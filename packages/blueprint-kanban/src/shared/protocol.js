// @ts-check
// The kanban board's contract: data shapes, wire protocol, limits and sanitisers.
// Shared by the server (src/server), the storage-agnostic rules (src/core) and the client
// (src/client). Changing anything here changes the wire protocol; do it deliberately.

// ---------------------------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} Column
 * @property {string} id         "k_" + 8 hex
 * @property {string} name
 * @property {number} version    bumped on rename; 0 never stored
 * @property {boolean} collapsed last-writer-wins, does not bump version
 */

/**
 * @typedef {object} ChecklistItem
 * @property {string} id   "i_" + 8 hex
 * @property {string} text
 * @property {boolean} done
 */

/**
 * @typedef {object} Card
 * @property {string} id           "c_" + 8 hex
 * @property {string} columnId
 * @property {string} order        fractional ordering key (src/shared/order.js); ties break on id
 * @property {string} title
 * @property {string} description  plain text, Markdown-ish
 * @property {string[]} labels     label ids
 * @property {string} assignee     free-text name ("" when unassigned)
 * @property {string|null} due     "YYYY-MM-DD" or null
 * @property {ChecklistItem[]} checklist
 * @property {number} version      starts at 1, bumped by every change including moves
 * @property {number} createdAt    epoch ms
 * @property {number} updatedAt    epoch ms
 * @property {string} createdBy    display name
 */

/**
 * @typedef {object} Label
 * @property {string} id    "l_" + 8 hex
 * @property {string} name
 * @property {string} color "#rrggbb"
 */

/**
 * @typedef {object} Comment
 * @property {string} id      "m_" + 8 hex
 * @property {string} cardId
 * @property {string} author
 * @property {string} text
 * @property {number} at      epoch ms
 */

/**
 * @typedef {object} HistoryEntry
 * @property {string} id       "h_" + 8 hex
 * @property {number} at
 * @property {string} by
 * @property {string} summary  human-readable, e.g. 'Moved "Fix login" to Done'
 * @property {Inverse|null} inverse  what undo applies; null when not undoable
 */

/**
 * Ops that reverse a history entry. Carries no baseVersion: undo is a deliberate action and is
 * applied against whatever versions are current at the time.
 * @typedef {object} Inverse
 * @property {CardOp[]} [cardOps]
 * @property {ColumnOp[]} [columnOps]
 */

/**
 * Stored under "meta".
 * @typedef {object} BoardMeta
 * @property {number} schemaVersion
 * @property {number} revision      bumped once per applied operation
 * @property {string} title
 * @property {string[]} columnOrder
 * @property {Record<string, Column>} columns
 * @property {number} lastModified
 */

/**
 * What getBoard() and subscribe() return.
 * @typedef {object} BoardSnapshot
 * @property {number} schemaVersion
 * @property {number} revision
 * @property {string} title
 * @property {string[]} columnOrder
 * @property {Record<string, Column>} columns
 * @property {Record<string, Card>} cards      keyed by card id; each card carries its columnId
 * @property {Record<string, Label>} labels
 * @property {number} lastModified
 */

// ---------------------------------------------------------------------------------------------
// Operations (client -> server)
// ---------------------------------------------------------------------------------------------

/**
 * Card operations. Every one except undo-generated ops carries `baseVersion`: the card version
 * the caller last saw (0 when creating). A stale baseVersion yields a conflict carrying the
 * authoritative card instead of a silent overwrite.
 *
 *   upsert  create (baseVersion 0, card must not exist) or patch the listed fields.
 *           `card` is a partial: only the fields present change. On create, missing fields take
 *           defaults and `order` defaults to after the column's last card.
 *   move    to `toColumnId` (may equal the current column) at `order`.
 *   delete  remove the card and its comments.
 *
 * @typedef {object} CardOp
 * @property {"upsert"|"move"|"delete"} op
 * @property {string} cardId
 * @property {string} [columnId]    upsert-create: required target column. Otherwise ignored.
 * @property {number} [baseVersion] required except in undo inverses
 * @property {Partial<Pick<Card,"title"|"description"|"labels"|"assignee"|"due"|"checklist"|"order">>} [card]
 * @property {string} [toColumnId]  move only
 * @property {string} [order]       move only; defaults to after the target column's last card
 */

/**
 * Column operations.
 *   upsert  create (baseVersion 0, inserted at `index`, default end) or patch.
 *           Renames are version-checked; `collapsed` alone is last-writer-wins.
 *   move    reorder to `index` (last-writer-wins, no version).
 *   delete  version-checked; removes the column, its cards and their comments.
 *
 * @typedef {object} ColumnOp
 * @property {"upsert"|"move"|"delete"} op
 * @property {string} columnId
 * @property {number} [baseVersion]
 * @property {{name?: string, collapsed?: boolean}} [column]
 * @property {number} [index]
 */

/**
 * Label operations, last-writer-wins. Deleting a label leaves ids on cards; readers ignore
 * unknown ids and the server strips them on the card's next write.
 * @typedef {object} LabelOp
 * @property {"upsert"|"delete"} op
 * @property {string} labelId
 * @property {{name?: string, color?: string}} [label]
 */

/**
 * @typedef {object} OperationRequest
 * @property {string} [senderId]  the client's id, echoed in the broadcast so it can skip its own
 * @property {string} [by]        display name recorded in history
 * @property {string} [requestId] idempotency key, 1-64 chars of [A-Za-z0-9:_-] (anything else is
 *   ignored as if absent). A request whose requestId the board has already recorded is not
 *   applied again; the recorded outcome is returned with `duplicate: true`. The board remembers
 *   the most recent LIMITS.requestRecords requests (at most LIMITS.requestRecordBytes).
 * @property {CardOp[]} [cardOps]
 * @property {ColumnOp[]} [columnOps]
 * @property {LabelOp[]} [labelOps]
 * @property {{title?: string}} [structure]  last-writer-wins
 */

/**
 * What the board persists (storage key "requests", newest last) for each request carrying a
 * valid requestId, in the same atomic commit as the request's changes.
 * @typedef {object} RequestRecord
 * @property {string} requestId
 * @property {string} [senderId]  the request's senderId ("" when absent); a replay only matches
 *   a record from the same sender
 * @property {number} revision  the revision the original request returned
 * @property {"applied"|"conflict"|"unchanged"} status
 * @property {{kind: "card"|"column", id: string}[]} conflicts
 * @property {OpError[]} errors
 */

/**
 * @typedef {object} Conflict
 * @property {"card"|"column"} kind
 * @property {string} id
 * @property {Card|Column|null} current  authoritative value; null when it no longer exists
 */

/**
 * @typedef {object} OpError
 * @property {"card"|"column"|"label"|"structure"} kind
 * @property {number} index  position in its op array (-1 for structure)
 * @property {string} code   "invalid_id", "unknown_card", "unknown_column", "exists", "limit" or
 *   "invalid_op". "limit" covers the count caps, the board byte budget (LIMITS.boardBytes) and a
 *   column delete that would cascade too far (LIMITS.columnDeleteCards/columnDeleteComments).
 * @property {string} message
 */

/**
 * Result of applyOperation and undo. Ops apply independently: valid ones are committed even when
 * others conflict or fail validation.
 *
 * status: "applied" when something changed and nothing conflicted; "conflict" when any op
 * conflicted (others may still have applied); "unchanged" when nothing changed and nothing
 * conflicted (errors may be present).
 *
 * duplicate: the request's requestId was already recorded, so nothing was applied. `status`,
 * `conflicts` (ids only; `current` is re-read now) and `errors` are the recorded ones, `revision`
 * is the CURRENT revision, and the diff fields are empty. No event is broadcast.
 *
 * @typedef {object} OperationResult
 * @property {"applied"|"conflict"|"unchanged"} status
 * @property {number} revision
 * @property {Card[]} upserts          cards created, edited or moved, in their final state
 * @property {{cardId: string, columnId: string}[]} deletes
 * @property {{cardId: string, fromColumnId: string, toColumnId: string}[]} moved
 * @property {StructureState|null} structure  set when title, columns or column order changed
 * @property {Record<string, Label>|null} labels  full label map when labels changed
 * @property {HistoryEntry|null} history
 * @property {Conflict[]} conflicts
 * @property {OpError[]} errors
 * @property {boolean} [duplicate]    true when this is the recorded answer to a replayed requestId
 */

/**
 * @typedef {object} StructureState
 * @property {string} title
 * @property {string[]} columnOrder
 * @property {Record<string, Column>} columns
 */

// ---------------------------------------------------------------------------------------------
// Events (server -> subscribed clients)
// ---------------------------------------------------------------------------------------------

/**
 * Delivered to `callback.operation(event)`.
 *
 * "operation": apply `deletes` first, then `upserts` (a move appears as a delete from the old
 * column's perspective only in `moved`; the upserted card carries its new columnId), then
 * `structure` and `labels` wholesale when present.
 * "comment":   a comment was appended.
 * "snapshot":  replace local state entirely.
 *
 * @typedef {(
 *   {type: "operation", senderId: string, revision: number, upserts: Card[],
 *    deletes: {cardId: string, columnId: string}[],
 *    moved: {cardId: string, fromColumnId: string, toColumnId: string}[],
 *    structure: StructureState|null, labels: Record<string, Label>|null,
 *    history: HistoryEntry|null, lastModified: number}
 *   | {type: "comment", senderId: string, comment: Comment}
 *   | {type: "snapshot", board: BoardSnapshot}
 * )} BoardEvent
 */

/**
 * Ephemeral, never stored. Delivered to `callback.presence(event)`.
 * "join" on subscribe (and replayed to newcomers for everyone already present), "update" for
 * heartbeats and changes, "leave" on explicit leave or broken connection.
 *
 * @typedef {object} PresenceEvent
 * @property {"join"|"update"|"leave"} type
 * @property {string} clientId
 * @property {string} [name]
 * @property {string} [color]
 * @property {string|null} [openCardId]    card whose panel is open
 * @property {string|null} [dragCardId]    card being dragged
 * @property {string|null} [hoverColumnId] column the drag is over
 * @property {number} at
 */

/**
 * Second argument of subscribe(callback, client).
 * @typedef {object} ClientInfo
 * @property {string} clientId
 * @property {string} name
 * @property {string} color
 * @property {string} [session]  the session subscribe() returned earlier for this clientId. Needed
 *   to replace a live subscription for the same clientId; a 32-hex value is also kept as the new
 *   session when the server has no entry (e.g. after a restart), so the token stays stable.
 */

/**
 * What subscribe() returns: the snapshot plus the subscription's session token (32 lowercase hex,
 * 128 bits). The token is never broadcast. It must accompany updatePresence and leavePresence,
 * and a re-subscribe for the same clientId while the old subscription is live.
 *
 * subscribe throws Error("clientId in use") when a live subscription for clientId has a different
 * session, and Error("board is full") beyond LIMITS.subscribers.
 * @typedef {BoardSnapshot & {session: string}} SubscribeResult
 */

/**
 * Argument of updatePresence. Returns {known, revision}; known is false when this server
 * instance has no subscription for clientId or the session does not match it.
 * @typedef {object} PresenceUpdate
 * @property {string} clientId
 * @property {string} session
 * @property {string} [name]
 * @property {string} [color]
 * @property {string|null} [openCardId]
 * @property {string|null} [dragCardId]
 * @property {string|null} [hoverColumnId]
 */

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

export const SCHEMA_VERSION = 1;

export const LIMITS = Object.freeze({
  columns: 50,
  cards: 2000,
  labels: 50,
  labelsPerCard: 20,
  checklistItems: 50,
  commentsPerCard: 200,
  /**
   * Budget for the stored size of all cards together (sum of each card's conservative stored
   * size: UTF-8 JSON bytes, or 2 bytes per UTF-16 unit when non-Latin-1). Creates, growing edits
   * and undo restores beyond it fail with "limit"; shrinking edits, moves and deletes always work.
   * Keeps the snapshot well inside the 32 MiB RPC message and 128 MB isolate limits.
   */
  boardBytes: 8 * 1024 * 1024,
  /** Same measure, for all comments of one card. */
  commentBytesPerCard: 256 * 1024,
  /** A column delete is refused ("limit") when the column holds more cards than this... */
  columnDeleteCards: 200,
  /** ...or when one request would remove more comments than this (card and column deletes). */
  columnDeleteComments: 5000,
  /** Recent requestIds remembered for idempotent replays (entries, and serialized bytes). */
  requestRecords: 500,
  requestRecordBytes: 64 * 1024,
  /** Live subscriptions per board; subscribe beyond this throws "board is full". */
  subscribers: 200,
  historyEntries: 200,
  /** Serialized JSON bytes; oldest history entries are dropped beyond this. */
  historyBytes: 100 * 1024,
  /** Serialized JSON bytes; larger inverses are stored as null (not undoable). */
  inverseBytes: 4 * 1024,
  opsPerRequest: 500,
  boardTitle: 200,
  columnName: 80,
  cardTitle: 500,
  description: 10000,
  assignee: 80,
  checklistText: 200,
  labelName: 40,
  commentText: 2000,
  displayName: 40,
  orderKey: 128,
  summary: 200,
});

export const PRESENCE_HEARTBEAT_MS = 4000;
export const PRESENCE_STALE_MS = 12000;

export const DEFAULT_TITLE = "Untitled board";
export const DEFAULT_COLUMNS = ["Backlog", "To do", "In progress", "Done"];
/** @type {ReadonlyArray<{name: string, color: string}>} */
export const DEFAULT_LABELS = [
  { name: "Bug", color: "#c93c3c" },
  { name: "Feature", color: "#3b82f6" },
  { name: "Urgent", color: "#e8871e" },
  { name: "Chore", color: "#6b7280" },
];

export const ID_PREFIX = Object.freeze({
  card: "c", column: "k", label: "l", item: "i", comment: "m", history: "h",
});

const ID_RE = /^[a-z]_[0-9a-f]{8}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9:_-]{1,64}$/;
const SESSION_RE = /^[0-9a-f]{32}$/;
const ORDER_RE = /^[0-9A-Za-z]+$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
// C0/C1 controls except tab and newline, plus bidi overrides.
const CONTROL_RE = /[ ---‪-‮⁦-⁩]/g;

// ---------------------------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------------------------

/**
 * @param {keyof typeof ID_PREFIX} kind
 * @returns {string}
 */
export function newId(kind) {
  const hex = globalThis.crypto?.randomUUID
    ? crypto.randomUUID().slice(0, 8)
    : Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
  return ID_PREFIX[kind] + "_" + hex;
}

/**
 * @param {unknown} id
 * @param {keyof typeof ID_PREFIX} kind
 * @returns {id is string}
 */
export function isId(id, kind) {
  return typeof id === "string" && ID_RE.test(id) && id[0] === ID_PREFIX[kind];
}

/** @param {unknown} v @returns {v is string} a valid OperationRequest.requestId */
export function isRequestId(v) {
  return typeof v === "string" && REQUEST_ID_RE.test(v);
}

/** @param {unknown} v @returns {v is string} a well-formed session token (32 lowercase hex) */
export function isSession(v) {
  return typeof v === "string" && SESSION_RE.test(v);
}

/** @returns {string} a fresh session token: 128 random bits as 32 lowercase hex digits */
export function newSession() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------------------------
// Sanitisers. Pure; they clamp rather than throw. Callers decide what is an error.
// ---------------------------------------------------------------------------------------------

/**
 * Single-line text: controls and newlines removed, trimmed, truncated.
 * @param {unknown} value
 * @param {number} max
 */
export function cleanLine(value, max) {
  if (value == null) return "";
  return String(value).replace(CONTROL_RE, "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}

/**
 * Multi-line text: controls removed (tabs and newlines kept), CRLF normalised, truncated.
 * @param {unknown} value
 * @param {number} max
 */
export function cleanText(value, max) {
  if (value == null) return "";
  return String(value).replace(/\r\n?/g, "\n").replace(CONTROL_RE, "").slice(0, max);
}

/** @param {unknown} value */
export function cleanColor(value) {
  return typeof value === "string" && COLOR_RE.test(value) ? value.toLowerCase() : null;
}

/** @param {unknown} value */
export function cleanDue(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return null;
  const d = new Date(value + "T00:00:00Z");
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : value;
}

/** @param {unknown} value */
export function isOrderKey(value) {
  return typeof value === "string" && value.length > 0 && value.length <= LIMITS.orderKey &&
    ORDER_RE.test(value);
}

/**
 * @param {unknown} value
 * @param {Record<string, Label>} knownLabels
 * @returns {string[]}
 */
export function cleanLabelIds(value, knownLabels) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const id of value) {
    if (typeof id === "string" && Object.hasOwn(knownLabels, id) && !out.includes(id)) out.push(id);
    if (out.length >= LIMITS.labelsPerCard) break;
  }
  return out;
}

/**
 * Items without a valid id get a fresh one; duplicate ids are dropped.
 * @param {unknown} value
 * @returns {ChecklistItem[]}
 */
export function cleanChecklist(value) {
  if (!Array.isArray(value)) return [];
  /** @type {ChecklistItem[]} */
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = /** @type {Record<string, unknown>} */ (raw);
    let id = isId(item.id, "item") ? /** @type {string} */ (item.id) : newId("item");
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, text: cleanLine(item.text, LIMITS.checklistText), done: item.done === true });
    if (out.length >= LIMITS.checklistItems) break;
  }
  return out;
}

/**
 * Picks and cleans the editable card fields present in `patch`; unknown keys are dropped.
 * `order` is included only when valid.
 * @param {unknown} patch
 * @param {Record<string, Label>} knownLabels
 * @returns {Partial<Card>}
 */
export function cleanCardPatch(patch, knownLabels) {
  /** @type {Partial<Card>} */
  const out = {};
  if (!patch || typeof patch !== "object") return out;
  const p = /** @type {Record<string, unknown>} */ (patch);
  if ("title" in p) out.title = cleanLine(p.title, LIMITS.cardTitle);
  if ("description" in p) out.description = cleanText(p.description, LIMITS.description);
  if ("labels" in p) out.labels = cleanLabelIds(p.labels, knownLabels);
  if ("assignee" in p) out.assignee = cleanLine(p.assignee, LIMITS.assignee);
  if ("due" in p) out.due = cleanDue(p.due);
  if ("checklist" in p) out.checklist = cleanChecklist(p.checklist);
  if ("order" in p && isOrderKey(p.order)) out.order = /** @type {string} */ (p.order);
  return out;
}

/**
 * @param {unknown} name
 * @param {string} fallback
 */
export function cleanName(name, fallback) {
  return cleanLine(name, LIMITS.displayName) || fallback;
}

/**
 * Sort comparator for cards within a column.
 * @param {Pick<Card,"order"|"id">} a
 * @param {Pick<Card,"order"|"id">} b
 */
export function compareCards(a, b) {
  if (a.order !== b.order) return a.order < b.order ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Cards of one column, sorted.
 * @param {Record<string, Card>} cards
 * @param {string} columnId
 */
export function cardsInColumn(cards, columnId) {
  return Object.values(cards).filter((c) => c.columnId === columnId).sort(compareCards);
}

// ---------------------------------------------------------------------------------------------
// CSV (used by the server's ExportHandler and available to clients)
// ---------------------------------------------------------------------------------------------

export const CSV_COLUMNS = [
  "Column", "Title", "Description", "Labels", "Assignee", "Due", "Checklist done",
  "Checklist total", "Created", "Updated", "Created by", "Card id",
];

/** @param {unknown} value */
function csvField(value) {
  let text = String(value ?? "");
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

/**
 * @param {BoardSnapshot} board
 * @returns {string}
 */
export function boardToCsv(board) {
  const rows = [CSV_COLUMNS.map(csvField).join(",")];
  for (const columnId of board.columnOrder) {
    const column = board.columns[columnId];
    if (!column) continue;
    for (const card of cardsInColumn(board.cards, columnId)) {
      rows.push([
        column.name,
        card.title,
        card.description,
        card.labels.map((id) => board.labels[id]?.name).filter(Boolean).join("; "),
        card.assignee,
        card.due ?? "",
        card.checklist.filter((i) => i.done).length,
        card.checklist.length,
        new Date(card.createdAt).toISOString(),
        new Date(card.updatedAt).toISOString(),
        card.createdBy,
        card.id,
      ].map(csvField).join(","));
    }
  }
  return rows.join("\r\n") + "\r\n";
}
