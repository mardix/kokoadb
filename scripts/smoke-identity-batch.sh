#!/usr/bin/env bash
# Exercises user-create arrays, atomic failures, and queued acknowledgements over HTTP.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
cargo build
mkdir -p .smoke
SMOKE_DIR="$(mktemp -d ./.smoke/identity-batch.XXXXXX)"
SMOKE_PORT="${KOKOADB_SMOKE_PORT:-18127}"
KOKOADB_PORT="$SMOKE_PORT" \
KOKOADB_STORAGE_MODE=local \
KOKOADB_DATA_DIR="$SMOKE_DIR/data" \
KOKOADB_AUTH_MODE=none \
KOKOADB_BASE_PATH=/ \
KOKOADB_WRITE_MODE=committed \
KOKOADB_IDENTITY_CREATE_MAX_BATCH=3 \
./target/debug/kokoadb >"$SMOKE_DIR/server.log" 2>&1 &
SMOKE_PID=$!
trap 'kill "$SMOKE_PID" 2>/dev/null || true; wait "$SMOKE_PID" 2>/dev/null || true' EXIT
node - "$SMOKE_PORT" <<'NODE'
const assert = require('node:assert/strict');
const base = `http://127.0.0.1:${process.argv[2]}`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function call(operation, payload = {}) {
  const response = await fetch(`${base}/gateway`, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({db: 'identity/batch', operation, payload})
  });
  return response.json();
}
async function main() {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/ping`)).ok) { ready = true; break; } } catch {}
    await pause(100);
  }
  assert(ready, 'server did not start');
  assert.equal((await call('create_db')).status, 'success');
  const first = await call('user_create', {commit: true, users: [
    {user_id: 'alice', email: 'alice@example.com', provider: 'google', provider_user_id: 'google-alice'},
    {email: 'bob@example.com', password_hash: 'private-hash', password_algo: 'argon2id'}
  ]});
  assert.equal(first.committed, true);
  assert.equal(first.data.succeeded, 2);
  assert.equal(first.data.results[0].item.id, 'alice');
  assert.equal(first.data.results[1].item.id.length, 32);
  assert(!JSON.stringify(first).includes('private-hash'));
  const oversized = await call('user_create', {commit: false, users: [{}, {}, {}, {}]});
  assert.equal(oversized.status, 'error');
  assert.match(oversized.error, /1 to 3/);
  const mixed = await call('user_create', {commit: false, email: 'mixed@example.com', users: [{}]});
  assert.equal(mixed.status, 'error');
  const rollback = await call('user_create', {commit: true, users: [
    {user_id: 'rolled-back', email: 'rollback@example.com'}, {email: 'alice@example.com'}
  ]});
  assert.equal(rollback.status, 'error');
  assert.equal((await call('user_get', {user_id: 'rolled-back'})).data.item, null);
  const partial = await call('user_create', {commit: true, on_error: 'continue', users: [
    {user_id: 'provider-conflict', provider: 'google', provider_user_id: 'google-alice'},
    {user_id: 'charlie', email: 'charlie@example.com'}
  ]});
  assert.equal(partial.status, 'partial');
  assert.equal(partial.data.failed, 1);
  assert.equal(partial.data.results[0].index, 0);
  assert.equal(partial.data.results[1].item.id, 'charlie');
  assert.equal((await call('user_get', {user_id: 'provider-conflict'})).data.item, null);
  const accepted = await call('user_create', {commit: false, users: [
    {user_id: 'queued-custom', email: 'queued@example.com'}, {email: 'queued-generated@example.com'}
  ]});
  assert.equal(accepted.committed, false);
  assert.equal(accepted.is_async_ack, true);
  assert.equal(accepted.data.count, 2);
  assert.equal(accepted.data.ids[0], 'queued-custom');
  assert.equal(accepted.data.ids[1].length, 32);
  for (const id of accepted.data.ids) {
    let found = false;
    for (let i = 0; i < 80; i++) {
      const result = await call('user_get', {user_id: id});
      if (result.data?.item?.id === id) { found = true; break; }
      await pause(50);
    }
    assert(found, `queued user ${id} was not persisted`);
  }
  const single = await call('user_create', {commit: true, email: 'single@example.com'});
  assert.equal(single.data.item.email, 'single@example.com');
  const invalidSingle = await call('user_create', {commit: true, user_id: 'single-failed', provider: 'google'});
  assert.equal(invalidSingle.status, 'error');
  assert.equal((await call('user_get', {user_id: 'single-failed'})).data.item, null);
  console.log('Identity batch smoke passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
NODE
echo "Smoke artifacts: $SMOKE_DIR"
