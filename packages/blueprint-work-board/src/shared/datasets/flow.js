// @ts-check
// Flow datasets, folded from per-item timelines (timeline.js): transitions, cumulative flow,
// cycle burndown and burnup, throughput, cycle time, created vs resolved, plus workload (current
// state) and the dependency graph. Every day is a UTC date; "at the end of day D" is just before
// D+1 00:00Z (for today: now).

import { registerDataset, invalid } from "./registry.js";
import { DAY_MS, at, dayEnd, dayRange, dayStart, percentile, plusDays, round, stateChanges, timelines, utcDay, weekOf } from "./timeline.js";
import { KINDS, KIND_LABELS, daysBetween } from "../model/work.js";
import { personName } from "../model/index.js";

/**
 * @typedef {import("./registry.js").DatasetContext} DatasetContext
 * @typedef {import("./timeline.js").Timeline} Timeline
 * @typedef {import("./timeline.js").Point} Point
 * @typedef {import("../model/index.js").ItemView} ItemView
 * @typedef {import("../model/index.js").WorkIndex} WorkIndex
 * @typedef {import("../model/index.js").CycleView} CycleView
 */

// ------------------------------------------------------------------------------------------------
// Parameters

/** @param {DatasetContext} ctx */
const utcToday = (ctx) => utcDay(ctx.now);

/** @param {unknown} v @param {string} name @param {number} dflt @param {number} min @param {number} max */
function intParam(v, name, dflt, min, max) {
  if (v === undefined || v === null || v === "") return dflt;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw invalid(`${name} must be a whole number from ${min} to ${max}.`);
  return n;
}
/** @param {unknown} v */
function unitParam(v) {
  if (v === undefined || v === null || v === "") return "auto";
  if (v !== "points" && v !== "count" && v !== "auto") throw invalid("unit is points, count or auto.");
  return v;
}
/** @param {unknown} v @param {string} name */
function dayParam(v, name) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(dayStart(v))) throw invalid(`${name} is a date like 2026-09-30.`);
  return v;
}

/**
 * A cycle by name, number, id or `current` (containing today, else the latest started),
 * `previous` or `next` (relative to today, UTC).
 * @param {WorkIndex} index @param {unknown} value @param {string} today
 * @returns {CycleView}
 */
export function findCycle(index, value, today) {
  const cycles = index.cycles.filter((c) => c.start && c.end);
  const names = () => (cycles.length ? ` Cycles: ${cycles.map((c) => c.name).join(", ")}.` : " This datastore has no cycles with dates.");
  const v = value === undefined || value === null || value === "" ? "current" : String(value).trim().toLowerCase();
  /** @type {CycleView|undefined} */
  let found;
  const current = cycles.find((c) => /** @type {string} */ (c.start) <= today && today <= /** @type {string} */ (c.end));
  if (v === "current") found = current ?? cycles.filter((c) => /** @type {string} */ (c.start) <= today).at(-1);
  else if (v === "previous") found = cycles.filter((c) => /** @type {string} */ (c.end) < (current?.start ?? today)).at(-1);
  else if (v === "next") found = cycles.find((c) => /** @type {string} */ (c.start) > today);
  else found = cycles.find((c) => c.name.toLowerCase() === v || String(c.number) === v || c.id === v || c.name.toLowerCase() === `cycle ${v}`);
  if (!found) throw invalid(`No cycle matches “${value ?? "current"}”.${names()}`);
  return found;
}

/** @param {WorkIndex} index @param {unknown} value */
function findProject(index, value) {
  const v = String(value ?? "").trim().toLowerCase();
  const found = index.projects.find((p) => p.name.toLowerCase() === v || p.id === v);
  if (!found) throw invalid(`No project matches “${value ?? ""}”. Projects: ${index.projects.map((p) => p.name).join(", ") || "none"}.`);
  return found;
}

/** Points when at least half the items carry an estimate, else counts. @param {string} unit @param {Timeline[]} list */
function chooseUnit(unit, list) {
  if (unit !== "auto") return unit;
  if (!list.length) return "count";
  const estimated = list.filter((tl) => tl.item.estimate !== null || tl.points.some((p) => p.estimate !== null)).length;
  return estimated * 2 >= list.length ? "points" : "count";
}
/** @param {string} unit @param {Point} p */
const weight = (unit, p) => (unit === "points" ? p.estimate ?? 0 : 1);
/** @param {string} unit @param {number} n */
const unitWord = (unit, n) => (unit === "points" ? (n === 1 ? "point" : "points") : n === 1 ? "item" : "items");
/** @param {number} n */
const num = (n) => (Number.isInteger(n) ? n.toLocaleString("en") : round(n, 1).toLocaleString("en"));

/** The instant at which "end of day" is read: the day's end, or now for today. @param {string} day @param {number} now */
const readAt = (day, now) => Math.min(dayEnd(day), now + 1);

/** @param {DatasetContext} ctx @param {ItemView[]} items */
function listFor(ctx, items) {
  const all = timelines(ctx.index, ctx.history, ctx.historyVersion ?? 0);
  return items.map((i) => all.get(i.id)).filter(/** @returns {t is Timeline} */ (t) => Boolean(t));
}

/** Kinds used by this datastore's workflow, in Linear's order. @param {WorkIndex} index */
function kindsOf(index) {
  const used = new Set(index.states.map((s) => s.kind));
  return KINDS.filter((k) => used.has(k));
}

/** @param {WorkIndex} index @param {string} key */
const stateName = (index, key) => index.stateByKey.get(key)?.name ?? key;
/** @param {number} t */
const iso = (t) => new Date(t).toISOString();

// ------------------------------------------------------------------------------------------------
// transitions

registerDataset({
  name: "transitions",
  title: "State transitions",
  history: true,
  description: "Every change of workflow state from the journal, oldest first, including the state each item was created in (from_state null).",
  params: { days: "Only changes in the last N days (UTC), 1–3650; default all" },
  columns: [
    { name: "key", type: "string", description: "Item key" },
    { name: "title", type: "string", description: "Item title" },
    { name: "from_state", type: "string", description: "State before, or null when the item was created" },
    { name: "from_kind", type: "string", description: "Kind before, or null" },
    { name: "to_state", type: "string", description: "State after" },
    { name: "to_kind", type: "string", description: "Kind after: triage, backlog, unstarted, started, completed, canceled" },
    { name: "actor", type: "string", description: "Who made the change (display name)" },
    { name: "at", type: "instant", description: "When (ISO 8601 UTC)" },
    { name: "day", type: "date", description: "The UTC day of the change" },
  ],
  resolve: (p) => ({ days: intParam(p.days, "days", 0, 0, 3650) }),
  rows: (ctx, items, p) => {
    const since = p.days ? dayStart(plusDays(utcToday(ctx), -(p.days - 1))) : -Infinity;
    /** @type {Record<string, any>[]} */
    const rows = [];
    for (const tl of listFor(ctx, items)) {
      for (const { from, to } of stateChanges(tl.points)) {
        if (to.t < since) continue;
        rows.push({
          key: tl.item.key, title: tl.item.title, from_state: from ? stateName(ctx.index, from.state) : null, from_kind: from?.kind ?? null,
          to_state: stateName(ctx.index, to.state), to_kind: to.kind, actor: to.actor ? personName(ctx.index, to.actor) : null,
          at: iso(to.t), day: utcDay(to.t), _t: to.t,
        });
      }
    }
    const sorted = rows.toSorted((a, b) => a._t - b._t);
    for (const r of sorted) delete r._t;
    return sorted;
  },
  summary: (rows, _ctx, p) => {
    const moves = rows.filter((r) => r.from_state !== null);
    if (!rows.length) return "No state changes in this period.";
    const people = new Set(moves.map((r) => r.actor).filter(Boolean)).size;
    /** @type {Map<string, number>} */
    const pairs = new Map();
    for (const r of moves) pairs.set(`${r.from_state} → ${r.to_state}`, (pairs.get(`${r.from_state} → ${r.to_state}`) ?? 0) + 1);
    const top = [...pairs].toSorted((a, b) => b[1] - a[1])[0];
    return `${num(moves.length)} state changes by ${people} ${people === 1 ? "person" : "people"}${p.days ? ` in the last ${p.days} days` : ""}, plus ${num(rows.length - moves.length)} items created${top ? `; most common: ${top[0]} (${top[1]})` : ""}.`;
  },
});

// ------------------------------------------------------------------------------------------------
// daily_state_counts (cumulative flow)

registerDataset({
  name: "daily_state_counts",
  title: "Items per state kind per day",
  history: true,
  description: "For each UTC day, how many of the matching items were in each state kind at the end of that day (today: now). Stacked, it is a cumulative flow diagram.",
  params: { days: "How many days, 1–365; default 30", end: "The last day (YYYY-MM-DD, UTC); default today" },
  columns: [
    { name: "day", type: "date", description: "UTC day" },
    { name: "kind", type: "string", description: "State kind" },
    { name: "kind_label", type: "string", description: "Kind as shown: Triage, Backlog, Unstarted, Started, Completed, Canceled" },
    { name: "order", type: "number", description: "Kind order, 0 = triage … 5 = canceled (for stacking)" },
    { name: "count", type: "number", description: "Items in that kind at the end of the day" },
    { name: "points", type: "number", description: "Sum of their estimates at the time" },
  ],
  resolve: (p, ctx) => ({ days: intParam(p.days, "days", 30, 1, 365), end: dayParam(p.end, "end") ?? utcToday(ctx) }),
  rows: (ctx, items, p) => {
    const days = dayRange(plusDays(p.end, -(p.days - 1)), p.end);
    const kinds = kindsOf(ctx.index);
    const list = listFor(ctx, items);
    /** @type {Record<string, any>[]} */
    const rows = [];
    for (const day of days) {
      const t = readAt(day, ctx.now);
      /** @type {Map<string, { count: number, points: number }>} */
      const acc = new Map(kinds.map((k) => [k, { count: 0, points: 0 }]));
      if (dayStart(day) <= ctx.now) {
        for (const tl of list) {
          const pt = at(tl.points, t);
          if (!pt || pt.archived) continue;
          const a = acc.get(pt.kind);
          if (a) { a.count++; a.points += pt.estimate ?? 0; }
        }
      }
      for (const k of kinds) {
        const a = /** @type {{ count: number, points: number }} */ (acc.get(k));
        rows.push({ day, kind: k, kind_label: /** @type {any} */ (KIND_LABELS)[k], order: KINDS.indexOf(k), count: a.count, points: round(a.points, 1) });
      }
    }
    return rows;
  },
  summary: (rows, _ctx, p) => {
    if (!rows.length) return "No days to show.";
    const first = rows[0].day, last = rows.at(-1)?.day;
    const get = (/** @type {string} */ day, /** @type {string} */ kind) => rows.find((r) => r.day === day && r.kind === kind)?.count ?? 0;
    const wipA = get(first, "started"), wipB = get(last, "started");
    const doneDelta = get(last, "completed") - get(first, "completed");
    const triage = get(last, "triage");
    const total = rows.filter((r) => r.day === last).reduce((s, r) => s + r.count, 0);
    if (!total) return "No matching items existed in this period.";
    const wip = wipA === wipB ? `work in progress held at ${wipB} ${wipB === 1 ? "item" : "items"}` : `work in progress went from ${wipA} to ${wipB} items`;
    return `Over the last ${p.days} days ${wip} and ${Math.max(0, doneDelta)} more ${doneDelta === 1 ? "item was" : "items were"} completed${triage ? `; ${triage} ${triage === 1 ? "item waits" : "items wait"} in triage` : ""}.`;
  },
});

// ------------------------------------------------------------------------------------------------
// cycle_burndown and burnup

/**
 * Scope and completed work per day for items in a membership (a cycle or a project).
 * @param {DatasetContext} ctx @param {Timeline[]} list @param {string[]} days @param {(p: Point) => boolean} member @param {string} unit
 */
function scopeSeries(ctx, list, days, member, unit) {
  return days.map((day) => {
    if (dayStart(day) > ctx.now) return { day, scope: null, completed: null, future: true };
    const t = readAt(day, ctx.now);
    let scope = 0, completed = 0;
    for (const tl of list) {
      const p = at(tl.points, t);
      if (!p || p.archived || !member(p) || p.kind === "canceled") continue;
      const w = weight(unit, p);
      scope += w;
      if (p.kind === "completed") completed += w;
    }
    return { day, scope: round(scope, 1), completed: round(completed, 1), future: false };
  });
}

/** Items that were ever in a membership (so the unit is chosen from them). @param {Timeline[]} list @param {(p: Point) => boolean} member */
const everIn = (list, member) => list.filter((tl) => tl.points.some(member));

/** @param {Record<string, unknown>} p @param {DatasetContext} ctx */
function resolveCycleParams(p, ctx) {
  const cycle = findCycle(ctx.index, p.cycle, utcToday(ctx));
  return { cycle: cycle.name, cycle_id: cycle.id, starts_on: cycle.start, ends_on: cycle.end, unit: unitParam(p.unit) };
}

/**
 * The parts of a sentence about a cycle's progress: scope change, work done and a projection from
 * the rate so far. `text` is set when a single message says it all.
 * @param {Record<string, any>[]} rows @param {DatasetContext} ctx @param {Record<string, any>} p
 * @returns {{ text: string|null, scope?: string, done?: string, pct?: number, projection?: string, unestimated?: string }}
 */
function cycleParts(rows, ctx, p) {
  const past = rows.filter((r) => !r.future);
  const unit = rows[0]?.unit ?? "count";
  const today = utcToday(ctx);
  if (!past.length) {
    const planned = rows[0]?.planned ?? 0;
    return { text: `${p.cycle} starts on ${p.starts_on} with ${num(planned)} ${unitWord(unit, planned)} planned.` };
  }
  const start = past[0], now = past[past.length - 1];
  if (!now.scope) return { text: `${p.cycle} has no ${unit === "points" ? "estimated " : ""}items.` };
  const change = start.scope ? (now.scope - start.scope) / start.scope : 0;
  const scope = Math.abs(change) < 0.01 ? "Scope is unchanged" : `Scope ${change > 0 ? "grew" : "shrank"} ${Math.round(Math.abs(change) * 100)}%`;
  const done = `${num(now.completed)} of ${num(now.scope)} ${unitWord(unit, now.scope)} done`;
  const pct = Math.round((now.completed / now.scope) * 100);
  const unestimated = unit === "points" && rows[0]?.unestimated ? `; ${rows[0].unestimated} ${rows[0].unestimated === 1 ? "item has" : "items have"} no estimate` : "";
  if (p.ends_on < today) return { text: `${p.cycle} ended with ${done} (${pct}%). ${scope} over the cycle${unestimated}.` };
  const remaining = now.scope - now.completed;
  let projection;
  if (remaining <= 0) projection = `everything is done with ${daysBetween(today, p.ends_on)} days to spare`;
  else if (!now.completed) projection = "nothing is completed yet, so there is no projection";
  else {
    const needed = Math.ceil(remaining / (now.completed / past.length));
    const late = daysBetween(p.ends_on, plusDays(today, needed));
    projection = late > 0 ? `projected to finish ${late} ${late === 1 ? "day" : "days"} late` : late < 0 ? `projected to finish ${-late} ${late === -1 ? "day" : "days"} early` : "projected to finish on the last day";
  }
  return { text: null, scope, done, pct, projection, unestimated };
}

/** @param {Record<string, any>[]} rows @param {DatasetContext} ctx @param {Record<string, any>} p */
function cycleSentence(rows, ctx, p) {
  const c = cycleParts(rows, ctx, p);
  return c.text ?? `${c.scope} this cycle; ${c.done}; ${c.projection}${c.unestimated}.`;
}

registerDataset({
  name: "cycle_burndown",
  title: "Cycle burndown",
  history: true,
  description: "Remaining work in a cycle per UTC day from its start to its end, with the ideal straight line. Canceled items leave the scope; future days have null values.",
  params: { cycle: "Cycle name, number, current (default), previous or next", unit: "points, count or auto (points when at least half the items are estimated)" },
  columns: [
    { name: "day", type: "date", description: "UTC day" },
    { name: "cycle", type: "string", description: "Cycle name" },
    { name: "unit", type: "string", description: "points or count" },
    { name: "scope", type: "number", description: "Work in the cycle at the end of the day (null in the future)" },
    { name: "completed", type: "number", description: "Of which completed" },
    { name: "remaining", type: "number", description: "scope − completed" },
    { name: "ideal", type: "number", description: "The ideal line from the first day's scope to 0 on the last day" },
    { name: "future", type: "boolean", description: "The day has not happened yet" },
  ],
  resolve: resolveCycleParams,
  rows: (ctx, items, p) => {
    const member = (/** @type {Point} */ pt) => pt.cycle === p.cycle_id;
    const list = everIn(listFor(ctx, items), member);
    const unit = chooseUnit(p.unit, list);
    const days = dayRange(p.starts_on, p.ends_on);
    const series = scopeSeries(ctx, list, days, member, unit);
    const first = series.find((s) => !s.future);
    const planned = list.filter((tl) => tl.item.cycle === p.cycle_id && tl.item.kind !== "canceled" && !tl.item.archived).reduce((s, tl) => s + (unit === "points" ? tl.item.estimate ?? 0 : 1), 0);
    const base = first?.scope ?? planned;
    const unestimated = list.filter((tl) => tl.item.cycle === p.cycle_id && tl.item.estimate === null && !tl.item.archived && tl.item.kind !== "canceled").length;
    return series.map((s, i) => ({
      day: s.day, cycle: p.cycle, unit, scope: s.scope, completed: s.completed,
      remaining: s.scope === null || s.completed === null ? null : round(s.scope - s.completed, 1),
      ideal: round(days.length > 1 ? base * (1 - i / (days.length - 1)) : 0, 1), future: s.future,
      ...(i === 0 ? { planned, unestimated } : {}),
    }));
  },
  summary: cycleSentence,
});

registerDataset({
  name: "burnup",
  title: "Burnup",
  history: true,
  description: "Scope and completed work per UTC day for a cycle (start to end) or a project (its start, or first item, to today; at most 180 days). Canceled items leave the scope.",
  params: {
    scope: "cycle (default) or project", cycle: "For scope cycle: name, number, current (default), previous or next",
    project: "For scope project: the project name (required)", unit: "points, count or auto",
  },
  columns: [
    { name: "day", type: "date", description: "UTC day" },
    { name: "name", type: "string", description: "Cycle or project name" },
    { name: "unit", type: "string", description: "points or count" },
    { name: "scope", type: "number", description: "Total work in scope at the end of the day (null in the future)" },
    { name: "completed", type: "number", description: "Completed work at the end of the day" },
    { name: "future", type: "boolean", description: "The day has not happened yet" },
  ],
  resolve: (p, ctx) => {
    const scope = p.scope === undefined || p.scope === "" ? "cycle" : p.scope;
    if (scope !== "cycle" && scope !== "project") throw invalid("scope is cycle or project.");
    if (scope === "cycle") return { scope, ...resolveCycleParams(p, ctx) };
    if (p.cycle !== undefined) throw invalid("cycle applies only to scope cycle.");
    const project = findProject(ctx.index, p.project);
    return { scope, project: project.name, project_id: project.id, starts_on: project.start, unit: unitParam(p.unit) };
  },
  rows: (ctx, items, p) => {
    const member = p.scope === "cycle" ? (/** @type {Point} */ pt) => pt.cycle === p.cycle_id : (/** @type {Point} */ pt) => pt.project === p.project_id;
    const list = everIn(listFor(ctx, items), member);
    const unit = chooseUnit(p.unit, list);
    /** @type {string[]} */
    let days;
    const today = utcToday(ctx);
    if (p.scope === "cycle") days = dayRange(p.starts_on, p.ends_on);
    else {
      const firstSeen = list.flatMap((tl) => tl.points.filter(member).map((pt) => pt.t)).reduce((m, t) => Math.min(m, t), Infinity);
      const from = [p.starts_on, Number.isFinite(firstSeen) ? utcDay(firstSeen) : null].filter(Boolean).toSorted()[0] ?? today;
      days = dayRange(from < plusDays(today, -179) ? plusDays(today, -179) : from, today);
    }
    return scopeSeries(ctx, list, days, member, unit).map((s) => ({ day: s.day, name: p.scope === "cycle" ? p.cycle : p.project, unit, scope: s.scope, completed: s.completed, future: s.future }));
  },
  summary: (rows, ctx, p) => {
    if (p.scope === "cycle") {
      const c = cycleParts(rows, ctx, p);
      return c.text ?? `${p.cycle}: ${c.done} (${c.pct}%). ${c.scope} this cycle; ${c.projection}${c.unestimated}.`;
    }
    const past = rows.filter((r) => !r.future);
    const first = past[0], last = past[past.length - 1];
    if (!last?.scope) return `${p.project} has no ${last?.unit === "points" ? "estimated " : ""}items yet.`;
    const change = first.scope ? (last.scope - first.scope) / first.scope : 0;
    const scope = Math.abs(change) < 0.01 ? "scope is unchanged" : `scope ${change > 0 ? "grew" : "shrank"} ${Math.round(Math.abs(change) * 100)}% since ${first.day}`;
    return `${p.project}: ${num(last.completed)} of ${num(last.scope)} ${unitWord(last.unit, last.scope)} done (${Math.round((last.completed / last.scope) * 100)}%); ${scope}.`;
  },
});

// ------------------------------------------------------------------------------------------------
// throughput and cycle time

/** When an item last became completed, if it is completed now. @param {Timeline} tl */
function completedAt(tl) {
  const last = tl.points.at(-1);
  if (!last || last.kind !== "completed") return null;
  let t = last.t;
  for (let i = tl.points.length - 1; i >= 0 && tl.points[i].kind === "completed"; i--) t = tl.points[i].t;
  return t;
}
/** When an item first entered a started state. @param {Timeline} tl */
function startedAt(tl) { return tl.points.find((p) => p.kind === "started")?.t ?? null; }

registerDataset({
  name: "throughput",
  title: "Throughput",
  history: true,
  description: "Items (and points) completed per ISO week (Monday to Sunday, UTC), by when each currently completed item was last completed. The current week is partial.",
  params: { weeks: "How many weeks, 1–104; default 12" },
  columns: [
    { name: "week", type: "date", description: "The Monday starting the week (UTC)" },
    { name: "completed", type: "number", description: "Items completed that week" },
    { name: "points", type: "number", description: "Their estimates" },
    { name: "partial", type: "boolean", description: "The week is not over yet" },
  ],
  resolve: (p) => ({ weeks: intParam(p.weeks, "weeks", 12, 1, 104) }),
  rows: (ctx, items, p) => {
    const today = utcToday(ctx);
    const thisWeek = weekOf(today);
    const weeks = Array.from({ length: p.weeks }, (_, i) => plusDays(thisWeek, -7 * (p.weeks - 1 - i)));
    const acc = new Map(weeks.map((w) => [w, { completed: 0, points: 0 }]));
    for (const tl of listFor(ctx, items)) {
      const t = completedAt(tl);
      if (t === null) continue;
      const a = acc.get(weekOf(utcDay(t)));
      if (a) { a.completed++; a.points += tl.item.estimate ?? 0; }
    }
    return weeks.map((w) => ({ week: w, completed: acc.get(w)?.completed ?? 0, points: round(acc.get(w)?.points ?? 0, 1), partial: w === thisWeek }));
  },
  summary: (rows) => {
    const full = rows.filter((r) => !r.partial);
    if (!full.length) return `${rows[0]?.completed ?? 0} items completed so far this week.`;
    const avg = full.reduce((s, r) => s + r.completed, 0) / full.length;
    const lastWeek = full.at(-1)?.completed ?? 0;
    const best = full.reduce((m, r) => (r.completed > m.completed ? r : m), full[0]);
    return `On average ${num(round(avg, 1))} items were completed per week over the last ${full.length} full ${full.length === 1 ? "week" : "weeks"} (last week ${lastWeek}; best ${best.completed}, week of ${best.week}).`;
  },
});

registerDataset({
  name: "cycle_time",
  title: "Cycle time",
  history: true,
  description: "For each item completed in the period: from first entering a started state to last being completed, in days, with a centred rolling average (window 20% of items, at least 5, odd) and the 50th/85th percentiles. Items completed without ever being started are left out.",
  params: { days: "Items completed in the last N days, 1–730; default 90" },
  columns: [
    { name: "key", type: "string", description: "Item key" },
    { name: "title", type: "string", description: "Title" },
    { name: "assignee", type: "string", description: "Assignee's name, or null" },
    { name: "estimate", type: "number", description: "Points, or null" },
    { name: "started", type: "instant", description: "First entered a started state (ISO 8601 UTC)" },
    { name: "completed", type: "instant", description: "Last completed (ISO 8601 UTC)" },
    { name: "completed_day", type: "date", description: "UTC day it was completed" },
    { name: "days", type: "number", description: "Cycle time in days (1 decimal)" },
    { name: "rolling_avg", type: "number", description: "Centred rolling average of days" },
    { name: "p50", type: "number", description: "Median cycle time of all rows (same on every row)" },
    { name: "p85", type: "number", description: "85th percentile of all rows (same on every row)" },
  ],
  resolve: (p) => ({ days: intParam(p.days, "days", 90, 1, 730) }),
  rows: (ctx, items, p) => {
    const since = ctx.now - p.days * DAY_MS;
    /** @type {Record<string, any>[]} */
    const rows = [];
    for (const tl of listFor(ctx, items)) {
      const done = completedAt(tl);
      if (done === null || done < since) continue;
      const started = startedAt(tl);
      if (started === null || started > done) continue;
      rows.push({
        key: tl.item.key, title: tl.item.title, assignee: tl.item.assignee ? personName(ctx.index, tl.item.assignee) : null, estimate: tl.item.estimate,
        started: iso(started), completed: iso(done), completed_day: utcDay(done), days: round((done - started) / DAY_MS, 1), _t: done,
      });
    }
    rows.splice(0, rows.length, ...rows.toSorted((a, b) => a._t - b._t));
    const n = rows.length;
    let w = Math.max(5, Math.round(n * 0.2));
    if (w % 2 === 0) w++;
    const half = (w - 1) / 2;
    const sorted = rows.map((r) => r.days).toSorted((a, b) => a - b);
    const p50 = percentile(sorted, 0.5), p85 = percentile(sorted, 0.85);
    return rows.map((r, i) => {
      const win = rows.slice(Math.max(0, i - half), Math.min(n, i + half + 1));
      const { _t, ...rest } = r;
      return { ...rest, rolling_avg: round(win.reduce((s, x) => s + x.days, 0) / win.length, 1), p50: p50 === null ? null : round(p50, 1), p85: p85 === null ? null : round(p85, 1) };
    });
  },
  summary: (rows, _ctx, p) => {
    if (!rows.length) return `No items were completed in the last ${p.days} days.`;
    const trendA = rows[Math.floor(rows.length / 4)]?.rolling_avg, trendB = rows[Math.floor((rows.length * 3) / 4)]?.rolling_avg;
    const trend = rows.length >= 10 && trendA && trendB ? (trendB < trendA * 0.8 ? "; items are finishing faster lately" : trendB > trendA * 1.2 ? "; items are taking longer lately" : "") : "";
    return `Median cycle time ${num(rows[0].p50)} days; 85% of items finished within ${num(rows[0].p85)} days (${rows.length} ${rows.length === 1 ? "item" : "items"} completed in the last ${p.days} days)${trend}.`;
  },
});

// ------------------------------------------------------------------------------------------------
// created_vs_resolved

registerDataset({
  name: "created_vs_resolved",
  title: "Created vs resolved",
  history: true,
  description: "Items created and resolved (moved into a done-category state: completed or canceled) per UTC day, with running totals over the period. An item resolved, reopened and resolved again counts twice.",
  params: { days: "How many days, 1–365; default 30" },
  columns: [
    { name: "day", type: "date", description: "UTC day" },
    { name: "created", type: "number", description: "Items created that day" },
    { name: "resolved", type: "number", description: "Items resolved that day" },
    { name: "created_total", type: "number", description: "Created since the first day of the period" },
    { name: "resolved_total", type: "number", description: "Resolved since the first day of the period" },
  ],
  resolve: (p) => ({ days: intParam(p.days, "days", 30, 1, 365) }),
  rows: (ctx, items, p) => {
    const today = utcToday(ctx);
    const days = dayRange(plusDays(today, -(p.days - 1)), today);
    const acc = new Map(days.map((d) => [d, { created: 0, resolved: 0 }]));
    for (const tl of listFor(ctx, items)) {
      const first = tl.points[0];
      if (first) { const a = acc.get(utcDay(first.t)); if (a) a.created++; }
      for (let i = 1; i < tl.points.length; i++) {
        if (tl.points[i].category === "done" && tl.points[i - 1].category !== "done") { const a = acc.get(utcDay(tl.points[i].t)); if (a) a.resolved++; }
      }
      if (first && first.category === "done") { const a = acc.get(utcDay(first.t)); if (a) a.resolved++; }
    }
    let ct = 0, rt = 0;
    return days.map((day) => {
      const a = /** @type {{ created: number, resolved: number }} */ (acc.get(day));
      ct += a.created; rt += a.resolved;
      return { day, created: a.created, resolved: a.resolved, created_total: ct, resolved_total: rt };
    });
  },
  summary: (rows, _ctx, p) => {
    const last = rows.at(-1);
    if (!last) return "No days to show.";
    const net = last.created_total - last.resolved_total;
    const trend = net > 0 ? `open work grew by ${net}` : net < 0 ? `open work shrank by ${-net}` : "open work held steady";
    return `In the last ${p.days} days ${num(last.created_total)} ${last.created_total === 1 ? "item was" : "items were"} created and ${num(last.resolved_total)} resolved, so ${trend}.`;
  },
});

// ------------------------------------------------------------------------------------------------
// workload

const OPEN_KINDS = ["triage", "backlog", "unstarted", "started"];

registerDataset({
  name: "workload",
  title: "Workload by assignee",
  description: "Unfinished work per person and state kind now: item counts and estimate sums. By default only committed work (unstarted and started kinds); Unassigned last.",
  params: { kinds: "Comma-separated kinds to count: triage, backlog, unstarted, started, or open for all four; default unstarted,started" },
  columns: [
    { name: "assignee", type: "string", description: "Person's name, or Unassigned" },
    { name: "assignee_id", type: "string", description: "Records actor id, or null" },
    { name: "kind", type: "string", description: "State kind" },
    { name: "kind_label", type: "string", description: "Kind as shown" },
    { name: "order", type: "number", description: "Kind order, 0 = triage … 3 = started (for stacking)" },
    { name: "count", type: "number", description: "Items" },
    { name: "points", type: "number", description: "Estimate sum" },
    { name: "total_count", type: "number", description: "The person's items across the chosen kinds" },
    { name: "total_points", type: "number", description: "The person's points across the chosen kinds" },
  ],
  resolve: (p) => {
    const raw = p.kinds === undefined || p.kinds === "" ? "unstarted,started" : String(p.kinds);
    const kinds = raw === "open" ? OPEN_KINDS : raw.split(",").map((k) => k.trim()).filter(Boolean);
    const bad = kinds.find((k) => !OPEN_KINDS.includes(k));
    if (bad || !kinds.length) throw invalid(`kinds is a list of ${OPEN_KINDS.join(", ")} (or open).`);
    return { kinds: kinds.join(",") };
  },
  rows: (ctx, items, p) => {
    const kinds = String(p.kinds).split(",");
    /** @type {Map<string|null, Map<string, { count: number, points: number }>>} */
    const byPerson = new Map();
    for (const i of items) {
      if (!kinds.includes(i.kind)) continue;
      let m = byPerson.get(i.assignee);
      if (!m) byPerson.set(i.assignee, m = new Map());
      const a = m.get(i.kind) ?? { count: 0, points: 0 };
      a.count++; a.points += i.estimate ?? 0;
      m.set(i.kind, a);
    }
    const people = [...byPerson].map(([id, m]) => ({
      id, name: id ? personName(ctx.index, id) : "Unassigned", m,
      count: [...m.values()].reduce((s, a) => s + a.count, 0), points: [...m.values()].reduce((s, a) => s + a.points, 0),
    })).toSorted((a, b) => (a.id === null ? 1 : 0) - (b.id === null ? 1 : 0) || b.count - a.count || b.points - a.points || a.name.localeCompare(b.name));
    return people.flatMap((person) => KINDS.filter((k) => person.m.has(k)).map((k) => {
      const a = /** @type {{ count: number, points: number }} */ (person.m.get(k));
      return { assignee: person.name, assignee_id: person.id, kind: k, kind_label: /** @type {any} */ (KIND_LABELS)[k], order: KINDS.indexOf(k), count: a.count, points: round(a.points, 1), total_count: person.count, total_points: round(person.points, 1) };
    }));
  },
  summary: (rows) => {
    /** @type {Map<string, { count: number, points: number, started: number }>} */
    const people = new Map();
    for (const r of rows) {
      const p = people.get(r.assignee) ?? { count: r.total_count, points: r.total_points, started: 0 };
      if (r.kind === "started") p.started += r.count;
      people.set(r.assignee, p);
    }
    const named = [...people].filter(([n]) => n !== "Unassigned");
    if (!named.length) return people.size ? `All ${people.get("Unassigned")?.count} items are unassigned.` : "Nobody has unfinished work in these states.";
    const [topName, top] = named[0];
    const avg = named.reduce((s, [, p]) => s + p.count, 0) / named.length;
    const un = people.get("Unassigned");
    return `${topName} has the most: ${top.count} ${top.count === 1 ? "item" : "items"} (${num(top.points)} points), ${top.started} in progress; the average across ${named.length} ${named.length === 1 ? "person" : "people"} is ${num(round(avg, 1))}${un ? `. ${un.count} ${un.count === 1 ? "item is" : "items are"} unassigned` : ""}.`;
  },
});

// ------------------------------------------------------------------------------------------------
// dependencies

registerDataset({
  name: "dependencies",
  title: "Dependencies",
  description: "The live blocking graph: rows with type \"node\" (items) and type \"edge\" (an active blocks relation between two unfinished items). An edge is included when either end matches the query; nodes outside the query are marked context. Blocked chains are flagged.",
  columns: [
    { name: "type", type: "string", description: "node or edge" },
    { name: "id", type: "string", description: "Node: the item key. Edge: \"FROM->TO\"" },
    { name: "key", type: "string", description: "Node: item key" },
    { name: "title", type: "string", description: "Node: title" },
    { name: "state", type: "string", description: "Node: state name" },
    { name: "kind", type: "string", description: "Node: state kind" },
    { name: "assignee", type: "string", description: "Node: assignee's name, or null" },
    { name: "blocked", type: "boolean", description: "Node: blocked by an unfinished item" },
    { name: "blocking", type: "number", description: "Node: how many unfinished items it blocks" },
    { name: "depth", type: "number", description: "Node: longest chain of unfinished blockers above it (0 = not blocked)" },
    { name: "chain", type: "boolean", description: "Node: blocked and itself blocking (a link in a chain)" },
    { name: "context", type: "boolean", description: "Node: outside the query, shown because it is related" },
    { name: "source", type: "string", description: "Edge: the blocking item's key" },
    { name: "target", type: "string", description: "Edge: the blocked item's key" },
    { name: "critical", type: "boolean", description: "Edge: part of a chain of two or more blocks" },
  ],
  rows: (ctx, items) => {
    const ix = ctx.index;
    const selected = new Set(items.map((i) => i.id));
    /** @type {{ from: string, to: string }[]} */
    const live = [];
    for (const r of ix.relations) {
      if (!r.active || r.kind !== "blocks") continue;
      const a = ix.items.get(r.from), b = ix.items.get(r.to);
      if (!a || !b || a.archived || b.archived || a.category === "done" || b.category === "done" || a.id === b.id) continue;
      live.push({ from: a.id, to: b.id });
    }
    /** @type {Map<string, string[]>} */
    const blockers = new Map();
    /** @type {Map<string, string[]>} */
    const blocks = new Map();
    for (const e of live) {
      blockers.set(e.to, [...(blockers.get(e.to) ?? []), e.from]);
      blocks.set(e.from, [...(blocks.get(e.from) ?? []), e.to]);
    }
    /** @type {Map<string, number>} */
    const depthMemo = new Map();
    /** @param {string} id @param {Set<string>} seen @returns {number} */
    const depth = (id, seen) => {
      const known = depthMemo.get(id);
      if (known !== undefined) return known;
      if (seen.has(id)) return 0;
      seen.add(id);
      const d = Math.max(0, ...(blockers.get(id) ?? []).map((b) => 1 + depth(b, seen)));
      seen.delete(id);
      depthMemo.set(id, d);
      return d;
    };
    const edges = live.filter((e) => selected.has(e.from) || selected.has(e.to));
    const nodeIds = new Set(edges.flatMap((e) => [e.from, e.to]));
    /** @type {Record<string, any>[]} */
    const rows = [];
    for (const id of [...nodeIds].toSorted((a, b) => (ix.items.get(a)?.number ?? 0) - (ix.items.get(b)?.number ?? 0))) {
      const it = /** @type {ItemView} */ (ix.items.get(id));
      const d = depth(id, new Set());
      rows.push({
        type: "node", id: it.key, key: it.key, title: it.title, state: stateName(ix, it.state), kind: it.kind,
        assignee: it.assignee ? personName(ix, it.assignee) : null, blocked: d > 0, blocking: blocks.get(id)?.length ?? 0, depth: d,
        chain: d > 0 && (blocks.get(id)?.length ?? 0) > 0, context: !selected.has(id),
        source: null, target: null, critical: null,
      });
    }
    for (const e of edges) {
      const a = /** @type {ItemView} */ (ix.items.get(e.from)), b = /** @type {ItemView} */ (ix.items.get(e.to));
      rows.push({
        type: "edge", id: `${a.key}->${b.key}`, key: null, title: null, state: null, kind: null, assignee: null, blocked: null, blocking: null, depth: null,
        chain: null, context: null, source: a.key, target: b.key, critical: (blockers.get(e.from)?.length ?? 0) > 0 || (blocks.get(e.to)?.length ?? 0) > 0,
      });
    }
    return rows;
  },
  summary: (rows) => {
    const nodes = rows.filter((r) => r.type === "node");
    const blocked = nodes.filter((r) => r.blocked && !r.context).length || nodes.filter((r) => r.blocked).length;
    const blockers = new Set(rows.filter((r) => r.type === "edge").map((r) => r.source)).size;
    if (!nodes.length) return "Nothing is blocked.";
    const deepest = nodes.reduce((m, r) => (r.depth > m.depth ? r : m), nodes[0]);
    /** @type {string[]} */
    const chain = [deepest.key];
    const edges = rows.filter((r) => r.type === "edge");
    const byKey = new Map(nodes.map((n) => [n.key, n]));
    for (let cur = deepest; cur && cur.depth > 0 && chain.length < 12;) {
      /** @type {Record<string, any>|null} */
      let next = null;
      for (const e of edges) {
        const up = e.target === cur.key ? byKey.get(e.source) : undefined;
        if (up && (!next || up.depth > next.depth)) next = up;
      }
      if (!next || chain.includes(next.key)) break;
      chain.unshift(next.key);
      cur = next;
    }
    return `${blocked} ${blocked === 1 ? "item is" : "items are"} blocked by ${blockers} unfinished ${blockers === 1 ? "item" : "items"}; ${deepest.depth > 1 ? `the longest chain is ${deepest.depth} deep: ${chain.join(" → ")}` : "no chains longer than one step"}.`;
  },
});
