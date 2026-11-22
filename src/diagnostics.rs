//! Read-only memory diagnostics and scoped accounting for retained payload buffers.

use std::io::{self, Write};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use serde_json::{Value, json};

#[derive(Default)]
pub struct ByteTracker {
    bytes: AtomicU64,
    peak: AtomicU64,
    active: AtomicU64,
}

impl ByteTracker {
    pub const fn new() -> Self {
        Self {
            bytes: AtomicU64::new(0),
            peak: AtomicU64::new(0),
            active: AtomicU64::new(0),
        }
    }

    pub fn track(&'static self, bytes: u64) -> ByteReservation {
        self.active.fetch_add(1, Ordering::Relaxed);
        let current = self.bytes.fetch_add(bytes, Ordering::Relaxed) + bytes;
        self.peak.fetch_max(current, Ordering::Relaxed);
        ByteReservation {
            tracker: self,
            bytes,
        }
    }

    pub fn snapshot(&self) -> Value {
        json!({
            "active": self.active.load(Ordering::Relaxed),
            "current_bytes": self.bytes.load(Ordering::Relaxed),
            "peak_bytes": self.peak.load(Ordering::Relaxed)
        })
    }
}

pub struct ByteReservation {
    tracker: &'static ByteTracker,
    bytes: u64,
}

impl ByteReservation {
    pub fn resize(&mut self, bytes: u64) {
        if bytes >= self.bytes {
            let current = self
                .tracker
                .bytes
                .fetch_add(bytes - self.bytes, Ordering::Relaxed)
                + bytes
                - self.bytes;
            self.tracker.peak.fetch_max(current, Ordering::Relaxed);
        } else {
            self.tracker
                .bytes
                .fetch_sub(self.bytes - bytes, Ordering::Relaxed);
        }
        self.bytes = bytes;
    }
}

impl Drop for ByteReservation {
    fn drop(&mut self) {
        self.tracker.bytes.fetch_sub(self.bytes, Ordering::Relaxed);
        self.tracker.active.fetch_sub(1, Ordering::Relaxed);
    }
}

pub static WRITE_PAYLOADS: ByteTracker = ByteTracker::new();
pub static SNAPSHOT_BUFFERS: ByteTracker = ByteTracker::new();
pub static S3_UPLOAD_COPIES: ByteTracker = ByteTracker::new();
pub static S3_DOWNLOAD_BUFFERS: ByteTracker = ByteTracker::new();

// Count serialization bytes without allocating a second serialized payload.
pub fn serialized_bytes(value: &impl Serialize) -> u64 {
    struct Counter(u64);
    impl Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0 = self.0.saturating_add(bytes.len() as u64);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter(0);
    let _ = serde_json::to_writer(&mut counter, value);
    counter.0
}

pub fn sqlite_memory() -> Value {
    fn status(code: i32) -> Value {
        let (mut current, mut peak) = (0_i64, 0_i64);
        // SQLite's global status API is thread-safe; reset=0 preserves lifetime peaks.
        let result = unsafe { libsql::ffi::sqlite3_status64(code, &mut current, &mut peak, 0) };
        if result == libsql::ffi::SQLITE_OK as i32 {
            json!({"current": current, "peak": peak})
        } else {
            Value::Null
        }
    }
    json!({
        "scope": "process",
        "allocated_bytes": status(libsql::ffi::SQLITE_STATUS_MEMORY_USED as i32),
        "pagecache_overflow_bytes": status(libsql::ffi::SQLITE_STATUS_PAGECACHE_OVERFLOW as i32),
        "allocation_count": status(libsql::ffi::SQLITE_STATUS_MALLOC_COUNT as i32),
        "per_connection_stats_available": false
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reservations_release_on_drop_and_preserve_peak() {
        static TRACKER: ByteTracker = ByteTracker {
            bytes: AtomicU64::new(0),
            peak: AtomicU64::new(0),
            active: AtomicU64::new(0),
        };
        let mut first = TRACKER.track(100);
        let second = TRACKER.track(50);
        first.resize(200);
        assert_eq!(TRACKER.snapshot()["current_bytes"], 250);
        drop(second);
        first.resize(25);
        assert_eq!(TRACKER.snapshot()["current_bytes"], 25);
        drop(first);
        assert_eq!(TRACKER.snapshot()["current_bytes"], 0);
        assert_eq!(TRACKER.snapshot()["active"], 0);
        assert_eq!(TRACKER.snapshot()["peak_bytes"], 250);
    }

    #[test]
    fn serialization_estimate_counts_utf8_and_escaping() {
        let value = json!({"text": "hello\nworld", "items": [true, 1, null]});
        assert_eq!(
            serialized_bytes(&value),
            serde_json::to_vec(&value).unwrap().len() as u64
        );
    }

    #[tokio::test]
    async fn sqlite_counters_are_available_without_resetting_peaks() {
        let db = libsql::Builder::new_local(":memory:")
            .build()
            .await
            .unwrap();
        let _conn = db.connect().unwrap();
        let first = sqlite_memory();
        assert!(first["allocated_bytes"]["current"].as_i64().unwrap() > 0);
        assert!(
            sqlite_memory()["allocated_bytes"]["peak"].as_i64().unwrap()
                >= first["allocated_bytes"]["peak"].as_i64().unwrap()
        );
    }

    #[tokio::test]
    async fn reservations_release_when_work_is_cancelled() {
        static TRACKER: ByteTracker = ByteTracker {
            bytes: AtomicU64::new(0),
            peak: AtomicU64::new(0),
            active: AtomicU64::new(0),
        };
        let (ready, waiting) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _reservation = TRACKER.track(4096);
            ready.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        waiting.await.unwrap();
        assert_eq!(TRACKER.snapshot()["current_bytes"], 4096);
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(TRACKER.snapshot()["current_bytes"], 0);
        assert_eq!(TRACKER.snapshot()["active"], 0);
    }
}
