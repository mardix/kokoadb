#!/usr/bin/env bash
# Checks memory diagnostics, cache accounting, and write-payload cleanup over HTTP.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
cargo build
mkdir -p .smoke
SMOKE_DIR="$(mktemp -d ./.smoke/memory.XXXXXX)"
SMOKE_PORT="${KOKOADB_SMOKE_PORT:-18128}"
KOKOADB_PORT="$SMOKE_PORT" KOKOADB_STORAGE_MODE=local \
KOKOADB_DATA_DIR="$SMOKE_DIR/data" KOKOADB_AUTH_MODE=none \
KOKOADB_BASE_PATH=/ KOKOADB_WRITE_MODE=committed KOKOADB_CACHE_TTL_SECS=60 \
./target/debug/kokoadb >"$SMOKE_DIR/server.log" 2>&1 &
SMOKE_PID=$!
trap 'kill "$SMOKE_PID" 2>/dev/null || true; wait "$SMOKE_PID" 2>/dev/null || true' EXIT
node - "$SMOKE_PORT" <<'NODE'
const assert = require('node:assert/strict');
const base = `http://127.0.0.1:${process.argv[2]}`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function call(operation, payload = {}, namespace) {
  const response = await fetch(`${base}/gateway`, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({db: 'diagnostics/main', operation, namespace, payload})
  });
  const result = await response.json();
  assert.equal(result.status, 'success', JSON.stringify(result));
  return result.data;
}
async function main() {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/ping`)).ok) { ready = true; break; } } catch {}
    await pause(100);
  }
  assert(ready, 'server did not start');
  await call('create_db');
  await call('insert', {commit: true, data: {_id: 'memory-row', body: 'x'.repeat(4096)}}, 'items');
  const query = await call('query', {cache: true}, 'items');
  const first = await call('system_memory');
  const breakdown = first.memory_breakdown;
  assert(first.process_memory.physical_bytes > 0);
  assert(breakdown.sqlite.allocated_bytes.current > 0);
  assert(breakdown.response_cache.entries > 0);
  assert(breakdown.response_cache.estimated_serialized_bytes >= 4096);
  const second = await call('get_system_stats');
  assert.equal(second.memory_breakdown.response_cache.entries, breakdown.response_cache.entries);
  assert.equal(second.memory_breakdown.response_cache.estimated_serialized_bytes, breakdown.response_cache.estimated_serialized_bytes);
  assert.deepEqual(await call('query', {cache: true}, 'items'), query);
  await call('query', {cache: 120}, 'items');
  const custom = (await call('system_memory')).memory_breakdown.response_cache;
  assert(custom.ttl_override_entries > 0);
  assert(custom.ttl_override_estimated_serialized_bytes >= 4096);
  await call('update', {commit: true, data: {_id: 'memory-row', body: 'changed'}}, 'items');
  const fresh = await call('query', {cache: true}, 'items');
  assert.equal(fresh.items[0].body, 'changed');
  await call('insert', {commit: false, data: {_id: 'queued-row', body: 'queued'}}, 'items');
  let drained;
  for (let i = 0; i < 80; i++) {
    drained = (await call('system_memory')).memory_breakdown;
    if (drained.outstanding_write_payloads.active === 0 && drained.pending_documents.entries === 0) break;
    await pause(50);
  }
  assert.equal(drained.outstanding_write_payloads.active, 0);
  assert.equal(drained.outstanding_write_payloads.current_bytes, 0);
  assert(drained.outstanding_write_payloads.peak_bytes > 0);
  assert.equal(drained.pending_documents.entries, 0);
  assert.equal(drained.snapshot_buffers.current_bytes, 0);
  console.log('Memory diagnostics smoke passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
NODE
echo "Smoke artifacts: $SMOKE_DIR"
