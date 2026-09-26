// @ts-check
// A small, realistic work datastore for WQL tests. Fixed "today": 2026-09-26 (instants at noon UTC,
// so the local day is the same in any timezone within ±11 h).
import { buildIndex } from "../../src/shared/model/index.js";

export const TODAY = "2026-09-26";
export const NOW = Date.parse(`${TODAY}T12:00:00Z`);
export const ADA = "cloudflare-os:ada@example.com";
export const BOB = "cloudflare-os:bob@example.com";

const hex = (/** @type {number} */ n, /** @type {string} */ tag) => `${tag.padEnd(8, "0").slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const id = (/** @type {number} */ n) => hex(n, "aaaaaaaa");
const sid = (/** @type {number} */ n) => hex(n, "bbbbbbbb");
export const PROJECT = { web: hex(1, "cccccccc"), api: hex(2, "cccccccc") };
export const CYCLE = { prev: hex(1, "dddddddd"), cur: hex(2, "dddddddd"), next: hex(3, "dddddddd") };
const day = (/** @type {number} */ d) => new Date(NOW + d * 86_400_000).toISOString();

const states = [
  ["triage", "Triage", "triage"], ["backlog", "Backlog", "backlog"], ["todo", "Todo", "unstarted"],
  ["in_progress", "In Progress", "started"], ["in_review", "In Review", "started"], ["done", "Done", "completed"], ["cancelled", "Canceled", "canceled"],
];

/**
 * @typedef {{ n: number, title: string, state?: string, status?: string, priority?: number, assignee?: string,
 *   labels?: string[], estimate?: number, due?: string, start?: string, parent?: number, project?: string, cycle?: string,
 *   archived?: boolean, created?: number, updated?: number, by?: string, ext?: Record<string, unknown>, description?: string, rank?: string }} Spec
 */

/** @type {Spec[]} */
export const ITEMS = [
  { n: 1, title: "Login page redesign", state: "in_progress", priority: 1, assignee: ADA, labels: ["bug", "ui"], estimate: 5, due: "2026-09-24", project: PROJECT.web, cycle: CYCLE.cur, created: -40, updated: -1, ext: { team: "Web", points: 3 }, rank: "a0" },
  { n: 2, title: "API rate limits", state: "todo", priority: 2, assignee: BOB, labels: ["backend"], estimate: 3, due: "2026-10-01", project: PROJECT.api, cycle: CYCLE.cur, created: -30, updated: -20, rank: "a1" },
  { n: 3, title: "Fix login timeout", description: "Users see a login timeout after 5 minutes", state: "in_review", priority: 2, assignee: ADA, labels: ["bug"], estimate: 2, due: "2026-09-26", parent: 1, project: PROJECT.web, cycle: CYCLE.cur, created: -10, updated: -2 },
  { n: 4, title: "Write onboarding docs", state: "backlog", priority: 4, labels: ["docs"], created: -60, updated: -45, cycle: CYCLE.next },
  { n: 5, title: "Triage crash report", state: "triage", priority: 0, created: -1, updated: -1, by: BOB },
  { n: 6, title: "Ship dark mode", state: "done", priority: 3, assignee: BOB, labels: ["ui"], estimate: 8, due: "2026-09-20", project: PROJECT.web, cycle: CYCLE.prev, created: -50, updated: -15 },
  { n: 7, title: "Drop legacy exports", state: "cancelled", priority: 4, labels: ["wontfix"], created: -70, updated: -30 },
  { n: 8, title: "Database migration", state: "in_progress", priority: 1, assignee: BOB, estimate: 13, start: "2026-09-20", due: "2026-10-10", project: PROJECT.api, cycle: CYCLE.cur, created: -20, updated: -3, ext: { team: "Platform", points: 8 } },
  { n: 9, title: "Old archived task", state: "done", priority: 3, archived: true, created: -200, updated: -100 },
  { n: 10, title: "Regression in search", state: "todo", priority: 2, labels: ["regression", "bug"], estimate: 1, parent: 1, created: -5, updated: -5, ext: { tags: ["a", "b"] } },
  { n: 11, title: "Improve logging", status: "active", priority: 3, assignee: ADA, created: -25, updated: -16 },
  { n: 12, title: "Plan Q4", state: "todo", priority: 0, due: "2026-09-30", project: PROJECT.api, created: -2, updated: -2 },
];

/** Raw records for the fixture datastore. */
export function records() {
  /** @type {any[]} */
  const out = [];
  let rev = 1;
  states.forEach(([key, name, kind], i) => out.push({ id: sid(i + 1), entity: "workflow_state", revision: rev++, data: { key, name, kind, position: i + 1 } }));
  out.push({ id: hex(1, "eeeeeeee"), entity: "label", revision: rev++, data: { key: "bug", name: "Bug", color: "#d33" } });
  out.push({ id: hex(2, "eeeeeeee"), entity: "label", revision: rev++, data: { key: "ui", name: "User interface", color: "#33d" } });
  out.push({ id: PROJECT.web, entity: "project", revision: rev++, data: { name: "Website relaunch", state: "active" } });
  out.push({ id: PROJECT.api, entity: "project", revision: rev++, data: { name: "Public API", state: "planned" } });
  out.push({ id: CYCLE.prev, entity: "cycle", revision: rev++, data: { name: "Cycle 1", number: 1, starts_on: "2026-09-01", ends_on: "2026-09-14" } });
  out.push({ id: CYCLE.cur, entity: "cycle", revision: rev++, data: { name: "Cycle 2", number: 2, starts_on: "2026-09-15", ends_on: "2026-09-28" } });
  out.push({ id: CYCLE.next, entity: "cycle", revision: rev++, data: { name: "Cycle 3", number: 3, starts_on: "2026-09-29", ends_on: "2026-10-12" } });
  for (const s of ITEMS) {
    const data = /** @type {any} */ ({ title: s.title, description: s.description ?? "", status: s.status ?? statusOf(s.state), number: s.n, priority: s.priority ?? 0, labels: s.labels ?? [], archived: s.archived ?? false, extensions: s.ext ?? {} });
    if (s.state) data.state = s.state;
    if (s.assignee) data.assignee = s.assignee;
    if (s.estimate !== undefined) data.estimate = s.estimate;
    if (s.due) data.due_date = s.due;
    if (s.start) data.start_date = s.start;
    if (s.parent) data.parent = id(s.parent);
    if (s.project) data.project = s.project;
    if (s.cycle) data.cycle = s.cycle;
    if (s.rank) data.rank = s.rank;
    out.push({ id: id(s.n), entity: "work_item", revision: rev++, created_by: s.by ?? ADA, updated_by: s.by ?? ADA, created_at: day(s.created ?? -1), updated_at: day(s.updated ?? -1), data });
  }
  // 8 blocks 2; 6 (done) blocks 12 (so not blocking); 3 relates 10.
  out.push({ id: hex(1, "ffffffff"), entity: "relation", revision: rev++, data: { from: id(8), to: id(2), kind: "blocks" } });
  out.push({ id: hex(2, "ffffffff"), entity: "relation", revision: rev++, data: { from: id(6), to: id(12), kind: "blocks" } });
  out.push({ id: hex(3, "ffffffff"), entity: "relation", revision: rev++, data: { from: id(3), to: id(10), kind: "relates" } });
  return out;
}

/** @param {string|undefined} state */
function statusOf(state) {
  return state === "in_progress" || state === "in_review" ? "active" : state === "done" || state === "cancelled" ? "done" : "open";
}

/** @param {Partial<import("../../src/shared/wql/evaluate.js").WqlContext>} [over] */
export function context(over = {}) {
  const index = buildIndex(records(), { keyPrefix: "WRK" });
  return { index, viewer: ADA, now: NOW, today: TODAY, ...over };
}

/** Strips spans for structural comparison. @param {unknown} ast */
export function strip(ast) {
  return JSON.parse(JSON.stringify(ast, (k, v) => (k === "span" ? undefined : v)));
}
