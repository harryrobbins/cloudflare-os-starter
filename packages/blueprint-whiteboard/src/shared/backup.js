// @ts-check
// The portable board format: data-only JSON used by the clipboard, "Download board backup",
// backup import, templates and the exportData()/importData() agent methods.
//
//   {format: "cloudflare-os-whiteboard", version: 1, objects: [...], origin?: {x, y},
//    title?, background?, exportedAt?}
//
// It holds objects only in their drawable, data-only form: never presence, history, request ids,
// viewer ids, sessions, versions, timestamps, `createdBy` or order keys. `objects` are listed
// bottom to top (frames first); an object's `id` is only a local reference for `frameId`, `from`
// and `to` inside the same document. On the way in every id is regenerated, references are
// remapped (a connector survives only when both endpoints came along; a `frameId` only when its
// frame did), and every object goes through the same normalisers as an interactive create, so
// nothing a backup carries bypasses the board's rules.
//
// The backup format version is independent of the stored `schemaVersion`: MIGRATIONS upgrades
// an older document one version at a time before it is read.

import {
  BACKGROUNDS, LIMITS, TYPE_DEFAULTS, cleanCoord, cleanLine, cleanPoints, cleanText, compareObjects,
  effectiveFrameId, isObject, isObjectType, normalizeNewObject,
} from "./protocol.js";
import { boardBounds, rotatedBounds, unionRects } from "./geometry.js";
import { resolveLanguage } from "./code/languages.js";
import { codeHeight } from "./code/layout.js";

/** @typedef {import("./protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {import("./protocol.js").ObjectType} ObjectType */
/** @typedef {import("./protocol.js").BoardSnapshot} BoardSnapshot */
/** @typedef {{x: number, y: number, w: number, h: number}} Rect */

/** Marker naming the format, so a pasted or dropped document is recognisable. */
export const BACKUP_FORMAT = "cloudflare-os-whiteboard";
/** Current backup format version (not the stored schemaVersion). */
export const BACKUP_VERSION = 1;
/** Clipboard MIME type of copied objects. */
export const CLIPBOARD_MIME = "application/vnd.cloudflare-os-whiteboard+json;version=1";

export const BACKUP_LIMITS = Object.freeze({
  /** Longest backup text accepted (characters): a full board is at most LIMITS.boardBytes stored. */
  textChars: 16 * 1024 * 1024,
  /** Objects in one backup (the board's own cap). */
  objects: LIMITS.objects,
  /** Objects one paste creates: one request's worth. */
  pasteObjects: LIMITS.opsPerRequest,
  /** Sticky notes one plain-text paste creates. */
  textStickies: 200,
  /** Longest local reference (`id`, `frameId`, `from`, `to`) inside a document. */
  refLength: 64,
  /** Error messages kept for a preview; the rest are counted. */
  errors: 20,
});

/** Grid of stickies made from plain text. */
export const TEXT_STICKY = Object.freeze({ size: 200, gap: 40 });

/**
 * One object as the portable format carries it.
 * @typedef {object} PortableObject
 * @property {string} id  local reference
 * @property {ObjectType} type
 * @property {number} x @property {number} y @property {number} w @property {number} h
 * @property {number} rot
 * @property {string} text
 * @property {import("./protocol.js").Style} style
 * @property {string|null} [frameId]
 * @property {number[]} [points]
 * @property {string} [from] @property {string} [to]
 * @property {string} [fromSide] @property {string} [toSide] @property {string} [routing]
 * @property {number[]} [segments] @property {[number, number]|null} [curve]
 * @property {string} [packId] @property {string} [iconId]
 * @property {string} [language] @property {"light"|"dark"} [theme] @property {boolean} [lineNumbers]
 * @property {boolean} [wrap] @property {string} [filename]
 */

/**
 * @typedef {object} BackupDocument
 * @property {string} format
 * @property {number} version
 * @property {PortableObject[]} objects
 * @property {{x: number, y: number}} [origin]
 * @property {string} [title]
 * @property {"dots"|"grid"|"plain"} [background]
 * @property {string} [exportedAt]  ISO time
 */

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

/**
 * The portable form of `list` (objects of `all`): bottom to top, connectors only when both
 * endpoints are in `list`, `frameId` only when its frame is. Nothing else is carried.
 * @param {WhiteboardObject[]} list
 * @param {Record<string, WhiteboardObject>} all
 * @returns {PortableObject[]}
 */
export function toPortable(list, all) {
  const ids = new Set(list.map((o) => o.id));
  /** @type {PortableObject[]} */
  const out = [];
  for (const o of [...list].sort(compareObjects)) {
    if (o.type === "connector" && !(o.from && o.to && ids.has(o.from) && ids.has(o.to))) continue;
    /** @type {PortableObject} */
    const p = { id: o.id, type: o.type, x: o.x, y: o.y, w: o.w, h: o.h, rot: o.rot, text: o.text, style: { ...o.style } };
    if (o.type !== "frame" && o.type !== "connector") {
      const f = effectiveFrameId(o, all);
      p.frameId = f && ids.has(f) ? f : null;
    }
    if (o.type === "pen") p.points = [...(o.points ?? [])];
    if (o.type === "icon") { p.packId = o.packId; p.iconId = o.iconId; }
    if (o.type === "code") {
      p.language = o.language; p.theme = o.theme; p.lineNumbers = o.lineNumbers; p.wrap = o.wrap; p.filename = o.filename;
    }
    if (o.type === "connector") {
      p.from = o.from; p.to = o.to;
      p.fromSide = o.fromSide; p.toSide = o.toSide; p.routing = o.routing;
      // Route edits, only when present (older connectors have neither).
      if (o.segments?.length) p.segments = [...o.segments];
      if (o.curve) p.curve = [o.curve[0], o.curve[1]];
    }
    out.push(p);
  }
  return out;
}

/**
 * The whole board as a backup document.
 * @param {Pick<BoardSnapshot, "title"|"background"|"objects">} board
 * @param {{now?: number}} [opts]
 * @returns {BackupDocument}
 */
export function buildBackup(board, { now = Date.now() } = {}) {
  const all = board.objects ?? {};
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date(now).toISOString(),
    title: board.title,
    background: board.background,
    objects: toPortable(Object.values(all), all),
  };
}

/**
 * Copied objects as a clipboard document. `origin` is the top-left of their bounds.
 * @param {WhiteboardObject[]} list
 * @param {Record<string, WhiteboardObject>} all
 * @returns {BackupDocument}
 */
export function buildClipboard(list, all) {
  const objects = toPortable(list, all);
  const b = portableBounds(objects);
  return {
    format: BACKUP_FORMAT, version: BACKUP_VERSION,
    origin: { x: b ? b.x : 0, y: b ? b.y : 0 },
    objects,
  };
}

// ---------------------------------------------------------------------------------------------
// Migrations: version n -> n + 1, applied in order until BACKUP_VERSION
// ---------------------------------------------------------------------------------------------

/**
 * Version 0 is a bare board snapshot, as `getBoard()` returns it (`objects` a record keyed by
 * id, stacking by `z`). Version 1 lists objects bottom to top and drops everything else.
 * @type {Readonly<Record<number, (doc: any) => any>>}
 */
export const MIGRATIONS = Object.freeze({
  0: (doc) => {
    const record = isObject(doc.objects) ? doc.objects : {};
    const list = Object.values(record).filter((o) => isObject(o) && typeof o.id === "string" && isObjectType(o.type))
      .map((o) => ({ ...o, z: typeof o.z === "string" ? o.z : "" }))
      .sort(compareObjects);
    return {
      format: BACKUP_FORMAT, version: 1,
      title: typeof doc.title === "string" ? doc.title : undefined,
      background: doc.background,
      objects: list,
    };
  },
});

/**
 * Detects the version of a parsed document and upgrades it to BACKUP_VERSION.
 * @param {unknown} raw
 * @returns {{doc: any, from: number}|{error: string}}
 */
export function migrateBackup(raw) {
  if (!isObject(raw)) return { error: "This is not a whiteboard backup." };
  const r = /** @type {Record<string, any>} */ (raw);
  let version = r.version;
  if (version === undefined && isObject(r.objects)) version = 0; // a getBoard() snapshot
  if (r.format !== undefined && r.format !== BACKUP_FORMAT) return { error: "This is not a whiteboard backup." };
  if (!Number.isSafeInteger(version) || version < 0) return { error: "This is not a whiteboard backup." };
  if (version > BACKUP_VERSION) {
    return { error: `This backup was made by a newer whiteboard (format version ${version}); this one reads up to version ${BACKUP_VERSION}.` };
  }
  const from = version;
  let doc = r;
  while (version < BACKUP_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) return { error: `No migration from backup format version ${version}.` };
    doc = step(doc);
    version++;
  }
  return { doc, from };
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

/**
 * A cleaned object ready to be placed: the normalised object without an id, plus its local `ref`
 * and cleaned local references.
 * @typedef {object} Entry
 * @property {string} ref
 * @property {number} index  position in the document's `objects`
 * @property {Record<string, any>} object  normalised fields (no id, z, version, timestamps)
 * @property {string|null} frameRef
 * @property {string|null} fromRef
 * @property {string|null} toRef
 */

/**
 * @typedef {object} ParsedBackup
 * @property {Entry[]} entries  bottom to top
 * @property {Record<string, number>} counts  entries per type
 * @property {string[]} errors  the first BACKUP_LIMITS.errors problems, human readable
 * @property {number} skipped   objects left out (invalid, duplicate, over the cap, dangling connector)
 * @property {{x: number, y: number}|null} origin
 * @property {string|null} title
 * @property {"dots"|"grid"|"plain"|null} background
 * @property {number} fromVersion
 */

/** @param {unknown} v */
// A NUL-prefixed ref is reserved for objects saved without an id (see parseBackup), so a real id
// can never collide with one.
const cleanRef = (v) => (typeof v === "string" && v.length > 0 && v.length <= BACKUP_LIMITS.refLength && v[0] !== "\u0000" ? v : null);

/** Placeholder id so normalizeNewObject accepts an entry; replaced on placement. */
const PLACEHOLDER_ID = "o_000000000000";

/**
 * Parses and validates a backup or clipboard document (text or already-parsed JSON). Never
 * throws; a document that cannot be read at all gives `{error}`.
 * @param {unknown} input
 * @returns {ParsedBackup|{error: string}}
 */
export function parseBackup(input) {
  let raw = input;
  if (typeof input === "string") {
    if (input.length > BACKUP_LIMITS.textChars) {
      return { error: `This backup is too large (over ${Math.round(BACKUP_LIMITS.textChars / 1024 / 1024)} MB).` };
    }
    try {
      raw = JSON.parse(input);
    } catch {
      return { error: "This is not a whiteboard backup (it is not valid JSON)." };
    }
  }
  const migrated = migrateBackup(raw);
  if ("error" in migrated) return migrated;
  const doc = migrated.doc;
  if (!Array.isArray(doc.objects)) return { error: "This is not a whiteboard backup (it has no objects list)." };

  /** @type {string[]} */
  const errors = [];
  let skipped = 0;
  const problem = (/** @type {string} */ message) => {
    skipped++;
    if (errors.length < BACKUP_LIMITS.errors) errors.push(message);
  };

  /** @type {Entry[]} */
  const entries = [];
  /** @type {Map<string, Entry>} */
  const byRef = new Map();
  const list = /** @type {unknown[]} */ (doc.objects);
  list.forEach((item, index) => {
    if (entries.length >= BACKUP_LIMITS.objects) {
      problem(`Object ${index + 1}: over the limit of ${BACKUP_LIMITS.objects} objects.`);
      return;
    }
    if (!isObject(item)) return problem(`Object ${index + 1}: not an object.`);
    const o = /** @type {Record<string, any>} */ (item);
    if (!isObjectType(o.type)) return problem(`Object ${index + 1}: unknown type.`);
    const ref = cleanRef(o.id) ?? `\u0000${index}`;
    if (byRef.has(ref)) return problem(`Object ${index + 1}: duplicate id.`);
    // Only known fields reach the normaliser; it drops everything else (versions, timestamps,
    // createdBy, z) and clamps what it keeps.
    const norm = /** @type {Record<string, any>|null} */ (normalizeNewObject({
      id: PLACEHOLDER_ID, type: o.type, x: o.x, y: o.y, w: o.w, h: o.h, rot: o.rot, text: o.text,
      style: o.style, points: o.points, fromSide: o.fromSide, toSide: o.toSide, routing: o.routing,
      segments: o.segments, curve: o.curve,
      packId: o.packId, iconId: o.iconId,
      language: o.language, theme: o.theme, lineNumbers: o.lineNumbers, wrap: o.wrap, filename: o.filename,
    }));
    if (!norm) return problem(`Object ${index + 1}: invalid.`);
    delete norm.id;
    delete norm.z;
    delete norm.frameId;
    if (o.type === "pen") {
      const pts = cleanPoints(o.points);
      if (!pts) return problem(`Object ${index + 1}: a drawing without valid points.`);
      norm.points = pts;
    }
    if (o.type === "connector") { delete norm.from; delete norm.to; }
    /** @type {Entry} */
    const entry = {
      ref, index, object: norm,
      frameRef: o.type === "frame" || o.type === "connector" ? null : cleanRef(o.frameId),
      fromRef: o.type === "connector" ? cleanRef(o.from) : null,
      toRef: o.type === "connector" ? cleanRef(o.to) : null,
    };
    entries.push(entry);
    byRef.set(ref, entry);
  });

  // References: a frameId must name a frame of this document; a connector needs both endpoints
  // (neither a connector).
  /** @type {Entry[]} */
  const kept = [];
  for (const e of entries) {
    if (e.frameRef && byRef.get(e.frameRef)?.object.type !== "frame") e.frameRef = null;
    if (e.object.type === "connector") {
      const a = e.fromRef ? byRef.get(e.fromRef) : undefined;
      const b = e.toRef ? byRef.get(e.toRef) : undefined;
      if (!a || !b || a === b || a.object.type === "connector" || b.object.type === "connector") {
        problem(`Object ${e.index + 1}: a connector whose ends are not both in the backup.`);
        continue;
      }
    }
    kept.push(e);
  }

  /** @type {Record<string, number>} */
  const counts = {};
  for (const e of kept) counts[e.object.type] = (counts[e.object.type] ?? 0) + 1;
  const origin = isObject(doc.origin) ? { x: cleanCoord(doc.origin.x) ?? 0, y: cleanCoord(doc.origin.y) ?? 0 } : null;
  const title = typeof doc.title === "string" ? cleanLine(doc.title, LIMITS.boardTitle) || null : null;
  const background = BACKGROUNDS.includes(doc.background) ? doc.background : null;
  return { entries: kept, counts, errors, skipped, origin, title, background, fromVersion: migrated.from };
}

/**
 * Bounds of the drawable entries (connectors excluded), or null.
 * @param {Array<Entry|PortableObject>} list
 * @returns {Rect|null}
 */
export function entriesBounds(list) {
  /** @type {Rect[]} */
  const rects = [];
  for (const item of list) {
    const o = "object" in item ? item.object : item;
    if (o.type === "connector") continue;
    rects.push(rotatedBounds(/** @type {any} */ (o)));
  }
  return unionRects(rects);
}

/** @param {PortableObject[]} list */
function portableBounds(list) {
  return entriesBounds(list);
}

/**
 * Turns entries into create payloads with fresh ids, offset by (dx, dy). Frames come first, then
 * other objects, then connectors, each group in document order (creates stack in array order, so
 * relative stacking is kept). At most `max` objects; a connector only when both endpoints are
 * created. No `z`: creates go on top.
 * @param {Entry[]} entries
 * @param {{newId: () => string, dx?: number, dy?: number, max?: number}} opts
 * @returns {{creates: Array<Record<string, any>>, idMap: Map<string, string>, dropped: number}}
 */
export function planCreates(entries, { newId, dx = 0, dy = 0, max = Infinity }) {
  const frames = entries.filter((e) => e.object.type === "frame");
  const others = entries.filter((e) => e.object.type !== "frame" && e.object.type !== "connector");
  const connectors = entries.filter((e) => e.object.type === "connector");
  /** @type {Map<string, string>} */
  const idMap = new Map();
  /** @type {Array<Record<string, any>>} */
  const creates = [];
  let dropped = 0;
  const shift = (/** @type {number} */ v, /** @type {number} */ d) => cleanCoord(v + d) ?? v;
  for (const e of [...frames, ...others]) {
    if (creates.length >= max) { dropped++; continue; }
    const id = newId();
    idMap.set(e.ref, id);
    /** @type {Record<string, any>} */
    const c = { ...structuredCopy(e.object), id, x: shift(e.object.x, dx), y: shift(e.object.y, dy) };
    if (e.object.type !== "frame") c.frameId = null;
    creates.push(c);
  }
  // Frame membership once every frame has its new id.
  for (const [i, e] of [...frames, ...others].entries()) {
    const c = creates[i];
    if (!c || e.object.type === "frame") continue;
    c.frameId = e.frameRef ? idMap.get(e.frameRef) ?? null : null;
  }
  for (const e of connectors) {
    const from = e.fromRef ? idMap.get(e.fromRef) : undefined;
    const to = e.toRef ? idMap.get(e.toRef) : undefined;
    if (creates.length >= max || !from || !to) { dropped++; continue; }
    const id = newId();
    idMap.set(e.ref, id);
    creates.push({ ...structuredCopy(e.object), id, from, to });
  }
  return { creates, idMap, dropped };
}

/**
 * The offset that puts the entries' bounds centred on `at`.
 * @param {Entry[]} entries @param {{x: number, y: number}} at
 */
export function offsetToCenter(entries, at) {
  const b = entriesBounds(entries);
  if (!b) return { dx: 0, dy: 0 };
  return { dx: Math.round(at.x - (b.x + b.w / 2)), dy: Math.round(at.y - (b.y + b.h / 2)) };
}

/** Gap between existing content and an import placed beside it (as addStickies). */
export const IMPORT_GAP = 200;

/**
 * The offset that places `entries` for an import: top-left at `at`; else unchanged on an empty
 * board; else right of existing content, aligned with its top.
 * @param {import("../shared/backup.js").Entry[]} entries
 * @param {Record<string, any>} objects  current board objects
 * @param {unknown} at
 */
export function importOffset(entries, objects, at) {
  const b = entriesBounds(entries);
  if (!b) return { dx: 0, dy: 0 };
  if (isObject(at) && Number.isFinite(/** @type {any} */ (at).x) && Number.isFinite(/** @type {any} */ (at).y)) {
    const a = /** @type {{x: number, y: number}} */ (at);
    return keepInside(b, a.x - b.x, a.y - b.y);
  }
  const existing = boardBounds(objects);
  if (!existing) return { dx: 0, dy: 0 };
  return keepInside(b, existing.x + existing.w + IMPORT_GAP - b.x, existing.y - b.y);
}

/**
 * Limits an offset so the moved group stays within ±LIMITS.coord as a whole; clamping each
 * coordinate on its own would pile everything up on the edge and lose the layout.
 * @param {{x: number, y: number, w: number, h: number}} b
 * @param {number} dx @param {number} dy
 */
function keepInside(b, dx, dy) {
  const axis = (/** @type {number} */ lo, /** @type {number} */ size, /** @type {number} */ d) => {
    const min = -LIMITS.coord - lo;
    const max = LIMITS.coord - (lo + size);
    return min > max ? d : Math.min(max, Math.max(min, d));
  };
  return { dx: axis(b.x, b.w, dx), dy: axis(b.y, b.h, dy) };
}

// ---------------------------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------------------------

/**
 * Plain text as sticky-note entries: one per non-empty line in a square-ish grid, or, when the
 * text is tab-separated (a table copied from a spreadsheet), one per non-empty cell at its row
 * and column. At most `max` stickies; text beyond LIMITS.text per note is cut.
 * @param {string} text
 * @param {{max?: number}} [opts]
 * @returns {{entries: Entry[], truncated: number}}
 */
export function textToEntries(text, { max = BACKUP_LIMITS.textStickies } = {}) {
  const src = String(text ?? "").slice(0, BACKUP_LIMITS.textChars);
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const table = lines.filter((l) => l.trim()).length > 0 && lines.some((l) => l.includes("\t"));
  const { size, gap } = TEXT_STICKY;
  /** @type {{text: string, row: number, col: number}[]} */
  const cells = [];
  let total = 0;
  if (table) {
    let row = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      line.split("\t").forEach((cell, col) => {
        const t = cleanText(cell.trim(), LIMITS.text);
        if (!t) return;
        total++;
        if (cells.length < max) cells.push({ text: t, row, col });
      });
      row++;
    }
  } else {
    const items = lines.map((l) => cleanText(l.trim(), LIMITS.text)).filter(Boolean);
    total = items.length;
    const shown = items.slice(0, max);
    const columns = Math.max(1, Math.ceil(Math.sqrt(shown.length)));
    shown.forEach((t, i) => cells.push({ text: t, row: Math.floor(i / columns), col: i % columns }));
  }
  const d = TYPE_DEFAULTS.sticky;
  const entries = cells.map((c, i) => ({
    ref: `t${i}`, index: i, frameRef: null, fromRef: null, toRef: null,
    object: {
      type: "sticky", x: c.col * (size + gap), y: c.row * (size + gap), w: size, h: size, rot: 0,
      text: c.text, style: { ...d.style },
    },
  }));
  return { entries, truncated: Math.max(0, total - cells.length) };
}

/**
 * A fenced Markdown code block (```lang ... ```), the whole of `text`, as one code-block entry;
 * null when `text` is not exactly one fence. The language comes from the fence's info string, else
 * `detect(code)`. Linear: no regular expression over the text.
 * @param {string} text
 * @param {(code: string) => string} [detect]
 * @returns {Entry|null}
 */
export function codeFenceToEntry(text, detect = () => "plain") {
  const src = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (src.length > LIMITS.codeText + 400 || !(src.startsWith("```") || src.startsWith("~~~"))) return null;
  const mark = src.slice(0, 3);
  const firstEnd = src.indexOf("\n");
  if (firstEnd < 0 || !src.endsWith(mark)) return null;
  const lastStart = src.lastIndexOf("\n");
  if (lastStart <= firstEnd || src.slice(lastStart + 1).trim() !== mark) return null;
  const info = src.slice(3, firstEnd).trim().split(" ")[0] ?? "";
  const code = src.slice(firstEnd + 1, lastStart);
  // Another fence inside means this is Markdown with several blocks, not one code block.
  if (code.split("\n").some((l) => l.trimStart().startsWith(mark))) return null;
  const norm = /** @type {Record<string, any>|null} */ (normalizeNewObject({
    id: PLACEHOLDER_ID, type: "code", text: code, language: resolveLanguage(info) ?? detect(code),
  }));
  if (!norm) return null;
  norm.h = Math.min(LIMITS.sizeMax, codeHeight(norm));
  delete norm.id; delete norm.z; delete norm.frameId;
  return { ref: "c0", index: 0, object: norm, frameRef: null, fromRef: null, toRef: null };
}

/**
 * The text a copy puts on the clipboard as text/plain: each object's text on its own line.
 * @param {PortableObject[]} list
 */
export function plainTextOf(list) {
  return list.filter((o) => o.type !== "connector" && o.text).map((o) => o.text).join("\n");
}

/**
 * A plain deep copy of JSON-like data.
 * @template T
 * @param {T} v
 * @returns {T}
 */
function structuredCopy(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return /** @type {any} */ (v.map(structuredCopy));
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, val] of Object.entries(v)) if (val !== undefined) out[k] = structuredCopy(val);
  return /** @type {T} */ (out);
}
