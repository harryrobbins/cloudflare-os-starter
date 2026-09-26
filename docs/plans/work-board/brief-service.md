# Brief: Records `work` planning model (migration 010)

Owner: service subagent. Read first: [plan.md](plan.md) ("Data model"),
`packages/records-service/sql/README.md` (permissions section), migrations `002`, `007`–`009`,
`packages/records-model/examples/people/` (a rule-bearing module written to the current contract),
`packages/records-model/profiles/work.json`, `packages/records-service/test/permissions.test.ts`.

## Goal

Extend the bundled `work` module (API v1, additively) with the planning model in plan.md so the
Work Board can be a real project tracker. Existing v1 clients must keep working unchanged.

## Deliverables

1. `packages/records-service/sql/010-work-planning.sql` (one transaction, forward-only):
   - New optional columns on `records_work.items`: `number bigint` (server-assigned, unique per
     datastore, never client input), `state text`, `priority smallint CHECK 0..4`, `assignee text`
     (actor pattern), `labels text[]` (≤ 20, each 1–60 chars, no duplicates), `estimate numeric`
     (0–1000), `start_date date`, `due_date date`, `parent uuid`, `project uuid`, `cycle uuid`,
     `rank text` (≤ 64), `archived boolean NOT NULL DEFAULT false`. Backfill `number` for existing
     rows in created order. Useful indexes (datastore+state, +assignee, +project, +cycle, +parent).
   - New tables in `records_work`: `projects`, `cycles`, `workflow_states`, `labels`, `relations`,
     `comments`, with columns per plan.md, `datastore_id`, `id`, `revision`, `created_by`,
     `updated_by`, stamp trigger, `records_private.isolate()`, `members` policies for presenter and
     commander, grants, FKs within the same datastore (composite `(datastore_id, id)`).
   - Integrity enforced in SQL: `parent`/`project`/`cycle`/relation endpoints must exist in the same
     datastore; no parent cycles; no self-relations; no duplicate active relation of the same kind;
     cycles must not overlap; `state` must name an existing workflow state and `status` is set from
     its category (a client sending only `status` gets the first state of that category;
     sending both inconsistently is PT400); cycle/`number` assignment race-free (execute_command
     already holds the datastore row lock).
   - Default workflow states seeded lazily per datastore on the first command if none exist:
     `backlog` (open), `todo` (open), `in_progress` (active), `in_review` (active), `done` (done),
     `cancelled` (done, cancelled). Existing items map `open→todo`, `active→in_progress`,
     `done→done` when first touched or via backfill for existing datastores.
   - Handlers: extend `records_work.apply` (or add per-entity handler functions, each SECURITY
     DEFINER owned by `records_commander`, fixed `search_path`) for commands `work.create`,
     `work.update`, `work.project.create|update`, `work.cycle.create|update`,
     `work.state.create|update`, `work.label.create|update`, `work.relation.create|update`,
     `work.comment.create|update`. Unknown keys are PT400; updates need the revision (PT428/412
     as today); `work.update` with `labels` replaces the array; extensions still whole-object.
     Handlers return `{id, entity, created_by, updated_by, data}` like the current ones.
   - Presentation: 1:1 views for every entity via `records_private.present_table`, registered;
     history view unchanged (all readers). Register commands in `records_private.commands`, update
     the module manifest (`entities`, `commands`). The migration must end by asserting
     `publication_errors('work',1)` is empty (as 008 does).
2. `packages/records-model/profiles/work.json`: additive fields and entities with Schema.org
   terms where natural (`https://schema.org/` pinned 30.1: e.g. `Project`, `name`, `description`,
   `startDate`, `endDate`, `keywords` for labels, `Comment`, `text`), `urn:records:work:*` otherwise;
   `reference` for IRIs. Must pass `validateProfile` and `validateUpgrade` from the current profile
   (additive only). `getRuntimeProfile('work')` feeds the deploy migrate job.
3. Tests (`packages/records-service/test/work-planning.test.ts`, embedded Postgres, add to
   `test:run`): every command happy path; every integrity rule refused with the right SQLSTATE;
   number assignment under 12 concurrent creates is gapless and unique; reads/snapshot/changes
   return new fields and entities; old v1-shaped input still works; existing datastore backfill;
   runtime role still cannot touch storage; `publication_errors` empty. Update
   `test/database-helpers.mjs` migration list.
4. Docs: `sql/README.md` (work planning section), service `README.md` command table, and
   `docs/plans/external_datastores/records-delivery.md` (a short "Work planning model" entry).
5. Update the connector's types if the command/entity list is declared there
   (`packages/gatekeeper-records-service/src/types.d.ts`: also add `actor` to `RecordsChange`).

## Rules

- Work in your git worktree; commit on your branch with clear messages ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push, deploy, or touch `ms`.
- Do not edit migrations 001–009 (applied in production). Do not change existing command
  semantics except as additive extensions.
- Run `pnpm --filter @records/service test:run`, `pnpm --filter @records/service types:check` and
  the records-model tests before finishing. Report: files changed, command list with input shapes,
  anything you decided that the board needs to know (field names, error messages, limits).
