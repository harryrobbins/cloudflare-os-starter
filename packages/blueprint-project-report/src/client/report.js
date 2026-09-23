// @ts-check
// Pure report logic: loading, filtering, aggregation and CSV. No DOM, no RPC of its own.

/** @typedef {import("../../../gatekeeper-records/src/vendor/types.d.ts").RecordsIssue} Issue */
/** @typedef {import("../../../gatekeeper-records/src/vendor/types.d.ts").RecordsProject} Project */
/** @typedef {import("../../../gatekeeper-records/src/vendor/types.d.ts").RecordsWorkflow} Workflow */

export const PRIORITIES = /** @type {const} */ (["urgent", "high", "medium", "low", "none"]);
export const PRIORITY_LABELS = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low", none: "No priority" };
/** At most 20 pages of 100. */
export const MAX_ISSUES = 2000;
export const MAX_ASSIGNEE_BARS = 10;

/**
 * Reads every issue in the datastore (all projects), newest first, up to MAX_ISSUES.
 * @param {(input: any) => Promise<{items: Issue[], nextCursor: string|null}>} listIssues
 */
export async function loadIssues(listIssues) {
  /** @type {Issue[]} */
  const items = [];
  let cursor = /** @type {string|null} */ (null);
  do {
    const page = await listIssues({ order: "updated_desc", limit: 100, ...(cursor ? { cursor } : {}) });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && items.length < MAX_ISSUES);
  // Pages can overlap if issues change while paging; keep the newest revision of each.
  /** @type {Map<string, Issue>} */
  const byId = new Map();
  for (const issue of items) {
    const held = byId.get(issue.id);
    if (!held || held.revision < issue.revision) byId.set(issue.id, issue);
  }
  return { items: [...byId.values()].slice(0, MAX_ISSUES), truncated: Boolean(cursor) };
}

/**
 * @typedef {{projectId: string, state: string, priority: string, assigneeId: string}} View
 * @param {Issue[]} issues @param {View} view
 */
export function filterIssues(issues, view) {
  return issues.filter((i) =>
    (!view.projectId || i.projectId === view.projectId) &&
    (!view.state || i.state === view.state) &&
    (!view.priority || i.priority === view.priority) &&
    (!view.assigneeId || (view.assigneeId === "none" ? !i.assignee : i.assignee?.id === view.assigneeId)));
}

/**
 * @param {Issue[]} issues @param {Workflow} workflow
 * @returns {{
 *   total: number, open: number, done: number, unassignedOpen: number,
 *   byState: {key: string, label: string, count: number}[],
 *   byPriority: {key: string, label: string, count: number}[],
 *   byAssignee: {key: string, label: string, count: number}[],
 * }}
 */
export function summarise(issues, workflow) {
  const states = [...workflow.states].toSorted((a, b) => a.position - b.position);
  const category = new Map(states.map((s) => [s.key, s.category]));
  const count = (/** @type {(i: Issue) => string} */ key) => {
    /** @type {Map<string, number>} */
    const m = new Map();
    for (const i of issues) m.set(key(i), (m.get(key(i)) ?? 0) + 1);
    return m;
  };
  const stateCounts = count((i) => i.state);
  const byState = states.map((s) => ({ key: s.key, label: s.name, count: stateCounts.get(s.key) ?? 0 }));
  for (const [key, n] of stateCounts) if (!category.has(key)) byState.push({ key, label: `${key} (not in workflow)`, count: n });

  const prioCounts = count((i) => i.priority);
  const byPriority = PRIORITIES.map((p) => ({ key: p, label: PRIORITY_LABELS[p], count: prioCounts.get(p) ?? 0 }));

  /** @type {Map<string, {label: string, count: number}>} */
  const people = new Map();
  let unassigned = 0;
  for (const i of issues) {
    if (!i.assignee) { unassigned++; continue; }
    const p = people.get(i.assignee.id) ?? { label: i.assignee.displayName, count: 0 };
    p.count++;
    people.set(i.assignee.id, p);
  }
  const ranked = [...people.entries()].map(([key, v]) => ({ key, ...v }))
    .toSorted((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const byAssignee = ranked.slice(0, MAX_ASSIGNEE_BARS);
  const rest = ranked.slice(MAX_ASSIGNEE_BARS).reduce((n, p) => n + p.count, 0);
  if (rest) byAssignee.push({ key: "__other", label: `${ranked.length - MAX_ASSIGNEE_BARS} others`, count: rest });
  if (unassigned) byAssignee.push({ key: "none", label: "Unassigned", count: unassigned });

  const isDone = (/** @type {Issue} */ i) => category.get(i.state) === "done";
  const open = issues.filter((i) => !isDone(i));
  return {
    total: issues.length, open: open.length, done: issues.length - open.length,
    unassignedOpen: open.filter((i) => !i.assignee).length, byState, byPriority, byAssignee,
  };
}

/** @param {Issue[]} issues @param {number} [n] */
export function recentlyUpdated(issues, n = 10) {
  return [...issues].toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, n);
}

/** Quotes a CSV cell and defuses spreadsheet formulas. @param {unknown} value */
export function csvCell(value) {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

/** @param {Issue[]} issues @param {Project[]} projects @param {Workflow} workflow */
export function toCsv(issues, projects, workflow) {
  const project = new Map(projects.map((p) => [p.id, p.name]));
  const state = new Map(workflow.states.map((s) => [s.key, s.name]));
  const header = ["Key", "Title", "Project", "State", "Priority", "Assignee", "Created", "Updated", "Updated by"];
  const rows = issues.map((i) => [
    i.key, i.title, project.get(i.projectId) ?? i.projectId, state.get(i.state) ?? i.state,
    PRIORITY_LABELS[i.priority] ?? i.priority, i.assignee?.displayName ?? "", i.createdAt, i.updatedAt, i.updatedBy.displayName,
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
