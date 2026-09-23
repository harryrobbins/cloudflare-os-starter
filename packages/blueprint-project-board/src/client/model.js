// @ts-check
// Board state derived from Records reads. Pure: no DOM, no RPC.
//
// Records delivery is at-least-once and responses can race, so every merge keeps the higher
// revision of an issue and ignores obsolete ones.

/** @typedef {import("../../../gatekeeper-records/src/vendor/types.d.ts").RecordsIssue} Issue */
/** @typedef {import("../../../gatekeeper-records/src/vendor/types.d.ts").RecordsWorkflow} Workflow */
/** @typedef {import("../../../gatekeeper-records/src/vendor/types.d.ts").RecordsPrincipal} Principal */

export const PRIORITIES = /** @type {const} */ (["urgent", "high", "medium", "low", "none"]);
export const PRIORITY_LABELS = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low", none: "No priority" };

/** Loads at most this many issues per project (10 pages of 100). */
export const MAX_ISSUES = 1000;

/**
 * Merges one issue into the map unless an equal or newer revision is already held.
 * @param {Map<string, Issue>} issues
 * @param {Issue} issue
 * @returns {boolean} whether the map changed
 */
export function mergeIssue(issues, issue) {
  const held = issues.get(issue.id);
  if (held && held.revision >= issue.revision) return false;
  issues.set(issue.id, issue);
  return true;
}

/**
 * Replaces the map with a full snapshot, keeping any held copy that is newer than the snapshot's
 * (a write result can arrive before a list page that was read earlier).
 * @param {Map<string, Issue>} held
 * @param {Issue[]} snapshot
 */
export function replaceIssues(held, snapshot) {
  /** @type {Map<string, Issue>} */
  const next = new Map();
  for (const issue of snapshot) {
    const old = held.get(issue.id);
    next.set(issue.id, old && old.revision > issue.revision ? old : issue);
  }
  return next;
}

/**
 * Reads every page of a project's issues, up to MAX_ISSUES.
 * @param {(input: any) => Promise<{items: Issue[], nextCursor: string|null}>} listIssues
 * @param {string} projectId
 */
export async function loadAllIssues(listIssues, projectId) {
  /** @type {Issue[]} */
  const items = [];
  let cursor = /** @type {string|null} */ (null);
  do {
    const page = await listIssues({ projectId, order: "number_asc", limit: 100, ...(cursor ? { cursor } : {}) });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && items.length < MAX_ISSUES);
  return { items: items.slice(0, MAX_ISSUES), truncated: Boolean(cursor) || items.length > MAX_ISSUES };
}

/** @param {Workflow} workflow */
export function sortedStates(workflow) {
  return [...workflow.states].toSorted((a, b) => a.position - b.position);
}

/** States an issue in `from` may move to, in board order. @param {Workflow} workflow @param {string} from */
export function allowedTargets(workflow, from) {
  const to = new Set(workflow.transitions.filter((t) => t.from === from).map((t) => t.to));
  return sortedStates(workflow).filter((s) => to.has(s.key));
}

/** @param {Workflow} workflow @param {string} from @param {string} to */
export function canTransition(workflow, from, to) {
  return workflow.transitions.some((t) => t.from === from && t.to === to);
}

/**
 * Groups issues into workflow columns. Issues in a state the workflow no longer lists go into an
 * "Other states" column so nothing silently disappears.
 * @param {Workflow} workflow
 * @param {Iterable<Issue>} issues
 * @param {{text?: string, assigneeId?: string, priority?: string}} [filter]
 */
export function columns(workflow, issues, filter = {}) {
  const states = sortedStates(workflow);
  /** @type {Map<string, Issue[]>} */
  const byState = new Map(states.map((s) => [s.key, []]));
  /** @type {Issue[]} */
  const other = [];
  const text = (filter.text ?? "").trim().toLowerCase();
  for (const issue of issues) {
    if (text && !`${issue.key} ${issue.title}`.toLowerCase().includes(text)) continue;
    if (filter.assigneeId === "none" && issue.assignee) continue;
    if (filter.assigneeId && filter.assigneeId !== "none" && issue.assignee?.id !== filter.assigneeId) continue;
    if (filter.priority && issue.priority !== filter.priority) continue;
    (byState.get(issue.state) ?? other).push(issue);
  }
  const rank = (/** @type {Issue} */ i) => PRIORITIES.indexOf(i.priority);
  const order = (/** @type {Issue} */ a, /** @type {Issue} */ b) => rank(a) - rank(b) || a.number - b.number;
  const cols = states.map((state) => ({ state, issues: (byState.get(state.key) ?? []).toSorted(order) }));
  if (other.length) {
    cols.push({ state: { key: "__other", name: "Other states", category: "todo", position: Infinity }, issues: other.toSorted(order) });
  }
  return cols;
}

/**
 * People for the assignee picker: the datastore's members (listAssignees), plus anyone seen on
 * loaded issues (e.g. a former member still assigned).
 * @param {Iterable<Issue>} issues
 * @param {Principal[]} [members]
 * @returns {Principal[]}
 */
export function knownPeople(issues, members = []) {
  /** @type {Map<string, Principal>} */
  const people = new Map(members.map((m) => [m.id, m]));
  for (const issue of issues) {
    for (const p of [issue.assignee, issue.createdBy, issue.updatedBy]) {
      if (p && p.kind === "human" && !people.has(p.id)) people.set(p.id, p);
    }
  }
  return [...people.values()].toSorted((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Which operations this binding can perform right now.
 * @param {{scopes: string[], datastore: {lifecycle: string}}|null} binding
 */
export function capabilities(binding) {
  const scopes = new Set(binding?.scopes ?? []);
  const active = binding?.datastore.lifecycle === "active";
  return {
    read: scopes.has("issues.read") && scopes.has("projects.read"),
    create: active && scopes.has("issues.create"),
    edit: active && scopes.has("issues.edit"),
    transition: active && scopes.has("issues.transition"),
    comment: active && scopes.has("comments.create"),
  };
}

/** Scopes the blueprint asks for that this binding lacks. */
export function missingScopes(/** @type {{scopes: string[]}} */ requirement, /** @type {{scopes: string[]}|null} */ binding) {
  const have = new Set(binding?.scopes ?? []);
  return requirement.scopes.filter((s) => !have.has(s));
}

/**
 * The fields of an attempted edit that now differ from the current record, for the conflict view.
 * @param {Record<string, any>} patch
 * @param {Issue} current
 */
export function conflictingFields(patch, current) {
  /** @type {{field: string, yours: any, theirs: any}[]} */
  const out = [];
  for (const [field, yours] of Object.entries(patch)) {
    const theirs = field === "assigneeId" ? current.assignee?.id ?? null : /** @type {any} */ (current)[field];
    if (JSON.stringify(theirs ?? null) !== JSON.stringify(yours ?? null)) out.push({ field, yours, theirs });
  }
  return out;
}
