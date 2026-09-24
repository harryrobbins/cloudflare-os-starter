# Organisation records (`gatekeeper-records`)

The Postgres-backed Records service and its Gatekeeper, implementing
[docs/plans/organisation-datastores.md](../../docs/plans/organisation-datastores.md). It is
disabled by default in the template; this deployment runs it against Neon (see the plan's
deployment record). Configuration keys are documented in
[docs/customization.md](../../docs/customization.md#organisation-records).

Organisation-owned datastores (Projects module, API v1) are shared by any number of gadgets and
external clients. Removing a gadget, a connection or the person who created a datastore never
deletes its records.

## Layout

| Path | What it is |
| --- | --- |
| `../records-contracts` | Frozen DTOs, role/scope matrix, error codes, event envelope, intent digests, manifests |
| `../records-schema` | Ordered SQL migrations, the migration runner (lock + checksum ledger), bootstrap, embedded-Postgres test harness |
| `src/db/` | Transactions with transaction-local trusted context; error translation |
| `src/domain/` | Authorisation, registry (datastores, members, bindings, credentials, audit), Projects operations, idempotency, audit/outbox journal |
| `src/http/` | Versioned machine API (`/gatekeeper/records/v1/*`) and Access verification |
| `src/vendor/` | Gatekeeper vendor, account, per-gadget facet, session, observers, configurator, management capability |
| `src/connect.ts` | Access-verified connect flow for people |
| `src/feed/` | Outbox publisher, Queue consumer, per-datastore notification Durable Object, hook controller |
| `app/` | Workshop-hosted **Data** management page |

## Who can do what

`effective = principal's role ∩ binding/credential scopes ∩ the operation's permission`
(`records-contracts/src/permissions.ts`). Owners and admins hold editor rights; the organisation
data administrator creates datastores and assigns owners but holds no record access from that role.

- **People in gadgets.** Reads act as the binding (the connecting person's role ∩ its scopes), with
  every viewer verified as a datastore reader by `addObserver`; an observer who later loses access is
  excluded from each read. Writes act as the *viewer who asked*: the gadget UI obtains a one-use,
  60-second **viewer assertion** for the exact intent digest (`$createViewerAssertion`, a kernel
  feature on the fork branch `feat/viewer-assertions`), the facet redeems it through its own
  ApprovalQueue, and the write goes through the approval queue (pre-approvable per binding) and is
  re-authorised when applied.
- **External systems.** A Records credential (`rk1_…`, shown once, stored as a SHA-256 digest)
  names a service principal with fixed scopes on one datastore, and needs a valid Access service
  token for the API's own path-specific Access application as well. It stops working when revoked,
  expired, or when its human owner loses `credentials.manage`.
- **Agents.** Can read through a binding (observations). They cannot write through the gadget path
  (no viewer to assert); unattended automation uses a service credential.

## Tests

```sh
pnpm --filter @records/contracts test:run      # contracts, digests, role matrix
pnpm --filter @records/schema test:run         # migrations, privileges, RLS, integrity
pnpm --filter gatekeeper-records test:run      # domain, HTTP API, outbox/feed (real Postgres)
pnpm --filter gatekeeper-records test:workerd  # facet, session, viewer assertions, observers (workerd)
```

Every suite starts its own disposable Postgres 17 (`embedded-postgres`); no Docker or shared
database is needed, and no production data is ever used.

## Enabling it (operator)

Nothing here provisions infrastructure. In order:

1. Create a managed Postgres database per environment (Neon is the recommended first evaluation
   target; see the decisions record). Use its **direct** (non-pooler) endpoint.
2. Apply migrations with the migration-owner credential:
   `RECORDS_MIGRATION_URL=… pnpm --filter @records/schema db:migrate` (`db:status` to inspect).
   Runtime credentials cannot run DDL.
3. Create two LOGIN users and grant them the group roles the migrations created:
   `GRANT records_app TO <app user>; GRANT records_publisher TO <publisher user>;`
4. Create two Hyperdrive configurations (app user, publisher user) with **query caching disabled**.
5. Create the queue and its dead-letter queue.
6. Optional: create a separate, path-specific Access application for `/gatekeeper/records/v1/*`
   with a service token for each external client. Until it exists, set `apiAccessAudience` to
   `null`; the machine API then refuses every request.
7. Bootstrap the organisation and first data administrator:
   `RECORDS_MIGRATION_URL=… pnpm --filter @records/schema db:bootstrap "<Org>" admin@example.com "Admin Name"`.
8. Fill the `records` block in `deployment.jsonc`, set `"enabled": true`, run `pnpm check`, then deploy.

Upgrades: run migrations **before** deploying dependent Worker code; Worker rollback never reverses
SQL, so migrations are additive and roll forward.

## Operations

- The cron logs `records.outbox.tick` with `pending`, `oldestPendingSeconds` and `dead` (outbox age
  and dead-letter metrics). Dead rows need a person: fix the cause, then set them back to `pending`.
- Published outbox rows are kept 7 days (replay window); idempotency outcomes 7 days.
- Record bodies and credentials are never logged.

## Known limits (v1)

- One read audience per gadget/datastore; no row, project or field permissions.
- Export is synchronous and capped at 10 000 issues; export jobs, import and purge are follow-ups.
- Consumer references are not yet reconciled when a gadget disappears without its connection being
  removed; such bindings stay listed (and revocable) in the Data page.
- Agent writes through gadgets are not supported; use a service credential.
- `wrangler dev` reaches Postgres through the `localConnectionString` values in `wrangler.jsonc`,
  which must point at a disposable local database; `scripts/deploy.ts` strips them from generated
  production config.
