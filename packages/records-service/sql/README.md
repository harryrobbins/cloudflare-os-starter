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
The generic projection supports reads and each mutation adds one immutable journal row and
an outbox marker. No module names or domain branches exist in the command dispatcher.

Authorization takes shared locks on principal, membership and binding, in that order. Writers
then lock their datastore counter before domain rows. Revocation updates take the corresponding
row lock and bump the permission epoch. Transactions serialize per datastore; counter and journal
writes roll back together. A slow transaction cannot be overtaken by another writer. Retry lookup
happens after fresh authorization and before revision checks. Idempotency is scoped to datastore,
principal, binding, module, API major and command. The input digest includes the expected revision.
Only owners may change registry entries or history. RLS is defence in depth on physical tables;
security-definer RPCs explicitly authorize because their owner bypasses RLS.

Current limits are explicit:

- A handler changes exactly one record. Multi-record commands and tombstone/delete semantics are
  not implemented; extending them requires whole-commit pagination before enabling batches.
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
