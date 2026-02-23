#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${ROOT_DIR}/server/data"
PID_FILE="${LOG_DIR}/goose-bridge.pid"
LOG_FILE="${LOG_DIR}/goose-bridge.log"

mkdir -p "${LOG_DIR}"

if [[ -f "${PID_FILE}" ]] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
  echo "goose-bridge already running (pid=$(cat "${PID_FILE}"))"
  exit 0
fi

export GOOSE_BRIDGE_BIND="${GOOSE_BRIDGE_BIND:-0.0.0.0}"
export GOOSE_BRIDGE_PORT="${GOOSE_BRIDGE_PORT:-8788}"
export GOOSE_BRIDGE_TOKEN="${GOOSE_BRIDGE_TOKEN:-factory-bridge-token}"

nohup node "${ROOT_DIR}/bridge/goose-bridge.js" >>"${LOG_FILE}" 2>&1 &
echo $! > "${PID_FILE}"
echo "goose-bridge started pid=$(cat "${PID_FILE}") bind=${GOOSE_BRIDGE_BIND}:${GOOSE_BRIDGE_PORT}"
