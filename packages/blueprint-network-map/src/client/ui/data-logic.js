// @ts-check
// Pure helpers for the Data and Activity panels (./data.js, ./activity.js): format detection,
// plan and changeset summaries, review decisions, undo messages and the stored-map shape the
// exporters (src/shared/exports.js) read. DOM-free, so they are unit-tested in
// test/client/data-logic.test.js.

import { parseEdgeList, parseKumuJson, parseKumuSheets, parseDelimited } from "../../shared/imports.js";

/** @typedef {"kumu-sheets"|"edge-list"|"kumu-json"} ImportFormat */

export const FORMATS = Object.freeze(/** @type {{id: ImportFormat, label: string}[]} */ ([
  { id: "kumu-sheets", label: "Kumu spreadsheet (Elements + Connections)" },
  { id: "edge-list", label: "Edge list (CSV)" },
  { id: "kumu-json", label: "Kumu JSON" },
]));

/** Items per addChangesetItems call (the server's LIMITS.opsPerRequest). */
export const STAGE_CHUNK = 2000;
/** Review items per getChangeset page. */
export const REVIEW_PAGE = 200;

// ---------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------

/** @param {string} text */
const firstLine = (text) => {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const nl = s.search(/\r|\n/);
  return nl === -1 ? s : s.slice(0, nl);
};

/**
 * Which table a pasted or loaded sheet holds, from its header row.
 * @param {unknown} text
 * @returns {"elements"|"connections"|null}
 */
export function sheetKind(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const { headers } = parseDelimited(firstLine(text));
  const keys = new Set(headers.map((h) => h.trim().toLowerCase()));
  if ((keys.has("from") || keys.has("fromid")) && (keys.has("to") || keys.has("toid"))) return "connections";
  if (keys.has("source") && keys.has("target")) return "connections";
  if (keys.has("label")) return "elements";
  return null;
}

/**
 * The import format a file most likely holds, from its name and then its content.
 * @param {string} [fileName] @param {string} [text]
 * @returns {ImportFormat|null}
 */
export function detectFormat(fileName = "", text = "") {
  const name = String(fileName).toLowerCase();
  if (name.endsWith(".json")) return "kumu-json";
  const t = typeof text === "string" ? text.trimStart() : "";
  if (t.startsWith("{") || t.startsWith("[")) return "kumu-json";
  const kind = sheetKind(t);
  if (kind === "elements") return "kumu-sheets";
  if (kind === "connections") return /edge/.test(name) ? "edge-list" : "kumu-sheets";
  if (name.endsWith(".csv") || name.endsWith(".tsv") || name.endsWith(".txt")) return t ? "edge-list" : null;
  return null;
}

/**
 * A source name from a file name: no extension, no "Elements"/"Connections"/"Edges" suffix
 * (Kumu exports one file per sheet, and both should share the import's identity).
 * @param {string} fileName
 */
export function sourceNameFromFile(fileName) {
  let s = String(fileName ?? "").replace(/^.*[\\/]/, "");
  s = s.replace(/\.(csv|tsv|txt|json)$/i, "");
  s = s.replace(/[\s._-]*[-–(]?\s*(elements|connections|edges|edge list)\)?$/i, "");
  return s.replace(/[_]+/g, " ").trim().slice(0, 120);
}

/**
 * Parses the inputs for `format` into an ImportPlan (src/shared/imports.js).
 * @param {{format: ImportFormat, elements?: string, connections?: string, edges?: string, json?: string, sourceName?: string}} input
 */
export function planFor(input) {
  const sourceName = (input.sourceName ?? "").trim() || undefined;
  if (input.format === "edge-list") return parseEdgeList(input.edges ?? "", { sourceName });
  if (input.format === "kumu-json") return parseKumuJson(input.json ?? "", { sourceName });
  return parseKumuSheets({ elements: input.elements ?? "", connections: input.connections ?? "", sourceName });
}

/** @param {string|undefined} d */
export function delimiterName(d) {
  return d === "\t" ? "Tab (pasted from a spreadsheet)" : d === ";" ? "Semicolon" : d === "," ? "Comma" : "—";
}

/**
 * Whether text decoded from a file lost characters (U+FFFD replaces bytes that are not UTF-8).
 * @param {string} text
 */
export function hasDecodingErrors(text) {
  return typeof text === "string" && text.includes("�");
}

/** @param {number} n @param {string} one @param {string} [many] */
export const plural = (n, one, many = one + "s") => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

/**
 * One line for a plan preview: "3 elements · 2 connections · 2 types · 3 fields".
 * @param {import("../../shared/imports.js").ImportPreview} preview
 */
export function planSummary(preview) {
  const parts = [plural(preview.elements, "element"), plural(preview.connections, "connection")];
  if (preview.types.length) parts.push(plural(preview.types.length, "type"));
  if (preview.fields.length) parts.push(plural(preview.fields.length, "field"));
  return parts.join(" · ");
}

/**
 * Items of each kind in a plan (or in any list of changeset items).
 * @param {any[]} items
 */
export function kindTotals(items) {
  const out = { type: 0, field: 0, element: 0, connection: 0 };
  for (const it of items ?? []) {
    const k = it?.kind ?? it?.data?.kind;
    if (k in out) out[/** @type {keyof typeof out} */ (k)]++;
  }
  return out;
}

/**
 * Splits items into calls of at most `size`.
 * @template T @param {T[]} items @param {number} [size]
 * @returns {T[][]}
 */
export function chunk(items, size = STAGE_CHUNK) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------------------------

export const ACTION_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({
  create: "Create new", update: "Update", "use-existing": "Use existing", skip: "Skip", invalid: "Invalid", blocked: "Blocked",
}));

/**
 * The manifest's counts as rows for the summary, in a fixed order, zeros left out.
 * @param {Record<string, number>|undefined} counts
 * @returns {{key: string, label: string, n: number}[]}
 */
export function countRows(counts) {
  const c = counts ?? {};
  return ["create", "update", "use-existing", "skip", "invalid", "blocked"]
    .map((key) => ({ key, label: ACTION_LABELS[key], n: c[key] ?? 0 }))
    .filter((r) => r.n > 0);
}

/**
 * What an item will do, as the review shows it: "invalid" and "blocked" win over the action.
 * @param {any} item
 */
export function effectiveAction(item) {
  if (item?.invalid) return "invalid";
  if (item?.blocked) return "blocked";
  return item?.action ?? "create";
}

/**
 * The choices a reviewer has for an item, as {value, label}. Values: "create", "skip",
 * "use-existing:<id>", "update:<id>". Types and fields only offer create/skip when they would be
 * created (an existing one is simply used); connections offer create or update, and skip.
 * @param {any} item a getChangeset item (candidates as {id, label}, target as {id, label}|null)
 * @returns {{value: string, label: string}[]}
 */
export function decisionOptions(item) {
  const kind = item?.data?.kind;
  /** @type {{value: string, label: string}[]} */
  const out = [];
  if (kind === "element") {
    out.push({ value: "create", label: "Create new" });
    const seen = new Set();
    for (const c of item.candidates ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ value: `use-existing:${c.id}`, label: `Use existing: ${c.label}` });
    }
    if (item.action === "use-existing" && item.targetId && !seen.has(item.targetId)) {
      out.push({ value: `use-existing:${item.targetId}`, label: `Use existing: ${item.target?.label ?? item.targetId}` });
    }
    if (item.action === "update" && item.targetId) out.push({ value: `update:${item.targetId}`, label: `Update: ${item.target?.label ?? "the element it created before"}` });
    out.push({ value: "skip", label: "Skip" });
    return out;
  }
  if (kind === "connection") {
    out.push(item.action === "update" ? { value: "update", label: "Update" } : { value: "create", label: "Create new" });
    out.push({ value: "skip", label: "Skip" });
    return out;
  }
  if (item?.action === "use-existing") return [{ value: "use-existing", label: "Use existing" }];
  return [{ value: "create", label: "Create new" }, { value: "skip", label: "Skip" }];
}

/** The option value matching an item's current action. @param {any} item */
export function currentDecision(item) {
  const kind = item?.data?.kind;
  if (item?.action === "skip") return "skip";
  if (kind === "element" && (item.action === "use-existing" || item.action === "update")) return `${item.action}:${item.targetId}`;
  return item?.action ?? "create";
}

/**
 * The setDecisions entry for choosing `value` for an item.
 * @param {any} item @param {string} value
 * @returns {{iid: string, action: string, targetId?: string}}
 */
export function decisionFor(item, value) {
  const [action, targetId] = value.split(":");
  if (action === "update" && item?.data?.kind === "connection") return { iid: item.iid, action: "create" };
  return targetId ? { iid: item.iid, action, targetId } : { iid: item.iid, action };
}

/**
 * Bulk decisions over a list of items (typically every "problems" page):
 *   "use-existing-single"   element items that matched exactly one existing element by label but
 *                           are set to create -> use that element
 *   "create-label-matches"  element items set to use an existing element found by label -> create
 *   "skip-invalid"          invalid items not already skipped -> skip
 * Items updated through their source reference are never label matches and are left alone.
 * @param {any[]} items @param {"use-existing-single"|"create-label-matches"|"skip-invalid"} mode
 * @returns {{iid: string, action: string, targetId?: string}[]}
 */
export function bulkDecisions(items, mode) {
  const out = [];
  for (const it of items ?? []) {
    const d = it?.data;
    if (!d) continue;
    if (mode === "skip-invalid") {
      if (it.invalid && it.action !== "skip") out.push({ iid: it.iid, action: "skip" });
      continue;
    }
    if (d.kind !== "element" || it.invalid) continue;
    const candidates = it.candidates ?? [];
    if (mode === "use-existing-single" && it.action === "create" && candidates.length === 1) {
      out.push({ iid: it.iid, action: "use-existing", targetId: candidates[0].id ?? candidates[0] });
    } else if (mode === "create-label-matches" && it.action === "use-existing" && candidates.length) {
      out.push({ iid: it.iid, action: "create" });
    }
  }
  return out;
}

/**
 * How many elements and connections accepting will write (create, update or link). Totals are the
 * staged items per kind; `skipped` counts the reviewer's own skip decisions per kind; `invalid`
 * counts invalid items per kind; `blocked` (connections only) is the manifest's count.
 * @param {{element: number, connection: number}} totals
 * @param {{skipped?: {element?: number, connection?: number}, invalid?: {element?: number, connection?: number}, blocked?: number}} [minus]
 */
export function acceptCounts(totals, minus = {}) {
  const s = minus.skipped ?? {}, inv = minus.invalid ?? {};
  return {
    elements: Math.max(0, (totals.element ?? 0) - (s.element ?? 0) - (inv.element ?? 0)),
    connections: Math.max(0, (totals.connection ?? 0) - (s.connection ?? 0) - (inv.connection ?? 0) - (minus.blocked ?? 0)),
  };
}

/**
 * Exactly how many elements and connections accepting will write, from every item of a changeset.
 * @param {any[]} items getChangeset items
 */
export function countWritable(items) {
  const out = { elements: 0, connections: 0 };
  for (const it of items ?? []) {
    const a = effectiveAction(it);
    if (a === "skip" || a === "invalid" || a === "blocked") continue;
    if (it.data?.kind === "element") out.elements++;
    else if (it.data?.kind === "connection") out.connections++;
  }
  return out;
}

/** The accept button's label. @param {{elements: number, connections: number}} c */
export function acceptLabel(c) {
  if (!c.elements && !c.connections) return "Import (nothing to add)";
  if (!c.connections) return `Import ${plural(c.elements, "element")}`;
  if (!c.elements) return `Import ${plural(c.connections, "connection")}`;
  return `Import ${plural(c.elements, "element")} and ${plural(c.connections, "connection")}`;
}

/**
 * Apply progress from a manifest: items settled (applied, or skipped as invalid/blocked/skip)
 * are not known until the end, so `done` counts applied items against every item.
 * @param {any} m
 */
export function progressOf(m) {
  const total = Math.max(0, m?.items ?? 0);
  const done = Math.min(total, Math.max(0, m?.applied ?? 0));
  return { done, total, fraction: total ? done / total : 0, text: `${done.toLocaleString("en")} of ${plural(total, "item")} applied` };
}

/** @param {string} status */
export function statusLabel(status) {
  return ({
    staging: "Staging", review: "In review", applying: "Applying", applied: "Imported", partial: "Partly imported",
    failed: "Failed", rejected: "Discarded",
  })[status] ?? status;
}

/**
 * Counts of a finished or reviewed changeset as a short line.
 * @param {any} m
 */
export function manifestSummary(m) {
  const c = m?.counts ?? {};
  if (m?.status === "applied" || m?.status === "partial") {
    const parts = [`${(m.applied ?? 0).toLocaleString("en")} applied`];
    if (c.failed) parts.push(`${c.failed.toLocaleString("en")} failed`);
    if (c.skip) parts.push(`${c.skip.toLocaleString("en")} skipped`);
    return parts.join(" · ");
  }
  const rows = countRows(c);
  return rows.length ? rows.map((r) => `${r.n.toLocaleString("en")} ${r.label.toLowerCase()}`).join(" · ") : plural(m?.items ?? 0, "item");
}

/**
 * Whether an import was undone, from the history seen so far: every entry of its group undone
 * -> "undone"; some -> "partly"; none -> "no"; no entries known -> "unknown".
 * @param {string} groupId @param {any[]} history
 */
export function groupUndoState(groupId, history) {
  const entries = (history ?? []).filter((h) => h.groupId === groupId && !h.undoOf);
  if (!entries.length) return "unknown";
  const undone = entries.filter((h) => h.undoneBy).length;
  return undone === entries.length ? "undone" : undone ? "partly" : "no";
}

/**
 * Element ids an import created or linked: created with its provenance, or carrying its source's
 * external reference (updated or matched).
 * @param {Iterable<any>} objects @param {{id: string, source?: string}} m
 */
export function importedElementIds(objects, m) {
  const out = [];
  for (const o of objects) {
    if (o?.id?.[0] !== "e") continue;
    if (o.provenance?.changesetId === m.id || (m.source && (o.externalRefs ?? []).some((/** @type {any} */ r) => r.sourceId === m.source))) out.push(o.id);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Undo messages
// ---------------------------------------------------------------------------------------------

/** Object conflicts (position conflicts are not items a person would recognise). @param {any[]} list */
const objectConflicts = (list) => new Set((list ?? []).filter((c) => c && !c.layout && c.id).map((c) => c.id)).size;

/**
 * A message for an undo result: store.undo's (an operation result) or undoGroup's
 * ({parts, conflicts, errors}). `ok` is false when nothing was undone.
 * @param {any} result
 * @returns {{ok: boolean, message: string}}
 */
export function undoMessage(result) {
  if (!result) return { ok: false, message: "Undo failed." };
  const errors = (result.errors ?? []).filter((/** @type {any} */ e) => e);
  const kept = objectConflicts(result.conflicts);
  if ("parts" in result) {
    if (!result.parts) return { ok: false, message: errors[0]?.message ?? "Nothing left to undo for this import." };
    if (kept) return { ok: true, message: `Import undone. ${plural(kept, "item was", "items were")} changed since and kept.` };
    if (errors.length) return { ok: true, message: `Import undone, with a problem: ${errors[0].message}` };
    return { ok: true, message: "Import undone." };
  }
  if (result.status === "unchanged" && errors.length) return { ok: false, message: errors[0].message };
  if (kept) return { ok: true, message: `Undone. ${plural(kept, "item was", "items were")} changed since and kept.` };
  return { ok: true, message: "Undone." };
}

/**
 * Badges for a history entry.
 * @param {any} entry
 * @returns {{key: string, label: string}[]}
 */
export function historyBadges(entry) {
  const out = [];
  if (entry.undoneBy) out.push({ key: "undone", label: "undone" });
  if (entry.undoOf) out.push({ key: "undo", label: "undo" });
  if (!entry.undoable) out.push({ key: "not-undoable", label: entry.evicted ? "too old to undo" : "not undoable" });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

/**
 * The store's positions (layout -> id -> {x, y, pin, v}) as the stored column form
 * {layout, ids, x, y, pin: "0101…", v} that exports read.
 * @param {Map<string, Map<string, {x: number, y: number, pin?: boolean, v?: number}>>} positions
 */
export function positionsToColumns(positions) {
  const out = [];
  for (const [layout, m] of positions ?? []) {
    /** @type {{layout: string, ids: string[], x: number[], y: number[], pin: string, v: number[]}} */
    const col = { layout, ids: [], x: [], y: [], pin: "", v: [] };
    for (const [id, p] of m) {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      col.ids.push(id); col.x.push(p.x); col.y.push(p.y); col.pin += p.pin ? "1" : "0"; col.v.push(p.v ?? 0);
    }
    out.push(col);
  }
  return out;
}

/**
 * The map as exports.js reads it, from the store's optimistic model.
 * @param {{meta: any, objects: Map<string, any>, positions: Map<string, Map<string, any>>}} store
 */
export function storedMapOf(store) {
  return { meta: store.meta ?? {}, objects: [...store.objects.values()], positions: positionsToColumns(store.positions) };
}

/**
 * A file name for an export: the map title made safe, plus a suffix.
 * @param {string|undefined} title @param {string} suffix e.g. "elements.csv"
 */
export function exportFileName(title, suffix) {
  const base = String(title ?? "").normalize("NFKD").replace(/[^\w\s-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60).toLowerCase();
  return `${base || "network-map"}-${suffix}`;
}
