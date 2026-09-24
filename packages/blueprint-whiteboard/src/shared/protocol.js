// @ts-check
// The whiteboard's contract: data shapes, wire protocol, limits and sanitisers.
// Shared by the server (src/server), the storage-agnostic rules (src/core) and the client
// (src/client). Changing anything here changes the wire protocol; do it deliberately.
//
// Two channels share one RPC session:
//   operations  applyOperation -> broadcast   committed, versioned, stored, in history
//   presence    updatePresence -> presence    cursors, viewports, selections, in-progress drags
//                                             and strokes; memory only, never stored

import { isValidOrderKey } from "./order.js";
import { resolveLanguage } from "./code/languages.js";
import { truncateText } from "./graphemes.js";

// ---------------------------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {"sticky"|"rect"|"ellipse"|"text"|"frame"|"pen"|"connector"|"icon"|"code"} ObjectType
 */

/**
 * @typedef {"auto"|"top"|"right"|"bottom"|"left"} Side
 */

/**
 * Every object carries every style key (defaults per type in TYPE_DEFAULTS).
 * @typedef {object} Style
 * @property {string} fill         "#rrggbb" or "none"
 * @property {string} stroke       "#rrggbb" or "none"
 * @property {number} strokeWidth  0..LIMITS.strokeWidth, world units
 * @property {string} textColor    "#rrggbb"
 * @property {number} fontSize     LIMITS.fontSizeMin..LIMITS.fontSizeMax, world units
 * @property {"left"|"center"|"right"} align
 * @property {"none"|"arrow"} arrowStart  connectors only; "none" elsewhere
 * @property {"none"|"arrow"} arrowEnd    connectors only; "none" elsewhere
 */

/**
 * One object on the board, stored under "obj:<id>".
 *
 * Geometry: (x, y) is the top-left corner of the unrotated box, w and h its size, all in world
 * units. `rot` is degrees clockwise about the box centre, [0, 360); only sticky, rect, ellipse,
 * text and icon rotate, everything else is always 0. A connector's box is meaningless (always 0,0,1,1):
 * its geometry is derived from its endpoints (src/shared/geometry.js).
 *
 * Stacking: frames always render below every other object; within each group, ascending `z`
 * (a fractional order key, src/shared/order.js), ties broken by id. See compareObjects.
 *
 * @typedef {object} WhiteboardObject
 * @property {string} id           "o_" + 12 hex
 * @property {ObjectType} type     immutable after create
 * @property {number} x
 * @property {number} y
 * @property {number} w            LIMITS.sizeMin..LIMITS.sizeMax
 * @property {number} h
 * @property {number} rot
 * @property {string} z
 * @property {string|null} frameId the frame this object belongs to, or null. Always null for
 *   frames and connectors. May name a frame that has since been deleted: readers treat such an
 *   id as null, and the server clears it on the object's next write (see "Frames"). A create or
 *   update naming an object that does not exist (a frame deleted concurrently) stores null and
 *   applies the rest of the op; naming an existing object that is not a frame is invalid_ref.
 * @property {string} text         sticky/rect/ellipse/text: content (LIMITS.text chars, newlines
 *   kept); frame: its name (LIMITS.frameName, one line); connector: a label (LIMITS.connectorLabel,
 *   one line); pen: always ""; icon: content drawn in its icon's text box, always "" for icons
 *   without one (glyphs).
 * @property {Style} style
 * @property {number[]} [points]   pen only: flat [x0, y0, x1, y1, ...] normalised to the box, each
 *   coordinate in [0, 1] rounded to 4 decimals; 2..LIMITS.penPoints points
 * @property {string} [from]       connector only: id of an existing non-connector object
 * @property {string} [to]         connector only: id of an existing non-connector object, != from
 * @property {Side} [fromSide]     connector only
 * @property {Side} [toSide]       connector only
 * @property {"straight"|"elbow"} [routing]  connector only
 * @property {string} [packId]     icon only: the icon pack, "<name>.<version>" (see
 *   src/shared/icons/registry.js); with iconId it names compiled geometry, never markup
 * @property {string} [iconId]     icon only: the icon within its pack
 * @property {string} [language]   code only: a language id from src/shared/code/languages.js
 *   ("plain", "python", ...); aliases ("py") are accepted on input and stored as the id
 * @property {"light"|"dark"} [theme]  code only: highlighting palette
 * @property {boolean} [lineNumbers]   code only: draw a line-number gutter
 * @property {boolean} [wrap]      code only: wrap long lines at the box width (else clip them)
 * @property {string} [filename]   code only: optional title shown in the header (LIMITS.codeFilename, one line)
 * @property {number} version      1 on create, bumped once per request that changes the object
 * @property {number} createdAt    epoch ms
 * @property {number} updatedAt    epoch ms
 * @property {string} createdBy    display name
 */

/**
 * Frames: an object of type "frame" is a named region. Membership is the member's `frameId`, set
 * by whoever moves the object (the client sets it when a drop leaves the object's centre inside a
 * frame). Deleting a frame does not touch its members; their `frameId` dangles and reads as null
 * until the object is next written, when the server clears it. Undoing the frame delete recreates
 * the frame with the same id, so the members rejoin. Frames cannot nest.
 *
 * Connectors: deleting an object deletes every connector attached to it, in the same request
 * (the result and broadcast list them in `deletes`).
 */

/**
 * Stored under "meta".
 * @typedef {object} BoardMeta
 * @property {number} schemaVersion
 * @property {number} revision       bumped once per request that changed something
 * @property {string} title
 * @property {"dots"|"grid"|"plain"} background
 * @property {number} lastModified
 */

/**
 * What getBoard() and subscribe() return.
 * @typedef {object} BoardSnapshot
 * @property {number} schemaVersion
 * @property {number} revision
 * @property {string} title
 * @property {"dots"|"grid"|"plain"} background
 * @property {Record<string, WhiteboardObject>} objects  keyed by id
 * @property {number} lastModified
 */

/**
 * @typedef {object} HistoryEntry
 * @property {string} id       "h_" + 12 hex
 * @property {number} at
 * @property {string} by
 * @property {string} summary  human-readable, e.g. 'Moved 3 objects'
 * @property {Inverse|null} inverse  what server undo applies; null when not undoable (too large,
 *   or a title/background change)
 * @property {string} [undoOf]    set on an undo's own entry: the id of the entry it undid
 * @property {string} [undoneBy]  set on an entry once undone: the id of that undo's entry; cleared
 *   again when that undo is itself undone (the change is back)
 */

/**
 * Ops that reverse a history entry. Applied without version checks ("force" mode), so creates
 * may recreate a deleted id and restore its createdAt/createdBy.
 * @typedef {object} Inverse
 * @property {ObjectOp[]} objectOps
 */

// ---------------------------------------------------------------------------------------------
// Operations (client -> server)
// ---------------------------------------------------------------------------------------------

/**
 * Object operations. Processed in array order; each op sees the effects of the ops before it.
 *
 *   create  `object` must carry a valid unused `id` and a `type`; every other field is optional
 *           and takes TYPE_DEFAULTS. `z` defaults to above every object of its group. Pen needs
 *           `points`; connector needs `from` and `to` naming existing objects.
 *   update  `patch` holds only the fields to change (EDITABLE_FIELDS; `style` merges key by key).
 *           `type`, `id`, `version` and timestamps cannot change.
 *   delete  also deletes connectors attached to the object.
 *
 * `baseVersion` is required on update and delete: the version the caller last saw. It matches
 * when it equals the current version, or the version the object had before this request (so a
 * request may carry several ops for one object). A stale baseVersion yields a conflict carrying
 * the authoritative object (null when it no longer exists) instead of a silent overwrite.
 *
 * @typedef {(
 *   {op: "create", object: Partial<WhiteboardObject> & {id: string, type: ObjectType}}
 * | {op: "update", id: string, baseVersion: number, patch: ObjectPatch}
 * | {op: "delete", id: string, baseVersion: number}
 * )} ObjectOp
 */

/**
 * @typedef {Partial<Omit<WhiteboardObject, "style"|"id"|"type"|"version"|"createdAt"|"updatedAt"|"createdBy">>
 *   & {style?: Partial<Style>}} ObjectPatch
 */

/**
 * @typedef {object} OperationRequest
 * @property {string} [senderId]  the client's id, echoed in the broadcast so it can skip its own
 * @property {string} [by]        display name recorded in history and createdBy
 * @property {string} [requestId] idempotency key, 1-64 chars of [A-Za-z0-9:_-] (anything else is
 *   ignored as if absent). A request whose requestId is already recorded FOR THE SAME senderId is
 *   not applied again; the recorded outcome is returned with `duplicate: true`. Records are shared
 *   by everyone on the board and senderId is broadcast, so requestIds must be unguessable (the
 *   client uses a per-store random secret plus a counter): a peer that knows a future requestId
 *   could record it first and have that request answered as a duplicate.
 * @property {ObjectOp[]} [objectOps]
 * @property {{title?: string, background?: "dots"|"grid"|"plain"}} [structure]  last-writer-wins,
 *   applied after objectOps
 */

/**
 * Stored (key "requests", newest last) for each request carrying a valid requestId, in the same
 * atomic commit as its changes.
 * @typedef {object} RequestRecord
 * @property {string} requestId
 * @property {string} senderId  the request's cleaned senderId ("" when absent); a replay matches
 *   only a record with the same requestId AND senderId
 * @property {number} revision
 * @property {"applied"|"conflict"|"unchanged"} status
 * @property {string[]} conflicts  object ids
 * @property {OpError[]} errors
 */

/**
 * @typedef {object} Conflict
 * @property {string} id
 * @property {WhiteboardObject|null} current  authoritative object; null when it no longer exists
 */

/**
 * @typedef {object} OpError
 * @property {number} index  position in objectOps; -1 for structure or the whole request
 * @property {"invalid_id"|"invalid_op"|"unknown_object"|"exists"|"invalid_ref"|"limit"} code
 *   invalid_ref: a connector endpoint that does not name a suitable existing object, or a frameId
 *   naming an existing object that is not a frame (a frameId naming nothing is cleared instead).
 *   limit: a count cap, the per-object or whole-board byte budget, or LIMITS.commitObjects.
 * @property {string} message
 */

/**
 * Result of applyOperation, undo and the convenience writes. Ops apply independently: valid ones
 * commit even when others conflict or fail.
 *
 * status: "applied" when something changed and nothing conflicted; "conflict" when any op
 * conflicted (others may still have applied); "unchanged" when nothing changed and nothing
 * conflicted (errors may be present).
 *
 * duplicate: the requestId was already recorded, so nothing was applied. status, conflict ids and
 * errors are the recorded ones (conflicts[].current is read now), revision is CURRENT, and
 * upserts/deletes/structure/history are empty. Nothing is broadcast.
 *
 * @typedef {object} OperationResult
 * @property {"applied"|"conflict"|"unchanged"} status
 * @property {number} revision
 * @property {WhiteboardObject[]} upserts  objects created or changed, in their final state
 * @property {string[]} deletes            ids removed, including cascaded connectors
 * @property {{title: string, background: "dots"|"grid"|"plain"}|null} structure  set when changed
 * @property {HistoryEntry|null} history
 * @property {Conflict[]} conflicts
 * @property {OpError[]} errors
 * @property {boolean} [duplicate]
 */

// ---------------------------------------------------------------------------------------------
// Events (server -> subscribed clients)
// ---------------------------------------------------------------------------------------------

/**
 * Delivered to `callback.operation(event)`, in revision order.
 *   "operation": remove `deletes`, then put `upserts`, then take `structure` when present.
 *   "snapshot":  replace local state entirely.
 * @typedef {(
 *   {type: "operation", senderId: string, revision: number, upserts: WhiteboardObject[],
 *    deletes: string[], structure: {title: string, background: "dots"|"grid"|"plain"}|null,
 *    history: HistoryEntry|null, lastModified: number}
 *   | {type: "snapshot", board: BoardSnapshot}
 * )} BoardEvent
 */

/**
 * In-progress geometry of an object someone is dragging, resizing or rotating.
 * @typedef {object} PresenceTransform
 * @property {string} id
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {number} rot
 */

/**
 * A stroke being drawn, in WORLD coordinates (not normalised).
 * @typedef {object} PresenceStroke
 * @property {number[]} points  flat [x0, y0, ...], at most LIMITS.presenceStrokePoints points
 * @property {string} color     "#rrggbb"
 * @property {number} width
 */

/**
 * A collaborator's full ephemeral state. Every "join" and "update" carries all of it, so a
 * receiver (or a coalescing server) only ever needs the latest one per client.
 * @typedef {object} PresenceState
 * @property {string} clientId
 * @property {string} name
 * @property {string} color
 * @property {{x: number, y: number}|null} cursor         world coordinates; null when off-canvas
 * @property {{x: number, y: number, w: number, h: number}|null} viewport  world rect they see
 * @property {string[]} selection                         object ids
 * @property {PresenceTransform[]} transforms
 * @property {PresenceStroke|null} stroke
 * @property {string|null} editingId                      object whose text they are editing
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
 * session, and Error("board is full") beyond LIMITS.subscribers.
 * @typedef {BoardSnapshot & {session: string}} SubscribeResult
 */

/**
 * Argument of updatePresence. Fields left out keep their previous value; `null` clears.
 * Returns {known, revision}: known is false when this server instance has no subscription for
 * clientId or the session does not match (the client then re-subscribes); revision lets the
 * client notice missed events.
 * @typedef {Partial<Omit<PresenceState, "clientId">> & {clientId: string, session: string}} PresenceUpdate
 */

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

export const SCHEMA_VERSION = 1;

export const LIMITS = Object.freeze({
  objects: 5000,
  frames: 50,
  /** Objects whose frameId names one frame. */
  objectsPerFrame: 2000,
  /** Points (pairs) in a stored pen stroke. */
  penPoints: 2000,
  text: 4000,
  /** Characters of code in one code block (its `text`), and its lines. */
  codeText: 20_000,
  codeLines: 1000,
  codeFilename: 120,
  frameName: 80,
  connectorLabel: 200,
  boardTitle: 200,
  displayName: 40,
  /** Longest order key stored (order.js accepts up to this). */
  orderKey: 128,
  /**
   * Longest `z` a client may set directly (see isAcceptableOrderKey); leaves the server headroom
   * to generate keys above and below any accepted key.
   */
  orderKeyAccept: 64,
  summary: 200,
  /** Stored size (storedBytes: an upper bound of its JSON and of its V8 serialisation) of one object. */
  objectBytes: 64 * 1024,
  /** Same measure, all objects together. Keeps the snapshot far below the RPC message limit. */
  boardBytes: 8 * 1024 * 1024,
  opsPerRequest: 1000,
  /** Objects one request may create, change or delete, cascaded connectors included. */
  commitObjects: 2000,
  historyEntries: 200,
  /** storedBytes of the whole "history" value; Durable Object storage allows 128 KiB per value. */
  historyBytes: 100 * 1024,
  inverseBytes: 16 * 1024,
  requestRecords: 500,
  requestRecordBytes: 64 * 1024,
  subscribers: 200,
  // Geometry clamps.
  coord: 1_000_000,
  sizeMin: 1,
  sizeMax: 100_000,
  strokeWidth: 64,
  fontSizeMin: 8,
  fontSizeMax: 200,
  // Presence payload caps. Larger arrays are truncated silently.
  presenceSelection: 200,
  presenceTransforms: 100,
  presenceStrokePoints: 1000,
});

/** Client heartbeat interval; also the longest a remote cursor can sit without an update. */
export const PRESENCE_HEARTBEAT_MS = 4000;
/** A peer unseen this long is removed by clients. */
export const PRESENCE_STALE_MS = 12000;
/** Minimum gap between a client's presence sends while the pointer moves (about 30 Hz). */
export const PRESENCE_SEND_MS = 33;
/** Zoom range for the client camera. */
export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 20;

export const DEFAULT_TITLE = "Untitled whiteboard";

export const OBJECT_TYPES = /** @type {const} */ (["sticky", "rect", "ellipse", "text", "frame", "pen", "connector", "icon", "code"]);
/** Types that rotate; every other type has rot 0. */
export const ROTATABLE = /** @type {const} */ (["sticky", "rect", "ellipse", "text", "icon"]);
export const SIDES = /** @type {const} */ (["auto", "top", "right", "bottom", "left"]);
export const BACKGROUNDS = /** @type {const} */ (["dots", "grid", "plain"]);

/**
 * Fields an update patch may carry, per type (plus `style` for every type).
 * @type {Readonly<Record<ObjectType, readonly string[]>>}
 */
export const EDITABLE_FIELDS = Object.freeze({
  sticky: ["x", "y", "w", "h", "rot", "z", "frameId", "text", "style"],
  rect: ["x", "y", "w", "h", "rot", "z", "frameId", "text", "style"],
  ellipse: ["x", "y", "w", "h", "rot", "z", "frameId", "text", "style"],
  text: ["x", "y", "w", "h", "rot", "z", "frameId", "text", "style"],
  frame: ["x", "y", "w", "h", "z", "text", "style"],
  pen: ["x", "y", "w", "h", "z", "frameId", "points", "style"],
  connector: ["z", "text", "style", "from", "to", "fromSide", "toSide", "routing"],
  icon: ["x", "y", "w", "h", "rot", "z", "frameId", "text", "style", "packId", "iconId"],
  code: ["x", "y", "w", "h", "z", "frameId", "text", "style", "language", "theme", "lineNumbers", "wrap", "filename"],
});

/** Geometry fields a client rebases by delta when a concurrent change conflicts. */
export const GEOMETRY_FIELDS = /** @type {const} */ (["x", "y", "w", "h", "rot"]);

/** Named colours accepted by the convenience methods, and offered by the UI. */
export const COLORS = Object.freeze({
  yellow: "#fff3a0", orange: "#ffd29c", red: "#ffadad", pink: "#ffc6e5", purple: "#dcc6ff",
  blue: "#b5d8ff", teal: "#aeeee0", green: "#c7f0b0", gray: "#e5e7eb", white: "#ffffff",
  black: "#1f2937",
});

/** Stroke and text colours offered by the UI. */
export const INK = Object.freeze(["#1f2937", "#6b7280", "#dc2626", "#ea580c", "#16a34a", "#2563eb", "#7c3aed", "#db2777"]);

/**
 * Defaults per type, applied on create.
 * @type {Readonly<Record<ObjectType, {w: number, h: number, text: string, style: Style} & {routing?: "straight"|"elbow"}>>}
 */
export const TYPE_DEFAULTS = Object.freeze({
  sticky: { w: 200, h: 200, text: "", style: style({ fill: COLORS.yellow, stroke: "none", strokeWidth: 0, fontSize: 20, align: "center" }) },
  rect: { w: 200, h: 120, text: "", style: style({ fill: "#ffffff", stroke: "#1f2937", strokeWidth: 2, fontSize: 18, align: "center" }) },
  ellipse: { w: 200, h: 120, text: "", style: style({ fill: "#ffffff", stroke: "#1f2937", strokeWidth: 2, fontSize: 18, align: "center" }) },
  text: { w: 240, h: 40, text: "", style: style({ fill: "none", stroke: "none", strokeWidth: 0, fontSize: 24, align: "left" }) },
  frame: { w: 800, h: 600, text: "Frame", style: style({ fill: "#ffffff", stroke: "#9ca3af", strokeWidth: 1, fontSize: 16, align: "left" }) },
  pen: { w: 1, h: 1, text: "", style: style({ fill: "none", stroke: "#1f2937", strokeWidth: 4, fontSize: 16, align: "left" }) },
  connector: { w: 1, h: 1, text: "", routing: "straight", style: style({ fill: "none", stroke: "#1f2937", strokeWidth: 2, fontSize: 14, align: "center", arrowEnd: "arrow" }) },
  // A glyph's defaults; the board applies each icon's own size and style (registry iconDefaults).
  icon: { w: 96, h: 96, text: "", style: style({ fill: "none", stroke: "#1f2937", strokeWidth: 2, fontSize: 18, align: "center" }) },
  // Colours come from the code theme (src/shared/code/theme.js); only fontSize is used.
  code: { w: 480, h: 120, text: "", style: style({ fill: "none", stroke: "none", strokeWidth: 0, fontSize: 14, align: "left" }) },
});

/** Code-block fields a create takes when it does not give them. */
export const CODE_DEFAULTS = Object.freeze({ language: "plain", theme: "light", lineNumbers: true, wrap: false, filename: "" });

/** @param {Partial<Style>} s @returns {Style} */
function style(s) {
  return Object.freeze({
    fill: "none", stroke: "none", strokeWidth: 0, textColor: "#1f2937", fontSize: 16, align: "left",
    arrowStart: "none", arrowEnd: "none", ...s,
  });
}

export const ID_PREFIX = Object.freeze({ object: "o", history: "h" });

const ID_RE = /^[a-z]_[0-9a-f]{12}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9:_-]{1,64}$/;
const SESSION_RE = /^[0-9a-f]{32}$/;
const ORDER_RE = /^[0-9A-Za-z]+$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
/** Shape of icon references; existence is checked against src/shared/icons/registry.js by the board. */
const PACK_ID_RE = /^[a-z][a-z0-9-]{0,31}\.[0-9]{1,4}$/;
const ICON_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// C0/C1 controls except tab and newline, plus bidi overrides.
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

// ---------------------------------------------------------------------------------------------
// Ids and tokens
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
 * @param {keyof typeof ID_PREFIX} [kind]  defaults to "object"
 * @returns {id is string}
 */
export function isId(id, kind = "object") {
  return typeof id === "string" && ID_RE.test(id) && id[0] === ID_PREFIX[kind];
}

/** @param {unknown} v @returns {v is string} */
export function isRequestId(v) {
  return typeof v === "string" && REQUEST_ID_RE.test(v);
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

// ---------------------------------------------------------------------------------------------
// Sanitisers. Pure; they clamp rather than throw. Callers decide what is an error.
// ---------------------------------------------------------------------------------------------

/** @param {unknown} v */
export const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Single-line text: controls and newlines removed, trimmed, truncated (limits count UTF-16 code
 * units; truncation never splits an emoji or other multi-code-point character).
 * @param {unknown} value @param {number} max
 */
export function cleanLine(value, max) {
  if (value == null) return "";
  return truncateText(String(value).replace(CONTROL_RE, "").replace(/[\r\n\t]+/g, " ").trim(), max);
}

/**
 * Multi-line text: controls removed (tabs and newlines kept), CRLF normalised, truncated without
 * splitting a multi-code-point character (see cleanLine).
 * @param {unknown} value @param {number} max
 */
export function cleanText(value, max) {
  if (value == null) return "";
  return truncateText(String(value).replace(/\r\n?/g, "\n").replace(CONTROL_RE, ""), max);
}

/**
 * Code: multi-line text (tabs kept) cut to LIMITS.codeText characters and LIMITS.codeLines lines.
 * @param {unknown} value
 */
export function cleanCode(value) {
  let text = cleanText(value, LIMITS.codeText);
  let at = -1;
  for (let line = 1; line < LIMITS.codeLines; line++) {
    at = text.indexOf("\n", at + 1);
    if (at < 0) return text;
  }
  at = text.indexOf("\n", at + 1);
  if (at >= 0) text = text.slice(0, at);
  return text;
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
 * A finite number clamped to [min, max] and rounded to `decimals`, or null when not a finite number.
 * @param {unknown} v @param {number} min @param {number} max @param {number} [decimals]
 */
export function cleanNumber(v, min, max, decimals = 2) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const f = 10 ** decimals;
  const clamped = Math.min(max, Math.max(min, v));
  return Math.round(clamped * f) / f + 0; // + 0 turns -0 into 0
}

/** @param {unknown} v @returns {number|null} a coordinate */
export const cleanCoord = (v) => cleanNumber(v, -LIMITS.coord, LIMITS.coord);

/** @param {unknown} v @returns {number|null} a width or height */
export const cleanSize = (v) => cleanNumber(v, LIMITS.sizeMin, LIMITS.sizeMax);

/** @param {unknown} v @returns {number|null} degrees in [0, 360) */
export function cleanRotation(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const r = Math.round((((v % 360) + 360) % 360) * 10) / 10;
  return r >= 360 ? 0 : r + 0;
}

/** @param {unknown} value */
export function isOrderKey(value) {
  // Well-formed per order.js, so keyBetween accepts it as a neighbour (e.g. "b" and "c0" are not).
  return typeof value === "string" && value.length <= LIMITS.orderKey && ORDER_RE.test(value) && isValidOrderKey(value);
}

/**
 * An order key a client may set directly: well-formed, at most LIMITS.orderKeyAccept chars, with
 * an integer head from "B" to "y". Honest keys ("a0", "a1", "Zz", ...) never come near those ends
 * (reaching "y" from "a0" takes some 62^24 steps), and the server can always step the integer part
 * of such a key up or down, so a short key above and below any accepted key exists. The server
 * turns other valid keys into keys of its own (see "Order keys" in src/core/whiteboard.js).
 * @param {unknown} value
 * @returns {value is string}
 */
export function isAcceptableOrderKey(value) {
  return isOrderKey(value) && value.length <= LIMITS.orderKeyAccept && value[0] >= "B" && value[0] <= "y";
}

/** @param {unknown} v @returns {v is ObjectType} */
export function isObjectType(v) {
  return typeof v === "string" && /** @type {readonly string[]} */ (OBJECT_TYPES).includes(v);
}

/**
 * Cleans a partial style. Unknown keys and invalid values are dropped; arrow keys only survive for
 * connectors.
 * @param {unknown} raw
 * @param {ObjectType} type
 * @returns {Partial<Style>}
 */
export function cleanStylePatch(raw, type) {
  /** @type {Partial<Style>} */
  const out = {};
  if (!isObject(raw)) return out;
  const s = /** @type {Record<string, unknown>} */ (raw);
  const fill = cleanColor(s.fill, true);
  if (fill) out.fill = fill;
  const stroke = cleanColor(s.stroke, true);
  if (stroke) out.stroke = stroke;
  const strokeWidth = cleanNumber(s.strokeWidth, 0, LIMITS.strokeWidth, 1);
  if (strokeWidth !== null) out.strokeWidth = strokeWidth;
  const textColor = cleanColor(s.textColor);
  if (textColor) out.textColor = textColor;
  const fontSize = cleanNumber(s.fontSize, LIMITS.fontSizeMin, LIMITS.fontSizeMax, 0);
  if (fontSize !== null) out.fontSize = fontSize;
  if (s.align === "left" || s.align === "center" || s.align === "right") out.align = s.align;
  if (type === "connector") {
    if (s.arrowStart === "none" || s.arrowStart === "arrow") out.arrowStart = s.arrowStart;
    if (s.arrowEnd === "none" || s.arrowEnd === "arrow") out.arrowEnd = s.arrowEnd;
  }
  return out;
}

/**
 * Normalised pen points: a flat array of an even length, 2..LIMITS.penPoints points, each value
 * clamped to [0, 1] and rounded to 4 decimals. Null when unusable.
 * @param {unknown} v
 * @returns {number[]|null}
 */
export function cleanPoints(v) {
  if (!Array.isArray(v) || v.length < 4) return null;
  const n = Math.min(Math.floor(v.length / 2), LIMITS.penPoints) * 2;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const c = cleanNumber(v[i], 0, 1, 4);
    if (c === null) return null;
    out[i] = c;
  }
  return out;
}

/**
 * Picks and cleans the fields of an update patch that `type` allows. Values that are invalid are
 * dropped (not clamped to a default), except numbers, which are clamped. Reference fields (frameId,
 * from, to) are only checked for shape here; existence is the board's job. `style` is a cleaned
 * partial.
 * @param {unknown} raw
 * @param {ObjectType} type
 * @returns {ObjectPatch}
 */
export function cleanObjectPatch(raw, type) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (!isObject(raw)) return /** @type {ObjectPatch} */ (out);
  const p = /** @type {Record<string, unknown>} */ (raw);
  const allowed = EDITABLE_FIELDS[type];
  for (const key of allowed) {
    if (!(key in p)) continue;
    const v = p[key];
    switch (key) {
      case "x": case "y": { const c = cleanCoord(v); if (c !== null) out[key] = c; break; }
      case "w": case "h": { const c = cleanSize(v); if (c !== null) out[key] = c; break; }
      case "rot": { const c = cleanRotation(v); if (c !== null) out.rot = c; break; }
      case "z": if (isOrderKey(v)) out.z = v; break;
      case "frameId": if (v === null || isId(v)) out.frameId = v; break;
      case "text":
        out.text = type === "frame" ? cleanLine(v, LIMITS.frameName)
          : type === "connector" ? cleanLine(v, LIMITS.connectorLabel)
          : type === "code" ? cleanCode(v)
          : cleanText(v, LIMITS.text);
        break;
      case "style": { const s = cleanStylePatch(v, type); if (Object.keys(s).length) out.style = s; break; }
      case "points": { const pts = cleanPoints(v); if (pts) out.points = pts; break; }
      case "from": case "to": if (isId(v)) out[key] = v; break;
      case "fromSide": case "toSide":
        if (typeof v === "string" && /** @type {readonly string[]} */ (SIDES).includes(v)) out[key] = v;
        break;
      case "routing": if (v === "straight" || v === "elbow") out.routing = v; break;
      case "packId": if (typeof v === "string" && PACK_ID_RE.test(v)) out.packId = v; break;
      case "iconId": if (typeof v === "string" && ICON_ID_RE.test(v)) out.iconId = v; break;
      case "language": { const l = resolveLanguage(v); if (l) out.language = l; break; }
      case "theme": if (v === "light" || v === "dark") out.theme = v; break;
      case "lineNumbers": case "wrap": if (typeof v === "boolean") out[key] = v; break;
      case "filename": if (typeof v === "string") out.filename = cleanLine(v, LIMITS.codeFilename); break;
    }
  }
  return /** @type {ObjectPatch} */ (out);
}

/**
 * Builds a complete object (minus version and timestamps) from a create op's `object`, applying
 * TYPE_DEFAULTS. Returns null when `id` or `type` is invalid. References are not checked, `z` is
 * left "" when absent or invalid (the board picks one), and a pen without valid points, a
 * connector without from/to or an icon without a well-formed packId/iconId is returned as is for
 * the board to reject.
 * @param {unknown} raw
 * @returns {Omit<WhiteboardObject, "version"|"createdAt"|"updatedAt"|"createdBy">|null}
 */
export function normalizeNewObject(raw) {
  if (!isObject(raw)) return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  if (!isId(r.id) || !isObjectType(r.type)) return null;
  const type = r.type;
  const d = TYPE_DEFAULTS[type];
  const patch = cleanObjectPatch(r, type);
  /** @type {any} */
  const obj = {
    id: r.id, type,
    x: patch.x ?? 0, y: patch.y ?? 0,
    w: patch.w ?? d.w, h: patch.h ?? d.h,
    rot: patch.rot ?? 0,
    z: patch.z ?? "",
    frameId: type === "frame" || type === "connector" ? null : patch.frameId ?? null,
    text: patch.text ?? d.text,
    style: { ...d.style, ...(patch.style ?? {}) },
  };
  if (type === "pen") obj.points = patch.points ?? [];
  if (type === "connector") {
    obj.x = 0; obj.y = 0; obj.w = 1; obj.h = 1;
    obj.from = patch.from ?? "";
    obj.to = patch.to ?? "";
    obj.fromSide = patch.fromSide ?? "auto";
    obj.toSide = patch.toSide ?? "auto";
    obj.routing = patch.routing ?? d.routing ?? "straight";
  }
  if (type === "icon") {
    obj.packId = patch.packId ?? "";
    obj.iconId = patch.iconId ?? "";
  }
  if (type === "code") {
    for (const k of /** @type {const} */ (["language", "theme", "lineNumbers", "wrap", "filename"])) obj[k] = patch[k] ?? CODE_DEFAULTS[k];
  }
  return obj;
}

/**
 * Stacking order: frames first (below), then ascending z, ties by id.
 * @param {Pick<WhiteboardObject, "type"|"z"|"id">} a
 * @param {Pick<WhiteboardObject, "type"|"z"|"id">} b
 */
export function compareObjects(a, b) {
  const ga = a.type === "frame" ? 0 : 1;
  const gb = b.type === "frame" ? 0 : 1;
  if (ga !== gb) return ga - gb;
  if (a.z !== b.z) return a.z < b.z ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Objects in stacking order (bottom first).
 * @param {Record<string, WhiteboardObject>} objects
 */
export function sortedObjects(objects) {
  return Object.values(objects).sort(compareObjects);
}

/**
 * The frame an object effectively belongs to: its frameId when that names an existing frame.
 * @param {WhiteboardObject} obj
 * @param {Record<string, WhiteboardObject>} objects
 * @returns {string|null}
 */
export function effectiveFrameId(obj, objects) {
  const f = obj.frameId;
  return f && Object.hasOwn(objects, f) && objects[f].type === "frame" ? f : null;
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
 * 9 bytes or its JSON length, whichever is more (V8 writes a double as 9 bytes where JSON may need
 * 3); a string as its UTF-8 JSON or its code units (2 bytes each once any character is outside
 * Latin-1), whichever is more; arrays and objects add their tags and separators, and each array
 * element 4 more (V8 writes a holey array sparse, as index and value pairs).
 * @param {unknown} value
 */
export function storedBytes(value) {
  return valueBytes(value) + 2; // + the serialisation header
}

/**
 * Cleans a presence update onto the previous state. Fields absent from `raw` keep `previous`;
 * over-long arrays are truncated; invalid entries dropped. `clientId` is taken as given.
 * @param {unknown} raw
 * @param {string} clientId
 * @param {PresenceState|null} previous
 * @returns {PresenceState}
 */
export function cleanPresence(raw, clientId, previous) {
  const r = /** @type {Record<string, any>} */ (isObject(raw) ? raw : {});
  const has = (/** @type {string} */ k) => Object.hasOwn(r, k);

  /** @type {PresenceState["cursor"]} */
  let cursor = previous?.cursor ?? null;
  if (has("cursor")) {
    const x = isObject(r.cursor) ? cleanCoord(r.cursor.x) : null;
    const y = isObject(r.cursor) ? cleanCoord(r.cursor.y) : null;
    cursor = x !== null && y !== null ? { x, y } : null;
  }

  /** @type {PresenceState["viewport"]} */
  let viewport = previous?.viewport ?? null;
  if (has("viewport")) {
    const v = isObject(r.viewport) ? r.viewport : null;
    const x = v ? cleanCoord(v.x) : null, y = v ? cleanCoord(v.y) : null;
    const w = v ? cleanNumber(v.w, 1, 2 * LIMITS.coord) : null, h = v ? cleanNumber(v.h, 1, 2 * LIMITS.coord) : null;
    viewport = x !== null && y !== null && w !== null && h !== null ? { x, y, w, h } : null;
  }

  let selection = previous?.selection ?? [];
  if (has("selection")) {
    selection = Array.isArray(r.selection)
      ? [...new Set(r.selection.slice(0, LIMITS.presenceSelection).filter((id) => isId(id)))]
      : [];
  }

  let transforms = previous?.transforms ?? [];
  if (has("transforms")) {
    transforms = [];
    for (const t of Array.isArray(r.transforms) ? r.transforms.slice(0, LIMITS.presenceTransforms) : []) {
      if (!isObject(t) || !isId(t.id)) continue;
      const x = cleanCoord(t.x), y = cleanCoord(t.y), w = cleanSize(t.w), h = cleanSize(t.h);
      if (x === null || y === null || w === null || h === null) continue;
      transforms.push({ id: t.id, x, y, w, h, rot: cleanRotation(t.rot) ?? 0 });
    }
  }

  let stroke = previous?.stroke ?? null;
  if (has("stroke")) {
    stroke = null;
    const s = r.stroke;
    if (isObject(s) && Array.isArray(s.points)) {
      const n = Math.min(Math.floor(s.points.length / 2), LIMITS.presenceStrokePoints) * 2;
      const points = [];
      for (let i = 0; i < n; i++) {
        const c = cleanCoord(s.points[i]);
        if (c === null) { points.length = 0; break; }
        points.push(c);
      }
      if (points.length >= 2) {
        stroke = {
          points,
          color: cleanColor(s.color) ?? "#1f2937",
          width: cleanNumber(s.width, 0.5, LIMITS.strokeWidth, 1) ?? 4,
        };
      }
    }
  }

  let editingId = previous?.editingId ?? null;
  if (has("editingId")) editingId = isId(r.editingId) ? r.editingId : null;

  return {
    clientId,
    name: has("name") ? cleanName(r.name, previous?.name ?? "Guest") : previous?.name ?? "Guest",
    color: (has("color") ? cleanColor(r.color) : null) ?? previous?.color ?? "#e1632e",
    cursor, viewport, selection, transforms, stroke, editingId,
  };
}
