#!/usr/bin/env bash
# Logical backup of the Records database: pg_dump (custom format) to a local file, checked with
# pg_restore --list, with a SHA-256 beside it; optionally uploaded to R2. Runbook:
# docs/plans/external_datastores/records-operations.md, "Backups".
#
#   scripts/records/backup.sh [--env-file .env.local] [--out-dir DIR] [--keep-local N]
#                             [--r2-bucket BUCKET] [--r2-prefix PREFIX]
#
# Connects with RECORDS_MIGRATION_URL (the migration owner), from the environment or read from
# --env-file. Only that one variable is read from the file; the file is never sourced. The URL is
# handed to pg_dump through libpq environment variables, never on a command line.
#
# pg_dump comes from PATH if it is version 17 or newer, otherwise from the postgres:17 Docker image
# (override with PG_DOCKER_IMAGE). The dump never enters the repository: the default directory is
# ${XDG_STATE_HOME:-~/.local/state}/cfos-records-backups, files are mode 600.
#
# Upload (only with --r2-bucket) uses the project-pinned Wrangler: `pnpm exec wrangler r2 object put
# <bucket>/<prefix>/<file> --file <file> --remote`. The bucket's lifecycle rule and lock are set up
# once, by hand, as the runbook describes; this script never changes bucket configuration.

set -euo pipefail
umask 077

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE=""
OUT_DIR="${RECORDS_BACKUP_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/cfos-records-backups}"
KEEP_LOCAL=7
BUCKET=""
PREFIX="records/pg_dump"
IMAGE="${PG_DOCKER_IMAGE:-postgres:17}"

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }
die() { echo "backup: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) ENV_FILE="${2:?}"; shift 2 ;;
    --out-dir) OUT_DIR="${2:?}"; shift 2 ;;
    --keep-local) KEEP_LOCAL="${2:?}"; shift 2 ;;
    --r2-bucket) BUCKET="${2:?}"; shift 2 ;;
    --r2-prefix) PREFIX="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done
[[ "$KEEP_LOCAL" =~ ^[0-9]+$ ]] || die "--keep-local must be a number"

URL="${RECORDS_MIGRATION_URL:-}"
if [[ -z "$URL" && -n "$ENV_FILE" ]]; then
  [[ -r "$ENV_FILE" ]] || die "cannot read $ENV_FILE"
  URL="$(grep -E '^[[:space:]]*(export[[:space:]]+)?RECORDS_MIGRATION_URL=' "$ENV_FILE" | tail -n 1 | sed -E 's/^[^=]*=//; s/^["'\'']//; s/["'\'']$//')"
fi
[[ -n "$URL" ]] || die "set RECORDS_MIGRATION_URL or pass --env-file"

# URL → libpq environment (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, PGSSLMODE, PGCHANNELBINDING).
parts=()
while IFS= read -r -d '' part; do parts+=("$part"); done < <(
  RECORDS_URL_IN="$URL" node -e '
    const u = new URL(process.env.RECORDS_URL_IN);
    if (!/^postgres(ql)?:$/.test(u.protocol)) { console.error("not a postgres:// URL"); process.exit(1); }
    const q = u.searchParams;
    process.stdout.write([u.hostname, u.port || "5432", decodeURIComponent(u.username), decodeURIComponent(u.password),
      decodeURIComponent(u.pathname.slice(1)) || "postgres", q.get("sslmode") || "", q.get("channel_binding") || ""].join("\0") + "\0");')
[[ ${#parts[@]} -eq 7 ]] || die "could not parse RECORDS_MIGRATION_URL"
export PGHOST="${parts[0]}" PGPORT="${parts[1]}" PGUSER="${parts[2]}" PGPASSWORD="${parts[3]}" PGDATABASE="${parts[4]}"
[[ -n "${parts[5]}" ]] && export PGSSLMODE="${parts[5]}"
[[ -n "${parts[6]}" ]] && export PGCHANNELBINDING="${parts[6]}"
unset URL parts

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="records-${PGDATABASE}-${STAMP}.dump"
FILE="$OUT_DIR/$NAME"

# Run a PostgreSQL client tool: local if new enough, else in Docker with the output dir mounted at
# the same path, the host network (so tunnels to localhost work) and the caller's uid.
pg_tool() {
  local tool="$1"; shift
  if command -v "$tool" >/dev/null 2>&1 && [[ "$("$tool" --version | grep -oE '[0-9]+' | head -n 1)" -ge 17 ]]; then
    "$tool" "$@"
  elif command -v docker >/dev/null 2>&1; then
    docker run --rm --network host --user "$(id -u):$(id -g)" -v "$OUT_DIR:$OUT_DIR" \
      -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE -e PGCHANNELBINDING \
      "$IMAGE" "$tool" "$@"
  else
    die "$tool 17+ is not installed and Docker is not available"
  fi
}

echo "backup: dumping $PGDATABASE on $PGHOST to $FILE"
started=$SECONDS
pg_tool pg_dump --format=custom --no-password --file="$FILE.partial"
mv "$FILE.partial" "$FILE"
entries="$(pg_tool pg_restore --list "$FILE" | grep -cv '^;')" || die "pg_restore could not read $FILE"
( cd "$OUT_DIR" && sha256sum "$NAME" > "$NAME.sha256" )
chmod 600 "$FILE" "$FILE.sha256"
echo "backup: ok, $(du -h "$FILE" | cut -f1), $entries TOC entries, $((SECONDS - started)) s; sha256 $(cut -d' ' -f1 "$FILE.sha256")"

if [[ -n "$BUCKET" ]]; then
  for f in "$FILE" "$FILE.sha256"; do
    key="$PREFIX/$(basename "$f")"
    echo "backup: uploading r2://$BUCKET/$key"
    ( cd "$REPO_ROOT" && pnpm exec wrangler r2 object put "$BUCKET/$key" --file "$f" --remote )
  done
fi

# Local rotation: keep the newest N dumps (and their checksums).
if [[ "$KEEP_LOCAL" -gt 0 ]]; then
  mapfile -t old < <(ls -1t "$OUT_DIR"/records-*.dump 2>/dev/null | tail -n +"$((KEEP_LOCAL + 1))")
  for f in "${old[@]}"; do rm -f -- "$f" "$f.sha256"; done
fi
echo "$FILE"
