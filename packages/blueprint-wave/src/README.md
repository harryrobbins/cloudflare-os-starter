# Wave

A live, threaded conversation where every message ("blip") is a shared document. Several people can type in the same blip at the same time and see each other's carets; replies go at the end of a thread or after a particular paragraph; an optional AI model summarises, compares options, proposes next steps, refreshes the brief and catches you up; and a discussion ends as a recorded decision that can be exported as Markdown.

This gadget is built from `packages/blueprint-wave` in the deployment's starter repository. **Edits made here in the code editor are not carried back to that source.** To change the Wave for everyone, change the source and ship a new format revision.

## Using the Wave

<!-- C2: complete. Keep the order of this outline; expand each bullet into the same style as the whiteboard README (what it is, how to do it by mouse, touch and keyboard). -->

- **First open and templates**: nobody is asked for a name; the template picker (Blank, Decision, Design review, Retrospective, Incident review) creates a pinned brief and two to four starter threads. Whoever picks first wins; everyone else sees the result.
- **Reading**: root blips as cards in order, replies indented one level, deeper levels collapsed to "N more replies"; `J`/`K` move between blips, `Enter` focuses a thread full width, `Esc` returns; blip ids in text are links.
- **Since marker and catching up**: changed blips carry a dot; `N`/`Shift+N` jump to the next and previous changed blip. The marker is per session (kept across a self-reload). **Ask agent → Catch up** summarises changes since last hour, today, or a point on the History scrubber.
- **Reply**: `R` or **Reply** opens a composer at the end of the thread; the blip exists from the first keystroke so others see it being written; `Ctrl+Enter` or **Done** closes it; an empty composer is removed. **Reply after paragraph** is the gutter button on each paragraph.
- **Your name** is your account's display name: your caret, the blips you write, your reviews, your decisions and your History entries carry it. Nobody is asked for a name. Click your avatar at the top (or **Change colour** in the **People** tab) to change your colour; it is kept across a reload of the Wave.
- **Edit**: `E`, a click in the text, or **Edit** opens a textarea in place; others' carets show as coloured bars with names; `Esc` or **Done** returns to the read view. Markdown-lite: paragraphs, `#`/`##`/`###` headings, `**bold**`, `*italic*`, `` `code` ``, fenced code, `[text](https://…)` links, bullet and numbered lists, `>` quotes.
- **Saving and connection**: per-blip **Saved** / **Saving…** chip; wave-level **Reconnecting…** / **Reloading to reconnect…** (a self-reload keeps your colour and comes back under the same account name); unsaved text is offered back after a reload of the frame (a self-reload or a manual one) as **Re-insert unsaved text**, which restores only the edits the Wave never saved, once, in their place among everyone's later edits (text that did reach the Wave is not repeated). If that is not possible, the whole text is shown to copy instead.
- **Ask agent**: Summarise, Compare options, Propose next steps, Refresh brief, Catch up; scope is the focused thread or the whole Wave; one optional line of instructions; runs and their state (with Cancel and Retry) in the **Agent** tab. Without a configured model the menu says where to add one (Connections → `Model`).
- **Agent output and proposals**: agent cards show Evidence, Interpretation and Open questions with source links, and offer **Discard** and **Reply**. Proposal cards show the quoted passage and the replacement with **Accept** and **Reject**; a proposal **based on an older version** cannot be accepted, only regenerated.
- **Record decision**: from a thread, a dialog prefilled from the brief and any accepted proposal: decision, rationale, dissent, next steps. Decisions are locked; a new one supersedes the old and both remain, listed in the **Decisions** tab. They carry the account name of whoever recorded them.
- **History**: a mode with a banner ("Viewing history · editing off"), a scrubber over the event sequence, changed blips highlighted, arrow keys step by event, `Esc` returns; the earliest available point is marked.
- **People**: who is here (by account name), who is editing what, and your colour.
- **Export**: Markdown of the whole Wave or of the decisions only; HTML and PDF through the platform's export.
- **Phones and tablets**: single column, panel as a bottom sheet, 44 px targets, no hover-only controls.
- **Keyboard and accessibility**: every action has a keyboard path; focus rings; one polite live region for others' changes.

## Programmatic use

Call these from `executeCode` through the gadget's binding (for example `env.Wave`). All methods are on the `Gadget` Durable Object.

**Change the Wave through these methods, never by editing this gadget's code.**

### The short version, for chat

```js
// Read the whole conversation as Markdown. Every blip is headed by its id, kind and author, so
// the text can be quoted back and cited: "[b_1a2b3c4d5e6f]" is an anchor.
const md = await env.Wave.getWaveMarkdown();
// Only what changed since an event sequence, or only one thread:
const recent = await env.Wave.getWaveMarkdown({ sinceSeq: 120 });
const thread = await env.Wave.getWaveMarkdown({ threadId: "b_1a2b3c4d5e6f" });

// Reply at the end of a thread (or under any blip). Cite the blips you drew on with their ids.
const { blip } = await env.Wave.reply({
  parentId: "b_1a2b3c4d5e6f",
  text: "Summary of the options so far:\n\n- Option A (b_3f1e2d4c5b6a) is cheaper …",
  by: "Assistant",
  requestId: crypto.randomUUID(),
});

// Propose a rewrite of one blip. People review it in the Wave; nothing changes until accepted.
await env.Wave.propose({
  targetId: "b_1a2b3c4d5e6f",
  quote: "",                       // "" means the whole text; otherwise the passage to replace
  replacement: "# Brief\n\nWe need to onboard ten customers by November …",
  summary: "Tighten the brief to one goal and one date",
  sources: ["b_3f1e2d4c5b6a", "b_9a02b3c4d5e6"],
  by: "Assistant",
  requestId: crypto.randomUUID(),
});

// Record a decision at the end of a thread. Decisions are locked; a later one supersedes it.
await env.Wave.recordDecision({
  threadId: "b_1a2b3c4d5e6f",
  text: "We choose option B (self-serve onboarding).",
  rationale: "Lower cost per customer; see b_3f1e2d4c5b6a and b_9a02b3c4d5e6.",
  dissent: "Harry prefers white-glove for the first three customers.",
  nextSteps: "Alice drafts the onboarding checklist by Friday.",
  by: "Assistant",
  requestId: crypto.randomUUID(),
});

// A decision record, Markdown, ready to paste into a chat, a pull request or docs/decisions/.
const record = await env.Wave.exportMarkdown({ decisions: true });
```

`by` is a display label. The Wave's own UI always sends the signed-in account's display name (the platform's `gadgetViewer`), but **the server does not verify it**: a caller of these methods, or a tampered client, can send any name, so names on blips, reviews and decisions are shown as unverified.

### Conventions

- **Ids** are a one-letter prefix, an underscore and 12 lowercase hex digits: `b_` for blips, `r_` for agent runs. Events have no id; they are numbered by `seq`. New blip ids for `applyOperation` creates may be chosen by the caller, for example `"b_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12)`.
- **`seq`** is the Wave's global event sequence: every change takes at least one number. Reads return the current `seq`; use it for `getChanges`, `getWaveMarkdown({sinceSeq})` and playback. Timestamps (`at`, `createdAt`, `updatedAt`) are for display only.
- **Binary is base64.** Every Yjs update, state vector and relative position crosses RPC as a standard base64 string (with padding). `pushText`, `openBlip`, `getPlayback`, paragraph anchors and presence carets all use it. Size limits below are decoded sizes; a base64 string is 4/3 as long.
- **Idempotent writes.** Every write accepts a `requestId` (1 to 64 characters from `A-Z a-z 0-9 : _ -`) and a `senderId`. A request whose `requestId` is already recorded **for the same `senderId`** is not applied again: it returns the recorded outcome with `duplicate: true`. The last 200 request ids per sender are remembered. Make request ids unguessable (a random value made once per session plus a counter): `senderId` is visible to other clients, so an id someone else can predict could be recorded first and your request answered as a duplicate.
- **Errors as values.** The convenience and text methods return `{error, message}` instead of throwing, so a chat agent sees the reason. Codes: `unknown_blip`, `unknown_run`, `locked` (the blip is a decision), `blip_full` (text over 16,000 characters or 96 KiB of state: reply instead), `invalid_update` (the base64 or the Yjs update does not decode), `invalid_argument`, `limit`, `no_model` (no `Model` binding), `busy` (a run is already running and three are queued). `applyOperation` reports per-op errors in `errors[]` instead.
- **Text is Markdown-lite**, rendered by the same tokenizer everywhere: paragraphs, headings `#` to `###`, `**bold**`, `*italic*`, inline and fenced code, `[text](url)` links with `http`, `https` and `mailto` only (other schemes render as text), bullet and numbered lists, `>` quotes, and blip ids as links.

### Reads

| Method | Returns |
| --- | --- |
| `getWave()` | `{meta, blips, runs, seq, capabilities}`. No text: each blip carries a 200-character `preview`. `blips` is keyed by id and includes soft-deleted blips (`deleted: true`). `capabilities.model` says whether Ask agent can run |
| `getThread({rootId})` | `{blips, seq}`: the root and every reply under it, as an array in tree order (each parent before its replies, siblings by `order`) |
| `getWaveMarkdown({sinceSeq?, threadId?})` | `string`. The Wave (or one thread) as Markdown: the title, then each thread with `### [b_…] kind · by · time` headings, replies indented, agent and proposal blips labelled with their sources and state, decisions with rationale, dissent and next steps. With `sinceSeq`, only blips changed after that sequence (their ancestors kept for context). Cut at 2 MiB with a note |
| `openBlip({blipId, stateVector?})` | `{update, seq, textSeq}`: the blip's full Yjs V2 state (base64), or only the part the caller lacks when `stateVector` (base64, at most 16 KiB) is given. `textSeq` is the sequence of the blip's latest text update |
| `getChanges({afterSeq, limit?})` | `{events, seq, earliestSeq}`: events with `seq > afterSeq`, ascending, at most `limit` (default 200, max 1,000). `earliestSeq` is the oldest sequence still retained |
| `getPlayback({blipId, fromSeq?, toSeq?})` | `{base: {seq, state}, updates: [{seq, at, by, update}], seq}`: apply `base.state` (base64; empty for a blip whose history is complete) then the updates in order to reach the text at any sequence |
| `getRun({runId})` | `{run, seq}`; `run` is null for an unknown id |
| `exportMarkdown({decisions?})` | `string`. The whole Wave as a document, or with `decisions: true` a decision record per decision: context (the thread's brief and root), decision, rationale, dissent, next steps, superseded-by, and the source blip ids. At most 2 MiB |

**Blip fields**: `id, parentId, anchor, kind, order, by, createdAt, updatedAt, version, seq, textSeq, textChars, log, deleted, locked, preview`, plus `proposal` (kind `proposal`), `decision` (kind `decision`) and `runId` (kinds `agent` and `proposal`).

| Field | Meaning |
| --- | --- |
| `kind` | `note` (written by people), `brief` (the pinned root a template creates), `agent` (model output with sources), `proposal` (a suggested replacement for one blip), `decision` (locked; only `recordDecision` creates one) |
| `parentId`, `anchor` | `null` for a root. A reply's anchor is `{type: "end"}` or `{type: "para", pos}` where `pos` is a Yjs relative position (base64) at the start of a paragraph of the parent |
| `order` | fractional ordering key among siblings (base-62 strings such as `"a0"`, `"a1"`, `"a0V"`); roots are listed in `meta.rootOrder` |
| `version` | 1 on create, bumped by each request that changes the record through `applyOperation`, `reviewProposal` or `recordDecision`. Text pushes do **not** bump it, so `baseVersion` checks never conflict with typing |
| `seq` | sequence of the last change of any kind to this blip; `textSeq` the sequence of its last text update (0 when never edited) |
| `proposal` | `{targetId, baseSeq, quote, replacement, summary, sources, state, reviewedBy?, reviewedAt?}`; `state` is `review`, `accepted`, `rejected` or `stale` (the target changed after `baseSeq`) |
| `decision` | `{supersedes?, supersededBy?, recordedBy, recordedAt, rationale, dissent, nextSteps}`; the blip's text is the decision statement |
| `log` | retained-update bookkeeping `{count, bytes, sinceCompaction, sinceCompactionBytes}`; informational |

**meta**: `{schemaVersion, seq, title, rootOrder, participants: [{id, name, color}], earliestSeq, retainedBytes, lastModified, template}`.

**Events** are `{seq, at, by, kind, blipId?, runId?, bytes?, detail?}` with `kind` one of `blip.create`, `blip.delete`, `blip.restore`, `blip.move`, `text` (with `bytes`), `proposal.accept`, `proposal.reject`, `decision.record`, `run.queued`, `run.started`, `run.done`, `run.failed`, `run.cancelled`, `run.unknown`, `structure`. The last 5,000 events (or 1 MiB) are kept.

### Text

| Method | Returns |
| --- | --- |
| `pushText({senderId, blipId, update, requestId, by?})` | `{seq, textSeq}` or `{error}`. `update` is one Yjs V2 update (base64, at most 96 KiB decoded) for the blip's `Y.Text` named `"t"`. The server applies it to a scratch copy first: a decode failure is `invalid_update`, a result over 16,000 characters or 96 KiB of state is `blip_full`, a decision is `locked`. A replayed `requestId` returns the recorded `{seq, textSeq}` with `duplicate: true` and stores nothing |

From chat, prefer `reply` (which seeds the text) and `propose` (which people accept) over `pushText`; the text methods exist for the UI and for tools that hold a Yjs document.

### Structure and content

| Method | Returns |
| --- | --- |
| `applyOperation({senderId?, by?, requestId?, blipOps?, structure?, participantOps?})` | `OperationResult` |
| `reply({parentId, text, anchor?, by?, requestId?, senderId?})` | `{blip, seq}` or `{error}`. Creates a `note` reply seeded with `text` (Markdown, 16,000 characters); `anchor` defaults to `{type: "end"}` |
| `propose({targetId, quote, replacement, summary, sources, by?, requestId?, senderId?})` | `{blip, seq}` or `{error}`. Creates a `proposal` reply under the target's thread, with `baseSeq` read now. `quote` and `replacement` are up to 8 KiB each; `summary` is one line; `sources` are blip ids (unknown ids are dropped). A proposal against a decision is `locked` |
| `reviewProposal({proposalId, decision, expectedVersion, by?, requestId?, senderId?})` | `{status, blip, seq}` or `{error}`. `decision` is `"accept"` or `"reject"`; `expectedVersion` is the proposal blip's `version` you read. `status`: `applied` (the replacement was applied to the target in the same commit), `rejected`, `stale` (the target changed since `baseSeq`; the proposal is marked `stale` and nothing is applied), `conflict` (`expectedVersion` is not current, for example someone else reviewed it first; `blip` is the current record). Only `review` proposals can be reviewed |
| `recordDecision({threadId, text, rationale, dissent?, nextSteps?, supersedes?, by?, requestId?, senderId?})` | `{blip, seq}` or `{error}`. Creates a locked `decision` at the end of the thread's root. `rationale`, `dissent` and `nextSteps` are up to 4 KiB each. `supersedes` names an earlier decision in the same thread; it gets `supersededBy`. Model output never becomes a decision; only this method does |
| `askAgent({op, blipIds?, sinceSeq?, instructions?, by?, requestId?, senderId?})` | `{run, seq}` or `{error: "no_model" \| "busy" \| "limit" \| "invalid_argument"}`. See "Agent runs" |
| `cancelRun({runId, requestId?, senderId?, by?})` | `{run, seq}` or `{error}` |

**blipOps** are applied in order, each seeing the ones before it:

- `{op: "create", blipId, parentId, anchor?, kind?, order?, text?}` creates a blip. `blipId` must be an unused id; `parentId` is `null` for a root, else an existing blip (a reply deeper than 6 levels attaches at level 6). `kind` is `note` (default) or `brief`; the other kinds come from the methods above. `text` seeds the blip's text. `order` may be given (an ordering key of at most 64 characters whose first letter is between `B` and `y`; every key made by stepping from `"a0"` qualifies) or is assigned after the last sibling.
- `{op: "delete", blipId, baseVersion}` soft-deletes a blip: it is hidden, keeps its text, and can be restored. Decisions cannot be deleted (`locked`).
- `{op: "restore", blipId, baseVersion}` undoes a soft delete.
- `{op: "move", blipId, baseVersion, parentId, anchor?, order?}` re-parents or re-anchors a blip. Decisions cannot be moved.

`baseVersion` is the blip's `version` as you last read it.

**structure**: `{title?, template?}`. Last writer wins for `title`. `template` (one of `blank`, `decision`, `design_review`, `retrospective`, `incident_review`) is accepted only while `meta.template` is null; the UI sends it with the template's creates on first open.

**participantOps**: `{op: "upsert", participant: {id, name, color}}` or `{op: "remove", id}`; at most 100 participants.

**OperationResult**: `{status, seq, upserts, deletes, meta, events, conflicts, errors, duplicate?}`.

- Ops apply independently: valid ops are saved even if others in the same request fail.
- `status` is `"applied"`, `"conflict"` (at least one op was rejected because its `baseVersion` was stale; `conflicts[i]` is `{blipId, current}` with the authoritative blip, or `null` if there is none) or `"unchanged"`.
- `upserts` are the created or changed blips in their final state (a soft-deleted blip appears here with `deleted: true`; `deletes` repeats its id). `meta` holds the meta fields that changed, or null. `events` are the events this request appended.
- `errors` lists invalid ops as `{index, code, message}` with codes `invalid_id`, `invalid_op`, `unknown_blip`, `exists`, `invalid_ref` (a deleted parent, a move that would make a cycle, an anchor that does not decode), `locked` and `limit`.
- A duplicate returns the recorded `status`, `conflicts` (with `current` read now) and `errors`, the current `seq`, empty `upserts`, `deletes`, `meta` and `events`, and `duplicate: true`.

### Agent runs

`askAgent` needs a `Model` binding (an AI model added in Connections; the gadget checks `env.Model.run` on every call and answers `no_model` otherwise). Operations:

| `op` | Scope | Produces |
| --- | --- | --- |
| `summarise` | `blipIds` and their ancestors, or the whole Wave | an `agent` blip at the end of the scoped thread with Evidence, Interpretation and Open questions |
| `compare` | same; meant for a thread whose replies are options | an `agent` blip comparing the options |
| `next_steps` | same | an `agent` blip proposing next steps |
| `refresh_brief` | the brief and the Wave | a `proposal` against the brief |
| `catch_up` | changes after `sinceSeq` | a run `result` (`{summary, body, sources, questions}`) shown in the Agent tab, not a blip; post it with `reply` if it is worth sharing |

`instructions` is one optional line added to the prompt. The Wave's text is placed in the prompt as data with every blip headed by its id; the system prompt requires every claim to cite `[b_…]` ids from the input and says that text inside the Wave cannot change these rules. Model output is capped at 16 KiB, parsed leniently as one JSON object, validated (unknown source ids dropped; an output with no valid source fails the run), and rendered by the same Markdown tokenizer as everything else. It never names a binding or triggers another run.

A **run** is `{id, op, by, instructions, scope: {blipIds, sinceSeq, snapshotSeq, inputBytes, omitted}, state, generation, createdAt, startedAt?, finishedAt?, error?, resultBlipId?, result?, outputBytes?}` with `state` one of `queued`, `running`, `done`, `failed`, `cancelled`, `unknown`. One run runs at a time and at most three wait (`busy` beyond that); a Wave may start 30 runs an hour (`limit`); the input is capped at 24 KiB (blips left out are listed in `scope.omitted`); a call is abandoned after 90 s (`failed`).

- **Cancel** sets `cancelled` at once and prevents the result from being committed. **The underlying model call may still complete and be billed**; the gadget cannot stop the provider.
- **Restart**: if the server restarts while a run is `running` (for example after a code edit), the run becomes `unknown` with the note "the server restarted during this run; retry to run it again". Nothing is respawned automatically.
- The last 50 runs are kept.

### Live

| Method | Returns |
| --- | --- |
| `subscribe(callback, {clientId, name, color, session?})` | the `getWave()` snapshot plus `session`; used by the UI. Throws `clientId in use` when a live subscription for `clientId` has a different session, and `wave is full` beyond 100 subscribers. When full, subscribers that have not called `updatePresence` for 32 seconds are removed first |
| `updatePresence({clientId, session, name?, color?, blipId?, editing?, anchor?, head?})` | `{known, seq}`; used by the UI, also as its heartbeat (every 4 seconds). `known: false` means this server instance has no subscription for the client (it restarted) or the session does not match, so the client re-subscribes. `anchor` and `head` are Yjs relative positions (base64, at most 512 bytes each); a malformed one becomes null without rejecting the update. Each client's updates are passed on at most 40 times a second |
| `leavePresence(clientId, session)` | nothing; ignored unless `session` matches |

`subscribe(callback, client)` keeps the callback and calls:

- `callback.operation(event)` with `{type: "operation", senderId, seq, upserts, deletes, meta?, events, runs?}` or `{type: "snapshot", wave}`. `senderId` lets the originating client skip its own echo.
- `callback.text(events)` with an **array** of `{blipId, senderId, seq, prevTextSeq, textSeq, update}`, one per committed text change, base64 updates. `senderId` is the pushing client's for a `pushText`, and empty (`""`) for text the server makes (the replacement applied by accepting a proposal), which is new to every client, the reviewer's included. The originator receives its own pushes too; applying every event's update, echoes included, is harmless (Yjs updates are idempotent, so a real echo changes nothing) and is what the Wave's own client does. A receiver whose known `textSeq` for the blip is older than `prevTextSeq` has missed an update and calls `openBlip` with its state vector.
- `callback.presence(events)` with an **array** of `{type: "join" | "update", clientId, name, color, blipId, editing, anchor, head, at}` or `{type: "leave", clientId, at}`. Presence is never stored.

### Limits

| Item | Limit |
| --- | --- |
| Blips | 2,000 |
| Reply depth | 6 (deeper replies attach at depth 6) |
| Text per blip | 16,000 characters; 96 KiB of stored state |
| One `pushText` update | 96 KiB decoded |
| Retained text updates | 256 KiB per blip, 4 MiB per Wave; older ones fold into the blip's base state and `meta.earliestSeq` moves |
| Events | 5,000 or 1 MiB |
| Participants | 100 named; 100 live subscribers |
| Presence caret | 512 bytes; 40 updates a second per client |
| Runs | 1 running, 3 queued, 30 an hour, 24 KiB in, 16 KiB out, 90 s |
| Proposal quote and replacement | 8 KiB each |
| Decision rationale, dissent, next steps | 4 KiB each |
| Title | 200 characters; display names 40 |
| Ops per `applyOperation` | 500 |
| Request ids remembered | 200 per sender |
| `getWaveMarkdown` and `exportMarkdown` | 2 MiB |

Longer text is truncated and out-of-range values are rejected or clamped as each method says. Stored size is measured conservatively, as an upper bound of both the JSON and the binary form storage writes: each number counts at least 9 bytes, text 1 byte per character, or 2 when it has characters beyond Latin-1, or its UTF-8 JSON size when that is more, and binary its length plus a small header.

### Storage layout

| Key | Holds |
| --- | --- |
| `meta` | `{schemaVersion, seq, title, rootOrder, participants, earliestSeq, retainedBytes, lastModified, template}` |
| `blip:<id>` | one blip record (no text) |
| `text:<id>` | the blip's compacted Yjs state as of `textSeq`; rewritten after 100 updates or 64 KiB since the last compaction |
| `base:<id>` | `{seq, state}`: the earliest state playback can start from; updated when old updates are trimmed |
| `upd:<id>:<seq>` | one Yjs V2 update `{by, at, update}`; `seq` is zero-padded to 12 digits so a prefix listing is in order |
| `event:<seq>` | one event, zero-padded likewise |
| `run:<id>` | one agent run |
| `req:<senderId>` | that sender's recent `requestId` outcomes |

## Measured

Measured on a local Cloudflare OS (2026-09-17). The package README has the full notes.

- Blip text crosses RPC as base64 Yjs V2 updates; a keystroke push into a 15,000-character blip is tens of bytes.
- Local edits are pushed after 80 ms idle, at 1 KiB pending, or at most 250 ms after the oldest unsent change. Three people typing continuously send about 9 pushes a second in total, and remote text shows in about 150 ms.
- Paste, IME composition and touch editing work in the sandboxed frame. Links open in a new tab.
- One Summarise with a fast OpenRouter model takes about 5 s. A model call cannot be aborted; after 90 s the run fails and a late answer is discarded.
- Names come from the signed-in account (`gadgetViewer`); nobody is asked for one.
