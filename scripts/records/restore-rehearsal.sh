#!/usr/bin/env bash
# Restore rehearsal: restore a Records dump (from backup.sh) into a disposable PostgreSQL 17
# container and run the verification query set (scripts/records/verify.sql). Exits non-zero if the
# restore or any check fails. Runbook: docs/plans/external_datastores/records-operations.md,
# "Restore rehearsal".
#
#   scripts/records/restore-rehearsal.sh <file.dump> [--keep] [--image postgres:17]
#
# Nothing outside the container is touched: the database, its roles and its password exist only in
# a container with no published port, removed on exit unless --keep is given (then it prints how to
# connect, and `docker rm -f <name>` removes it). Needs Docker; pulls the image if it is missing.

set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${PG_DOCKER_IMAGE:-postgres:17}"
KEEP=0
DUMP=""

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; }
die() { echo "rehearsal: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP=1; shift ;;
    --image) IMAGE="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) usage >&2; die "unknown argument: $1" ;;
    *) [[ -z "$DUMP" ]] || die "one dump file only"; DUMP="$1"; shift ;;
  esac
done
[[ -n "$DUMP" && -r "$DUMP" ]] || { usage >&2; die "give a readable dump file"; }
command -v docker >/dev/null 2>&1 || die "Docker is required"
DUMP="$(cd "$(dirname "$DUMP")" && pwd)/$(basename "$DUMP")"

if [[ -r "$DUMP.sha256" ]]; then
  ( cd "$(dirname "$DUMP")" && sha256sum --check --quiet "$(basename "$DUMP").sha256" ) || die "checksum mismatch for $DUMP"
  echo "rehearsal: checksum ok"
fi

NAME="records-rehearsal-$(date -u +%Y%m%d%H%M%S)-$$"
LOG="$(mktemp)"
PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
cleanup() {
  if [[ "$KEEP" -eq 1 ]]; then
    echo "rehearsal: kept container $NAME. Connect: docker exec -it $NAME psql -U postgres records. Remove: docker rm -f $NAME"
  else
    docker rm -f "$NAME" >/dev/null 2>&1 || true
  fi
  rm -f "$LOG"
}
trap cleanup EXIT

docker run -d --name "$NAME" -e POSTGRES_PASSWORD="$PASSWORD" \
  -v "$DUMP:/rehearsal/backup.dump:ro" -v "$HERE/verify.sql:/rehearsal/verify.sql:ro" \
  "$IMAGE" -c fsync=off -c full_page_writes=off >/dev/null
psql_in() { docker exec -i "$NAME" psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres "$@"; }

for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U postgres 2>/dev/null && break
  sleep 1
done
docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U postgres || die "the rehearsal server did not start"

# The database and the group roles the schema grants to. Login roles and the Neon owner are not
# needed: objects are restored as the rehearsal superuser (--no-owner).
psql_in -d postgres <<'SQL'
CREATE DATABASE records;
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['records_app', 'records_publisher', 'records_analytics', 'neondb_owner'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END
$$;
SQL

echo "rehearsal: restoring $(basename "$DUMP") into $NAME"
started=$SECONDS
set +e
docker exec "$NAME" pg_restore -h 127.0.0.1 -U postgres --no-owner --dbname=records --jobs=2 /rehearsal/backup.dump \
  > "$LOG" 2>&1
restore_status=$?
set -e
restore_seconds=$((SECONDS - started))
errors="$(grep -c 'error:' "$LOG" || true)"
if [[ "$errors" -gt 0 ]]; then
  echo "rehearsal: pg_restore reported $errors error(s):"
  grep 'error:' "$LOG" | head -n 20
fi
echo "rehearsal: restore took ${restore_seconds}s (pg_restore exit $restore_status)"

echo "rehearsal: verification"
report="$(psql_in -d records -A -t -F ' | ' -f /rehearsal/verify.sql)"
echo "$report" | sed 's/^/  /'
failed="$(echo "$report" | awk -F ' \\| ' '$2 == "FAIL"' | wc -l)"

if [[ "$failed" -gt 0 ]]; then
  echo "rehearsal: FAILED, $failed check(s) failed"
  exit 1
fi
if [[ "$restore_status" -ne 0 || "$errors" -gt 0 ]]; then
  echo "rehearsal: checks passed, but pg_restore reported errors above; review them before relying on this dump"
  exit 2
fi
echo "rehearsal: PASSED in $((SECONDS - started))s"
