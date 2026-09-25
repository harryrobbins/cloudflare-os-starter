# gatekeeper-records-service

The Cloudflare OS connector for the standards-based **Records service**
([records.surprisingly.ltd](https://records.surprisingly.ltd), source in
[`records-service`](../records-service/README.md)). Gadgets connect to an operator-approved datastore.
Several gadgets can connect to the same datastore and see the same records, for example two Work
Boards and a Records Explorer. Records belong to the datastore, so removing a gadget keeps them.

It is separate from [`gatekeeper-records`](../gatekeeper-records), which serves the legacy
Projects runtime (`records://datastore/*`, vendor `records`). This connector is vendor
`recordservice` (Workshop binding `GATEKEEPER_RECORDSERVICE`, Worker `cfos-records-service`). Its
resources are `records-service://datastore/<uuid>/<module>/v<major>/<read|write>`.

## How it works

| Piece | What it does |
| --- | --- |
| `GatekeeperVendor` / `RecordsServiceAccount` | Auto-provisioned accounts with no credentials of their own. The picker (`src/configurator.js`) lists the approved datastores and offers **Read only** or **Read and request changes**. |
| `RecordsServiceGatekeeper` | One Durable Object facet per gadget binding. Its storage holds a binding ID, verified observers and submitted actions. |
| `src/host.ts` | The Cloudflare OS host for the service's own `RecordsOsBridge` (`records-service/src/cloudflare-os.ts`): durable pending actions, the Workshop queue adapter, error mapping and the session logic. |
| `src/types.d.ts` | The `RecordsServiceSession` contract that gadgets and agents see. |

Reads (`describe`, `records`, `snapshot`, `changes`, `getOutcome`) go through the bridge's observed
session: the facet checks the connection's module, API major and scopes against the datastore,
reads, and authorises the observation with the Workshop before returning anything. `model()`
returns public model metadata (profile and per-entity JSON Schema) and needs no credential.

Writes are exact-intent module commands (`work.create`, `work.update`, …):

1. The browser builds `{datastore, binding, moduleId, apiMajor, command, input, expectedRevision,
   idempotencyKey}`. It hashes the canonical JSON (raw lowercase SHA-256 hex, as
   `recordsOsIntentDigest`) and asks `gadget.$createViewerAssertion("RECORDS", digest)`.
2. `command()` redeems that one-use assertion for exactly this digest, persists the intent and
   submits a Workshop action that says who asked and what exactly will change.
3. Only `applyAction()`, called by the Workshop after approval, sends the command to Records, with
   the stored idempotency key and `If-Match` revision. It re-checks that the datastore is still
   approved and still satisfies the connection. A stale revision (412) settles as rejected.
   Denied actions never execute.

The owner can opt each command kind into auto-approval (`records.<module>.<command>`).
Read-only connections cannot submit commands.

## Who can read, and whose authority a write uses

The Records service has no per-person principals yet. Each approved datastore is reached with its
operator-issued datastore credential. The connection narrows that credential to one module, API
major and read or write scopes. Consequences, stated plainly:

- Every Cloudflare OS member (everyone admitted by Access) may observe an approved datastore
  through a gadget. `addObserver` accepts any Records account minted by this vendor. There is no
  per-datastore membership list yet. Do not approve a datastore whose data some members must not
  see.
- Approved writes run as the datastore's service binding. The person who asked is proven by the
  viewer assertion and recorded on the Workshop action and in the stored intent. The Records
  journal does not record it.
- Removing a datastore from the secret revokes it on the next call, including for already-approved
  pending actions.

This is the known-binding, operator-approved option in the
[explorer plan](../../docs/plans/external_datastores/records-explorer-blueprint.md) (E0). The
upgrade path is per-person principals and a credential broker in the service. With those,
`recordsHost().resolveViewer`/`canRead` would map the viewer to their own principal, with no
change to gadgets.

## Approving a datastore (operator)

1. Create a datastore and credential on the Records host (writes a new mode-0600 file, never
   overwrites):

   ```sh
   pnpm --filter @records/service db:bootstrap work /secure/new-credential.json
   ```

2. Install the approved list as the Worker secret. It is a JSON array; keep every datastore in it:

   ```sh
   CLOUDFLARE_ACCOUNT_ID=<id> pnpm exec wrangler secret put RECORDS_SERVICE_DATASTORES --name cfos-records-service
   # [{ "id": "<datastoreId>", "label": "Team work", "key": "<key from the file>" }]
   ```

Credentials from `db:bootstrap` expire after 90 days; rotate them before then. The service origin
is `recordsService.url` in `deployment.jsonc`.

## Commands

```sh
pnpm --filter gatekeeper-records-service build      # regenerate src/generated.ts, then tsc
pnpm --filter gatekeeper-records-service test:run   # host/bridge tests against an in-memory service
```

Blueprints using it: [`blueprint-work-board`](../blueprint-work-board) and
[`blueprint-records-explorer`](../blueprint-records-explorer).
