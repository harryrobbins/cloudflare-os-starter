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
 * @typedef {"connecting"|"live"|"reconnecting"} ConnectionState
 */

/**
 * @typedef {object} ClientState
 * @property {BoardSnapshot} board     optimistic view: server state plus pending local ops
 * @property {Viewer} viewer
 * @property {Map<string, Peer>} peers
 * @property {ConnectionState} connection
 * @property {number} pending          local ops not yet acknowledged
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
 * Presence. Fields left out keep their value. Throttled to one send per PRESENCE_SEND_MS; the
 * last value is always sent. `transforms` and `stroke` should be cleared ([] / null) when the
 * gesture ends, in the same tick as the commit.
 * @property {(p: Partial<Pick<PresenceState, "cursor"|"viewport"|"selection"|"transforms"|"stroke"|"editingId">>) => void} setPresence
 * @property {() => void} flushPresence  send the pending presence now (e.g. on pointer up)
 * @property {(name: string, color?: string) => void} setViewer
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
 * @property {() => void} [onUnrecoverable]  called at most once, when the connection looks dead
 *   for good (3 failed subscribes in a row, or 8 s non-live with no call succeeding). On the
 *   platform the iframe's `gadget` stub stays broken after a facet restart (code edit), so main.js
 *   reloads the frame. The store keeps retrying regardless.
 */

export {};
