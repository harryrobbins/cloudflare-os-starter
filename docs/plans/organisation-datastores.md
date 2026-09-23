# Organisation datastores: implementation plan

Written 2026-09-23 against starter `7d39f48` and pinned `cloudflare-os` `e50a9058`.
Status (2026-09-23): **implemented and tested locally through Phase 3; nothing provisioned or
deployed, Records disabled in `deployment.jsonc`.** Phase 0 decisions and their evidence are in §9 of
the [decisions record](../research/organisation-datastores-decisions.md#9-phase-0-decisions-and-evidence-2026-09-23).
Open gates are marked `[~]` (partly done) or `[ ]` below. Code: `packages/records-contracts`,
`packages/records-schema`, `packages/gatekeeper-records`, `packages/blueprint-project-{board,report}`,
and the fork branch `feat/viewer-assertions` (gitlink not yet updated).

This is the authoritative implementation plan for durable organisational business data. It
supersedes [external-records-service.md](external-records-service.md) and
[External API Plan A](../research/external-api-plan-A.md). The supporting
[research and decision record](../research/organisation-datastores-decisions.md) distinguishes
verified platform behaviour, design decisions and unresolved implementation gates.
The [gadget HTTP API](gadget-http-api.md) remains a separate proposal for gadget-specific automation;
it is not the enterprise records API.

## 1. Outcome and scope

An organisation owns durable datasets independently of the employee, connector connection,
blueprint or gadget that first created them. Multiple gadgets and external clients use one
authoritative service. Replacing a UI, removing a connector connection or deleting a gadget
does not delete its business records.

Build one Postgres-backed Records service with a Projects module, a permission-filtered datastore
registry, a Workshop management page, typed Gatekeeper access and a versioned HTTP API. Demonstrate
two blueprints sharing one dataset: a writable project board and a read-only project report.

Postgres owns records, memberships, registry metadata, audit history and pending outbox events.
Durable Objects own presence, delivery coordination and reconstructable caches. Keep existing
gadget-local storage where appropriate; do not automatically migrate existing Board instances.

V1 excludes arbitrary SQL/DDL from gadgets, bidirectional DO/Postgres synchronization, a generic
JSON document database, unrestricted PostgREST, direct BI write access, offline write merging,
cross-datastore transactions and a third-party module marketplace. Attachments, database-provider
provisioning automation and existing-gadget import are follow-ups, not hidden prerequisites.

## 2. Ownership and resource model

| Resource | Example | Lifecycle and authority |
| --- | --- | --- |
| Database environment | Organisation production Postgres | Operator-managed storage, region, credentials and recovery |
| Service module | `projects` | Reviewed migrations, domain methods and versioned API contract |
| Datastore instance | Engineering projects | Organisation-owned dataset with stable UUID, membership and retention |
| Connector account | Alice's Records connection | Authenticated route into organisation resources; does not own their data |
| Connector binding | Board → Engineering projects | Restricted capability for one gadget and approved operations |
| Blueprint | Project board | Reusable UI/code declaring a service requirement; contains no live grants |

Start with one managed Postgres database per organisation deployment and environment. Keep dev,
test and production isolated. Use `records` for registry/security metadata and `projects` for the
initial module's private tables. Multiple datastore instances share module tables, isolated by
immutable `org_id` and `datastore_id`. A datastore may contain multiple projects; v1 permissions
apply to the whole datastore. Separate confidential audiences into separate datastores initially.

Retain explicit organisation IDs even for a deployment with one organisation. Organisation
creation and identity-provider mapping are operator-managed, not inferred from an email suffix.
Use stable internal principal IDs and a verified external identity mapping; names and email
addresses are display attributes, not ownership keys.

Use a dedicated database/project when independent restore, residency, ownership, workload or
isolation requirements justify it. A schema is a namespace and privilege-management tool, not an
independent backup/failure boundary. Database placement is administrative metadata; applications
bind stable logical datastore IDs, never provider connection strings.

## 3. Architecture and package boundaries

Gadget calls reach the Records Gatekeeper through typed capabilities. External clients reach
`/gatekeeper/records/v1/*` through the Router and the Records Worker. Both adapters call the same
domain operations and authorization layer, which use a cache-disabled Hyperdrive connection.
Management UI calls a separate administrative RPC surface in the same service.

The initial service and Gatekeeper can share one Worker. Keep transport, authorization, domain
operations and persistence as separate modules so neither HTTP nor RPC can skip business rules.
There is no Neon Data API/JWKS signing dependency in v1. PostgREST is deferred until a concrete
consumer needs constrained views/functions and its authorization parity can be demonstrated.

| Proposed path | Responsibility |
| --- | --- |
| `packages/records-contracts/` | Runtime-validated RPC/HTTP DTOs, errors, permissions, manifest schemas, event types and fixtures |
| `packages/records-schema/` | Ordered SQL migrations, seeds, migration runner configuration, database/RLS tests |
| `packages/gatekeeper-records/src/domain/` | Shared registry, membership and Projects operations |
| `packages/gatekeeper-records/src/db/` | Transactions, trusted context, repositories, idempotency and audit writes |
| `packages/gatekeeper-records/src/vendor/` | Vendor/account/binding capabilities, observer checks and approval integration |
| `packages/gatekeeper-records/src/http/` | Access validation, service credentials, HTTP contract, limits and error mapping |
| `packages/gatekeeper-records/src/feed/` | Outbox publisher, Queue consumer, notification DO and hook registration |
| `packages/gatekeeper-records/app/` | Workshop-hosted Data management UI and binding configurator |
| `packages/blueprint-project-board/`, `packages/blueprint-project-report/` | Two new clients of the Projects contract |
| `scripts/deployment-config.ts`, `scripts/deploy.ts`, related tests | Optional Records deployment, bindings, build order and validation |

All these new paths are proposed, not existing interfaces. The contract phase decides exact names
before implementation fans out. Keep the necessary caller-identity changes in the pinned fork,
separate from wrapper-owned service code. Update the gitlink only after that patch is reviewed
and integrated by the designated integrator.

## 4. Publication, installation and developer workflow

| Event | Required behaviour |
| --- | --- |
| Publish blueprint | Store code and service requirements; no production DDL, credentials or provisioning |
| Publish module | Produce versioned service code, migration bundle and API compatibility metadata |
| Install/upgrade module | Deployment pipeline validates and applies migrations once per database environment |
| Create datastore | Authorized management operation creates registry, ownership, memberships and initial rows atomically |
| Instantiate blueprint | Resolve compatible existing datastore, or offer explicit creation to a principal with that permission |
| Bind connector | Grant only requested operations for the selected datastore; validate compatibility server-side |
| Upgrade blueprint | Preserve binding; refuse incompatible API or request any newly required permissions |
| Remove connection/gadget | Revoke corresponding capabilities; retain dataset and organisation ownership |
| Archive/delete datastore | Separate administrative workflow with dependency report, retention and explicit confirmation |

A blueprint declares a module ID, supported API major, required features and operation scopes.
The initial implementation may store this in wrapper-owned sidecar metadata, but cannot pretend
the existing blueprint format already enforces it. Phase 0 determines the manifest/binding
integration point. Exported blueprints omit credentials, membership grants, live resource IDs and
cached confidential records. Copying a gadget must require an explicit reuse-or-new-data choice.

A module manifest identifies its module version, exported API versions and ordered migration
checksums. API versions and physical migration versions are distinct: several migrations may
preserve one API major. A new incompatible API major coexists with the previous major until its
consumers migrate. A module must not alter another module's schema without a reviewed dependency.

Developer sequence:

1. Start local Postgres or a disposable provider database with synthetic seed data.
2. Develop the module contract, SQL migration and service method together; generate client types
   and HTTP documentation from the shared validated contract.
3. Run migration, negative authorization, transaction and contract tests against a real database.
4. CI builds an isolated database, applies migrations from empty and the previous supported
   release, then runs old/new client compatibility tests. Production data is not a CI fixture.
5. Publish immutable build artifacts and a reviewed migration bundle. Publication changes no
   organisation dataset.
6. Install through a single migration job with a lock and checksum ledger. Runtime Worker
   credentials cannot perform DDL. Deploy additive changes before dependent service code; remove
   old structures only after old consumers have been retired.

Use versioned SQL with one migration runner; dbmate is the initial candidate, to be pinned and
validated in Phase 0. Do not run competing migration tools or migrations at Worker startup.
Developer convenience commands should be added for database setup, migration, seeding and tests;
their exact names are implementation outputs, not currently runnable commands.

## 5. Registry and independent management UI

Add a full-page **Data** application using `AccountDescription.providesUi` and `startAppUi`.
It is independent of the project board/report and hosted inside Workshop. The service remains
headless for scripts and other clients. Reuse the existing connector resource configurator for
selection and creation; do not require a standalone deployment for each datastore's UI.

Registry records include stable ID, organisation, name, description, module, supported API
versions/features, environment, lifecycle state, owner team, access policy and retention policy.
Administrative views additionally show physical placement, migration state, export/restore status
and connected consumers. Consumer references need reconciliation when a gadget disappears; a
missing callback must not cause dataset deletion.

The page supports authorized list/search, creation, ownership/membership management, bindings and
integration inventory, credential mint/revoke, audit viewing, export jobs and archive workflows.
Start the generic record inspector read-only. Business edits use module operations.

Use one registry query layer for the UI, resource picker and agent discovery. `getAgentCatalog()`
exposes a bounded selection; a paginated `searchDatastores()` handles larger inventories. Discovery
is an authorized observation, and cannot expose inaccessible names, counts or descriptions.
Default to showing only accessible datastores. Organisation-visible requestable entries require
an explicit separate discovery policy. Discovery never grants record access.

Creation is available only to organisation data administrators in v1. Connector auto-provisioning,
if enabled, creates a connection identity only; it does not create a database, membership or
ambient read access. Bootstrap the first data administrator explicitly; deployment administration
does not silently confer routine access to every record.

## 6. Identity, authorization and approval

The intended effective permission is:

`principal rights ∩ binding/credential scopes ∩ permitted domain operation`

For RPC, the Gatekeeper derives the organisation/datastore from the server-owned binding. For
HTTP, a supplied datastore ID is only a selector: it must match the credential grant and current
membership. Payloads cannot set trusted actor, organisation or datastore ownership fields.

### Trusted caller gate

The current `gadgetViewer` supplies browser-side attribution only. A connected account identifies
the binding owner, not the person calling the shared gadget facet. Neither is sufficient for
per-viewer authorization or a trusted audit actor.

Before multi-user records writes, implement and test a platform-owned per-invocation capability
or equivalent authenticated context from Workshop session through the gadget call to the Records
adapter. Merely passing a user ID through gadget JavaScript is insufficient. The capability must
be bound to the initiating session, gadget, permitted resource/operations and lifetime; it must
not become a reusable credential retained by arbitrary gadget code. Prove the design under async
interleaving, nested calls, failures and replay. No global mutable "current user" is allowed.

Phase 0 compares an invocation-bound capability with a platform-mediated per-viewer session and
freezes one design. If neither can preserve authority through the current facet model, revise the
platform boundary before proceeding; do not fall back to the owner's identity. UI work against
fixtures can continue while this gate is unresolved, but integrated gadget access cannot ship.

Agents, schedules and external automation use explicitly delegated service principals with named
owners, limited scopes, expiry and revocation. Their actions record the service principal and,
where verified, the initiator/approver separately. They never impersonate the last human viewer.

### Roles and scope

| Role | Default authority |
| --- | --- |
| Organisation data administrator | Create datastores, assign ownership and manage module availability |
| Datastore owner | Manage lifecycle, ownership and grants within organisation policy |
| Datastore administrator | Manage members and configuration; cannot transfer ownership or purge |
| Editor | Read and perform permitted Projects business operations |
| Reader | Read records and permitted metadata |
| Service principal | Only explicitly granted operations on named datastores |

Freeze the exact role/operation matrix in the contract phase, including whether management roles
also receive record-read rights. Do not equate Workshop `build`/`use` roles with these roles. A user
with permission to edit gadget code can exercise its approved capabilities; critical workflow
rules must therefore remain in the service.

V1 operation scopes include `projects.read`, `issues.read`, `issues.create`, `issues.edit`,
`issues.transition`, and `comments.create`. Lifecycle, export, credential administration and grant
changes use separate management permissions. No catch-all `records.write` pre-approval.

### Approvals and revocation

Every Gatekeeper read is an authorized observation. Every write follows the platform's action
queue, including human-triggered UI writes; eligible operation kinds can be pre-approved for a
binding. Return explicit `pending`, `applied`, `rejected` or `conflict` status. Do not show a save as
committed while approval is pending. Recheck current principal rights, binding state and expected
record version when the action actually executes. Approval cannot increase the submitter's rights.

External API writes use their explicit service-principal authorization and the same domain checks,
not a fictional gadget approval queue. Both paths produce the same durable business audit events.

Membership and credential checks use fresh authoritative state. A revocation committed before an
operation's authorization check denies that operation; already authorized in-flight transactions
may complete. Define this ordering in tests, and serialize revocation with mutations if stricter
semantics are required. Queued actions are always checked again. Deny new subscription delivery
after revocation is observed and close/revalidate sessions; choose and test a maximum disconnect
delay before release. Revocation cannot erase data a user already received.

### Shared gadgets and observers

Start with one uniform read audience per bound datastore/gadget. Implement `addObserver()` using
trusted verifiers and current membership; a share link alone never grants datastore access.
Account for historical observations, transcripts, cached data and blueprint exports, not only new
SQL reads. If the platform cannot prevent unauthorized access to already-materialized gadget state,
that sharing mode must be unavailable for Records-backed gadgets.

Do not introduce per-user private rows into a shared gadget cache in v1. Future project/row/field
permissions require separately isolated output/cache paths and an observer-history design.
Notifications are authorization-filtered identifiers/revisions, never full confidential records.

## 7. Database and domain contract

The registry/security schema holds organisations, principals, identity mappings, memberships,
datastores, module installations, bindings/service grants and credential digests. The Projects
schema holds projects, issues, comments, workflow definitions and custom-field definitions/values.

Tenant-owned tables have immutable `org_id`, `datastore_id` where applicable, stable IDs, record
revisions, timestamps and trusted attribution. Foreign keys and uniqueness constraints include
the relevant tenant/datastore key so records cannot reference another dataset. Module-global
tables must be explicitly classified rather than accidentally exempted from isolation tests.

Use typed columns for stable domain fields and validated JSONB extensions for custom fields. Field
definition changes must account for existing values. A custom field becomes a typed column only
through a migration. Avoid a universal `collections + JSONB` model in the first release.

Database rules:

- Separate migration owner, application and outbox-publisher privileges. No application role owns
  tables, has `BYPASSRLS`, performs DDL, or can assign itself another application's authority.
- Enable default-deny RLS on tenant tables, with read and write policies; test all actual runtime
  roles. Explicitly validate any `FORCE ROW LEVEL SECURITY`, view-owner, function-owner and default
  privilege choices. Private schema means not publicly exposed, not magically protected from SQL.
- Set trusted context transaction-locally on one pinned connection; parameterize values and
  allow-list identifiers. Test cleanup after rollback and reuse through Hyperdrive. RLS context
  protects against missed predicates, not compromise of the trusted service or SQL injection.
- Use conditional revision updates and transactions for issue changes, audit and outbox insertion.
  All application writers use this service path; maintenance writes need an explicit audited path.
- Keep audit and outbox separate: different access controls, payloads and retention. Audit is
  append-only to application roles; privileged database operators remain part of the trust model.

Expose typed domain methods such as `listProjects`, `listIssues`, `createIssue`, `editIssue`,
`transitionIssue` and `addComment`. Bound filters, ordering, page size, query time and response bytes.
No client-defined SQL, joins or arbitrary table names. Management APIs are not on the gadget session.

All mutating commands carry an idempotency key; changes to existing records also carry an expected
revision. Scope keys by principal, datastore and operation and store a request digest plus outcome
atomically with the mutation. Same key/different request is a conflict. Document the retention
window; replay of a saved outcome still requires current access. A timeout does not prove failure.

HTTP uses versioned routes, validated DTOs, stable problem/error codes, bounded bodies and responses,
pagination, rate limits and deadlines. Map HTTP `If-Match` to expected revision and distinguish
precondition failures from workflow conflicts. Use a path-specific Access application/audience for
machine API traffic plus an expiring Records credential; validate both. Store only credential
digests, show secrets once, and never place them in gadget code, logs or agent context. Browser
management uses its authenticated Workshop capability, not a shared machine token.

## 8. Reliable change delivery

Use a transactional outbox and a publisher owned by the Records service. Poll indexed pending
events using a bounded scheduled invocation or alarm-driven publisher; settle the wake-up and cost
policy during the infrastructure spike. Publication must continue even when no gadget is open.

Claim pending rows with a lease and retry time, commit the claim, publish to a bound Cloudflare
Queue, and mark publication only after acknowledgement. Expired leases are retried. A crash after
enqueue and before marking creates a duplicate; consumers must tolerate it. Do not hold a SQL
transaction across the external enqueue. No additional public ingress Worker is required when
the publisher already runs inside this Worker with a Queue binding.

Do not poll solely with `WHERE seq > last_seen`: sequence allocation is not commit order and a
late-committing transaction can be skipped. Use pending delivery state, stable event IDs and
per-entity revisions. Keep published rows long enough for the agreed replay/recovery window.

The Queue consumer routes invalidations to datastore-scoped notification DOs. Delivery is
at-least-once, may be out of order, and is not a business-record replica. Clients refetch current
state and ignore obsolete revisions. Hook registration is idempotent by binding/registration key;
persist the initiator, restore callbacks per delivery and dispose RPC stubs. Reconcile abandoned
registrations and revoked bindings. If hook persistence is not viable, polling authoritative
reads is a documented temporary fallback, with an explicit freshness target.

On initial load and reconnect, subscribe before taking a snapshot, buffer invalidations during
the read, and refetch affected data; if retention/delivery continuity is uncertain, do a full
authorized refresh. Do not offer a resumable client cursor until its ordering and retention
semantics are implemented. Test subscriber restart, out-of-order delivery, duplicate delivery,
snapshot races and missed notification recovery. Failure of notification delivery must never
undo or corrupt a committed business transaction.

## 9. Phases and release gates

Each phase produces reviewable evidence, not just code. `[x]` done with tests, `[~]` partly done (the note says what is missing), `[ ]` not started.

### Phase 0 — resolve feasibility and freeze contracts

- [~] *Local spike done on embedded Postgres 17.9; no provider selected or contacted.* Record provider candidates and select an isolated spike environment; Neon is the recommended
      first evaluation target, not a production commitment. Follow the companion research's Neon
      setup (direct origin behind Hyperdrive, standard Postgres driver, no Data API dependency).
      Choose provider/version/region, availability, recovery targets,
      budget and ownership before production provisioning.
- [~] *Proven on direct connections and through Miniflare's local Hyperdrive; not through real Hyperdrive, and not measured.* Prove transaction-local authorization and rollback cleanup through cache-disabled Hyperdrive;
      measure read/write latency and connection behaviour under representative concurrency.
- [~] *Viewer assertions built (fork `a687cbdf`) and proven in kernel unit tests and the workerd suite; still needs a two-browser run through the real Workshop.* Prove trusted invocation identity with two interleaving users and malicious/replayed arguments.
      Trace observer sharing and historical-state access. This is a release-blocking platform gate.
- [x] Freeze validated contracts: manifests, role/scope matrix, caller capability, domain operations,
      approval outcomes, registry discovery, event envelope and error/idempotency semantics.
- [~] *Runner, test provider, hook persistence and wake-up chosen; cost not measured.* Choose migration runner and test provider. Resolve hook registration/recovery and publisher
      wake-up mechanism with minimal spikes; measure idle/active cost rather than assuming 1.5 s polls.
- [x] Record decisions and evidence in the companion research document. No production data is used.

Exit: contract fixtures checked in, unresolved identity/security issues explicitly closed or a
revised architecture agreed. Parallel implementation starts only against this frozen boundary.

### Phase 1 — persistence and trusted service foundation

- [x] Create schema/migration packages, registry, memberships, Projects tables, role grants/RLS,
      audit, idempotency and pending outbox structures.
- [x] Implement database transactions and shared domain operations, including creation and lifecycle.
- [~] *Implemented on the fork branch; awaiting review and gitlink integration.* Implement the reviewed platform caller capability and server-owned binding resolution.
- [x] Run two-organisation/two-datastore negative tests, cross-datastore FK tests and concurrent
      revision/idempotency tests against real Postgres and local workerd where applicable.

Exit: unauthorized reads/writes fail, actors cannot be forged, domain mutations and their audit/
outbox records commit atomically. No UI or HTTP adapter gets a bypass path.

### Phase 2 — transport, management and discovery

- [x] Implement Gatekeeper vendor/account/resource lifecycle, observers, approval submission and
      apply-time reauthorization with explicit pending outcomes.
- [x] Implement HTTP adapter, path-specific Access checks, scoped service credentials and limits.
- [x] Build Data management UI, compatible datastore picker, agent catalog and paginated search.
- [~] *Requirements ship as `service-requirement.json` in each archive and are validated in tests; the platform does not enforce them at install.* Implement validated blueprint/module metadata and compatibility checks; prevent copied/exported
      artifacts from carrying live credentials or unapproved dataset grants.
- [x] Prove HTTP/RPC authorization and domain-result parity. Test metadata non-disclosure, revoked
      credentials, changed permissions while approval is pending and connector-owner offboarding.

Exit: an administrator creates a dataset, two users receive different operation grants, and an
external service principal can use only its permitted API. Data survives connection removal.

### Phase 3 — delivery, two clients and deployment integration

- [~] *Publisher, consumer, feed DO and hooks built; publisher/consumer tested, hook delivery not exercised against the real Workshop.* Implement leased outbox publication, Queue retry/dead-letter handling, notification DOs,
      idempotent hooks and reconnect refresh.
- [x] Build project board and read-only report against the same service; show pending approvals,
      conflicts and unavailable states clearly. Do not silently persist offline business writes.
- [x] Add disabled-by-default Records configuration, Hyperdrive/Queue bindings, required secrets,
      builds and generated config tests. Router stays the sole public entrypoint.
- [~] *Deploy order is Records before Workshop and Router; the gitlink and bundled format archives are not integrated.* Migrate before deploying dependent service code, then Workshop and Router; keep overlapping
      versions compatible. Integrate the reviewed fork gitlink and bundled artifacts serially.
- [ ] *Needs an isolated deployed environment.* Demonstrate a write through the board and API appearing in both clients, gadget replacement
      with data intact, revocation, late transaction commits and publisher/consumer restarts.

Exit: the complete flow works in an isolated environment, including the failure paths. Deployment
integration does not automatically authorize or trigger a production deploy.

### Phase 4 — operational readiness and controlled rollout

- [ ] Choose explicit RPO, RTO, backup/PITR retention, audit/outbox retention, freshness target,
      revocation delay, capacity limits and budget; attach measured evidence to the release record.
- [ ] Restore a backup into an isolated environment, recover records and registry permissions,
      reconcile/revoke restored credentials, rebuild subscriptions and safely replay pending events.
- [ ] Exercise export/import, archive and eventual purge; explain when deleted data ages out of
      backups and audit retention. Dataset restore must not roll back unrelated datasets.
- [ ] Exercise database outage, pool exhaustion, credential rotation, queue backlog/dead letters,
      failed migrations and partial Worker deployments. Document retry and roll-forward procedures.
- [ ] Add metrics for API latency/error rate, pool pressure, pending approvals, outbox age, delivery
      retries, denied authorization and restore age; keep record bodies and credentials out of logs.
- [ ] Run scoped suites and the repository's required checks; perform the operator workflow before
      approved production provisioning/deployment and verify access with allowed and denied users.

Exit: ownership, on-call runbooks, restore evidence and access tests are recorded. Only then enable
the module for a pilot organisation/team. Do not claim production readiness from local tests alone.

## 10. Safe parallel-agent execution

Use one coordinator/integrator to own the contract, migration numbering, root configuration,
dependency manifests/lockfile, generated blueprint artifacts and submodule gitlink. Other agents
propose changes to those files through the coordinator. No two agents run root `pnpm check` or
deployment generation in the same checkout concurrently. Use isolated worktrees and disposable
databases for tests; a worktree alone does not isolate remote resources.

| Workstream | Exclusive implementation ownership | Starts after | Safe parallel work |
| --- | --- | --- | --- |
| A: contracts/integration | `records-contracts`, root configuration, lockfile, gitlink, release docs | Initial design | Coordinate Phase 0 spikes; serialize shared-file changes |
| B: schema/security | `records-schema` and its database tests | Frozen schema/authorization contract | C and fixture-based UI/client work; only B numbers/applies shared migrations |
| C: platform identity | Fork `workshop-shared`, backend caller/observer code and identity tests | Frozen caller design | B; no other agent edits these kernel files |
| D: domain/persistence | Records `src/domain`, `src/db` and their tests | B interface/fixtures frozen | UI/client work using contracts; integration waits for B and C |
| E: Gatekeeper adapter | Records `src/vendor` and adapter tests | C and D interfaces frozen | F, G and H; no kernel or shared DTO edits |
| F: HTTP adapter | Records `src/http` and adapter tests | D interface frozen | E, G and H |
| G: management UI | Records `app` and configurator files | Registry/admin contract frozen | B–F using explicit fixtures; real authorization tests follow integration |
| H: feed | Records `src/feed` and delivery tests | B outbox and E hook contracts frozen | E/F/G; migration requests go through B |
| I: blueprint clients | New board/report source and client tests | Projects/manifest contracts frozen | Service adapters/UI using fixtures; A alone integrates generated archives |

This table describes independent work, not a requirement to run nine agents. With four slots,
use these waves, retaining A as coordinator:

1. **Feasibility:** A freezes contracts while B investigates SQL/Hyperdrive, C investigates identity/
   sharing, and H investigates event delivery. Findings must merge before dependent contracts freeze.
2. **Foundation:** B implements persistence, C implements the trusted platform path, and G builds
   management UI against fixtures. A maintains integration and reviews security boundaries.
3. **Service:** D implements domain operations while G completes UI and I builds the two clients
   against the frozen contract. Integrate foundation changes before real service tests.
4. **Adapters:** E, F and H implement their separate adapters after the domain boundary is available.
5. **Integration:** A integrates branches and deployment changes serially. Other agents can run
   security, recovery and client reviews in isolated environments; defects return to file owners.

Safe parallel work requires committed contract versions, exclusive file ownership and recorded
fixture assumptions. A changed contract pauses affected consumers until A updates the contract
and owners acknowledge it. Shared database migration execution, production resource changes,
gitlink updates and final release checks are serialized. Never resolve an overlap by overwriting
another agent's or the user's working changes.

## 11. Acceptance scenarios and deferred decisions

The release must demonstrate all of the following:

1. Publish the same blueprint twice: no database/schema/dataset is created by publication.
2. Install the module once, create two datasets and bind two different blueprints to one dataset.
3. Reader cannot write through UI, modified gadget code, direct RPC or HTTP; editor cannot escape
   binding scope. Unknown actor, wrong organisation and forged caller contexts fail closed.
4. Sharing a gadget does not disclose current or historical records to a non-member. Revocation
   prevents new authorized operations/delivery within the documented semantics.
5. Duplicate mutations and approval retries apply once; stale revisions cause a visible conflict.
6. A late-committing outbox row is eventually published; crashes and duplicate delivery converge.
7. Removing a creator's account, gadget or connector preserves organisation records and another
   authorized administrator can continue managing them. Reconnecting requires new valid grants.
8. Previous and new supported clients survive an additive migration; failed deployment can roll
   forward or return to compatible code without pretending a Worker rollback reverses SQL.
9. Restore and export reproduce data plus applicable ownership/permissions without reviving
   revoked access or overwriting unrelated datasets.

Provider/region and operational targets remain release decisions, not guessed constants. The
specific caller-capability mechanism, migration runner and poll wake-up mechanism are Phase 0
decisions. Project-level ACLs, direct reporting SQL/PostgREST, attachments, existing Board import
and independently isolated databases are later extensions with their own security/recovery review.
