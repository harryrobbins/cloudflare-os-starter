// @ts-check
// The Wave's contract: data shapes, wire protocol, limits and sanitisers.
// Shared by the server (src/server), the storage-agnostic rules (src/core) and the client
// (src/client). Changing anything here changes the wire protocol; do it deliberately.
//
// Three channels share one RPC session:
//   structure   applyOperation, reply, propose, reviewProposal, recordDecision, askAgent
//               -> callback.operation      committed, sequenced, stored, in the event log
//   text        pushText -> callback.text   one Yjs V2 update per push, stored per update,
//                                           replayable (History mode)
//   presence    updatePresence -> callback.presence   who is on which blip, editing, carets;
//                                                     memory only, never stored
//
// Binary on the wire is base64 (encodeBytes / decodeBytes): every Yjs update, state vector and
// relative position crosses RPC as a string. In storage, updates and states are Uint8Array
// (Durable Object storage structured-clones typed arrays). Wire caps are sized for the 4/3
// overhead; the LIMITS below are DECODED sizes unless a comment says otherwise.

import { isValidOrderKey } from "./order.js";

// ---------------------------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------------------------

/**
 * `note` is what people write; `brief` is the pinned root blip a template creates; `agent` is
 * model output with sources; `proposal` is model output that targets a blip (Accept applies it);
 * `decision` is a locked blip created only by recordDecision. Clients may create `note` and
 * `brief`; the other kinds come from the server's own methods.
 * @typedef {"note"|"brief"|"agent"|"proposal"|"decision"} BlipKind
 */

/**
 * Where a reply sits in its parent. `end`: after every paragraph, at the end of the thread.
 * `para`: after the paragraph whose start is `pos`, a Yjs relative position into the parent's
 * Y.Text (base64, at most LIMITS.caretBytes decoded; the server re-encodes it with Yjs' own
 * parser and rejects anything else). When the paragraph no longer exists, readers render the
 * reply at the end with a "was attached to removed text" note; the anchor itself is kept.
 * Root blips have anchor null.
 * @typedef {{type: "end"} | {type: "para", pos: string}} Anchor
 */

/**
 * One blip, stored under "blip:<id>". Its text is NOT here: it lives in a Y.Text (see the text
 * channel), and `preview` carries its first LIMITS.preview characters for collapsed views.
 *
 * @typedef {object} Blip
 * @property {string} id           "b_" + 12 hex
 * @property {string|null} parentId  null for a root blip
 * @property {Anchor|null} anchor  null for a root blip
 * @property {BlipKind} kind       immutable after create
 * @property {string} order        fractional order key among siblings with the same parent (roots:
 *   among roots; `meta.rootOrder` is derived from it), see src/shared/order.js
 * @property {string} by           display name of the creator (unverified)
 * @property {number} createdAt    epoch ms
 * @property {number} updatedAt    epoch ms, structure or text
 * @property {number} version      1 on create, bumped once per REQUEST that changes the record
 *   through applyOperation, reviewProposal or recordDecision. Text pushes do NOT bump it (they
 *   advance textSeq), so baseVersion checks never fight with typing.
 * @property {number} seq          global event sequence of the last change to this blip of any
 *   kind (structure, text, proposal state); the since marker and History highlights use it
 * @property {number} textSeq      global event sequence of the latest text update applied to this
 *   blip; 0 when the text has never changed. Text events carry {prevTextSeq, textSeq} so a client
 *   can detect a gap.
 * @property {number} textChars    length of the text after the last commit (for the UI's counter
 *   and the blip_full message); refreshed on every push
 * @property {UpdateLog} log       bookkeeping for compaction and retention (see below)
 * @property {boolean} deleted     soft-deleted: hidden, text kept, restorable
 * @property {boolean} locked      true for decisions: no edits, deletes or moves
 * @property {string} preview      first LIMITS.preview characters of the text, whitespace
 *   collapsed; refreshed on every commit that changes the text
 * @property {Proposal} [proposal] kind "proposal" only
 * @property {Decision} [decision] kind "decision" only
 * @property {string} [runId]      kind "agent" and "proposal": the run that produced it
 */

/**
 * Retained-update bookkeeping, kept on the blip record because the record is rewritten on every
 * push anyway (seq, textSeq, updatedAt change) and the core has every blip loaded. All sizes are
 * storedBytes of the stored update records.
 * @typedef {object} UpdateLog
 * @property {number} count   retained "upd:<id>:*" keys
 * @property {number} bytes   their stored size together (retention trims at LIMITS.updBytesPerBlip)
 * @property {number} sinceCompaction       updates appended since "text:<id>" was last rewritten
 * @property {number} sinceCompactionBytes  their size (compaction at LIMITS.compaction.*)
 */

/**
 * @typedef {"review"|"accepted"|"rejected"|"stale"} ProposalState
 */

/**
 * A proposal targets one blip and offers a replacement for a quoted passage (an empty quote means
 * the whole text). `baseSeq` is the target's `seq` when the proposal was made; when the target's
 * seq has moved since, the proposal is `stale` ("based on an older version" in the UI) and Accept
 * is refused. Accepting applies the replacement to the target's Y.Text as one transaction.
 * @typedef {object} Proposal
 * @property {string} targetId
 * @property {number} baseSeq
 * @property {string} quote        LIMITS.proposalFieldChars
 * @property {string} replacement  LIMITS.proposalFieldChars
 * @property {string} summary      one line, LIMITS.summary
 * @property {string[]} sources    blip ids the proposal cites (unknown ids dropped)
 * @property {ProposalState} state
 * @property {string} [reviewedBy]
 * @property {number} [reviewedAt]
 */

/**
 * A decision is a locked blip whose text is the decision statement. Recording a new decision in
 * the same thread supersedes the previous one; both remain.
 * @typedef {object} Decision
 * @property {string} [supersedes]     id of the decision this one replaces
 * @property {string} [supersededBy]   set on the older decision when a successor is recorded
 * @property {string} recordedBy       display name (unverified)
 * @property {number} recordedAt
 * @property {string} rationale        LIMITS.decisionFieldChars each
 * @property {string} dissent
 * @property {string} nextSteps
 */

/**
 * @typedef {object} Participant
 * @property {string} id     1-64 chars of [A-Za-z0-9:_-]; the viewer's stable id (kept in
 *   window.name across reloads), not the per-page clientId
 * @property {string} name
 * @property {string} color  "#rrggbb"
 */

/**
 * Stored under "meta".
 * @typedef {object} WaveMeta
 * @property {number} schemaVersion
 * @property {number} seq             global, monotonically increasing event sequence; every commit
 *   that changes anything takes at least one number. Ordering, gap detection, playback and the
 *   since marker use it; timestamps are for display only
 * @property {string} title
 * @property {string[]} rootOrder     root blip ids in display order (derived from their `order`)
 * @property {Participant[]} participants  everyone who has joined, LIMITS.participants
 * @property {number} earliestSeq     the oldest sequence History can replay from (retention
 *   trimming and event dropping raise it); 1 for an untrimmed wave
 * @property {number} retainedBytes   sum of every blip's log.bytes (retention at LIMITS.updBytesPerWave)
 * @property {number} lastModified    epoch ms
 * @property {string|null} template   TEMPLATES id applied on first open, null until then
 */

/**
 * What getWave() and subscribe() return, and what a "snapshot" event carries. No text: previews
 * only. `runs` lists the most recent runs (LIMITS.runs.keep), oldest first. `capabilities.model`
 * says whether Ask agent can run at all (a Model binding is configured); it is computed per read,
 * never stored.
 * @typedef {object} WaveSnapshot
 * @property {WaveMeta} meta
 * @property {Record<string, Blip>} blips   keyed by id, soft-deleted ones included (deleted: true)
 * @property {Run[]} runs
 * @property {number} seq                    same as meta.seq
 * @property {{model: boolean}} capabilities
 */

/**
 * @typedef {"blip.create"|"blip.delete"|"blip.restore"|"blip.move"|"text"|"proposal.accept"|"proposal.reject"|"decision.record"|"run.queued"|"run.started"|"run.done"|"run.failed"|"run.cancelled"|"run.unknown"|"structure"} EventKind
 */

/**
 * One entry of the event log, stored under "event:<seq>" (seq zero-padded, see seqKey). Retained
 * up to LIMITS.events / LIMITS.eventBytes; older ones are dropped and meta.earliestSeq moves.
 * @typedef {object} WaveEvent
 * @property {number} seq
 * @property {number} at
 * @property {string} by        display name (unverified); "agent" for model output commits
 * @property {EventKind} kind
 * @property {string} [blipId]
 * @property {string} [runId]
 * @property {number} [bytes]   "text": decoded size of the update
 * @property {string} [detail]  one line, LIMITS.eventDetail: e.g. a new title, a proposal summary
 */

/**
 * @typedef {"summarise"|"compare"|"next_steps"|"refresh_brief"|"catch_up"} RunOp
 */

/**
 * queued -> running -> done | failed | cancelled. `unknown`: the server restarted while the run
 * was running; nothing is respawned, the person retries. A cancelled run's model call may still
 * complete and be billed; its result is discarded.
 * @typedef {"queued"|"running"|"done"|"failed"|"cancelled"|"unknown"} RunState
 */

/**
 * What a model call must return (parsed leniently from its text by src/core/runs.js): one JSON
 * object. `body` is Markdown rendered like everything else, with Evidence / Interpretation / Open
 * questions sections; `sources` are blip ids from the input (unknown ids dropped; an output with
 * no valid source is a failed run). `quote` and `replacement` are used only by refresh_brief
 * (which yields a proposal); `summary` is one line.
 * @typedef {object} AgentOutput
 * @property {string} summary
 * @property {string} body
 * @property {string[]} sources
 * @property {string[]} questions
 * @property {string} [quote]
 * @property {string} [replacement]
 */

/**
 * Stored under "run:<id>". `generation` guards commits: a result is committed only when the run
 * is still `running` with the generation the dispatcher started (a restart bumps it).
 * @typedef {object} Run
 * @property {string} id          "r_" + 12 hex
 * @property {RunOp} op
 * @property {string} by
 * @property {string} instructions   one line the person added, LIMITS.instructions; "" when none
 * @property {{blipIds: string[], sinceSeq: number, snapshotSeq: number, inputBytes: number, omitted: string[]}} scope
 *   blipIds: the blips the model saw (ancestors included); sinceSeq: catch_up's starting point,
 *   0 otherwise; snapshotSeq: meta.seq when the input was built; inputBytes: UTF-8 size of the
 *   prompt's wave content; omitted: blip ids left out for LIMITS.runs.inputBytes
 * @property {RunState} state
 * @property {number} generation
 * @property {number} createdAt
 * @property {number} [startedAt]
 * @property {number} [finishedAt]
 * @property {string} [error]        failed | unknown: one line for the run card
 * @property {string} [resultBlipId] done: the agent blip or proposal created
 * @property {AgentOutput} [result]  done, catch_up only (shown in the Agent tab with "Post to wave")
 * @property {number} [outputBytes]  UTF-8 size of the raw model reply
 */

/**
 * Stored under "req:<senderId>" (newest last), one record per write carrying a valid requestId,
 * in the same atomic commit as its changes. A replay (same senderId AND requestId) returns the
 * recorded outcome with `duplicate: true` and applies nothing.
 * @typedef {object} RequestRecord
 * @property {string} requestId
 * @property {number} seq        meta.seq after the request
 * @property {number} at
 * @property {"applyOperation"|"pushText"|"reply"|"propose"|"reviewProposal"|"recordDecision"|"askAgent"|"cancelRun"} method
 * @property {unknown} outcome   the method's result minus bulky fields (see each method's
 *   `duplicate` note); for pushText {seq, textSeq}
 */

// ---------------------------------------------------------------------------------------------
// Operations (client -> server)
// ---------------------------------------------------------------------------------------------

/**
 * Blip operations, processed in array order; each op sees the effects of the ops before it.
 *
 *   create   `blipId` must be a valid unused id. `parentId` null makes a root (then anchor is
 *            ignored); otherwise it names an existing blip and `anchor` defaults to {type: "end"}.
 *            A reply deeper than LIMITS.replyDepth attaches at depth LIMITS.replyDepth (its parent
 *            becomes the ancestor at that depth, anchor "end"). `kind` defaults to "note"; only
 *            "note" and "brief" are accepted here. `order` defaults to after the last sibling.
 *            `text` (LIMITS.textChars) seeds the Y.Text in the same commit.
 *   delete   soft-delete (hidden, restorable); refused with "locked" for decisions.
 *   restore  undo a soft-delete.
 *   move     re-parent or re-anchor; refused with "locked" for decisions.
 *
 * `baseVersion` is required on delete, restore and move: the version the caller last saw. It
 * matches when it equals the current version or the version before this request. A stale
 * baseVersion yields a conflict carrying the authoritative blip instead of a silent overwrite.
 *
 * @typedef {(
 *   {op: "create", blipId: string, parentId: string|null, anchor?: Anchor, kind?: BlipKind, order?: string, text?: string}
 * | {op: "delete", blipId: string, baseVersion: number}
 * | {op: "restore", blipId: string, baseVersion: number}
 * | {op: "move", blipId: string, baseVersion: number, parentId: string|null, anchor?: Anchor, order?: string}
 * )} BlipOp
 */

/**
 * `upsert` adds or renames a participant (LIMITS.participants; beyond it, "limit"); `remove`
 * drops one. The client upserts its viewer on join and on a name change.
 * @typedef {(
 *   {op: "upsert", participant: Participant}
 * | {op: "remove", id: string}
 * )} ParticipantOp
 */

/**
 * @typedef {object} OperationRequest
 * @property {string} [senderId]  the client's id, echoed in the broadcast so it can skip its own
 * @property {string} [by]        display name recorded on blips and events
 * @property {string} [requestId] idempotency key, 1-64 chars of [A-Za-z0-9:_-] (anything else is
 *   ignored as if absent). A request whose requestId is already recorded FOR THE SAME senderId is
 *   not applied again; the recorded outcome is returned with `duplicate: true`. senderId is
 *   broadcast, so requestIds must be unguessable (the client uses a per-page random secret plus a
 *   counter): a peer that knows a future requestId could record it first and have that request
 *   answered as a duplicate.
 * @property {BlipOp[]} [blipOps]                 at most LIMITS.opsPerRequest
 * @property {{title?: string, template?: string}} [structure]  last-writer-wins, applied after
 *   blipOps. `template` (a TEMPLATES id) is accepted only while meta.template is null; the client
 *   sends it with the template's creates on first open.
 * @property {ParticipantOp[]} [participantOps]   at most LIMITS.opsPerRequest
 */

/**
 * @typedef {object} Conflict
 * @property {string} blipId
 * @property {Blip|null} current  authoritative blip; null when it does not exist
 */

/**
 * @typedef {object} OpError
 * @property {number} index  position in blipOps (or participantOps for its codes); -1 for
 *   structure or the whole request
 * @property {"invalid_id"|"invalid_op"|"unknown_blip"|"exists"|"invalid_ref"|"locked"|"limit"} code
 *   invalid_ref: a parentId naming a deleted blip, a move that would make a cycle, or an anchor
 *   that does not decode. locked: a delete or move of a decision. limit: LIMITS.blips,
 *   LIMITS.opsPerRequest, LIMITS.participants, or a text over LIMITS.textChars / textStateBytes.
 * @property {string} message
 */

/**
 * Result of applyOperation. Ops apply independently: valid ones commit even when others conflict
 * or fail.
 *
 * status: "applied" when something changed and nothing conflicted; "conflict" when any op
 * conflicted (others may still have applied); "unchanged" when nothing changed and nothing
 * conflicted (errors may be present).
 *
 * duplicate: the requestId was already recorded, so nothing was applied. status, conflict ids
 * and errors are the recorded ones (conflicts[].current is read now), seq is CURRENT, and
 * upserts / deletes / meta / events are empty. Nothing is broadcast.
 *
 * @typedef {object} OperationResult
 * @property {"applied"|"conflict"|"unchanged"} status
 * @property {number} seq
 * @property {Blip[]} upserts               blips created or changed, in their final state
 * @property {string[]} deletes             ids soft-deleted by this request (they also appear in
 *   upserts with deleted: true; `deletes` is the convenience list)
 * @property {Partial<WaveMeta>|null} meta  the meta fields that changed (title, rootOrder,
 *   participants, template, seq, lastModified), or null
 * @property {WaveEvent[]} events
 * @property {Conflict[]} conflicts
 * @property {OpError[]} errors
 * @property {boolean} [duplicate]
 */

/**
 * Errors the convenience and text methods report as a value rather than by throwing, so a chat
 * agent sees them. A malformed argument that cannot be repaired is "invalid_argument".
 * @typedef {"unknown_blip"|"unknown_run"|"locked"|"blip_full"|"invalid_update"|"invalid_argument"|"limit"|"no_model"|"busy"} ErrorCode
 */

/**
 * @typedef {{error: ErrorCode, message: string}} ErrorResult
 */

// --- Text channel ---------------------------------------------------------------------------

/**
 * Argument of pushText: one Yjs V2 update (base64, at most LIMITS.pushBytes decoded) for one
 * blip. The server applies it to a scratch doc first; a decode failure is "invalid_update", a
 * resulting state over LIMITS.textStateBytes or text over LIMITS.textChars is "blip_full" (the
 * UI suggests a reply), a decision is "locked". A replayed requestId returns the recorded
 * {seq, textSeq} with duplicate: true and appends nothing.
 * @typedef {object} PushTextRequest
 * @property {string} senderId
 * @property {string} blipId
 * @property {string} update
 * @property {string} requestId
 * @property {string} [by]
 */

/**
 * @typedef {{seq: number, textSeq: number, duplicate?: boolean} | ErrorResult} PushTextResult
 */

/**
 * Argument of openBlip. Without `stateVector` the result is the blip's full state; with one (a
 * Yjs state vector, base64, at most LIMITS.stateVectorBytes decoded) only the diff the caller
 * lacks. `textSeq` is the blip's current textSeq; `seq` the wave's.
 * @typedef {{blipId: string, stateVector?: string}} OpenBlipRequest
 */

/**
 * @typedef {{update: string, seq: number, textSeq: number} | ErrorResult} OpenBlipResult
 */

/**
 * @typedef {{afterSeq: number, limit?: number}} GetChangesRequest  limit defaults to 200, max 1000
 */

/**
 * @typedef {{events: WaveEvent[], seq: number, earliestSeq: number}} GetChangesResult
 */

/**
 * Playback data for one blip: the earliest state available (`base.seq` is 0 for "empty text")
 * and every retained update from fromSeq (default: base.seq) to toSeq (default: now), ascending.
 * Apply the base, then the updates in order, to reach the text at any sequence.
 * @typedef {{blipId: string, fromSeq?: number, toSeq?: number}} GetPlaybackRequest
 */

/**
 * @typedef {{base: {seq: number, state: string}, updates: Array<{seq: number, at: number, by: string, update: string}>, seq: number} | ErrorResult} GetPlaybackResult
 */

// --- Convenience writes (agent-friendly) -----------------------------------------------------

/**
 * @typedef {object} ReplyRequest
 * @property {string} parentId
 * @property {string} text        Markdown, LIMITS.textChars
 * @property {Anchor} [anchor]    default {type: "end"}
 * @property {string} [by]
 * @property {string} [requestId]
 * @property {string} [senderId]
 */

/**
 * @typedef {{blip: Blip, seq: number, duplicate?: boolean} | ErrorResult} BlipResult
 */

/**
 * @typedef {object} ProposeRequest
 * @property {string} targetId
 * @property {string} quote         passage of the target to replace; "" for the whole text
 * @property {string} replacement
 * @property {string} summary       one line
 * @property {string[]} sources     blip ids
 * @property {string} [by]
 * @property {string} [requestId]
 * @property {string} [senderId]
 */

/**
 * @typedef {object} ReviewProposalRequest
 * @property {string} proposalId
 * @property {"accept"|"reject"} decision
 * @property {number} expectedVersion  the proposal blip's version the reviewer saw
 * @property {string} [by]
 * @property {string} [requestId]
 * @property {string} [senderId]
 */

/**
 * applied: accepted and the replacement applied to the target. rejected: marked rejected.
 * stale: the target changed since the proposal (state becomes "stale", nothing applied).
 * conflict: expectedVersion is not the proposal's current version, e.g. someone else reviewed it
 * first (the UI shows "already applied" when blip.proposal.state is "accepted").
 * @typedef {{status: "applied"|"rejected"|"stale"|"conflict", blip: Blip, seq: number, duplicate?: boolean} | ErrorResult} ReviewProposalResult
 */

/**
 * @typedef {object} RecordDecisionRequest
 * @property {string} threadId      a root blip id (or any blip in the thread; the decision goes
 *   at the end of the root's thread)
 * @property {string} text          the decision statement, LIMITS.textChars
 * @property {string} rationale     LIMITS.decisionFieldChars each
 * @property {string} [dissent]
 * @property {string} [nextSteps]
 * @property {string} [supersedes]  an earlier decision's id in the same thread
 * @property {string} [by]
 * @property {string} [requestId]
 * @property {string} [senderId]
 */

/**
 * @typedef {object} AskAgentRequest
 * @property {RunOp} op
 * @property {string[]} [blipIds]     scope: these blips and their ancestors; the whole wave when
 *   absent. refresh_brief ignores it (the brief is the scope).
 * @property {number} [sinceSeq]      catch_up: changes after this sequence
 * @property {string} [instructions]  one line, LIMITS.instructions
 * @property {string} [by]
 * @property {string} [requestId]
 * @property {string} [senderId]
 */

/**
 * @typedef {{run: Run, seq: number, duplicate?: boolean} | ErrorResult} RunResult
 */

/**
 * @typedef {{runId: string, requestId?: string, senderId?: string, by?: string}} CancelRunRequest
 */

/**
 * @typedef {{sinceSeq?: number, threadId?: string}} GetWaveMarkdownRequest
 */

/**
 * @typedef {{decisions?: boolean}} ExportMarkdownRequest
 */

// ---------------------------------------------------------------------------------------------
// Events (server -> subscribed clients)
// ---------------------------------------------------------------------------------------------

/**
 * Delivered to `callback.operation(event)`, in seq order.
 *   "operation": put `upserts` (a soft-deleted blip arrives as an upsert with deleted: true;
 *                `deletes` repeats their ids), merge `meta` when present, append `events`, put
 *                `runs` when present.
 *   "snapshot":  replace local state entirely.
 * @typedef {(
 *   {type: "operation", senderId: string, seq: number, upserts: Blip[], deletes: string[],
 *    meta?: Partial<WaveMeta>, events: WaveEvent[], runs?: Run[]}
 *   | {type: "snapshot", wave: WaveSnapshot}
 * )} WaveOperationEvent
 */

/**
 * Delivered to `callback.text(events)` as an ARRAY, oldest first, one entry per committed push
 * (the server may batch several into one call). The originator receives its own pushes too
 * (matching `senderId`). `senderId` is the pushing client's only for a pushText; text the server
 * makes (an accepted proposal's replacement) carries "". Receivers apply every update anyway (Yjs
 * updates are idempotent, so a real echo changes nothing). A receiver whose known textSeq
 * for the blip is older than `prevTextSeq` has a gap: it applies nothing from the event and calls
 * openBlip with its state vector instead.
 * @typedef {object} TextEvent
 * @property {string} blipId
 * @property {string} senderId     the pushing client, or "" for server-made text
 * @property {number} seq          the wave sequence this push took
 * @property {number} prevTextSeq  the blip's textSeq before this push
 * @property {number} textSeq      equals seq
 * @property {string} update       base64 Yjs V2 update
 */

/**
 * A collaborator's full ephemeral state. Every "join" and "update" carries all of it, so a
 * receiver (or a coalescing server) only ever needs the latest one per client.
 * `anchor` and `head` are Yjs relative positions into the blip's Y.Text (base64, each at most
 * LIMITS.caretBytes decoded); a malformed one becomes null rather than rejecting the update.
 * Without a blipId, editing is false and both carets are null.
 * @typedef {object} PresenceState
 * @property {string} clientId
 * @property {string} name
 * @property {string} color
 * @property {string|null} blipId   the blip they are on (focused or editing)
 * @property {boolean} editing      true while their editor is open on blipId
 * @property {string|null} anchor   selection anchor while editing
 * @property {string|null} head     selection head while editing (equals anchor for a caret)
 */

/**
 * Delivered to `callback.presence(events)` as an ARRAY, oldest first. The hub may deliver one
 * event per call or coalesce several clients' latest states into one call; receivers must handle
 * both. "join" when a client subscribes (and replayed to a newcomer for everyone already present),
 * "update" on changes and heartbeats, "leave" on explicit leave or a dropped connection.
 * @typedef {(PresenceState & {type: "join"|"update", at: number}) | {type: "leave", clientId: string, at: number}} PresenceEvent
 */

/**
 * Second argument of subscribe(callback, client).
 * @typedef {object} ClientInfo
 * @property {string} clientId  1-64 chars
 * @property {string} name
 * @property {string} color
 * @property {string} [session]  the session subscribe() returned earlier for this clientId; needed
 *   to replace a live subscription for the same clientId. A well-formed token is also kept as the
 *   new session when the server has no entry (e.g. after a restart).
 */

/**
 * What subscribe() returns: the snapshot plus the subscription's session token (32 lowercase hex).
 * The token is never broadcast; it must accompany updatePresence and leavePresence.
 * subscribe throws Error("clientId in use") when a live subscription for clientId has a different
 * session, and Error("wave is full") beyond LIMITS.subscribers.
 * @typedef {WaveSnapshot & {session: string}} SubscribeResult
 */

/**
 * Argument of updatePresence. Fields left out keep their previous value; `null` clears.
 * Returns {known, seq}: known is false when this server instance has no subscription for
 * clientId or the session does not match (the client then re-subscribes); seq lets the client
 * notice missed events.
 * @typedef {Partial<Omit<PresenceState, "clientId">> & {clientId: string, session: string}} PresenceUpdate
 */

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

export const SCHEMA_VERSION = 1;

export const LIMITS = Object.freeze({
  blips: 2000,
  /** Deeper replies attach at this depth (a root is depth 1). */
  replyDepth: 6,
  /** Characters of text in one blip. */
  textChars: 16000,
  /** Stored (decoded) size of one blip's compacted Y.Text state. */
  textStateBytes: 96 * 1024,
  /** Decoded size of one pushText update. A resync goes through openBlip, never pushText. */
  pushBytes: 96 * 1024,
  /** Decoded size of a state vector passed to openBlip. */
  stateVectorBytes: 16 * 1024,
  /** Retained "upd:" records per blip and per wave (storedBytes); older ones fold into "base:". */
  updBytesPerBlip: 256 * 1024,
  updBytesPerWave: 4 * 1024 * 1024,
  /** Retention trims at most this many blips per commit (the largest first). */
  trimBlipsPerCommit: 1,
  /** Event log: whichever comes first. */
  events: 5000,
  eventBytes: 1024 * 1024,
  eventDetail: 200,
  participants: 100,
  subscribers: 100,
  /** Decoded size of one presence caret (anchor or head) and of a paragraph anchor's pos. */
  caretBytes: 512,
  runs: Object.freeze({
    running: 1,
    queued: 3,
    perHour: 30,
    /** UTF-8 size of wave content placed in the prompt; more is omitted (scope.omitted). */
    inputBytes: 24 * 1024,
    /** UTF-8 size of the raw model reply that is read; more fails the run. */
    outputBytes: 16 * 1024,
    timeoutMs: 90_000,
    /** Blip ids one askAgent may name. */
    scopeBlips: 200,
    /** "run:" records kept (oldest finished ones are deleted beyond this). */
    keep: 50,
  }),
  /** Ids in an agent output's `sources` and entries in `questions`. */
  sources: 50,
  questions: 20,
  /** One line of instructions on askAgent. */
  instructions: 500,
  /** Proposal quote and replacement, characters each. */
  proposalFieldChars: 8192,
  /** Decision rationale, dissent and nextSteps, characters each. */
  decisionFieldChars: 4096,
  /** Characters of getWaveMarkdown and exportMarkdown output; more is cut with a note. */
  exportBytes: 2 * 1024 * 1024,
  title: 200,
  displayName: 40,
  /** Blip.preview and event details derived from text. */
  preview: 200,
  /** Proposal summary and AgentOutput.summary. */
  summary: 500,
  /** Longest order key stored (order.js accepts up to this). */
  orderKey: 128,
  /** Longest `order` a client may set directly (see isAcceptableOrderKey). */
  orderKeyAccept: 64,
  /** blipOps and participantOps per applyOperation. */
  opsPerRequest: 500,
  /** Per sender ("req:<senderId>"): records kept, and storedBytes of the whole value. */
  requestRecords: 200,
  requestRecordBytes: 64 * 1024,
  /** Senders with a "req:" record; the least recently written are dropped beyond it. */
  requestSenders: 200,
  /** Compaction of "text:<id>" after this many updates OR this many bytes since textSeq. */
  compaction: Object.freeze({ updates: 100, bytes: 64 * 1024 }),
  /** Server-side Y.Doc cache (src/server): docs, decoded bytes, idle eviction. */
  cache: Object.freeze({ docs: 64, bytes: 8 * 1024 * 1024, idleMs: 10 * 60_000 }),
});

/** Client heartbeat interval; also the longest a remote caret can sit without an update. */
export const PRESENCE_HEARTBEAT_MS = 4000;
/** A peer unseen this long is removed by clients. */
export const PRESENCE_STALE_MS = 12000;
/** Minimum gap between a client's presence sends while the caret moves (about 30 Hz). */
export const PRESENCE_SEND_MS = 33;
/**
 * Text batching: send pending updates when idle this long, when this much is pending, or at the
 * latest TEXT_MAX_WAIT_MS after the oldest pending change. Without the cap a continuous typist
 * (a key every 60 ms) never goes idle, and the local platform run (T11) saw remote text stall for
 * over 10 s. 250 ms is about 4 pushes a second per typist, the plan's rate budget.
 */
export const TEXT_IDLE_MS = 80;
export const TEXT_MAX_WAIT_MS = 250;
export const TEXT_FLUSH_BYTES = 1024;

export const DEFAULT_TITLE = "Untitled wave";
export const DEFAULT_COLOR = "#e1632e";
export const DEFAULT_NAME = "Guest";

export const BLIP_KINDS = /** @type {const} */ (["note", "brief", "agent", "proposal", "decision"]);
/** Kinds a client may create through applyOperation. */
export const CLIENT_KINDS = /** @type {const} */ (["note", "brief"]);
export const EVENT_KINDS = /** @type {const} */ ([
  "blip.create", "blip.delete", "blip.restore", "blip.move", "text",
  "proposal.accept", "proposal.reject", "decision.record",
  "run.queued", "run.started", "run.done", "run.failed", "run.cancelled", "run.unknown",
  "structure",
]);
export const RUN_OPS = /** @type {const} */ (["summarise", "compare", "next_steps", "refresh_brief", "catch_up"]);
export const RUN_STATES = /** @type {const} */ (["queued", "running", "done", "failed", "cancelled", "unknown"]);
export const PROPOSAL_STATES = /** @type {const} */ (["review", "accepted", "rejected", "stale"]);
/** Human-readable labels for the Ask agent menu and run cards. */
export const RUN_OP_LABELS = Object.freeze({
  summarise: "Summarise", compare: "Compare options", next_steps: "Propose next steps",
  refresh_brief: "Refresh brief", catch_up: "Catch up",
});

export const ID_PREFIX = Object.freeze({ blip: "b", run: "r", history: "h" });

const ID_RE = /^[a-z]_[0-9a-f]{12}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9:_-]{1,64}$/;
const PARTICIPANT_ID_RE = /^[A-Za-z0-9:_-]{1,64}$/;
const SESSION_RE = /^[0-9a-f]{32}$/;
const ORDER_RE = /^[0-9A-Za-z]+$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const TEMPLATE_ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
/** Digits of a zero-padded sequence key ("upd:<id>:<seq>", "event:<seq>"). */
export const SEQ_DIGITS = 12;
const SEQ_KEY_RE = /^[0-9]{12}$/;
// C0/C1 controls except tab and newline, plus bidi overrides.
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

// ---------------------------------------------------------------------------------------------
// Ids, tokens and sequence keys
// ---------------------------------------------------------------------------------------------

/**
 * @param {keyof typeof ID_PREFIX} kind
 * @returns {string}
 */
export function newId(kind) {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return ID_PREFIX[kind] + "_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {unknown} id
 * @param {keyof typeof ID_PREFIX} [kind]  defaults to "blip"
 * @returns {id is string}
 */
export function isId(id, kind = "blip") {
  return typeof id === "string" && ID_RE.test(id) && id[0] === ID_PREFIX[kind];
}

/** @param {unknown} v @returns {v is string} */
export const isBlipId = (v) => isId(v, "blip");

/** @param {unknown} v @returns {v is string} */
export const isRunId = (v) => isId(v, "run");

/** @param {unknown} v @returns {v is string} */
export function isRequestId(v) {
  return typeof v === "string" && REQUEST_ID_RE.test(v);
}

/** @param {unknown} v @returns {v is string} a participant id (same alphabet as a request id) */
export function isParticipantId(v) {
  return typeof v === "string" && PARTICIPANT_ID_RE.test(v);
}

/** @param {unknown} v @returns {v is string} a well-formed session token (32 lowercase hex) */
export function isSession(v) {
  return typeof v === "string" && SESSION_RE.test(v);
}

/** @returns {string} 128 random bits as 32 lowercase hex digits */
export function newSession() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A sequence as a fixed-width key segment, so "upd:<id>:<seqKey>" and "event:<seqKey>" list in
 * numeric order. Throws on anything but a non-negative safe integer below 10^12.
 * @param {number} seq
 * @returns {string}
 */
export function seqKey(seq) {
  if (!Number.isSafeInteger(seq) || seq < 0 || seq >= 10 ** SEQ_DIGITS) throw new RangeError("bad seq: " + seq);
  return String(seq).padStart(SEQ_DIGITS, "0");
}

/**
 * The inverse of seqKey: the last 12 digits of a key (any "<prefix>:" before them is ignored),
 * or null when the tail is not 12 digits or is not separated by a colon.
 * @param {unknown} key
 * @returns {number|null}
 */
export function parseSeqKey(key) {
  if (typeof key !== "string" || key.length < SEQ_DIGITS) return null;
  const tail = key.slice(-SEQ_DIGITS);
  if (!SEQ_KEY_RE.test(tail)) return null;
  if (key.length > SEQ_DIGITS && key[key.length - SEQ_DIGITS - 1] !== ":") return null;
  return Number(tail);
}

/** @param {unknown} v @returns {number|null} a non-negative safe integer, else null */
export function cleanSeq(v) {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

// ---------------------------------------------------------------------------------------------
// Binary <-> base64
// ---------------------------------------------------------------------------------------------

/**
 * Standard base64 (with padding) of the bytes. Chunked so large updates do not blow the argument
 * limit of String.fromCharCode.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function encodeBytes(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, /** @type {any} */ (bytes.subarray(i, i + 0x8000)));
  }
  return btoa(binary);
}

/**
 * Decoded size of a base64 string, without decoding it; -1 when malformed.
 * @param {string} str
 */
export function decodedLength(str) {
  if (str.length % 4 !== 0 || !BASE64_RE.test(str)) return -1;
  const pad = str.endsWith("==") ? 2 : str.endsWith("=") ? 1 : 0;
  return (str.length / 4) * 3 - pad;
}

/**
 * Bytes of a base64 string, or null when it is not a string, is malformed (wrong alphabet, bad
 * padding, length not a multiple of 4), or decodes to more than `maxBytes`. "" decodes to an
 * empty array.
 * @param {unknown} str
 * @param {number} [maxBytes]
 * @returns {Uint8Array|null}
 */
export function decodeBytes(str, maxBytes = Infinity) {
  if (typeof str !== "string") return null;
  const n = decodedLength(str);
  if (n < 0 || n > maxBytes) return null;
  let binary;
  try {
    binary = atob(str);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Canonical base64 of a base64 field: null when it does not decode or exceeds maxBytes.
 * @param {unknown} str
 * @param {number} maxBytes
 * @returns {string|null}
 */
export function cleanBase64(str, maxBytes) {
  const bytes = decodeBytes(str, maxBytes);
  return bytes ? encodeBytes(bytes) : null;
}

// ---------------------------------------------------------------------------------------------
// Sanitisers. Pure; they clamp rather than throw. Callers decide what is an error.
// ---------------------------------------------------------------------------------------------

/** @param {unknown} v */
export const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Single-line text: controls and newlines removed, trimmed, truncated.
 * @param {unknown} value @param {number} max
 */
export function cleanLine(value, max) {
  if (value == null) return "";
  return String(value).replace(CONTROL_RE, "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}

/**
 * Multi-line text: controls removed (tabs and newlines kept), CRLF normalised, truncated.
 * @param {unknown} value @param {number} max
 */
export function cleanText(value, max) {
  if (value == null) return "";
  return String(value).replace(/\r\n?/g, "\n").replace(CONTROL_RE, "").slice(0, max);
}

/** @param {unknown} name @param {string} fallback */
export function cleanName(name, fallback) {
  return cleanLine(name, LIMITS.displayName) || fallback;
}

/**
 * "#rrggbb" lowercased, or null. With allowNone, "none" is accepted too.
 * @param {unknown} value @param {boolean} [allowNone]
 */
export function cleanColor(value, allowNone = false) {
  if (allowNone && value === "none") return "none";
  return typeof value === "string" && COLOR_RE.test(value) ? value.toLowerCase() : null;
}

/**
 * The preview stored on a blip: the first LIMITS.preview characters of the text with whitespace
 * runs collapsed to one space, trimmed. (src/shared/markdown.js firstLine strips markers too; the
 * preview keeps them so it stays cheap and faithful.)
 * @param {unknown} text
 */
export function previewOf(text) {
  if (text == null) return "";
  return String(text).slice(0, LIMITS.preview * 2).replace(CONTROL_RE, "").replace(/\s+/g, " ").trim().slice(0, LIMITS.preview);
}

/** @param {unknown} value @returns {value is string} */
export function isOrderKey(value) {
  return typeof value === "string" && value.length <= LIMITS.orderKey && ORDER_RE.test(value) && isValidOrderKey(value);
}

/**
 * An order key a client may set directly: well-formed, at most LIMITS.orderKeyAccept chars, with
 * an integer head from "B" to "y", so the server can always generate a short key above and below
 * it. Other valid keys are replaced by the server (a create then goes last among its siblings).
 * @param {unknown} value
 * @returns {value is string}
 */
export function isAcceptableOrderKey(value) {
  return isOrderKey(value) && value.length <= LIMITS.orderKeyAccept && value[0] >= "B" && value[0] <= "y";
}

/** @param {unknown} v @returns {v is BlipKind} */
export function isKind(v) {
  return typeof v === "string" && /** @type {readonly string[]} */ (BLIP_KINDS).includes(v);
}

/** @param {unknown} v @returns {BlipKind|null} */
export function cleanKind(v) {
  return isKind(v) ? v : null;
}

/** @param {unknown} v @returns {v is EventKind} */
export function isEventKind(v) {
  return typeof v === "string" && /** @type {readonly string[]} */ (EVENT_KINDS).includes(v);
}

/** @param {unknown} v @returns {v is RunOp} */
export function isRunOp(v) {
  return typeof v === "string" && /** @type {readonly string[]} */ (RUN_OPS).includes(v);
}

/** @param {unknown} v @returns {v is RunState} */
export function isRunState(v) {
  return typeof v === "string" && /** @type {readonly string[]} */ (RUN_STATES).includes(v);
}

/** @param {unknown} v @returns {v is string} a TEMPLATES id shape (existence is templates.js' job) */
export function isTemplateId(v) {
  return typeof v === "string" && TEMPLATE_ID_RE.test(v);
}

/**
 * A reply anchor: {type: "end"}, or {type: "para", pos} with `pos` re-encoded canonically and at
 * most LIMITS.caretBytes decoded. Null for anything else (a missing anchor is the caller's
 * default, usually "end"). Yjs-level validity of `pos` is checked by the core.
 * @param {unknown} raw
 * @returns {Anchor|null}
 */
export function cleanAnchor(raw) {
  if (!isObject(raw)) return null;
  const a = /** @type {Record<string, unknown>} */ (raw);
  if (a.type === "end") return { type: "end" };
  if (a.type === "para") {
    const pos = cleanBase64(a.pos, LIMITS.caretBytes);
    return pos && pos.length ? { type: "para", pos } : null;
  }
  return null;
}

/**
 * Shape-checks and cleans one blip op. Existence, versions and locks are the core's job. Returns
 * the cleaned op, or the error code and message to report at this index.
 * @param {unknown} raw
 * @returns {{ok: true, op: BlipOp} | {ok: false, code: OpError["code"], message: string}}
 */
export function cleanBlipOp(raw) {
  if (!isObject(raw)) return { ok: false, code: "invalid_op", message: "op must be an object" };
  const r = /** @type {Record<string, any>} */ (raw);
  if (!isBlipId(r.blipId)) return { ok: false, code: "invalid_id", message: "blipId must be b_ plus 12 hex" };
  const blipId = r.blipId;
  switch (r.op) {
    case "create": {
      if (r.parentId !== null && r.parentId !== undefined && !isBlipId(r.parentId)) {
        return { ok: false, code: "invalid_id", message: "parentId must be null or a blip id" };
      }
      if (r.kind !== undefined && !/** @type {readonly string[]} */ (CLIENT_KINDS).includes(r.kind)) {
        return { ok: false, code: "invalid_op", message: "kind must be note or brief" };
      }
      if (r.anchor !== undefined && r.anchor !== null && !cleanAnchor(r.anchor)) {
        return { ok: false, code: "invalid_ref", message: "anchor must be {type: end} or {type: para, pos}" };
      }
      /** @type {BlipOp} */
      const op = { op: "create", blipId, parentId: r.parentId ?? null };
      /** @type {Anchor|null} */
      const anchor = op.parentId === null ? null : r.anchor == null ? { type: "end" } : cleanAnchor(r.anchor);
      if (anchor) op.anchor = anchor;
      if (r.kind !== undefined) op.kind = r.kind;
      if (isAcceptableOrderKey(r.order)) op.order = r.order;
      if (r.text !== undefined && r.text !== null) {
        const text = cleanText(r.text, LIMITS.textChars + 1);
        if (text.length > LIMITS.textChars) return { ok: false, code: "limit", message: `text exceeds ${LIMITS.textChars} characters` };
        op.text = text;
      }
      return { ok: true, op };
    }
    case "delete":
    case "restore": {
      const baseVersion = cleanSeq(r.baseVersion);
      if (baseVersion === null) return { ok: false, code: "invalid_op", message: "baseVersion required" };
      return { ok: true, op: { op: r.op, blipId, baseVersion } };
    }
    case "move": {
      const baseVersion = cleanSeq(r.baseVersion);
      if (baseVersion === null) return { ok: false, code: "invalid_op", message: "baseVersion required" };
      if (r.parentId !== null && !isBlipId(r.parentId)) return { ok: false, code: "invalid_id", message: "parentId must be null or a blip id" };
      if (r.parentId === blipId) return { ok: false, code: "invalid_ref", message: "a blip cannot be its own parent" };
      if (r.anchor !== undefined && r.anchor !== null && !cleanAnchor(r.anchor)) {
        return { ok: false, code: "invalid_ref", message: "anchor must be {type: end} or {type: para, pos}" };
      }
      /** @type {BlipOp} */
      const op = { op: "move", blipId, baseVersion, parentId: r.parentId };
      /** @type {Anchor|null} */
      const anchor = r.parentId === null ? null : r.anchor == null ? { type: "end" } : cleanAnchor(r.anchor);
      if (anchor) op.anchor = anchor;
      if (isAcceptableOrderKey(r.order)) op.order = r.order;
      return { ok: true, op };
    }
    default:
      return { ok: false, code: "invalid_op", message: "op must be create, delete, restore or move" };
  }
}

/**
 * Cleans a participant op. Null when unusable.
 * @param {unknown} raw
 * @returns {ParticipantOp|null}
 */
export function cleanParticipantOp(raw) {
  if (!isObject(raw)) return null;
  const r = /** @type {Record<string, any>} */ (raw);
  if (r.op === "remove") return isParticipantId(r.id) ? { op: "remove", id: r.id } : null;
  if (r.op !== "upsert" || !isObject(r.participant) || !isParticipantId(r.participant.id)) return null;
  return {
    op: "upsert",
    participant: {
      id: r.participant.id,
      name: cleanName(r.participant.name, DEFAULT_NAME),
      color: cleanColor(r.participant.color) ?? DEFAULT_COLOR,
    },
  };
}

/**
 * Blip ids from an untrusted list: strings that validate, de-duplicated, capped. Anything that is
 * not an array yields [].
 * @param {unknown} raw @param {number} max
 * @returns {string[]}
 */
export function cleanBlipIds(raw, max) {
  if (!Array.isArray(raw)) return [];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const v of raw) {
    if (out.length >= max) break;
    if (isBlipId(v) && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

/**
 * The content fields of a propose() call, cleaned and capped. Null when targetId is not a blip id
 * or the replacement is missing (a proposal must propose something; an empty quote means the
 * whole text). Unknown source ids are the core's job to drop.
 * @param {unknown} raw
 * @returns {{targetId: string, quote: string, replacement: string, summary: string, sources: string[]}|null}
 */
export function cleanProposalFields(raw) {
  if (!isObject(raw)) return null;
  const r = /** @type {Record<string, any>} */ (raw);
  if (!isBlipId(r.targetId) || typeof r.replacement !== "string") return null;
  return {
    targetId: r.targetId,
    quote: cleanText(r.quote, LIMITS.proposalFieldChars),
    replacement: cleanText(r.replacement, LIMITS.proposalFieldChars),
    summary: cleanLine(r.summary, LIMITS.summary),
    sources: cleanBlipIds(r.sources, LIMITS.sources),
  };
}

/**
 * The content fields of a recordDecision() call, cleaned and capped. Null when threadId is not a
 * blip id or the decision text is empty after cleaning.
 * @param {unknown} raw
 * @returns {{threadId: string, text: string, rationale: string, dissent: string, nextSteps: string, supersedes: string|null}|null}
 */
export function cleanDecisionFields(raw) {
  if (!isObject(raw)) return null;
  const r = /** @type {Record<string, any>} */ (raw);
  if (!isBlipId(r.threadId)) return null;
  const text = cleanText(r.text, LIMITS.textChars).trim();
  if (!text) return null;
  return {
    threadId: r.threadId,
    text,
    rationale: cleanText(r.rationale, LIMITS.decisionFieldChars).trim(),
    dissent: cleanText(r.dissent, LIMITS.decisionFieldChars).trim(),
    nextSteps: cleanText(r.nextSteps, LIMITS.decisionFieldChars).trim(),
    supersedes: isBlipId(r.supersedes) ? r.supersedes : null,
  };
}

/**
 * Siblings in display order: by order key, ties by id.
 * @param {Pick<Blip, "order"|"id">} a
 * @param {Pick<Blip, "order"|"id">} b
 */
export function compareBlips(a, b) {
  if (a.order !== b.order) return a.order < b.order ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The thread a blip belongs to: its root's id (walks parentId; a dangling parent counts as a root).
 * @param {string} id
 * @param {Record<string, Pick<Blip, "id"|"parentId">>} blips
 * @returns {string}
 */
export function rootOf(id, blips) {
  let cur = id;
  for (let guard = 0; guard < 10_000; guard++) {
    const b = blips[cur];
    if (!b || b.parentId === null || !blips[b.parentId]) return cur;
    cur = b.parentId;
  }
  return cur;
}

/**
 * Depth of a blip (a root is 1; unknown parents stop the walk).
 * @param {string} id
 * @param {Record<string, Pick<Blip, "id"|"parentId">>} blips
 */
export function depthOf(id, blips) {
  let depth = 1;
  let cur = blips[id];
  while (cur && cur.parentId !== null && blips[cur.parentId] && depth < 10_000) {
    depth++;
    cur = blips[cur.parentId];
  }
  return depth;
}

const ASCII_RE = /^[\u0000-\u007f]*$/;
const LATIN1_RE = /^[\u0000-\u00ff]*$/;
const encoder = new TextEncoder();

/** Largest V8 serialisation of a number: a tag and an 8-byte double. */
const V8_NUMBER = 9;
/** V8 overhead of a string beyond its code units: a tag, a length varint and alignment padding. */
const V8_STRING = 5;
/** V8 overhead of an array or object: begin and end tags, length and count varints. */
const V8_CONTAINER = 10;
/** V8 overhead per array element: a holey array is written sparse, each value after its index. */
const V8_ELEMENT = 4;
/** V8 overhead of a typed array beyond its bytes: ArrayBuffer tag and length, view tag, offset, length, flags. */
const V8_TYPED_ARRAY = 16;

/** @param {string} str */
function stringBytes(str) {
  const json = JSON.stringify(str);
  const utf8 = ASCII_RE.test(json) ? json.length : encoder.encode(json).length;
  const v8 = (LATIN1_RE.test(str) ? str.length : 2 * str.length) + V8_STRING;
  return Math.max(utf8, v8);
}

/** @param {unknown} value */
function valueBytes(value) {
  switch (typeof value) {
    case "string": return stringBytes(value);
    case "number": return Math.max(V8_NUMBER, String(value).length);
    case "object": {
      if (value === null) return 5;
      if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
        return /** @type {ArrayBufferView|ArrayBuffer} */ (value).byteLength + V8_TYPED_ARRAY;
      }
      let n = V8_CONTAINER;
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) n += valueBytes(value[i]) + V8_ELEMENT;
        return n;
      }
      for (const key of Object.keys(value)) {
        n += stringBytes(key) + 2 + valueBytes(/** @type {any} */ (value)[key]);
      }
      return n;
    }
    default: return 5; // booleans, undefined, anything else
  }
}

/**
 * Upper bound of the stored size of `value` in bytes: at least the UTF-8 length of its JSON and at
 * least its V8 serialisation (what Durable Object storage and RPC write). A number counts as
 * 9 bytes or its JSON length, whichever is more; a string as its UTF-8 JSON or its code units
 * (2 bytes each once any character is outside Latin-1), whichever is more; arrays and objects add
 * their tags and separators, and each array element 4 more (V8 writes a holey array sparse). A
 * Uint8Array (or any ArrayBuffer view) counts its byteLength plus 16: V8 writes the buffer and a
 * view header; its JSON form is not considered, since typed arrays are never JSON-serialised here.
 * @param {unknown} value
 */
export function storedBytes(value) {
  return valueBytes(value) + 2; // + the serialisation header
}

/**
 * Cleans a presence update onto the previous state. Fields absent from `raw` keep `previous`;
 * `null` clears. A malformed or over-long caret becomes null on its own (the rest of the update
 * still applies); without a blipId, editing is false and both carets null. `clientId` is taken as
 * given.
 * @param {unknown} raw
 * @param {string} clientId
 * @param {PresenceState|null} previous
 * @returns {PresenceState}
 */
export function cleanPresence(raw, clientId, previous) {
  const r = /** @type {Record<string, any>} */ (isObject(raw) ? raw : {});
  const has = (/** @type {string} */ k) => Object.hasOwn(r, k);

  let blipId = previous?.blipId ?? null;
  if (has("blipId")) blipId = isBlipId(r.blipId) ? r.blipId : null;

  let editing = previous?.editing ?? false;
  if (has("editing")) editing = r.editing === true;

  let anchor = previous?.anchor ?? null;
  if (has("anchor")) anchor = cleanBase64(r.anchor, LIMITS.caretBytes) || null;
  let head = previous?.head ?? null;
  if (has("head")) head = cleanBase64(r.head, LIMITS.caretBytes) || null;

  if (blipId === null) {
    editing = false;
    anchor = null;
    head = null;
  }

  return {
    clientId,
    name: has("name") ? cleanName(r.name, previous?.name ?? DEFAULT_NAME) : previous?.name ?? DEFAULT_NAME,
    color: (has("color") ? cleanColor(r.color) : null) ?? previous?.color ?? DEFAULT_COLOR,
    blipId, editing, anchor, head,
  };
}
