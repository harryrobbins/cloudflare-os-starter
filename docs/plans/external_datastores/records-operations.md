# Records operations runbook

> **Records direction superseded — 2026-09-25.** The current recommendation and delivery plan is [Records: shared application data](records-direction.md). This document is retained as historical research, implementation evidence or a separate gadget-HTTP proposal; it is not the specification for the new Records service. Existing deployment records remain historical facts, not instructions to deploy the new design.

> **Framing superseded (2026-09-25)** by [App datastore service: reframing](app-datastore-service.md). Records is a
> generic, schema-driven datastore for apps built on cloudflare-os. It was never meant to be a
> Jira-like product or a Projects service: project management with a Jira mapping is one example
> module. The concepts may inform later operational work, but these commands target legacy tables/functions
> and must not be run on the new service. Its redaction and retention commands are not implemented.
> Use [the current deployment runbook](../../../packages/records-service/deploy/README.md) and
> [status](records-status.md); Neon branch operations do not apply to the homeserver database.

Written 2026-09-25 against starter `main` `019df76`, with Phase 6 of the
[canonical Postgres datastore](canonical-postgres-datastore.md) plan (§8, §10 Phase 6, acceptance
§11.7) built on top. Status: **code, migration and local tests only. Nothing here has been run
against Neon, R2 or Cloudflare.** Every command below that touches production is for an operator to
run after the checks in §2.

Code:

| Piece | Where |
| --- | --- |
| Migration `0009_operations` | `packages/records-schema/migrations/0009_operations.sql` |
| Restore, redaction, archival, analytics logins | `packages/records-core/src/ops/` (exported from `@records/core`) |
| Operator commands | `packages/records-schema/src/cli.ts` → `src/ops-cli.ts` |
| Backup and restore rehearsal | `scripts/records/backup.sh`, `scripts/records/restore-rehearsal.sh`, `scripts/records/verify.sql` |
| Tests | `packages/records-core/__tests__/ops-*.test.ts` |

Every operator command runs as the migration owner (`RECORDS_MIGRATION_URL`, `neondb_owner` in
production), prints what it would do, and changes nothing unless `--apply` is given. Run them from
`packages/records-schema`:

```sh
cd packages/records-schema
set -a; . ../../.env.local; set +a        # RECORDS_MIGRATION_URL and friends; never commit them
node src/cli.ts <command> [flags]         # add --apply only after reading the dry run
```

## 1. What exists today

| Protection | State |
| --- | --- |
| Neon history (point-in-time restore) | Free plan: **6 hours**. The only backup today (see the [deployment record](organisation-datastores.md#12-deployment-record-2026-09-24)) |
| Logical backups | None yet. `scripts/records/backup.sh` is ready; no bucket exists |
| Restore rehearsal | Scripted; run locally against a synthetic database only |
| Per-datastore restore | Built and tested locally (`restore-datastore`) |
| Redaction | Built and tested locally (`redact`) |
| Journal retention | Built and tested locally (`archive-journal`); no policy chosen, nothing archived |
| Analytics | Views and role in migration 0009; no login, no read replica |
| Journal partitions | Created three months ahead by the Worker's hourly cron (`records.ensure_journal_partitions`) |

**Recommendation.** Before a team relies on Records: move the Neon project to a paid plan with at
least 7 days of history (check Neon's current plan limits; longer is better), and run the nightly
dump to R2 with a 30-day lock (§3). Six hours means a mistake found the next morning is
unrecoverable.

## 2. Before any production change

Follow `.agents/skills/cloudflare-os-operator/SKILL.md` and the repository `CLAUDE.md`. For the
operations here that means, in order:

1. **Account and target.** `RECORDS_NEON_PROJECT_ID` is `jolly-silence-27253955`, branch `main`, and
   `RECORDS_MIGRATION_URL` points at `ep-still-brook-zaw5ewhf` (the direct endpoint). For a restore,
   `RECORDS_RESTORE_SOURCE_URL` points at the **restore branch**, never at `main`.
2. **Schema.** `node src/cli.ts status` shows every migration applied, including
   `0009_operations`. Applying 0009 is itself a production change: it needs a validated
   `pnpm check` and the operator's approval, like any migration.
3. **Last known good.** Take a fresh dump (`backup.sh`) and note the time. For a restore or
   redaction, also note the datastore's clock: `SELECT seq FROM records.datastore_clock WHERE datastore_id = '<id>'`.
4. **Dry run.** Run the command without `--apply` and read the whole output.
5. **Rollback.** Know it before applying: a per-datastore restore can be undone by another restore
   to the clock noted in step 3. A redaction cannot be undone (that is its purpose). Archival can be
   undone only while the partition is kept detached (§7).
6. **After.** Run `scripts/records/verify.sql` read-only against production
   (`psql "$RECORDS_MIGRATION_URL" -f scripts/records/verify.sql`); every check must be `ok`.

## 3. Backups

### One-time bucket setup (not yet done)

The bucket holds nightly dumps and archived journal partitions. The lock rule makes objects under
the prefix undeletable for 30 days, so a compromised credential cannot erase them; the lifecycle
rule deletes them a day after the lock lapses. A lifecycle rule shorter than the lock would fail to
delete locked objects.

```sh
pnpm exec wrangler r2 bucket create cfos-records-backups
pnpm exec wrangler r2 bucket lock add cfos-records-backups lock-30d records/pg_dump/ --retention-days 30
pnpm exec wrangler r2 bucket lifecycle add cfos-records-backups expire-31d records/pg_dump/ --expire-days 31
# Archived journal partitions are kept for as long as the retention policy says (§7), not 30 days:
pnpm exec wrangler r2 bucket lock add cfos-records-backups lock-journal records/journal/ --retention-indefinite
```

Check with `wrangler r2 bucket lock list cfos-records-backups` and
`wrangler r2 bucket lifecycle list cfos-records-backups`.

### Nightly dump

```sh
scripts/records/backup.sh --env-file .env.local --r2-bucket cfos-records-backups
```

What it does: `pg_dump --format=custom` of the whole database as the owner, to
`~/.local/state/cfos-records-backups/records-neondb-<UTC time>.dump` (mode 600, outside the
repository), checks the file with `pg_restore --list`, writes a `.sha256` beside it, uploads both to
`records/pg_dump/` with the project's Wrangler, and keeps the newest 7 local copies
(`--keep-local`). It reads only `RECORDS_MIGRATION_URL` from the env file and passes it to `pg_dump`
through libpq environment variables, never on a command line. `pg_dump` must be version 17 or newer;
without one on `PATH` the script runs it from the `postgres:17` Docker image.

Schedule it once a day from a machine that holds `.env.local`, for example a user crontab entry:

```cron
17 3 * * * cd /var/web/cloudflare-os-starter && scripts/records/backup.sh --env-file .env.local --r2-bucket cfos-records-backups >> ~/.local/state/cfos-records-backups/backup.log 2>&1
```

The dump holds personal data (principals' e-mail addresses and record text). Treat the bucket and
the local directory as production data. A redaction does not reach existing dumps (§6).

## 4. Restore rehearsal

Rehearse after setting up backups, after each schema migration, and monthly:

```sh
scripts/records/restore-rehearsal.sh ~/.local/state/cfos-records-backups/records-neondb-<time>.dump
# or from R2:
pnpm exec wrangler r2 object get cfos-records-backups/records/pg_dump/<file>.dump --file /tmp/r.dump --remote
pnpm exec wrangler r2 object get cfos-records-backups/records/pg_dump/<file>.dump.sha256 --file /tmp/r.dump.sha256 --remote
scripts/records/restore-rehearsal.sh /tmp/r.dump
```

The script checks the SHA-256, starts a throwaway `postgres:17` container with no published port,
restores into it with `--no-owner`, runs `scripts/records/verify.sql` and removes the container
(`--keep` leaves it for inspection). It prints the restore time: record it as the measured recovery
time. It exits non-zero if any check fails:

| Check | Meaning of a failure |
| --- | --- |
| `clock_matches_journal` | A datastore's clock is not its highest journal seq |
| `journal_gapless` | Retained seqs have a hole |
| `journal_presence` | A current row names a journal entry that does not exist (and was not archived) |
| `journal_rebuild` | A current field differs from its latest journaled value |
| `rls_enabled` | A tenant table lost row-level security |

Tested locally on 2026-09-25: a healthy dump passes; a dump with one title changed behind the
triggers fails `journal_rebuild`.

### Whole-database restore

For a loss that affects everything (a bad migration, a dropped schema), restore the whole branch in
Neon (console: Branches → `main` → Restore, to a time inside the history window), or restore a dump
into a new Neon branch with `pg_restore --no-owner --dbname=<branch owner URL>`, then point Hyperdrive
at it. Both rewind every datastore; prefer §5 when only one datastore is damaged.

## 5. Restoring one datastore

Plan §8 and acceptance §11.7: one datastore goes back to an earlier point; the others do not move.

**How it works.** A Neon branch restored to a time before the damage holds the journal as it was.
The journal is append-only, so its entries up to the chosen seq are the same entries production
still has (the command compares their change IDs and refuses a branch whose history differs). The
command folds that journal into the state at the chosen seq and brings production to it with new
journal entries: command `system.restoreDatastore`, `via: system`, the operator as actor, in one
transaction. History is appended to, never rewritten. It writes an audit event
(`restoreDatastore`, with counts and the reason) and outbox events, so the project board and sync
clients converge through an ordinary delta. Redactions recorded in production are re-applied, so a
branch taken before a redaction never brings the text back.

**What it restores:** project name and description; issue title, description, state, priority,
assignee and custom fields; and any project, issue or comment that existed at that seq and is now
missing, recreated with its original ID (journal op `restore`).

**What it cannot do**, reported in the output instead:

- `cannotRemove`: entities created after the chosen seq. The model has no delete or archive yet,
  so nothing can journal a removal. Close or edit them by hand, or wait for an archive command.
- `unresolved`: a comment whose body differs (comments are append-only), a changed project key or
  issue number, an issue whose old workflow state no longer exists, a missing assignee.
- Configuration is not journaled and is not restored: workflow states and transitions, custom field
  definitions, memberships, bindings, credentials.
- A journal whose first partitions were archived (§7) cannot be replayed from seq 1; the command
  refuses. Restore from a dump taken before the archival instead.

**Steps.**

1. Find the point. Either a time, or a seq from the datastore's history
   (`SELECT seq, command, entity_type, occurred_at FROM records.journal WHERE datastore_id = '<id>' ORDER BY seq DESC LIMIT 50`).
2. Create a branch at a time just after that point, inside the history window. Console: Branches →
   New branch → parent `main`, "Past point in time". Or the API:

   ```sh
   curl -sS -X POST "https://console.neon.tech/api/v2/projects/$RECORDS_NEON_PROJECT_ID/branches" \
     -H "Authorization: Bearer $NEON_ORG_TOKEN" -H 'Content-Type: application/json' \
     -d '{"branch":{"name":"restore-<date>","parent_timestamp":"<ISO time>"},"endpoints":[{"type":"read_write"}]}'
   ```

   Copy the branch's `neondb_owner` connection string (direct host) into
   `RECORDS_RESTORE_SOURCE_URL`.
3. Dry run, then read the plan: every `changes` entry, every `cannotRemove` and `unresolved` entry.

   ```sh
   node src/cli.ts restore-datastore --datastore <id> --actor <your principal id> --upto-time <ISO time> --reason "<ticket>"
   # or --upto-seq <n>
   ```

   `--upto-time` picks the last seq whose transaction began at or before that instant (to the
   millisecond); `--upto-seq` is exact.
4. Apply with `--apply`. Keep the printed report (it names the seqs written and the command ID).
5. Check: `verify.sql` against production; open the datastore in the project board; confirm the
   other datastores' clocks did not move.
6. Delete the restore branch in Neon.

To undo a restore, run it again against a branch taken just before it, to the clock noted in §2.

## 6. Redaction

Plan §8, "Erasure". The journal holds principal IDs, not personal details, so erasing a person is
mostly removing their registry details (display name, e-mail) as the owner. Free text written into
records is removed with `redact`: the one sanctioned exception to journal immutability.

```sh
node src/cli.ts redact --datastore <id> --entity-type issue --entity-id <id> \
  --fields title,description --reason "<request reference>" --actor <your principal id>
```

Redactable fields: project `name`, `description`; issue `title`, `description`; comment `body`.
The dry run prints where the text occurs (journal entries, saved outcomes) and the current lengths,
never the text itself. With `--apply` the owner-only procedure `records_ops.redact` overwrites the
fields with `[redacted]` (`--marker` to change it) in the current row, in every past journal entry's
`after` and `before`, and in saved idempotency outcomes; journals a `redact` entry
(`system.redact`, `via: system`); bumps the revision; writes an audit event with the reason and a
row in `records_ops.redactions`; and emits `issue.updated` for issues so clients refetch. Do not put
the text itself in the reason.

**Why only this path can rewrite the journal.** Migration 0009 tightens the append-only trigger:
UPDATE is refused to every role, the owner included, unless it runs inside `records_ops.redact`
(which sets `records.journal_redaction` for its own duration) and changes only `after` and `before`.
The runtime roles hold no UPDATE privilege on the journal, cannot see the `records_ops` schema and
cannot execute the procedure; any role other than the owner is refused by the trigger even with the
setting on. Tests: `ops-redact.test.ts`. The owner can still disable the trigger, so owner
credentials remain the thing to protect.

**What it does not reach:** Neon history (until it ages out: 6 hours today), existing dumps and
their R2 copies (until the lifecycle rule deletes them, 31 days), archived journal files in R2, webhook
and Queue deliveries already sent, and clients' local caches until they next pull. Tell the requester
the date by which every copy is gone. A per-datastore restore re-applies the redaction (§5); a
whole-database restore from an older backup does not, so re-run the redactions in
`records_ops.redactions` after one.

## 7. Journal retention and archival

Plan §8, "Retention". The journal is partitioned by month (`records.journal_YYYYmMM`). Partitions
older than the retention window are exported as NDJSON (gzip), uploaded to R2 and detached.

No retention window has been chosen. The journal is small (a row per change), so there is no
pressure yet; a window of at least 24 months is suggested. Decide it with the owner before the first
run.

```sh
node src/cli.ts archive-journal --older-than-months 24 --out-dir ~/.local/state/cfos-records-archive
```

The dry run lists eligible partitions, their row counts and per-datastore seq ranges. With
`--apply`, oldest first, for each partition: export to `<partition>.ndjson.gz` (mode 600, with its
SHA-256), re-count the rows, `DETACH PARTITION`, and record the partition in
`records_ops.journal_archives`. By default the detached table is **kept** in the database (no
longer part of the journal, invisible to the service) until the upload is verified:

```sh
pnpm exec wrangler r2 object put cfos-records-backups/records/journal/<partition>.ndjson.gz --file <file> --remote
pnpm exec wrangler r2 object get cfos-records-backups/records/journal/<partition>.ndjson.gz --file /tmp/check.gz --remote
sha256sum /tmp/check.gz        # must match the sha256 in records_ops.journal_archives
psql "$RECORDS_MIGRATION_URL" -c "DROP TABLE records.<partition>; UPDATE records_ops.journal_archives SET dropped = true WHERE partition = '<partition>'"
```

To undo before the drop: `ALTER TABLE records.journal ATTACH PARTITION records.<partition> FOR VALUES FROM (...) TO (...)`
with the range from the ledger, then delete the ledger row. `--drop` drops at once instead; use it
only when the export directory is itself durable.

Safety rules the command enforces:

- It only removes a prefix of each datastore's history. `occurred_at` is a transaction's start, so a
  transaction that straddled a month boundary can leave a higher seq in the older month. Such a
  partition is refused, and newer ones wait.
- The row count is re-checked in the detaching transaction.
- `DETACH` (not `CONCURRENTLY`, which a default partition forbids) briefly takes an exclusive lock
  on the journal: writes pause for a moment. Run it at a quiet time.

**After archival**, readers treat the smallest retained seq as the start of history: the changes
feed answers `resetRequired`, and a sync pull with an older cookie gets full state (tested in
`ops-archive.test.ts`). Migration 0009 also relaxes the journal-presence check so that bookkeeping
updates (issue-number allocation) on a row whose last entry was archived still work; before it, the
first new issue in such a project would have failed.

## 8. Partition maintenance

The `cfos-records` Worker's cron calls `records.ensure_journal_partitions(3)` at the top of each hour
(`packages/gatekeeper-records/src/index.ts`), keeping this month and three more. If that lapses, rows
land in `records.journal_default` and the next run moves them. Check monthly:

```sql
SELECT count(*) FROM records.journal_default;                          -- expect 0
SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
 WHERE i.inhparent = 'records.journal'::regclass ORDER BY 1;           -- this month + 3
```

`verify.sql` reports both under `journal_partitions`.

## 9. Analytics access

Plan §8, "Analytics". Migration 0009 publishes a versioned contract in the `analytics` schema:

| View | Rows |
| --- | --- |
| `analytics.datastores_v1` | Datastores: name, module, lifecycle |
| `analytics.projects_v1` | Projects: key, name, description |
| `analytics.issues_v1` | Issues with project key, issue key, state name and category, comment count |
| `analytics.daily_activity_v1` | Journal activity per datastore, UTC day, entity type, operation and channel: changes, transactions, distinct actors |

A breaking change adds `_v2` beside `_v1`; never change a published view incompatibly.

The views are `security_invoker`, so the base tables' row-level security applies. The
`records_analytics` group role (NOLOGIN) has its own read policies, keyed to the **login it connected
as** (`session_user`, which a session cannot change) through `records_ops.analytics_logins`, not to a
setting a client could forge. An analytics login therefore sees exactly the datastores its mapped
principal can read (`issues.read`), and nothing once that principal is disabled or loses its
membership. It holds SELECT on the columns the views use only (no journal bodies, no credentials,
no registry details), defaults to read-only transactions and has a connection limit of 3.

To give a BI tool access, create a service principal with reader memberships on the datastores it
should see (Data page), then:

```sh
node src/cli.ts analytics-grant --login analytics_<tool> --principal <service principal id>          # dry run
RECORDS_ANALYTICS_PASSWORD='<from a password manager>' node src/cli.ts analytics-grant --login analytics_<tool> --principal <id> --apply
```

Without `RECORDS_ANALYTICS_PASSWORD` a password is generated and printed once. Give the tool a
**read replica** endpoint rather than the read-write one, so heavy queries never compete with the
service. In Neon, add a read-only compute to `main` (console: Branches → `main` → Add read replica, or
`POST /projects/{id}/endpoints` with `{"endpoint":{"branch_id":"br-sweet-flower-zadhywpm","type":"read_only"}}`);
it shares storage and roles with `main`, so the login works there unchanged.

To revoke: `DROP ROLE analytics_<tool>; DELETE FROM records_ops.analytics_logins WHERE login = 'analytics_<tool>';`
(or disable the principal, which empties its view at once).

If a warehouse is ever wanted, extract incrementally from the journal by `(datastore_id, seq)`.

## 10. What migration 0009 changes

| Change | Why |
| --- | --- |
| `records.journal_append_only` refuses owner UPDATEs except inside `records_ops.redact` | Redaction is the only sanctioned rewrite; owner DELETE and TRUNCATE stay allowed for partition maintenance |
| `records.require_journal_entry` skips updates that keep `last_seq` | Retention: bookkeeping updates on rows whose last entry was archived. Content changes still must advance `last_seq` and name a new entry (acceptance §11.4 holds) |
| `records_ops` schema: `redact`, `redactions`, `journal_archives`, `analytics_logins` | Operator-only; no runtime role has USAGE |
| `records_analytics` role, `analytics` schema, four `_v1` views, read policies | §9 |

The operator functions live in `records_ops` and `analytics`, not `records`, so the runtime schema's
list of SECURITY DEFINER functions is unchanged.

## 11. Open items for the operator

- [ ] Approve and apply migration 0009 in production (a production change: `pnpm check`, mutation summary, then `db:migrate`).
- [ ] Move Neon to a paid plan with a longer history window.
- [ ] Create the R2 bucket, lock and lifecycle rules (§3), then schedule the nightly dump.
- [ ] First restore rehearsal against a real dump; record the restore time.
- [ ] Choose the journal retention window.
- [ ] Decide whether analytics is wanted now; if so, add the read replica and the first login.
- [ ] Add an archive (soft-delete) command to the Projects module so a restore can remove entities
      created after the restore point.
