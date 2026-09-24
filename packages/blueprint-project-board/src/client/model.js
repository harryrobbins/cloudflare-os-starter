// @ts-check
// Board state derived from the SyncClient's view (server state with local guesses replayed on top).
// Pure: no DOM, no RPC.

/** @typedef {import("../../../gatekeeper-records/src/vendor/types.d.ts").RecordsIssue} Issue */
/** @typedef {import("../../../gatekeeper-records/src/vendor/types.d.ts").RecordsWorkflow} Workflow */
/** @typedef {import("../../../gatekeeper-records/src/vendor/types.d.ts").RecordsPrincipal} Principal */

export const PRIORITIES = /** @type {const} */ (["urgent", "high", "medium", "low", "none"]);
export const PRIORITY_LABELS = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low", none: "No priority" };

/** @typedef {import("../../../gatekeeper-records/src/vendor/types.d.ts").RecordsProject} Project */
/** @typedef {import("../../../gatekeeper-records/src/vendor/types.d.ts").RecordsComment} Comment */
/** @typedef {{scan(prefix: string): Array<[string, any]>, get(key: string): any}} View */

/** Projects in the synced view, by key. @param {View} view @returns {Project[]} */
export function projectsIn(view) {
  return view.scan("project/").map(([, p]) => /** @type {Project} */ (p)).toSorted((a, b) => a.key.localeCompare(b.key));
}

/** One project's issues in the synced view (local guesses included). @param {View} view @param {string|null} projectId */
export function issuesIn(view, projectId) {
  /** @type {Map<string, Issue>} */
  const out = new Map();
  for (const [, v] of view.scan("issue/")) {
    const issue = /** @type {Issue} */ (v);
    if (issue.projectId === projectId) out.set(issue.id, issue);
  }
  return out;
}

/** An issue's comments, oldest first. @param {View} view @param {string} issueId @returns {Comment[]} */
export function commentsIn(view, issueId) {
  return view.scan("comment/").map(([, c]) => /** @type {Comment} */ (c)).filter((c) => c.issueId === issueId)
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** A local create the server has not numbered yet (key `ENG-?`). @param {Pick<Issue, "number">} issue */
export function isProvisional(issue) {
  return issue.number === 0;
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
  // Unnumbered local creates (number 0) go after numbered issues of the same priority.
  const num = (/** @type {Issue} */ i) => (i.number === 0 ? Infinity : i.number);
  const order = (/** @type {Issue} */ a, /** @type {Issue} */ b) => rank(a) - rank(b) || num(a) - num(b) || a.id.localeCompare(b.id);
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
      if (p && p.kind === "human" && p.displayName && !people.has(p.id)) people.set(p.id, p);
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
