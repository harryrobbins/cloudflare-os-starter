# Organisation datastores: research and decisions

Written 2026-09-23 against starter `7d39f48` and pinned `cloudflare-os` `e50a9058`.
This supports the authoritative [implementation plan](../plans/organisation-datastores.md).
It supersedes the recommendations in [External API Plan A](external-api-plan-A.md) and
[external records service](../plans/external-records-service.md). Those documents remain historical
inputs, not parallel implementation instructions. No provider spike or deployed validation has
been performed for this design.

## 1. Decisions and alternatives

| Question | Decision | Reason and tradeoff |
| --- | --- | --- |
| System of record | Managed Postgres for organisational business records | Relational integrity, reporting and recovery tooling; adds a regional dependency and operational cost |
| Service shape | Domain operations shared by Gatekeeper RPC and HTTP | Workflow/authorization parity; more implementation than automatic table REST |
| Generic PostgREST | Deferred, optional constrained views/functions | Not required for the initial clients; avoid a second authorization/write path |
| Physical tenancy | Database per organisation deployment/environment; schemas per module | Keeps initial operations manageable; instances share a failure/restore boundary |
| Logical tenancy | Organisation-owned datastore IDs and RLS-scoped module rows | Multiple UIs can share a dataset without duplicating schema or owning it |
| Publication | Publish code/contracts only | Publishing a template must not mutate unrelated organisations' data |
| Schema changes | Reviewed module installation/upgrade migrations | Explicit compatibility and rollback/roll-forward planning |
| Connector UI | Headless service plus Workshop-hosted Data management page | Organisation administration survives replacement of any gadget UI |
| Discovery | Authoritative permission-filtered registry | Existing connector listings do not describe all dataset instances |
| User identity | Platform-authenticated invocation context; implementation gate | Current browser attribution cannot enforce per-viewer permissions |
| Automation identity | Explicit delegated service principals | Keeps unattended work attributable and revocable |
| Live updates | Transactional outbox → Queue → notification DO → authorized refetch | Business transaction remains authoritative; consumers handle duplicates and delay |
| Audit/feed | Separate tables and retention | Audit evidence and delivery queues have different access and lifecycle needs |
| Cache | Hyperdrive caching disabled for v1 | Predictable permission checks and read-after-write semantics |
| Initial permissions | Datastore-wide read audience and operation-specific writes | Fits shared gadget state; fine-grained private outputs require more isolation |

These are design choices for this deployment, not claims that other architectures are universally
wrong. Durable Object storage remains appropriate for gadget-local records and coordination.
One-way mirrors may support legacy reporting, but are outside the first release and must clearly
label the authoritative source. A generic collections service could be a later module rather than
the storage model for every domain.

## 2. What the current checkout supports

The relevant current sources are:

- [`gatekeeper.ts`](../../cloudflare-os/packages/workshop-shared/src/gatekeeper.ts):
  `AccountDescription.providesUi`, `GatekeeperUser.startAppUi`, resource configurators,
  `Gatekeeper.startSession`, `getAgentCatalog`, `addObserver` and action pre-approval contracts.
- [`library-gatekeeper.ts`](../../cloudflare-os/packages/gatekeeper-context/src/library-gatekeeper.ts):
  an existing management application, discovery catalog and observer implementation to study.
- [`gatekeepers.tsx`](../../cloudflare-os/packages/workshop-frontend/src/routes/gatekeepers.tsx):
  Connectors lists connected accounts/vendors; it is not an organisation dataset registry.
- [`overseer.ts`](../../cloudflare-os/packages/workshop-backend/src/overseer.ts):
  `GadgetClientImpl.getViewer`, `UseGadgetClientInterface.getViewer`, shared gadget connections,
  bindings and observer verification.
- [Viewer identity research](gadget-viewer-identity.md) and
  [the current trust-limit statement](../plans/collaborative-blueprints.md#viewer-identity-and-change-attribution):
  `gadgetViewer` reaches the iframe, but the gadget server receives ordinary client arguments.
- [Existing Supabase Gatekeeper](../../cloudflare-os/packages/gatekeeper-supabase/README.md):
  administrative SQL access with approved mutations, not the proposed domain records service.
- [`scripts/deploy.ts`](../../scripts/deploy.ts): wrapper-generated Worker configuration, builds and
  service binding/deploy ordering. The Records package and configuration do not exist yet.

Inference: management pages, resource selection, discovery metadata and action approvals can use
existing extension points. Organisation ownership, datastore lifecycle, metadata enforcement and
trusted per-viewer authorization need new implementation. In particular, enabling an account
automatically must not be interpreted as granting organisational dataset access.

The operator workflow informed the plan's private Worker boundary, optional deployment, explicit
resource ownership, isolated evaluation and recovery gates. The plan does not authorize deployment.

## 3. Publication is not provisioning

There are three independently versioned things: a blueprint UI, a service API and a physical SQL
schema. Coupling their versions would force every cosmetic UI release to become a database release
and make two clients of one dataset difficult to maintain.

Blueprint publication declares compatibility and scopes. Module installation applies migrations
once to the chosen environment. Creating a datastore is normally an ordinary transaction inserting
registry, membership and initial domain rows. Binding is a capability grant. None of these implies
the others automatically.

A module upgrade may affect every datastore sharing its schema. Track installation/migration
state at the database/module level, not pretend each logical datastore has an independently
installed physical schema version. Per-dataset custom-field configuration has its own revision.

Data must survive creator offboarding and connection revocation. Organisation ownership therefore
cannot be encoded solely as the connecting user's Gatekeeper account ID. Keep stable organisation,
principal and datastore identities, with explicit ownership transfer and grant administration.

For different isolation needs, compare:

| Layout | Advantages | Cost/limitation |
| --- | --- | --- |
| Shared module tables, datastore key | One migration stream, simple aggregate reporting | Shared failure/restore boundary; rigorous RLS required |
| Schema per datastore | Namespaced object layout | Migration fan-out; still shares database recovery and compute |
| Database/project per datastore | Independent administrative/recovery boundary where provider supports it | More connections, migrations, monitoring and cost |

Choose the first for initial logical instances. Select dedicated infrastructure for a concrete
requirement, and verify provider isolation rather than assuming separate database names imply
independent compute, keys or backups.

## 4. Identity and sharing are the primary platform gate

The existing Gatekeeper binding carries the connecting account's authority and is shared by callers
of a gadget. It cannot infer which viewer caused a call. `gadgetViewer` is useful for honest-client
display and attribution but is not an authorization credential.

The proposed service must receive authority from the authenticated platform, not a gadget-supplied
actor string. Candidate mechanisms are invocation-bound capabilities or platform-mediated
per-viewer sessions. Both require a code-level spike through actual Cap'n Web/Worker boundaries.
An ordinary signed bearer token passed through arbitrary gadget code could be retained/replayed;
signing an identity string alone does not solve that problem. Test lifetime, binding, nested calls,
async interleaving and background execution before choosing a mechanism.

Sharing creates a second problem: an authorized read may already have entered the gadget's shared
cache, UI, transcript or exported archive. RLS on later queries cannot retract those copies.
The current observer interface explicitly requires checking access to historical observations.
V1 should therefore use one compatible read audience per gadget/datastore, enforce observer
verification and disallow sharing paths that cannot protect past materialized state. Private row
or field permissions are deferred until output/cache isolation is designed.

Approval and authorization answer different questions. Approval permits an already-authorized
action to execute. It must not expand the principal's or binding's scope. Rechecking at execution
also prevents an approved-but-delayed action from using revoked membership. External machine
clients use explicit service grants, rather than pretending to be gadget viewers.

## 5. PostgreSQL boundary and view pitfalls

PostgreSQL RLS is default-deny once enabled without an applicable policy. Owners normally bypass
it; superusers and `BYPASSRLS` roles bypass it. Foreign-key/uniqueness checks have separate behaviour,
so tests must include cross-dataset references and possible information disclosure through errors.
The design uses dedicated application roles, explicit tenant keys in constraints, and negative
tests under actual runtime credentials. [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

Views do not automatically solve authorization. `security_invoker` makes underlying permissions
use the invoking role; this also means the invoker needs the applicable underlying privileges.
A design promising both invoker views and no underlying grants needs examination. Owner-context
views and `SECURITY DEFINER` functions require deliberate ownership, search path, execution grants
and RLS analysis. Merely naming a schema `api_v1` is not sufficient.
[PostgreSQL CREATE VIEW](https://www.postgresql.org/docs/current/sql-createview.html).

V1 avoids a public SQL/table API. The trusted service runs parameterized domain queries under a
least-privileged role with transaction-local context; RLS protects against accidental omitted
predicates. It does not protect against a compromised service that can set arbitrary context.
No gadget or machine client receives that role's database credentials.

## 6. Hyperdrive and provider selection

Hyperdrive query caching is enabled by default and writes do not invalidate matching cached reads.
Use a cache-disabled configuration for permissions, membership, registry and transactional reads.
Do not rely on SQL comments or inferred cache keys to separate tenants. Pooling still has value
with caching disabled. [Cloudflare query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/).

The [supported-features documentation](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/)
is the compatibility reference, not evidence that this project's exact SQL/driver combination has
been tested. Phase 0 must prove transaction pinning, local context/role setup, rollback cleanup,
timeouts and concurrent tenant isolation through the selected driver and Hyperdrive configuration.
Do not build notification delivery on an assumed persistent `LISTEN` session through the pool.

Neon is an evaluation candidate; Supabase, RDS/Aurora or another managed Postgres provider remain
possible. Choose using measured latency, region, availability, restore capability, ownership,
connection capacity, operational familiarity and total cost. Provider-specific Data API claims are
not prerequisites: the attempted Neon documentation fetch was unavailable during this review and
no custom-JWKS/PostgREST compatibility is asserted. If selected later, verify the exact feature set.

Use synthetic local/disposable test databases by default. A provider branch is optional and must
not silently copy production personal data into CI. Before production selection, record numeric
RPO/RTO, retention, latency/freshness and revocation targets plus an estimate at expected load.

### Neon suitability and proposed setup

Neon is compatible with the chosen architecture and is the recommended first evaluation target.
Cloudflare documents a Neon integration through Hyperdrive. The intended path is Records Worker
→ Hyperdrive → Neon Postgres, with ordinary PostgreSQL transactions and RLS; Neon Auth and the
Neon Data API are not required. [Cloudflare Neon integration](https://developers.cloudflare.com/workers/databases/third-party-integrations/neon/).

Neon's Hyperdrive guidance recommends its direct, non-pooler connection endpoint as the Hyperdrive
origin, and a standard driver such as Postgres.js or node-postgres in the Worker. Do not stack
Neon's connection pooler or HTTP/WebSocket serverless driver into this path. Keep application
credentials least-privileged and migration credentials separate.
[Neon Hyperdrive FAQ](https://neon.com/blog/hyperdrive-neon-faq).

Proposed setup: organisation-controlled Neon account/project, a region chosen for the organisation's
residency and latency requirements, isolated development and production projects, module schemas
inside production, and logical datastore IDs inside module tables. Use disposable test branches
from synthetic data if useful. Publishing a blueprint still creates no Neon database or branch.

Neon documents point-in-time branch restore within its configured history window. The exact
available retention, availability commitments, compute limits and pricing must be verified for
the selected current plan; no fixed figures are assumed here. Test restoring into an isolated
branch and extracting one dataset without rewinding other organisational datasets.
[Neon point-in-time restore](https://neon.com/blog/announcing-point-in-time-restore).

Measure idle/resume behaviour together with the outbox polling strategy: frequent database work
can undermine an assumption of idle compute savings. Confirm actual costs and latency in the
spike. Neon is a suitable hosting choice, but organisation permissions, the registry, domain API
and trusted gadget identity remain responsibilities of this implementation.

## 7. Outbox correction: allocation order is not commit order

The earlier records proposal uses a `bigserial` change table and advances `seq > cursor`. That is
not sufficient for reliable delivery under concurrent transactions. PostgreSQL sequences allocate
values independently of transaction rollback. [Sequence documentation](https://www.postgresql.org/docs/current/functions-sequence.html).

The following is a design inference from those transaction semantics, to verify with a regression
test: transaction A allocates 10 and pauses; B allocates 11 and commits; the poller sees 11 and
advances its cursor; A then commits 10. A poll restricted to values above 11 never sees A's event.
UUID or timestamp ordering alone does not establish commit order either.

Use an indexed pending-event queue in Postgres with lease/retry state. Claim rows in a short
transaction, publish outside it, and mark acknowledged publication. A late-committing row remains
pending and is eligible next time. A crash after enqueue can duplicate an event, so use stable
event IDs and idempotent consumers. Preserve pending events even with zero active subscribers.

Cloudflare Queues provides at-least-once delivery; consumers cannot assume exactly-once effects.
Use entity revisions for invalidation and refetch current state. Queue retry/dead-letter recovery,
retention expiry and reconnect refresh must be tested.
[Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/).

Separate audit history from delivery state. Audit access, retention and possible sensitive diffs
must not be inherited by every subscriber. Prefer identifiers and revisions in notifications,
and treat even identifiers as authorization-filtered metadata.

## 8. Operational consequences and unresolved gates

Database-level PITR does not imply independent restore of one logical dataset. Restore to an
isolated database and selectively recover the target's records and relationships, or choose
dedicated infrastructure when independent recovery is a firm requirement. Coordinate registry,
identity mappings, grants and audit recovery; restoring old credential rows must not revive
revoked keys. Maintain a recovery procedure that reconciles credentials with current authority,
and rotate/revoke restored service credentials before reopening traffic.

Worker rollback does not roll back SQL. Additive migrations, overlapping service versions and a
tested roll-forward path are required. Existing gadgets are not automatically converted: a later
import tool needs an explicit authority cutover and reconciliation plan, never two writable copies.

| Gate | Required evidence | Owner in implementation plan |
| --- | --- | --- |
| Trusted identity | Two-user concurrency, forgery/replay denial, background identity separation | C with A review |
| Shared-state isolation | Unauthorized current/historical observation and export tests | C and E |
| SQL/Hyperdrive | Real transaction-local isolation and cleanup, latency/capacity measurement | B and D |
| Module lifecycle | Empty/upgrade migrations, checksum/lock behaviour and old-client compatibility | A and B |
| HTTP/RPC parity | Same permitted results and denials; pending approval semantics | D, E and F |
| Event durability | Late commits, lease expiry, duplicates, dead letters, snapshot race recovery | H |
| Provider/recovery | Selected region, cost/targets and successful isolated restore | A/operator |

The implementation plan owns scope, phases and acceptance criteria. This document owns the
reasoning and evidence. Update both if a gate changes the architecture; mark failed hypotheses
explicitly rather than leaving contradictory recommendations in an active plan.

## 9. Phase 0 decisions and evidence (2026-09-23)

Recorded during implementation, against starter `7d39f48` and fork branch `feat/viewer-assertions`
(`a687cbdf`, on top of `e50a9058`). Everything below was verified locally; nothing was provisioned or
deployed, and no provider (Neon or otherwise) was contacted.

| Question | Decision | Evidence |
| --- | --- | --- |
| Test provider | `embedded-postgres` 17.9 (real Postgres server binaries from npm), one disposable cluster per test run, one database per test file | Docker Desktop could not be started from WSL on this machine (`cmd.exe` interop failed), and PGlite is single-connection, which cannot exercise lock ordering, revision races or late commits. Real concurrency is covered by `records-schema` and `gatekeeper-records` tests |
| Migration runner | In-repo runner (`packages/records-schema/src/migrate.ts`), not dbmate | The plan requires a checksum ledger; dbmate records versions only. The runner holds a session advisory lock, re-verifies every applied checksum, refuses edited, missing or out-of-order files, and commits each migration with its ledger row. Tests: concurrent runners, drift, rollback of a failing migration |
| Driver | postgres.js with `fetch_types: true` | Array columns (`scopes`, `api_versions`) arrive as raw strings with type fetching off; one catalogue query per connection is the cost |
| Trusted context | `set_config(..., is_local => true)` for `records.org_id`/`records.datastore_id`/`statement_timeout` at the start of each transaction | Test: context is gone after COMMIT and after ROLLBACK on the same reused connection. **Not yet verified through Hyperdrive**; the Phase 0 Hyperdrive bullet stays open |
| Caller capability | **Viewer assertions** (invocation-bound), not per-viewer sessions | See below |
| Hook persistence | A `DatastoreFeed` Durable Object per datastore stores each approved hook's `HookInitiator`, keyed by binding ID (idempotent re-registration). Each delivery re-checks the binding in Postgres, calls `startHook()`, authorises an observation and disposes every returned stub | Follows the Scheduled Tasks pattern in the fork. Not yet exercised against the real Workshop |
| Publisher wake-up | Publish immediately after each committed write (`waitUntil`), plus a one-minute cron as the backstop that also prunes delivery state | Idle cost is one small indexed query per minute. Late-commit, lease-expiry, backoff/dead and concurrent-publisher tests pass. Idle/active cost against a real provider is still unmeasured |
| Identity mapping | Issuer `workshop-email`, subject = lower-cased Access-verified sign-in e-mail. Principals have internal UUIDs; the e-mail is a mapping, not a key | The Workshop keys accounts by that e-mail (`GadgetViewer.id`), so the connect flow (Access JWT) and viewer assertions (kernel) agree. Organisations and principals are created by an operator bootstrap and by data administrators, never inferred from an e-mail domain |

### Caller capability: viewer assertions

The kernel already had owner action permits (`c84d34df`): one-use, 60-second tokens bound to one
gadget, one committed binding target and one intent digest. The fork change generalises the permit
store to `ActionPermits<S>` and adds a second store for viewer assertions:

- `GadgetClient.createViewerAssertion(bindingName, intentHash)`, exposed to the gadget iframe as
  `$createViewerAssertion`, is available to every authenticated viewer (build and use roles) and
  records the viewer's `GadgetViewer` from the authenticated session.
- `ApprovalQueue.consumeViewerAssertion(token, intentHash)` redeems it, only from the committed
  gadget UI caller, and returns that `GadgetViewer`.
- Owner permits and viewer assertions are separate stores, so neither can be redeemed as the other.

What it proves: a specific authenticated viewer asked for this exact operation, input and
idempotency key within the last minute. Gadget code can withhold or delay an assertion, but cannot
forge, replay or re-target one. The gatekeeper holds the viewer only for that call. Tests: the
kernel unit tests (single use, scope, expiry, kind separation, interleaved viewers) and the workerd
suite (interleaved reader and editor on one gadget, replayed and misbound tokens, unknown and
foreign-organisation viewers, reauthorisation at apply time).

Not yet proven: an end-to-end run through the real Workshop with two signed-in browsers, which is
the remaining evidence for the release-blocking identity gate. The per-viewer session alternative
was not built; it would have changed every gadget method signature, and its credential would stay
in the shared facet for the session's lifetime.

Accepted limit: agent turns and hooks have no viewer, so they cannot write through the gadget path.
Automation uses delegated service credentials instead.

### Observers and shared state

`addObserver` admits a viewer only if their own connected account's verifier names a principal in
the same organisation who currently reads the datastore. On every read, observers who have since
lost access are listed in `excludeObservers`, and the Workshop refuses the read if it cannot hide it
from them. Historical materialised state (transcripts, exports) is still governed by the Workshop's
existing observer mechanism; that end-to-end check is outstanding with the identity gate.

### Connect flow

The Records account is created by an Access-verified, same-origin confirmation page rather than by
auto-provisioning. A flow URL opened from a pasted link arrives with `Sec-Fetch-Site` of
`cross-site` or `none` and is refused. This blocks one person completing another person's flow,
which would otherwise link the second person's identity to the first person's Workshop account.

### Outbox hypothesis confirmed

The late-commit scenario in §7 is now a regression test: an uncommitted outbox row is skipped while
a later transaction's row is published, and it is published on the next run after commit.
