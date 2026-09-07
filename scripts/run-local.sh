#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Load environment file.
# Priority:
# 1) kokoadb.env.${KOKOADB_ENV} if KOKOADB_ENV is set
# 2) kokoadb.env
export KOKOADB_ENV="${KOKOADB_ENV:-local}"
ENV_FILE="$ROOT_DIR/kokoadb.env"
if [[ -f "$ROOT_DIR/kokoadb.env.${KOKOADB_ENV}" ]]; then
  ENV_FILE="$ROOT_DIR/kokoadb.env.${KOKOADB_ENV}"
fi

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ENV_FILE"
  set +a
fi

export KOKOADB_STORAGE_MODE="${KOKOADB_STORAGE_MODE:-local}"
export KOKOADB_PORT="${KOKOADB_PORT:-6543}"
export KOKOADB_DATA_DIR="${KOKOADB_DATA_DIR:-./data_local}"
export KOKOADB_BASE_PATH="${KOKOADB_BASE_PATH:-}"
export KOKOADB_BACKUP_PATH="${KOKOADB_BACKUP_PATH:-./backups}"
export KOKOADB_AUTH_MODE="none"

# Optional archive cleanup TTL. Uncomment to force __kdb_archive retention.
# export KOKOADB_ARCHIVE_TTL_SECS="${KOKOADB_ARCHIVE_TTL_SECS:-86400}"

echo "Starting KokoaDB"
echo "  env:   $KOKOADB_ENV"
echo "  mode:  $KOKOADB_STORAGE_MODE"
echo "  port:  $KOKOADB_PORT"
echo "  base path: ${KOKOADB_BASE_PATH:-<none>}"
echo "  gateway path: ${KOKOADB_BASE_PATH}/gateway"
echo "  data:  $KOKOADB_DATA_DIR"
echo "  runtime profile: ${KOKOADB_RUNTIME_PROFILE:-balanced}"

exec cargo run
