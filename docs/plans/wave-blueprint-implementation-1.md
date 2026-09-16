# Wave, implementation pass 1: review and plan

Written 2026-09-16. Status: implementation plan for the first shippable Wave. Grounded in starter commit `843848c`, the fork pin `90f0591`, and `packages/blueprint-whiteboard` as built and deployed (`format.whiteboard` revision 4).

This document reviews the two existing Wave plans and replaces their delivery details for the first pass:

- [wave-blueprint.md](wave-blueprint.md): the collaboration foundation and the "Start here" notes from the board and whiteboard builds. Its notes on the platform (binary RPC, rate budget, V8 sizes, stub disposal, `connect`, undo, clipboard, forms, accessibility) still apply and are not repeated here.
- [agentic-wave-blueprint.md](agentic-wave-blueprint.md): the product proposal. Its direction is right; its scope is a programme, not a first pass. This document keeps its principles (agent work is scoped, inspectable, reviewable, traceable to sources) and narrows the surface to what one build can ship.

Where this document and either plan disagree, this document wins for pass 1. The [master plan](collaborative-blueprints.md) and [kanban-delivery.md](kanban-delivery.md) still govern the build process.

## Summary

Pass 1 ships one job: **a team turns a live discussion into a recorded decision, with the agent doing the reading, and every agent contribution pointing at the blips it came from.**

The five changes that matter most, each argued below:

1. **Editor: textarea plus `Y.Text`, not a hand-written `contenteditable` binding.** Blips are Markdown. A blip has a rendered read view and an explicit edit mode. Co-editing in edit mode is still character-level with live carets. This removes the riskiest code in both plans and makes paste, IME, mobile selection and undo native problems instead of ours.
2. **Agents: the Workshop chat agent first, then the AI model binding, and the agent spawner deferred.** The three bounded operations (Summarise, Compare options, Propose next steps) are a single `run({prompt, systemPrompt})` call that returns a string. That is easier to cap, time out, validate and reconcile after a restart than a callable spawned agent. The spawner returns in pass 2, where its visible chat thread is the reason to use it.
3. **One record shape for content.** Proposals, decisions and agent output are *blips with a kind*, not four record families. One event log, one commit queue, one playback path. The agentic plan's reserved families (artifact, schedule, receipt) stay out of storage until they have a caller.
4. **Playback from retained update logs, not snapshots.** One storage key per Yjs update, a per-blip base state at the retention boundary, and replay by server sequence. No checkpoint chunks, no reliance on Yjs snapshots surviving garbage collection.
5. **The Wave is legible to a model in one call.** `getWaveMarkdown()` returns the whole conversation as Markdown with blip ids as anchors; `exportMarkdown()` produces a decision record that can be pasted into a chat or committed to a repository. That is the fit with a vibe-coding workflow: the decision lands where the code is.

Recommended in parallel, not on the critical path: the master plan's Phase 0 viewer identity patch. Wave is the tool where anonymous authorship hurts most. Pass 1 consumes `gadgetViewer` when the global exists and falls back to the name dialog when it does not.

## 1. Review of the two plans

### 1.1 User experience

| Area | What the plans say | Problem | Pass 1 |
| --- | --- | --- | --- |
| Editing model | Original: every blip is an always-editable rich-text `contenteditable` bound to a `Y.XmlFragment`. Agentic: prototype the binding first, compare a bundled editor if it becomes the main risk. | Wave's historical failure was that everything was editable and nothing was legible. A hand-written binding for marks, lists and links is the least tested code in the product and the whiteboard build shows that text editing finds its bugs only in the real iframe. | A blip is Markdown. Read view renders it; **Edit** (or `E`, or click) opens a textarea bound to `Y.Text`. Several people can be in edit mode on one blip and see each other's carets. Remote changes update the read view live. |
| Inline replies | Both: a reply anchored at a character position inside the parent. | Character anchors are fiddly to place and read in a textarea, and the agentic plan already needs a fallback when the passage disappears. | **Reply to this paragraph.** The anchor is a Yjs relative position at the start of a paragraph. The reply renders after that paragraph in the read view. If the paragraph is deleted, the reply falls back to the end of the parent with a "was attached to removed text" note. End-of-thread replies remain. |
| Vocabulary | Agentic: Reply here, Ask agent, Propose change, Record decision, Catch up. | "Propose change" is what the agent does, not what a person does. | Four human verbs: **Reply**, **Edit**, **Ask agent**, **Record decision**. Proposals are how agent output arrives. **Catch up** is an Ask agent operation. |
| Side panel | Agentic: brief, decisions, open questions, agent jobs. | Requires a brief record, a question record, a decision record and a run record before anything ships. | Panel tabs: **Decisions**, **Agent**, **People**, **History**. The brief is a pinned root blip of kind `brief`, created by the template. Open questions are ordinary replies until they earn a kind. |
| Unread and catch-up | Original: per-participant read markers. Agentic: an agent-generated catch-up. | No identity in pass 1 and no client storage, so read state is per session and gone on reload. | A **since** marker by server sequence. `N` and `Shift+N` move to the next and previous changed blip (Wave's own gesture). The marker is kept for the session and, across a frame reload, in `window.name`. **Catch up** asks the model to summarise changes since a chosen point: last hour, today, or a point on the History scrubber. It works without identity and becomes per-user when identity lands. |
| Playback | Original: a slider in the header that swaps live docs for replay docs. | A slider beside live controls invites accidental edits into a replayed state. | History is a **mode** with a banner, a scrubber over event sequence, changed blips highlighted, editing disabled, and `Esc` to return. Nothing in playback invokes an agent or applies a change. |
| Agent output | Agentic: proposals with a diff, accept, revise or reject, stale marking. | Right, but the plan treats a summary the same as an edit suggestion; a summary has nothing to accept. | Two shapes. An **agent blip** (kind `agent`) is a reply with sources, shown in a distinct card with **Discard** and **Reply**. A **proposal** (kind `proposal`) targets a blip and carries quote, replacement and base sequence, with **Accept** and **Reject**; it shows "based on an older version" when the target changed. |
| Empty state | Neither plan. | A blank Wave gives a new team nothing to do. | Templates on first open: **Blank**, **Decision**, **Design review**, **Retrospective**, **Incident review**. Each creates a brief blip and two or three prompting root blips. |
| Saving and connection | Whiteboard has a connection chip and self-reload. | Text edits that had not reached the server are lost on a forced reload, and the person has no warning. | A per-blip **Saving / Saved** chip. A wave-level connection chip. Before a self-reload, pending text for the open editor is written to `window.name` (bounded) and offered back after the reload as **Re-insert unsaved text**. |
| Mobile | Mentioned in passing. | | Single column, panel as a bottom sheet, edit mode fills the width, 44 px targets, no hover-only controls. |
| Accessibility | Both list requirements. | The whiteboard's UI review found missing keyboard paths late. | Every action has a keyboard path from day one (section 3.6), and the UI review is part of the gate. |

### 1.2 Outcome effectiveness

The original plan's outcome is "several people can type in one paragraph". That is a demo. The agentic plan's outcome is correct: a discussion becomes a reviewed decision, and agent work is traceable. It sizes that outcome as five phases with proposals, decisions, runs, artifacts, schedules, an actor bridge and an execution receipt model.

Pass 1 keeps the outcome and cuts the machinery:

| Keep | Cut from pass 1 | Why |
| --- | --- | --- |
| Threads, co-editing, presence, bounded history | Cross-Wave inbox, search, private subthreads | Need platform work the gadget cannot do |
| Agent blips and proposals with sources and staleness | Artifact adapters (whiteboard frame previews, board cards) | Links with a label are enough until cross-gadget reads exist |
| Decisions as locked blips that supersede each other | A derived brief record with refresh tracking | The brief is a pinned blip; **Refresh brief** produces a proposal against it |
| Three model operations plus Catch up | Scheduler subscriptions, semantic triggers | Explicit invocation only; nothing runs because text changed |
| Markdown export of the Wave and of decisions | Action and receipt records, an approve-as-owner path | External actions go through Workshop chat and its existing review; Wave stores a link |
| Optional `Model` binding, degrade to collaboration-only | Agent spawner runs | Deferred to pass 2 with a spike |

What makes pass 1 effective in this environment specifically:

- **The chat agent already has everything it needs.** The Workshop agent reaches a gadget through `executeCode` and `env.Wave`. With `getWaveMarkdown`, `reply` and `propose` documented in the gadget README, "summarise this wave", "draft a decision from thread X" and "propose a rewrite of the brief" work on the day the RPC surface exists, before any binding is configured. The board and whiteboard READMEs are the pattern.
- **Blip ids are anchors.** Every read for a model carries `[b_1a2b3c4d5e6f]` style ids and every agent write must cite them. The UI turns citations into links. That is the "traceable to its source" promise in one convention.
- **Decisions leave the tool.** `exportMarkdown({decisions: true})` renders decisions as an architecture-decision-record style document: context, options, decision, rationale, dissent, next steps, with the source blips. Paste it into a chat, a pull request or `docs/decisions/`.
- **Templates encode the loop.** The Decision template seeds "Question", "Options", "Constraints" and a brief. The agent's Compare operation reads exactly that structure.
- **Measure three things** in the acceptance run: a decision was recorded from a thread, a proposal was accepted and a stale one refused, and the exported record was usable without editing.

### 1.3 Technical implementation

| Topic | Original plan | Agentic plan | Pass 1 |
| --- | --- | --- | --- |
| Editor binding | Hand-written `contenteditable` to `Y.XmlFragment` | Prototype first, compare a bundled binding | Textarea to `Y.Text` by diffing the textarea value on `input` (common prefix and suffix), applied as one Yjs transaction with a local origin. About 150 lines including selection restore. Carets from relative positions, drawn over a mirror element. Undo with `Y.UndoManager` tracking the local origin. Paste and IME are native. Markdown rendered in the read view by a small tokenizer that builds DOM nodes, never `innerHTML` with user text. |
| Agent runtime | Chat calls `setBlipText` (delete all and insert) | Chat RPC first, then `spawnCallable` after a spike | Chat RPC first. Then an optional `aiModel` binding named `Model`: `env.Model.run({prompt, systemPrompt})` returns a string. Validate, cap, and commit as an agent blip or proposal. No stub storage, no callable interface, one timeout. Spawner deferred. |
| Storage | `updates:<id>` and `history` arrays | Nine record families with chunked checkpoints | `meta`, `blip:<id>`, `text:<id>`, `base:<id>`, `upd:<id>:<seq>`, `event:<seq>`, `run:<id>`, `req:<sender>` (bounded). Proposals and decisions are fields on `blip:`. Every cap measured with `storedBytes`. |
| Playback | Replay `history` in timestamp order | Checkpoint plus events | Per blip: `base:<id>` at the retention boundary, then `upd:` keys by server sequence. Trimming old updates folds them into `base:` first. The earliest available sequence is exposed and shown. |
| Sync | 50 ms timer; dropped broadcasts harmless | Gap detection and state-vector resync | Adaptive batching (send when idle 80 ms or 1 KiB pending), at most one `pushText` in flight per client, pending updates merged with `Y.mergeUpdatesV2`. Each text event carries the blip's previous and new sequence; a gap triggers `openBlip` with the client's state vector, which returns only the missing diff. |
| Commit rules | Structure via `enqueueMutation`, text via a per-blip queue | A commit coordinator with separate per-blip preparation | One mutation queue for every commit, including text. At the measured 45–50 calls a second, a text commit is far cheaper than the queue overhead of two coordinators. Model calls run outside the queue with a run generation check on commit. |
| Idempotency | Request ids for structure; hash or request id for text | Request ids per scope | Every write, including `pushText`, carries a `requestId` from a per-page secret; replay records match per `senderId` (the whiteboard's fixed design). A replayed text push returns the recorded sequence and is not appended again. |
| Rich-text limits | 64 KiB Yjs state per blip | Bound everything, sized from the spike | 16,000 characters of text and 96 KiB of stored state per blip. A push that would exceed either is refused with `blip_full` and the UI suggests a reply. Interleaved edits fragment Yjs items, which is why the state cap is separate from the character cap. |
| Binary transport | Spike `Uint8Array` first | Same | Same. Fallback is base64 in strings with caps sized for the 4/3 overhead. The harness must pass binary through structured clone so the fallback is exercised only if the platform needs it. |
| Presence | Carets as relative positions | Separately throttled, never in the event log | Through the whiteboard hub unchanged. Payload: `{blipId, editing, anchor, head}` with a 512-byte cap per caret and malformed carets dropped individually. |

## 2. Scope of pass 1

In:

- A Wave with a title, a participant list and a tree of blips: root blips in order, replies at the end of a thread or after a paragraph of the parent.
- Blips are Markdown-lite: paragraphs, headings, bold, italic, inline code, fenced code, links, bullet and numbered lists, block quotes.
- Character-level co-editing of any blip in edit mode, with live carets and "Name is editing" on the blip.
- Blip kinds: `note`, `brief`, `agent`, `proposal`, `decision`. Decisions are locked; recording a new decision in the same thread supersedes the previous one and both remain.
- Since marker, next-changed navigation, History mode with a scrubber and changed-blip highlights.
- Workshop chat access through a documented RPC surface and `getWaveMarkdown`.
- Optional `Model` binding for Summarise, Compare options, Propose next steps, Refresh brief and Catch up. Without it, Ask agent explains how to add a model in Connections and the rest works.
- Markdown export of the Wave and of decisions; HTML and PDF export through the platform's export path renders the read view.
- Templates on first open.
- Phones: single column, bottom sheet, 44 px targets.

Out, with the reason:

- Agent spawner runs (pass 2, after a spike; its visible chat thread is the reason to add it).
- WYSIWYG marks (the read view is rich; editing is Markdown; a richer editor can replace the textarea later without changing `Y.Text`).
- Attachments and images (gadgets have no asset storage).
- Previews of whiteboard frames or board cards (links with a label until cross-gadget reads exist).
- Cross-Wave inbox, search across Waves, per-blip permissions, federation.
- Scheduled or reactive agent runs.
- Verified authorship and approvals (needs the identity patch; pass 1 records unverified names and says so on decisions).

## 3. User experience plan

### 3.1 Layout

```
+------------------------------------------------------------------------------------+
| Wave title (editable)      · 3 here  · Saved   · [Ask agent v] [History] [Export v] |
+----------------------------------------------------------------+-------------------+
| Brief (pinned)                                     Edit  Reply  | Decisions  Agent  |
|  We need to onboard ten customers by November ...               | People  History   |
|                                                                 |                   |
| ▸ Which onboarding approach?               Harry · 2 replies    | Decision 2 (live) |
|   Option A: white-glove ... [b_3f1e]                            |  Chose option B   |
|     ↳ Reply after paragraph 1  Alice: The cost is ...           |  supersedes 1     |
|   Option B: self-serve ...                                      |                   |
|   [Agent] Comparison of A and B    sources: b_3f1e, b_9a02      | Runs              |
|     Evidence ... Interpretation ... Open questions ...          |  Compare · done   |
|     Discard   Reply                                             |  Summarise · run. |
|   [Proposal] Rewrite the brief's second paragraph               |                   |
|     based on version 41 · current 41    Accept  Reject  Reply   |                   |
|   [Decision] We choose option B · recorded by Alice (unverified)|                   |
|   + Reply to this thread                                        |                   |
+----------------------------------------------------------------+-------------------+
```

- Header: title, presence avatars, save state, Ask agent menu, History toggle, Export menu.
- Centre: root blips as cards in order; replies indented one level; deeper levels collapse to "N more replies". A focused-thread view (`Enter` on a thread, or **Focus**) shows one thread full width with a back link.
- Right panel: Decisions (list, latest first, with supersedes chain), Agent (runs and their states, with Cancel and Retry), People (who is here, who is editing what, name and colour dialog), History (scrubber, earliest available point, changed-blip list). On phones the panel is a bottom sheet opened from a tab bar.

### 3.2 Objects as the person sees them

| Kind | Card | Actions |
| --- | --- | --- |
| `note` | Author, time, rendered Markdown, "edited by N" when others touched it | Reply (end), Reply after paragraph (gutter button on hover or focus), Edit, Delete (soft) |
| `brief` | Pinned at the top, labelled Brief | Edit, Ask agent → Refresh brief |
| `agent` | Tinted card, robot badge, operation name, "sources: b_…" as links, sections Evidence, Interpretation, Open questions | Discard, Reply, Show run (scope, sizes, timing) |
| `proposal` | Tinted card, "Proposal for [target]", quote and replacement as a two-column or stacked diff, based-on and current version chips; a **stale** chip when they differ | Accept (disabled when stale, with "Regenerate" instead), Reject, Reply |
| `decision` | Framed card, "Decision N", recorded-by and time, locked icon, "supersedes Decision N-1" link | Reply, Record new decision, Export |

### 3.3 Key flows

**Read.** Open the Wave; the since marker sits after the last blip you saw in this session. `N` jumps to the next changed blip and scrolls it into view with a brief highlight. `J` and `K` move between blips, `Enter` focuses a thread, `Esc` returns.

**Reply.** `R` or the Reply button opens a composer at the end of the thread. Typing in the composer creates the blip on the first keystroke (so others see "Alice is writing a reply"), not on submit. `Ctrl+Enter` or **Done** closes the composer. An empty blip is removed when closed. **Reply after paragraph** appears in the gutter of each paragraph in read view.

**Edit.** `E`, click in the text, or **Edit** opens the textarea in place with the same width and font as the read view, so nothing jumps. Others' carets appear as coloured bars with name tags. `Esc` or **Done** returns to the read view. Remote changes arriving during IME composition are applied after `compositionend`.

**Ask agent.** Select a thread (or nothing, for the whole Wave), open Ask agent, choose Summarise, Compare options, Propose next steps, Refresh brief or Catch up, optionally add one line of instructions. A run card appears in the Agent tab with its scope: which blips, how many bytes, whether anything was omitted for the input cap. The result arrives as an agent blip or proposal at the end of the thread. If no model is configured, the menu explains where to add one and the operation is disabled.

**Review a proposal.** Accept applies the replacement to the target in one transaction and records who accepted it. If the target changed since the proposal was made, Accept is replaced by Regenerate; the person can still reject or reply. Two people accepting at once results in one application and one "already applied" notice.

**Record a decision.** From a thread, **Record decision** opens a dialog prefilled from the thread's brief and any accepted proposal: decision, rationale, dissent, next steps. Recording creates a locked decision blip at the end of the thread and lists it in the Decisions tab. Editing a decision is not possible; **Record new decision** creates a successor with a supersedes link.

**Catch up.** Choose "since last hour", "since today", or "since here" on the History scrubber. The model receives only changes since that sequence and returns changed decisions, new agent output, open questions and threads with the most activity, each with blip links. The result shows in the Agent tab with **Post to wave** if it is worth sharing.

**History.** Toggle History; a banner says "Viewing history · editing off"; drag the scrubber or step by event with arrow keys; changed blips highlight; the earliest available point is marked. Blips whose history was trimmed show "history from version N".

**Export.** Markdown (whole Wave, or decisions only), HTML and PDF through the platform's export path.

### 3.4 Presence

Header avatars show who is here. A blip shows "Alice is editing" while Alice's presence has `editing: true` on it, and her caret only when the viewer is also in edit mode on that blip. Carets and editing chips expire on the whiteboard's timers (12 s without a heartbeat).

### 3.5 Wording

Say **Saved**, **Saving…**, **Reconnecting…**, **Reloading to reconnect…**. Say **unverified** next to a recorded-by name until identity exists. Say **based on an older version** rather than "stale". Say **Discard** for agent output and **Reject** for proposals. Never say "AI thinks"; agent cards label **Evidence**, **Interpretation** and **Open questions** because the prompt asks the model to separate them.

### 3.6 Keyboard and accessibility

- Every blip card is a focusable `article` with `aria-label` "Reply by Alice, 3 minutes ago" and a roving tabindex within the conversation; `J`/`K`, `N`/`Shift+N`, `R`, `E`, `Enter`, `Esc`, `Delete` as above; `Ctrl+Enter` closes a composer.
- Toolbars and the panel tabs use roving tabindex; `Tab` moves between the conversation, the header and the panel; `Esc` closes the panel on phones.
- `Ctrl/Cmd+Z`, `Shift+Z` and `Y` are intercepted in a capture-phase `keydown` both inside the editor (routed to `Y.UndoManager`) and outside it (ignored), for the reasons in the whiteboard notes.
- Focus is restored to the card after Done, Delete, Accept, Reject and dialog close.
- Remote changes are announced through one polite live region, rate-limited to one message per two seconds and never per keystroke: "Alice edited the brief", "New reply from the agent in Which onboarding approach".
- Visible `outline` focus rings, 44 px targets on phones, no `<form>`, no `alert`, no `confirm`, no `localStorage`.
- Markdown links render with `rel="noopener"`; whether the sandbox allows opening them is a spike item (section 5.1). If it does not, links show their URL and a **Select URL** action that selects the text for a native copy.

## 4. Technical plan

### 4.1 Package

`packages/blueprint-wave`, started as a copy of `packages/blueprint-whiteboard` per the "Start here" notes. Delete the whiteboard core, model, geometry, render, simplify and canvas UI. Keep the hub, repository seam, sync store, protocol helpers, harness, e2e helpers, scripts and the fuzz network.

```
src/shared/protocol.js        types, limits, sanitisers, event shapes, storedBytes   (contract)
src/shared/markdown.js        tokenizer → node tree; used by the read view and the export
src/shared/order.js           fractional keys for root and reply ordering (kept)
src/core/wave.js              rules: blips, text commits, proposals, decisions, events, retention
src/core/runs.js              agent run state machine, prompt building, output validation
src/core/hub.js               kept; cleanPresence replaced for carets
src/core/repository.js        kept; adds prefix listing for upd:/event: and batched deletes
src/server/index.js           Gadget DO: RPC surface, mutation queue, Y.Doc cache, model calls
src/server/do-repository.js   kept
src/client/sync/store.js      structure channel (kept) plus the text channel
src/client/sync/text.js       per-blip Y.Doc, batching, gap detection, resync
src/client/editor/binding.js  textarea ↔ Y.Text, selection restore, IME deferral, undo
src/client/editor/carets.js   relative-position carets over a mirror element
src/client/ui/*.js            conversation, blip card, composer, panel, dialogs, history, export, styles
src/client/ui/ui-contract.js  the interface between conversation and shell (two UI streams)
src/client/main.js
harness/                      fake server over the real core, with a fake Model binding
e2e/                          harness and local-platform suites
scripts/                      build, pack (formats/wave.*), archive
```

`yjs` 13.6.31 is a devDependency bundled by esbuild into both `dist/server.js` and `dist/client.js`. The client never imports anything at runtime.

### 4.2 Editor binding

- Local edits: on `input`, diff `previous` against `textarea.value` by common prefix and suffix (with a guard for the case where both sides changed, which yields one delete and one insert), then `ytext.delete` and `ytext.insert` inside `doc.transact(fn, LOCAL)`.
- Remote updates: `ytext.observe` with origin other than `LOCAL`: convert the current selection to relative positions, set `textarea.value = ytext.toString()`, restore the selection from the relative positions. If a composition is in progress, queue and apply on `compositionend`.
- Undo: one `Y.UndoManager` per open blip with `trackedOrigins: new Set([LOCAL])` and `captureTimeout: 500`. The editor handles the keys itself; the capture-phase interceptor keeps the browser's native undo out.
- Carets: presence carries `{blipId, editing, anchor, head}` where anchor and head are `Y.encodeRelativePosition` bytes (or base64 if the binary spike fails). A mirror `div` with the textarea's computed font, padding, width and `white-space: pre-wrap` locates a caret by inserting a marker span at the absolute index. Recomputed on remote update, scroll and resize, at most once per animation frame.
- Read view: `markdown.js` produces a node tree; the client builds elements from it. Autolink `b_` ids to blips. Unknown or unsafe URL schemes render as text.
- Composer and editor are the same component; a composer is an editor on a blip created on the first keystroke.

### 4.3 Data model

Storage keys, all values sized by `storedBytes`:

| Key | Holds |
| --- | --- |
| `meta` | `{schemaVersion, seq, title, rootOrder: [id], participants: [{id, name, color}], earliestSeq, lastModified, template}` |
| `blip:<id>` | `{id, parentId, anchor, kind, order, by, createdAt, updatedAt, version, textSeq, deleted, locked, preview, proposal?, decision?, runId?}` |
| `text:<id>` | Compacted `Y.Text` state (V2) as of `textSeq`, used to hydrate |
| `base:<id>` | `{seq, state}`: the earliest state playback can start from for this blip |
| `upd:<id>:<seq>` | One Yjs V2 update, `{by, at, update}`; `seq` is the global event sequence, zero-padded for prefix order |
| `event:<seq>` | `{seq, at, by, kind, blipId?, runId?, bytes?, detail?}` |
| `run:<id>` | `{id, op, by, scope: {blipIds, sinceSeq, snapshotSeq, inputBytes, omitted}, state, generation, createdAt, startedAt?, finishedAt?, error?, resultBlipId?, result?}` |
| `req:<senderId>` | Bounded list of `{requestId, outcome}` for replay |

Field notes:

- `anchor` is `{type: "end"}` or `{type: "para", pos: <relative position bytes>}`.
- `kind` is `note | brief | agent | proposal | decision`.
- `proposal` is `{targetId, baseSeq, quote, replacement, summary, sources, state: review | accepted | rejected | stale, reviewedBy?, reviewedAt?}`.
- `decision` is `{supersedes?, supersededBy?, recordedBy, recordedAt, rationale, dissent, nextSteps}`; the blip's text is the decision statement.
- `preview` is the first 200 characters, refreshed on compaction and on every commit that changes the first paragraph, so `getWave()` can render a collapsed thread without opening text.
- `seq` in `meta` is the global, monotonically increasing event sequence. Unread, ordering, gap detection and playback use it. Timestamps are for display only.

Compaction and retention, both inside the mutation queue:

- After 100 updates or 64 KiB of `upd:` since `textSeq`, rewrite `text:<id>` from the cached doc and set `textSeq`. Updates are not deleted by compaction.
- When a blip's retained updates exceed 256 KiB, or the Wave's exceed 4 MiB, trim the oldest updates of the largest blips: apply them to a scratch doc hydrated from the previous `base:`, write the new `base:`, delete the keys, raise `meta.earliestSeq` if no earlier update remains anywhere. Everything the trimmed updates said is in the new base, so hydration and playback stay correct.
- Soft-deleted blips keep their text until an explicit **Delete permanently** (later pass). Pass 1 hides; it does not erase.

Events cover `blip.create`, `blip.delete`, `blip.restore`, `blip.move`, `text` (with `bytes`), `proposal.accept`, `proposal.reject`, `decision.record`, `run.queued`, `run.started`, `run.done`, `run.failed`, `run.cancelled`, `run.unknown`, `structure`. Retain 5,000 events or 1 MiB, whichever comes first; older ones are dropped and `earliestSeq` moves.

### 4.4 RPC surface

Names avoid `connect` and `fetch`. All writes carry `senderId`, `by` and `requestId`. Reads return the current `seq`.

```
// Reads
getWave()                                       -> { meta, blips, seq }                     (no text; previews only)
getThread({ rootId })                           -> { blips, seq }
getWaveMarkdown({ sinceSeq?, threadId? })       -> string   blip ids as anchors, kinds labelled, sizes capped
openBlip({ blipId, stateVector? })              -> { update, seq, textSeq }                 (full state, or the diff since stateVector)
getChanges({ afterSeq, limit? })                -> { events, seq }
getPlayback({ blipId, fromSeq?, toSeq? })       -> { base: {seq, state}, updates: [{seq, at, by, update}] }
getRun({ runId })                               -> run

// Text
pushText({ senderId, blipId, update, requestId })      -> { seq, textSeq } | { error: "blip_full" | "locked" | "unknown_blip" }

// Structure and content
applyOperation({ senderId, by, requestId, blipOps?, structure?, participantOps? })
                                                -> { status, seq, upserts, deletes, conflicts, errors, duplicate? }
   blipOps: create {blipId, parentId, anchor, kind, order?, text?} | delete | restore | move {parentId, anchor, order} — each with baseVersion
reply({ parentId, text, anchor?, by, requestId })            -> { blip }         (agent-friendly create; seeds Y.Text with text)
propose({ targetId, quote, replacement, summary, sources, by, requestId })
                                                            -> { blip }         (a proposal reply under the target's thread; baseSeq read now)
reviewProposal({ proposalId, decision: "accept"|"reject", expectedVersion, by, requestId })
                                                            -> { status: "applied"|"rejected"|"stale"|"conflict", blip }
recordDecision({ threadId, text, rationale, dissent?, nextSteps?, supersedes?, by, requestId })
                                                            -> { blip }
askAgent({ op, blipIds?, sinceSeq?, instructions?, by, requestId })
                                                            -> { run } | { error: "no_model" | "busy" | "limit" }
cancelRun({ runId, requestId })                              -> { run }
markRead({ session, seq })                                   -> {}
exportMarkdown({ decisions?: boolean })                      -> string

// Live
subscribe(callback, { clientId, name, color, session? })     -> snapshot + session
updatePresence({ clientId, session, name, color, blipId?, editing?, anchor?, head? })  -> { known, seq }
leavePresence(clientId, session)
```

Events to subscribers: `callback.operation(event)` for committed changes (`{type: "operation", seq, upserts, deletes, events}`), `callback.text(events)` as an array of `{blipId, senderId, seq, prevTextSeq, update}` coalesced per receiver, and `callback.presence(events)` unchanged from the whiteboard.

`reviewProposal` is a content transition only. There is no `executeTool`, no `fetchUrl`, and no method that accepts an actor claim it cannot check. `by` is a display label in pass 1 and the README says so.

### 4.5 Sync

- **Structure** uses the whiteboard store unchanged: subscription generations, verbatim replay, heartbeat restart detection, self-reload on a dead stub.
- **Text** per open blip: a local `Y.Doc`, `doc.on("updateV2")` queues bytes; the sender merges the queue with `Y.mergeUpdatesV2` and sends when idle for 80 ms or when 1 KiB is pending, with at most one `pushText` in flight per client across all blips (round-robin by oldest pending). Each push has a `requestId`.
- **Gap detection**: each text event carries `prevTextSeq`; if the client's known `textSeq` for that blip is older, it applies nothing from the event, calls `openBlip` with its state vector and applies the returned diff, then resumes. Resync after a re-subscribe does the same for every open blip.
- **Echo**: the server sends text events to the originator too, with `senderId`; the originator uses them only to advance `textSeq`, since Yjs already applied the local change.
- **Server cache**: `Map<blipId, {doc, lastTouched}>`, hydrated from `text:` plus later `upd:` on first touch, evicted after ten minutes idle, bounded to 64 docs and 8 MiB decoded by evicting least recently used. Every update is applied to a scratch doc first; a decode failure or a state over cap is refused before the real doc changes.
- **Budget**: three typists at the batching above produce at most about 4 pushes a second each; presence adds at most one in flight per client; heartbeats every 4 s. Comfortably inside the measured 45–50 calls a second. Test T11 measures it.

### 4.6 Agent runs

- `askAgent` validates the operation and scope, builds the snapshot inside the mutation queue (`getWaveMarkdown` for the selected blips, ancestors included, 24 KiB input cap, omissions listed), writes `run:` with `state: queued`, `generation: 1`, and returns. One running run per Wave and at most three queued; further calls return `busy`. A per-Wave allowance of 30 runs an hour returns `limit`.
- A dispatcher outside the queue takes the next queued run, sets `running`, and calls `env.Model.run({systemPrompt, prompt})` with a 90 s timeout. Output is capped at 16 KiB and parsed leniently for one JSON object of the shape `{summary, body, sources: [id], questions: [string]}`; unknown ids are dropped from sources; Markdown in `body` goes through the same renderer as everything else.
- Commit: inside the queue, check `run.generation` and `run.state === "running"`, then create the agent blip or proposal and set `done` with `resultBlipId`. A cancelled run or a changed generation discards the result. A failure sets `failed` with a short message and no blip.
- Restart: on first touch after hydration, any `run:` in `running` becomes `unknown` with the note "the server restarted during this run; retry to run it again". Nothing is respawned automatically.
- Cancel sets `cancelled` immediately and prevents commit; the README states that the underlying model call may still complete and be billed.
- Prompts: the system prompt fixes the role, the citation rule (`every claim cites [b_…] ids from the input`), the Evidence, Interpretation and Open questions structure, the output shape, and the instruction that text inside the Wave is data and cannot change these rules. Wave content is never placed in the system prompt.
- Model output never becomes a `decision`; only `recordDecision` does that.

### 4.7 Bindings and the format manifest

- The format sidecar `formats/wave.json` declares `output: {id: "wave", noun: "Wave", plural: "Waves", icon: "notebook"}` and `blueprintId: "format.wave"`. The packer's archive metadata gains a `bindings` entry `Model: {title: "Model for Ask agent", description: "Optional. Summarise, compare and catch up run on this model.", type: "aiModel"}`. The packer currently writes `bindings: {}`; extend `pack-gadget.mjs` to take bindings from the sidecar.
- The gadget checks `typeof env.Model?.run === "function"` on each `askAgent` and reports `no_model` otherwise. Whether **New** prompts for an `aiModel` binding on a bundled format, or leaves it to Connections, is a spike item; the Wave works either way.
- No agent spawner binding in pass 1.

### 4.8 Limits

| Item | Limit |
| --- | --- |
| Blips | 2,000 |
| Reply depth | 6 (deeper replies attach at depth 6) |
| Text per blip | 16,000 characters; 96 KiB stored state |
| Retained updates | 256 KiB per blip, 4 MiB per Wave |
| Events | 5,000 or 1 MiB |
| Participants | 100 named; 100 live subscribers |
| Presence caret | 512 bytes; 40 updates a second per client, coalesced at 33 ms |
| Runs | 1 running, 3 queued, 30 an hour, 24 KiB in, 16 KiB out, 90 s |
| Proposal quote and replacement | 8 KiB each |
| Decision fields | 4 KiB each |
| Export | 2 MiB of Markdown |

### 4.9 Validation and safety

- Every RPC argument is validated by shape and size; ids by regex (`b_`, `r_`, `h_` plus 12 hex); relative positions decoded with Yjs' own parser and re-encoded.
- Updates are applied to a scratch doc before the real one. A blip over cap refuses further pushes and says so.
- `Y.Text` content is plain text; the only rendering path is the shared Markdown renderer, which builds nodes and allows `http`, `https` and `mailto` links only.
- The server does not trust `by`, `senderId` or a typed name for anything but labels and replay matching. The README says decisions and reviews carry unverified names until the platform supplies identity.
- Model output is untrusted: capped, parsed, validated, rendered through the same renderer, and never allowed to name a binding or trigger another run.
- Logs record sequences, sizes, run states and timings; never blip text or prompts.
- `callback.dup()` stubs are disposed exactly once on replace, leave and drop, as in the whiteboard hub.

## 5. Implementation plan

The process is the kanban and whiteboard one: spikes, one contract author, parallel streams with disjoint files, read-only reviews with repro scripts, fix agents, local platform end-to-end, pack, deploy. Estimate for pass 1: two to three days with parallel agents, plus one day for the identity patch if taken.

### 5.1 Phase 0: spikes (half a day, one agent on one local platform)

A throwaway gadget on the local Cloudflare OS, following `e2e/start-local-platform.sh`, checks:

1. `Uint8Array` round-trips browser → Workshop → facet and facet → callback → browser with its type intact, and comes back from storage as `Uint8Array`. If not, base64.
2. A textarea bound to `Y.Text` inside the real sandboxed iframe: typing, IME composition (a CJK input source or the Playwright composition events), paste, mobile emulation selection, and a remote update during composition.
3. Whether a Markdown link can be opened from the iframe, and what `target="_blank"` does under the sandbox flags.
4. `env.Model.run` from a facet with a configured OpenRouter model: latency, output size, behaviour on a 90 s timeout, and what happens when the binding is absent. Also what **New** does for a bundled format whose archive declares an `aiModel` binding.
5. Rate: three browsers typing continuously in one blip with adaptive batching; record calls a second, median remote latency and any queue growth.
6. Whether `gadgetViewer` exists (it will not on this pin; the check documents the fallback path).

Exit: a short write-up in the package README's "Measured" section, with numbers.

### 5.2 Phase 1: contract (3 hours, one author)

`protocol.js` (types, limits, sanitisers, event and presence shapes), `markdown.js` (tokenizer and node tree, with tests), `store-contract.js` (structure plus text channel), `ui-contract.js` (conversation ↔ shell), the `Repository` additions, the gadget README's programmatic section with the RPC surface from section 4.4, and the harness's fake Model interface. No stream starts before the contract is committed.

### 5.3 Phase 2: parallel streams (a day)

| Stream | Owns | Delivers |
| --- | --- | --- |
| A: core and server | `src/core/wave.js`, `src/core/runs.js`, `src/server/*`, `test/core`, `test/server` | Commit rules, compaction and retention, proposals, decisions, events, run state machine, Y.Doc cache, RPC surface, workerd tests |
| B: client sync and editor | `src/client/sync/*`, `src/client/editor/*`, `test/client/{store,text,binding,fuzz}` | Text channel, batching, gap resync, textarea binding, carets, undo; the network fuzz extended with text operations |
| C1: conversation UI | `src/client/ui/{conversation,blip,composer,keymap}.js` | Cards, threads, focus view, paragraph replies, edit mode integration, keyboard navigation, live region |
| C2: shell | `src/client/ui/{app,header,panel,dialogs,history,export,templates,styles}.js`, `src/client/main.js` | Layout, panel tabs, Ask agent menu, run cards, decision dialog, History mode, export, templates, phone layout |
| D: tooling and harness | `harness/*`, `scripts/*`, `e2e/harness.test.mjs`, `formats/wave.json` | Binary through structured clone, fake Model with ok/slow/fail/garbage modes, "restart mid-run" control, packer bindings support |

The orchestrator runs integration between streams and owns `package.json`, the vitest configs and the build script.

### 5.4 Phase 3: reviews (3 hours, three read-only reviewers)

- **Server safety**: caps by `storedBytes`, scratch-doc validation, replay records per sender, proposal acceptance races, run generation and restart handling, prompt-injection attempts through blip text, Markdown renderer with hostile input, stub disposal.
- **Sync correctness**: the widened fuzz (`SEEDS=1..20 STEPS=1500 MAXLAT=120 FIFO=0`) with text operations, gap resync under reorder, restart during a push, compaction and trimming during typing, playback equals the live text at every step.
- **UI and accessibility**: every flow in 3.3 by keyboard only, screen-reader labels, focus restoration, phone layout at 360 px, reduced motion, History mode cannot edit.

Each finding comes with a runnable repro in the scratchpad.

### 5.5 Phase 4: fixes (half a day, disjoint owners)

Fix agents turn each repro into a regression test in the owning stream's test directory.

### 5.6 Phase 5: local platform end-to-end (half a day)

`e2e/platform.test.mjs` against a local Cloudflare OS, with evidence screenshots and the platform log scanned for stub warnings and runtime crashes:

| Test | Passes when |
| --- | --- |
| T0 | The shipped client boots; the name dialog joins by button and by Enter; no blocked form submissions |
| T1 | Alice and Bob type interleaved words in one blip; both end with identical text |
| T2 | Bob's caret is visible in Alice's editor and stays on the right character while Alice types above it |
| T3 | Alice replies after paragraph 2; Bob sees it at the same paragraph after editing paragraph 1 |
| T4 | Alice reloads mid-typing; acknowledged text is intact; pending text is offered back |
| T5 | History replays a session in order; the scrubber's final state equals the live text |
| T6 | Carol's tab dies; her caret and editing chip vanish within 15 s |
| T7 | A 15,000-character blip stays responsive; each push is small (bytes, not the document) |
| T8 | Alice edits `server.js`; Bob's frame recovers and both keep syncing; no divergence |
| T9 | Workshop chat: "summarise this wave as a reply" creates an agent blip live through `env.Wave` |
| T10 | Ask agent with a configured model creates an agent blip with valid sources; a proposal against a since-edited blip shows stale and refuses Accept; a double Accept applies once |
| T11 | Three typists for 30 s: calls a second under budget, remote text visible within one second |
| T12 | Ten frame reloads and server churn: no stub warnings except around a code-edit restart, no crash |
| T13 | A `use`-role window has no Share or Code tab and can edit, reply and review |
| T14 | Markdown export of decisions contains the decision, rationale, dissent and source ids |
| T15 | A restart during a model call leaves the run `unknown` with Retry; nothing respawns |

### 5.7 Phase 6: pack and deploy

`pnpm --filter blueprint-wave pack:gadget`, commit `formats/wave.gadget` and `formats/wave.json`, run `pnpm check`, then `pnpm deploy` when asked. Update the bundled-formats memory after the deploy.

Harry's checklist after deploy:

1. **New** offers Wave; create one; pick a template.
2. Add the `Model` binding in Connections if **New** did not ask; run Summarise on the template's prompts.
3. With a second Access identity: T1, T2, T9 and T10 on production.
4. Optionally publish a blueprint with a screenshot.

### 5.8 Risks

| Risk | Handling |
| --- | --- |
| Binary RPC fails on one hop | Base64 fallback, caps sized 4/3; the spike decides before the contract |
| Textarea selection restore fights IME on mobile | Defer remote application during composition; T2 and the spike cover it; a "reload to resync" is the last resort and is logged |
| Model output ignores the schema | Lenient parse then validation; a failed parse becomes a `failed` run with the raw text shown in the run card, never a blip |
| Yjs state fragments past the cap on a hot blip | Compaction rewrites `text:` from a fresh encode, which merges runs; the character cap keeps the ceiling honest |
| Retention trimming during heavy typing stalls the queue | Trim at most one blip per commit and bound the scratch replay at 256 KiB |
| Identity patch slips | Nothing in pass 1 depends on it; labels say unverified |
| The old plan's one-to-two-day estimate | Re-estimated at two to three days after the spikes; agent scope is the cut, not the editor |

## 6. Decisions taken here and open questions

Taken:

- Markdown blips with a textarea editor, rather than rich text with a hand-written binding.
- The AI model binding, rather than the agent spawner, for the first agent operations; chat RPC before either.
- Proposals, decisions and agent output as blip kinds; no separate record families in pass 1.
- Playback from retained updates with a per-blip base; no checkpoint chunks.
- One mutation queue; model calls outside it with generation checks.
- Paragraph-level reply anchors, with an end-of-parent fallback.
- Templates and Markdown export are in scope; artifact adapters, schedules and receipts are not.

Open until the spike answers:

- Binary transport on this pin.
- Link opening from the sandbox.
- Whether **New** prompts for an `aiModel` binding on a bundled format.
- Measured typing throughput with three clients, which sets the batching constants.

Open for the person deciding:

- Whether to run the identity patch alongside this build. Recommended: yes, as a separate stream on the fork, so Wave ships with real names where the platform allows.
- Pass 2 candidates, in order: agent spawner runs with the visible chat thread, whiteboard frame and board card references with sanitised previews, a richer editor over the same `Y.Text`, and scheduled catch-ups through the Scheduler Gatekeeper.
