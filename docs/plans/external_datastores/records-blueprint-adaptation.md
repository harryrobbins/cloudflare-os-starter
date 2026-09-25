# Adapt the board and report blueprints to the new Records service

2026-09-25 · **Implementation plan.** Board and connector implemented in `packages/blueprint-work-board` and `packages/gatekeeper-records-service`; the report and the acceptance gates below remain open.

This plan follows [the Records direction](records-direction.md) and the new service's actual
interfaces. It replaces the earlier assumption that the existing Projects blueprint can connect
to the new service by changing an endpoint. Preserve existing installed blueprints and their
legacy backend while developing independently versioned replacements.

## Outcome and first scope

Publish a **Work Board** and a read-only **Work Report** backed by the same canonical `work`
datastore. Start with title, description and the three current statuses. Both apps must reflect
changes made by another gadget or an authorised external client. Removing either gadget must
leave the datastore intact.

The board is an open work application. A Jira or Linear adapter can translate a vendor-shaped
request into this model, but neither vendor determines the model, the blueprint API or the
authority boundary. Use Jira-shaped issue fields below as one concrete mapping exercise, not
as a commitment to Jira SDK compatibility or parity with Linear's workflows.

Do not retain inert assignee selectors, project filters, comments or custom workflow controls
in the new UI. These need real module capabilities before they can be offered. The old Project
Board remains the available experience for installations depending on those features.

## What exists and what still needs building

| Area | Present in the repository | Required for this adaptation |
| --- | --- | --- |
| Service | `packages/records-service/src/client.ts`: description, scoped module binding, reads, bounded snapshot, journal pull, retry-safe commands | A browser-facing RPC transport and state controller for this contract |
| Work model | `packages/records-model/profiles/work.json`; executable SQL under `packages/records-service/sql/002-modules.sql` and subsequent migrations | UI projected from `work_item` data, not legacy issue objects |
| Host approval adapter | `packages/records-service/src/cloudflare-os.ts`: `RecordsOsBridge`, exact viewer assertions, durable-store interface, observations, apply/reject callbacks | A deployed, registered gatekeeper implementing its host interfaces and persistent lifecycle |
| Identity | Service checks current principal, membership, binding, scopes and credential validity | Enrolled Cloudflare OS identity resolution and secure per-viewer credential provisioning/refresh |
| Sync | `snapshot`, `changes`; SSE hints and periodic reconciliation; client SDK can pull the durable journal | Gadget-local state isolation, permission-reset UX, approval polling and reconnect handling |
| Existing blueprints | `blueprint-project-board` and `blueprint-project-report` use the old `projects` module and sync protocol | New archive identities, service requirement and public session typings |

The live website/API and structural queue tests do **not** mean the new Cloudflare OS
gatekeeper is already registered. `bindViewer` is a read-only host integration seam;
`executeApprovedCommand` is an OS-neutral approval contract. Neither supplies the missing
deployment, credential broker or observer enrollment by itself.

## Exact code migration map

Create `packages/blueprint-work-board` and `packages/blueprint-work-report` as new packages.
Copy useful presentation and packaging code from the following sources, then make the stated
changes in the new packages. Do not edit or republish the original archives in place.

| Existing source | Change in the new package |
| --- | --- |
| Both `src/service-requirement.json` | Change `moduleId: projects` to `work`, API major 1. Board requests `work.read` and `work.write`; report requests only `work.read`. Remove legacy feature names. |
| Both `src/shared/records.js` | Replace Projects copy and vendor-type imports. Describe the new resource type and connector name. Define stable serialisable service errors rather than parsing legacy error strings. |
| Both `src/server/proxy.js` | Expose only the new observed session's `describe`, `records`, `snapshot`, `changes`; board additionally exposes `command` and `getOutcome`. Do not expose credentials or a generic URL-fetch method. |
| Board `src/client/transport.js` | Replace `syncPush/syncPull/syncApprovals` with exact-intent command submission, outcome polling and journal reads. Use the new digest format described below. |
| Board `src/client/model.js` | Read `{id, entity, revision, data}` records. Group `data.status` into open/active/done; use `data.title`. Remove project prefixes, issue numbers, priority ranking, assignees and comments. |
| Board `src/client/ui/app.js` | Replace legacy `SyncClient` setup and Projects predictors. Add explicit queued/approved/conflict states. Use ordinary forms and a pending overlay; committed state comes from the service. |
| Report `src/client/transport.js`, `src/client/report.js`, `src/client/app.js` | Replace old sync envelopes and `listIssues` pagination. Report status totals and supported text fields only. Remove unsupported assignee/priority/project aggregations. Keep CSV export with existing escaping protections. |
| Both `src/server/pokes.js`, `src/client/pokes.js` | Start with bounded polling of `changes`. Do not call the old `onChange` hook until the new connector actually implements an approved hook capability. |
| Both `src/server/index.js` | Wire only the new proxy methods through gadget RPC. Keep host-only apply/reject operations off this surface. |
| Both `format.json`, `gadget.lock.json`, `scripts/pack-gadget.mjs` | Assign new blueprint IDs, for example `format.work-board` / `format.work-report`, and archive stems `work-board` / `work-report`. Generate fresh content hashes and revisions. |
| Both `src/README.md`, package `README.md`, test fixtures | Document the reduced supported model and bind steps; replace legacy Projects fake sessions with the new module contract. |

Do not make the new packages depend on `gatekeeper-records/src/vendor/types.d.ts`,
Projects-specific predictors, `records-jira`, or the old sync client's mutation acknowledgement
format. A journal cursor is not a legacy `cookie`, and `changes` is not a legacy `patch` response.

Suggested new board requirement:

```json
{
  "service": "records",
  "moduleId": "work",
  "apiMajor": 1,
  "features": [],
  "scopes": ["work.read", "work.write"]
}
```

The current SDK checks module/API major, granted scopes and requested features. Its
`BlueprintRequirement` does not require the archive's `service` field; the platform manifest
retains that discovery metadata. Empty features here mean no unimplemented feature is being
claimed. If features are introduced later, publish and validate them in the module manifest
before a blueprint requires them.

## Host integration and authority

Build a separate connector package, provisionally `packages/gatekeeper-records-service`.
Assign it a distinct connector/resource identity until an explicit migration is available.
Do not point the existing `records://datastore/*` registration at incompatible methods.

Implement `RecordsOsHost` against real Cloudflare OS capabilities:

1. Store binding configuration server-side: service URL, organisation/datastore identity,
   module/API requirement and binding ID. Validate the requirement before exposing a session.
2. Map an enrolled platform issuer and viewer account to a Records principal. Do not infer
   identity from a browser-provided name, an unverified email address or `gadgetViewer` alone.
3. Implement `readClient()` and `resolveViewer()` using current, revocable credentials with the
   necessary datastore/binding scope. Keep both service credentials and Access origin secrets
   inside the host. A shared administrator API key is not a per-viewer credential broker.
4. Implement `PendingActionStore` with durable host storage. Atomically allocate monotonically
   increasing action IDs and persist immutable intent before `submitAction`. Preserve pending
   actions through restarts; define outcome retention and safe retry after partial failure.
5. Connect `RecordsOsBridge.session()` to gadget RPC. Connect the gatekeeper's trusted
   `applyAction` and `rejectAction` callbacks to the bridge separately. Never expose those
   callbacks through gadget methods.
6. Implement observer registration and current `canRead` checks. Every protected read,
   including description, sync and action outcomes, must pass `authorizeObservation`; excluded
   observers must not receive results. Do not declare private datastore data workspace-readable.
7. Test revoked credentials, changed principal mappings and removed bindings again at apply
   time. An approval obtained earlier does not freeze permission indefinitely.

Before implementing or registering this new gatekeeper, review its public capability contract
against the then-current upstream `cloudflare-os/packages/workshop-shared/src/gatekeeper.ts`
and the repository's applicable write-gatekeeper guidance. Record any required upstream API
review or approval as that future implementation gate. This planning document does not change
an upstream interface, require that review now, or claim it has already happened.

## Canonical work model and adapter exercise

Current stored envelopes contain `id`, `entity`, `revision` and `data`. The executable entity
is `work_item`; its data supports `title`, `status`, `description`, and a JSON `extensions`
object. Status values are exactly `open`, `active`, `done`.

| Example imported issue field | Canonical target | Rule and limitation |
| --- | --- | --- |
| Summary/title | `data.title` → `schema:name` | Required, 1–500 characters. Reject invalid input rather than silently truncate. |
| Description | `data.description` → `schema:description` | Preserve plain text. A rich-text source needs an explicit conversion and loss report. |
| Status | `data.status` → `urn:records:work:status` | A versioned adapter table maps source statuses to open/active/done. Mapping many source states to one target is lossy and not a workflow engine. |
| External issue ID/key | Adapter-owned external-ID mapping | Keep source system, instance and identifier together. Do not replace Records UUID identity or use a vendor key as the canonical type. |
| Project | No current project relation | A separate datastore is one possible initial grouping, not a claim that datastores and projects are equivalent. A project entity/relation needs a real profile/module extension. |
| Assignee/reporter | No current typed people relation | Do not fabricate membership or equate vendor users with Records principals. Requires identity mapping, relations and access rules. |
| Priority, labels, dates | No current first-class fields | Explicit namespaced extension metadata may preserve source values, but provides no typed filtering, validation or workflow semantics by itself. |
| Comments, attachments, transitions | Unsupported by current work commands | Retain in the source/export until corresponding entities, permissions and commands are implemented. Do not pretend description text reproduces these features. |

Jira and Linear compatibility packages may be built independently of the Records team. Each
owns authentication to its source, enum translation, external IDs, pagination, rich-text
conversion, error translation and explicit unsupported operations. Their tests must distinguish
field compatibility from behavioural compatibility. Do not put vendor IDs on generic core
tables or add vendor conditionals to command dispatch.

An optional first adapter deliverable is a **dry-run importer** producing canonical candidate
records and a per-field loss report. Follow with separately approved imports through
`work.create`. Full SDK emulation, bidirectional sync and conflict ownership are later projects.

## Snapshot, journal and pending UI

1. On a new binding or viewer context, clear any incompatible cache and request an observed
   `snapshot(limit)`. Validate `complete: true`; atomically store its records, `seq` and
   `permission_epoch`. Cache keys include service, datastore, binding and authorised view.
2. Pull `changes(after=seq, epoch=permission_epoch)`. Apply a whole page before persisting its
   cursor. Keep polling after lost hints or reconnection; SSE is an optimisation, not authority.
3. On epoch mismatch/reset, purge cached records and pending visual projections before a new
   snapshot. On 401/403 stop displaying protected data and require a fresh authorised binding.
   Do not keep showing the last successful private snapshot after revocation.
4. The current snapshot is complete and bounded: default 1,000, maximum 5,000 records. An
   oversized result returns 413. Show an explicit unsupported-size state; do not replace it
   with independently paged reads and call that a consistent snapshot. Larger snapshots are
   a separate service feature with their own acceptance tests.
5. Keep pending command intent separate from committed records. Show queued, applied, rejected
   and conflict states. A pending status must not increase committed report totals. Initial
   UI predictions are optional and cannot substitute for server validation.

The current service commands affect one record per commit. Before adding multi-record module
commands, verify journal page boundaries preserve whole commits or introduce an ordinal-aware
cursor. Do not assume the current numeric cursor already provides arbitrary batch pagination.

## Approved command flow

The browser constructs one complete intent containing `datastore`, `binding`, `moduleId`,
`apiMajor`, `command`, `input`, `expectedRevision`, and `idempotencyKey`. Compute its
`recordsOsIntentDigest` and call the platform's `$createViewerAssertion` for the binding.
The digest is raw lowercase SHA-256 hex, unlike the prefixed OS-neutral helper result.

Forward intent and assertion without changing defaults or values after hashing. The trusted
bridge consumes the assertion for that exact digest, resolves the viewer, persists the pending
intent, and submits an action. Only the later kernel `applyAction` callback invokes the
Records command, using newly checked viewer authority. The browser receives a pending action
ID and reads its outcome through the observed session.

Use `work.create` for `{title, status?, description?, extensions?}`. Use `work.update` with
the existing record ID and supported changed fields, supplying the last committed revision;
the HTTP client sends its quoted `If-Match`. Confirm the installed command schema when wiring
forms rather than copying legacy issue mutation envelopes.

Generate and persist an idempotency key once per logical command. Retry ambiguous execution
with identical input, key and revision. A new edit gets a new key. A stale revision (412)
requires reloading and showing a conflict; do not silently overwrite or invent an incremented
revision. Missing required revision (428) is a client defect. Submission retries need a fresh
one-use viewer assertion; pending actions already accepted by the kernel must instead be
recovered by action ID, not repeatedly resubmitted as new approval requests.

## Delivery checklist and acceptance gates

- [ ] **Contract fixtures:** new board/report requirements, work model fixtures and protocol
  types; incompatible major, missing scope and missing feature fail before UI operation.
- [ ] **Registered connector in staging:** real durable pending storage, enrolled viewer
  credential resolution, observer verification, kernel callbacks and approved public API
  review completed. Test against the actual platform, not only structural queue doubles.
- [ ] **Read-only report first:** a fresh snapshot plus later external writes converge; counts
  and CSV cover supported fields; limits and permission resets are visible and fail closed.
- [ ] **Board writes:** title/description/status forms, exact-intent assertions, pending states,
  conflicts and identical-key retries. No execution before approval; denied/altered intent
  executes nothing; removed viewer/binding cannot apply an old pending action.
- [ ] **Shared-state qualification:** two viewers, two gadgets and an external client converge;
  hidden observers receive nothing; disconnect, restart, duplicate submission, expired
  credentials and missed notifications are exercised. Browser/network inspection finds no
  service keys, origin Access secrets or administrator credentials.
- [ ] **Independent mapping fixture:** source-shaped Jira and Linear examples map onto the
  same work records with an explicit loss report. Either adapter can be removed without
  changing the core module or board.
- [ ] **Archives and rollout:** new IDs and hashes, independent install beside the old board,
  documented connection steps and rollback to the old experience without changing its data.

Build and run the new packages' model, transport, UI, server and archive tests, then run the
service security/integration tests affected by the connector. Include a real platform approval
lifecycle and a same-datastore board/report convergence test before advertising integration
as complete. Do not claim an actual vendor SDK compatibility level from shape fixtures alone.

## Rollout and preservation

Keep `format.project-board`, `format.project-report`, their existing `.gadget` archives,
legacy gatekeeper registration and datastore migrations unchanged. Add the new Work Board
and Work Report as separate catalogue entries labelled with their supported capabilities.
Do not silently reconnect an existing gadget or reinterpret its local sync storage.

Start with an empty pilot datastore. If users want existing data moved, inventory the old
schema and real data first; run a dry-run mapping/loss report, approve an import, reconcile
counts and identifiers, then switch selected gadgets. Avoid dual writers across old and new
authorities. A rollback after new writes needs data reconciliation; reinstalling an old archive
does not move those writes back. Retire the legacy path only after its remaining users and
missing capabilities have been explicitly addressed.
