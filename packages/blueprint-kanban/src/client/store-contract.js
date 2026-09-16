// @ts-check
// The interface between the sync layer (src/client/model, src/client/sync) and the UI
// (src/client/ui). Types only. The UI never calls `gadget` directly; the store never touches the
// DOM. `createStore` lives in src/client/sync/store.js.

/** @typedef {import("../shared/protocol.js").BoardSnapshot} BoardSnapshot */
/** @typedef {import("../shared/protocol.js").Card} Card */
/** @typedef {import("../shared/protocol.js").Column} Column */
/** @typedef {import("../shared/protocol.js").Label} Label */
/** @typedef {import("../shared/protocol.js").Comment} Comment */
/** @typedef {import("../shared/protocol.js").HistoryEntry} HistoryEntry */

/**
 * @typedef {object} Viewer
 * @property {string} clientId  random per page load. The store replaces it (emitting a "viewer"
 *   change) if the server reports it is held by another live session ("clientId in use").
 * @property {string} name      "" until the user has chosen one
 * @property {string} color     "#rrggbb"
 */

/**
 * A collaborator currently present (never includes the viewer's own clientId).
 * @typedef {object} Peer
 * @property {string} clientId
 * @property {string} name
 * @property {string} color
 * @property {string|null} openCardId
 * @property {string|null} dragCardId
 * @property {string|null} hoverColumnId
 * @property {number} lastSeen  local clock ms; peers unseen for PRESENCE_STALE_MS are removed
 */

/**
 * An unresolved conflict on a content edit: someone else changed the same fields first.
 * @typedef {object} CardConflict
 * @property {string} cardId
 * @property {Partial<Card>} mine      the fields this viewer tried to save
 * @property {Card|null} theirs        authoritative card (null if it was deleted)
 */

/**
 * @typedef {"connecting"|"live"|"reconnecting"} ConnectionState
 */

/**
 * @typedef {object} ClientState
 * @property {BoardSnapshot} board          optimistic view: server state plus pending local ops
 * @property {Viewer} viewer
 * @property {Map<string, Peer>} peers
 * @property {ConnectionState} connection
 * @property {Map<string, CardConflict>} conflicts  keyed by card id
 * @property {number} pending               local ops not yet acknowledged
 * @property {HistoryEntry[]} history       most recent last; seeded by loadHistory(), then live
 * @property {string|null} lastError        last error: a server validation error (including "limit"),
 *   or a change the store gave up on (a move or delete that kept conflicting, a request that
 *   kept failing). Such changes are rolled back, never dropped silently.
 */

/**
 * What changed, so the UI can re-render narrowly. `columns` lists affected column ids (a moved
 * card affects both); `all` means re-render the whole board.
 * @typedef {object} Change
 * @property {"snapshot"|"operation"|"presence"|"conflict"|"connection"|"comment"|"history"|"viewer"|"error"} kind
 * @property {boolean} [all]
 * @property {string[]} [columns]
 * @property {string[]} [cards]
 * @property {Comment} [comment]
 */

/**
 * @typedef {object} Store
 * @property {() => ClientState} getState
 * @property {(listener: (state: ClientState, change: Change) => void) => () => void} subscribe
 *
 * Cards. All return immediately after the optimistic local apply; the server round trip happens
 * in the background with conflict handling as described in src/README.md.
 * @property {(columnId: string, fields: Partial<Card>, beforeCardId?: string|null) => string} createCard
 *   returns the new card id; placed before `beforeCardId`, or at the end when null/omitted
 * @property {(cardId: string, patch: Partial<Card>) => void} updateCard
 * @property {(cardId: string, toColumnId: string, beforeCardId: string|null) => void} moveCard
 * @property {(cardId: string) => void} deleteCard
 *
 * Columns and board.
 * @property {(name: string, index?: number) => string} createColumn
 * @property {(columnId: string, name: string) => void} renameColumn
 * @property {(columnId: string, index: number) => void} moveColumn
 * @property {(columnId: string, collapsed: boolean) => void} setColumnCollapsed
 * @property {(columnId: string) => void} deleteColumn
 * @property {(title: string) => void} setTitle
 * @property {(labelId: string|null, name: string, color: string) => string} upsertLabel  null creates
 * @property {(labelId: string) => void} deleteLabel
 *
 * Comments and history.
 * @property {(cardId: string) => Promise<Comment[]>} loadComments
 * @property {(cardId: string, text: string) => Promise<Comment>} addComment
 * @property {(limit?: number) => Promise<HistoryEntry[]>} loadHistory
 * @property {(historyId: string) => Promise<void>} undo
 *
 * Conflicts.
 * @property {(cardId: string, choice: "overwrite"|"discard") => void} resolveConflict
 *
 * Presence and identity.
 * @property {(p: {openCardId?: string|null, dragCardId?: string|null, hoverColumnId?: string|null}) => void} setPresence
 * @property {(name: string, color?: string) => void} setViewer
 * @property {() => void} dispose  leave presence, stop timers
 */

/**
 * @typedef {object} StoreOptions
 * @property {any} gadget        RPC stub to the Gadget (the `gadget` global in the iframe)
 * @property {any} RpcTarget     the `RpcTarget` global (injectable for tests)
 * @property {Viewer} viewer
 * @property {{setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout,
 *   setInterval: typeof setInterval, clearInterval: typeof clearInterval, now: () => number}} [timers]
 */

export {};
