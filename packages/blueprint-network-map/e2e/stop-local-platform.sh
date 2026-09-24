#!/usr/bin/env bash
# Stops the platform started by ./start-local-platform.sh: kills only the process group recorded in
# its PGID file (never other worktrees' wrangler/workerd), then checks :8787 is free.
set -uo pipefail
PGID_FILE="${TMPDIR:-/tmp}/netmap-local-platform/pgid"
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
  if pgrep -g "$PGID" >/dev/null; then
    echo "process group $PGID still has processes:"; ps -o pid,args -g "$PGID"; exit 1
  fi
else
  echo "no PGID file at $PGID_FILE"
fi
if listening="$(ss -ltnH 'sport = :8787' 2>/dev/null)" && [[ -n "$listening" ]]; then
  echo "still listening on :8787:"; echo "$listening"; exit 1
fi
echo "stopped (process group gone, :8787 free)"
