#!/usr/bin/env bash
# Run the migration CLI through an SSH tunnel, for networks that block outbound Postgres (5432).
# The Neon host and endpoint come from RECORDS_MIGRATION_URL in the repo's .env.local; the bastion is
# any SSH host that can reach it. The URL is rewritten in this process only and never printed.
#
#   packages/records-schema/scripts/migrate-via-bastion.sh <ssh-host> [status|migrate]
#
# `migrate` (the default) prints the status before and after. TLS stays end to end with Neon; Neon
# routes by SNI, which a 127.0.0.1 connection lacks, so the endpoint is passed as a startup option.
set -euo pipefail

BASTION=${1:?usage: $0 <ssh-host> [status|migrate]}
COMMAND=${2:-migrate}
LOCAL_PORT=${RECORDS_TUNNEL_PORT:-15432}
cd "$(dirname "$0")/.."

set -a; . ../../.env.local; set +a
TARGET=$(node -e 'const u = new URL(process.env.RECORDS_MIGRATION_URL); console.log(`${u.hostname}:${u.port || 5432}`)')

ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -L "127.0.0.1:${LOCAL_PORT}:${TARGET}" "$BASTION" &
TUNNEL=$!
trap 'kill $TUNNEL 2>/dev/null' EXIT
for _ in $(seq 1 30); do (echo > "/dev/tcp/127.0.0.1/${LOCAL_PORT}") 2>/dev/null && break; sleep 0.5; done

RECORDS_MIGRATION_URL=$(LOCAL_PORT=$LOCAL_PORT node -e '
  const u = new URL(process.env.RECORDS_MIGRATION_URL);
  const neon = u.hostname.endsWith(".neon.tech");
  const endpoint = u.hostname.split(".")[0];
  u.hostname = "127.0.0.1"; u.port = process.env.LOCAL_PORT;
  if (neon) u.searchParams.set("options", `endpoint=${endpoint}`);
  console.log(u.toString());')
export RECORDS_MIGRATION_URL

case "$COMMAND" in
  status) node src/cli.ts status ;;
  migrate)
    echo "== before"; node src/cli.ts status
    echo "== migrate"; node src/cli.ts migrate
    echo "== after"; node src/cli.ts status ;;
  *) echo "unknown command: $COMMAND" >&2; exit 2 ;;
esac
