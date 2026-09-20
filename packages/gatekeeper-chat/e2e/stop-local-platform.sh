#!/usr/bin/env bash
# Kills the process group start-local-platform.sh recorded, then checks nothing is left behind.
set -uo pipefail
STATE_DIR="${TMPDIR:-/tmp}/cfos-chat-platform"
PGID_FILE="$STATE_DIR/pgid"
if [[ -f "$PGID_FILE" ]]; then
  PGID="$(cat "$PGID_FILE")"
  kill -- "-$PGID" 2>/dev/null && echo "killed group $PGID" || echo "group $PGID was already gone"
  rm -f "$PGID_FILE"
fi
running() { ps -eo pid,args | grep -E 'wrangler(\.js)? dev|/workerd |run-dev-server' | grep -v grep; }
for _ in $(seq 1 20); do running >/dev/null || break; sleep 0.5; done
if left="$(running)"; then
  echo "still running after the kill:" >&2; echo "$left" >&2; exit 1
fi
echo "clean"
