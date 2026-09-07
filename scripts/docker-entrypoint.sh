#!/bin/sh
set -eu

# Env-file loading order:
# 1) KOKOADB_ENV_FILE (explicit path)
# 2) /app/kokoadb.env.$KOKOADB_ENV
# 3) /app/kokoadb.env
load_env_file() {
  f="$1"
  if [ -n "$f" ] && [ -f "$f" ]; then
    # Load env-file values as defaults only; Dockerfile ENV and `docker run -e`
    # values must keep precedence over baked-in profiles.
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        "" | "#"*) continue ;;
        export\ *) line=${line#export } ;;
      esac

      key=${line%%=*}
      if [ "$key" = "$line" ]; then
        continue
      fi
      case "$key" in
        "" | *[!A-Za-z0-9_]* | [0-9]*) continue ;;
      esac

      if printenv "$key" >/dev/null 2>&1; then
        continue
      fi
      export "$line"
    done < "$f"
    echo "loaded env file: $f"
    return 0
  fi
  return 1
}

ENV_FILE="${KOKOADB_ENV_FILE:-}"
ENV_PROFILE="${KOKOADB_ENV:-}"

if [ "$ENV_FILE" != "" ]; then
  load_env_file "$ENV_FILE" || {
    echo "KOKOADB_ENV_FILE not found: $ENV_FILE" >&2
    exit 1
  }
elif [ "$ENV_PROFILE" != "" ]; then
  load_env_file "/app/kokoadb.env.${ENV_PROFILE}" || {
    echo "env profile file not found: /app/kokoadb.env.${ENV_PROFILE}" >&2
    exit 1
  }
else
  load_env_file "/app/kokoadb.env" || true
fi

# Container defaults apply after runtime values and profile files are considered.
export KOKOADB_DATA_DIR="${KOKOADB_DATA_DIR:-/data}"
export KOKOADB_BACKUP_PATH="${KOKOADB_BACKUP_PATH:-/data/backups}"
export KOKOADB_EXPORT_PATH="${KOKOADB_EXPORT_PATH:-/data/exports}"
export KOKOADB_DOCS_FILE="${KOKOADB_DOCS_FILE:-/app/DOCUMENTATION.md}"

exec sh -c 'KOKOADB_PORT=${PORT:-${KOKOADB_PORT:-6543}} kokoadb'
