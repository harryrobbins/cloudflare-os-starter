#!/usr/bin/env bash
# Stops the platform started by start-local-platform.sh (kills its whole process group).
set -uo pipefail
PGID_FILE="${TMPDIR:-/tmp}/cfos-notebook-platform/pgid"
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
echo "Notebook test platform stopped. Other worktrees were left running."
