// @ts-check
// File and paste imports (docs/plans/network-map-blueprint.md §6.5): Kumu spreadsheet layout
// (Elements and Connections tables, pasted as CSV/TSV), CSV edge lists and Kumu JSON (project
// export or blueprint). Each parser returns an ImportPlan: changeset items (the exact item format
// of src/core/changesets.js) plus a preview for the reviewer. Nothing here writes to the map; the
// server validates every item again and stays authoritative.
//
// Pure and DOM-free. Parsers never throw on bad input (they report problems instead), never build
// a regular expression from user input, and bound their work: at most MAX_ROWS rows and
// MAX_COLUMNS columns per table, LIST_CAP entries per preview list.
//
// GraphML and GEXF imports are Phase 2 (XML parsing through DOMParser) and are not here.
//
// Conventions:
// - Kumu's sheet headers match case-insensitively after trimming; "Element Type" and
//   "Connection Type" are accepted for "Type", "Sign" for "Polarity".
// - With an ID column, element keys are IDs and connection From/To are resolved as an ID first,
//   then as a label (case- and space-insensitive, when exactly one element has it). Without one,
//   keys are labels. FromID/ToID columns (written by our own CSV export) win over From/To.
// - An endpoint found in neither is created as a new element with that label, as Kumu does; the
//   preview lists it under `unresolved` and counts it in `autoCreated`.
// - A cell that starts with "'" followed by = + - @ tab or CR had its quote added by a
//   spreadsheet-safe export (src/shared/exports.js); the quote is removed.
// - A custom column with the same name in both tables becomes one field that applies to "both".
// - Field kinds are inferred per column (inferFieldKind). Dates are full YYYY-MM-DD only: partial
//   dates (YYYY, YYYY-MM) stay text rather than being silently widened to a day.

import { DIRECTIONS, LIMITS, cleanDate, cleanLine, cleanStringList, cleanText, cleanUrl, isObject, normalizeLabel } from "./protocol.js";

export const MAX_ROWS = 100_000;
export const MAX_COLUMNS = 200;
const LIST_CAP = 50;
const SAMPLES = 3;

/**
 * @typedef {"text"|"longtext"|"number"|"date"|"bool"|"choice"|"multichoice"|"url"} InferredKind
 */

/**
 * @typedef {object} ImportPreview
 * @property {number} elements
 * @property {number} connections
 * @property {string[]} types
 * @property {{name: string, kind: InferredKind, appliesTo: "element"|"connection"|"both", sample: string[]}[]} fields
 * @property {"," | "\t" | ";"} [delimiter]
 * @property {{elements?: string[], connections?: string[]}} [headers]
 * @property {string[]} duplicateKeys     keys used by more than one element row (later rows dropped), at most 50
 * @property {string[]} duplicateLabels   labels used by more than one element row when rows have IDs
 * @property {string[]} unresolved        connection endpoints not among the imported elements, at most 50
 * @property {number} autoCreated         elements created from those endpoints
 * @property {string[]} skipped           human-readable notes about what was not imported
 * @property {string[]} problems
 */

/**
 * @typedef {object} ImportPlan
 * @property {"kumu-sheets"|"edge-list"|"kumu-json"} format
 * @property {string} sourceName
 * @property {string} source   stable source id for external references, e.g. "kumu:<name>"
 * @property {any[]} items     changeset items: types, fields, elements, connections (in that order)
 * @property {ImportPreview} preview
 */

// ---------------------------------------------------------------------------------------------
// Delimited text
// ---------------------------------------------------------------------------------------------

/** @param {string} s */
function detectDelimiter(s) {
  const nl = s.indexOf("\n");
  const first = nl === -1 ? s : s.slice(0, nl);
  if (first.includes("\t")) return "\t";
  let semi = 0, comma = 0;
  for (let i = 0; i < first.length; i++) {
    if (first[i] === ";") semi++;
    else if (first[i] === ",") comma++;
  }
  return semi > comma ? ";" : ",";
}

/**
 * RFC 4180-style parsing: quoted cells, doubled quotes, CRLF or LF, newlines inside quotes. A
 * UTF-8 byte order mark is stripped and fully empty rows are skipped. The first row is the header.
 * @param {unknown} text
 * @param {{delimiter?: "," | "\t" | ";"}} [options]  detected from the first line when omitted
 * @returns {{delimiter: "," | "\t" | ";", headers: string[], rows: string[][], problems: string[]}}
 */
export function parseDelimited(text, options = {}) {
  /** @type {string[]} */
  const problems = [];
  let s = typeof text === "string" ? text : "";
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const d = options?.delimiter;
  const delimiter = d === "," || d === "\t" || d === ";" ? d : detectDelimiter(s);
  /** @type {string[][]} */
  const records = [];
  /** @type {string[]} */
  let row = [];
  let cell = "";
  let inQuotes = false;
  let tooManyColumns = false, tooManyRows = false;
  const n = s.length;
  const endCell = () => {
    if (row.length < MAX_COLUMNS) row.push(cell);
    else tooManyColumns = true;
    cell = "";
  };
  const endRow = () => {
    endCell();
    if (row.some((c) => c.trim() !== "")) records.push(row);
    row = [];
  };
  let i = 0;
  while (i < n) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 2; }
        else { inQuotes = false; i++; }
        continue;
      }
      const next = s.indexOf('"', i);
      if (next === -1) { cell += s.slice(i); i = n; break; }
      cell += s.slice(i, next);
      i = next;
      continue;
    }
    if (ch === '"' && cell === "") { inQuotes = true; i++; continue; }
    if (ch === delimiter) { endCell(); i++; continue; }
    if (ch === "\r" || ch === "\n") {
      endRow();
      i += ch === "\r" && s[i + 1] === "\n" ? 2 : 1;
      if (records.length > MAX_ROWS + 1) { records.pop(); tooManyRows = true; break; }
      continue;
    }
    cell += ch;
    i++;
  }
  if (inQuotes) problems.push("A quoted cell is never closed; the rest of the text was read as one cell");
  if (!tooManyRows && (cell !== "" || row.length)) {
    endRow();
    if (records.length > MAX_ROWS + 1) { records.pop(); tooManyRows = true; }
  }
  if (tooManyRows) problems.push(`Only the first ${MAX_ROWS.toLocaleString("en")} rows were read`);
  if (tooManyColumns) problems.push(`Only the first ${MAX_COLUMNS} columns were read`);
  const headers = (records[0] ?? []).map((h) => h.trim());
  return { delimiter, headers, rows: records.slice(1), problems };
}

// ---------------------------------------------------------------------------------------------
// Field kind inference and value conversion
// ---------------------------------------------------------------------------------------------

const BOOLS = new Map([["true", true], ["false", false], ["yes", true], ["no", false]]);

/** @param {string} s */
const isNumeric = (s) => s !== "" && Number.isFinite(Number(s));

/** @param {string} s */
const isHttp = (s) => {
  const lower = s.slice(0, 8).toLowerCase();
  return (lower.startsWith("http://") || lower.startsWith("https://")) && cleanUrl(s) !== null;
};

/** @param {string} s */
const splitList = (s) => s.split("|").map((t) => t.trim()).filter(Boolean);

/**
 * The field kind a column of cell values most likely holds. Empty cells are ignored; a column
 * with no values is "text".
 *   number       >= 90% of values are finite JavaScript numbers (after trimming)
 *   date         every value is a valid YYYY-MM-DD date (partial dates are not accepted)
 *   bool         every value is true/false/yes/no (any case)
 *   url          every value is an http(s) URL
 *   longtext     any value is longer than 200 characters or spans lines
 *   multichoice  some value holds "|" separators and there are at most 50 distinct items
 *   choice       at most 30 distinct values, at most half the count, and at least 2 repeats
 *   text         anything else
 * @param {string[]} values
 * @returns {InferredKind}
 */
export function inferFieldKind(values) {
  const list = (Array.isArray(values) ? values : []).map((v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim())).filter((v) => v !== "");
  if (!list.length) return "text";
  let numbers = 0;
  for (const v of list) if (isNumeric(v)) numbers++;
  if (numbers / list.length >= 0.9) return "number";
  if (list.every((v) => cleanDate(v) !== null)) return "date";
  if (list.every((v) => BOOLS.has(v.toLowerCase()))) return "bool";
  if (list.every(isHttp)) return "url";
  if (list.some((v) => v.length > 200 || v.includes("\n") || v.includes("\r"))) return "longtext";
  if (list.some((v) => v.includes("|"))) {
    const tokens = new Set();
    let fits = true;
    for (const v of list) {
      for (const t of splitList(v)) {
        if (t.length > LIMITS.choice) fits = false;
        tokens.add(t);
      }
      if (tokens.size > 50) break;
    }
    if (fits && tokens.size > 0 && tokens.size <= 50) return "multichoice";
  }
  const distinct = new Set(list);
  if (distinct.size <= 30 && distinct.size <= list.length / 2 && list.length - distinct.size >= 2 && list.every((v) => v.length <= LIMITS.choice)) return "choice";
  return "text";
}

/**
 * Converts one non-empty cell to a field value of `kind`, or undefined when it does not fit.
 * @param {InferredKind} kind @param {string} raw
 * @returns {unknown}
 */
function convertValue(kind, raw) {
  const v = raw.trim();
  switch (kind) {
    case "number": return isNumeric(v) ? Number(v) : undefined;
    case "date": return cleanDate(v) ?? undefined;
    case "bool": return BOOLS.get(v.toLowerCase());
    case "url": return cleanUrl(v) ?? undefined;
    case "multichoice": {
      const list = cleanStringList(splitList(v), LIMITS.choices, LIMITS.choice);
      return list.length ? list : undefined;
    }
    case "choice": return cleanLine(v, LIMITS.choice) || undefined;
    case "longtext": return cleanText(raw, LIMITS.fieldLongText) || undefined;
    default: return cleanLine(v, LIMITS.fieldText) || undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Records -> plan (shared by every format)
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} ElementRecord
 * @property {string} key
 * @property {string} label
 * @property {string} [type]
 * @property {string} [description]
 * @property {string[]} [tags]
 * @property {Map<string, string>} raw   field name -> cell text
 */

/**
 * @typedef {object} ConnectionRecord
 * @property {string} [key]
 * @property {string[]} fromRefs   tried in order: an id/key, then a label
 * @property {string[]} toRefs
 * @property {string} fromLabel    the label used when the endpoint is created
 * @property {string} toLabel
 * @property {string} [type]
 * @property {string} [direction]
 * @property {string} [label]
 * @property {"+"|"-"} [polarity]
 * @property {number} [strength]
 * @property {string} [description]
 * @property {string[]} [tags]
 * @property {Map<string, string>} raw
 */

/** @param {string[]} list @param {string} value */
const pushCapped = (list, value) => { if (list.length < LIST_CAP && !list.includes(value)) list.push(value); };

/** @param {unknown} name */
const sourceSlug = (name) => normalizeLabel(name).slice(0, 70) || "untitled";

/** @param {unknown} v @returns {string[]} */
function tagList(v) {
  if (Array.isArray(v)) return cleanStringList(v.filter((t) => typeof t === "string"), LIMITS.tags, LIMITS.tag);
  if (typeof v === "string") return cleanStringList(splitList(v), LIMITS.tags, LIMITS.tag);
  return [];
}

/** @param {unknown} v @returns {"+"|"-"|undefined} */
function polarityOf(v) {
  const s = typeof v === "string" ? v.trim().toLowerCase() : typeof v === "number" ? (v > 0 ? "+" : v < 0 ? "-" : "") : "";
  if (s === "+" || s === "positive" || s === "same" || s === "s" || s === "pos") return "+";
  if (s === "-" || s === "negative" || s === "opposite" || s === "o" || s === "neg") return "-";
  return undefined;
}

/**
 * Builds items and preview from parsed records.
 * @param {{format: ImportPlan["format"], sourceName: string, source: string, elements: ElementRecord[],
 *   connections: ConnectionRecord[], hasIds: boolean, problems: string[], skipped: string[],
 *   delimiter?: "," | "\t" | ";", headers?: {elements?: string[], connections?: string[]}}} input
 * @returns {ImportPlan}
 */
function buildPlan(input) {
  const { problems, skipped } = input;
  /** @type {string[]} */
  const duplicateKeys = [];
  /** @type {string[]} */
  const duplicateLabels = [];
  /** @type {string[]} */
  const unresolved = [];

  // Elements: first row per key wins.
  /** @type {Map<string, ElementRecord>} */
  const byKey = new Map();
  let duplicateRows = 0;
  for (const e of input.elements) {
    if (byKey.has(e.key)) { duplicateRows++; pushCapped(duplicateKeys, e.key); continue; }
    byKey.set(e.key, e);
  }
  if (duplicateRows) problems.push(`${duplicateRows} element row${duplicateRows === 1 ? "" : "s"} repeated an earlier key and ${duplicateRows === 1 ? "was" : "were"} left out`);
  /** @type {Map<string, string[]>} normalised label -> keys */
  const byLabel = new Map();
  for (const e of byKey.values()) {
    const n = normalizeLabel(e.label);
    const keys = byLabel.get(n);
    if (keys) keys.push(e.key);
    else byLabel.set(n, [e.key]);
  }
  if (input.hasIds) for (const [, keys] of byLabel) if (keys.length > 1) pushCapped(duplicateLabels, /** @type {ElementRecord} */ (byKey.get(keys[0])).label);

  /** @param {string} ref */
  const resolve = (ref) => {
    if (!ref) return null;
    if (byKey.has(ref)) return ref;
    const keys = byLabel.get(normalizeLabel(ref));
    return keys && keys.length === 1 ? keys[0] : null;
  };
  let autoCreated = 0;
  /** @param {string[]} refs @param {string} label */
  const endpoint = (refs, label) => {
    for (const r of refs) {
      const k = resolve(r);
      if (k) return k;
    }
    const name = cleanLine(label, LIMITS.label);
    if (!name) return null;
    pushCapped(unresolved, name);
    const key = cleanLine(label, LIMITS.externalKey);
    if (byKey.has(key)) return key;
    byKey.set(key, { key, label: name, raw: new Map() });
    byLabel.set(normalizeLabel(name), [key]);
    autoCreated++;
    return key;
  };

  /** @type {{rec: ConnectionRecord, from: string, to: string}[]} */
  const conns = [];
  let missingEnds = 0;
  for (const c of input.connections) {
    const from = endpoint(c.fromRefs, c.fromLabel);
    const to = endpoint(c.toRefs, c.toLabel);
    if (!from || !to) { missingEnds++; continue; }
    conns.push({ rec: c, from, to });
  }
  if (missingEnds) problems.push(`${missingEnds} connection${missingEnds === 1 ? " has" : "s have"} an empty From or To and ${missingEnds === 1 ? "was" : "were"} left out`);
  if (autoCreated) problems.push(`${autoCreated} element${autoCreated === 1 ? " was" : "s were"} created from connection endpoints that are not in the elements table`);

  const elements = [...byKey.values()];
  if (elements.length > LIMITS.elements) problems.push(`${elements.length} elements is more than a map holds (${LIMITS.elements.toLocaleString("en")})`);
  if (conns.length > LIMITS.connections) problems.push(`${conns.length} connections is more than a map holds (${LIMITS.connections.toLocaleString("en")})`);

  // Types, once per name (case- and space-insensitive) per kind.
  /** @type {any[]} */
  const typeItems = [];
  /** @type {string[]} */
  const typeNames = [];
  const seenTypes = new Set();
  /** @param {string|undefined} name @param {"element"|"connection"} appliesTo */
  const addType = (name, appliesTo) => {
    if (!name) return;
    const k = appliesTo + "\0" + normalizeLabel(name);
    if (seenTypes.has(k)) return;
    seenTypes.add(k);
    typeItems.push({ kind: "type", name, appliesTo });
    if (!typeNames.includes(name)) typeNames.push(name);
  };
  for (const e of elements) addType(e.type, "element");
  for (const { rec } of conns) addType(rec.type, "connection");
  if (typeItems.length > LIMITS.types) problems.push(`${typeItems.length} types is more than a map holds (${LIMITS.types})`);

  // Fields: one per name across both tables.
  /** @type {Map<string, {name: string, element: boolean, connection: boolean, values: string[]}>} */
  const fieldCols = new Map();
  /** @param {Map<string, string>} raw @param {"element"|"connection"} kind */
  const collect = (raw, kind) => {
    for (const [name, v] of raw) {
      const k = normalizeLabel(name);
      let col = fieldCols.get(k);
      if (!col) fieldCols.set(k, (col = { name, element: false, connection: false, values: [] }));
      col[kind] = true;
      col.values.push(v);
    }
  };
  for (const e of elements) collect(e.raw, "element");
  for (const { rec } of conns) collect(rec.raw, "connection");
  /** @type {Map<string, {name: string, kind: InferredKind, appliesTo: "element"|"connection"|"both"}>} */
  const fieldDefs = new Map();
  /** @type {any[]} */
  const fieldItems = [];
  /** @type {ImportPreview["fields"]} */
  const fieldPreview = [];
  for (const [k, col] of fieldCols) {
    if (fieldDefs.size >= LIMITS.fields) { problems.push(`Only the first ${LIMITS.fields} custom fields were kept`); break; }
    const kind = inferFieldKind(col.values);
    const appliesTo = col.element && col.connection ? "both" : col.element ? "element" : "connection";
    fieldDefs.set(k, { name: col.name, kind, appliesTo });
    /** @type {Record<string, any>} */
    const item = { kind: "field", name: col.name, fieldKind: kind, appliesTo };
    if (kind === "choice" || kind === "multichoice") {
      const choices = new Set();
      for (const v of col.values) {
        if (!v.trim()) continue;
        const parts = kind === "multichoice" ? splitList(v) : [v.trim()];
        for (const p of parts) {
          const c = cleanLine(p, LIMITS.choice);
          if (c) choices.add(c);
        }
        if (choices.size >= LIMITS.choices) break;
      }
      item.choices = [...choices];
    }
    fieldItems.push(item);
    /** @type {string[]} */
    const sample = [];
    for (const v of col.values) {
      const t = v.trim();
      if (t && !sample.includes(t)) sample.push(cleanLine(t, 80));
      if (sample.length >= SAMPLES) break;
    }
    fieldPreview.push({ name: col.name, kind, appliesTo, sample });
  }
  /** @type {Map<string, number>} */
  const badValues = new Map();
  /** @param {Map<string, string>} raw */
  const fieldValues = (raw) => {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [name, v] of raw) {
      if (!v.trim()) continue;
      const def = fieldDefs.get(normalizeLabel(name));
      if (!def) continue;
      const value = convertValue(def.kind, v);
      if (value === undefined) { badValues.set(def.name, (badValues.get(def.name) ?? 0) + 1); continue; }
      out[def.name] = value;
    }
    return out;
  };

  const elementItems = elements.map((e) => {
    /** @type {Record<string, any>} */
    const item = { kind: "element", key: e.key, label: e.label };
    if (e.type) item.type = e.type;
    if (e.description) item.description = e.description;
    if (e.tags?.length) item.tags = e.tags;
    item.fields = fieldValues(e.raw);
    return item;
  });

  /** @type {Set<string>} */
  const connKeys = new Set();
  const connectionItems = conns.map(({ rec, from, to }) => {
    /** @type {Record<string, any>} */
    const item = { kind: "connection" };
    const base = rec.key || `${from} -> ${to}${rec.type ? " : " + rec.type : ""}${rec.label ? " : " + rec.label : ""}`.slice(0, LIMITS.externalKey);
    let key = base;
    for (let n = 2; connKeys.has(key); n++) key = `${base.slice(0, LIMITS.externalKey - 8)} #${n}`;
    connKeys.add(key);
    item.key = key;
    item.from = from;
    item.to = to;
    if (rec.type) item.type = rec.type;
    if (rec.direction) item.direction = rec.direction;
    if (rec.label) item.label = rec.label;
    if (rec.polarity) item.polarity = rec.polarity;
    if (rec.strength !== undefined) item.strength = rec.strength;
    if (rec.description) item.description = rec.description;
    if (rec.tags?.length) item.tags = rec.tags;
    item.fields = fieldValues(rec.raw);
    return item;
  });
  for (const [name, count] of badValues) {
    const def = fieldDefs.get(normalizeLabel(name));
    problems.push(`${count} value${count === 1 ? "" : "s"} in field "${name}" ${count === 1 ? "is" : "are"} not ${def?.kind === "number" ? "a number" : "valid " + def?.kind} and ${count === 1 ? "was" : "were"} left out`);
  }

  /** @type {ImportPreview} */
  const preview = {
    elements: elementItems.length, connections: connectionItems.length, types: typeNames, fields: fieldPreview,
    duplicateKeys, duplicateLabels, unresolved, autoCreated, skipped, problems: problems.slice(0, LIST_CAP),
  };
  if (input.delimiter) preview.delimiter = input.delimiter;
  if (input.headers) preview.headers = input.headers;
  return {
    format: input.format, sourceName: input.sourceName, source: input.source,
    items: [...typeItems, ...fieldItems, ...elementItems, ...connectionItems], preview,
  };
}

// ---------------------------------------------------------------------------------------------
// Tables (Kumu sheets and edge lists)
// ---------------------------------------------------------------------------------------------

const FORMULA_START = new Set(["=", "+", "-", "@", "\t", "\r"]);

/** Removes the quote a spreadsheet-safe export put in front of a formula-like cell. @param {string} s */
const unescapeCell = (s) => (s.length > 1 && s[0] === "'" && FORMULA_START.has(s[1]) ? s.slice(1) : s);

/** @param {string} h */
const headerKey = (h) => cleanLine(h, 200).toLowerCase().replace(/\s+/g, " ");

/**
 * Maps header positions to roles; everything else becomes a custom field column.
 * @param {string[]} headers @param {Record<string, string>} roles header key -> role
 * @param {string[]} problems @param {string} table
 */
function columnsOf(headers, roles, problems, table) {
  /** @type {Record<string, number>} */
  const role = {};
  /** @type {{index: number, name: string}[]} */
  const custom = [];
  const seen = new Set();
  headers.forEach((h, index) => {
    const k = headerKey(h);
    if (!k) { if (headers.slice(index).some((x) => x.trim())) problems.push(`${table}: column ${index + 1} has no header and was left out`); return; }
    const r = roles[k];
    if (r) {
      if (role[r] === undefined) role[r] = index;
      return;
    }
    const name = cleanLine(h, LIMITS.fieldName);
    const nk = normalizeLabel(name);
    if (seen.has(nk)) { problems.push(`${table}: a second column named "${name}" was left out`); return; }
    seen.add(nk);
    custom.push({ index, name });
  });
  return { role, custom };
}

const ELEMENT_ROLES = Object.freeze(/** @type {Record<string, string>} */ ({
  id: "id", label: "label", type: "type", "element type": "type", description: "description", tags: "tags",
}));
const CONNECTION_ROLES = Object.freeze(/** @type {Record<string, string>} */ ({
  id: "id", from: "from", to: "to", fromid: "fromId", toid: "toId", type: "type", "connection type": "type",
  direction: "direction", label: "label", strength: "strength", description: "description", tags: "tags",
  polarity: "polarity", sign: "polarity",
}));

/** @param {string} v @param {string[]} problems @param {{warned?: boolean}} state */
function directionOf(v, problems, state) {
  const s = v.trim().toLowerCase();
  if (!s) return undefined;
  if (/** @type {readonly string[]} */ (DIRECTIONS).includes(s)) return s;
  if (!state.warned) { state.warned = true; problems.push(`Direction "${cleanLine(v, 40)}" is not directed, undirected or mutual; such connections are directed`); }
  return undefined;
}

/** @param {unknown} v @param {string[]} problems @param {{warned?: boolean}} state */
function strengthOf(v, problems, state) {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return undefined;
  if (isNumeric(s)) return Number(s);
  if (!state.warned) { state.warned = true; problems.push(`Strength "${cleanLine(s, 40)}" is not a number and was left out`); }
  return undefined;
}

/**
 * @param {string[]} headers @param {string[][]} rows @param {string[]} problems
 * @returns {{records: ElementRecord[], hasIds: boolean}}
 */
function elementRecordsFromTable(headers, rows, problems) {
  const { role, custom } = columnsOf(headers, ELEMENT_ROLES, problems, "Elements");
  if (role.label === undefined) {
    if (rows.length) problems.push('Elements: no "Label" column, so no elements were read from this table');
    return { records: [], hasIds: false };
  }
  const hasIds = role.id !== undefined;
  /** @param {string[]} row @param {number|undefined} i */
  const cell = (row, i) => (i === undefined ? "" : unescapeCell(row[i] ?? ""));
  /** @type {ElementRecord[]} */
  const records = [];
  let noLabel = 0;
  for (const row of rows) {
    const label = cleanLine(cell(row, role.label), LIMITS.label);
    if (!label) { noLabel++; continue; }
    const key = (hasIds ? cleanLine(cell(row, role.id), LIMITS.externalKey) : "") || cleanLine(label, LIMITS.externalKey);
    /** @type {Map<string, string>} */
    const raw = new Map();
    for (const c of custom) {
      const v = cell(row, c.index);
      if (v.trim()) raw.set(c.name, v);
    }
    records.push({
      key, label, raw,
      type: cleanLine(cell(row, role.type), LIMITS.typeName) || undefined,
      description: cleanText(cell(row, role.description), LIMITS.description).trim() || undefined,
      tags: tagList(cell(row, role.tags)),
    });
  }
  if (noLabel) problems.push(`Elements: ${noLabel} row${noLabel === 1 ? " has" : "s have"} no label and ${noLabel === 1 ? "was" : "were"} left out`);
  return { records, hasIds };
}

/**
 * @param {string[]} headers @param {string[][]} rows @param {string[]} problems @param {string} table
 * @returns {ConnectionRecord[]}
 */
function connectionRecordsFromTable(headers, rows, problems, table) {
  const { role, custom } = columnsOf(headers, CONNECTION_ROLES, problems, table);
  const hasFrom = role.from !== undefined || role.fromId !== undefined;
  const hasTo = role.to !== undefined || role.toId !== undefined;
  if (!hasFrom || !hasTo) {
    if (rows.length) problems.push(`${table}: needs "From" and "To" columns, so no connections were read from this table`);
    return [];
  }
  /** @param {string[]} row @param {number|undefined} i */
  const cell = (row, i) => (i === undefined ? "" : unescapeCell(row[i] ?? ""));
  const dirState = {}, strengthState = {};
  return rows.map((row) => {
    const fromLabel = cell(row, role.from).trim(), toLabel = cell(row, role.to).trim();
    const fromId = cell(row, role.fromId).trim(), toId = cell(row, role.toId).trim();
    /** @type {Map<string, string>} */
    const raw = new Map();
    for (const c of custom) {
      const v = cell(row, c.index);
      if (v.trim()) raw.set(c.name, v);
    }
    /** @type {ConnectionRecord} */
    const rec = {
      key: cleanLine(cell(row, role.id), LIMITS.externalKey) || undefined,
      fromRefs: [fromId, fromLabel].map((r) => cleanLine(r, LIMITS.externalKey)).filter(Boolean),
      toRefs: [toId, toLabel].map((r) => cleanLine(r, LIMITS.externalKey)).filter(Boolean),
      fromLabel: fromLabel || fromId, toLabel: toLabel || toId,
      type: cleanLine(cell(row, role.type), LIMITS.typeName) || undefined,
      direction: directionOf(cell(row, role.direction), problems, dirState),
      label: cleanLine(cell(row, role.label), LIMITS.label) || undefined,
      polarity: polarityOf(cell(row, role.polarity)),
      strength: strengthOf(cell(row, role.strength), problems, strengthState),
      description: cleanText(cell(row, role.description), LIMITS.description).trim() || undefined,
      tags: tagList(cell(row, role.tags)),
      raw,
    };
    return rec;
  });
}

/**
 * Kumu's spreadsheet layout, each table pasted or uploaded as CSV/TSV text.
 * @param {{elements?: string, connections?: string, sourceName?: string}} input
 * @returns {ImportPlan}
 */
export function parseKumuSheets(input) {
  const a = isObject(input) ? input : {};
  const sourceName = cleanLine(a.sourceName, 120) || "Kumu spreadsheet";
  /** @type {string[]} */
  const problems = [];
  /** @type {{elements?: string[], connections?: string[]}} */
  const headers = {};
  /** @type {"," | "\t" | ";" | undefined} */
  let delimiter;
  let elements = /** @type {ElementRecord[]} */ ([]), hasIds = false;
  /** @type {ConnectionRecord[]} */
  let connections = [];
  if (typeof a.elements === "string" && a.elements.trim()) {
    const t = parseDelimited(a.elements);
    delimiter = t.delimiter;
    headers.elements = t.headers;
    for (const p of t.problems) problems.push("Elements: " + p);
    ({ records: elements, hasIds } = elementRecordsFromTable(t.headers, t.rows, problems));
  }
  if (typeof a.connections === "string" && a.connections.trim()) {
    const t = parseDelimited(a.connections);
    delimiter ??= t.delimiter;
    headers.connections = t.headers;
    for (const p of t.problems) problems.push("Connections: " + p);
    connections = connectionRecordsFromTable(t.headers, t.rows, problems, "Connections");
  }
  if (!headers.elements && !headers.connections) problems.push("Nothing to import: paste an Elements table, a Connections table or both");
  return buildPlan({
    format: "kumu-sheets", sourceName, source: "kumu:" + sourceSlug(sourceName), elements, connections, hasIds,
    problems, skipped: [], delimiter, headers,
  });
}

const EDGE_HEADERS = new Set(["from", "to", "source", "target", "type", "connection type", "label", "weight", "strength", "direction", "polarity", "sign", "description", "tags", "id"]);

/**
 * A CSV/TSV edge list: From/To (or Source/Target) columns when the header names them, otherwise
 * the first two columns. Type, Label and Weight (strength) are read, as are the other Kumu
 * connection columns; further named columns become connection fields. Without a recognisable
 * header row the first row is data. Elements are created from the distinct endpoint labels.
 * @param {string} text @param {{sourceName?: string}} [options]
 * @returns {ImportPlan}
 */
export function parseEdgeList(text, options = {}) {
  const sourceName = cleanLine(options?.sourceName, 120) || "Edge list";
  const t = parseDelimited(text);
  const problems = [...t.problems];
  let headers = t.headers;
  let rows = t.rows;
  const keys = headers.map(headerKey);
  const named = (keys.includes("from") && keys.includes("to")) || (keys.includes("source") && keys.includes("target"));
  const width = Math.max(headers.length, ...rows.slice(0, 100).map((r) => r.length));
  if (width < 2) {
    if (headers.length) problems.push("An edge list needs at least two columns: from and to");
    else problems.push("Nothing to import");
    return buildPlan({ format: "edge-list", sourceName, source: "edges:" + sourceSlug(sourceName), elements: [], connections: [], hasIds: false, problems, skipped: [], delimiter: t.delimiter, headers: { connections: headers } });
  }
  if (named) {
    headers = headers.map((h, i) => {
      const k = keys[i];
      return k === "source" ? "From" : k === "target" ? "To" : k === "weight" ? "Strength" : h;
    });
  } else if (keys.some((k) => EDGE_HEADERS.has(k))) {
    headers = headers.map((h, i) => (i === 0 ? "From" : i === 1 ? "To" : keys[i] === "weight" ? "Strength" : h));
  } else {
    rows = [t.headers, ...rows];
    headers = Array.from({ length: width }, (_, i) => (i === 0 ? "From" : i === 1 ? "To" : `Column ${i + 1}`));
    problems.push("No header row found: the first two columns are read as From and To");
  }
  const connections = connectionRecordsFromTable(headers, rows, problems, "Edge list");
  return buildPlan({
    format: "edge-list", sourceName, source: "edges:" + sourceSlug(sourceName), elements: [], connections, hasIds: false,
    problems, skipped: [], delimiter: t.delimiter, headers: { connections: t.headers },
  });
}

// ---------------------------------------------------------------------------------------------
// Kumu JSON
// ---------------------------------------------------------------------------------------------

/**
 * One JSON attribute value as cell text, or null when it cannot become a field value.
 * @param {unknown} v @returns {string|null}
 */
function jsonCell(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.map((x) => x.replaceAll("|", "/")).join("|");
  return null;
}

/**
 * Kumu JSON: a project export ({elements: [{_id, attributes}], connections: [{_id, from, to,
 * direction, attributes}], loops, maps}) where from/to are element _ids, or blueprint JSON
 * ({elements: [{label, type, ...}], connections: [{from, to, type, direction, ...}]}) where
 * from/to are labels. The shape is detected from the elements and connections. Loops and
 * maps/perspectives are counted and reported as skipped in Phase 1.
 * @param {string} text @param {{sourceName?: string}} [options]
 * @returns {ImportPlan}
 */
export function parseKumuJson(text, options = {}) {
  const sourceName = cleanLine(options?.sourceName, 120) || "Kumu JSON";
  const source = "kumu:" + sourceSlug(sourceName);
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const skipped = [];
  const empty = () => buildPlan({ format: "kumu-json", sourceName, source, elements: [], connections: [], hasIds: false, problems, skipped });
  let data;
  try {
    let s = typeof text === "string" ? text : "";
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    data = JSON.parse(s);
  } catch {
    problems.push("This is not valid JSON");
    return empty();
  }
  if (!isObject(data)) { problems.push("Kumu JSON must be an object with elements and connections"); return empty(); }
  const rawElements = Array.isArray(data.elements) ? data.elements : [];
  const rawConnections = Array.isArray(data.connections) ? data.connections : [];
  if (!rawElements.length && !rawConnections.length) problems.push("No elements or connections found");
  if (rawElements.length > MAX_ROWS) problems.push(`Only the first ${MAX_ROWS.toLocaleString("en")} elements were read`);
  if (rawConnections.length > MAX_ROWS) problems.push(`Only the first ${MAX_ROWS.toLocaleString("en")} connections were read`);
  const elementsIn = rawElements.slice(0, MAX_ROWS).filter(isObject);
  const connectionsIn = rawConnections.slice(0, MAX_ROWS).filter(isObject);
  const project = [...elementsIn.slice(0, 50), ...connectionsIn.slice(0, 50)].some((o) => isObject(o.attributes) || typeof o._id === "string");

  const loops = Array.isArray(data.loops) ? data.loops.length : 0;
  const perspectives = (Array.isArray(data.maps) ? data.maps.length : 0) + (Array.isArray(data.perspectives) ? data.perspectives.length : 0);
  if (loops || perspectives) skipped.push(`skipped: ${loops} loop${loops === 1 ? "" : "s"}, ${perspectives} perspective${perspectives === 1 ? "" : "s"} (not supported yet)`);

  /** @type {Map<string, number>} */
  const unsupported = new Map();
  let images = 0;
  /**
   * Splits attributes into known roles and custom field cells.
   * @param {Record<string, any>} attrs @param {Record<string, string>} roles lowercased key -> role
   */
  const split = (attrs, roles) => {
    /** @type {Record<string, any>} */
    const known = {};
    /** @type {Map<string, string>} */
    const raw = new Map();
    for (const [k, v] of Object.entries(attrs)) {
      const lk = headerKey(k);
      const r = roles[lk];
      if (r === "skip") continue;
      if (r === "image") { if (v !== null && v !== "") images++; continue; }
      if (r) { if (known[r] === undefined) known[r] = v; continue; }
      if (v === null || v === undefined || v === "") continue;
      const name = cleanLine(k, LIMITS.fieldName);
      if (!name) continue;
      const cell = jsonCell(v);
      if (cell === null) { unsupported.set(name, (unsupported.get(name) ?? 0) + 1); continue; }
      if (cell.trim()) raw.set(name, cell);
    }
    return { known, raw };
  };
  /** @param {unknown} v */
  const str = (v) => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");

  /** @type {Record<string, string>} */
  const elementRoles = project
    ? { label: "label", "element type": "type", type: "type", description: "description", tags: "tags", image: "image" }
    : { id: "id", _id: "id", label: "label", "element type": "type", type: "type", description: "description", tags: "tags", image: "image" };
  /** @type {ElementRecord[]} */
  const elements = [];
  let noLabel = 0;
  for (const o of elementsIn) {
    const attrs = project ? (isObject(o.attributes) ? o.attributes : {}) : o;
    const { known, raw } = split(attrs, elementRoles);
    const id = project ? str(o._id) : str(known.id);
    const label = cleanLine(str(known.label), LIMITS.label) || (project ? cleanLine(id, LIMITS.label) : "");
    if (!label) { noLabel++; continue; }
    elements.push({
      key: cleanLine(id, LIMITS.externalKey) || cleanLine(label, LIMITS.externalKey), label, raw,
      type: cleanLine(str(known.type), LIMITS.typeName) || undefined,
      description: cleanText(str(known.description), LIMITS.description).trim() || undefined,
      tags: tagList(known.tags),
    });
  }
  if (noLabel) problems.push(`${noLabel} element${noLabel === 1 ? " has" : "s have"} no label and ${noLabel === 1 ? "was" : "were"} left out`);

  const connectionRoles = {
    _id: "skip", id: "id", from: "from", to: "to", direction: "direction", "connection type": "type", type: "type",
    label: "label", description: "description", tags: "tags", strength: "strength", polarity: "polarity", sign: "polarity", image: "image",
  };
  const dirState = {}, strengthState = {};
  /** @type {ConnectionRecord[]} */
  const connections = [];
  for (const o of connectionsIn) {
    const attrs = project ? (isObject(o.attributes) ? o.attributes : {}) : o;
    const { known, raw } = split(attrs, connectionRoles);
    const from = cleanLine(str(project ? o.from : known.from), LIMITS.externalKey);
    const to = cleanLine(str(project ? o.to : known.to), LIMITS.externalKey);
    const direction = project ? (o.direction ?? known.direction) : known.direction;
    connections.push({
      key: cleanLine(project ? str(o._id) : str(known.id), LIMITS.externalKey) || undefined,
      fromRefs: from ? [from] : [], toRefs: to ? [to] : [], fromLabel: from, toLabel: to,
      type: cleanLine(str(known.type), LIMITS.typeName) || undefined,
      direction: typeof direction === "string" ? directionOf(direction, problems, dirState) : undefined,
      label: cleanLine(str(known.label), LIMITS.label) || undefined,
      polarity: polarityOf(known.polarity),
      strength: strengthOf(known.strength, problems, strengthState),
      description: cleanText(str(known.description), LIMITS.description).trim() || undefined,
      tags: tagList(known.tags),
      raw,
    });
  }
  if (images) skipped.push(`skipped: ${images} image${images === 1 ? "" : "s"} (images are not imported)`);
  for (const [name, count] of unsupported) {
    if (problems.length >= LIST_CAP) break;
    problems.push(`${count} value${count === 1 ? "" : "s"} of "${name}" ${count === 1 ? "is an object or list" : "are objects or lists"} and ${count === 1 ? "was" : "were"} left out`);
  }
  return buildPlan({ format: "kumu-json", sourceName, source, elements, connections, hasIds: project || elements.some((e) => e.key !== cleanLine(e.label, LIMITS.externalKey)), problems, skipped });
}
