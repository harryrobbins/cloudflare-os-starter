// @ts-check
// Editing help for WQL: autocomplete at a cursor, filter chips that round-trip to text, and
// toggling a single term (quick filters).

import { CATEGORIES, KINDS } from "../model/work.js";
import { personName } from "../model/index.js";
import { FIELDS, PREDICATES, fieldByName, quoteValue } from "./fields.js";
import { group, negate, parse } from "./parse.js";
import { format, formatNode } from "./text.js";

/**
 * @typedef {import("./parse.js").Node} Node
 * @typedef {import("./parse.js").Query} Query
 * @typedef {import("./parse.js").SortKey} SortKey
 * @typedef {import("./evaluate.js").WqlContext} WqlContext
 * @typedef {{ label: string, insert: string, detail: string, kind: "field"|"value"|"keyword"|"predicate" }} Suggestion
 * @typedef {{ field: string, op: string, values: string[], negated: boolean, text: string }} Chip
 */

const DATE_PRESETS = [["today", "Today"], ["-7d", "7 days ago"], ["7d", "In 7 days"], ["-14d", "14 days ago"], ["-30d", "30 days ago"], ["none", "No date"]];
const MAX = 50;

/** Values offered for a field. @param {string} fieldName @param {WqlContext} ctx @returns {Suggestion[]} */
function valuesFor(fieldName, ctx) {
  const idx = ctx.index;
  const v = (/** @type {string} */ value, detail = "", /** @type {Suggestion["kind"]} */ kind = "value") => ({ label: value, insert: quoteValue(value), detail, kind });
  const lower = fieldName.toLowerCase();
  if (lower === "is") return PREDICATES.map((p) => v(p, "", "predicate"));
  if (lower === "has") return FIELDS.filter((f) => f.name !== "rank").map((f) => v(f.name, f.doc, "field"));
  if (lower === "sort") return FIELDS.filter((f) => f.sortable).flatMap((f) => [v(f.name, "ascending", "field"), v(`-${f.name}`, "descending", "field")]);
  const field = fieldByName(fieldName);
  if (!field) return [];
  switch (field.name === "priority" || field.name === "status" ? field.name : field.type) {
    case "priority": return ["urgent", "high", "medium", "low", "none"].map((p) => v(p));
    case "status": return CATEGORIES.map((c) => v(c));
    case "kind": return KINDS.map((k) => v(k));
    case "state": return idx.states.map((s) => v(s.name, s.key));
    case "person": return [v("me", "You"), v("none", "Nobody"), ...[...idx.people.keys()].map((a) => v(personName(idx, a), a))];
    case "labels": {
      const keys = new Set([...idx.labels.map((l) => l.key), ...idx.itemList.flatMap((i) => i.labels)]);
      return [...[...keys].toSorted().map((k) => v(k, idx.labelByKey.get(k)?.name ?? "")), v("none", "No labels")];
    }
    case "project": return [...idx.projects.map((p) => v(p.name, p.state)), v("none", "Not in a project")];
    case "cycle": return [v("current"), v("next"), v("previous"), ...idx.cycles.map((c) => v(c.name, [c.start, c.end].filter(Boolean).join(" – "))), v("none", "Not in a cycle")];
    case "date": case "instant": return DATE_PRESETS.map(([p, d]) => v(p, d));
    case "bool": return [v("true"), v("false")];
    case "ref-item": return [v("none", "No parent"), ...[...idx.children.keys()].map((id) => idx.items.get(id)).filter(Boolean).map((i) => v(/** @type {any} */ (i).key, /** @type {any} */ (i).title))];
    case "key": return idx.itemList.slice(0, MAX).map((i) => v(i.key, i.title));
    case "number": case "ext": return [v("none")];
  }
  return [];
}

/**
 * Completions at the cursor.
 * @param {string} text @param {number} cursor @param {WqlContext} ctx
 * @returns {{ from: number, to: number, items: Suggestion[] }}
 */
export function suggest(text, cursor, ctx) {
  const at = Math.max(0, Math.min(cursor ?? text.length, text.length));
  let start = at;
  let quotes = 0;
  for (let i = 0; i < at; i++) if (text[i] === '"' && text[i - 1] !== "\\") quotes++;
  // Walk back to the token start; inside an open quote whitespace belongs to the token.
  let open = quotes % 2 === 1;
  while (start > 0) {
    const c = text[start - 1];
    if (c === '"') open = !open;
    if (!open && /[\s()]/.test(c)) break;
    start--;
  }
  let token = text.slice(start, at);
  if (token.startsWith("-")) { start++; token = token.slice(1); }
  const colon = token.indexOf(":");
  /** @type {Suggestion[]} */
  let items;
  let from;
  let prefix;
  if (colon > 0) {
    const field = token.slice(0, colon);
    let rest = token.slice(colon + 1);
    const opMatch = /^(<=|>=|<|>|=)/.exec(rest);
    const valueStart = start + colon + 1 + (opMatch ? opMatch[0].length : 0);
    rest = rest.slice(opMatch ? opMatch[0].length : 0);
    const comma = rest.lastIndexOf(",");
    from = valueStart + comma + 1;
    prefix = rest.slice(comma + 1).replace(/^"/, "");
    items = valuesFor(field, ctx);
  } else {
    from = start;
    prefix = token;
    items = [
      ...FIELDS.filter((f) => f.name !== "rank").map((f) => ({ label: `${f.name}:`, insert: `${f.name}:`, detail: f.doc, kind: /** @type {const} */ ("field") })),
      { label: "is:", insert: "is:", detail: "blocked, overdue, unassigned…", kind: "field" },
      { label: "has:", insert: "has:", detail: "Any field with a value", kind: "field" },
      { label: "sort:", insert: "sort:", detail: "Sort by fields; -field for descending", kind: "field" },
      ...(start > 0 ? ["OR", "AND", "NOT"].map((k) => ({ label: k, insert: k, detail: "", kind: /** @type {const} */ ("keyword") })) : []),
    ];
  }
  const p = prefix.toLowerCase();
  const first = [], second = [];
  for (const item of items) {
    const l = item.label.toLowerCase();
    if (l.startsWith(p)) first.push(item); else if (p && l.includes(p)) second.push(item);
  }
  return { from, to: at, items: [...first, ...second].slice(0, MAX) };
}

// ---------------------------------------------------------------------------------------------
// Chips and toggles

/** @param {Node} node */
const chipable = (node) => node.type === "term" || node.type === "is" || node.type === "has";

/** Splits a query's top-level AND into chips and the rest. @param {Query} ast @returns {{ chips: Chip[], rest: Node[] }} */
export function toChips(ast) {
  const where = ast?.where;
  const children = !where ? [] : where.type === "and" ? where.children : [where];
  /** @type {Chip[]} */
  const chips = [];
  /** @type {Node[]} */
  const rest = [];
  for (const child of children) {
    const negated = child.type === "not";
    const inner = negated ? /** @type {any} */ (child).child : child;
    if (!chipable(inner)) { rest.push(child); continue; }
    chips.push(inner.type === "term"
      ? { field: inner.field, op: inner.op, values: [...inner.values], negated, text: formatNode(child) }
      : { field: inner.type, op: "eq", values: [inner.value], negated, text: formatNode(child) });
  }
  return { chips, rest };
}

/** @param {Chip[]} chips @param {Node[]} [rest] @param {SortKey[]} [sort] @returns {Query} */
export function fromChips(chips, rest = [], sort = []) {
  const nodes = chips.map((c) => {
    /** @type {Node} */
    const node = c.field === "is" || c.field === "has"
      ? { type: c.field, value: c.values[0], span: [0, 0] }
      : { type: "term", field: c.field, op: /** @type {any} */ (c.op), values: [...c.values], span: [0, 0] };
    return c.negated ? negate(node) : node;
  });
  return { type: "query", where: group("and", [...nodes, ...rest]), sort: [...sort] };
}

/** @param {unknown} value @returns {string} */
function shape(value) {
  return JSON.stringify(value, (k, v) => (k === "span" ? undefined : typeof v === "string" && k !== "type" && k !== "field" && k !== "op" ? v.toLowerCase() : v));
}

/** @param {string} text @param {string} termText */
function split(text, termText) {
  const { ast } = parse(text);
  const term = parse(termText).ast.where;
  const children = !ast.where ? [] : ast.where.type === "and" ? ast.where.children : [ast.where];
  const wanted = term ? shape(term) : "";
  return { ast, term, children, index: term ? children.findIndex((c) => shape(c) === wanted) : -1 };
}

/** Whether the query's top-level AND contains the term. @param {string} text @param {string} termText */
export function hasTerm(text, termText) { return split(text, termText).index >= 0; }

/** Adds the term (AND) when absent, removes it when present; returns canonical text. @param {string} text @param {string} termText */
export function toggleTerm(text, termText) {
  const { ast, term, children, index } = split(text, termText);
  if (!term) return format(ast);
  const next = index >= 0 ? children.filter((_, i) => i !== index) : [...children, term];
  return format({ type: "query", where: group("and", next), sort: ast.sort });
}
