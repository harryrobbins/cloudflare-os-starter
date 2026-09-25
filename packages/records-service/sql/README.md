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
Work commands are `work.create` and `work.update`; messaging commands are `messaging.send`
and `messaging.edit`. Data uses typed module columns; extensions are bounded JSON objects.
Each mutation adds one immutable journal row and an outbox marker. The generic
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

Current limits are explicit:

- A handler changes exactly one record. Multi-record commands and tombstone/delete semantics are
  not implemented; extending them requires whole-commit pagination before enabling batches.
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
  must not be exposed by a public gateway.

`test/database.test.mjs` exercises real embedded PostgreSQL, including concurrency and rollback,
as restricted runtime roles. Signature verification belongs to the PostgREST integration tests.
