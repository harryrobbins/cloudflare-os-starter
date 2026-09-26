// @ts-check
// WQL evaluation: compile an AST once into a predicate over ItemViews, validate values against the
// data (check), and sort.
//
// Priority comparisons use URGENCY RANK (urgent 1, high 2, medium 3, low 4, none 5): `<` means
// "more urgent than" and `<=` "at least as urgent as", so `priority:<=high` (or `priority:<=2`) is
// urgent or high, and `priority:>=medium` is medium, low or none.
// Dates compare by day. Relative dates count from the context's `today`: `-7d` is seven days ago,
// `7d`/`+7d` seven days ahead (units d, w, m = 30 days, y = 365 days), so `due:<7d` is everything due
// before a week from today, overdue items included. Items without a value never match a comparison.

import { addDays, CATEGORIES, KINDS, PRIORITIES, localDay } from "../model/work.js";
import { itemByKey, personName } from "../model/index.js";
import { closest, didYouMean, fieldByName } from "./fields.js";
import { parse } from "./parse.js";

/**
 * @typedef {import("./parse.js").Node} Node
 * @typedef {import("./parse.js").Query} Query
 * @typedef {import("./parse.js").SortKey} SortKey
 * @typedef {import("./parse.js").WqlError} WqlError
 * @typedef {import("../model/index.js").ItemView} ItemView
 * @typedef {import("../model/index.js").WorkIndex} WorkIndex
 * @typedef {{ index: WorkIndex, viewer: string|null, now: number, today: string }} WqlContext
 * @typedef {(item: ItemView) => boolean} Predicate
 */

const DAY = 86_400_000;
const STALE_DAYS = 14;
const UNITS = { d: 1, w: 7, m: 30, y: 365 };

/** Resolves a date value to YYYY-MM-DD, or null. @param {string} value @param {string} today */
export function resolveDay(value, today) {
  const v = value.toLowerCase();
  if (v === "today") return today;
  if (v === "yesterday") return addDays(today, -1);
  if (v === "tomorrow") return addDays(today, 1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? null : v;
  const rel = /^([+-]?)(\d{1,4})([dwmy])$/.exec(v);
  if (rel) return addDays(today, (rel[1] === "-" ? -1 : 1) * Number(rel[2]) * UNITS[/** @type {"d"} */ (rel[3])]);
  return null;
}

/** @param {string} value @returns {number|null} urgency rank */
function priorityRank(value) {
  const v = value.toLowerCase();
  const p = PRIORITIES.find((x) => x.key === v || String(x.value) === v || (v === "no" && x.value === 0));
  return p ? p.rank : null;
}

/** @param {string} value */
function keyNumber(value) {
  const m = /^(?:[A-Za-z][A-Za-z0-9]*-)?(\d+)$/.exec(value.trim());
  return m ? Number(m[1]) : null;
}

const isNone = (/** @type {string} */ v) => v.toLowerCase() === "none";
const numeric = (/** @type {unknown} */ v) => typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null;

/** @param {WqlContext} ctx @param {string} value @returns {Set<string>|null} matching state keys */
function stateKeys(ctx, value) {
  const v = value.toLowerCase();
  const keys = ctx.index.states.filter((s) => s.key.toLowerCase() === v || s.name.toLowerCase() === v).map((s) => s.key);
  return keys.length ? new Set(keys) : null;
}

/** @param {WqlContext} ctx @param {string} value @returns {string[]|null} cycle ids */
export function cycleIds(ctx, value) {
  const v = value.toLowerCase();
  const cycles = ctx.index.cycles;
  const t = ctx.today;
  if (v === "current") return cycles.filter((c) => c.start && c.end && c.start <= t && t <= c.end).map((c) => c.id);
  if (v === "next") { const cy = cycles.find((c) => c.start && c.start > t); return cy ? [cy.id] : []; }
  if (v === "previous") { const cy = cycles.filter((c) => c.end && c.end < t).at(-1); return cy ? [cy.id] : []; }
  const found = cycles.filter((c) => c.id === v || c.name.toLowerCase() === v || (c.number !== null && String(c.number) === v));
  return found.length ? found.map((c) => c.id) : null;
}

/** @param {WqlContext} ctx @param {string} value @returns {string[]|null} project ids */
function projectIds(ctx, value) {
  const v = value.toLowerCase();
  const found = ctx.index.projects.filter((p) => p.id === v || p.name.toLowerCase() === v);
  return found.length ? found.map((p) => p.id) : null;
}

/** The comparable value and value converter of an ordered field. @param {string} field @param {string} type @param {WqlContext} ctx */
function ordered(field, type, ctx) {
  /** @type {(item: ItemView) => number|string|null} */
  let get;
  /** @type {(value: string) => number|string|null} */
  let conv;
  const idx = ctx.index;
  switch (field === "priority" ? "priority" : field === "status" ? "status" : type) {
    case "priority": get = (i) => PRIORITIES[i.priority].rank; conv = priorityRank; break;
    case "status": get = (i) => CATEGORIES.indexOf(i.category); conv = (v) => { const n = CATEGORIES.indexOf(/** @type {any} */ (v.toLowerCase())); return n < 0 ? null : n; }; break;
    case "kind": get = (i) => KINDS.indexOf(/** @type {any} */ (i.kind)); conv = (v) => { const n = KINDS.indexOf(/** @type {any} */ (v.toLowerCase())); return n < 0 ? null : n; }; break;
    case "state": {
      const pos = new Map(idx.states.map((s, n) => [s.key, n]));
      get = (i) => pos.get(i.state) ?? null;
      conv = (v) => { const keys = stateKeys(ctx, v); return keys ? /** @type {number} */ (pos.get([...keys][0])) : null; };
      break;
    }
    case "number": get = (i) => i.estimate; conv = numeric; break;
    case "key": get = (i) => i.number; conv = keyNumber; break;
    case "date": get = (i) => (field === "due" ? i.due : i.start); conv = (v) => resolveDay(v, ctx.today); break;
    case "instant": {
      const cache = new Map();
      get = (i) => {
        const ms = field === "created" ? i.created : i.updated;
        if (ms === null) return null;
        let day = cache.get(ms);
        if (day === undefined) cache.set(ms, day = localDay(new Date(ms)));
        return day;
      };
      conv = (v) => resolveDay(v, ctx.today);
      break;
    }
    default: return null;
  }
  return { get, conv };
}

/** An absent extension value. @param {any} x */
const isEmptyValue = (x) => x === undefined || x === null || x === "" || (Array.isArray(x) && !x.length);

/** @param {import("./parse.js").TermNode} t @param {WqlContext} ctx @returns {Predicate} */
function compileTerm(t, ctx) {
  const field = fieldByName(t.field);
  if (!field) return () => false;
  const values = t.values;
  const none = values.some(isNone);
  const lower = values.map((v) => v.toLowerCase());
  const idx = ctx.index;

  if (field.type === "ext") {
    const name = t.field.slice(4);
    const read = (/** @type {ItemView} */ i) => /** @type {any} */ (i.ext)[name];
    const cmp = (/** @type {any} */ a, /** @type {string} */ b) => {
      const na = numeric(a), nb = numeric(b);
      if (na !== null && nb !== null) return na - nb;
      return String(a).toLowerCase().localeCompare(b.toLowerCase());
    };
    if (t.op === "eq") return (i) => { const x = read(i); if (isEmptyValue(x)) return none; return (Array.isArray(x) ? x : [x]).some((e) => values.some((v) => !isNone(v) && cmp(e, v) === 0)); };
    return rangeOp(t, (i) => { const x = read(i); return isEmptyValue(x) || Array.isArray(x) || typeof x === "object" ? null : x; }, (v) => v, cmp);
  }

  const ord = ordered(t.field, field.type, ctx);
  if (ord) {
    if (t.field === "key" && t.op === "eq") {
      const nums = new Set(values.map(keyNumber).filter((n) => n !== null));
      const ids = lower.filter((v) => v.startsWith("#")).map((v) => v.slice(1));
      return (i) => (i.number !== null && nums.has(i.number)) || ids.some((p) => p && i.id.startsWith(p)) || (none && i.number === null);
    }
    if (t.op === "eq") {
      if (t.field === "state") {
        const keys = new Set(values.flatMap((v) => [...(stateKeys(ctx, v) ?? [])]));
        return (i) => keys.has(i.state);
      }
      const targets = new Set(values.map(ord.conv).filter((v) => v !== null));
      return (i) => { const x = ord.get(i); return x === null ? none : targets.has(x); };
    }
    return rangeOp(t, ord.get, ord.conv, (a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  switch (field.type) {
    case "person": {
      const key = t.field === "assignee" ? "assignee" : t.field;
      const cache = new Map();
      const matches = (/** @type {string} */ actor) => {
        let hit = cache.get(actor);
        if (hit === undefined) {
          const a = actor.toLowerCase(), name = personName(idx, actor).toLowerCase();
          hit = lower.some((v) => (v === "me" ? actor === ctx.viewer : !isNone(v) && (a === v || a.includes(v) || name.includes(v))));
          cache.set(actor, hit);
        }
        return hit;
      };
      return (i) => { const actor = /** @type {string|null} */ (/** @type {any} */ (i)[key]); return actor ? matches(actor) : none; };
    }
    case "labels": {
      const wanted = new Set();
      for (const v of lower) {
        if (v === "none") continue;
        wanted.add(v);
        for (const l of idx.labels) if (l.name.toLowerCase() === v) wanted.add(l.key.toLowerCase());
      }
      return (i) => (i.labels.length ? i.labels.some((l) => wanted.has(l.toLowerCase())) : none);
    }
    case "text": {
      const get = t.field === "title" ? (/** @type {ItemView} */ i) => i.title : t.field === "description" ? (/** @type {ItemView} */ i) => i.description
        : t.field === "rank" ? (/** @type {ItemView} */ i) => i.rank : (/** @type {ItemView} */ i) => `${i.title}\n${i.description}`;
      return (i) => { const s = get(i).toLowerCase(); return lower.some((v) => s.includes(v)); };
    }
    case "ref-item": {
      const ids = new Set(values.map((v) => itemByKey(idx, v)?.id).filter(Boolean));
      return (i) => (i.parent ? ids.has(i.parent) : none);
    }
    case "project": {
      const ids = new Set(values.flatMap((v) => projectIds(ctx, v) ?? []));
      return (i) => (i.project ? ids.has(i.project) : none);
    }
    case "cycle": {
      const ids = new Set(values.flatMap((v) => cycleIds(ctx, v) ?? []));
      return (i) => (i.cycle ? ids.has(i.cycle) : none);
    }
    case "bool": {
      const want = new Set(lower.map((v) => (["true", "yes", "1"].includes(v) ? true : ["false", "no", "0"].includes(v) ? false : null)));
      return (i) => want.has(i.archived);
    }
  }
  return () => false;
}

/**
 * @param {import("./parse.js").TermNode} t
 * @param {(item: ItemView) => any} get @param {(value: string) => any} conv
 * @param {(a: any, b: any) => number} cmp
 * @returns {Predicate}
 */
function rangeOp(t, get, conv, cmp) {
  const a = conv(t.values[0]);
  if (a === null || a === undefined) return () => false;
  if (t.op === "range") {
    const b = conv(t.values[1]);
    if (b === null || b === undefined) return () => false;
    const [lo, hi] = cmp(a, b) <= 0 ? [a, b] : [b, a];
    return (i) => { const x = get(i); return x !== null && cmp(x, lo) >= 0 && cmp(x, hi) <= 0; };
  }
  const test = { lt: (/** @type {number} */ c) => c < 0, lte: (/** @type {number} */ c) => c <= 0, gt: (/** @type {number} */ c) => c > 0, gte: (/** @type {number} */ c) => c >= 0, eq: (/** @type {number} */ c) => c === 0 }[t.op];
  return (i) => { const x = get(i); return x !== null && test(cmp(x, a)); };
}

/** @param {string} name @param {WqlContext} ctx @returns {Predicate} */
function compilePredicate(name, ctx) {
  const idx = ctx.index;
  switch (name) {
    case "blocked": return (i) => (idx.blockedBy.get(i.id)?.length ?? 0) > 0;
    case "blocking": return (i) => (idx.blocking.get(i.id)?.length ?? 0) > 0;
    case "overdue": return (i) => i.due !== null && i.due < ctx.today && i.category !== "done";
    case "archived": return (i) => i.archived;
    case "parent": return (i) => (idx.children.get(i.id)?.length ?? 0) > 0;
    case "sub": return (i) => i.parent !== null;
    case "unassigned": return (i) => !i.assignee;
    case "unestimated": return (i) => i.estimate === null;
    case "stale": { const limit = ctx.now - STALE_DAYS * DAY; return (i) => i.updated !== null && i.updated < limit && i.category !== "done"; }
    case "open": case "active": case "done": return (i) => i.category === name;
  }
  return () => false;
}

/** @param {string} field @returns {Predicate} */
function compileHas(field) {
  if (field.startsWith("ext.")) {
    const name = field.slice(4);
    return (i) => { const x = /** @type {any} */ (i.ext)[name]; return x !== undefined && x !== null && x !== "" && !(Array.isArray(x) && !x.length); };
  }
  switch (field) {
    case "label": return (i) => i.labels.length > 0;
    case "priority": return (i) => i.priority !== 0;
    case "key": return (i) => i.number !== null;
    case "archived": return (i) => i.archived;
    case "text": return (i) => Boolean(i.title || i.description);
    case "status": case "state": case "kind": return () => true;
  }
  return (i) => { const x = /** @type {any} */ (i)[field]; return x !== null && x !== undefined && x !== ""; };
}

/** @param {Node} node @param {WqlContext} ctx @returns {Predicate} */
function compileNode(node, ctx) {
  switch (node.type) {
    case "and": { const fs = node.children.map((c) => compileNode(c, ctx)); return (i) => fs.every((f) => f(i)); }
    case "or": { const fs = node.children.map((c) => compileNode(c, ctx)); return (i) => fs.some((f) => f(i)); }
    case "not": { const f = compileNode(node.child, ctx); return (i) => !f(i); }
    case "term": return compileTerm(node, ctx);
    case "is": return compilePredicate(node.value, ctx);
    case "has": return compileHas(node.value);
    case "text": { const v = node.value.toLowerCase(); return (i) => i.title.toLowerCase().includes(v) || i.description.toLowerCase().includes(v); }
  }
}

/** @param {Query} ast @param {WqlContext} ctx @returns {Predicate} */
export function compile(ast, ctx) {
  return ast?.where ? compileNode(ast.where, ctx) : () => true;
}

/** @param {Query} ast @param {ItemView} item @param {WqlContext} ctx */
export function evaluate(ast, item, ctx) { return compile(ast, ctx)(item); }

/** @param {string} field @param {WqlContext} ctx @returns {(item: ItemView) => any} value or null (nulls sort last) */
function sortValue(field, ctx) {
  const idx = ctx.index;
  if (field.startsWith("ext.")) { const n = field.slice(4); return (i) => { const x = /** @type {any} */ (i.ext)[n]; return x === undefined || x === "" ? null : x; }; }
  switch (field) {
    case "priority": return (i) => (i.priority === 0 ? null : PRIORITIES[i.priority].rank);
    case "updated": return (i) => i.updated;
    case "created": return (i) => i.created;
    case "due": return (i) => i.due;
    case "start": return (i) => i.start;
    case "estimate": return (i) => i.estimate;
    case "key": return (i) => i.number;
    case "title": return (i) => i.title.toLowerCase();
    case "state": { const pos = new Map(idx.states.map((s, n) => [s.key, n])); return (i) => pos.get(i.state) ?? null; }
    case "rank": return (i) => i.rank || null;
    case "assignee": return (i) => (i.assignee ? personName(idx, i.assignee).toLowerCase() : null);
    case "project": return (i) => (i.project ? idx.projectById.get(i.project)?.name.toLowerCase() ?? null : null);
    case "cycle": return (i) => (i.cycle ? idx.cycleById.get(i.cycle)?.start ?? idx.cycleById.get(i.cycle)?.name ?? null : null);
  }
  return () => null;
}

/** @type {SortKey[]} */
export const DEFAULT_SORT = [{ field: "priority", dir: "asc" }, { field: "updated", dir: "desc" }, { field: "key", dir: "desc" }];

/** @param {SortKey[]} sort @param {WqlContext} ctx @returns {(a: ItemView, b: ItemView) => number} */
export function compare(sort, ctx) {
  const keys = (sort?.length ? sort : DEFAULT_SORT).map((s) => ({ get: sortValue(s.field, ctx), sign: s.dir === "desc" ? -1 : 1 }));
  return (a, b) => {
    for (const { get, sign } of keys) {
      const x = get(a), y = get(b);
      if (x === y) continue;
      if (x === null) return 1;
      if (y === null) return -1;
      const c = typeof x === "string" && typeof y === "string" ? x.localeCompare(y) : x < y ? -1 : x > y ? 1 : 0;
      if (c) return c * sign;
    }
    return (b.number ?? 0) - (a.number ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  };
}

/** Whether the query mentions archived items (otherwise they are hidden). @param {Node|null} node @returns {boolean} */
export function mentionsArchived(node) {
  if (!node) return false;
  switch (node.type) {
    case "and": case "or": return node.children.some(mentionsArchived);
    case "not": return mentionsArchived(node.child);
    case "term": return node.field === "archived";
    case "is": case "has": return node.value === "archived";
    default: return false;
  }
}

/**
 * Filters and sorts items. Archived items are left out unless the query mentions archived.
 * @param {Query|string} query @param {WqlContext} ctx @param {ItemView[]} [items]
 */
export function run(query, ctx, items = ctx.index.itemList) {
  const ast = typeof query === "string" ? parse(query).ast : query;
  const pred = compile(ast, ctx);
  const archived = mentionsArchived(ast.where);
  const out = items.filter((i) => (archived || !i.archived) && pred(i));
  return out.toSorted(compare(ast.sort, ctx));
}

/**
 * Validates term values against the data, with suggestions. Labels and people are free text.
 * @param {Query} ast @param {WqlContext} ctx @returns {WqlError[]}
 */
export function check(ast, ctx) {
  /** @type {WqlError[]} */
  const errors = [];
  const idx = ctx.index;
  const bad = (/** @type {import("./parse.js").TermNode} */ t, /** @type {string} */ what, /** @type {string} */ v, /** @type {string[]} */ candidates) => {
    const s = closest(v, candidates);
    errors.push({ message: didYouMean(`Unknown ${what} “${v}”.`, s), start: t.span[0], end: t.span[1], suggestions: s });
  };
  /** @param {Node|null} node */
  const walk = (node) => {
    if (!node) return;
    if (node.type === "and" || node.type === "or") { node.children.forEach(walk); return; }
    if (node.type === "not") { walk(node.child); return; }
    if (node.type !== "term") return;
    const field = fieldByName(node.field);
    for (const v of node.values) {
      if (isNone(v) && node.op === "eq") continue;
      switch (field?.type === "enum" ? node.field : field?.type) {
        case "priority": if (priorityRank(v) === null) bad(node, "priority", v, PRIORITIES.map((p) => p.key)); break;
        case "status": if (!CATEGORIES.includes(/** @type {any} */ (v.toLowerCase()))) bad(node, "status", v, [...CATEGORIES]); break;
        case "kind": if (!KINDS.includes(/** @type {any} */ (v.toLowerCase()))) bad(node, "state kind", v, [...KINDS]); break;
        case "state": if (!stateKeys(ctx, v)) bad(node, "state", v, idx.states.flatMap((s) => [s.name, s.key])); break;
        case "project": if (!projectIds(ctx, v)) bad(node, "project", v, idx.projects.map((p) => p.name)); break;
        case "cycle": if (!cycleIds(ctx, v)) bad(node, "cycle", v, ["current", "next", "previous", ...idx.cycles.map((c) => c.name)]); break;
        case "date": case "instant": if (resolveDay(v, ctx.today) === null) errors.push({ message: `“${v}” is not a date. Use 2026-09-30, today, -7d or 7d.`, start: node.span[0], end: node.span[1], suggestions: [] }); break;
        case "number": if (numeric(v) === null) errors.push({ message: `“${v}” is not a number.`, start: node.span[0], end: node.span[1], suggestions: [] }); break;
        case "key": if (keyNumber(v) === null && !v.startsWith("#")) errors.push({ message: `“${v}” is not an item key like ${idx.keyPrefix}-12.`, start: node.span[0], end: node.span[1], suggestions: [] }); break;
        case "ref-item": if (!itemByKey(idx, v)) errors.push({ message: `No item “${v}”.`, start: node.span[0], end: node.span[1], suggestions: [] }); break;
        case "bool": if (!["true", "false", "yes", "no", "1", "0"].includes(v.toLowerCase())) bad(node, "value", v, ["true", "false"]); break;
      }
    }
  };
  walk(ast?.where ?? null);
  return errors;
}
