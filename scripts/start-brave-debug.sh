#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RAW_PROFILE_DIR="${VALIANT_PLAYWRIGHT_PROFILE_DIR:-playwright-profile}"
BRAVE_BIN="${BRAVE_BIN:-/snap/bin/brave}"
DEBUG_ADDRESS="${VALIANT_BRAVE_DEBUG_ADDRESS:-127.0.0.1}"
DEBUG_PORT="${VALIANT_BRAVE_DEBUG_PORT:-9222}"
START_URL="${VALIANT_BRAVE_START_URL:-https://valiant.trade/perps}"
START_TIMEOUT_SECONDS="${VALIANT_BRAVE_START_TIMEOUT_SECONDS:-45}"

debug_port_is_open() {
  (true >"/dev/tcp/${DEBUG_ADDRESS}/${DEBUG_PORT}") >/dev/null 2>&1
}

profile_lock_pid() {
  local lock_target
  lock_target="$(readlink "$PROFILE_DIR/SingletonLock" 2>/dev/null || true)"
  [[ "$lock_target" =~ -([0-9]+)$ ]] || return 1
  printf '%s\n' "${BASH_REMATCH[1]}"
}

cleanup_stale_profile_locks() {
  local socket_target lock_pid
  socket_target="$(readlink "$PROFILE_DIR/SingletonSocket" 2>/dev/null || true)"
  lock_pid="$(profile_lock_pid || true)"

  if [[ -n "$socket_target" && -S "$socket_target" ]]; then
    return
  fi

  if [[ -n "$lock_pid" ]] && kill -0 "$lock_pid" >/dev/null 2>&1; then
    return
  fi

  rm -f "$PROFILE_DIR/SingletonCookie" "$PROFILE_DIR/SingletonLock" "$PROFILE_DIR/SingletonSocket"
}

wait_for_debug_port() {
  local waited=0
  until debug_port_is_open; do
    if (( waited >= START_TIMEOUT_SECONDS )); then
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

monitor_debug_port() {
  while debug_port_is_open; do
    sleep 30
  done
  echo "Brave debug port ${DEBUG_ADDRESS}:${DEBUG_PORT} closed." >&2
  exit 1
}

if [[ "$RAW_PROFILE_DIR" = /* ]]; then
  PROFILE_DIR="$RAW_PROFILE_DIR"
else
  PROFILE_DIR="$APP_DIR/$RAW_PROFILE_DIR"
fi

if [[ ! -x "$BRAVE_BIN" ]]; then
  if command -v brave-browser >/dev/null 2>&1; then
    BRAVE_BIN="$(command -v brave-browser)"
  elif command -v brave >/dev/null 2>&1; then
    BRAVE_BIN="$(command -v brave)"
  elif command -v chromium >/dev/null 2>&1; then
    BRAVE_BIN="$(command -v chromium)"
  else
    echo "Could not find Brave/Chromium. Set BRAVE_BIN=/path/to/browser." >&2
    exit 1
  fi
fi

mkdir -p "$PROFILE_DIR"

if debug_port_is_open; then
  echo "Brave debug port ${DEBUG_ADDRESS}:${DEBUG_PORT} is already open; not opening another Valiant tab."
  monitor_debug_port
fi

cleanup_stale_profile_locks

"$BRAVE_BIN" \
  --remote-debugging-address="$DEBUG_ADDRESS" \
  --remote-debugging-port="$DEBUG_PORT" \
  --user-data-dir="$PROFILE_DIR" \
  "$START_URL" &

browser_pid="$!"

if ! wait_for_debug_port; then
  echo "Brave started as PID ${browser_pid}, but debug port ${DEBUG_ADDRESS}:${DEBUG_PORT} did not open within ${START_TIMEOUT_SECONDS}s." >&2
  kill "$browser_pid" >/dev/null 2>&1 || true
  exit 1
fi

echo "Brave debug port ${DEBUG_ADDRESS}:${DEBUG_PORT} is open."
monitor_debug_port
