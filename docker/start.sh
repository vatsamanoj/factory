#!/bin/sh
set -eu

# Start API in background for nginx to proxy /api and /ws.
node /app/server/src/index.js &
API_PID=$!

cleanup() {
  kill "$API_PID" 2>/dev/null || true
}

trap cleanup INT TERM

exec nginx -g "daemon off;"
