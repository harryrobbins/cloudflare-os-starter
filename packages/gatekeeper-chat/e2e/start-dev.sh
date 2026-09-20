#!/usr/bin/env bash
# Starts ONE `wrangler dev` for this package (the dev-identity entry, local R2) and waits until it
# answers. Its own process group, so one kill stops wrangler, workerd and the capnweb-validate build
# together.
#
#   packages/gatekeeper-chat/e2e/start-dev.sh    # prints PGID and URL, then returns
#   packages/gatekeeper-chat/e2e/stop-dev.sh     # kills the group
#
# Env: CHAT_DEV_LOG (default $STATE/dev.log), CHAT_DEV_TIMEOUT (default 120),
#      CHAT_DEV_STATE (default ${TMPDIR:-/tmp}/cfos-chat-dev), CHAT_SKIP_BUILD=1 to reuse app/dist.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$PKG/../.." && pwd)"
URL="http://localhost:8787"
STATE="${CHAT_DEV_STATE:-${TMPDIR:-/tmp}/cfos-chat-dev}"
LOG="${CHAT_DEV_LOG:-$STATE/dev.log}"
TIMEOUT="${CHAT_DEV_TIMEOUT:-120}"

if [[ -z "$(command -v node)" || "$(command -v node)" == /mnt/c/* ]]; then
  echo "Linux node not on PATH; run: eval \"\$(fnm env)\" && fnm use v24.21.0" >&2
  exit 1
fi

# Matches only real server processes. A plain `grep wrangler` also matches the shell that invoked
# this script when the command line happens to contain the word, which made the stop script report a
# leak that was its own caller.
chat_dev_processes() {
  ps -eo pid,pgid,args | grep -E 'wrangler(\.js)? dev|/workerd |run-dev-server' | grep -v grep
}

# Exactly one server on :8787. The local platform (blueprint-whiteboard/e2e) uses the same port.
if running="$(chat_dev_processes)"; then
  echo "wrangler/workerd is already running; stop it first:" >&2
  echo "$running" >&2
  exit 1
fi

mkdir -p "$STATE"
# app/dist is gitignored build output and the `assets` binding needs the directory to exist.
if [[ -z "${CHAT_SKIP_BUILD:-}" || ! -f "$PKG/app/dist/index.html" ]]; then
  echo "Building the SPA into app/dist..."
  (cd "$REPO" && pnpm --filter gatekeeper-chat build >/dev/null)
fi

cd "$PKG"
setsid pnpm exec wrangler dev -c wrangler.dev.jsonc >"$LOG" 2>&1 </dev/null &
PID=$!
sleep 0.5
PGID="$(ps -o pgid= -p "$PID" | tr -d ' ' || true)"
PGID="${PGID:-$PID}"
echo "$PGID" > "$STATE/pgid"
echo "PGID $PGID (log: $LOG)"

deadline=$((SECONDS + TIMEOUT))
until curl -sf -o /dev/null --max-time 10 "$URL/gatekeeper/chat/dev/identities"; do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "wrangler exited during startup; tail of $LOG:" >&2; tail -n 30 "$LOG" >&2; rm -f "$STATE/pgid"; exit 1
  fi
  if (( SECONDS > deadline )); then
    echo "not ready after ${TIMEOUT}s; stopping. tail of $LOG:" >&2; tail -n 30 "$LOG" >&2
    kill -- "-$PGID" 2>/dev/null || true; rm -f "$STATE/pgid"; exit 1
  fi
  sleep 1
done
echo "READY $URL/gatekeeper/chat/"
echo "stop with: $HERE/stop-dev.sh   (or: kill -- -$PGID)"
