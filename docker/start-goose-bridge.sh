#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${ROOT_DIR}/server/data"
PID_FILE="${LOG_DIR}/goose-bridge.pid"
LOG_FILE="${LOG_DIR}/goose-bridge.log"
GOOSE_HOST_HOME="${GOOSE_HOST_HOME:-/home/infosys}"
GOOSE_HOST_CONFIG_DIR="${GOOSE_HOST_CONFIG_DIR:-${GOOSE_HOST_HOME}/.config/goose}"
GOOSE_SECRETS_FILE="${GOOSE_SECRETS_FILE:-${GOOSE_HOST_CONFIG_DIR}/secrets.yaml}"
GOOSE_LOCAL_ENV_FILE="${GOOSE_LOCAL_ENV_FILE:-${ROOT_DIR}/server/data/goose-bridge.env}"

mkdir -p "${LOG_DIR}"

if [[ -f "${PID_FILE}" ]] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
  echo "goose-bridge already running (pid=$(cat "${PID_FILE}"))"
  exit 0
fi

if [[ -f "${PID_FILE}" ]]; then
  rm -f "${PID_FILE}"
fi

load_secret_from_yaml() {
  local key="$1"
  local file="$2"
  [[ -f "$file" ]] || return 1
  local line
  line="$(grep -E "^${key}:" "$file" | head -n1 || true)"
  [[ -n "$line" ]] || return 1
  local value="${line#*:}"
  value="$(echo "$value" | sed -E "s/^[[:space:]]+//; s/[[:space:]]+$//; s/^\"//; s/\"$//; s/^'//; s/'$//")"
  [[ -n "$value" ]] || return 1
  export "${key}=${value}"
  return 0
}

# Ensure Goose uses host profile/config (required for custom providers like kilo code).
export HOME="${GOOSE_HOST_HOME}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-${GOOSE_HOST_HOME}/.config}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-${GOOSE_HOST_HOME}/.cache}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-${GOOSE_HOST_HOME}/.local/share}"
export XDG_STATE_HOME="${XDG_STATE_HOME:-${GOOSE_HOST_HOME}/.local/state}"

export GOOSE_BRIDGE_BIND="${GOOSE_BRIDGE_BIND:-0.0.0.0}"
export GOOSE_BRIDGE_PORT="${GOOSE_BRIDGE_PORT:-8788}"
export GOOSE_BRIDGE_TOKEN="factory-bridge-token"
export GOOSE_BRIDGE_CONTAINER_USE="${GOOSE_BRIDGE_CONTAINER_USE:-1}"
export GOOSE_BRIDGE_CONTAINER_USE_BUILTIN="${GOOSE_BRIDGE_CONTAINER_USE_BUILTIN:-container-use}"
export GOOSE_TELEMETRY_ENABLED="${GOOSE_TELEMETRY_ENABLED:-false}"
export GOOSE_PROVIDER="${GOOSE_PROVIDER:-custom_kilo_code}"
export GOOSE_MODEL="${GOOSE_MODEL:-moonshotai/kimi-k2.5}"

# Optional local env file for explicit runtime overrides.
if [[ -f "${GOOSE_LOCAL_ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${GOOSE_LOCAL_ENV_FILE}"
fi

# Load provider credentials from Goose secrets if not already exported.
[[ -n "${CUSTOM_KILO_CODE_API_KEY:-}" ]] || load_secret_from_yaml "CUSTOM_KILO_CODE_API_KEY" "${GOOSE_SECRETS_FILE}" || true
[[ -n "${CUSTOM_KILO_API_KEY:-}" ]] || load_secret_from_yaml "CUSTOM_KILO_API_KEY" "${GOOSE_SECRETS_FILE}" || true
[[ -n "${OPENROUTER_API_KEY:-}" ]] || load_secret_from_yaml "OPENROUTER_API_KEY" "${GOOSE_SECRETS_FILE}" || true
[[ -n "${OPENAI_API_KEY:-}" ]] || load_secret_from_yaml "OPENAI_API_KEY" "${GOOSE_SECRETS_FILE}" || true
[[ -n "${GOOGLE_API_KEY:-}" ]] || load_secret_from_yaml "GOOGLE_API_KEY" "${GOOSE_SECRETS_FILE}" || true
[[ -n "${ANTHROPIC_API_KEY:-}" ]] || load_secret_from_yaml "ANTHROPIC_API_KEY" "${GOOSE_SECRETS_FILE}" || true

if [[ -z "${CUSTOM_KILO_CODE_API_KEY:-}" ]]; then
  echo "warning: CUSTOM_KILO_CODE_API_KEY is empty; custom_kilo_code provider may fail."
fi

nohup node "${ROOT_DIR}/bridge/goose-bridge.js" >>"${LOG_FILE}" 2>&1 &
echo $! > "${PID_FILE}"
echo "goose-bridge started pid=$(cat "${PID_FILE}") bind=${GOOSE_BRIDGE_BIND}:${GOOSE_BRIDGE_PORT} provider=${GOOSE_PROVIDER} model=${GOOSE_MODEL}"
