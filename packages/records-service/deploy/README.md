# Records server deployment artefacts

This is infrastructure as code for a **dedicated new Records database**, separate from the local
evaluation stack and the earlier Records runtime. It builds a reproducible application image and
runs Postgres, PostgREST, the gateway/relay and a one-shot migration job. It creates no organisation,
datastore, user grant or demo data. Applying this topology is not a production-readiness claim.

## Build and configure

From the repository root, with Docker Compose, Node 24.19+ and the service dependencies installed:

```sh
docker build -f packages/records-service/Dockerfile -t records-server:local .
node packages/records-service/deploy/prepare-secrets.ts /absolute/new/private/records-secrets
export RECORDS_SECRETS_DIR=/absolute/new/private/records-secrets
docker compose -f packages/records-service/deploy/compose.yaml config --quiet
docker compose -f packages/records-service/deploy/compose.yaml up -d
curl --fail http://127.0.0.1:8789/healthz
```

Create the parent directory first. `prepare-secrets.ts` refuses an existing target directory. It is
an initial installation utility, **not** a live rotation mechanism. Record the generated secrets in
your selected secret manager. File secrets must be readable by container UID 1000 for the Node
service; Compose local file secrets retain host ownership. Do not make them world-readable to
work around ownership. The database image consumes its password through `POSTGRES_PASSWORD_FILE`.

The Dockerfile pins Node by digest and installs exact production dependencies from the independent
`deploy/runtime/pnpm-lock.yaml` with pnpm 11.17.0. Keep this small lock aligned with the service's
runtime dependencies. Build context is allowlisted by `Dockerfile.dockerignore`; local environment
files, `.eval`, `.git`, host `node_modules` and credentials are excluded. No runtime host source or
node_modules mounts are used. Publish the built image to your chosen registry and set
`RECORDS_IMAGE` to its digest for deployment; the example tag is only for local qualification.

Node runs as UID 1000 with a read-only filesystem, no capabilities and a bounded temporary mount.
Database and PostgREST have no host ports. The gateway binds localhost port 8789 by default,
configurable with `RECORDS_LOCAL_PORT`. The database has a private internal network; a separate
ingress network permits an optional outbound tunnel. Persist and back up the named database volume.

The migration job needs the admin and runtime-role passwords. It applies the migration ledger,
configures login roles and installs bundled semantic profiles without provisioning data. Migration
credentials are not mounted into the gateway. After reviewing a release, rerun migrations as a
one-shot deployment step before replacing gateway instances. Avoid unrelated manual schema edits.
This topology does not implement a zero-downtime rolling upgrade controller.

## Optional Cloudflare ingress

`../../../../infra/records` contains the separate account-specific IaC when configured. Its remotely
managed named tunnel should point to `http://gateway:8788`. The optional sidecar accepts a tunnel
**token file**, not an inline token or a locally managed credentials JSON file:

```sh
# Put the separately issued token in $RECORDS_SECRETS_DIR/tunnel_token with private permissions.
export CLOUDFLARED_IMAGE=cloudflare/cloudflared@sha256:REVIEWED_IMAGE_DIGEST
docker compose -f packages/records-service/deploy/compose.yaml \
  -f packages/records-service/deploy/tunnel.compose.yaml config --quiet
```

Replace the placeholder with an actual verified image digest before starting. No tunnel, DNS record,
Access application, database provider or account resource is created by the image build or secret
preparation. Review and apply remote IaC separately. An Access boundary supplements Records'
scoped credentials; it does not replace them. Keep PostgREST and SQL private.

## Operating and recovering

Monitor database disk/CPU/locks, gateway errors, token failures, listener reconnects and SSE load.
The health endpoint proves process liveness, not every database dependency or a recovery guarantee.
Only the gateway has an image health check; Postgres has a readiness check. Startup dependency order
waits for migrations, while clients must still retry transient PostgREST startup/reload failures.

Take database backups using a dedicated scheduled operator job and store them outside this host.
Include the migration ledger, module registry, journal and idempotency receipts. Export role/grant
configuration separately and store credentials and signing keys in your secret manager; a database
logical dump does not recreate cluster roles or secret files. Apply retention/erasure policy to
backups and client caches as well as live rows. Configure PostgreSQL WAL archiving/PITR if required;
this Compose file does not provide it.

Restore into a **new isolated database/cluster**, restore roles and credentials with controlled
ownership, compare data and ledger contents, test authenticated reads/writes and revocation, then
perform an explicitly planned cutover. The local `scripts/restore-rehearsal.ts` exercises the separate
evaluation Compose stack; its same-cluster logical restore is not evidence of production PITR.
Do not point that script at this deployment or restore over live data. Keep old versions available,
but reconcile new writes before a rollback; replacing a container cannot roll back committed data.

The separate homeserver release script has deployed these services; see [the deployment record](homeserver.md).
The generic Compose files alone do not create Cloudflare resources. Backups, secret rotation,
capacity planning and business-data qualification remain operational work.

## Qualification recorded on 2026-09-25

The image built successfully from the allowlisted 1.68 MB source context using the frozen pnpm lock.
A separate `records-server` stack initialized a new named volume without touching the evaluation
stack. The migration job applied six ledger entries and left the datastore count at **zero**.
The gateway returned 200 for health, the database-backed work profile and the bundled Project term.
Private PostgREST returned 401 without a token. This exercised file-secret loading, the non-root
read-only gateway and the image's packaged dependencies; no host node_modules/source mounts exist.
Both base and tunnel-overlay Compose configurations passed validation. The optional remote tunnel
was not started and no remote resource was created. Production qualification remains separate.
