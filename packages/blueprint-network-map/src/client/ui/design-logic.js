// @ts-check
// Pure helpers for the Design panel (./design.js): the rule editor's state and its conversion to
// and from the JSON of src/shared/rules.js (selectors, predicates, decorations), which operators
// and values make sense for each subject, readable summaries, and usage counts that let the panel
// explain the server's refusals (a type in use, a choice in use) before a change is sent.
//
// Editor state (plain data, safe to structuredClone):
//   SelectorState   { target, match, conditions: ConditionState[] }
//   ConditionState  { subject: SubjectKey, op, value: string | string[] }   ("in" takes string[])
//   DecorationState { color: {mode, value, subject, from, to}, size: {mode, value, subject, min, max, scale},
//                     shape, label, hidden, opacity, border, arrow, curved }
//   RuleState       { name, off, target, match, conditions, deco }
// SubjectKey is a string: "label" | "type" | "tag" | "origin" | "direction" | "polarity" | "id"
//   | "field:<field id>" | "metric:<degree|indegree|outdegree>".

import { DIRECTIONS, LIMITS, PALETTE, POLARITIES, PROVENANCE_ORIGINS, SHAPES, fieldApplies } from "../../shared/protocol.js";
import { METRICS, SCALES, cleanRule, cleanSelector, compileSelector, describeSelector } from "../../shared/rules.js";

/** @typedef {"element"|"connection"} Target */
/** @typedef {"number"|"date"|"text"|"type"|"choice"|"enum"|"bool"} ValueKind */
/** @typedef {{subject: string, op: string, value: string|string[]}} ConditionState */
/** @typedef {{target: Target, match: "all"|"any", conditions: ConditionState[]}} SelectorState */
/**
 * @typedef {object} DecorationState
 * @property {{mode: "none"|"fixed"|"category"|"number", value: string, subject: string, from: string, to: string}} color
 * @property {{mode: "none"|"fixed"|"number", value: number, subject: string, min: number, max: number, scale: string}} size
 * @property {string} shape    "" (unchanged) or a shape
 * @property {string} label    "" | "label" | "none" | "field:<id>"
 * @property {""|"hide"|"show"} hidden
 * @property {number|null} opacity
 * @property {string} border   "" or "#rrggbb"
 * @property {""|"auto"|"none"} arrow
 * @property {""|"yes"|"no"} curved
 */
/** @typedef {{name: string, off: boolean, target: Target, match: "all"|"any", conditions: ConditionState[], deco: DecorationState}} RuleState */

/** Operator text for pickers: symbol and words (screen readers do not read "≤" reliably). */
export const OP_LABELS = Object.freeze({
  eq: "= is", ne: "≠ is not", lt: "< less than", le: "≤ at most", gt: "> more than", ge: "≥ at least",
  contains: "contains", in: "is one of", exists: "is set", missing: "is not set",
});

/** @type {Record<ValueKind, string[]>} */
const OPS_BY_KIND = {
  number: ["lt", "le", "gt", "ge", "eq", "ne", "exists", "missing"],
  date: ["lt", "le", "gt", "ge", "eq", "ne", "exists", "missing"],
  text: ["eq", "ne", "contains", "in", "exists", "missing"],
  type: ["eq", "ne", "in", "exists", "missing"],
  choice: ["eq", "ne", "in", "exists", "missing"],
  enum: ["eq", "ne", "in"],
  bool: ["eq", "ne", "exists", "missing"],
};

/** @param {ValueKind} kind @returns {string[]} the operators that make sense for a kind of value */
export const opsForKind = (kind) => OPS_BY_KIND[kind] ?? OPS_BY_KIND.text;

/** @param {string} op */
export const opNeedsValue = (op) => op !== "exists" && op !== "missing";

const ELEMENT_SIZE = /** @type {const} */ ([1, 100]);
const CONNECTION_WIDTH = /** @type {const} */ ([0.5, 20]);
/** @param {Target} target */
export const sizeBounds = (target) => (target === "element" ? ELEMENT_SIZE : CONNECTION_WIDTH);

// ---------------------------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------------------------

/** @param {any} subject @returns {string} */
export function subjectKey(subject) {
  if (subject.k === "field") return `field:${subject.id}`;
  if (subject.k === "metric") return `metric:${subject.id}`;
  return subject.k;
}

/** @param {string} key @returns {any} */
export function subjectFromKey(key) {
  const i = key.indexOf(":");
  if (i < 0) return { k: key };
  return { k: key.slice(0, i), id: key.slice(i + 1) };
}

/**
 * @param {string} key @param {any} index a GraphIndex (only `fields` and `types` are read)
 * @returns {ValueKind}
 */
export function subjectKind(key, index) {
  const s = subjectFromKey(key);
  switch (s.k) {
    case "metric": return "number";
    case "type": return "type";
    case "origin": case "direction": case "polarity": return "enum";
    case "field": {
      const f = index.fields.get(s.id);
      switch (f?.kind) {
        case "number": return "number";
        case "date": case "daterange": return "date";
        case "bool": return "bool";
        case "choice": case "multichoice": return "choice";
        default: return "text";
      }
    }
    default: return "text";
  }
}

const METRIC_LABELS = { degree: "Connections", indegree: "Incoming connections", outdegree: "Outgoing connections" };
const BUILTIN_LABELS = { label: "Label", type: "Type", tag: "Tag", origin: "Origin", direction: "Direction", polarity: "Polarity", id: "Id" };

/** A subject's name for pickers and summaries. @param {string} key @param {any} index */
export function subjectLabel(key, index) {
  const s = subjectFromKey(key);
  if (s.k === "field") return index.fields.get(s.id)?.name ?? "Missing field";
  if (s.k === "metric") return /** @type {any} */ (METRIC_LABELS)[s.id] ?? s.id;
  return /** @type {any} */ (BUILTIN_LABELS)[s.k] ?? s.k;
}

/** Custom fields for a target, by name. @param {Target} target @param {any} index */
function fieldsFor(target, index) {
  return [...index.fields.values()].filter((f) => fieldApplies(f, target)).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Subjects a condition can test, grouped for an <optgroup> picker.
 * @param {Target} target @param {any} index
 * @returns {{key: string, label: string, group: string}[]}
 */
export function subjectOptions(target, index) {
  /** @type {{key: string, label: string, group: string}[]} */
  const out = [
    { key: "label", label: "Label", group: "Built in" },
    { key: "type", label: "Type", group: "Built in" },
    { key: "tag", label: "Tag", group: "Built in" },
  ];
  if (target === "connection") {
    out.push({ key: "direction", label: "Direction", group: "Built in" }, { key: "polarity", label: "Polarity", group: "Built in" });
  }
  out.push({ key: "origin", label: "Origin", group: "Built in" });
  for (const f of fieldsFor(target, index)) out.push({ key: `field:${f.id}`, label: f.name, group: "Fields" });
  if (target === "element") for (const m of METRICS) out.push({ key: `metric:${m}`, label: METRIC_LABELS[m], group: "Metrics" });
  return out;
}

/**
 * Subjects that make categories (colour by category).
 * @param {Target} target @param {any} index
 */
export function categorySubjectOptions(target, index) {
  return subjectOptions(target, index).filter((o) => o.key !== "label" && !o.key.startsWith("metric:")
    && (!o.key.startsWith("field:") || !["number", "date"].includes(subjectKind(o.key, index))));
}

/**
 * Subjects with numbers (colour or size by number).
 * @param {Target} target @param {any} index
 */
export function numberSubjectOptions(target, index) {
  return subjectOptions(target, index).filter((o) => subjectKind(o.key, index) === "number");
}

/**
 * The fixed values a subject can take (a select), or null for free input.
 * @param {string} key @param {any} index @param {Target} target
 * @returns {{value: string, label: string}[]|null}
 */
export function valueOptions(key, index, target) {
  const s = subjectFromKey(key);
  switch (s.k) {
    case "type":
      return [...index.types.values()].filter((t) => t.appliesTo === target).sort((a, b) => a.name.localeCompare(b.name)).map((t) => ({ value: t.id, label: t.name }));
    case "origin": return PROVENANCE_ORIGINS.map((v) => ({ value: v, label: v }));
    case "direction": return DIRECTIONS.map((v) => ({ value: v, label: v }));
    case "polarity": return POLARITIES.map((v) => ({ value: v, label: v === "+" ? "+ (same direction)" : v === "-" ? "− (opposite direction)" : "unknown" }));
    case "field": {
      const f = index.fields.get(s.id);
      if (f?.kind === "bool") return [{ value: "true", label: "yes" }, { value: "false", label: "no" }];
      if (f?.kind === "choice" || f?.kind === "multichoice") return (f.choices ?? []).map((/** @type {string} */ c) => ({ value: c, label: c }));
      return null;
    }
    default: return null;
  }
}

/** The input type for a free-text value. @param {ValueKind} kind */
export const inputTypeFor = (kind) => (kind === "number" ? "number" : kind === "date" ? "date" : "text");

/**
 * A fresh condition for a subject: its first sensible operator and an empty or first value.
 * @param {string} key @param {any} index @param {Target} target
 * @returns {ConditionState}
 */
export function conditionFor(key, index, target) {
  const kind = subjectKind(key, index);
  const op = kind === "number" || kind === "date" ? "ge" : key === "label" ? "contains" : opsForKind(kind)[0];
  const options = valueOptions(key, index, target);
  return { subject: key, op, value: options?.length ? options[0].value : "" };
}

/**
 * Changes a condition's operator, converting its value between one value and a list.
 * @param {ConditionState} cond @param {string} op
 * @returns {ConditionState}
 */
export function withOp(cond, op) {
  const wasList = Array.isArray(cond.value);
  if (op === "in" && !wasList) return { ...cond, op, value: cond.value ? [/** @type {string} */ (cond.value)] : [] };
  if (op !== "in" && wasList) return { ...cond, op, value: cond.value[0] ?? "" };
  return { ...cond, op };
}

// ---------------------------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------------------------

/** @param {Target} target @returns {SelectorState} */
export const emptySelectorState = (target) => ({ target, match: "all", conditions: [] });

/** @param {unknown} v */
const str = (v) => (typeof v === "string" ? v : String(v));

/** @param {any} pred @returns {ConditionState} */
export function conditionFromPredicate(pred) {
  const subject = subjectKey(pred.subject);
  if (!opNeedsValue(pred.op)) return { subject, op: pred.op, value: "" };
  if (pred.op === "in") return { subject, op: "in", value: (pred.value ?? []).map(str) };
  return { subject, op: pred.op, value: pred.value === undefined ? "" : str(pred.value) };
}

/** @param {any} selector a cleaned selector @returns {SelectorState} */
export function stateFromSelector(selector) {
  return {
    target: selector.target, match: selector.match === "any" ? "any" : "all",
    conditions: (selector.where ?? []).map(conditionFromPredicate),
  };
}

/**
 * @param {string} raw @param {ValueKind} kind
 * @returns {{value: string|number|boolean}|{error: string}}
 */
function scalarFor(raw, kind) {
  const s = String(raw).trim();
  if (!s) return { error: "needs a value" };
  if (kind === "number") {
    const n = Number(s);
    return Number.isFinite(n) ? { value: n } : { error: "needs a number" };
  }
  if (kind === "bool") return s === "true" || s === "false" ? { value: s === "true" } : { error: "needs yes or no" };
  if (kind === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(s)) return { error: "needs a date (YYYY-MM-DD)" };
  return { value: s };
}

/** Splits a typed list ("a, b, c") into values. @param {string} s */
export const splitList = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);

/**
 * @param {ConditionState} cond @param {any} index
 * @returns {{value: any}|{error: string}} a predicate
 */
export function predicateFromCondition(cond, index) {
  const subject = subjectFromKey(cond.subject);
  const kind = subjectKind(cond.subject, index);
  if (!opsForKind(kind).includes(cond.op)) return { error: `“${OP_LABELS[/** @type {keyof typeof OP_LABELS} */ (cond.op)] ?? cond.op}” does not apply to ${subjectLabel(cond.subject, index)}` };
  if (!opNeedsValue(cond.op)) return { value: { subject, op: cond.op } };
  if (cond.op === "in") {
    const raw = Array.isArray(cond.value) ? cond.value : splitList(cond.value);
    if (!raw.length) return { error: "choose at least one value" };
    if (raw.length > LIMITS.inValues) return { error: `at most ${LIMITS.inValues} values` };
    const values = [];
    for (const r of raw) {
      const v = scalarFor(r, kind);
      if ("error" in v) return v;
      values.push(v.value);
    }
    return { value: { subject, op: "in", value: values } };
  }
  const v = scalarFor(Array.isArray(cond.value) ? cond.value[0] ?? "" : cond.value, kind);
  if ("error" in v) return v;
  return { value: { subject, op: cond.op, value: v.value } };
}

/**
 * Builds and validates a selector.
 * @param {SelectorState} state @param {any} index
 * @returns {{value: any}|{error: string}}
 */
export function selectorFromState(state, index) {
  if (state.conditions.length > LIMITS.predicates) return { error: `At most ${LIMITS.predicates} conditions` };
  const where = [];
  for (const [i, c] of state.conditions.entries()) {
    const p = predicateFromCondition(c, index);
    if ("error" in p) return { error: `Condition ${i + 1}: ${subjectLabel(c.subject, index)} ${p.error}` };
    where.push(p.value);
  }
  return cleanSelector({ target: state.target, match: state.match, where });
}

/**
 * How many items a selector picks. O(items × conditions).
 * @param {any} selector a cleaned selector @param {any} index
 */
export function matchCount(selector, index) {
  const test = compileSelector(selector, index);
  const pool = selector.target === "element" ? index.elements : index.connections;
  let n = 0;
  for (const item of pool.values()) if (test(item)) n++;
  return n;
}

// ---------------------------------------------------------------------------------------------
// Decorations
// ---------------------------------------------------------------------------------------------

/** @param {Target} target @returns {DecorationState} */
export function emptyDecorationState(target) {
  const [lo, hi] = target === "element" ? [4, 16] : [1, 6];
  return {
    color: { mode: "none", value: PALETTE[0], subject: "type", from: "#9ecae1", to: "#08519c" },
    size: { mode: "none", value: target === "element" ? 8 : 2, subject: target === "element" ? "metric:degree" : "", min: lo, max: hi, scale: "linear" },
    shape: "", label: "", hidden: "", opacity: null, border: "", arrow: "", curved: "",
  };
}

/**
 * @param {any} set a cleaned decoration @param {Target} target
 * @returns {DecorationState}
 */
export function stateFromDecoration(set, target) {
  const d = emptyDecorationState(target);
  const c = set.color;
  if (c?.value) d.color = { ...d.color, mode: "fixed", value: c.value };
  else if (c?.byCategory) d.color = { ...d.color, mode: "category", subject: subjectKey(c.byCategory) };
  else if (c?.byNumber) d.color = { ...d.color, mode: "number", subject: subjectKey(c.byNumber), from: c.range[0], to: c.range[1] };
  const s = target === "element" ? set.size : set.width;
  if (s?.value !== undefined) d.size = { ...d.size, mode: "fixed", value: s.value };
  else if (s?.byNumber) d.size = { ...d.size, mode: "number", subject: subjectKey(s.byNumber), min: s.range[0], max: s.range[1], scale: s.scale ?? "linear" };
  if (set.shape) d.shape = set.shape;
  if (set.label !== undefined) d.label = typeof set.label === "string" ? set.label : `field:${set.label.field}`;
  if (set.hidden !== undefined) d.hidden = set.hidden ? "hide" : "show";
  if (set.opacity !== undefined) d.opacity = set.opacity;
  if (set.border) d.border = set.border;
  if (set.arrow) d.arrow = set.arrow;
  if (set.curved !== undefined) d.curved = set.curved ? "yes" : "no";
  return d;
}

/**
 * The decoration JSON for the editor state (not yet validated: see ruleFromState). Keys that do not
 * apply to the target are left out, so switching target keeps the rest.
 * @param {DecorationState} d @param {Target} target
 * @returns {Record<string, any>}
 */
export function decorationFromState(d, target) {
  /** @type {Record<string, any>} */
  const set = {};
  if (d.color.mode === "fixed") set.color = { value: d.color.value.toLowerCase() };
  else if (d.color.mode === "category") set.color = { byCategory: subjectFromKey(d.color.subject) };
  else if (d.color.mode === "number") set.color = { byNumber: subjectFromKey(d.color.subject), range: [d.color.from.toLowerCase(), d.color.to.toLowerCase()] };
  const sizeKey = target === "element" ? "size" : "width";
  if (d.size.mode === "fixed") set[sizeKey] = { value: Number(d.size.value) };
  else if (d.size.mode === "number") set[sizeKey] = { byNumber: subjectFromKey(d.size.subject), range: [Number(d.size.min), Number(d.size.max)], scale: d.size.scale };
  if (target === "element" && d.shape) set.shape = d.shape;
  if (d.label === "label" || d.label === "none") set.label = d.label;
  else if (d.label.startsWith("field:")) set.label = { field: d.label.slice(6) };
  if (d.hidden) set.hidden = d.hidden === "hide";
  if (d.opacity !== null && d.opacity !== undefined) set.opacity = Number(d.opacity);
  if (target === "element" && d.border) set.border = d.border.toLowerCase();
  if (target === "connection" && d.arrow) set.arrow = d.arrow;
  if (target === "connection" && d.curved) set.curved = d.curved === "yes";
  return set;
}

/**
 * Checks what cleanRule would clamp silently, so the editor can say so.
 * @param {DecorationState} d @param {Target} target @param {any} index
 * @returns {string|null}
 */
function decorationProblem(d, target, index) {
  const [lo, hi] = sizeBounds(target);
  const what = target === "element" ? "Size" : "Width";
  const inRange = (/** @type {unknown} */ v) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
  if (d.size.mode === "fixed" && !inRange(Number(d.size.value))) return `${what} must be a number from ${lo} to ${hi}`;
  if (d.size.mode === "number") {
    if (!inRange(Number(d.size.min)) || !inRange(Number(d.size.max))) return `${what} range must be numbers from ${lo} to ${hi}`;
    if (!d.size.subject) return `Choose what the ${what.toLowerCase()} follows`;
    if (subjectKind(d.size.subject, index) !== "number") return `${what} needs a number to follow`;
  }
  if (d.color.mode === "number" && subjectKind(d.color.subject, index) !== "number") return "Colour by number needs a number to follow";
  if (d.opacity !== null && d.opacity !== undefined && !(Number(d.opacity) >= 0 && Number(d.opacity) <= 1)) return "Opacity must be from 0 to 1";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

/** @param {Target} target @returns {RuleState} */
export function emptyRuleState(target = "element") {
  return { name: "", off: false, target, match: "all", conditions: [], deco: emptyDecorationState(target) };
}

/** @param {any} rule a cleaned rule @returns {RuleState} */
export function stateFromRule(rule) {
  const sel = stateFromSelector(rule.selector);
  return { name: rule.name ?? "", off: rule.off === true, target: sel.target, match: sel.match, conditions: sel.conditions, deco: stateFromDecoration(rule.set, sel.target) };
}

/**
 * Builds and validates a rule with cleanRule.
 * @param {RuleState} state @param {any} index
 * @returns {{value: any}|{error: string}}
 */
export function ruleFromState(state, index) {
  const selector = selectorFromState({ target: state.target, match: state.match, conditions: state.conditions }, index);
  if ("error" in selector) return selector;
  const problem = decorationProblem(state.deco, state.target, index);
  if (problem) return { error: problem };
  const set = decorationFromState(state.deco, state.target);
  if (!Object.keys(set).length) return { error: "Choose at least one thing for the rule to change" };
  return cleanRule({ name: state.name, off: state.off, selector: selector.value, set });
}

/**
 * Switches a rule's target: drops conditions and decoration choices that do not apply.
 * @param {RuleState} state @param {Target} target @param {any} index
 * @returns {RuleState}
 */
export function retarget(state, target, index) {
  if (state.target === target) return state;
  const valid = new Set(subjectOptions(target, index).map((o) => o.key));
  const fresh = emptyDecorationState(target);
  const d = structuredClone(state.deco);
  if (d.color.mode === "category" && !valid.has(d.color.subject)) d.color = { ...d.color, mode: "none" };
  if (d.color.mode === "number" && !valid.has(d.color.subject)) d.color = { ...d.color, mode: "none" };
  d.size = fresh.size;
  if (d.label.startsWith("field:") && !valid.has(d.label)) d.label = "";
  if (target === "connection") { d.shape = ""; d.border = ""; } else { d.arrow = ""; d.curved = ""; }
  return { ...state, target, conditions: state.conditions.filter((c) => valid.has(c.subject)), deco: d };
}

/** @param {number} n */
const num = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

/**
 * What a decoration does, in words: "Colour by Sector, size 4–16 by Influence".
 * @param {any} set a cleaned decoration @param {Target} target @param {any} index
 */
export function describeDecoration(set, target, index) {
  const parts = [];
  const name = (/** @type {any} */ s) => subjectLabel(subjectKey(s), index);
  if (set.color?.value) parts.push(`Colour ${set.color.value}`);
  else if (set.color?.byCategory) parts.push(`Colour by ${name(set.color.byCategory)}`);
  else if (set.color?.byNumber) parts.push(`Colour by ${name(set.color.byNumber)} (${set.color.range[0]} → ${set.color.range[1]})`);
  const s = target === "element" ? set.size : set.width;
  const what = target === "element" ? "Size" : "Width";
  if (s?.value !== undefined) parts.push(`${what} ${num(s.value)}`);
  else if (s?.byNumber) parts.push(`${what} ${num(s.range[0])}–${num(s.range[1])} by ${name(s.byNumber)}${s.scale && s.scale !== "linear" ? ` (${s.scale})` : ""}`);
  if (set.shape) parts.push(`Shape ${set.shape}`);
  if (set.label === "none") parts.push("No label");
  else if (set.label === "label") parts.push("Label shown");
  else if (set.label?.field) parts.push(`Label from ${index.fields.get(set.label.field)?.name ?? "a missing field"}`);
  if (set.hidden === true) parts.push("Hide");
  else if (set.hidden === false) parts.push("Show");
  if (set.opacity !== undefined) parts.push(`Opacity ${Math.round(set.opacity * 100)}%`);
  if (set.border) parts.push(`Border ${set.border}`);
  if (set.arrow === "none") parts.push("No arrows");
  else if (set.arrow === "auto") parts.push("Arrows");
  if (set.curved === true) parts.push("Curved");
  else if (set.curved === false) parts.push("Straight");
  return parts.length ? parts.join(", ") : "No changes";
}

/**
 * A rule's lines for the rule list.
 * @param {any} rule @param {any} index
 * @returns {{title: string, selector: string, effect: string}}
 */
export function describeRule(rule, index) {
  const effect = describeDecoration(rule.set, rule.selector.target, index);
  const selector = describeSelector(rule.selector, index);
  return { title: rule.name || effect, selector: selector.charAt(0).toUpperCase() + selector.slice(1), effect };
}

/**
 * Moves an item within a copy of a list.
 * @template T @param {T[]} list @param {number} from @param {number} to @returns {T[]}
 */
export function moveItem(list, from, to) {
  const out = [...list];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

/**
 * Replaces the rule a person edited with its new version. The view may have changed meanwhile (a
 * collaborator reordered or edited rules), so the original is found by content first, then by
 * position; a rule that vanished is appended.
 * @param {any[]} rules current rules @param {any|null} original the rule as the editor opened it (null: new)
 * @param {number} at its position then @param {any} next
 */
export function replaceRule(rules, original, at, next) {
  const out = [...rules];
  if (!original) { out.push(next); return out; }
  const key = JSON.stringify(original);
  let i = out.findIndex((r) => JSON.stringify(r) === key);
  if (i < 0 && at < out.length && !out.some((r) => JSON.stringify(r) === JSON.stringify(next))) i = at;
  if (i < 0) out.push(next);
  else out[i] = next;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Types, fields and usage
// ---------------------------------------------------------------------------------------------

/**
 * Items per type id. One pass over elements and connections.
 * @param {any} index @returns {Map<string, number>}
 */
export function typeUsage(index) {
  /** @type {Map<string, number>} */
  const use = new Map();
  for (const pool of [index.elements, index.connections]) {
    for (const o of pool.values()) if (o.typeId) use.set(o.typeId, (use.get(o.typeId) ?? 0) + 1);
  }
  return use;
}

/**
 * Items with a value per field id. One pass over elements and connections.
 * @param {any} index @returns {Map<string, number>}
 */
export function fieldUsage(index) {
  /** @type {Map<string, number>} */
  const use = new Map();
  for (const pool of [index.elements, index.connections]) {
    for (const o of pool.values()) {
      if (!o.fields) continue;
      for (const id in o.fields) use.set(id, (use.get(id) ?? 0) + 1);
    }
  }
  return use;
}

/**
 * Items holding each choice of a choice or multichoice field.
 * @param {string} fieldId @param {any} index @returns {Map<string, number>}
 */
export function choiceUsage(fieldId, index) {
  /** @type {Map<string, number>} */
  const use = new Map();
  for (const pool of [index.elements, index.connections]) {
    for (const o of pool.values()) {
      const v = o.fields?.[fieldId];
      if (v === undefined) continue;
      for (const x of Array.isArray(v) ? v : [v]) use.set(x, (use.get(x) ?? 0) + 1);
    }
  }
  return use;
}

/**
 * The choices a new list would drop although items still hold them (the server refuses these).
 * @param {any} field @param {string[]} nextChoices @param {any} index
 * @returns {{choice: string, count: number}[]}
 */
export function blockedChoiceRemovals(field, nextChoices, index) {
  const keep = new Set(nextChoices);
  const removed = (field.choices ?? []).filter((/** @type {string} */ c) => !keep.has(c));
  if (!removed.length) return [];
  const use = choiceUsage(field.id, index);
  return removed.filter((/** @type {string} */ c) => (use.get(c) ?? 0) > 0).map((/** @type {string} */ c) => ({ choice: c, count: /** @type {number} */ (use.get(c)) }));
}

/**
 * The first palette colour no type of this kind uses yet.
 * @param {any} index @param {Target} appliesTo
 */
export function nextTypeColor(index, appliesTo) {
  const used = new Set([...index.types.values()].filter((t) => t.appliesTo === appliesTo).map((t) => t.color));
  return PALETTE.find((c) => !used.has(c)) ?? PALETTE[index.types.size % PALETTE.length];
}

/** @param {number} n @param {string} one @param {string} [many] */
export const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

/**
 * Move ops that copy positions into a view's own layout, in chunks the server accepts.
 * @param {string} layout the view id
 * @param {Iterable<string>} ids element ids
 * @param {(id: string) => ({x: number, y: number, pin?: boolean}|undefined)} positionOf
 * @param {number} [chunk]
 * @returns {any[]} one move op per chunk
 */
export function copyLayoutMoves(layout, ids, positionOf, chunk = LIMITS.movesPerRequest) {
  const items = [];
  for (const id of ids) {
    const p = positionOf(id);
    if (!p) continue;
    items.push({ id, x: Math.round(p.x), y: Math.round(p.y), pin: p.pin === true });
  }
  const ops = [];
  for (let i = 0; i < items.length; i += chunk) ops.push({ op: "move", layout, items: items.slice(i, i + chunk) });
  return ops;
}

/**
 * A copy of a view's content under a new id and name (its own layout, if any, is copied separately).
 * @param {any} view @param {string} id @param {string} name @param {number} order
 */
export function duplicateView(view, id, name, order) {
  /** @type {Record<string, any>} */
  const out = { id, name, rules: structuredClone(view.rules ?? []), layout: { kind: view.layout?.kind ?? "force", own: view.layout?.own === true }, order };
  for (const k of ["filter", "showcase", "focus", "description"]) if (view[k] !== undefined && view[k] !== null) out[k] = structuredClone(view[k]);
  return out;
}

/** A readable name for "Copy of X" that fits the view name limit. @param {string} name */
export const copyName = (name) => `${name} copy`.slice(0, LIMITS.viewName);

export { SHAPES, SCALES, PALETTE };
