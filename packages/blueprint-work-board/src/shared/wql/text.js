// @ts-check
// WQL → canonical text (format) and → plain English (describe).

import { PRIORITIES } from "../model/work.js";
import { itemByKey, personName } from "../model/index.js";
import { quoteText, quoteValue } from "./fields.js";
import { cycleIds } from "./evaluate.js";

/**
 * @typedef {import("./parse.js").Node} Node
 * @typedef {import("./parse.js").Query} Query
 * @typedef {import("./parse.js").SortKey} SortKey
 * @typedef {import("./evaluate.js").WqlContext} WqlContext
 */

const OP_TEXT = { eq: "", lt: "<", lte: "<=", gt: ">", gte: ">=", range: "" };

/** Canonical text of one node. @param {Node} node @returns {string} */
export function formatNode(node) {
  switch (node.type) {
    case "term":
      return `${node.field}:${OP_TEXT[node.op]}${node.op === "range" ? node.values.join("..") : node.values.map(quoteValue).join(",")}`;
    case "is": case "has": return `${node.type}:${node.value}`;
    case "text": return quoteText(node.value);
    case "not": return node.child.type === "and" || node.child.type === "or" ? `-(${formatNode(node.child)})` : `-${formatNode(node.child)}`;
    case "and": return node.children.map((c) => (c.type === "or" ? `(${formatNode(c)})` : formatNode(c))).join(" ");
    case "or": return node.children.map(formatNode).join(" OR ");
  }
}

/** @param {SortKey[]} sort */
export function formatSort(sort) {
  return sort.length ? `sort:${sort.map((s) => (s.dir === "desc" ? "-" : "") + s.field).join(",")}` : "";
}

/** Canonical text of a query. @param {Query} ast */
export function format(ast) {
  return [ast?.where ? formatNode(ast.where) : "", formatSort(ast?.sort ?? [])].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------------------------
// describe

const HAS_NOUN = { assignee: "an assignee", label: "labels", estimate: "an estimate", due: "a due date", start: "a start date", parent: "a parent", project: "a project", cycle: "a cycle", description: "a description", priority: "a priority", key: "a key" };
const IS_TEXT = {
  blocked: "that are blocked", blocking: "that block other items", overdue: "that are overdue", archived: "that are archived",
  parent: "that have sub-issues", sub: "that are sub-issues", unassigned: "that are unassigned", unestimated: "without an estimate",
  stale: "that are stale (no update for 14 days)", open: "that are open", active: "that are active", done: "that are done",
};
const SORT_TEXT = {
  "updated:desc": "most recently updated", "updated:asc": "least recently updated", "created:desc": "newest first", "created:asc": "oldest first",
  "priority:asc": "priority", "priority:desc": "lowest priority first", "due:asc": "due date", "due:desc": "latest due date first",
};

/** @param {string[]} parts @param {string} [joiner] */
const list = (parts, joiner = "or") => (parts.length < 2 ? parts[0] ?? "" : `${parts.slice(0, -1).join(", ")} ${joiner} ${parts.at(-1)}`);

/** @param {string} v */
function dayText(v) {
  const l = v.toLowerCase();
  if (l === "today" || l === "yesterday" || l === "tomorrow") return l;
  const m = /^([+-]?)(\d+)([dwmy])$/.exec(l);
  if (!m) return v;
  const unit = { d: "day", w: "week", m: "month", y: "year" }[/** @type {"d"} */ (m[3])] + (m[2] === "1" ? "" : "s");
  return m[1] === "-" ? `${m[2]} ${unit} ago` : `in ${m[2]} ${unit}`;
}

/** A priority value as its name. @param {string} v */
const priorityName = (v) => PRIORITIES.find((p) => p.key === v.toLowerCase() || String(p.value) === v)?.name ?? v;

/** @param {import("./parse.js").TermNode} t @param {WqlContext|undefined} ctx */
function termText(t, ctx) {
  const idx = ctx?.index;
  const vals = t.values;
  const none = vals.length === 1 && vals[0].toLowerCase() === "none";
  const cmpWords = { lt: "less than", lte: "at most", gt: "more than", gte: "at least" };
  const ordinal = (/** @type {(v: string) => string} */ name) => {
    if (t.op === "range") return `between ${name(vals[0])} and ${name(vals[1])}`;
    if (t.op === "eq") return list(vals.map(name));
    return `${/** @type {any} */ (cmpWords)[t.op]} ${name(vals[0])}`;
  };
  switch (t.field) {
    case "status": return `with status ${list(vals.map(cap))}`;
    case "state": {
      const name = (/** @type {string} */ v) => idx?.states.find((s) => s.key.toLowerCase() === v.toLowerCase() || s.name.toLowerCase() === v.toLowerCase())?.name ?? v;
      return t.op === "eq" ? `in ${list(vals.map(name))}` : `in a state ${ordinal(name).replace("less than", "before").replace("more than", "after")}`;
    }
    case "kind": return `in a ${list(vals.map((v) => v.toLowerCase()))} state`;
    case "priority": {
      const w = { eq: () => `with priority ${list(vals.map(priorityName))}`, lt: () => `with priority higher than ${priorityName(vals[0])}`, lte: () => `with priority ${priorityName(vals[0])} or higher`,
        gt: () => `with priority lower than ${priorityName(vals[0])}`, gte: () => `with priority ${priorityName(vals[0])} or lower`, range: () => `with priority between ${priorityName(vals[0])} and ${priorityName(vals[1])}` };
      return w[t.op]();
    }
    case "assignee": case "created_by": case "updated_by": {
      const who = (/** @type {string} */ v) => {
        const l = v.toLowerCase();
        if (l === "me") return "you";
        if (l === "none") return "nobody";
        const found = idx ? [...idx.people.keys()].filter((a) => a.toLowerCase() === l || a.toLowerCase().includes(l) || personName(idx, a).toLowerCase().includes(l)) : [];
        return found.length === 1 && idx ? personName(idx, found[0]) : v;
      };
      if (t.field === "assignee") return none ? "that are unassigned" : `assigned to ${list(vals.map(who))}`;
      return `${t.field === "created_by" ? "created" : "last updated"} by ${list(vals.map(who))}`;
    }
    case "label": return none ? "with no labels" : `labelled ${list(vals)}`;
    case "estimate": return none ? "without an estimate" : `with estimate ${ordinal((v) => v)}`;
    case "due": case "start": case "created": case "updated": {
      const verb = { due: "due", start: "starting", created: "created", updated: "updated" }[t.field];
      if (none) return `with no ${t.field === "due" ? "due" : t.field} date`;
      const d = { eq: "on", lt: "before", lte: "on or before", gt: "after", gte: "on or after" };
      if (t.op === "range") return `${verb} between ${dayText(vals[0])} and ${dayText(vals[1])}`;
      if (t.op === "eq") return `${verb} ${vals.map((v) => (/^\d{4}/.test(v) ? `on ${v}` : dayText(v))).join(" or ")}`;
      return `${verb} ${/** @type {any} */ (d)[t.op]} ${dayText(vals[0])}`;
    }
    case "parent": return none ? "without a parent" : `sub-issues of ${list(vals.map((v) => (idx ? itemByKey(idx, v)?.key ?? v : v)))}`;
    case "project": return none ? "not in a project" : `in project ${list(vals.map((v) => idx?.projects.find((p) => p.id === v || p.name.toLowerCase() === v.toLowerCase())?.name ?? v))}`;
    case "cycle": {
      if (none) return "not in a cycle";
      const name = (/** @type {string} */ v) => {
        const l = v.toLowerCase();
        if (l === "current" || l === "next" || l === "previous") {
          const found = ctx ? cycleIds(ctx, l) : null;
          const c = found?.length ? idx?.cycleById.get(found[0]) : null;
          return `the ${l} cycle${c ? ` (${c.name})` : ""}`;
        }
        return `cycle ${idx?.cycles.find((c) => c.id === v || c.name.toLowerCase() === l || String(c.number) === v)?.name ?? v}`;
      };
      return `in ${list(vals.map(name))}`;
    }
    case "key": return t.op === "range" ? `with keys ${vals[0]} to ${vals[1]}` : `with key ${ordinal((v) => v)}`;
    case "text": return `mentioning ${list(vals.map((v) => `“${v}”`))}`;
    case "title": return `with ${list(vals.map((v) => `“${v}”`))} in the title`;
    case "description": return `with ${list(vals.map((v) => `“${v}”`))} in the description`;
    case "archived": return ["true", "yes", "1"].includes(vals[0]?.toLowerCase()) ? "that are archived" : "that are not archived";
  }
  return `with ${t.field} ${t.op === "eq" ? `equal to ${list(vals)}` : ordinal((v) => v)}`;
}

/** @param {string} s */
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s; }

/** @param {Node} node @param {WqlContext|undefined} ctx @returns {string} */
function phrase(node, ctx) {
  switch (node.type) {
    case "term": return termText(node, ctx);
    case "is": return /** @type {any} */ (IS_TEXT)[node.value] ?? `that are ${node.value}`;
    case "has": return `with ${/** @type {any} */ (HAS_NOUN)[node.value] ?? `a value for ${node.value}`}`;
    case "text": return `mentioning “${node.value}”`;
    case "and": return node.children.map((c) => phrase(c, ctx)).join(", ");
    case "or": return `either ${node.children.map((c) => (c.type === "and" ? `(${phrase(c, ctx)})` : phrase(c, ctx))).join(" or ")}`;
    case "not": {
      const p = phrase(node.child, ctx);
      if (node.child.type === "and" || node.child.type === "or") return `not (${p})`;
      if (p.startsWith("with ")) return `without ${p.slice(5)}`;
      if (p.startsWith("without ")) return `with ${p.slice(8)}`;
      if (p.startsWith("that are not ")) return `that are ${p.slice(13)}`;
      if (p.startsWith("that are ")) return `that are not ${p.slice(9)}`;
      if (p.startsWith("that have ")) return `that do not have ${p.slice(10)}`;
      if (p.startsWith("that ")) return `that do not ${p.slice(5)}`;
      return `not ${p}`;
    }
  }
}

/** @param {SortKey} s */
function sortText(s) {
  const known = /** @type {any} */ (SORT_TEXT)[`${s.field}:${s.dir}`];
  if (known) return known;
  const name = s.field === "key" ? "key" : s.field;
  return s.dir === "desc" ? `${name} (descending)` : name;
}

/**
 * Plain English for screen readers and the agent.
 * @param {Query} ast @param {WqlContext} [ctx]
 */
export function describe(ast, ctx) {
  const where = ast?.where ? phrase(ast.where, ctx) : "";
  const sort = ast?.sort?.length ? `sorted by ${ast.sort.map(sortText).join(", then ")}` : "";
  if (!where) return sort ? `All items, ${sort}.` : "All items";
  return `Items ${where}${sort ? `, ${sort}` : ""}.`;
}
