#!/usr/bin/env bash
# Stops the platform started by start-local-platform.sh (kills its whole process group).
set -uo pipefail
PGID_FILE="${TMPDIR:-/tmp}/cfos-local-platform/pgid"
if [[ -f "$PGID_FILE" ]]; then
  PGID="$(cat "$PGID_FILE")"
  kill -TERM -- "-$PGID" 2>/dev/null && echo "sent SIGTERM to process group $PGID"
  for _ in $(seq 1 20); do
    pgrep -g "$PGID" >/dev/null || break
    sleep 0.5
  done
  if pgrep -g "$PGID" >/dev/null; then
    kill -KILL -- "-$PGID" 2>/dev/null && echo "process group $PGID did not exit; sent SIGKILL"
  fi
  rm -f "$PGID_FILE"
else
  echo "no PGID file at $PGID_FILE"
fi
left="$(ps -eo pid,pgid,args | grep -E 'wrangler|workerd|run-dev-server' | grep -v grep)"
if [[ -n "$left" ]]; then
  echo "still running:"; echo "$left"; exit 1
fi
echo "stopped (no wrangler/workerd/run-dev-server processes left)"
