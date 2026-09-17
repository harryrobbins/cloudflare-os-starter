// @ts-check
// The interface between the sync layer (src/client/sync: structure store plus text channel) and
// the UI (src/client/ui). Types only. The UI never calls `gadget` directly; the store never
// touches the DOM. `createStore` lives in src/client/sync/store.js.
//
// Three channels, one store:
//   structure  blips, meta, participants, runs: optimistic where cheap (creates, soft deletes,
//              title), round trip in the background, versioned on the server.
//   text       one Y.Doc per OPEN blip (openBlip). Local edits go into the Y.Text; the store
//              batches the resulting updates (TEXT_IDLE_MS / TEXT_FLUSH_BYTES), keeps one pushText
//              in flight, applies remote text events, detects gaps (prevTextSeq) and resyncs
//              through openBlip with a state vector. Per-blip `saving` tells the UI what to show.
//   presence   where the viewer is and whether they are editing, with carets while editing.
//              Throttled; never stored.

/** @typedef {import("../shared/protocol.js").WaveMeta} WaveMeta */
/** @typedef {import("../shared/protocol.js").WaveSnapshot} WaveSnapshot */
/** @typedef {import("../shared/protocol.js").Blip} Blip */
/** @typedef {import("../shared/protocol.js").BlipKind} BlipKind */
/** @typedef {import("../shared/protocol.js").Anchor} Anchor */
/** @typedef {import("../shared/protocol.js").Run} Run */
/** @typedef {import("../shared/protocol.js").RunOp} RunOp */
/** @typedef {import("../shared/protocol.js").WaveEvent} WaveEvent */
/** @typedef {import("../shared/protocol.js").PresenceState} PresenceState */
/** @typedef {import("../shared/protocol.js").OperationResult} OperationResult */
/** @typedef {import("../shared/protocol.js").BlipResult} BlipResult */
/** @typedef {import("../shared/protocol.js").RunResult} RunResult */
/** @typedef {import("../shared/protocol.js").ReviewProposalResult} ReviewProposalResult */
/** @typedef {import("../shared/protocol.js").GetChangesResult} GetChangesResult */
/** @typedef {import("../shared/protocol.js").GetPlaybackResult} GetPlaybackResult */
/** @typedef {import("../shared/protocol.js").ErrorResult} ErrorResult */

/**
 * @typedef {object} Viewer
 * @property {string} clientId  random per page load. The store replaces it (emitting a "viewer"
 *   change) if the server reports it is held by another live session ("clientId in use").
 * @property {string} participantId  stable across reloads (carried in window.name); the id the
 *   viewer is listed under in meta.participants
 * @property {string} name      "" until the user has chosen one
 * @property {string} color     "#rrggbb"
 */

/**
 * A collaborator currently present (never the viewer's own clientId): their latest presence plus
 * `lastSeen` (local clock ms). Peers unseen for PRESENCE_STALE_MS are removed.
 * @typedef {PresenceState & {lastSeen: number}} Peer
 */

/**
 * @typedef {"connecting"|"live"|"reconnecting"} ConnectionState
 */

/**
 * Per-blip text channel state, present only for blips the viewer has opened (openBlip) and for
 * a short while after closing (until the last push is acknowledged).
 *   saved    every local change has been acknowledged by the server
 *   saving   a push is pending or in flight ("Saving…")
 *   failed   the last push was refused (blip_full, locked) or gave up; `lastError` says why. The
 *            local doc keeps the text; the UI offers "Reply instead" for blip_full.
 * @typedef {object} TextState
 * @property {number} textSeq          the blip's textSeq as this client knows it
 * @property {"saved"|"saving"|"failed"} saving
 * @property {boolean} resyncing       a gap was detected and openBlip is in flight
 * @property {string|null} lastError   an ErrorCode when saving is "failed"
 */

/**
 * A blip opened for editing or live reading. The Y.Doc is owned by the store: the editor binds
 * to `text` (doc.getText("t")), transacts with its own origin, and calls close() when the editor
 * or card no longer needs live text. Several openers of one blip share one handle count; the doc
 * is released when the last one closes and every push is acknowledged.
 * @typedef {object} TextHandle
 * @property {import("yjs").Doc} doc
 * @property {import("yjs").Text} text
 * @property {string} blipId
 * @property {() => Promise<void>} whenSaved  resolves once no push is pending for this blip
 * @property {() => void} close
 */

/**
 * @typedef {object} ClientState
 * @property {WaveMeta} meta
 * @property {Record<string, Blip>} blips   optimistic view: server state plus pending local ops;
 *   soft-deleted blips stay in the map with deleted: true
 * @property {Record<string, Run>} runs     by id
 * @property {number} seq                   last event sequence seen (meta.seq)
 * @property {{model: boolean}} capabilities  from the snapshot; `model` false disables Ask agent
 * @property {Viewer} viewer
 * @property {Map<string, Peer>} peers
 * @property {ConnectionState} connection
 * @property {number} pending               structure requests not yet acknowledged
 * @property {Record<string, TextState>} text  per opened blip (see TextState)
 * @property {"saved"|"saving"|"failed"} saving  the worst of every TextState plus pending structure
 * @property {string|null} lastError        last error worth showing (an ErrorCode or a server
 *   validation message); changes the store gave up on are rolled back, never dropped silently
 */

/**
 * What changed, so the UI can re-render narrowly.
 *   snapshot    everything may have changed (initial load, resubscribe): rebuild.
 *   blips       `blips` lists ids whose record changed (created, updated, deleted, restored,
 *               proposal state, decision). The read view re-renders those cards only.
 *   meta        title, rootOrder, participants, template or earliestSeq changed.
 *   presence    `peers` lists client ids that joined, changed or left.
 *   connection  the connection state changed.
 *   text        `blips` lists ids whose Y.Text received a REMOTE update (local edits do not emit;
 *               the editor already sees them). Cards not in edit mode re-render their read view.
 *   runs        `runs` lists run ids created or changed.
 *   saving      per-blip or overall saving state changed; `blips` lists the ids affected.
 *   error       `lastError` changed.
 *   viewer      clientId, name or colour changed.
 *   events      `events` carries the WaveEvents of the last operation (for the live region and
 *               the History tab); emitted together with the blips/meta change it came with.
 * @typedef {object} Change
 * @property {"snapshot"|"blips"|"meta"|"presence"|"connection"|"text"|"runs"|"saving"|"error"|"viewer"|"events"} kind
 * @property {string[]} [blips]
 * @property {string[]} [peers]
 * @property {string[]} [runs]
 * @property {WaveEvent[]} [events]
 */

/**
 * @typedef {object} Store
 * @property {() => ClientState} getState
 * @property {(listener: (state: ClientState, change: Change) => void) => () => void} subscribe
 *
 * Structure. Creates and soft-deletes apply optimistically and return at once; the round trip
 * happens in the background and a refusal rolls the change back with an "error" change.
 * @property {(args: {parentId: string|null, anchor?: Anchor, kind?: "note"|"brief", text?: string, after?: string|null}) => string} createBlip
 *   Returns the new id. `after` names the sibling to insert after (default: last); the store
 *   computes the order key. The Y.Text of the new blip can be opened at once (openBlip); text
 *   typed before the create is acknowledged is queued behind it.
 * @property {(id: string) => void} deleteBlip    soft delete; refused for decisions ("locked")
 * @property {(id: string) => void} restoreBlip
 * @property {(title: string) => void} setTitle
 * @property {(templateId: string) => Promise<OperationResult|ErrorResult>} applyTemplate
 *   Applies src/shared/templates.js on an empty Wave (creates plus structure.template) in one
 *   request. Resolves when acknowledged; "unchanged" when someone else was first.
 *
 * Text. See TextHandle. Rejects with ErrorResult for an unknown or deleted blip.
 * @property {(id: string) => Promise<TextHandle>} openBlip
 * @property {(id: string) => Promise<void>} flushText  push pending updates for the blip now
 *   (e.g. before a self-reload); resolves when acknowledged or failed
 * @property {(id: string) => string|null} pendingText  the local text of an open blip whose
 *   pushes are pending or failed, else null. main.js writes it to window.name before a reload and
 *   offers it back as "Re-insert unsaved text".
 * @property {(id: string) => string|null} pendingUpdate  the unacknowledged local edits of an open
 *   blip (in flight, awaiting replay and queued) merged into one base64 Yjs V2 update, else null.
 *   Carried with pendingText; "Re-insert unsaved text" re-applies it (text.js restoreUpdate), which
 *   restores only what the server never acknowledged.
 *
 * Agent runs, proposals, decisions. Round trips; results are also reflected through "runs" and
 * "blips" changes when the broadcast arrives.
 * @property {(args: {op: RunOp, blipIds?: string[], sinceSeq?: number, instructions?: string}) => Promise<RunResult>} askAgent
 * @property {(runId: string) => Promise<RunResult>} cancelRun
 * @property {(runId: string) => Promise<RunResult>} retryRun  askAgent again with the run's op,
 *   scope and instructions (for failed, cancelled and unknown runs)
 * @property {(proposalId: string, decision: "accept"|"reject") => Promise<ReviewProposalResult>} reviewProposal
 *   Sends the proposal blip's current version as expectedVersion.
 * @property {(args: {threadId: string, text: string, rationale: string, dissent?: string, nextSteps?: string, supersedes?: string}) => Promise<BlipResult>} recordDecision
 * @property {(args: {parentId: string, text: string, anchor?: Anchor}) => Promise<BlipResult>} reply
 *   Server-side create with text (used by "Post to wave" for a catch-up result); interactive
 *   replies use createBlip + openBlip so others see the reply as it is typed.
 *
 * History and export. Plain reads; nothing is cached.
 * @property {(afterSeq: number, limit?: number) => Promise<GetChangesResult>} getChanges
 * @property {(blipId: string, fromSeq?: number, toSeq?: number) => Promise<GetPlaybackResult>} getPlayback
 *   base.state and updates[].update are base64 (decodeBytes) Yjs V2 data.
 * @property {(args?: {decisions?: boolean}) => Promise<string>} exportMarkdown
 * @property {(args?: {sinceSeq?: number, threadId?: string}) => Promise<string>} getWaveMarkdown
 *
 * Presence. Fields left out keep their value; null clears. Throttled to one send per
 * PRESENCE_SEND_MS; the last value is always sent. `anchor` and `head` are base64 relative
 * positions (encodeBytes(Y.encodeRelativePosition(...))) and must be cleared (null) with
 * `editing: false` when the editor closes, in the same tick.
 * @property {(p: Partial<Pick<PresenceState, "blipId"|"editing"|"anchor"|"head">>) => void} setPresence
 * @property {() => void} flushPresence  send the pending presence now (e.g. on blur)
 * @property {(name: string, color?: string) => void} setViewer  also upserts the participant
 * @property {() => void} dispose  leave presence, close every text handle, stop timers
 */

/**
 * @typedef {object} StoreOptions
 * @property {any} gadget        RPC stub to the Gadget (the `gadget` binding in the iframe)
 * @property {any} RpcTarget     the `RpcTarget` binding (injectable for tests)
 * @property {Viewer} viewer
 * @property {{setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout,
 *   setInterval: typeof setInterval, clearInterval: typeof clearInterval, now: () => number}} [timers]
 * @property {() => void} [onUnrecoverable]  called at most once, when the connection looks dead
 *   for good (3 failed subscribes in a row, 8 s non-live with no call succeeding, not counting time
 *   waiting on a subscribe call, or one subscribe call unsettled for 45 s). On the platform the
 *   iframe's `gadget` stub stays broken after a facet restart (code edit), so main.js saves
 *   pendingText to window.name and reloads the frame. The store keeps retrying regardless.
 */

export {};
