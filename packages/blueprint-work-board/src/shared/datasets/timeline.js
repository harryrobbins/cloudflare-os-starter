// @ts-check
// Per-item timelines rebuilt from the journal: for every work item, the sequence of its state,
// estimate, cycle and archived flag over time, with who made each change. Every flow dataset
// (cumulative flow, burndown, cycle time, throughput …) is a fold over these.
//
// Time is UTC throughout: a "day" is a UTC calendar date (YYYY-MM-DD) and "at the end of day D"
// means just before D+1 00:00:00Z. Journal entries without a commit time (an older Records
// service) cannot be placed in time and are skipped; an item with no timed history is placed at
// its creation time (when known) in its current state.

import { resolveState } from "../model/index.js";
import { refId } from "../model/work.js";

export const DAY_MS = 86_400_000;

/**
 * @typedef {import("../model/index.js").WorkIndex} WorkIndex
 * @typedef {import("../model/index.js").ItemView} ItemView
 * @typedef {import("../replica.js").HistoryEntry} HistoryEntry
 * @typedef {{ t: number, seq: number, state: string, kind: string, category: "open"|"active"|"done",
 *   estimate: number|null, cycle: string|null, project: string|null, assignee: string|null, archived: boolean,
 *   actor: string|null, created: boolean }} Point
 * @typedef {{ item: ItemView, points: Point[] }} Timeline
 */

/** The UTC day of an instant. @param {number} t */
export const utcDay = (t) => new Date(t).toISOString().slice(0, 10);
/** Midnight UTC starting a day. @param {string} day */
export const dayStart = (day) => Date.parse(`${day}T00:00:00Z`);
/** The instant a day ends (the next midnight UTC). @param {string} day */
export const dayEnd = (day) => dayStart(day) + DAY_MS;
/** @param {string} day @param {number} n */
export const plusDays = (day, n) => utcDay(dayStart(day) + n * DAY_MS);
/** Days from `from` to `to` inclusive (at most `max`). @param {string} from @param {string} to */
export function dayRange(from, to, max = 800) {
  /** @type {string[]} */
  const out = [];
  for (let t = dayStart(from), end = dayStart(to); t <= end && out.length < max; t += DAY_MS) out.push(utcDay(t));
  return out;
}
/** The Monday (UTC) starting the ISO week of a day. @param {string} day */
export function weekOf(day) {
  const t = dayStart(day);
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  return utcDay(t - dow * DAY_MS);
}

/** @type {WeakMap<object, { history: object, version: number, value: Map<string, Timeline> }>} */
const memo = new WeakMap();

/**
 * Timelines for every work item, memoised per index, history map and history version (a replica
 * fills its history map in place, so the version tells when it changed).
 * @param {WorkIndex} index @param {Map<string, HistoryEntry[]>|undefined} history @param {number} [version]
 * @returns {Map<string, Timeline>}
 */
export function timelines(index, history, version = 0) {
  const h = history ?? EMPTY;
  const hit = memo.get(index);
  if (hit && hit.history === h && hit.version === version) return hit.value;
  const value = build(index, h);
  memo.set(index, { history: h, version, value });
  return value;
}
const EMPTY = new Map();

/** @param {WorkIndex} index @param {Map<string, HistoryEntry[]>} history */
function build(index, history) {
  /** @type {Map<string, Timeline>} */
  const out = new Map();
  for (const item of index.items.values()) out.set(item.id, { item, points: pointsOf(index, item, history.get(item.id) ?? []) });
  return out;
}

/**
 * @param {WorkIndex} index @param {ItemView} item @param {HistoryEntry[]} entries
 * @returns {Point[]}
 */
function pointsOf(index, item, entries) {
  /** @type {Point[]} */
  const points = [];
  /** @type {Record<string, any>} */
  const data = {};
  let last = "";
  for (const e of entries.length > 1 ? [...entries].toSorted((a, b) => a.seq - b.seq) : entries) {
    for (const [key, [, after]] of Object.entries(e.diff)) data[key] = after;
    if (e.at === null) continue;
    const p = point(index, data, e);
    const sig = `${p.state}|${p.estimate}|${p.cycle}|${p.project}|${p.assignee}|${p.archived}`;
    if (sig === last && !e.created) continue;
    last = sig;
    points.push(p);
  }
  if (!points.length && item.created !== null) {
    points.push({ t: item.created, seq: 0, state: item.state, kind: item.kind, category: item.category, estimate: item.estimate,
      cycle: item.cycle, project: item.project, assignee: item.assignee, archived: item.archived, actor: item.created_by, created: true });
  }
  return points;
}

/** @param {WorkIndex} index @param {Record<string, any>} data @param {HistoryEntry} e @returns {Point} */
function point(index, data, e) {
  const status = data.status === "active" || data.status === "done" ? data.status : "open";
  const s = resolveState(data.state, status, index.stateByKey, index.states);
  return {
    t: /** @type {number} */ (e.at), seq: e.seq, state: s.key, kind: s.kind, category: s.category,
    estimate: typeof data.estimate === "number" && Number.isFinite(data.estimate) ? data.estimate : null,
    cycle: refId(data.cycle), project: refId(data.project), assignee: typeof data.assignee === "string" && data.assignee ? data.assignee : null,
    archived: data.archived === true, actor: e.actor, created: e.created,
  };
}

/**
 * The item's point in force at instant `t` (the last change before it), or null before creation.
 * @param {Point[]} points @param {number} t
 */
export function at(points, t) {
  let lo = 0, hi = points.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found === -1 ? null : points[found];
}

/**
 * Transitions between workflow states (the first point is the state an item was created in).
 * @param {Point[]} points
 * @returns {{ from: Point|null, to: Point }[]}
 */
export function stateChanges(points) {
  /** @type {{ from: Point|null, to: Point }[]} */
  const out = [];
  /** @type {Point|null} */
  let prev = null;
  for (const p of points) {
    if (!prev || prev.state !== p.state) out.push({ from: prev, to: p });
    prev = p;
  }
  return out;
}

/** Linear-interpolated percentile of a sorted list. @param {number[]} sorted @param {number} q 0–1 */
export function percentile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** @param {number} n @param {number} [digits] */
export const round = (n, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;
