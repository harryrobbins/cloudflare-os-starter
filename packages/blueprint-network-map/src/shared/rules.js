// @ts-check
// Views: decoration rules, selectors, filter, focus and showcase, as JSON, with one evaluator that
// the server uses to validate and the client uses to render. No eval, no user regular
// expressions, and bounded work: at most LIMITS.rules rules of at most LIMITS.predicates
// predicates, each O(1) per item (an `in` list is a Set), so decorating a map is
// O(rules × (elements + connections)).
//
// Selector  { target: "element"|"connection", match: "all"|"any", where: Predicate[] }
//           An empty `where` selects every item of the target.
// Predicate { subject: Subject, op: Op, value?: unknown }
// Subject   { k: "label" } | { k: "type" } | { k: "tag" } | { k: "field", id } | { k: "metric", id }
//           | { k: "id" } | { k: "origin" } | { k: "direction" } | { k: "polarity" }
//           metric ids: degree, indegree, outdegree (Phase 1; computed per render)
// Op        eq ne lt le gt ge contains in exists missing
//
// Rule      { selector: Selector, set: Decoration }   later rules win, key by key
// Decoration, elements:
//   color  { value: "#rrggbb" } | { byCategory: Subject } | { byNumber: Subject, range: ["#hex", "#hex"] }
//   size   { value: number } | { byNumber: Subject, range: [min, max], scale: "linear"|"sqrt"|"log" }
//   shape  circle|square|diamond|triangle|hexagon     label  "label"|"none"|{ field: id }
//   hidden boolean     opacity 0..1     border "#rrggbb"
// Decoration, connections: color (as above), width (as size), arrow "auto"|"none", curved, hidden,
//   opacity, label "label"|"none"|{ field: id }

import {
  DEFAULT_CONNECTION_COLOR, DEFAULT_ELEMENT_COLOR, LAYOUT_KINDS, LIMITS, PALETTE, SHAPES,
  cleanColor, cleanLine, cleanNumber, cleanText, isId, isObject, normalizeLabel,
} from "./protocol.js";

export const OPS = /** @type {const} */ (["eq", "ne", "lt", "le", "gt", "ge", "contains", "in", "exists", "missing"]);
export const SUBJECT_KINDS = /** @type {const} */ (["label", "type", "tag", "field", "metric", "id", "origin", "direction", "polarity"]);
export const METRICS = /** @type {const} */ (["degree", "indegree", "outdegree"]);
export const SCALES = /** @type {const} */ (["linear", "sqrt", "log"]);

const ELEMENT_ONLY = new Set(["metric"]);
const CONNECTION_ONLY = new Set(["direction", "polarity"]);

/** @param {string} message */
const fail = (message) => ({ error: message });

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

/**
 * @param {unknown} raw @param {"element"|"connection"} target
 * @returns {{value: any}|{error: string}}
 */
export function cleanSubject(raw, target) {
  if (!isObject(raw) || !SUBJECT_KINDS.includes(raw.k)) return fail(`subject.k must be one of ${SUBJECT_KINDS.join(", ")}`);
  if (target === "element" && CONNECTION_ONLY.has(raw.k)) return fail(`${raw.k} applies to connections only`);
  if (target === "connection" && ELEMENT_ONLY.has(raw.k)) return fail(`${raw.k} applies to elements only`);
  if (raw.k === "field") return isId(raw.id, "field") ? { value: { k: "field", id: raw.id } } : fail("A field subject needs id: a field id (f_…)");
  if (raw.k === "metric") return METRICS.includes(raw.id) ? { value: { k: "metric", id: raw.id } } : fail(`metric id must be one of ${METRICS.join(", ")}`);
  return { value: { k: raw.k } };
}

/** @param {unknown} v */
function cleanScalar(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return cleanLine(v, LIMITS.label);
  return undefined;
}

/**
 * @param {unknown} raw
 * @returns {{value: any}|{error: string}}
 */
export function cleanSelector(raw) {
  if (!isObject(raw)) return fail("A selector must be an object {target, match, where}");
  const target = raw.target;
  if (target !== "element" && target !== "connection") return fail('selector.target must be "element" or "connection"');
  const match = raw.match === "any" ? "any" : "all";
  const where = raw.where === undefined ? [] : raw.where;
  if (!Array.isArray(where)) return fail("selector.where must be an array");
  if (where.length > LIMITS.predicates) return fail(`A selector may have at most ${LIMITS.predicates} conditions`);
  const out = [];
  for (const p of where) {
    if (!isObject(p)) return fail("Each condition must be an object {subject, op, value}");
    const subject = cleanSubject(p.subject, target);
    if ("error" in subject) return subject;
    if (!OPS.includes(p.op)) return fail(`op must be one of ${OPS.join(", ")}`);
    /** @type {any} */
    const pred = { subject: subject.value, op: p.op };
    if (p.op === "in") {
      if (!Array.isArray(p.value) || !p.value.length) return fail('"in" needs a non-empty list of values');
      if (p.value.length > LIMITS.inValues) return fail(`"in" accepts at most ${LIMITS.inValues} values`);
      const values = p.value.map(cleanScalar);
      if (values.some((v) => v === undefined)) return fail('"in" values must be strings, numbers or booleans');
      pred.value = values;
    } else if (p.op !== "exists" && p.op !== "missing") {
      const v = cleanScalar(p.value);
      if (v === undefined) return fail(`"${p.op}" needs a value (string, number or boolean)`);
      if (["lt", "le", "gt", "ge"].includes(p.op) && typeof v === "boolean") return fail(`"${p.op}" compares numbers, dates or text`);
      pred.value = v;
    }
    out.push(pred);
  }
  return { value: { target, match, where: out } };
}

/**
 * @param {unknown} raw @param {"element"|"connection"} target
 * @returns {{value: any}|{error: string}|{value: undefined}}
 */
function cleanColorSpec(raw, target) {
  if (!isObject(raw)) return fail("color must be {value}, {byCategory} or {byNumber, range}");
  if ("value" in raw) {
    const c = cleanColor(raw.value);
    return c ? { value: { value: c } } : fail("color.value must be #rrggbb");
  }
  if ("byCategory" in raw) {
    const s = cleanSubject(raw.byCategory, target);
    return "error" in s ? s : { value: { byCategory: s.value } };
  }
  if ("byNumber" in raw) {
    const s = cleanSubject(raw.byNumber, target);
    if ("error" in s) return s;
    const range = Array.isArray(raw.range) ? raw.range.map(cleanColor) : [];
    if (range.length !== 2 || range.some((c) => !c)) return fail("color.range must be two #rrggbb colours");
    return { value: { byNumber: s.value, range } };
  }
  return fail("color must be {value}, {byCategory} or {byNumber, range}");
}

/**
 * @param {unknown} raw @param {"element"|"connection"} target @param {number} min @param {number} max
 * @returns {{value: any}|{error: string}}
 */
function cleanSizeSpec(raw, target, min, max) {
  if (!isObject(raw)) return fail("size must be {value} or {byNumber, range, scale}");
  if ("value" in raw) {
    const n = cleanNumber(raw.value, min, max, 2);
    return n === null ? fail(`size.value must be a number from ${min} to ${max}`) : { value: { value: n } };
  }
  if ("byNumber" in raw) {
    const s = cleanSubject(raw.byNumber, target);
    if ("error" in s) return s;
    const range = Array.isArray(raw.range) ? raw.range.map((/** @type {unknown} */ v) => cleanNumber(v, min, max, 2)) : [];
    if (range.length !== 2 || range.some((/** @type {any} */ v) => v === null)) return fail(`size.range must be two numbers from ${min} to ${max}`);
    const scale = SCALES.includes(raw.scale) ? raw.scale : "linear";
    return { value: { byNumber: s.value, range, scale } };
  }
  return fail("size must be {value} or {byNumber, range, scale}");
}

/**
 * @param {unknown} raw @param {"element"|"connection"} target
 * @returns {{value: any}|{error: string}}
 */
export function cleanDecoration(raw, target) {
  if (!isObject(raw)) return fail("set must be an object of decorations");
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, v] of Object.entries(raw)) {
    if (v === undefined || v === null) continue;
    switch (key) {
      case "color": {
        const c = cleanColorSpec(v, target);
        if ("error" in c) return c;
        out.color = c.value;
        break;
      }
      case "size":
      case "width": {
        if ((key === "size") !== (target === "element")) return fail(`${key} applies to ${key === "size" ? "elements" : "connections"}`);
        const s = key === "size" ? cleanSizeSpec(v, target, 1, 100) : cleanSizeSpec(v, target, 0.5, 20);
        if ("error" in s) return s;
        out[key] = s.value;
        break;
      }
      case "shape":
        if (target !== "element" || !SHAPES.includes(v)) return fail(`shape must be one of ${SHAPES.join(", ")} (elements only)`);
        out.shape = v;
        break;
      case "label":
        if (v === "label" || v === "none") out.label = v;
        else if (isObject(v) && isId(v.field, "field")) out.label = { field: v.field };
        else return fail('label must be "label", "none" or {field}');
        break;
      case "hidden":
      case "curved":
        if (typeof v !== "boolean") return fail(`${key} must be true or false`);
        if (key === "curved" && target !== "connection") return fail("curved applies to connections");
        out[key] = v;
        break;
      case "opacity": {
        const n = cleanNumber(v, 0, 1, 2);
        if (n === null) return fail("opacity must be a number from 0 to 1");
        out.opacity = n;
        break;
      }
      case "border": {
        const c = cleanColor(v);
        if (!c || target !== "element") return fail("border must be #rrggbb (elements only)");
        out.border = c;
        break;
      }
      case "arrow":
        if (target !== "connection" || (v !== "auto" && v !== "none")) return fail('arrow must be "auto" or "none" (connections only)');
        out.arrow = v;
        break;
      default:
        return fail(`Unknown decoration "${cleanLine(key, 40)}"`);
    }
  }
  return { value: out };
}

/**
 * @param {unknown} raw
 * @returns {{value: any}|{error: string}}
 */
export function cleanRule(raw) {
  if (!isObject(raw)) return fail("A rule must be {selector, set}");
  const selector = cleanSelector(raw.selector);
  if ("error" in selector) return selector;
  const set = cleanDecoration(raw.set, selector.value.target);
  if ("error" in set) return set;
  /** @type {any} */
  const rule = { selector: selector.value, set: set.value };
  const name = cleanLine(raw.name, 80);
  if (name) rule.name = name;
  if (raw.off === true) rule.off = true;
  return { value: rule };
}

/**
 * Validates a view's content (not its system fields). Used by the server on create and update.
 * @param {Record<string, any>} raw
 * @returns {{value: Record<string, any>}|{error: string}}
 */
export function normalizeView(raw) {
  const name = cleanLine(raw.name, LIMITS.viewName);
  if (!name) return fail("A view needs a name");
  const rawRules = raw.rules === undefined || raw.rules === null ? [] : raw.rules;
  if (!Array.isArray(rawRules)) return fail("rules must be an array");
  if (rawRules.length > LIMITS.rules) return fail(`A view may have at most ${LIMITS.rules} rules`);
  const rules = [];
  for (const [i, r] of rawRules.entries()) {
    const rule = cleanRule(r);
    if ("error" in rule) return fail(`Rule ${i + 1}: ${rule.error}`);
    rules.push(rule.value);
  }
  /** @type {Record<string, any>} */
  const out = { name, rules };
  for (const key of /** @type {const} */ (["filter", "showcase"])) {
    if (raw[key] === undefined || raw[key] === null) continue;
    const s = cleanSelector(raw[key]);
    if ("error" in s) return fail(`${key}: ${s.error}`);
    out[key] = s.value;
  }
  if (raw.focus !== undefined && raw.focus !== null) {
    const f = raw.focus;
    if (!isObject(f) || !Array.isArray(f.roots)) return fail("focus must be {roots: [element ids], depth, direction}");
    const roots = [...new Set(f.roots.filter((/** @type {unknown} */ id) => isId(id, "element")))].slice(0, LIMITS.focusRoots);
    if (roots.length) {
      const depth = Number.isInteger(f.depth) && f.depth >= 1 && f.depth <= 4 ? f.depth : 1;
      const direction = f.direction === "in" || f.direction === "out" ? f.direction : "both";
      out.focus = { roots, depth, direction };
    }
  }
  const layout = isObject(raw.layout) ? raw.layout : {};
  out.layout = { kind: LAYOUT_KINDS.includes(layout.kind) ? layout.kind : "force", own: layout.own === true };
  if (typeof raw.order === "number" && Number.isFinite(raw.order)) out.order = cleanNumber(raw.order, -1e9, 1e9, 4);
  const description = cleanText(raw.description, 2000);
  if (description) out.description = description;
  return { value: out };
}

/** The positions a view uses: its own when layout.own, else the map's shared layout. */
export const SHARED_LAYOUT = "shared";
/** @param {any} view */
export const layoutKeyOf = (view) => (view?.layout?.own ? view.id : SHARED_LAYOUT);

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} GraphIndex  what evaluation needs, built once per render
 * @property {Map<string, any>} elements
 * @property {Map<string, any>} connections
 * @property {Map<string, any>} types
 * @property {Map<string, any>} fields
 * @property {Map<string, {in: number, out: number, degree: number}>} degrees
 * @property {Map<string, string[]>} adjacency  element id -> incident connection ids
 */

/**
 * @param {Iterable<any>} objects every stored object
 * @returns {GraphIndex}
 */
export function buildGraphIndex(objects) {
  /** @type {GraphIndex} */
  const g = { elements: new Map(), connections: new Map(), types: new Map(), fields: new Map(), degrees: new Map(), adjacency: new Map() };
  for (const o of objects) {
    switch (o.id[0]) {
      case "e": g.elements.set(o.id, o); break;
      case "c": g.connections.set(o.id, o); break;
      case "t": g.types.set(o.id, o); break;
      case "f": g.fields.set(o.id, o); break;
    }
  }
  for (const id of g.elements.keys()) {
    g.degrees.set(id, { in: 0, out: 0, degree: 0 });
    g.adjacency.set(id, []);
  }
  for (const c of g.connections.values()) {
    const a = g.degrees.get(c.from), b = g.degrees.get(c.to);
    if (!a || !b) continue;
    a.degree++;
    if (c.from !== c.to) b.degree++;
    if (c.direction === "directed") { a.out++; b.in++; } else { a.out++; a.in++; b.out++; b.in++; }
    g.adjacency.get(c.from)?.push(c.id);
    if (c.from !== c.to) g.adjacency.get(c.to)?.push(c.id);
  }
  return g;
}

/**
 * The value of a subject for an item: a string, number, boolean, string[] (tags, multichoice) or
 * undefined (missing).
 * @param {any} subject @param {any} item @param {GraphIndex} g
 */
export function subjectValue(subject, item, g) {
  switch (subject.k) {
    case "label": return item.label || undefined;
    case "type": return item.typeId ?? undefined;
    case "tag": return item.tags?.length ? item.tags : undefined;
    case "id": return item.id;
    case "origin": return item.provenance?.origin ?? "manual";
    case "direction": return item.direction;
    case "polarity": return item.polarity ?? "unknown";
    case "metric": {
      const d = g.degrees.get(item.id);
      if (!d) return undefined;
      return subject.id === "indegree" ? d.in : subject.id === "outdegree" ? d.out : d.degree;
    }
    case "field": {
      const v = item.fields?.[subject.id];
      if (v === undefined || v === null) return undefined;
      if (isObject(v)) return v.from ?? v.to ?? undefined; // daterange compares on its start
      return v;
    }
    default: return undefined;
  }
}

/** @param {unknown} a @param {unknown} b */
function compare(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number" && typeof b === "string" && b.trim() !== "" && Number.isFinite(Number(b))) return a - Number(b);
  return String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
}

/** @param {unknown} a @param {unknown} b */
function same(a, b) {
  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b, undefined, { sensitivity: "base" }) === 0;
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  if (typeof a === "number" || typeof b === "number") {
    const x = Number(a), y = Number(b);
    return Number.isFinite(x) && Number.isFinite(y) && x === y;
  }
  return a === b;
}

/**
 * Compiles one predicate to a test.
 * @param {any} pred @param {GraphIndex} g
 * @returns {(item: any) => boolean}
 */
function compilePredicate(pred, g) {
  const { subject, op, value } = pred;
  const get = (/** @type {any} */ item) => subjectValue(subject, item, g);
  const anyOf = (/** @type {any} */ v, /** @type {(x: any) => boolean} */ test) => (Array.isArray(v) ? v.some(test) : test(v));
  // A type may be named by id or by name.
  const typeIds = subject.k === "type" ? (/** @type {any} */ v) => {
    if (isId(v, "type")) return v;
    const n = normalizeLabel(v);
    for (const t of g.types.values()) if (normalizeLabel(t.name) === n) return t.id;
    return null;
  } : null;
  switch (op) {
    case "exists": return (item) => get(item) !== undefined;
    case "missing": return (item) => get(item) === undefined;
    case "eq": {
      if (typeIds) { const t = typeIds(value); return (item) => get(item) === t; }
      return (item) => { const v = get(item); return v !== undefined && anyOf(v, (x) => same(x, value)); };
    }
    case "ne": {
      if (typeIds) { const t = typeIds(value); return (item) => get(item) !== t; }
      return (item) => { const v = get(item); return v === undefined || !anyOf(v, (x) => same(x, value)); };
    }
    case "in": {
      if (typeIds) { const set = new Set(value.map(typeIds)); return (item) => set.has(get(item)); }
      const set = new Set(value.map((/** @type {any} */ v) => (typeof v === "string" ? v.toLowerCase() : v)));
      const norm = (/** @type {any} */ x) => (typeof x === "string" ? x.toLowerCase() : x);
      return (item) => { const v = get(item); return v !== undefined && anyOf(v, (x) => set.has(norm(x))); };
    }
    case "contains": {
      const needle = String(value).toLowerCase();
      return (item) => { const v = get(item); return v !== undefined && anyOf(v, (x) => String(x).toLowerCase().includes(needle)); };
    }
    default: {
      const test = op === "lt" ? (/** @type {number} */ c) => c < 0 : op === "le" ? (/** @type {number} */ c) => c <= 0 : op === "gt" ? (/** @type {number} */ c) => c > 0 : (/** @type {number} */ c) => c >= 0;
      return (item) => { const v = get(item); return v !== undefined && !Array.isArray(v) && test(compare(v, value)); };
    }
  }
}

/**
 * @param {any} selector a cleaned selector @param {GraphIndex} g
 * @returns {(item: any) => boolean}
 */
export function compileSelector(selector, g) {
  const tests = selector.where.map((/** @type {any} */ p) => compilePredicate(p, g));
  if (!tests.length) return () => true;
  return selector.match === "any"
    ? (item) => tests.some((/** @type {(i: any) => boolean} */ t) => t(item))
    : (item) => tests.every((/** @type {(i: any) => boolean} */ t) => t(item));
}

/** @param {string} a @param {string} b @param {number} t 0..1 */
export function mixColor(a, b, t) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return "#" + pa.map((x, i) => Math.round(x + (pb[i] - x) * t).toString(16).padStart(2, "0")).join("");
}

/** @param {number} v @param {number} lo @param {number} hi @param {string} scale */
function unit(v, lo, hi, scale) {
  if (!(hi > lo)) return 0.5;
  const f = scale === "log" ? (/** @type {number} */ x) => Math.log1p(Math.max(0, x - lo)) : scale === "sqrt" ? (/** @type {number} */ x) => Math.sqrt(Math.max(0, x - lo)) : (/** @type {number} */ x) => x - lo;
  return Math.min(1, Math.max(0, f(v) / f(hi)));
}

/**
 * @typedef {object} ElementDecor
 * @property {string} color
 * @property {number} size
 * @property {string} shape
 * @property {string|null} label     text to draw, null for none
 * @property {boolean} hidden        removed by a rule, the filter or the focus
 * @property {number} opacity
 * @property {string|null} border
 */
/**
 * @typedef {object} ConnectionDecor
 * @property {string} color
 * @property {number} width
 * @property {boolean} arrow
 * @property {boolean} curved
 * @property {boolean} hidden
 * @property {number} opacity
 * @property {string|null} label
 */
/**
 * @typedef {object} LegendEntry
 * @property {"element"|"connection"} target
 * @property {string} label
 * @property {string} [color]
 * @property {string} [shape]
 * @property {any} [selector]  clicking the entry may filter by this
 */

/**
 * A readable name for a subject.
 * @param {any} subject @param {GraphIndex} g
 */
export function subjectName(subject, g) {
  switch (subject.k) {
    case "field": return g.fields.get(subject.id)?.name ?? "missing field";
    case "metric": return subject.id === "indegree" ? "incoming connections" : subject.id === "outdegree" ? "outgoing connections" : "connections";
    case "origin": return "origin";
    default: return subject.k;
  }
}

/**
 * A category's display text: type ids become type names.
 * @param {any} subject @param {unknown} v @param {GraphIndex} g
 */
function categoryText(subject, v, g) {
  if (subject.k === "type") return g.types.get(/** @type {string} */ (v))?.name ?? "Untyped";
  return String(v);
}

/**
 * Applies a view to a map: per-item decorations, visibility (rules, filter, focus), showcase
 * dimming, and the legend. Pure and deterministic.
 * @param {GraphIndex} g @param {any|null} view a cleaned view (or null for defaults)
 * @returns {{elements: Map<string, ElementDecor>, connections: Map<string, ConnectionDecor>, legend: LegendEntry[], visibleElements: number, visibleConnections: number}}
 */
export function decorate(g, view) {
  /** @type {Map<string, ElementDecor>} */
  const elements = new Map();
  /** @type {Map<string, ConnectionDecor>} */
  const connections = new Map();
  /** @type {LegendEntry[]} */
  const legend = [];

  // Base: type colours and shapes, then labels.
  for (const e of g.elements.values()) {
    const t = e.typeId ? g.types.get(e.typeId) : null;
    elements.set(e.id, {
      color: t?.color ?? DEFAULT_ELEMENT_COLOR, size: 8, shape: t?.shape ?? "circle",
      label: e.label, hidden: false, opacity: 1, border: null,
    });
  }
  for (const c of g.connections.values()) {
    const t = c.typeId ? g.types.get(c.typeId) : null;
    connections.set(c.id, {
      color: t?.color ?? DEFAULT_CONNECTION_COLOR, width: c.strength != null ? Math.min(8, 1.5 + Math.abs(c.strength) / 2) : 1.5,
      arrow: c.direction !== "undirected", curved: false, hidden: false, opacity: 1, label: c.label || null,
    });
  }
  // Type legend (only types in use).
  const usedTypes = new Set();
  for (const e of g.elements.values()) if (e.typeId) usedTypes.add(e.typeId);
  for (const c of g.connections.values()) if (c.typeId) usedTypes.add(c.typeId);
  for (const t of g.types.values()) {
    if (!usedTypes.has(t.id)) continue;
    legend.push({
      target: t.appliesTo, label: t.name, color: t.color ?? (t.appliesTo === "element" ? DEFAULT_ELEMENT_COLOR : DEFAULT_CONNECTION_COLOR),
      shape: t.shape ?? undefined,
      selector: { target: t.appliesTo, match: "all", where: [{ subject: { k: "type" }, op: "eq", value: t.id }] },
    });
  }

  const rules = view?.rules ?? [];
  for (const rule of rules) {
    if (rule.off) continue;
    const target = rule.selector.target;
    const test = compileSelector(rule.selector, g);
    const items = target === "element" ? [...g.elements.values()] : [...g.connections.values()];
    const matched = items.filter(test);
    const decor = /** @type {Map<string, any>} */ (target === "element" ? elements : connections);
    const set = rule.set;

    /** @type {((item: any) => string)|null} */
    let colorOf = null;
    if (set.color?.value) colorOf = () => set.color.value;
    else if (set.color?.byCategory) {
      const subj = set.color.byCategory;
      /** @type {Map<string, string>} */
      const palette = new Map();
      const values = [];
      for (const item of matched) {
        const v = subjectValue(subj, item, g);
        for (const x of Array.isArray(v) ? v : [v]) if (x !== undefined && !palette.has(String(x))) { palette.set(String(x), ""); values.push(x); }
      }
      values.sort((a, b) => compare(categoryText(subj, a, g), categoryText(subj, b, g)));
      values.forEach((v, i) => palette.set(String(v), PALETTE[i % PALETTE.length]));
      colorOf = (item) => {
        const v = subjectValue(subj, item, g);
        const first = Array.isArray(v) ? v[0] : v;
        return first === undefined ? "#bab0ac" : palette.get(String(first)) ?? "#bab0ac";
      };
      for (const v of values.slice(0, 24)) {
        legend.push({
          target, label: `${categoryText(subj, v, g)}`, color: palette.get(String(v)),
          selector: { target, match: "all", where: [{ subject: subj, op: "eq", value: v }] },
        });
      }
    } else if (set.color?.byNumber) {
      const subj = set.color.byNumber;
      const [lo, hi] = numericDomain(matched, subj, g);
      const [c0, c1] = set.color.range;
      colorOf = (item) => {
        const v = subjectValue(subj, item, g);
        return typeof v === "number" ? mixColor(c0, c1, unit(v, lo, hi, "linear")) : "#bab0ac";
      };
      legend.push({ target, label: `${subjectName(subj, g)}: ${fmt(lo)} → ${fmt(hi)}`, color: c1 });
    }

    const sizeSpec = target === "element" ? set.size : set.width;
    /** @type {((item: any) => number)|null} */
    let sizeOf = null;
    if (sizeSpec?.value !== undefined) sizeOf = () => sizeSpec.value;
    else if (sizeSpec?.byNumber) {
      const [lo, hi] = numericDomain(matched, sizeSpec.byNumber, g);
      const [s0, s1] = sizeSpec.range;
      sizeOf = (item) => {
        const v = subjectValue(sizeSpec.byNumber, item, g);
        return typeof v === "number" ? s0 + (s1 - s0) * unit(v, lo, hi, sizeSpec.scale) : s0;
      };
      legend.push({ target, label: `${target === "element" ? "Size" : "Width"} by ${subjectName(sizeSpec.byNumber, g)}` });
    }

    for (const item of matched) {
      const d = decor.get(item.id);
      if (!d) continue;
      if (colorOf) d.color = colorOf(item);
      if (sizeOf) d[target === "element" ? "size" : "width"] = sizeOf(item);
      if (set.shape) d.shape = set.shape;
      if (set.hidden !== undefined) d.hidden = set.hidden;
      if (set.opacity !== undefined) d.opacity = set.opacity;
      if (set.border) d.border = set.border;
      if (set.arrow) d.arrow = set.arrow === "auto" ? item.direction !== "undirected" : false;
      if (set.curved !== undefined) d.curved = set.curved;
      if (set.label !== undefined) {
        if (set.label === "none") d.label = null;
        else if (set.label === "label") d.label = item.label || null;
        else {
          const v = item.fields?.[set.label.field];
          d.label = v === undefined || v === null ? null : Array.isArray(v) ? v.join(", ") : isObject(v) ? `${v.from ?? ""}–${v.to ?? ""}` : String(v);
        }
      }
    }
  }

  // Filter: excluded elements are hidden; connections go with either end.
  if (view?.filter) {
    const test = compileSelector(view.filter, g);
    if (view.filter.target === "element") {
      for (const e of g.elements.values()) if (!test(e)) /** @type {ElementDecor} */ (elements.get(e.id)).hidden = true;
    } else {
      for (const c of g.connections.values()) if (!test(c)) /** @type {ConnectionDecor} */ (connections.get(c.id)).hidden = true;
    }
  }
  // Focus: only the neighbourhood of the roots stays visible.
  if (view?.focus?.roots?.length) {
    const keep = neighbourhood(g, view.focus.roots, view.focus.depth, view.focus.direction, (id) => !elements.get(id)?.hidden);
    for (const [id, d] of elements) if (!keep.has(id)) d.hidden = true;
  }
  for (const c of g.connections.values()) {
    const d = /** @type {ConnectionDecor} */ (connections.get(c.id));
    if (elements.get(c.from)?.hidden || elements.get(c.to)?.hidden) d.hidden = true;
  }
  // Showcase: matching items stay, everything else dims.
  if (view?.showcase) {
    const test = compileSelector(view.showcase, g);
    if (view.showcase.target === "element") {
      for (const e of g.elements.values()) if (!test(e)) /** @type {ElementDecor} */ (elements.get(e.id)).opacity *= 0.15;
      for (const c of g.connections.values()) {
        const a = g.elements.get(c.from), b = g.elements.get(c.to);
        if (!(a && test(a) && b && test(b))) /** @type {ConnectionDecor} */ (connections.get(c.id)).opacity *= 0.15;
      }
    } else {
      for (const c of g.connections.values()) if (!test(c)) /** @type {ConnectionDecor} */ (connections.get(c.id)).opacity *= 0.15;
    }
  }
  let visibleElements = 0, visibleConnections = 0;
  for (const d of elements.values()) if (!d.hidden) visibleElements++;
  for (const d of connections.values()) if (!d.hidden) visibleConnections++;
  return { elements, connections, legend, visibleElements, visibleConnections };
}

/** @param {number} n */
const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/**
 * @param {any[]} items @param {any} subject @param {GraphIndex} g
 * @returns {[number, number]}
 */
function numericDomain(items, subject, g) {
  let lo = Infinity, hi = -Infinity;
  for (const item of items) {
    const v = subjectValue(subject, item, g);
    if (typeof v !== "number") continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo === Infinity ? [0, 0] : [lo, hi];
}

/**
 * Element ids within `depth` steps of the roots, following connections in `direction` (a
 * non-directed connection is walked both ways). `allowed` limits the walk to visible elements.
 * @param {GraphIndex} g @param {string[]} roots @param {number} depth @param {"in"|"out"|"both"} direction
 * @param {(id: string) => boolean} [allowed]
 * @returns {Set<string>}
 */
export function neighbourhood(g, roots, depth, direction, allowed = () => true) {
  const seen = new Set(roots.filter((id) => g.elements.has(id) && allowed(id)));
  let frontier = [...seen];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next = [];
    for (const id of frontier) {
      for (const cid of g.adjacency.get(id) ?? []) {
        const c = g.connections.get(cid);
        if (!c) continue;
        const directed = c.direction === "directed";
        /** @type {string[]} */
        const targets = [];
        if (c.from === id && (direction !== "in" || !directed)) targets.push(c.to);
        if (c.to === id && (direction !== "out" || !directed)) targets.push(c.from);
        for (const t of targets) {
          if (seen.has(t) || !allowed(t)) continue;
          seen.add(t);
          next.push(t);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

/**
 * One line describing a selector, for the rule list and legend ("elements where type = Person").
 * @param {any} selector @param {GraphIndex} g
 */
export function describeSelector(selector, g) {
  const noun = selector.target === "element" ? "elements" : "connections";
  if (!selector.where.length) return `all ${noun}`;
  const parts = selector.where.map((/** @type {any} */ p) => {
    const name = subjectName(p.subject, g);
    const value = p.subject.k === "type" ? (g.types.get(p.value)?.name ?? p.value) : p.value;
    const op = { eq: "=", ne: "≠", lt: "<", le: "≤", gt: ">", ge: "≥", contains: "contains", in: "is one of", exists: "is set", missing: "is not set" }[/** @type {string} */ (p.op)];
    return p.op === "exists" || p.op === "missing" ? `${name} ${op}` : `${name} ${op} ${Array.isArray(value) ? value.join(", ") : value}`;
  });
  return `${noun} where ${parts.join(selector.match === "any" ? " or " : " and ")}`;
}
