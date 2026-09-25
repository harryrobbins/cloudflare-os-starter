# Records on the homeserver

The owner selected `ms:~/containers/records` for the long-running services on 2026-09-25.
SSH resolves to `mini-harry`, user `harry` (UID 1000). This is a new, isolated stack; other
homeserver projects and the existing cloudflare-os Records deployment must not be modified.

## Runtime and ingress

The versioned deployment contains Postgres, PostgREST and the Node gateway/notification relay.
The Docker Compose source is `packages/records-service/deploy/compose.yaml`; the connector overlay
is `tunnel.compose.yaml`. Database state persists independently of application release directories.
Only a loopback gateway listener is published; SQL and PostgREST have no host port.

One **remotely managed Cloudflare Tunnel token** runs the connector. Multiple hostnames can use
the same tunnel; separate projects/environments may use separate tunnels for independent rotation.
The selected API hostname should route to **HTTP `gateway:8788`** from the tunnel container.
It must not route to `localhost`, Postgres or PostgREST. Public TLS terminates at Cloudflare;
the connector reaches the gateway over the private project network.

The owner published `https://records.surprisingly.ltd/` through this tunnel. The gateway image
bundles the product website, documentation and preserved comparison under `/`, while `/v1/`
continues to serve the API. The initial API-only release returned JSON 404 at `/`; website
packaging and static routing correct that without changing DNS or tunnel ingress.

Direct tunnel ingress is sufficient for this deployment. The optional Worker can be added later
for an edge routing layer. For direct ingress, Records itself checks bearer credentials and grants
on every datastore operation. Vocabulary/model metadata and process health are public at the
application layer. If an additional Cloudflare Access boundary is wanted, configure an exact
hostname application and explicit intended callers; do not mistake the connector token for an
Access service token or a Records API credential.

## Token installation

The user supplies `RECORDS_CLOUDFLARE_TUNNEL_TOKEN` in the ignored local `.env.local`.
Live Access tests use `RECORDS_CLOUDFLARE_ACCESS_CLIENT_ID` and
`RECORDS_CLOUDFLARE_ACCESS_CLIENT_SECRET`.
Transfer only the selected tunnel value:

```sh
node packages/records-service/deploy/install-tunnel-token.ts .env.local
```

This helper uses SSH stdin, never a token in command arguments, to atomically install
`~/containers/records/secrets/tunnel_token` with mode 0600. It never copies other environment
values and never prints the token. The connector runs as UID 1000 so it can read that mount.
Application/database/signing secrets are independently generated on the homeserver and remain
there. `.env` is a local transfer source, not part of a release archive.

Use the verified Linux amd64 cloudflared 2026.9.0 image:

```text
cloudflare/cloudflared@sha256:b7a6db450ae2e2f773d4fbe9ffb48e7b5fc451e17329daab1b4dda5a2487e2cc
```

Install the token before enabling the overlay. An existing tunnel created by the operator must
not be replaced with a second tunnel by blindly applying `main.tf`. Record its ID, hostname and
ingress configuration; import/adopt it into IaC only after reviewing its existing routes and owner.
The checked-in OpenTofu module describes a separate, optional edge-to-origin Access topology;
it has not been applied to this homeserver tunnel.

## Verification and recovery

Check container health, six initial migration-ledger entries, installed module profiles, and no
unexpected datastores. After ingress is available, verify TLS, invalid credential denial, scoped
reads/writes, stale revisions, duplicate requests, cross-datastore denial and SSE. Provision any
smoke datastore through the trusted bootstrap command and keep its credential in a private file.
Do not expose an administrator provisioning endpoint to make bootstrap easier.

Retain the previous image/release and database volume. Rollback must account for forward schema
changes and writes after deployment. Do not run project-wide cleanup or delete volumes. Before
business data, configure off-host backups, retention, rotation and recovery objectives; the local
restore rehearsal does not establish homeserver recovery guarantees.
