# Agentic Wave: a shared place to discuss, decide and act

Written 2026-09-16. Status: product and implementation proposal, not a delivered feature. Grounded in starter commit `843848c` and the checked-out Cloudflare OS fork at `90f05910`. Deployment state is taken from repository records; this document does not claim a fresh production verification.

Read alongside [wave-blueprint.md](wave-blueprint.md), which provides the collaboration foundation, and the [master plan](collaborative-blueprints.md). This proposal extends Wave's product scope and explicitly revises several technical assumptions below. The original plan's September 16 implementation notes remain the starting point for the editor and transport.

## The product

Build **Wave as a shared, evolving work conversation**. People discuss a question, edit a common understanding, invite agents to investigate, compare proposals, record a decision, and follow the resulting work in the same place. Each important conclusion can be traced to the discussion and evidence that produced it.

The whiteboard remains the place to think spatially. Kanban remains the place to track delivery. Wave becomes the place to understand **what we are trying to do, why we chose it, and what needs attention now**.

Google Wave originally combined conversation, concurrent document editing, inline replies and playback. It also had robot extensions; adding a bot alone would not be a new interpretation. The useful 2026-onward development is to make agent work inspectable, scoped, interruptible and connected to human decisions. See Google's [original product description](https://googleblog.blogspot.com/2009/05/?hl=uk) and [Wave API introduction](https://googlewavedev.blogspot.com/2009/05/introducing-google-wave-apis-what-can.html).

The recommended first delivery is an ordinary bundled blueprint, `format.wave`, built in `packages/blueprint-wave`. Use the existing Workshop agent runtime and sharing system. Add platform features only where a tested requirement crosses the gadget boundary.

## What using it feels like

Imagine a Wave called **“How should we onboard our next ten customers?”**

1. Two colleagues write the problem together. One attaches a reference to a whiteboard frame containing the journey map. Replies attach to specific passages, keeping discussion beside its subject.
2. Someone selects the discussion and asks **“Compare these approaches”**. A visible agent job says what it will read and what output it will produce. The first version can perform this through Workshop chat; a later version exposes the same operation inside Wave.
3. The agent contributes a proposal with cited blips, assumptions and unresolved questions. People continue editing while it works. If relevant source text changes, the result is marked as based on an older revision.
4. A colleague challenges an assumption in an inline reply. The agent can revise its proposal without overwriting that discussion.
5. The team records a decision. A frozen decision version contains the chosen approach, rationale, objections, sources and next steps. Later changes supersede this version rather than silently rewriting the historical choice.
6. A follow-up can become a kanban card through an explicitly connected board. Any external action requiring authorization goes through Workshop's existing action review. Wave links the intended action to its eventual receipt.
7. The next morning, **“Catch me up”** shows changed decisions, new evidence, unresolved questions and work needing intervention, with links to the original passages.

This is a proposed end-to-end experience spanning the phases below. The first release delivers collaborative discussion and reviewable agent contributions; connected execution follows.

## The interaction model

The main surface is a readable conversation with editable messages, called *blips* internally. Keep the product vocabulary familiar: **Reply here**, **Ask agent**, **Propose change**, **Record decision**, **Catch up**.

The header holds the question, participants and connection status. The centre holds the conversation. A collapsible side panel shows the current brief, decisions, open questions and agent jobs. On mobile, the panel becomes a separate view. Playback is a deliberate history mode, visually distinct from live editing.

| Object | What the user sees | What makes it useful |
| --- | --- | --- |
| Conversation blip | Editable text with inline replies | Shared authorship and discussion stay together |
| Brief | A concise account of the current understanding | Shows the source revision and whether it needs refreshing |
| Proposal | Suggested text, decision or action, with a diff | Can be accepted, revised or rejected explicitly |
| Decision | A versioned choice with rationale and dissent | Changes preserve the earlier decision |
| Agent job | Task, scope, progress, result and failure state | People can see what is happening and stop accepting its output |
| Artifact reference | A whiteboard, card, document or source link | Preserves a connection to the work's context |
| Activity | Meaningful changes and execution receipts | Helps returning participants find what matters |

Keep the brief derived from the discussion. It is an aid to navigation, not an authority that silently replaces the source. Agents should explicitly distinguish evidence, interpretation and uncertainty. Preserve minority views when summarising a disagreement.

Use thread collapse and a focused reply view to keep deep discussions readable. Offer keyboard navigation, accessible editor labels, visible focus, local undo, and a restrained announcement stream for remote changes. Never announce every remote keystroke to a screen reader.

## Scope and platform fit

The checkout already has shared gadget facets, callback-based RPC, agent-callable gadget methods, model and agent-spawner bindings, Context and Scheduler Gatekeepers, and the format packaging path. The wrapper configures OpenRouter through AI Gateway. Provider configuration does not prove live model availability or suitability; Wave should use the user's configured model and evaluate it on representative tasks.

| Capability | Delivery boundary | Qualification |
| --- | --- | --- |
| Shared rich text, threads, presence, bounded playback | Wave blueprint | New application code using the existing facet and RPC transport |
| Workshop agent reads a thread and creates a proposal | Blueprint RPC plus existing chat | No new agent runtime needed |
| In-Wave agent invocation | Blueprint plus configured agent-spawner binding | Requires a local-platform spike for invocation, return values and restart recovery |
| Context-assisted research | Existing Context connection, explicitly scoped | Context access is not permission to publish private material into a shared Wave |
| Recurring catch-up or follow-up | Existing Scheduler and persistent callback | Fresh registration and hook enablement per workspace |
| References to existing boards and whiteboards | Links first; binding-backed adapters later | A reference grants no access to its target |
| Authenticated authors, approvers and personal unread state | Platform extension | The current gadget interface does not supply verified caller identity |
| External actions | Existing or additional Gatekeeper integration | Approval and execution belong at the capability boundary |
| Cross-Wave inbox/search, private subthreads, federation | Later platform or service work | An ordinary blueprint cannot discover or authorize every workspace |

These boundaries follow the [runtime research](../research/gadget-collaboration-runtime.md), [current blueprint lifecycle](../../cloudflare-os/docs/blueprints.md), [agent-spawner contract](../../cloudflare-os/packages/workshop-backend/src/agent-spawner-binding.txt), and [Scheduler contract](../../cloudflare-os/packages/gatekeeper-scheduler/README.md).

### One Wave per workspace initially

Create a new workspace from the blueprint, then share that workspace with collaborators. Sharing the blueprint itself creates independent instances; it does not connect people to the same conversation.

Workspace sharing includes its gadgets and chat history. For the initial release, one Wave per workspace makes that boundary understandable. Additional board or whiteboard gadgets in the same workspace share its audience. Existing artifacts in other workspaces remain separate and require their own access.

The roles `build` and `use` are Workshop roles. `use` allows interaction with the gadget; it does not mean read-only document access. A typed display name, `participantId`, `senderId` or browser-supplied role cannot establish identity or permission. Presence identities are labels until the platform provides a trusted actor capability.

### A blueprint is enough for the first release

Keep the existing path: sandboxed client → Workshop RPC → Wave gadget facet → private facet storage. Push changes through the callback hub. Agent and integration calls use configured bindings.

The gadget cannot open its own network connection, access the deployment's R2 bucket directly, or assume it has a Queue, Workflow or Durable Object namespace binding. Client libraries must be bundled into `client.js`. Do not introduce a separate WebSocket backend for this first implementation.

Introduce a dedicated service or Gatekeeper when there is a concrete requirement for external event ingestion, large attachments, durable orchestration beyond the available callback path, or an authorized index across workspaces. That is a deployment extension with its own lifecycle and access model. A blueprint cannot silently provision it.

## Agents as contributors

Start with three explicit operations: **Summarise this thread**, **Compare these options**, and **Propose next steps**. They cover a useful working loop and make model quality measurable. A “researcher” or “facilitator” is a task configuration, not a reason to keep a separate agent running continuously.

Each run records a bounded input snapshot, selected blips, source revisions, requested output, configured capability scope, and run status. The default scope is the selected thread plus an explicit brief. Include ancestors needed to interpret replies and disclose omissions if the selection exceeds the input budget. Broader retrieval should be intentional and recorded.

Return a structured proposal with evidence references and a short explanation. Do not request or store private chain-of-thought. Validate returned fields, source IDs, URLs and size limits before displaying or applying them. Treat document text and retrieved material as untrusted task data; a sentence in a blip cannot grant a new binding or authorize an action.

### Two implementation steps

First, let the existing Workshop agent call documented RPC methods to read Wave and add proposal records. This is the smallest useful agentic version and works without embedding another chat application inside the gadget. Direct gadget writes are not automatically protected by the platform's review of code changes; document that distinction in the gadget README.

Then add an optional agent-spawner binding. Its current API has `spawn(title, prompt)` and `spawnCallable(title, prompt)`; the callable variant returns a stub through which a task can return a result. Configure a minimal binding environment. For a summariser, supply a bounded snapshot and accept a returned proposal; it does not need a write-capable Wave or external-service binding. Persist the validated result through Wave's own coordinator. Verify this pattern in the actual sandbox before designing UI around it.

Do not hold the mutation queue while waiting for a model. Commit the run intent, perform the call outside the queue, then validate and commit its result with a run-generation check. A duplicate or late result must not create a second proposal or revive a cancelled run.

### Proposals and concurrent edits

An agent should normally append a contribution or propose a patch. Remove the original plan's delete-all-and-insert `setBlipText` from the normal agent workflow: it can overwrite meaning while humans are typing even if the CRDT remains technically convergent.

A proposal stores its target, base revision, quoted source range, replacement and source references. Acceptance is a server-side operation: check the proposal version and current target before applying a bounded Yjs transaction. For v1, any relevant target revision change makes the proposal stale and requires review or regeneration. Relative anchors locate text; they do not prove the text still means the same thing.

Two concurrent acceptance requests must result in one application. Rejecting a proposal changes its state without changing source text. Accepting it records the before/after versions. In the identity-limited release these are collaborative editing actions with unverified attribution, not authenticated approvals.

### Attention and autonomy

Default to explicit invocation. An agent does not respond to every text delta or automatically trigger another agent. Later subscriptions operate on semantic events such as “decision recorded” or a scheduled occurrence, with cause IDs, deduplication, cooldowns and a bounded chain depth.

Start with one active agent job per Wave, a bounded queue, input/output caps and a per-Wave invocation allowance. Show when a limit prevents a run. These are proposed application controls to implement, not existing guarantees from AI Gateway. Accurate currency budgets need trusted usage and pricing data; until available, label cost estimates and enforce conservative call/token limits.

“Cancel” immediately prevents further result application. The current spawner contract does not expose cancellation, so stopping underlying inference or billing is not guaranteed. Show that distinction. Persist job states such as queued, running, awaiting review, completed, failed, cancelled and outcome unknown. A restart during dispatch must not blindly spawn another paid job; reconcile it or ask for a deliberate retry.

## Decisions and actions have different authority

A recorded team decision captures intent. An execution approval authorizes a specific operation against a resource. Model these separately.

For external work, keep a proposed action description in Wave, then perform approval through the existing Workshop/Gatekeeper surface. Link to a trusted action identifier and receipt where the platform exposes them. If it does not expose a reliable status read, show **“Check execution in Workshop”**; do not infer success from the agent saying “done”.

Bind approval to the exact payload, target resource and proposal version. Recheck authority and preconditions at execution; edits invalidate the earlier approval. Use an idempotency key where the destination supports it. If an external write succeeds but saving its receipt fails, mark the outcome unknown and reconcile before retrying. A local transaction cannot make an external service call atomic.

The first Wave release has no privileged “approve as owner” RPC. A later trusted identity bridge must wrap calls at the Workshop session boundary, expose minimal actor information and enforce allowed operations server-side. Injecting a viewer global into the browser is insufficient. Keep this kernel change separate and test forged actor IDs, revocation and stale sessions.

Even with identity, a builder who can change gadget code can alter the gadget's own history. Wave playback is a collaboration record, not a tamper-proof audit log. External action evidence remains authoritative at the trusted platform or service boundary.

## Whiteboard, kanban and shared context

Begin with a link plus a human-written label and optional excerpt. Preserve the source workspace, gadget and object/frame/card identifier when known. Use a verified platform navigation URL; do not invent a deep-link route the existing tool cannot open.

Later, add explicit adapters using the whiteboard's `getFrame`/`findObjects` and the board's documented API. Render sanitized previews within Wave's DOM, with the source revision and refresh time. The iframe cannot embed another gadget iframe or fetch arbitrary previews. Cross-gadget reads require an actual supported binding; merely knowing an ID is insufficient.

Choose one authoritative owner for each field. A kanban card owns execution status; a Wave decision owns its rationale. Synchronise selected projections using stable source IDs and idempotency keys, with an explicit refresh or tested subscription. Avoid bidirectional full-document mirroring. A deleted or inaccessible artifact should show a broken reference without deleting the conversation around it.

Only bring material into Wave that may be seen by the workspace's entire audience. A cached excerpt can disclose a source even if its link is protected. Recheck access on refresh and account for already copied content when access is revoked. Approved summaries can later be published to Context through an available authorized write path; Context is not Wave's live database or an automatic archive of every discussion.

## State and synchronization

Reuse the hardened [whiteboard package](../../packages/blueprint-whiteboard/README.md): repository seam, callback hub, subscription generations, gated presence, replay IDs, deterministic packer and local-platform harness. Replace the drawing model with a thread model and an editor. Keep one Yjs document per blip and versioned records for structure and workflow state.

Suggested storage layout; this is a proposed contract, not an existing API:

| Record family | Contents |
| --- | --- |
| `meta` | Schema version, title, latest event sequence, retention boundary |
| `blip:<id>` | Parent, relative reply anchor, ordering key, version, deletion state, bounded preview |
| `text:<id>` / `upd:<id>:<seq>` | Compacted Yjs state and incremental updates |
| `event:<seq>` | Server-ordered committed change with provenance references |
| `checkpoint:<seq>:<part>` | Chunked structure and text state needed to replay retained history |
| `proposal:<id>` / `decision:<id>:<version>` | Reviewable suggestions and frozen decision versions |
| `run:<id>` | Scope, revisions, generation, state, result and execution references |
| `artifact:<id>` | Source reference and explicitly permitted cached projection |
| `read:<session>:<blip>` | Best-effort acknowledged event sequence until trusted user identity exists |

Use one commit coordinator for authoritative revisions, event ordering and workflow transitions. Per-blip preparation may be separate, but a text edit racing a delete or proposal acceptance must resolve under the same commit rules. A commit writes the state, event and idempotency result atomically before broadcasting. Build a candidate Y.Doc from authoritative state; validate the merged result before replacing the live cache. A syntactically valid update may still exceed limits or create unsupported document structure.

Yjs handles duplicate and reordered updates, but convergence requires receiving missing changes. Add gap detection and state-vector or full-state resynchronisation. The earlier plan's statement that dropped broadcasts are harmless needs this qualification. Keep V2 encoding consistent end to end, including `updateV2` events; do not feed V1 `update` events into V2 decoders. See [Yjs update semantics](https://docs.yjs.dev/api/document-updates) and the [Yjs V2 API notes](https://github.com/yjs/yjs).

Use a monotonically increasing server sequence for history and unread comparisons. A Yjs state vector is not a single scalar clock. Presence is ephemeral, separately throttled, and never part of the durable event log.

### Correct the older plan before implementation

- Replace integer inline anchors with relative positions consistently. Define a visible fallback to the parent thread when the anchored passage disappears; reject cycles in thread moves.
- Replace the single `history` and `updates:<id>` arrays with bounded records or chunks. Retain the repository's conservative per-value caps and serialization-aware measurement. Current Cloudflare limits differ between SQLite and legacy KV backends, so the observed 128 KiB failure is a constraint to verify on this facet path, not a universal SQLite limit. See [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/).
- Batch text updates adaptively with one in-flight send per client and merge pending updates. The locally measured 45–50 inbound RPC/s is a budget for this pinned gadget path, not a general Cloudflare throughput guarantee. Test three simultaneous typists plus presence and agent results.
- Bound total hydrated Y.Doc memory, decoded content, pending updates, subscriber fan-out and total retained history, as well as individual values. Choose caps from the spike; do not turn the plan's 100 participants into a promise of 100 concurrent typists.
- Prototype the rich-text binding before choosing a hand-written editor. Test IME composition, mobile selection, paste, marks, undo and remote edits; compare a bundled maintained Yjs editor binding if the bespoke version becomes the main risk.
- Treat reload recovery honestly. Acknowledged edits must survive. Unacknowledged edits exist only in memory in this sandbox and may be lost on a forced frame reload. Show “Saving” versus “Saved”, allow copying pending text where possible, and do not promise offline editing or persistent local drafts.

### Playback and retention

Provide two views: a semantic timeline of decisions, proposals and actions, and bounded document playback for inspecting edits. Use server sequence to order commits; timestamps are for display. Playback never invokes an agent or re-executes an action.

Compaction for current text is separate from retention for historical replay. Before trimming updates, persist a consistent checkpoint of structure and all required blip states at a known sequence. Reconstruct from that checkpoint plus retained events. A current Yjs snapshot alone does not preserve every earlier document state, especially after garbage collection. Test playback across edits, deletions, compaction and restarts.

Expose the earliest available history point. Keep accepted decision versions while the Wave exists, subject to explicit deletion policy, and cap raw edit history separately. Deleting content must account for checkpoints, proposal excerpts, exports and cached projections; hiding a blip is not erasure. A later archival service is required for guarantees beyond the gadget's configured retention.

## Proposed application API

Document a small semantic RPC surface for agents and use the same domain rules as the UI. Names below are illustrative and require a contract pass before coding:

```text
getWave({ cursor?, limit? })
getThread({ blipId, cursor?, limit? })
getChanges({ afterSequence, limit? })
getContextSnapshot({ blipIds, maxBytes })
createReply({ parentId, anchor?, text, requestId })
proposeEdit({ targetId, baseRevision, quote, replacement, sources, requestId })
reviewProposal({ proposalId, expectedVersion, decision, requestId })
recordDecision({ proposalId, expectedVersion, rationale, requestId })
getRun({ runId })
getPlayback({ checkpoint, afterSequence, limit? })
```

`reviewProposal` means a local content-review transition; it must not execute external actions. Reads are paginated and return their source revision. Request IDs derive from private session randomness and are checked against their request scope and payload. They prevent accidental replay, not impersonation. Agent return values become proposals through an internal validated path; a public `completeRun({by: "agent"})` method would not establish agent provenance.

Do not add an arbitrary `executeTool` or `fetchUrl` RPC. Capabilities stay in configured bindings and trusted Gatekeepers. The recipe README must explain how Workshop chat reads, appends and proposes without replacing a whole blip.

## Delivery sequence

| Phase | Deliverable | Exit evidence |
| --- | --- | --- |
| 0: Prove the foundations | Binary RPC/storage, editor binding, rate and restart spikes; callable-agent return spike | Measured results in the actual local platform, including failure paths |
| 1: Collaborative Wave | Threads, character-level co-editing, carets, local undo, bounded playback, export | Three clients converge; acknowledged edits survive restart; keyboard and IME flows work |
| 2: Useful agent contributions | Workshop-chat read/proposal RPCs, catch-up, decisions, stale-result handling | A real agent creates a cited proposal while humans edit; acceptance cannot overwrite stale text |
| 3: In-Wave jobs and references | Optional spawner, persisted run state, job limits, artifact adapters | Duplicate/late results fenced; missing bindings degrade clearly; source access tested |
| 4: Trusted execution | Server-enforced actor bridge where needed; action/receipt integration | Spoofed identities fail; approvals bind to payloads; unknown outcomes reconcile safely |
| 5: Persistent assistance | Opt-in schedules and semantic subscriptions | Fresh hooks enabled explicitly; repeated delivery deduplicated; revocation stops admission |

Ship phases 1 and 2 as the first useful agentic Wave. Reserve internal record types for later phases without presenting unfinished controls. Do not carry over the old one-to-two-day estimate to this expanded scope; estimate after the editor and runtime spikes.

Scheduler registration creates a disabled hook; a person enables it in Workshop Connections. Its callbacks can be retried, so use the stable occurrence `runId` to deduplicate work. Templates do not copy enabled schedules. Closed browser tabs must not be the mechanism that keeps recurring agents alive. These lifecycle rules are documented in the [Scheduler README](../../cloudflare-os/packages/gatekeeper-scheduler/README.md).

For packaging, create `formats/wave.gadget` and `formats/wave.json` with stable ID `format.wave` and output `{ id: "wave", noun: "Wave", plural: "Waves", icon: "notebook" }`. The existing `formatBlueprintsDir: "formats"` already selects this directory; keep all current format pairs because it replaces the upstream set. Declare optional agent bindings and support a collaboration-only instance when none are configured.

A blueprint revision changes new instances only. Existing Waves need an explicit code-upgrade process with schema compatibility, data export/backup and recovery testing. A `.gadget` archive contains code, not live Wave data; provide a separate versioned data export and test restoration before relying on it for migration. Preserve the Workshop's service identity and the submodule pin unless a separately reviewed platform change requires an upgrade.

## Acceptance scenario

The release demonstration should follow the onboarding example with three browsers and one actual configured agent. It passes when participants can discuss and co-edit, request a scoped proposal, inspect its evidence, reject a stale edit, accept a current one once, record a decision, return later and understand what changed.

Verify concurrent edit/delete, duplicate requests, dropped text events, restart during save, restart during an agent call, late results after cancellation, and playback after compaction. Include malicious rich text, forged actor fields and prompts asking for unrelated resources. A missing model or connection leaves the conversation fully usable.

Initial responsiveness targets are local typing feedback without a network wait and remote acknowledged edits visible within one second under the measured three-typist load. Treat them as acceptance targets, not benchmark results. Record RPC rates and bytes, queue delay, resync counts and job outcomes without logging document bodies or prompts.

Before production release, run package checks, the convergence harness, local-platform end-to-end tests and the wrapper's `pnpm check`. After deployment, verify with two distinct Access identities and run the real agent scenario. The existing board/whiteboard delivery notes explicitly leave their production multi-identity and agent-chat checks pending; their success must not be assumed for Wave.

The larger product can later add an authorized cross-Wave inbox, attachments, richer previews, search and event ingestion. Its first milestone is concrete: **a team can turn a live discussion into a reviewed decision, with an agent contributing useful work and every important result pointing back to its source.**
