// @ts-check
// The network map's data contract, shared by server, client, harness and tests: limits, ids,
// sanitisers, the stored-size estimator, per-kind normalisers and presence cleaning.
//
// Stored objects are plain JSON-compatible values. Every object carries `id` (its prefix names its
// kind), `version` (bumped once per request that changes it), `createdAt`, `createdBy`,
// `updatedAt`. Defaults are omitted from storage (an absent `tags` means none) so a large map
// costs as little storage and memory as possible; `expand*` helpers are not needed because every
// reader treats an absent field as its default.
//
// Kinds (id prefix):
//   e  element      a node: label, typeId, description, tags, aliases, fields, externalRefs, provenance
//   c  connection   an edge: from, to, direction, typeId, label, polarity, strength, fields, ...
//   l  loop         an ordered closed traversal of connections, with a manual R/B classification
//   v  view         a named lens: decoration rules, filter, focus, showcase, layout
//   t  type         an element or connection type: name, colour, shape
//   f  field        a custom field definition: name, kind, appliesTo, choices
// Not objects: h (history entry), x (changeset), i (changeset item).
//
// Field values: absent means unset; an explicit null means "cleared" (reserved for the overlay
// layer of Phase 2 source sync; in Phase 1 a null value is stored as absent).

import { truncateText } from "./graphemes.js";

export const SCHEMA_VERSION = 1;

export const LIMITS = Object.freeze({
  elements: 10_000,
  connections: 30_000,
  loops: 500,
  views: 50,
  types: 100,
  fields: 200,
  /** storedBytes of one object. */
  objectBytes: 64 * 1024,
  /** storedBytes of all objects together (elements, connections, loops, views, types, fields). */
  objectsBytes: 16 * 1024 * 1024,
  /** storedBytes of all stored positions, every view. */
  positionsBytes: 4 * 1024 * 1024,
  /** storedBytes of all undo data (inverse chunks). */
  inverseBytes: 4 * 1024 * 1024,
  /** storedBytes of one history entry's inverse; a larger change is recorded but cannot be undone. */
  inverseEntryBytes: 1024 * 1024,
  /** storedBytes of every staged changeset together. */
  stagingBytes: 8 * 1024 * 1024,
  /** Largest value written under one storage key (Durable Object storage allows 128 KiB). */
  valueBytes: 100 * 1024,
  label: 200,
  title: 200,
  description: 20_000,
  tags: 32,
  tag: 60,
  aliases: 16,
  externalRefs: 8,
  externalKey: 200,
  fieldText: 2_000,
  fieldLongText: 20_000,
  choices: 100,
  choice: 80,
  typeName: 60,
  fieldName: 60,
  viewName: 80,
  rules: 64,
  predicates: 16,
  inValues: 100,
  focusRoots: 50,
  loopSteps: 100,
  displayName: 40,
  summary: 200,
  opsPerRequest: 2000,
  /** Objects one request may create, change or delete, cascades included. */
  commitObjects: 2000,
  /** Position entries one request may write. */
  movesPerRequest: 2000,
  historyEntries: 200,
  historyBytes: 90 * 1024,
  requestRecords: 500,
  requestRecordBytes: 64 * 1024,
  subscribers: 200,
  coord: 10_000_000,
  strength: 1_000_000,
  // Presence payload caps. Larger arrays are truncated.
  presenceSelection: 200,
  presenceDrag: 200,
  /** Snapshot page size (storedBytes). S2 measured the transport; see docs/plans/network-map-blueprint.md. */
  snapshotPageBytes: 1024 * 1024,
  snapshotTokens: 32,
  snapshotTokenMs: 120_000,
});

export const PRESENCE_HEARTBEAT_MS = 4000;
export const PRESENCE_STALE_MS = 12000;

export const DEFAULT_TITLE = "Untitled map";
export const DEFAULT_VIEW_NAME = "Default";

export const KINDS = Object.freeze({ e: "element", c: "connection", l: "loop", v: "view", t: "type", f: "field" });
/** @typedef {"element"|"connection"|"loop"|"view"|"type"|"field"} Kind */

export const DIRECTIONS = /** @type {const} */ (["directed", "undirected", "mutual"]);
export const POLARITIES = /** @type {const} */ (["+", "-", "unknown"]);
export const SHAPES = /** @type {const} */ (["circle", "square", "diamond", "triangle", "hexagon"]);
export const FIELD_KINDS = /** @type {const} */ (["text", "longtext", "number", "date", "daterange", "bool", "choice", "multichoice", "url"]);
export const APPLIES_TO = /** @type {const} */ (["element", "connection", "both"]);
export const LAYOUT_KINDS = /** @type {const} */ (["force", "circle", "grid", "manual"]);
export const PROVENANCE_ORIGINS = /** @type {const} */ (["manual", "import", "source", "agent"]);

/** Categorical palette (validated for contrast on light and dark canvases). */
export const PALETTE = Object.freeze(["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac"]);
export const DEFAULT_ELEMENT_COLOR = "#4e79a7";
export const DEFAULT_CONNECTION_COLOR = "#9aa3ad";

// ---------------------------------------------------------------------------------------------
// Ids and tokens
// ---------------------------------------------------------------------------------------------

export const ID_PREFIX = Object.freeze({
  element: "e", connection: "c", loop: "l", view: "v", type: "t", field: "f",
  history: "h", changeset: "x", item: "i", group: "g",
});

const ID_RE = /^[a-z]_[0-9a-f]{12}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9:_-]{1,64}$/;
const SESSION_RE = /^[0-9a-f]{32}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// C0/C1 controls except tab and newline, plus bidi overrides.
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** @param {keyof typeof ID_PREFIX} kind @returns {string} */
export function newId(kind) {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return ID_PREFIX[kind] + "_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {unknown} id
 * @param {keyof typeof ID_PREFIX} [kind]  any object kind when omitted
 * @returns {id is string}
 */
export function isId(id, kind) {
  if (typeof id !== "string" || !ID_RE.test(id)) return false;
  return kind ? id[0] === ID_PREFIX[kind] : Object.hasOwn(KINDS, id[0]);
}

/** @param {string} id @returns {Kind|null} */
export function kindOf(id) {
  return typeof id === "string" && ID_RE.test(id) ? /** @type {any} */ (KINDS)[id[0]] ?? null : null;
}

/** @param {unknown} v @returns {v is string} */
export function isRequestId(v) {
  return typeof v === "string" && REQUEST_ID_RE.test(v);
}

/** @param {unknown} v @returns {v is string} */
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

/** @param {unknown} v @returns {v is Record<string, any>} */
export const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Single-line text: controls and newlines removed, trimmed, truncated without splitting a character. */
export function cleanLine(/** @type {unknown} */ value, /** @type {number} */ max) {
  if (value == null) return "";
  return truncateText(String(value).replace(CONTROL_RE, "").replace(/[\r\n\t]+/g, " ").trim(), max);
}

/** Multi-line text: controls removed (tabs and newlines kept), CRLF normalised, truncated. */
export function cleanText(/** @type {unknown} */ value, /** @type {number} */ max) {
  if (value == null) return "";
  return truncateText(String(value).replace(/\r\n?/g, "\n").replace(CONTROL_RE, ""), max);
}

/** @param {unknown} name @param {string} fallback */
export function cleanName(name, fallback) {
  return cleanLine(name, LIMITS.displayName) || fallback;
}

/** "#rrggbb" lowercased, or null. */
export function cleanColor(/** @type {unknown} */ value) {
  return typeof value === "string" && COLOR_RE.test(value) ? value.toLowerCase() : null;
}

/** A finite number clamped to [min, max] and rounded to `decimals`, or null. */
export function cleanNumber(/** @type {unknown} */ v, /** @type {number} */ min, /** @type {number} */ max, decimals = 2) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const f = 10 ** decimals;
  return Math.round(Math.min(max, Math.max(min, v)) * f) / f + 0;
}

/** @param {unknown} v */
export const cleanCoord = (v) => cleanNumber(v, -LIMITS.coord, LIMITS.coord, 1);

/** @param {unknown} v @returns {string|null} a valid calendar date "YYYY-MM-DD" */
export function cleanDate(v) {
  if (typeof v !== "string") return null;
  const m = DATE_RE.exec(v.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? m[0] : null;
}

/** @param {unknown} v @returns {string|null} an http(s) URL without credentials */
export function cleanUrl(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > 2000) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * A list of distinct single-line strings, each at most `each` long, at most `max` of them.
 * @param {unknown} v @param {number} max @param {number} each
 */
export function cleanStringList(v, max, each) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const item of v) {
    const s = cleanLine(item, each);
    const key = s.toLowerCase();
    if (!s || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Case- and space-insensitive form of a label or alias, for matching (never identity). */
export function normalizeLabel(/** @type {unknown} */ s) {
  return cleanLine(s, LIMITS.label).toLowerCase().replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------------------------
// Stored size (copied from the whiteboard's protocol.js; see its notes)
// ---------------------------------------------------------------------------------------------

const ASCII_RE = /^[\u0000-\u007f]*$/;
const LATIN1_RE = /^[\u0000-ÿ]*$/;
const encoder = new TextEncoder();
const V8_NUMBER = 9;
const V8_STRING = 5;
const V8_CONTAINER = 10;
const V8_ELEMENT = 4;

/** @param {string} str */
function stringBytes(str) {
  const json = JSON.stringify(str);
  const utf8 = ASCII_RE.test(json) ? json.length : encoder.encode(json).length;
  const v8 = (LATIN1_RE.test(str) ? str.length : 2 * str.length) + V8_STRING;
  return Math.max(utf8, v8);
}

/** @param {unknown} value @returns {number} */
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
      for (const key of Object.keys(value)) n += stringBytes(key) + 2 + valueBytes(/** @type {any} */ (value)[key]);
      return n;
    }
    default: return 5;
  }
}

/**
 * Upper bound of the stored size of `value` in bytes: at least the UTF-8 length of its JSON and at
 * least its V8 serialisation (what Durable Object storage and RPC write). A guard, not an exact
 * memory model.
 * @param {unknown} value
 */
export function storedBytes(value) {
  return valueBytes(value) + 2;
}

// ---------------------------------------------------------------------------------------------
// Field values
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} FieldDef
 * @property {string} id
 * @property {string} name
 * @property {typeof FIELD_KINDS[number]} kind
 * @property {typeof APPLIES_TO[number]} appliesTo
 * @property {string[]} [choices]
 */

/**
 * Cleans one field value for its definition. Returns `undefined` when the value is invalid (the
 * caller reports it), `null` for an explicit clear.
 * @param {FieldDef} def @param {unknown} v
 * @returns {unknown}
 */
export function cleanFieldValue(def, v) {
  if (v === null) return null;
  switch (def.kind) {
    case "text": return typeof v === "string" || typeof v === "number" ? cleanLine(v, LIMITS.fieldText) : undefined;
    case "longtext": return typeof v === "string" ? cleanText(v, LIMITS.fieldLongText) : undefined;
    case "number": {
      const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
      return typeof n === "number" && Number.isFinite(n) ? n : undefined;
    }
    case "date": return cleanDate(v) ?? undefined;
    case "daterange": {
      if (!isObject(v)) return undefined;
      const from = v.from == null ? null : cleanDate(v.from), to = v.to == null ? null : cleanDate(v.to);
      if ((v.from != null && !from) || (v.to != null && !to) || (!from && !to)) return undefined;
      if (from && to && from > to) return undefined;
      return { from, to };
    }
    case "bool": return typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined;
    case "choice": {
      const s = cleanLine(v, LIMITS.choice);
      return (def.choices ?? []).includes(s) ? s : undefined;
    }
    case "multichoice": {
      const list = Array.isArray(v) ? v : typeof v === "string" ? v.split("|") : null;
      if (!list) return undefined;
      const allowed = new Set(def.choices ?? []);
      const out = cleanStringList(list, LIMITS.choices, LIMITS.choice);
      return out.every((s) => allowed.has(s)) ? out : undefined;
    }
    case "url": return cleanUrl(v) ?? undefined;
    default: return undefined;
  }
}

/** @param {FieldDef} def @param {"element"|"connection"} kind */
export const fieldApplies = (def, kind) => def.appliesTo === "both" || def.appliesTo === kind;

// ---------------------------------------------------------------------------------------------
// Normalisers. Each takes raw caller input (a create's object or an update's merged result) and a
// context, and returns {value} or {error}. They never throw on bad input.
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} NormalizeContext
 * @property {(id: string) => any} get          current object by id (after earlier ops in the request)
 * @property {(id: string) => FieldDef|null} field
 */

/** Stored common fields, never taken from caller input. */
export const SYSTEM_FIELDS = Object.freeze(["id", "version", "createdAt", "createdBy", "updatedAt", "updatedBy"]);

/** Editable fields per kind (what an update patch may name). */
export const EDITABLE = Object.freeze({
  element: ["label", "typeId", "description", "tags", "aliases", "fields", "externalRefs", "provenance"],
  connection: ["from", "to", "direction", "typeId", "label", "description", "polarity", "strength", "tags", "fields", "externalRefs", "provenance"],
  loop: ["label", "steps", "classification", "description"],
  view: ["name", "rules", "filter", "focus", "showcase", "layout", "order", "description"],
  type: ["name", "color", "shape", "description"],
  field: ["name", "kind", "appliesTo", "choices", "description"],
});

/** @param {string} message */
const fail = (message) => ({ error: message });

/**
 * Cleans a `fields` map for an element or connection. Unknown field ids and fields for the other
 * kind are errors; null values drop the field (Phase 1 has no overlay layer).
 * @param {unknown} raw @param {"element"|"connection"} kind @param {NormalizeContext} ctx
 * @returns {{value: Record<string, unknown>}|{error: string}}
 */
function cleanFields(raw, kind, ctx) {
  if (raw === undefined || raw === null) return { value: {} };
  if (!isObject(raw)) return fail("fields must be an object of field id to value");
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [id, v] of Object.entries(raw)) {
    const def = isId(id, "field") ? ctx.field(id) : null;
    if (!def) return fail(`Unknown field ${cleanLine(id, 40)}`);
    if (!fieldApplies(def, kind)) return fail(`Field "${def.name}" does not apply to ${kind}s`);
    const value = cleanFieldValue(def, v);
    if (value === undefined) return fail(`Invalid value for field "${def.name}" (${def.kind})`);
    if (value === null || value === "" || (Array.isArray(value) && !value.length)) continue;
    out[id] = value;
  }
  return { value: out };
}

/** @param {unknown} raw */
function cleanExternalRefs(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const r of raw.slice(0, LIMITS.externalRefs)) {
    if (!isObject(r)) continue;
    const sourceId = cleanLine(r.sourceId, 80), key = cleanLine(r.key, LIMITS.externalKey);
    if (!sourceId || !key || seen.has(sourceId + "\0" + key)) continue;
    seen.add(sourceId + "\0" + key);
    out.push({ sourceId, key });
  }
  return out;
}

/** @param {unknown} raw */
function cleanProvenance(raw) {
  if (!isObject(raw)) return null;
  const origin = PROVENANCE_ORIGINS.includes(raw.origin) ? raw.origin : null;
  if (!origin || origin === "manual") return null;
  /** @type {Record<string, unknown>} */
  const p = { origin };
  if (typeof raw.changesetId === "string" && /^x_[0-9a-f]{12}$/.test(raw.changesetId)) p.changesetId = raw.changesetId;
  if (typeof raw.sourceName === "string") p.sourceName = cleanLine(raw.sourceName, 120);
  if (typeof raw.at === "number" && Number.isFinite(raw.at)) p.at = raw.at;
  if (typeof raw.acceptedBy === "string") p.acceptedBy = cleanName(raw.acceptedBy, "Anonymous");
  return p;
}

/**
 * @param {unknown} v @param {"element"|"connection"} kind @param {NormalizeContext} ctx
 * @returns {{value: string|null}|{error: string}}
 */
function cleanTypeRef(v, kind, ctx) {
  if (v === undefined || v === null || v === "") return { value: null };
  if (!isId(v, "type")) return fail("typeId must be a type id (t_…)");
  const t = ctx.get(v);
  if (!t) return fail(`No type ${v}`);
  if (t.appliesTo !== kind) return fail(`Type "${t.name}" is a ${t.appliesTo} type`);
  return { value: v };
}

/**
 * Drops default-valued optional fields so storage holds only what matters.
 * @param {Record<string, any>} o
 */
function compact(o) {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) || (isObject(v) && !Object.keys(v).length)) delete o[k];
  }
  return o;
}

/**
 * @param {Record<string, any>} raw @param {NormalizeContext} ctx
 * @returns {{value: Record<string, any>}|{error: string}}
 */
export function normalizeElement(raw, ctx) {
  const label = cleanLine(raw.label, LIMITS.label);
  if (!label) return fail("An element needs a label");
  const type = cleanTypeRef(raw.typeId, "element", ctx);
  if ("error" in type) return type;
  const fields = cleanFields(raw.fields, "element", ctx);
  if ("error" in fields) return fields;
  return {
    value: compact({
      label,
      typeId: type.value,
      description: cleanText(raw.description, LIMITS.description),
      tags: cleanStringList(raw.tags, LIMITS.tags, LIMITS.tag),
      aliases: cleanStringList(raw.aliases, LIMITS.aliases, LIMITS.label),
      fields: fields.value,
      externalRefs: cleanExternalRefs(raw.externalRefs),
      provenance: cleanProvenance(raw.provenance),
    }),
  };
}

/**
 * @param {Record<string, any>} raw @param {NormalizeContext} ctx
 * @returns {{value: Record<string, any>}|{error: string}}
 */
export function normalizeConnection(raw, ctx) {
  for (const end of /** @type {const} */ (["from", "to"])) {
    if (!isId(raw[end], "element")) return fail(`A connection needs ${end}: an element id (e_…)`);
    if (!ctx.get(raw[end])) return fail(`Connection ${end}: no element ${raw[end]}`);
  }
  const direction = raw.direction === undefined ? "directed" : raw.direction;
  if (!DIRECTIONS.includes(direction)) return fail("direction must be directed, undirected or mutual");
  const polarity = raw.polarity === undefined || raw.polarity === null ? "unknown" : raw.polarity;
  if (!POLARITIES.includes(polarity)) return fail('polarity must be "+", "-" or "unknown"');
  let strength = null;
  if (raw.strength !== undefined && raw.strength !== null && raw.strength !== "") {
    strength = cleanNumber(typeof raw.strength === "string" ? Number(raw.strength) : raw.strength, -LIMITS.strength, LIMITS.strength, 4);
    if (strength === null) return fail("strength must be a number");
  }
  const type = cleanTypeRef(raw.typeId, "connection", ctx);
  if ("error" in type) return type;
  const fields = cleanFields(raw.fields, "connection", ctx);
  if ("error" in fields) return fields;
  const out = compact({
    typeId: type.value,
    label: cleanLine(raw.label, LIMITS.label),
    description: cleanText(raw.description, LIMITS.description),
    polarity: polarity === "unknown" ? null : polarity,
    strength,
    tags: cleanStringList(raw.tags, LIMITS.tags, LIMITS.tag),
    fields: fields.value,
    externalRefs: cleanExternalRefs(raw.externalRefs),
    provenance: cleanProvenance(raw.provenance),
  });
  return { value: { from: raw.from, to: raw.to, direction, ...out } };
}

/**
 * The endpoints a loop step leaves from and arrives at.
 * @param {any} conn @param {boolean} fwd
 */
export const stepEnds = (conn, fwd) => (fwd ? [conn.from, conn.to] : [conn.to, conn.from]);

/**
 * A loop's traversal is valid when each step's arrival is the next step's departure and the last
 * arrives where the first departs. A directed connection may only be walked forwards.
 * @param {{c: string, fwd: boolean}[]} steps @param {(id: string) => any} get
 * @returns {string|null} what is wrong, or null
 */
export function loopProblem(steps, get) {
  if (!steps.length) return "A loop needs at least one connection";
  const conns = steps.map((s) => get(s.c));
  for (let i = 0; i < steps.length; i++) {
    const c = conns[i];
    if (!c || c.id?.[0] !== "c") return `Loop step ${i + 1}: no connection ${steps[i].c}`;
    if (c.direction === "directed" && !steps[i].fwd) return `Loop step ${i + 1}: a directed connection cannot be walked backwards`;
  }
  for (let i = 0; i < steps.length; i++) {
    const [, arrive] = stepEnds(conns[i], steps[i].fwd);
    const [depart] = stepEnds(conns[(i + 1) % steps.length], steps[(i + 1) % steps.length].fwd);
    if (arrive !== depart) return `Loop step ${i + 1} does not lead into step ${((i + 1) % steps.length) + 1}`;
  }
  return null;
}

/**
 * Derived loop polarity: "R" (reinforcing) with an even number of "-" connections, "B" with an odd
 * number, null when any connection's polarity is unknown.
 * @param {{c: string}[]} steps @param {(id: string) => any} get
 * @returns {"R"|"B"|null}
 */
export function derivedLoopPolarity(steps, get) {
  let negatives = 0;
  for (const s of steps) {
    const c = get(s.c);
    if (!c || (c.polarity !== "+" && c.polarity !== "-")) return null;
    if (c.polarity === "-") negatives++;
  }
  return negatives % 2 ? "B" : "R";
}

/**
 * @param {Record<string, any>} raw @param {NormalizeContext} ctx
 * @returns {{value: Record<string, any>}|{error: string}}
 */
export function normalizeLoop(raw, ctx) {
  if (!Array.isArray(raw.steps)) return fail("A loop needs steps: [{c: connectionId, fwd: true|false}]");
  if (raw.steps.length > LIMITS.loopSteps) return fail(`A loop may have at most ${LIMITS.loopSteps} steps`);
  const steps = [];
  for (const s of raw.steps) {
    if (!isObject(s) || !isId(s.c, "connection")) return fail("Each loop step needs c: a connection id (c_…)");
    steps.push({ c: s.c, fwd: s.fwd !== false });
  }
  const problem = loopProblem(steps, ctx.get);
  if (problem) return fail(problem);
  const classification = raw.classification === "R" || raw.classification === "B" ? raw.classification : null;
  return {
    value: compact({
      label: cleanLine(raw.label, LIMITS.label) || "Loop",
      steps,
      classification,
      description: cleanText(raw.description, LIMITS.description),
    }),
  };
}

/**
 * @param {Record<string, any>} raw
 * @returns {{value: Record<string, any>}|{error: string}}
 */
export function normalizeType(raw) {
  const name = cleanLine(raw.name, LIMITS.typeName);
  if (!name) return fail("A type needs a name");
  if (raw.appliesTo !== "element" && raw.appliesTo !== "connection") return fail('appliesTo must be "element" or "connection"');
  const shape = raw.shape === undefined || raw.shape === null ? null : raw.shape;
  if (shape !== null && !SHAPES.includes(shape)) return fail(`shape must be one of ${SHAPES.join(", ")}`);
  return {
    value: compact({
      name, appliesTo: raw.appliesTo, color: cleanColor(raw.color),
      shape: raw.appliesTo === "element" ? shape : null,
      description: cleanText(raw.description, 2000),
    }),
  };
}

/**
 * @param {Record<string, any>} raw
 * @returns {{value: Record<string, any>}|{error: string}}
 */
export function normalizeField(raw) {
  const name = cleanLine(raw.name, LIMITS.fieldName);
  if (!name) return fail("A field needs a name");
  if (!FIELD_KINDS.includes(raw.kind)) return fail(`kind must be one of ${FIELD_KINDS.join(", ")}`);
  const appliesTo = raw.appliesTo === undefined ? "element" : raw.appliesTo;
  if (!APPLIES_TO.includes(appliesTo)) return fail("appliesTo must be element, connection or both");
  const choices = raw.kind === "choice" || raw.kind === "multichoice" ? cleanStringList(raw.choices, LIMITS.choices, LIMITS.choice) : [];
  if ((raw.kind === "choice" || raw.kind === "multichoice") && !choices.length) return fail("A choice field needs choices");
  return { value: compact({ name, kind: raw.kind, appliesTo, choices, description: cleanText(raw.description, 2000) }) };
}

// View contents (rules, selectors) are validated by src/shared/rules.js; see normalizeView there.

// ---------------------------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} PresenceState
 * @property {string} clientId
 * @property {string} name
 * @property {string} color
 * @property {{x: number, y: number}|null} cursor   graph coordinates
 * @property {string|null} viewId
 * @property {string[]} selection
 * @property {{id: string, x: number, y: number}[]} drag   transient positions while dragging
 * @property {string|null} editingId
 * @property {string|null} following  a clientId whose camera this client follows
 * @property {{x: number, y: number, ratio: number}|null} camera
 */

/**
 * Cleans a presence update onto the previous state. Fields absent from `raw` keep `previous`.
 * @param {unknown} raw @param {string} clientId @param {PresenceState|null} previous
 * @returns {PresenceState}
 */
export function cleanPresence(raw, clientId, previous) {
  const r = /** @type {Record<string, any>} */ (isObject(raw) ? raw : {});
  const has = (/** @type {string} */ k) => Object.hasOwn(r, k);
  let cursor = previous?.cursor ?? null;
  if (has("cursor")) {
    const x = isObject(r.cursor) ? cleanCoord(r.cursor.x) : null;
    const y = isObject(r.cursor) ? cleanCoord(r.cursor.y) : null;
    cursor = x !== null && y !== null ? { x, y } : null;
  }
  let camera = previous?.camera ?? null;
  if (has("camera")) {
    const c = isObject(r.camera) ? r.camera : null;
    const x = c ? cleanNumber(c.x, -1e6, 1e6, 4) : null, y = c ? cleanNumber(c.y, -1e6, 1e6, 4) : null;
    const ratio = c ? cleanNumber(c.ratio, 0.001, 1000, 4) : null;
    camera = x !== null && y !== null && ratio !== null ? { x, y, ratio } : null;
  }
  let selection = previous?.selection ?? [];
  if (has("selection")) {
    selection = Array.isArray(r.selection) ? [...new Set(r.selection.slice(0, LIMITS.presenceSelection).filter((id) => isId(id)))] : [];
  }
  let drag = previous?.drag ?? [];
  if (has("drag")) {
    drag = [];
    for (const d of Array.isArray(r.drag) ? r.drag.slice(0, LIMITS.presenceDrag) : []) {
      if (!isObject(d) || !isId(d.id, "element")) continue;
      const x = cleanCoord(d.x), y = cleanCoord(d.y);
      if (x !== null && y !== null) drag.push({ id: d.id, x, y });
    }
  }
  const idOrNull = (/** @type {string} */ k, /** @type {any} */ kind) => (has(k) ? (isId(r[k], kind) ? r[k] : null) : previous?.[/** @type {"viewId"} */ (k)] ?? null);
  return {
    clientId,
    name: has("name") ? cleanName(r.name, previous?.name ?? "Guest") : previous?.name ?? "Guest",
    color: (has("color") ? cleanColor(r.color) : null) ?? previous?.color ?? "#e1632e",
    cursor,
    viewId: idOrNull("viewId", "view"),
    selection,
    drag,
    editingId: idOrNull("editingId", undefined),
    following: has("following") ? (typeof r.following === "string" ? cleanLine(r.following, 64) || null : null) : previous?.following ?? null,
    camera,
  };
}

// ---------------------------------------------------------------------------------------------
// Hashing (request payload digests, changeset digests). FNV-1a 64 over a canonical JSON string.
// Not cryptographic: it detects a changed payload, it does not authenticate one.
// ---------------------------------------------------------------------------------------------

/** @param {unknown} v @returns {string} JSON with object keys sorted */
export function canonicalJson(v) {
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (isObject(v)) return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
  return JSON.stringify(v ?? null);
}

/** @param {string} s @returns {string} 16 hex digits */
export function fnv64(s) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  const bytes = encoder.encode(s);
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

/** @param {unknown} v */
export const digestOf = (v) => fnv64(canonicalJson(v));
