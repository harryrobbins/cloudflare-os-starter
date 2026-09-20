#!/usr/bin/env bash
# Kills the process group start-dev.sh recorded, then checks nothing is left behind.
set -uo pipefail
STATE="${CHAT_DEV_STATE:-${TMPDIR:-/tmp}/cfos-chat-dev}"
PGID_FILE="$STATE/pgid"
if [[ -f "$PGID_FILE" ]]; then
  PGID="$(cat "$PGID_FILE")"
  kill -- "-$PGID" 2>/dev/null && echo "killed group $PGID" || echo "group $PGID was already gone"
  rm -f "$PGID_FILE"
fi
# Only real server processes: a plain `grep wrangler` also matches the shell that invoked this
# script, whose command line contains the word.
running() { ps -eo pid,args | grep -E 'wrangler(\.js)? dev|/workerd ' | grep -v grep; }
for _ in 1 2 3 4 5 6 7 8 9 10; do
  running >/dev/null || break
  sleep 0.5
done
if left="$(running)"; then
  echo "still running after the kill:" >&2; echo "$left" >&2; exit 1
fi
echo "clean"
