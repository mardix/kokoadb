#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${KOKOADB_PORT:-18092}"
SMOKE_ROOT="${KOKOADB_SMOKE_ROOT:-./.smoke/identity}"
DATA_DIR="${KOKOADB_DATA_DIR:-${SMOKE_ROOT}/data}"
LOG_FILE="${KOKOADB_SMOKE_LOG:-${SMOKE_ROOT}/logs/smoke-identity.log}"
BIN="${KOKOADB_BIN:-${KOKOADB_BIN:-./target/debug/kokoadb}}"
BASE_URL="http://127.0.0.1:${PORT}"
BASE_PATH_RAW="${KOKOADB_BASE_PATH:-}"
BASE_PATH="/${BASE_PATH_RAW#/}"
BASE_PATH="${BASE_PATH%/}"
if [[ "$BASE_PATH" == "/" ]]; then BASE_PATH=""; fi
GATEWAY_URL="${BASE_URL}${BASE_PATH}/gateway"

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local message="$3"
  if ! grep -Fq "$needle" <<<"$haystack"; then
    echo "assertion failed: $message" >&2
    echo "response: $haystack" >&2
    exit 1
  fi
}

echo "[1/10] building kokoadb"
cargo build >/dev/null

echo "[2/10] preparing smoke dirs under $SMOKE_ROOT"
rm -rf "$SMOKE_ROOT"
mkdir -p "$DATA_DIR" "$(dirname "$LOG_FILE")"

echo "[3/10] starting server on :$PORT"
KOKOADB_PORT="$PORT" \
KOKOADB_STORAGE_MODE="local" \
KOKOADB_DATA_DIR="$DATA_DIR" \
KOKOADB_BASE_PATH="$BASE_PATH" \
KOKOADB_AUTH_MODE="none" \
"$BIN" >"$LOG_FILE" 2>&1 &
PID=$!
cleanup() {
  kill "$PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

READY=false
for _ in $(seq 1 40); do
  if curl -fsS -o /dev/null "$BASE_URL/ping" 2>/dev/null; then
    READY=true
    break
  fi
  sleep 0.25
done
if [[ "$READY" != "true" ]]; then
  echo "server did not become ready on :$PORT" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

echo "[4/10] create identity database"
CREATE_DB="$(curl -sS -X POST "$GATEWAY_URL" -H 'content-type: application/json' -d '{"db":"identity/main","operation":"create_db","payload":{}}')"
assert_contains "$CREATE_DB" '"status":"success"' "create_db should succeed"

echo "[5/10] create identity requiring password change"
CREATE_USER="$(curl -sS -X POST "$GATEWAY_URL" -H 'content-type: application/json' -d '{
  "db":"identity/main",
  "operation":"user_create",
  "payload":{
    "email":"password-change@example.com",
    "first_name":"Password",
    "last_name":"Change",
    "requires_password_change":true,
    "data":{"plan":"pro","tags":["beta"]}
  }
}')"
assert_contains "$CREATE_USER" '"status":"success"' "user_create should succeed"
assert_contains "$CREATE_USER" '"requires_password_change":true' "user_create should return the enabled flag"
USER_ID="$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' <<<"$CREATE_USER")"
[[ -n "$USER_ID" ]] || { echo "failed to extract created user id" >&2; exit 1; }

LIST_USERS="$(curl -sS -X POST "$GATEWAY_URL" -H 'content-type: application/json' -d '{"db":"identity/main","operation":"user_query","payload":{}}')"
assert_contains "$LIST_USERS" '"requires_password_change":true' "user_query should return the enabled flag"

FILTERED_USERS="$(curl -sS -X POST "$GATEWAY_URL" -H 'content-type: application/json' -d '{"db":"identity/main","operation":"user_query","payload":{"filter":{"data.plan":"pro","data.tags":{"$includes":"beta"}}}}')"
assert_contains "$FILTERED_USERS" '"password-change@example.com"' "user_query should filter nested identity data"

echo "[6/10] rotate password hash and clear password-change requirement"
UPDATE_PASSWORD="$(curl -sS -X POST "$GATEWAY_URL" -H 'content-type: application/json' -d "{\"db\":\"identity/main\",\"operation\":\"user_update_password\",\"payload\":{\"user_id\":\"$USER_ID\",\"password_hash\":\"argon2id-smoke-hash\",\"password_algo\":\"argon2id\",\"requires_password_change\":false}}")"
assert_contains "$UPDATE_PASSWORD" '"status":"success"' "user_update_password should succeed"
assert_contains "$UPDATE_PASSWORD" '"requires_password_change":false' "password update should clear the requirement"
assert_contains "$UPDATE_PASSWORD" '"password_algo":"argon2id"' "password update should return the algorithm"
assert_contains "$UPDATE_PASSWORD" '"password_updated_at":' "password update should set its timestamp"
if grep -Fq 'argon2id-smoke-hash' <<<"$UPDATE_PASSWORD"; then
  echo "assertion failed: password hash must not be returned" >&2
  exit 1
fi

echo "[7/10] fetch identity with cleared requirement"
GET_USER="$(curl -sS -X POST "$GATEWAY_URL" -H 'content-type: application/json' -d "{\"db\":\"identity/main\",\"operation\":\"user_get\",\"payload\":{\"user_id\":\"$USER_ID\"}}")"
assert_contains "$GET_USER" '"requires_password_change":false' "user_get should return the cleared flag"
if grep -Fq 'argon2id-smoke-hash' <<<"$GET_USER"; then
  echo "assertion failed: user_get must not return password hash" >&2
  exit 1
fi

echo "[8/10] create, inspect, and atomically consume a token"
CREATE_TOKEN="$(curl -sS -X POST "$GATEWAY_URL" -H 'content-type: application/json' -d "{\"db\":\"identity/main\",\"operation\":\"user_create_token\",\"payload\":{\"user_id\":\"$USER_ID\",\"kind\":\"password_reset\",\"token_hash\":\"identity-smoke-token-one\",\"expires_in\":300}}")"
assert_contains "$CREATE_TOKEN" '"status":"success"' "user_create_token should succeed"
TOKEN_ID="$(sed -n 's/.*"token_id":"\([^"]*\)".*/\1/p' <<<"$CREATE_TOKEN")"
[[ -n "$TOKEN_ID" ]] || { echo "failed to extract created token id" >&2; exit 1; }

GET_TOKEN="$(curl -sS -X POST "$GATEWAY_URL" -H 'content-type: application/json' -d '{"db":"identity/main","operation":"user_get_token","payload":{"token_hash":"identity-smoke-token-one","kind":"password_reset"}}')"
assert_contains "$GET_TOKEN" '"status":"active"' "new token should be active"
if grep -Fq 'identity-smoke-token-one' <<<"$GET_TOKEN"; then
  echo "assertion failed: token hash must not be returned" >&2
  exit 1
fi

CONSUME_TOKEN="$(curl -sS -X POST "$GATEWAY_URL" -H 'content-type: application/json' -d '{"db":"identity/main","operation":"user_consume_token","payload":{"token_hash":"identity-smoke-token-one","kind":"password_reset"}}')"
assert_contains "$CONSUME_TOKEN" '"consumed":true' "first token consume should succeed"
CONSUME_AGAIN="$(curl -sS -X POST "$GATEWAY_URL" -H 'content-type: application/json' -d '{"db":"identity/main","operation":"user_consume_token","payload":{"token_hash":"identity-smoke-token-one","kind":"password_reset"}}')"
assert_contains "$CONSUME_AGAIN" '"consumed":false' "token consume must be one-time"

echo "[9/10] create and revoke another token"
CREATE_REVOKE_TOKEN="$(curl -sS -X POST "$GATEWAY_URL" -H 'content-type: application/json' -d "{\"db\":\"identity/main\",\"operation\":\"user_create_token\",\"payload\":{\"user_id\":\"$USER_ID\",\"kind\":\"email_verify\",\"token_hash\":\"identity-smoke-token-two\",\"expires_in\":300}}")"
REVOKE_TOKEN_ID="$(sed -n 's/.*"token_id":"\([^"]*\)".*/\1/p' <<<"$CREATE_REVOKE_TOKEN")"
[[ -n "$REVOKE_TOKEN_ID" ]] || { echo "failed to extract revocation token id" >&2; exit 1; }
REVOKE_TOKEN="$(curl -sS -X POST "$GATEWAY_URL" -H 'content-type: application/json' -d "{\"db\":\"identity/main\",\"operation\":\"user_revoke_token\",\"payload\":{\"token_id\":\"$REVOKE_TOKEN_ID\"}}")"
assert_contains "$REVOKE_TOKEN" '"revoked_count":1' "user_revoke_token should revoke one token"
REVOKED_TOKEN="$(curl -sS -X POST "$GATEWAY_URL" -H 'content-type: application/json' -d "{\"db\":\"identity/main\",\"operation\":\"user_get_token\",\"payload\":{\"token_id\":\"$REVOKE_TOKEN_ID\"}}")"
assert_contains "$REVOKED_TOKEN" '"status":"revoked"' "revoked token should report revoked status"

echo "[10/10] verify operations catalog"
OPERATIONS="$(curl -sS "$BASE_URL${BASE_PATH}/meta/operations")"
assert_contains "$OPERATIONS" '"user_update_password"' "operations catalog should include user_update_password"
assert_contains "$OPERATIONS" '"user_consume_token"' "operations catalog should include user_consume_token"

echo "identity smoke passed. log: $LOG_FILE"
