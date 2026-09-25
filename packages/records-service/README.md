# Records service — deployed alpha

A working, independent implementation of the accepted standards-based datastore direction.
Postgres holds typed module data and transactional history; PostgREST runs private SQL commands;
the gateway supplies credential checking, model interfaces, safe HTTP errors and change hints.
The complete pinned Schema.org catalogue lives in [`@records/model`](../records-model/README.md).

This service runs at https://records.surprisingly.ltd on the homeserver `ms`, alongside the earlier
Records implementation. The same gateway serves the website and `/v1/` API through cloudflared;
Postgres and PostgREST are private. It has not migrated or replaced the legacy OS gatekeeper. Production readiness and live OS adoption
remain tracked in [the delivery checklist](../../docs/plans/external_datastores/records-delivery.md).

For server deployment preparation, use [the container deployment](deploy/README.md),
[Cloudflare infrastructure code](../../infra/records/README.md), and
[the launch checklist](../../docs/plans/external_datastores/records-launch.md).
Wrangler deploys the separate edge and website; the persistent services need a host.

## Run the local stack

Requires the repository's Node 24.19+ and pnpm 11.17, Docker Engine and Docker Compose. The reference
stack mounts the installed workspace read-only and uses UID 1000; adapt the Compose user to your
local file ownership if necessary. It is a development topology, not a production image.

From the repository root:

```sh
pnpm install --filter @records/service... --no-frozen-lockfile
pnpm --filter @records/service dev:prepare
docker compose --env-file packages/records-service/.eval/compose.env -f packages/records-service/compose.yaml up -d
```

The only published service is `http://127.0.0.1:8788`. Postgres and PostgREST remain on the private
Docker network. The gateway also has a network for its localhost-published port. `/healthz` is a
process liveness check, not proof that authenticated database requests work.

`dev:prepare` creates fresh keys, random database passwords and two datastore credentials in ignored
`.eval/` files with restricted permissions. Existing files are retained on rerun. `.eval/client.json`
contains the local work/messaging IDs and credentials. Treat it as a secret, never commit or copy it
into a gadget. The gateway receives only credential-lookup and listener database access; migration
credentials belong to the one-shot initializer. This is synthetic local evaluation data.

On subsequent code changes, apply new migrations before restarting dependent code:

```sh
docker compose --env-file packages/records-service/.eval/compose.env -f packages/records-service/compose.yaml run --rm --no-deps init
docker compose --env-file packages/records-service/.eval/compose.env -f packages/records-service/compose.yaml restart gateway postgrest
```

Stop without deleting data:

```sh
docker compose --env-file packages/records-service/.eval/compose.env -f packages/records-service/compose.yaml down
```

## Try the API without printing credentials

```sh
RECORDS_INTEGRATION=1 pnpm --filter @records/service test:integration
```

That test reads the local fixture file and proves authenticated requests through the complete
gateway → ES256 token → PostgREST → Postgres path. It creates synthetic records, verifies safe
retry and revision conflicts, reads the change journal and checks semantic export.

Available interfaces:

| Route | Behaviour |
| --- | --- |
| `GET /v1/vocabulary/schemaorg/terms/Project` | Pinned vocabulary term definition; public metadata |
| `GET /v1/models/work/profile` | Installed profile; public metadata |
| `GET /v1/models/work/schema/work_item` | Generated record JSON Schema |
| `GET /v1/openapi.json` | Generic public API contract |
| `GET /v1/datastores/{id}/openapi` | Authorised module contract, scopes and profile |
| `GET /v1/datastores/{id}/describe` | Module and granted scopes |
| `GET /v1/datastores/{id}/modules/work/v1/records` | Bounded records, optional `entity`, `id`, `after`, `limit` |
| Same read with `format=jsonld` | Permission-filtered semantic representation |
| `GET /v1/datastores/{id}/modules/work/v1/snapshot` | Atomic bootstrap with sequence/permission epoch; at most 5,000 records |
| `POST /v1/datastores/{id}/modules/work/v1/rpc/work.create` | Create `{title,status?,description?,extensions?}` |
| Same prefix, `rpc/work.update` | Update `{id,title?,status?,description?,extensions?}`, requires quoted revision in `If-Match` |
| Messaging prefix, `rpc/messaging.send` | Create `{channel,body,extensions?}` |
| Messaging prefix, `rpc/messaging.edit` | Edit `{id,body?,extensions?}`, requires revision |
| `GET /v1/datastores/{id}/changes?after=0&epoch=1` | Durable cursor pull; epoch mismatch requires cache reset |
| `GET /v1/datastores/{id}/events` | Authorised SSE hints, bounded and periodically revalidated |

Datastore routes require `Authorization: Bearer <credential>`. Writes also require a unique
`Idempotency-Key`; preserve it across retries. Credentials are scoped to a principal and datastore.
Records carry `created_by` and `updated_by` (and `owner` for modules with ownership), set by
Postgres from the acting identity; change entries carry each change's `actor`. A credential with
an attribution grant may send `Records-Actor: <namespace>:<id>` to act for a person (for example
`cloudflare-os:ada@example.com`); any other value is refused with 403.

Permissions live in Postgres. Clients only ever read presentation views; storage tables have
forced row-level security and no client grants, and command handlers cannot bypass it. A module can
therefore declare row rules, restricted fields (absent for readers who may not see them) and
history rules that hold for every client. See [sql/README.md](sql/README.md#permissions-storage-presentation-and-commands-007009)
and the [people module](../records-model/examples/people/README.md).

Ordinary REST clients use JSON. JSON-LD export uses full IRIs and datastore-scoped record identities;
it is a constrained mapping, not an arbitrary JSON-LD processor or a remote-context fetcher.

The current query surface is deliberately bounded, not the full PostgREST query language. Errors
are `application/problem+json`; database details are removed. A new external system could provide
Jira/Linear, Slack/Matrix or Notion/Confluence mappings independently of the core.

## Publish your own model

The inventory example demonstrates a custom ontology and a third typed SQL module without core
edits. Publication is trusted code deployment, not an untrusted end-user upload. Review its SQL.

```sh
docker compose --env-file packages/records-service/.eval/compose.env -f packages/records-service/compose.yaml run --rm --no-deps init node scripts/manage.ts publish ../records-model/examples/inventory
```

The installer validates the profile, names, handlers, version and SQL checksums. It preserves
applied migrations, serialises installation, and rolls back registry and migration changes together.
It does not create datastores or grants. Repeating the same publication is safe.

Outside Compose, use `RECORDS_MIGRATION_URL` supplied through your operator's secret mechanism:

```sh
pnpm --filter @records/service db:migrate
pnpm --filter @records/service module:publish ../records-model/examples/inventory
pnpm --filter @records/service db:bootstrap inventory /secure/new-credential.json
```

Publication also runs the permission checks: forced RLS with a tenant policy on every storage
table, no client grants, a security-barrier presentation view per entity plus a history view, and
handlers owned by `records_commander`. A module that fails any check is not installed.

Operator permission tooling (same `RECORDS_MIGRATION_URL`):

```sh
node scripts/manage.ts attribution <binding-id> cloudflare-os   # "may attribute" grant; `none` removes it
node scripts/manage.ts role grant <datastore-id> cloudflare-os:ada@example.com admin
node scripts/manage.ts role revoke <datastore-id> cloudflare-os:ada@example.com admin
```

Role and attribution changes bump the datastore's permission epoch, so clients reset caches.

Bootstrap creates an organisation, service principal, datastore and scoped credential, expiring in
90 days, and writes that credential only to a new file with mode 0600. It refuses to overwrite a
file. Never point these commands at the earlier Records database. Installed profile metadata is
public by design; do not place customer data or secrets in module definitions.

## Clients and cloudflare-os

`src/client.ts` is a generic client: `describe`, `bind`, `records`, `snapshot`, `command`, `changes`
and a recoverable polling loop. A blueprint requirement uses `moduleId`, `apiMajor`, `scopes` and
optional `features`. Bind checks actual granted scopes, not just module-declared capabilities.

`src/connector.ts` provides read-only viewer binding. `src/approved-command.ts` requires a signed
full intent, exact approval and trusted execution broker for a write. Host verifiers and brokers
have no permissive defaults. These interfaces do not enroll an OS instance, put credentials in
gadgets, or modify the current gatekeeper. The live connection/configurator/observer rollout is a
separate qualification gate. No generated frontend may bypass those checks.

`src/cloudflare-os.ts` implements the concrete kernel ApprovalQueue bridge: consume viewer assertion,
persist the pending command, submit its action, execute only through host `applyAction`, and recheck
the viewer's current authority. It requires a durable pending store and observer authority checks.
The gadget-facing session exposes no credentials or apply capability. The cloudflare-os host sends
approved commands with `Records-Actor: cloudflare-os:<viewer>`, so its binding needs the
`cloudflare-os` attribution grant; shared-gadget reads do not yet run as each viewer. Tests cover this lifecycle;
the live OS vendor still needs registration, configuration and deployment qualification.

## Verification and operations

```sh
pnpm --filter @records/model test
pnpm --filter @records/service test:run
pnpm --filter @records/service types:check
RECORDS_INTEGRATION=1 pnpm --filter @records/service test:integration
docker compose --env-file packages/records-service/.eval/compose.env -f packages/records-service/compose.yaml run --rm --no-deps -e RECORDS_IDENTITY_TEST=1 operator node --test test/postgrest-identity.test.ts
```

Database tests start disposable embedded Postgres with actual restricted roles. They test
concurrency, rollback, isolation, revisions and publication lifecycle. The runtime gateway mounts only its code, dependencies and signing key. The `operator` tools-profile
service alone mounts development fixtures and migration credentials. Docker identity tests verify
the real token boundary, including missing issuer/audience/expiry and unknown signing key IDs.

`scripts/restore-rehearsal.ts` runs a local logical backup/restore into a uniquely named temporary
database and compares table content and migration ledgers. Run with local writers stopped. It
cleans up only its temporary database. This does not prove cross-cluster recovery or production
PITR. Use backup tooling and recovery objectives appropriate to the chosen production host.

`scripts/benchmark.ts` and `scripts/benchmark-sse.ts` produce repeatable local measurement evidence.
Measurements apply to that machine and workload, not an enterprise-scale SLA. See generated
[the measured throughput report](docs/benchmark.md) and [SSE probe](docs/benchmark-sse.md).
From the service directory, run operator measurements with a separate writable output mount:

```sh
docker compose --env-file .eval/compose.env -f compose.yaml run --rm --no-deps \
  --volume "$PWD/.eval:/benchmark-output:rw" operator node scripts/benchmark.ts \
  --base=http://gateway:8788 --duration=600 --rate=60 --output=/benchmark-output
docker compose --env-file .eval/compose.env -f compose.yaml run --rm --no-deps \
  -e RECORDS_RELAY_INTEGRATION=1 operator node --test test/relay-integration.test.ts
```

The live relay test deliberately terminates the local LISTEN backend, so run it after notification
benchmarks, not concurrently. It checks disconnected-client recovery, listener reconnect, stream
revocation, stale permission epochs and expired credentials.

For a remote Access-protected evaluation, manually place a dedicated short-lived Access service
token in the ignored root `.env.local` as `RECORDS_CLOUDFLARE_ACCESS_CLIENT_ID` and `RECORDS_CLOUDFLARE_ACCESS_CLIENT_SECRET`, plus
the exact `RECORDS_TEST_URL`. Use an Access **Service Auth** policy including that specific token.
`pnpm --filter @records/service test:access` performs read-only anonymous/authenticated requests,
never follows redirects, and prints only statuses. Optional `RECORDS_TEST_TOKEN` supplies the separate
datastore credential for API reads. Access admission alone does not create a human cloudflare-os
session. The helper neither deploys this stack nor edits policies. See
[Cloudflare service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).

## Explicit alpha limits

Single-record commands; no delete/tombstone protocol, multi-record commands, erasure/retention
workflow, webhook delivery worker or stable streaming snapshots yet. Snapshots above 5,000 records
are refused rather than silently truncated. Change cursors are sequence plus epoch, not opaque
signed cursors. Credential revocation stops new tokens immediately; previously minted internal
tokens have a maximum 60-second lifetime unless the binding or principal is revoked too.
HTTP process scaling does not remove per-datastore write serialization. The homeserver is deployed;
off-host backups/PITR, business-data qualification, data migration and live OS enrollment remain open.
See [current status](../../docs/plans/external_datastores/records-status.md) and the new
[blueprint adaptation](../../docs/plans/external_datastores/records-blueprint-adaptation.md) and
[explorer](../../docs/plans/external_datastores/records-explorer-blueprint.md) plans.

Detailed SQL boundary: [sql/README.md](sql/README.md).
