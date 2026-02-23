#!/bin/sh
set -eu

GOOSE_HOME_DIR="${GOOSE_HOME:-/app/server/data/goose-runtime}"
GOOSE_CONFIG_DIR="${XDG_CONFIG_HOME:-$GOOSE_HOME_DIR/.config}"
GOOSE_CACHE_DIR="${XDG_CACHE_HOME:-$GOOSE_HOME_DIR/.cache}"
GOOSE_DATA_DIR="${XDG_DATA_HOME:-$GOOSE_HOME_DIR/.local/share}"
GOOSE_STATE_DIR="${XDG_STATE_HOME:-$GOOSE_HOME_DIR/.local/state}"

mkdir -p "$GOOSE_CONFIG_DIR" "$GOOSE_CACHE_DIR" "$GOOSE_DATA_DIR" "$GOOSE_STATE_DIR"

seed_goose_dir() {
  src="$1"
  dest="$2"
  if [ -d "$src" ] && [ -z "$(ls -A "$dest" 2>/dev/null || true)" ]; then
    cp -a "$src"/. "$dest"/
  fi
}

# Seed Goose runtime configuration from host-mounted paths on first boot.
seed_goose_dir "/seed/goose/config" "$GOOSE_CONFIG_DIR/goose"
seed_goose_dir "/seed/goose/cache" "$GOOSE_CACHE_DIR/goose"
seed_goose_dir "/seed/goose/share" "$GOOSE_DATA_DIR/goose"
seed_goose_dir "/seed/goose/state" "$GOOSE_STATE_DIR/goose"

# Start API in background for nginx to proxy /api and /ws.
node --experimental-sqlite /app/server/src/index.js &
API_PID=$!

cleanup() {
  kill "$API_PID" 2>/dev/null || true
}

trap cleanup INT TERM

exec nginx -g "daemon off;"
