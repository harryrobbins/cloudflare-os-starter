# Records SQL boundary

Apply numbered migrations to a new PostgreSQL 17 database using the service migration runner.
These migrations deliberately do not upgrade or modify the legacy Records database.

The owner installs trusted SQL. `records_authenticator` can assume `records_runtime` for
PostgREST. Runtime has schema usage and approved RPC execution only; no private table grants.
`records_gateway` can only call `records.authenticate_api_key(key, target_datastore)`.
Create distinct LOGIN users inheriting those group roles; never give clients their passwords.
PostgREST must run `records_api.pre_request` and validate signatures and audience. SQL also
checks mandatory issuer, audience, expiry, identifiers, scopes and current grants.
A trusted direct SQL client must set `request.jwt.claims` transaction-locally and use the same
runtime role. These settings are not cryptographic proof: runtime credentials are trusted gateway
credentials, never credentials for arbitrary report authors.

RPC signatures are defined in the numbered migrations (`snapshot_records` is added in 004). `execute_command` accepts a registered command,
object input, idempotency key and optional expected revision. Creation returns
`{record:{id,entity,revision,data},seq,permission_epoch}`. Updates require a matching revision.
Work commands are `work.create` and `work.update`, plus the planning commands of 010 (below);
messaging commands are `messaging.send` and `messaging.edit`. Data uses typed module columns;
extensions are bounded JSON objects. Each mutation adds one immutable journal row (ordinal 0) and
an outbox marker; a `work` datastore's first command also journals its default workflow states at
ordinals 1-7 of the same commit. Change pages never split a commit. The generic
`records_private.records` projection is still written but is internal: no read uses it. No module names or domain branches exist in the command dispatcher.

Authorization takes shared locks on principal, membership and binding, in that order. Writers
then lock their datastore counter before domain rows. Revocation updates take the corresponding
row lock and bump the permission epoch. Transactions serialize per datastore; counter and journal
writes roll back together. A slow transaction cannot be overtaken by another writer. Retry lookup
happens after fresh authorization and before revision checks. Idempotency is scoped to datastore,
principal, binding, module, API major and command. The input digest includes the expected revision.
Only owners may change registry entries or history. The journal is append-only (a trigger refuses
UPDATE, DELETE and TRUNCATE).

## Permissions: storage, presentation and commands (007–009)

Postgres enforces permissions as part of each data model; see the
[design](../../../docs/plans/external_datastores/records-direction.md#authority-attribution-and-permissions).

- **Storage.** Every table has RLS enabled and forced. Tables with `datastore_id` carry a
  RESTRICTIVE `tenant` policy (`datastore_id = records.current_datastore()`), so module rules, which
  are permissive policies, can only narrow it. No client role holds any storage grant.
- **Presentation.** `present_<module>_v<major>` holds one security-barrier view per profile entity
  plus a `history` view over the journal, all owned by `records_presenter` (NOBYPASSRLS, owns no
  table). `records_runtime` has SELECT on these views only. Read rules are view `WHERE` clauses and
  column masks; a masked (NULL) field is absent from the record.
- **API.** `read_records`, `snapshot_records` and `pull_changes` are SECURITY INVOKER: they run as
  `records_runtime` and read only views. `records.read_plan()` authorizes and names the views;
  `records.datastore_state()` returns the counter and epoch in the reading statement's snapshot.
  Readers filtered by a history rule see sequence gaps; the change cursor still advances past them.
- **Commands.** `execute_command` (owner-run) authorizes, handles idempotency and journals; the
  module handler is SECURITY DEFINER owned by `records_commander` (NOBYPASSRLS, owns no table), so
  RLS INSERT/UPDATE policies apply to every write.
- **Actor.** A binding with an `attribution_namespace` may name a delegated actor
  (`<namespace>:<id>`) through the gateway, carried as the RFC 8693 `act` claim and re-checked by
  `authorize`. `records.actor()` returns it, or `records:principal:<uuid>`. `records.stamp_row()`
  sets `created_by`, `updated_by` and (where present) `owner`; owner changes only when a transfer
  handler sets `records.ownership_transfer` to the new owner, and bumps the permission epoch. The
  journal records `actor` and `owner_at_change`; a delegated actor joins the idempotency digest.
- **Roles.** `records_private.actor_roles` (per datastore, per actor) backs `records.has_role()`;
  every change bumps the permission epoch.

Module migrations use `records_private.isolate()`, `present_table()`, `present_history()`,
`register_presentation()` and `register_history()`. Publication runs
`records_private.publication_errors()` and refuses: storage without forced RLS or tenant policy,
any client grant on storage, a profile entity without a view, a view not security-barrier or not
owned by `records_presenter`, a missing history view, a handler not SECURITY DEFINER owned by
`records_commander` with a fixed search path, or a presenter/commander that bypasses RLS. The
check covers every storage table in the database, not only the module being published.

The migration role must be a superuser (or BYPASSRLS): core definer functions (authorization,
journal, registry) run as the owner and enforce rights explicitly. Owner bypass is never how client
data access is granted.

## Work planning model (010)

`work` API v1 grows additively (profile 1.1.0); v1 clients keep working unchanged. Every handler
is SECURITY DEFINER, owned by `records_commander`, with `search_path=pg_catalog`, and refuses
unknown keys and wrong JSON types with PT400. Creates may pass a client `id`, which must be unused
by every work entity in the datastore (PT409). Updates need the revision (PT428 missing, PT412
stale, PT404 unknown). Each entity has a 1:1 presentation view and the shared history view.

| Entity | Fields (data) | Commands |
| --- | --- | --- |
| `work_item` | v1 fields plus `number` (server), `state`, `priority` 0-4, `assignee`, `labels` (≤ 20, 1-60 chars, unique), `estimate` 0-1000, `start_date`, `due_date`, `parent`, `project`, `cycle`, `rank` (≤ 64 printable ASCII), `archived` | `work.create`, `work.update` |
| `project` | `name`, `description`, `state` (planned/active/paused/completed/cancelled), `lead`, `start_date`, `target_date`, `color`, `archived` | `work.project.create`, `.update` |
| `cycle` | `name`, `number` (server), `starts_on`, `ends_on`, `goal` | `work.cycle.create`, `.update` |
| `workflow_state` | `key` (fixed), `name`, `kind` (triage/backlog/unstarted/started/completed/canceled), `category` (derived), `position`, `color`, `wip_limit` | `work.state.create`, `.update` |
| `label` | `key` (fixed), `name`, `color`, `description`, `archived` | `work.label.create`, `.update` |
| `relation` | `from`, `to`, `kind` (blocks/relates/duplicates), `active` | `work.relation.create`; `.update` sets `active` only |
| `comment` | `item`, `body` (1-20,000), `edited` (server) | `work.comment.create`, `.update` (body only) |

Rules enforced in SQL (the datastore row lock serializes them):

- `parent`, `project`, `cycle`, relation endpoints and comment items must exist in the same
  datastore (PT400; composite foreign keys back this up). A parent never forms a cycle (PT409) and
  an item is never its own parent (PT400).
- `status` equals the category of `state` (a trigger enforces it for every writer). `state` alone
  sets `status`; `status` alone keeps the current state if it has that category, else picks the
  category's default (first `unstarted`, `started` or `completed` state by position, then any);
  both disagreeing is PT400. A state in use cannot change category (PT409).
- Cycles do not overlap (inclusive dates, PT409) and do not end before they start (PT400).
- One active relation per kind and pair, `relates` symmetric (PT409); no self-relations (PT400).
- `number` (items and cycles) is `max + 1` per datastore under the datastore lock: gapless and
  unique. Items and cycles are never deleted; items, projects and labels are archived.
- Dates are `YYYY-MM-DD`; actors (`assignee`, `lead`) match `<namespace>:<id>`; colours `#rrggbb`.
  `null` clears an optional field; `labels: []` clears labels (absent when empty).

Default workflow states (`triage`, `backlog`, `todo`, `in_progress`, `in_review`, `done`,
`canceled`) are created by the first command in a datastore without states, inside that command's
commit and attributed to its actor (`records_work.ensure_states`, owner-run, journal ordinals 1-7).
Migration 010 backfilled existing datastores without journalling: states seeded, `number` in
creation order, `state` from `status` (`open→todo`, `active→in_progress`, `done→done`), attribution
untouched, and the permission epoch bumped so synced clients take a new snapshot.

References (`parent`, `project`, `cycle`, `from`, `to`, `item`) carry the target's record id (a
UUID), as record ids do; like ids, they map to IRIs only at the export boundary.

Current limits are explicit:

- A handler changes exactly one record (the default workflow state seed is the only exception).
  Multi-record commands and tombstone/delete semantics are not implemented. Change pages are
  whole-commit since 010 (a page may exceed its limit by the rest of its last commit).
- Presentation reads cost more than the old projection (see
  [the view benchmark](../docs/benchmark-views.md)): about 2× for a 100-record page and 2.5× for a
  5,000-record snapshot.
- Read pages use UUID keyset pagination. They are not a stable multi-page snapshot under concurrent
  writes. `snapshot_records` returns a complete atomic bootstrap with its sequence and epoch,
  bounded to 5,000 records and rejects oversized snapshots with PT413. Streaming exports are pending.
- Change cursors are sequence numbers paired with datastore URL and permission epoch, not signed
  opaque tokens. Epoch mismatch requires the client to purge and reload; initial pulls may omit it.
- Credential revocation prevents new internal tokens immediately. Already issued tokens remain
  valid for the gateway's short TTL unless their binding/principal/membership is also revoked.
  Optional credential expiry is enforced during exchange. No plaintext credential is stored.
- The outbox is durable transaction evidence, not an implemented webhook delivery queue.
- Journal redaction, retention, imports, undo, operator audit, and backups are further delivery gates.
- Error SQLSTATEs PT400/401/403/404/409/412/413/428 are mapped by PostgREST/gateway; internal errors
  must not be exposed by a public gateway. The gateway currently replaces every message with a
  fixed one per status, so the specific work planning messages (for example "Cycle dates overlap
  another cycle") reach SQL clients and tests, not HTTP clients.

`test/database.test.mjs` exercises real embedded PostgreSQL, including concurrency and rollback,
as restricted runtime roles. Signature verification belongs to the PostgREST integration tests.
