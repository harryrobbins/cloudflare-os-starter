# Records Explorer blueprint

2026-09-25 · **Proposed delivery plan, not implemented.** No new blueprint, connector, API or
administrative authority is introduced by this document. This extends the locked
[Records direction](records-direction.md) and depends on the shared connector work in
[blueprint adaptation](records-blueprint-adaptation.md). The deployed Records service and product
website are working alpha software; that does not make this explorer available in cloudflare-os.

## Recommendation

Build a dedicated `Records Explorer` blueprint with the familiar navigation of Adminer or
phpMyAdmin: choose a datastore, browse its entities, inspect a record and its model, follow declared
relationships and understand recent changes. Its authority is the Records application API, not a
database-owner login. It should help someone understand and use any published application profile,
without making work tracking or messaging special cases in the core explorer.

Start read-only. Add explicit approved commands only after the generic cloudflare-os connector is
qualified. Keep datastore provisioning, grants, module publication, DDL, raw SQL and production
repair in separate operator tooling. A browser for application data is useful without becoming a
Postgres administration console. Work, messaging and a custom inventory module must all work through
the same record/model interface. Adapters for Jira/Linear, Slack/Matrix or Notion/Confluence remain
separate consumers of those models.

The primary user is an authorised app builder or operator asking: “What can this datastore represent,
what does it currently contain, what does this field mean, and which actions am I allowed to request?”
A Schema.org catalogue entry answers a meaning question; it does not imply a stored entity or an
installed workflow. Make that distinction visible in navigation and empty states.

## What is available to build on

This audit is of the new service, not the older Projects gatekeeper.

| Capability | Existing implementation | Explorer implication |
| --- | --- | --- |
| Known datastore description | `GET /v1/datastores/{id}/describe`; installed module/API major and binding scopes | A connected, known datastore can be described. There is no viewer-scoped endpoint listing all available datastores. |
| Collection reads | `/v1/datastores/{id}/modules/{module}/v{major}/records` | Supports `entity`, `id`, UUID `after`, and `limit` 1–500. No arbitrary sorting, SQL, joins, text search, totals or field predicates. |
| Snapshot | Same module prefix plus `/snapshot`; default 1,000 rows, maximum 5,000 | Complete bounded snapshot with sequence and permission epoch. Oversize returns 413; no snapshot pagination/export job exists. |
| Sync changes | `/v1/datastores/{id}/changes?after=…&epoch=…&limit=…`; maximum 500 | A forward journal for reconciliation. Not a record-history search service or an audit UI contract. |
| Live hints | `/v1/datastores/{id}/events` | Authenticated SSE with finite lifetime and revocation checks. Polling/catch-up remains necessary. |
| Model metadata | `/v1/models/{module}/v{major}/profile` and `/schema/{entity}` | Public model definitions can drive field descriptions and validation hints. They are not authority to read records. |
| Vocabulary | `/v1/vocabulary/schemaorg/terms/{term}` | Lookup of a known term in the complete pinned catalogue. No server catalogue search/list API exists yet. |
| JSON-LD | Collection reads with `format=jsonld` | Permission-filtered expanded representation is available. The current client/session does not expose this option. |
| Commands | Module prefix plus `/rpc/{command}`, with idempotency and revision headers | Registered SQL commands work, but generic entity JSON Schema is not a complete command-input/form schema. |
| API discovery | Public `/v1/openapi.json`; authenticated datastore `/openapi` | Datastore document includes installed metadata. Request bodies currently use generic objects, so automatic writable forms need a stronger contract. |
| OS integration seam | `RecordsOsBridge.session()` exposes `describe`, `records`, `snapshot`, `changes`, `command`, `getOutcome` | Reusable bridge logic exists; deployed generic host enrollment, durable pending-action storage and gadget wiring still need the adaptation plan. |

Evidence: [`gateway.ts`](../../../packages/records-service/src/gateway.ts),
[`openapi.ts`](../../../packages/records-service/src/openapi.ts),
[`client.ts`](../../../packages/records-service/src/client.ts),
[`cloudflare-os.ts`](../../../packages/records-service/src/cloudflare-os.ts),
[`connector.ts`](../../../packages/records-service/src/connector.ts), and
[`004-snapshot-and-rpc-validation.sql`](../../../packages/records-service/sql/004-snapshot-and-rpc-validation.sql).

A datastore currently pins one module and API major. An explorer may switch among explicitly
connected datastores, but must not suggest arbitrary cross-datastore joins or multiple independently
installed modules within one datastore. Work's executable entity is `work_item`; messaging's is
`message`. Richer project/channel profiles in the model package are examples, not tables hidden
behind a missing navigation item.

## User experience and boundaries

### Connect and understand

The first screen uses the generic Gatekeeper configurator from the adaptation plan. Initially it
accepts a host-approved datastore connection, then displays its name/identifier, module, API major,
model version, effective scopes and connection state. Do not accept an arbitrary backend URL or
ask a gadget user to paste service credentials. Saved configuration references an approved binding;
the trusted host owns endpoints, credential exchange and enrolled identity.

A genuine datastore chooser is a separate prerequisite for discovery, not an unauthenticated scan
of UUIDs or reuse of a privileged provisioning credential. Design a viewer-scoped registry contract
that returns only currently discoverable datastores and grantable capabilities, with pagination,
revocation and observer tests. Its path and identity transport should be settled by the connector
work. Before it exists, clearly offer “connect a datastore” rather than an apparently complete list
of the organisation's data. Do not infer record access from a visible public model name.

Navigation has **Records**, **Model**, **Activity**, and **Connection** areas. Under Records, list
entities actually declared by the installed profile. Vocabulary browsing is a separate Model view.
Do not create one “table” item for each of the 3,026 Schema.org terms.

### Browse records

Render a compact grid with record ID, entity, revision and selected profile fields. A detail panel
shows all returned fields, definitions, types, cardinality and a raw JSON representation. Preserve
unknown returned extension data in the inspector, even when no friendly field renderer exists.
Treat data, descriptions and labels as untrusted text; never execute HTML, scripts or imported
contexts. Provide keyboard navigation, visible focus, accessible table headings and a stacked
record-detail layout at narrow widths.

Pagination uses server UUID order. Store the next `after` value only from the final received record,
scoped to the binding/entity/query, and reset it when that scope changes. A page whose size equals
the requested bound is not proof that another page exists; a subsequent empty page ends traversal.
Do not label client-side sorting or filtering as applying to the full datastore. Initial tools are
entity selection, exact record ID lookup, column visibility and an explicitly labelled filter over
loaded rows. A server search/order contract with indexes and query budgets is later work.

A normal page is a current read, not a consistent multi-page export or a complete sync bootstrap.
For live views, use a successful bounded snapshot and then journal changes from its watermark.
If the datastore exceeds the snapshot bound, keep an explicitly refreshable page mode until a
stable server pagination/snapshot design is delivered. Never concatenate ordinary pages and claim
a transactionally consistent snapshot.

### Inspect models and relationships

Show the installed profile's stable term IDs, model version, required fields, constraints and any
published reference annotations. Link Schema.org terms to their pinned catalogue definitions,
including multiple inheritance and pending/retired/superseded status. Custom namespaces are first
class and need no Schema.org dependency. Keep storage SQL, handler signatures and deployment
secrets out of the gadget metadata response.

The session needs bounded model/schema/term lookup methods: either an allowlisted public metadata
proxy or model metadata included in the authorised description. Do not give the iframe unrestricted
network access merely because definitions are public. Catalogue search can start with a bounded
term lookup box; a searchable full-catalogue index needs an explicit distribution/version/cache
choice rather than thousands of speculative requests.

Only offer a relationship link when a profile declares the relationship and a reviewed mapping can
resolve the identifier to an entity/record within a permitted binding. Render arbitrary IRIs as
identifiers, not guessed foreign keys. Never dereference remote IRIs or remote JSON-LD contexts.
Current work/messaging profiles do not provide a relational graph of projects, people and channels;
those screens need separately published profiles and real reference constraints. Missing and denied
relationship targets must not reveal existence through different error details. Cross-datastore
navigation requires another explicitly authorised binding and is deferred from the first release.

### Activity and history

The alpha journal returns sequence, ordinal, entity, record ID, revision and the post-command data.
The public pull does not currently include actor, command name, timestamp or an authoritative
before-image. A diff between two loaded post-images is a convenience, not proof of a complete audit
trail. Missing earlier entries must be labelled “not loaded,” never fabricated as empty state.

The first Activity view should be a bounded recent feed from changes already observed in this
session. Offer no “all history” or “as of” guarantee. Per-record history, backwards pagination,
filters, actor disclosure and time ranges require a separate reviewed history API and indexes.
If introduced, history access and redaction must be designed together. Hiding an old value in the
current record does not remove it from the journal, idempotency receipts, backups or downloaded
exports. Existing datastore read scope currently permits its change feed; a UI-only history toggle
would not impose an additional security boundary. Avoid implying a separate history permission
until the server enforces one. Undo and historical restore are not generic operations today.

### Export and JSON-LD

Offer explicit exports of a selected record or the loaded page, labelled with the count and scope.
The session must add an authorised JSON-LD read/transform path preserving the API's datastore-bound
record identity and permission epoch. Do not construct external IDs from display labels. Exported
files should identify module/API/model version and whether they are partial current reads or a
complete bounded snapshot. Streaming a huge download through shared gadget state is not acceptable.

A complete export is available only when the snapshot succeeds within its bound; otherwise explain
the limit and leave the operation unavailable. Whole-datastore export jobs, large imports, retention
and administrator export are separate service work. JSON first avoids ambiguous CSV structures;
any later CSV exporter must address formula injection, nested values, explicit selected columns
and permission-safe downloads. Downloads contain real data and remain outside server revocation
once saved; describe that fact when offering an export, without pretending client caches can recall
previous files.

### Approved editing, after read qualification

Expose actions supported by reviewed module command descriptors. Work can offer create/update and
messaging send/edit; inventory's example supports register only. No generic delete, truncate, restore,
SQL console, table designer or editable arbitrary record JSON is inferred from read access.

Add a versioned command UI contract describing command name, input schema, required scope,
preconditions and record-to-input mapping. Command descriptors must come from installed, trusted
module metadata. Entity schema alone cannot express command intent or prove that a field is writable.
Unknown modules retain their complete read inspector; editing stays unavailable until descriptors
exist. Do not fall back to arbitrary SQL, privileged RPC forwarding or a shared automation key.

Editing produces an explicit preview of the exact intended command, including target record and
revision. The blueprint requests a viewer assertion over the complete intent, then calls the session
command path. Only the trusted host receives `applyAction`/`rejectAction` capabilities. Persist the
pending intent and its original idempotency key before approval; retries retain identical body and
precondition. The UI shows pending, applied or rejected from `getOutcome`; it never treats submission
as a committed edit. On 412, refresh and ask for a new reviewed intent rather than silently replacing
the revision. Cancellation must distinguish “approval withdrawn” from “request timed out after a
possible commit.” Current rights are checked again at application time.

## Shared integration prerequisites

Reuse the generic Records Gatekeeper/session work in [blueprint adaptation](records-blueprint-adaptation.md).
Do not build a second credential broker inside the explorer or reuse the old Projects-specific
`listProjects`/`listIssues` proxy as though it were generic. `bindViewer` is a read seam, while
`RecordsOsBridge` provides a tested queue-adapter contract; neither supplies the missing deployed
host storage/enrollment/configurator automatically.

The connector must supply authenticated, bounded metadata/read/change methods and exact-intent
commands, server-owned secrets, durable approval state and enrolled viewer resolution. Bind-time
requirements are concrete `{moduleId, apiMajor, scopes, features?}` values selected and verified by
the configurator. A generic explorer does not require a wildcard “all modules/all scopes” grant.
The blueprint definition declares support for this connector family, while each instance binds a
specific described module/API major. Freeze that requirement for a binding; reconnect explicitly
when selecting another datastore/version.

Use the host's observer authorization path for every observation, including schema-associated data,
activity, relationship results, downloads and command outcomes. An allowed requesting viewer is
not evidence that every shared gadget observer may see the response. Cache keys include endpoint,
organisation, datastore, binding, principal/observer audience, module/API major and permission epoch.
Keep private record payloads and credentials out of shared Yjs document state, gadget metadata,
logs, diagnostics and saved layout. Persist only safe view preferences when their audience permits.
Purge private caches and close stale sessions on revocation, epoch change, disconnect or a different
binding. Initial development must prove this through real host observer tests, not just a mocked
service client.

## Proposed repository layout

These are planned paths, not files created by this document:

```text
packages/blueprint-records-explorer/
  package.json
  format.json                       # format.records-explorer
  gadget.lock.json
  README.md
  scripts/build.mjs
  scripts/pack-gadget.mjs
  src/service-requirement.json       # generic connector family; configured concrete binding
  src/shared/records.ts             # local typed session contract, no credentials
  src/server/index.ts               # blueprint server entrypoint
  src/server/proxy.ts               # narrow observation/command session forwarding
  src/client/index.html
  src/client/app.ts
  src/client/explorer.css
  src/client/grid.ts
  src/client/model-inspector.ts
  src/client/activity.ts
  src/client/command-form.ts        # stage 3 only
  test/explorer.test.ts
  test/permissions.test.ts
  test/commands.test.ts             # stage 3 only
```

Use the repository blueprint build/pack conventions exemplified by
[`blueprint-project-report`](../../../packages/blueprint-project-report/README.md), while replacing its
Projects-shaped requirements and proxy. Reuse its packaging approach, not its data contract.
Do not fork cloudflare-os or independently edit the pinned submodule to hide connector gaps.
Any shared session/client extensions belong in the connector work and the existing
`packages/records-service/src/client.ts`, `cloudflare-os.ts`, `openapi.ts` and relevant service tests.
Server history/search/discovery contracts require new migrations and reviewed API changes, never
edits to applied migration checksums. The explorer must not install SQL modules itself.

## Delivery checklist and acceptance gates

All stages below are **unchecked planned work**.

### E0 — settle contracts and shared host dependency

- [ ] Complete the generic connector prerequisite and record its tested host/session contract.
- [ ] Specify authorised datastore discovery, or explicitly ship known-binding-only setup.
- [ ] Add bounded model/schema/term and JSON-LD session methods with capability tests.
- [ ] Document current journal/history disclosure and snapshot limits in UI contracts.
- [ ] Choose fixtures for executable work, messaging and a freshly published custom inventory module.

Exit: one host-approved binding can return metadata and records with no credential exposed to an
iframe or agent, and denied observers cannot receive those observations.

### E1 — read-only explorer

- [ ] Build/package the dedicated blueprint, explicit connection state and installed-entity navigation.
- [ ] Implement bounded grid/detail/raw JSON, model inspector and declared-reference behaviour.
- [ ] Implement permission-safe refresh, complete bounded snapshot bootstrap and journal catch-up.
- [ ] Add a bounded session Activity feed; label unprovided historical metadata correctly.
- [ ] Add selected/page JSON and JSON-LD export with explicit partial/full-snapshot labels.

Exit: the same blueprint inspects work, messages and inventory without source changes. Tests cover
empty datastores, unknown extension fields, absent references, 500-row page boundaries, an oversize
snapshot, concurrent changes and a revoked observer. Keyboard and narrow-screen flows are usable.
No action can write, provision, publish SQL or reach a raw database connection in this stage.

### E2 — qualification in real cloudflare-os

- [ ] Run two viewers with different permissions against one shared gadget.
- [ ] Open a second gadget plus an external client and prove eventual convergence after missed hints.
- [ ] Restart the host/session, revoke a membership/binding and verify cache purge/reset behaviour.
- [ ] Exercise unsupported query parameters, malformed model metadata, untrusted strings and IRIs.
- [ ] Confirm bounded memory, response size and request counts for all screens and exports.

Exit: real OS observation authorization, enrolled identities and current service boundaries hold.
A fixture-only bridge test does not complete this gate. Record screenshots, measured limits and
access-test evidence without logging credentials or private record data.

### E3 — module-declared approved commands

- [ ] Publish versioned input/form descriptors and scope/precondition metadata for initial commands.
- [ ] Build command previews, exact-intent viewer assertions and host approval submission.
- [ ] Implement pending outcome recovery, stale-edit conflict handling and idempotent retry UX.
- [ ] Test denied/expired assertions, changed payloads after approval, forged principal/binding,
  revoked authority before application, duplicate approvals and response loss after commit.

Exit: an observer with read authority cannot write; an approved command executes as its actual
viewer; retries mutate once; no gadget endpoint can call trusted apply/reject callbacks. Publish a
new blueprint revision only after these tests pass. Keep `implementsRevert` false until a module
provides a tested compensating command and its approval semantics.

### E4 — separately scoped enhancements

- [ ] Design indexed server search/sort and richer query budgets if users need them.
- [ ] Design record-history pagination and permissions together with redaction/retention.
- [ ] Design stable large snapshots/exports and explicit import workflows.
- [ ] Evaluate relationship graphs and cross-datastore navigation with independent binding grants.

These are not prerequisites for the read-only release and must not be implied by its navigation.
Schema editing/publication, identity administration and database-owner repair remain operator tools.

## Rollout and rollback

Develop against disposable fixtures, then install the read-only blueprint in a test cloudflare-os
instance using the new generic connector. Opt in one internal datastore per module before wider
use. Do not repoint existing project boards or reports as part of this explorer rollout; their
adaptation has its own compatibility checks. Release the read-only and editing revisions separately.

Disabling/removing the blueprint revokes its binding and clears caches; it does not delete shared
data. Reverting an explorer version does not undo committed commands. Keep module/API compatibility
pins and migration history intact. Any service changes made for discovery, history or exports need
the service's existing release/rollback procedure and review; this planning document authorises no
implementation, remote deployment or production data mutation.
