// @ts-check
// The interface between the sync layer (src/client/sync, src/client/model) and the UI
// (src/client/ui). Types only. The UI never calls `gadget` directly; the store never touches the
// DOM. `createStore` lives in src/client/sync/store.js.
//
// Committed versus ephemeral: the UI calls the object methods only when a gesture completes
// (pointer up, text blur, a colour click). While a gesture is in progress it calls setPresence
// with transforms / stroke, which peers render as ghosts and which is never stored.

/** @typedef {import("../shared/protocol.js").BoardSnapshot} BoardSnapshot */
/** @typedef {import("../shared/protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {import("../shared/protocol.js").ObjectPatch} ObjectPatch */
/** @typedef {import("../shared/protocol.js").HistoryEntry} HistoryEntry */
/** @typedef {import("../shared/protocol.js").PresenceState} PresenceState */

/**
 * @typedef {object} Viewer
 * @property {string} clientId  random per page load. The store replaces it (emitting a "viewer"
 *   change) if the server reports it is held by another live session ("clientId in use").
 * @property {string} name      "" until the user has chosen one
 * @property {string} color     "#rrggbb"
 */

/**
 * A collaborator currently present (never the viewer's own clientId): their latest presence plus
 * `lastSeen` (local clock ms). Peers unseen for PRESENCE_STALE_MS are removed.
 * @typedef {PresenceState & {lastSeen: number}} Peer
 */

/**
 * The connection/save state machine (src/client/sync/connection.js):
 *   connecting         no initial snapshot yet;
 *   live               subscribed and nothing pending: every local change is acknowledged ("Saved");
 *   saving             subscribed with queued or in-flight changes;
 *   reconnecting       the subscription or RPC target is being replaced; the queue is kept;
 *   recovery-required  the automatic recovery budget is exhausted; pending work may exist. Retries
 *                      continue, and a later success returns to live or saving;
 *   read-only          the session lacks edit authority (reserved for verified sessions; not yet produced).
 * @typedef {"connecting"|"live"|"saving"|"reconnecting"|"recovery-required"|"read-only"} ConnectionState
 */

/**
 * @typedef {object} ClientState
 * @property {BoardSnapshot} board     optimistic view: server state plus pending local ops
 * @property {Viewer} viewer
 * @property {Map<string, Peer>} peers
 * @property {ConnectionState} connection
 * @property {number} pending          local ops not yet acknowledged (same as pendingCount; kept for callers)
 * @property {number} pendingCount     local ops not yet acknowledged
 * @property {number|null} oldestPendingAt  local clock ms when the oldest of them was made; null when none
 * @property {number} lastAcknowledgedRevision  board revision up to which this client has seen every
 *   change confirmed (snapshots, events and its own acknowledged requests)
 * @property {boolean} riskOfLoss      reloading now may lose a change: something is unacknowledged and
 *   the link is down, or the oldest change has waited SLOW_SAVE_MS or more
 * @property {boolean} canUndo
 * @property {boolean} canRedo
 * @property {HistoryEntry[]} history  most recent last; seeded by loadHistory(), then live
 * @property {string|null} lastError   last error worth showing: a server validation error (e.g.
 *   "limit"), or a change the store gave up on. Such changes are rolled back, never dropped silently.
 */

/**
 * What changed, so the UI can re-render narrowly.
 *   snapshot   everything may have changed (initial load, resubscribe): rebuild.
 *   objects    `objects` lists ids whose optimistic state changed (created, updated or deleted).
 *              The UI patches only those elements (plus connectors attached to them).
 *   structure  title or background changed.
 *   presence   `peers` lists client ids that joined, changed or left.
 *   connection `connection` or `riskOfLoss` changed (not emitted for pendingCount alone; an
 *              "objects" change with an empty list covers that).
 *   flash      `objects` lists ids where a local change lost to a concurrent one (text or style
 *              kept theirs, or the object was deleted by someone else); the UI briefly highlights them.
 * @typedef {object} Change
 * @property {"snapshot"|"objects"|"structure"|"presence"|"connection"|"history"|"viewer"|"error"|"flash"|"undo"} kind
 * @property {string[]} [objects]
 * @property {string[]} [peers]
 */

/**
 * @typedef {object} Store
 * @property {() => ClientState} getState
 * @property {(listener: (state: ClientState, change: Change) => void) => () => void} subscribe
 *
 * Objects. Each call applies optimistically, returns immediately, and is ONE undo step. The
 * round trip happens in the background (see "Conflicts" below).
 * @property {(objects: Array<Partial<WhiteboardObject> & {type: WhiteboardObject["type"]}>) => string[]} createObjects
 *   Fills in `id` (when absent) and `z` (when absent: above everything, in array order) and
 *   returns the ids. Pen objects must carry normalised points (geometry.normalizeStroke).
 * @property {(updates: Array<{id: string, patch: ObjectPatch}>) => void} updateObjects
 *   Patches several objects at once (a multi-object move is one call). Unknown ids are ignored.
 *   Consecutive updates of the same fields of the same objects that have not been sent yet are
 *   coalesced into one op; each call is still its own undo step.
 * @property {(ids: string[]) => void} deleteObjects
 *   Also removes connectors attached to any of them (optimistically; the server does the same).
 * @property {(ids: string[], where: "front"|"back") => void} reorder
 *   Moves the objects above (or below) every other object of their stacking group, keeping their
 *   relative order.
 * @property {(patch: {title?: string, background?: "dots"|"grid"|"plain"}) => void} setStructure
 *
 * Local undo and redo of this viewer's own changes (object creates, updates, deletes, reorders).
 * Undo applies the inverse as a new change against current versions; parts that no longer apply
 * (the object was deleted by someone else) are skipped.
 * @property {() => void} undo
 * @property {() => void} redo
 *
 * Server history (activity panel, and undoing a change made before a reload).
 * @property {(limit?: number) => Promise<HistoryEntry[]>} loadHistory
 * @property {(historyId: string) => Promise<void>} undoHistory
 *
 * Presence (src/client/sync/presence.js). Fields left out keep their value. Boundaries (selection
 * or editing changes, gesture start/end, pointer leave/re-entry) are sent at once; movement is
 * capped at about 20 Hz (less with many peers or a slow gadget) and states equal once rounded are
 * skipped; the last value is always sent. `transforms` and `stroke` should be cleared ([] / null)
 * when the gesture ends, in the same tick as the commit.
 * @property {(p: Partial<Pick<PresenceState, "cursor"|"viewport"|"selection"|"transforms"|"stroke"|"editingId">>) => void} setPresence
 * @property {() => void} flushPresence  send the pending presence now (e.g. on pointer up)
 * @property {(visible: boolean) => void} setVisibility  document visibility: a hidden tab clears its
 *   cursor and gesture ghosts once, then sends heartbeats only
 * @property {(name: string, color?: string) => void} setViewer
 *
 * Connection seam and recovery.
 * @property {(gadget: any) => void} replaceTarget  swap the RPC stub (e.g. the host refreshed it after
 *   a facet restart) without reloading: re-subscribes on it, reconciles from its snapshot and replays
 *   only unacknowledged requests with their original request ids. Queue and undo stacks are kept.
 * @property {() => RecoveryData} getRecoveryData  data-only copy of what a reload could lose, for
 *   the recovery screen's download. Never store it in window.name or logs.
 * @property {() => void} dispose  leave presence, stop timers
 *
 * Conflicts (handled inside the store, see src/README.md):
 *   geometry (x, y, w, h, rot) changed by both: my delta is re-applied on top of theirs and retried;
 *   text, style, points, connector fields changed by both: theirs is kept, "flash" is emitted;
 *   fields only I changed: retried as is;
 *   the object was deleted meanwhile: my update is dropped, "flash" is emitted;
 *   a delete that conflicts is retried (delete wins).
 */

/**
 * @typedef {object} StoreOptions
 * @property {any} gadget        RPC stub to the Gadget (the `gadget` binding in the iframe)
 * @property {any} RpcTarget     the `RpcTarget` binding (injectable for tests)
 * @property {Viewer} viewer
 * @property {{setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout,
 *   setInterval: typeof setInterval, clearInterval: typeof clearInterval, now: () => number}} [timers]
 * @property {() => void} [onUnrecoverable]  called at most once per outage, when the connection
 *   looks dead for good (3 failed subscribes in a row, 8 s non-live with no call succeeding, not
 *   counting time waiting on a subscribe call, or one subscribe call unsettled for 45 s); the state
 *   is then recovery-required. On the platform the iframe's `gadget` stub stays broken after a facet
 *   restart (code edit), so main.js reloads the frame, but only when nothing is unacknowledged
 *   (otherwise it shows the recovery screen). The store keeps retrying regardless, and a success
 *   (or replaceTarget) starts a new outage budget.
 */

/**
 * A data-only recovery file: the last acknowledged server state plus the pending changes in
 * queue order. No request ids, sessions or executable content.
 * @typedef {object} RecoveryData
 * @property {"whiteboard-recovery"} format
 * @property {number} version
 * @property {string} savedAt                 ISO time
 * @property {number} lastAcknowledgedRevision
 * @property {BoardSnapshot} board            the last acknowledged server state
 * @property {Array<{kind: "create"|"update"|"delete"|"structure", id?: string, object?: any, patch?: any,
 *   structure?: any, baseVersion?: number|null, queuedAt: number|null, sent: boolean}>} pending
 *   `sent`: a request carrying it went out and its outcome is unknown (it may already be applied)
 */

export {};
