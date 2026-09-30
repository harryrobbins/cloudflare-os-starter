# Records: a standards-based datastore

2026-09-25 · **Accepted direction and implementation plan.** This replaces all earlier Records
architecture recommendations in these plan and research folders, including `app-datastore-service.md`.
Historical implementation and deployment records remain evidence, not instructions for the new service.

**Direction locked; implementation now authorised (2026-09-25).** The owner approved the new
positioning and requested delegated implementation against a checked delivery plan. The earlier
website-only limit is superseded. Follow [records-delivery.md](records-delivery.md) for checked
implementation evidence and outstanding gates. The alpha is deployed on the homeserver at
https://records.surprisingly.ltd; [current status](records-status.md) separates delivered capabilities
from target contracts below. No legacy production cutover is implied.

**Proposed amendment (2026-09-26).** [Records as an immutable fact store](records-immutable-facts.md)
proposes replacing the storage, write, sync and history model (the journal, revisions, idempotency
table and snapshot limits) with immutable, content-addressed facts and derived projections. The
product direction in this document is unchanged. Until the owner accepts it, the contract below remains in force.

## Decision

Build a standards-based, module-driven app datastore using **ordinary Postgres + self-hosted PostgREST**, with
explicit SQL command functions and a small TypeScript gateway. Keep the existing identity and
cloudflare-os integration concepts. Use a dedicated notification relay and a durable change journal.
Neon is an optional Postgres provider. Hyperdrive is an optional, not yet qualified path for trusted Workers making SQL calls;
it is not needed for HTTP calls to PostgREST.

Validate this direction with a bounded technical trial before replacing the existing runtime. The
trial is the first implementation milestone; its completed checks and open gates are in the delivery ledger. Choose architecture
now; the owner has since selected the homeserver for the isolated alpha. Do not start a wholesale
rewrite or build a generic API framework around the existing Projects routes.

**Product centre:** ship the complete pinned Schema.org vocabulary as an available model catalogue,
with carefully modelled application profiles, and let developers extend it or start from a blank
model. Keep semantic models independent of physical database schemas and third-party SDKs. This
incorporates the owner's subsequent clarification; the standards layer is a core deliverable, not
an optional marketing label. Its local implementation and remaining qualification gates are recorded in the delivery ledger.

Positioning: **“Your data has a meaning before it has an app.”** The open model is the default
reference point; vendor applications and SDKs are optional interpretations. The aim is durable shared
meaning, not to claim a complete or uniquely true ontology of the universe. Preserve provenance,
explicit definitions and versions so models can be challenged and improved. “Open” describes the
model and interoperability, not public access to private records. Security comes from enforced and
tested boundaries, not from a philosophical or mathematical analogy. Avoid describing other tools
as corruptions: show how they map to, and can be replaced around, the open model.

Records supplies shared data models, permissions, commands, history and integration contracts. Apps
supply the experience. A board and a report can use one work datastore; a channel view and an inbox
can use one messaging datastore. Both can span gadgets and cloudflare-os instances, subject to
explicit grants. Removing an app does not remove its datastore. This makes it possible to replace
selected SaaS workflows with apps and data you operate, without promising full feature parity or
zero operating cost. Jira, Slack and Mastodon are possible adapter targets, never core vocabulary.

## Why this direction

| Choice | Assessment |
| --- | --- |
| Postgres + PostgREST + explicit commands | Recommended. Reuses a mature relational read API while retaining domain operations, permissions and transactional history. Portable across Postgres hosts. Costs SQL authoring and another service to operate. |
| Generalise the TypeScript bus | Credible fallback. Retains existing handlers and shared predictors. Could use deliberately limited reads; it does **not** inherently require rebuilding all of PostgREST. Less rewrite, but more module API code to maintain. |
| CRUD-only PostgREST | Insufficient for approval intent, command retries, multi-row operations and predictable history. Generated reads are useful; arbitrary table writes are not the public contract. |
| Neon Data API | Provider-specific compatibility layer adds uncertainty without solving a requirement. Use upstream PostgREST for the reference stack. |
| postgres-websockets | Not selected. A notification bridge still needs membership checks, reconnect recovery, revocation and backpressure. Reuse the existing relay pattern instead; no maintainer-count argument is necessary. |
| Supabase-sized platform or a new CMS | Broader scope than needed. Records' useful boundary is versioned domain modules with app bindings, not auth/storage/CMS feature parity. |
| Durable Object ledger or gadget mirror | Keep gadget-local state local. Shared business data has one transactional Postgres authority; lake exports are downstream possibilities. |

The earlier 7–10 versus 5–7 week estimates and line counts are unvalidated planning estimates. Estimate
again after the trial and a second module; do not turn those numbers into delivery commitments.

## Evidence and corrections to the earlier recommendation

The original inspection below describes the **legacy** packages, not the new `records-service`
implementation, which now has generic module dispatch:

- `packages/records-core/src/bus/bus.ts` imports `PROJECTS_HANDLERS` and contains a Jira-specific
  unconditional-write branch. Generic dispatch is not implemented.
- `packages/records-contracts/src/manifest.ts` describes compatibility, but its scopes come from a
  fixed enum. A manifest by itself is not module installation or bind-time enforcement.
- `packages/records-core/src/db/context.ts` installs transaction-local identity. Its scope pattern
  accepts two segments; the proposed `messaging.messages.send` vocabulary needs coordinated changes.
- `packages/records-core/src/bus/commit.ts` already uses a transactional counter row, not a sequence.
  Carry its invariants and tests forward, not necessarily its lock timing.
- `packages/records-node/src/pokes.ts` has SSE and LISTEN/NOTIFY infrastructure. That is reusable code,
  not proof of a complete, independently hosted, authorised relay.
- Existing migration files and deployed-state statements belong to the old implementation. The
  assertion that production holds no business data was **not verified against production in this
  review**. Inspect migration ledgers and data before any future cutover.

PostgREST gives each HTTP request a transaction and exposes request context to SQL. This supports
command RPCs, but does not supply Records' retry or conflict semantics automatically.
[PostgREST transactions](https://docs.postgrest.org/en/stable/references/transactions.html).

Its JWT support includes JWK sets and `kid`; configured audience checking still permits an absent
audience. Require issuer, audience, expiry and recognised principal/binding claims explicitly, and
test the actual signing algorithm and rotation. Do not treat a fixable token-shape mismatch as a
reason to discard the architecture. [PostgREST authentication](https://docs.postgrest.org/en/stable/references/auth.html).

Database placement does **not** make rules apply to every SQL user. Owners and `BYPASSRLS` roles
can bypass policies. Untrusted SQL users can also fabricate session settings; do not give them the
gateway's login. Use constrained runtime roles and separately designed read-only reporting roles.
[PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

## Standards, application profiles and mappings

Separate four layers so adopting a familiar SDK never dictates the storage model:

```text
Schema.org catalogue + custom namespaces
                    ↓ select and extend
Open application profile (meaning + validation + commands)
                    ↕ explicit versioned storage mapping
Postgres tables, views and command functions

Any independent SDK / compatibility adapter ↔ public application-profile API
```

The product should offer three equally supported starting points: use a supplied Schema.org-based
profile; extend one with namespaced terms and stronger constraints; or start fresh with a custom
model and no Schema.org dependency. None changes the permissions, history or API guarantees.

**Catalogue:** import the complete term graph from a pinned published Schema.org release, with its
types, properties, multiple inheritance, enumerations, expected types, descriptions and term status.
Track upstream source, release, checksums and licence/attribution. Preserve pending and retired term
status rather than silently treating every term as stable. Resolve supported HTTP/HTTPS term aliases
without changing meaning. Updates produce an explicit catalogue diff and never silently migrate
application data. Do not flatten multiple inheritance into one parent or create one SQL table for
every term. Schema.org publishes machine-readable whole-vocabulary definitions.
[Schema.org developer resources](https://schema.org/docs/developers.html).

**Profiles:** a vocabulary describes meaning; an application profile specifies required fields,
cardinality, allowed values, identifiers, references, permissions and commands. Schema.org's flexible
domain/range conventions are not a strict database validation schema. Catalogue coverage and tested
application-profile coverage must be reported separately. The initial catalogue can cover the full
release while well-tested executable profiles begin with work and messaging.
[Schema.org data model](https://schema.org/docs/datamodel.html).

Use stable term IRIs and JSON-LD contexts for portable semantic representation, with ordinary JSON
for ergonomic REST clients. Pin/allowlist context documents; do not fetch arbitrary user-provided
remote contexts during requests. Define field constraints in JSON Schema for API tooling and SQL
constraints for runtime enforcement, with conformance fixtures to prevent divergence. SHACL is a
possible later graph validation/export format, not a prerequisite or a claimed implementation.
[JSON-LD 1.1](https://www.w3.org/TR/json-ld11/),
[SHACL](https://www.w3.org/TR/shacl/).

**Open project example:** `schema:Project` gives the project its general meaning; it is a subtype of
Organization, not a complete work-item or workflow model. A separately versioned, openly documented
work profile can define `work:WorkItem`, `work:status` and transitions under its own namespace. Never
invent `schema:Issue` or attribute a custom term to Schema.org. Before publishing profile packages,
select an explicit reusable licence and a stable namespace owned by the publisher; example.org IRIs
in the docs are illustrations, not chosen production identifiers.
[Schema.org Project](https://schema.org/Project).

**Storage mapping:** map semantic properties to typed columns, relations, validated JSON extensions
or computed read projections. The mapping is a versioned module artefact with identity strategy,
null/cardinality handling, enum translation and supported write commands. Existing databases can
be mapped by reviewed views/import transforms and command functions; Records does not infer all
semantics from column names. V1 writes require the Postgres transaction, permissions and journal
boundary. An arbitrary remote database is not transparently made transactional by adding a mapping.
Cross-source federation and live bidirectional synchronisation are separate later projects.

**SDK mapping:** an independent developer can map Jira- or Linear-shaped request and response types onto the
open work profile. They own external IDs, enum mappings, unsupported fields, errors and compatibility
tests. A field mapping does not reproduce Jira workflow behaviour or guarantee existing SDK parity.
No Jira adapter is required to publish, store or use the work profile, and the Records team need not
build one. The same boundary applies to Slack/Matrix messaging SDKs and Notion/Confluence document adapters.

Trial additions: load a pinned complete catalogue with count/checksum and inheritance fixtures;
define a Schema.org-derived profile, an extension and a completely custom profile; map two different
physical project schemas to the same public model and compare results; round-trip a JSON-LD sample
without losing IRIs or custom fields; reject invalid cardinality/type writes; simulate an independent
adapter with a small fixture rather than implementing a full Jira, Linear, Slack or Matrix SDK. All must work without adding
domain-specific branches to the core. Model identity and permission filtering must also apply to
JSON-LD exports and mapped views.

## Product boundary and vocabulary

| Concept | Contract |
| --- | --- |
| Vocabulary | A versioned catalogue of semantic terms; Schema.org is supplied, custom namespaces are supported. |
| Profile | An open application model using selected terms, explicit constraints and domain commands. Independent of the physical database and SDK conventions. |
| Module | Reviewed deployable profile package: semantic model, storage mapping, commands, permissions, API major, migrations, sync metadata and examples. Not arbitrary SQL uploaded by end users. |
| Datastore | Organisation-owned instance of one module. Many apps can bind to it; one app may explicitly bind to several datastores. |
| Binding | Grant connecting an app or system to a datastore, narrowed by scopes and current principal rights. |
| Blueprint | An app template declaring required module, API major, features and scopes. Publication creates no live grant. |
| Adapter | Optional translation to another system's vocabulary and API. Separate identity mappings; no adapter-specific switches in the core. |

Initial scope: work and messaging modules; typed relational fields with explicitly validated JSON
extensions; REST reads and command writes; change pull; cloudflare-os connector; service credentials;
history and redaction. Rich document editing, CRDTs, federation, attachments, full-text search,
visual schema authoring, arbitrary end-user SQL and full third-party compatibility are later work.
Messaging proves a different ontology; it does not promise a complete Slack replacement.

## Reference architecture

```text
cloudflare-os app → Records gatekeeper (viewer assertion + approval) ─┐
external app / script → Records gateway (scoped service credential) ─┤
                                                                   ↓
                          private PostgREST → Postgres
                          versioned views     core + module tables
                          command RPCs        RLS + journal + outbox
                                                   ↓ after commit
                             dedicated LISTEN relay → SSE / DO poke hub
                                                   ↓
                                  clients pull authorised changes

trusted Worker → Hyperdrive → restricted SQL entrypoints (optional)
module installer → direct migration connection (separate role)
```

The Node gateway makes standalone deployment possible. The Worker adapter supplies cloudflare-os
integration. Share validation and contract code, not a second set of business rules. PostgREST is
private; the gateway handles credentials, limits, safe error translation and stable URL mapping.
It maps registered module/API identifiers to fixed schemas and endpoints, never arbitrary client
schema names. Clear caller-supplied internal identity/profile headers before forwarding. Each request
gets a short-lived, narrowly scoped internal token. Browsers never receive database credentials.

Expose approved read views and command RPCs only. Runtime roles get no raw table DML or DDL.
Reads go through the per-module presentation schema, whose views are owned by a non-bypassing
presenter role (see [Authority, attribution and permissions](#authority-attribution-and-permissions)).
Use explicit schema grants, revoke public function execution, and tightly review command functions
with fixed search paths and least-privileged, non-owner roles. Definer functions must explicitly
enforce current rights; owner bypass is not an auth model.
Cross-datastore foreign keys include the datastore key so a valid record ID cannot cross a boundary.

External credentials map to service principals. On cloudflare-os, the requesting viewer and exact
approved intent remain bound to the command. Approval is not an enduring data grant: re-authorise
at application time. Check organisation, datastore, API major, binding, principal and required scopes
on every request. Multi-instance trust requires explicitly enrolled issuers and bindings, not shared
email addresses. Agents use the same granted interfaces and approval rules.

## Write and sync target contract

> Proposed replacement: [Records as an immutable fact store](records-immutable-facts.md), sections 3–7. It maps each rule below to a fact-based equivalent.

The following is the target contract. Current implementation is narrower: single-record commands,
sequence-plus-epoch cursors and bounded atomic snapshots. Batches, redaction/retention, webhook
delivery and opaque cursors remain unimplemented; see [current status](records-status.md).

Start with one datastore per write transaction. Use a conservative, consistent lock order across
commands and membership/revocation operations:

1. Validate trusted identity; lock the principal, membership and binding rows used for authorisation
   in a documented order shared with revocation. Reject missing/expired/revoked authority.
2. Lock the datastore counter row **before domain rows**. Recheck any authorisation state not locked.
   This serialises writes per datastore for the initial implementation; measure its cost.
3. Check idempotency under that lock. Key scope includes organisation, datastore, principal, binding,
   command and API major. Store a canonical input digest including the revision precondition.
   Same key + same digest returns the committed outcome; different digest returns 409. Recheck
   authority before replay. An ambiguous network failure is safely retried with the same key.
4. Validate input and expected revisions. Missing required `If-Match` returns 428; a stale revision
   returns 412. A successful retry returns its earlier result even when its old revision is now stale.
5. Apply bounded domain changes, increment the transactional counter once, and write journal entries
   with `(datastore_id, seq, ordinal)`, current-row revisions, audit and outbox in the same transaction.
   Store the successful idempotency result, then emit a small NOTIFY hint. Commit or roll back all of it.

This is a **commit-ordered counter**, not a timestamp assigned at the instant of commit. Holding the
row lock until commit prevents the next writer from overtaking it; rollback also rolls back the
increment. No `nextval`, deferred stamping machinery, cross-datastore transaction, or network call
inside the lock is needed. Batches are bounded and share one sequence with multiple ordinals. A no-op
returns without advancing it. Tail-lock optimisation is later work only if benchmarks justify it.

Pulls use a consistent snapshot and an opaque, datastore- and permission-epoch-bound cursor. Include
ordinal/pagination state or return whole commits so page boundaries never drop part of a command.
Filtered readers may see sequence gaps. Changed permissions force a reset and purge of locally
cached data; expired retention cursors require a fresh snapshot. Snapshot pagination must hold a
stable high-water mark. Predictors are optional UI conveniences, never validators or authority.

NOTIFY is a hint delivered after commit, not a durable queue. Reconnect and periodic reconciliation
pull from the journal. Authenticate relay subscriptions, check current membership, bound queues and
stream lifetimes, and avoid record payloads in notifications. A durable outbox handles retried
webhooks separately. Monitor notification queue pressure and terminate stalled listeners.
[PostgreSQL NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html).

History is append-only for ordinary writers, with privileged, audited redaction and retention.
Do not claim permanence or tamper resistance against the database operator. Idempotency responses,
exports, backups and client caches belong in the erasure policy too. Per-datastore undo creates a new
command; disaster recovery is a separate backup procedure.

## Authority, attribution and permissions

**Decided by the owner.** On 2026-09-25: the organisation's connector (`gatekeeper-records-service`)
holds each datastore's Records credential and decides, through the gatekeeper, who may read and who
may request a command. On 2026-09-26:

- Postgres enforces permissions, as part of each data model.
- A **presentation schema** of views is the only data surface granted to clients.
- The gateway stays in front of PostgREST.
- Every write remains a command.

Any rule that must hold for every client (cloudflare-os, external systems, SDK users, other
connectors) therefore lives in Postgres, not in a connector.

### Layers

| Layer | Holds | Who may use it |
| --- | --- | --- |
| Storage | Core tables (registry, bindings, journal, idempotency, outbox) and module tables. RLS enabled and **forced** on every table. | No client grants. Only the presentation owner, command owner and migration roles. |
| Presentation | One schema per module and API major, e.g. `present_work_v1`. Views over storage: entities, restricted-field masks, history. | `SELECT` for the runtime role. The only readable surface. |
| API | `records_api` read functions (`SECURITY INVOKER`, reading presentation views) and command RPCs. | `EXECUTE` for the runtime role. |
| Gateway | Credential check, the short-lived PostgREST token, limits, error mapping, SSE. | Public, behind its own checks. PostgREST stays private. |
| Connector | Datastore credential, Workshop approval, viewer identity. | cloudflare-os gadgets and agents, through their bindings. |

### Identity in the token

Today the gateway signs a 60-second PostgREST token with the binding's principal, organisation,
datastore, binding, scopes and permission epoch. It will also carry the **actor**, the person the
binding acts for, in the standard `act` claim (OAuth token exchange, RFC 8693):

- A binding may name an actor only if it holds an explicit "may attribute" grant. The connector names
  the viewer it verified from a one-use Workshop viewer assertion, for example
  `cloudflare-os:<email>`. Other bindings act as themselves.
- `records.actor()` returns the delegated actor, or the binding's own principal when there is none.
  `records.has_role(role)` looks up the actor's roles in a Records table, never in the token, so
  revoking a role takes effect on the next request.
- Roles (`member`, `admin`, and roles a module defines) are keyed by actor identity and managed by
  operator/admin tooling. A gadget never grants a role.
- The actor is only as trustworthy as the binding that names it, so only the operator's connector
  receives the grant.

### Presentation schema

Each module/API major gets a presentation schema, generated at publication and starting as 1:1 views
of its storage entities. This separates the public model from physical storage. Storage can later be
remodelled (tables split or merged, columns moved) while the views keep an API major's shape. A new
API major gets its own presentation schema beside the old one.

- Views are owned by a dedicated `records_presenter` role. It has `NOBYPASSRLS`, does not own the
  storage tables, and has only `SELECT` on them. Views run with their owner's rights, so the runtime
  role needs grants on the views alone. Storage RLS (tenant isolation, and any storage-level rule)
  still applies underneath, because the owner cannot bypass it.
- Views are `security_barrier`, so a caller's filters and functions cannot observe rows the view
  hides. `records.actor()` and `records.has_role()` are `STABLE`, and rule columns (owner, datastore)
  are indexed. The performance gate is a measured benchmark of view reads against today's reads.
- Profiles, JSON Schema, JSON-LD and OpenAPI describe the presentation, not the storage tables.
- The current generic `records_private.records` projection becomes an internal detail. Reads,
  snapshots and changes move to presentation views.

### Row, field and history rules

Rules are ordinary Postgres, reviewed with the module:

- **Read rules** live in view definitions: row filters in `WHERE`, and field rules as masks. A
  restricted field such as a profile's contact details appears only when
  `owner = records.actor() OR records.has_role('admin')`, and is otherwise absent. The profile marks
  such fields restricted, so schemas and clients know they may be missing.
- **Write rules** are RLS `INSERT`/`UPDATE` policies on storage tables, for example
  `USING (owner = records.actor() OR records.has_role('admin'))`. Command handlers run as a dedicated
  `records_commander` role (`NOBYPASSRLS`, not a table owner), so Postgres enforces these policies on
  every command. The command still does validation, revisions, idempotency and journalling.
- **Ownership** is a storage column set from `records.actor()` at create. It changes only through an
  explicit, journalled transfer command.
- **History** is a presentation view over the journal. Each journal row keeps the actor and the
  record's owner at that point (`owner_at_change`). The history view returns rows only to
  `records.actor() = owner_at_change` or `records.has_role('admin')` (or a module-defined rule), and
  applies the same field masks to the stored data. `changes`, snapshots and exports read these views.
  Filtered readers therefore see sequence gaps, which the sync contract already allows.
- A change to roles or ownership bumps the datastore's permission epoch, forcing clients to reset
  their caches.
- Hiding history from readers is not erasure. Erasure is a privileged, journalled redaction that also
  covers idempotency results, exports, backups and client caches.

### Attribution

Attribution needs no separate mechanism:

- The journal gains `actor` and `owner_at_change`. Storage rows gain server-set `created_by` and
  `updated_by`. All of these are `records.actor()` or derived from it at write time. Client input can
  never set them.
- The actor is part of the idempotency digest, so a retry cannot re-attribute a change.
- Presentation views expose "created by" and "last changed by". The history view exposes each
  change's actor.
- A trigger refuses `UPDATE` and `DELETE` on the journal. Privileged redaction is the only exception,
  and it is itself journalled.

### Publication checks

Publishing a module refuses any storage table without RLS enabled and forced and a tenant policy.
It also refuses:

- any grant on storage to the runtime role;
- a presentation schema missing any profile entity;
- a view not owned by `records_presenter` or not `security_barrier`;
- a command handler not owned by `records_commander`.

Module tests must cover each declared rule with an allowed and a refused actor, for reads, writes and
history.

### Delivery stages

1. **Actor and attribution.** Add the `act` claim, the "may attribute" grant, `records.actor()`,
   journal `actor` and `owner_at_change`, `created_by`/`updated_by`, actor in the idempotency digest,
   and the append-only journal trigger. The connector sends the verified viewer, and the blueprints
   show who created or changed a record.
2. **Presentation schema.** Generate 1:1 views for `work` and `messaging`. Add the presenter and
   commander roles, move reads, snapshots and changes to invoker functions over the views, remove
   client access to storage, and add the publication checks. Behaviour must match stage 1.
3. **Rules.** Roles table and `has_role()`, ownership and transfer, restricted fields, history views,
   epoch bumps on role or ownership change. Run a first rule-bearing module (for example
   `people.profile`) through the acceptance tests below.
4. **Connector reads as the actor.** Shared gadgets use `excludeObservers` for observations some
   observers may not see.

Acceptance for stages 3–4:

- An owner edits their own profile, and a non-owner is refused, including through a replayed or
  altered intent.
- Only the owner and admins see a profile's history and restricted fields, in reads, snapshots,
  `changes`, JSON-LD and exports.
- Shared-gadget observations exclude the right observers.
- Revoking a role resets caches.
- External bindings obey the same rules.

### Where attribution lives today

Durable Objects store only what their code writes; the platform keeps no native record of who
changed what. What exists now:

- **Workshop action records** (per workspace, in the Overseer's storage) hold the gadget or agent that
  called, who resolved the action (`resolvedBy`) and whether it was auto-approved. The person who
  *requested* the action appears only in the gatekeeper-written description text, not as a field.
  These records live and die with the workspace.
- **The connector facet** stores each pending command with its verified `viewerId` and outcome. Only
  the last 1,000 settled actions per gadget binding are kept.
- **Gadget state** (for example Yjs documents) has no per-user authorship unless the app records it,
  as the Whiteboard does with the signed-in account.

None of these is a durable, queryable, cross-app audit. That is why attribution belongs in the
Records journal.

## Module publication and API design

Module package layout (the alpha implements the initial profile/SQL format; see the package READMEs):

```text
modules/messaging/
  module.json             # id, semver, API majors, entities, scopes, limits
  model/                  # profile, pinned vocabulary refs, JSON-LD context, constraints
  mappings/               # semantic fields ↔ physical schema, identifier and enum rules
  migrations/             # checksummed SQL: storage tables, RLS write policies, command handlers
  presentation/           # presentation views per API major (generated 1:1 first), field masks
  api/openapi.json        # reviewed public contract, including gateway errors
  tests/                  # commands, permissions, isolation, upgrades
  examples/               # blueprint requirement and external HTTP client
  predictors/             # optional browser code
  adapters/               # optional compatibility packages
```

Core owns registry, identity, memberships, bindings, journal, idempotency, outbox and sync mechanics.
Modules own entities, business constraints, commands, scopes, projection/sync mapping and redactable
fields. SQL installation is privileged code deployment; packages are trusted and reviewed.

Publication validates names and dependencies, acquires an installation lock, checks migration
checksums, compares public contracts, applies transactional migrations where possible, registers
metadata, reloads PostgREST schema cache, probes the new contract, and only then enables bindings.
Record failed/nontransactional steps explicitly. No datastore or user grant is created by publication.
Initial releases avoid nontransactional migrations. Schema per module/API major, not per tenant;
tenant/datastore keys and RLS isolate rows. Datastore installation metadata pins the compatible
module release, but migrations of shared tables must preserve all supported API versions.

Implemented versioned URL: `/v1/datastores/{id}/modules/{module}/v{major}/…`.
Reads retain a documented subset of PostgREST filtering, ordering and pagination; query complexity,
row count and response size are bounded. Writes use `/rpc/{command}`. The gateway translates errors
to `application/problem+json`. Generate SDKs from the **public** contract, not an unmodified internal
schema dump. PostgREST's API description is a useful input, not proof of SDK contract compatibility.
Additive changes stay within an API major; breaking changes require a parallel major and migration
window. Enum additions and tighter validation need explicit compatibility review too.

## Hosting and Hyperdrive

Reference development topology: Docker Compose with Postgres 17, upstream PostgREST, Node gateway
and relay on a private network. Pin tested image versions/digests at trial time; persistent named
volume, health checks, local-only gateway port, ephemeral test keys. The local alpha now ships this topology in `packages/records-service/compose.yaml`; it is tested
locally. The separate `packages/records-service/deploy/` topology now runs on the homeserver,
serving the website and API through cloudflared. Postgres/PostgREST have no public ports. See
[deployment evidence](../../../packages/records-service/deploy/homeserver.md).

The selected alpha host is `ms:~/containers/records`. Before business data, establish an owner
for database patching, backups, disk capacity and recovery; managed Postgres remains an alternative.
Self-hosted Postgres is fully valid with that ownership. Provider is deliberately open; Neon has no
special status. Place PostgREST and the relay close to the database; use direct connections and
separate runtime, listener and migration roles.

Workers call the Records gateway over authenticated HTTPS, or Workers VPC once validated in the target
account. VPC is currently beta; don't make that beta a correctness dependency. Hyperdrive is the
SQL transport for optional trusted Worker callers, with cache disabled for authorisation-sensitive
queries and transaction-local context. Session listeners use a direct connection, not Hyperdrive.
[Workers VPC](https://developers.cloudflare.com/workers-vpc/),
[Hyperdrive supported features](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/).

## Delivery sequence and acceptance gates

| Stage | Deliverables | Exit evidence |
| --- | --- | --- |
| 0 — this change | Decision, archive notices, product site and docs preview | Site builds; links, mobile layout and demo interactions checked. Initial website-only phase completed; superseded by deployed alpha status. |
| 1 — bounded trial | Disposable Compose stack, catalogue import and model-mapping fixtures, two tiny modules, gateway contract, SQL commands, relay | Standards fixtures plus security/concurrency/recovery matrix below; measured resource and latency report. |
| 2 — model and module foundation | Pinned complete Schema.org catalogue, profile format, storage mappings, installer, registry dispatch, work module extracted | Extend a profile and start fresh; install messaging without editing core; incompatible blueprint binding fails; additive upgrade succeeds. |
| 3 — integration | Generic cloudflare-os connector, scoped external API, SDK, sync and inspector | Two gadgets and an external client converge; viewer attribution and approval retained; cross-instance grants tested. |
| 4 — operations and cutover | Backups, redaction, import, rollback rehearsal, staging | Restore proven; data and migration inventory approved; staged cutover succeeds before live rollout. |

Timebox stage 1 to five engineering days as a planning budget, not a promise. Produce a go/no-go
record with actual evidence. Test:

- ES256 tokens, wrong/missing audience and issuer, expired/missing expiry, unknown `kid`, key rotation,
  revoked principals and bindings, forged tenant context, observer isolation and denied raw DML.
- Two modules using the same core. Wrong module/API requests fail. Another tenant's IDs and nested
  relationships never leak through reads, errors, changes or commands. Run using runtime roles.
- Concurrent duplicate requests, changed-body reuse, rollback after counter increment, stale edits,
  delayed commit versus later writers, connection loss after commit, deadlock retries and revocation
  races. No missing journal entries, duplicate mutations or skipped visible committed changes.
- At least 50 successful small commands/second for one datastore for ten minutes as an inherited
  provisional target; also test several datastores, slow writers, p50/p95/p99, CPU and lock waits.
  Record workload and hardware. Establish user latency budgets from measurements, not invented SLAs.
- Disconnected/restarted relay, lost notifications, slow subscribers, cursor pagination, permissions
  changes and snapshot resets. Target p95 poke delivery below one second on the reference stack;
  prove eventual convergence even when that target is missed.
- Worker HTTP and optional Hyperdrive SQL paths: latency, pool reuse without identity leakage,
  auth/error fidelity and topology cost. VPC failure must have a supported HTTPS alternative.

Reject the SQL-command direction if isolation or history correctness cannot be proven, module
authoring requires core edits, or bounded contention cannot meet the agreed workload. Token wiring
or transport setup failures should first be fixed within the boundary. If the direction fails, retain
the module/API contract and implement it using a generic TypeScript command registry; do not resume
the old Jira-shaped design.

Migration work must preserve the old runtime until parity. Do not edit applied migration checksums.
Inventory actual environments first; import existing Projects data and adapter IDs if any. Stage
separately, compare counts/revisions/permissions, freeze writes for final import, switch one client,
then expand. Avoid dual writers. A rollback after new writes needs a tested data reconciliation plan,
not just a Worker rollback. Retire old routes only after their consumers have moved.

## Current artefacts and remaining decisions

- Product website and starter docs: [`sites/records`](../../../sites/records/README.md).
- Prior reframing and code audit: [app-datastore-service.md](app-datastore-service.md), historical.
- Every earlier document in both datastore folders now points here; gadget HTTP research remains
  useful for that separate feature, not authority for Records.
- Earlier scratchpad HTML concepts are preserved unchanged and copied into the site's labelled
  historical archive. The comparison page places the old and new sites side by side. Original
  historical copy is deliberately not rewritten.

The owner selected and authorised the homeserver deployment after this initial decision. Before
business data, settle operational ownership, recovery point/time targets, off-host backup retention,
expected datastore size/write load, and cross-instance identity enrollment policy. The deployed
alpha does not imply a service-level promise or authorise migration of existing data.

Next client work: [blueprint adaptation](records-blueprint-adaptation.md) and
[Records Explorer](records-explorer-blueprint.md). Both are plans, not implemented blueprints.
