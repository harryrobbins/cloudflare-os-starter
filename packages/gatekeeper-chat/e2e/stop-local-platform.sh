#!/usr/bin/env bash
# Kills both process groups start-local-platform.sh recorded (the platform, then the chat Worker),
# then checks nothing is left behind.
set -uo pipefail
STATE_DIR="${TMPDIR:-/tmp}/cfos-chat-platform"
for name in chat.pgid pgid; do
  f="$STATE_DIR/$name"
  if [[ -f "$f" ]]; then
    PGID="$(cat "$f")"
    kill -- "-$PGID" 2>/dev/null && echo "killed group $PGID ($name)" || echo "group $PGID ($name) was already gone"
    rm -f "$f"
  fi
done
running() { ps -eo pid,args | grep -E 'wrangler(\.js)? dev|/workerd |run-dev-server' | grep -v grep; }
for _ in $(seq 1 20); do running >/dev/null || break; sleep 0.5; done
if left="$(running)"; then
  echo "still running after the kill:" >&2; echo "$left" >&2; exit 1
fi
echo "clean"
