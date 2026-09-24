// An in-memory JiraPort for tests: validates inputs with the real contract schemas, applies the
// reference query semantics from @records/contracts, and records idempotency keys.

import {
  AddCommentInputSchema,
  CreateIssueInputSchema,
  DEFAULT_WORKFLOW,
  EditIssueInputSchema,
  RecordsError,
  compareIssues,
  evaluateIssueQuery,
  parseInput,
  type IssueQuery,
  type MutationOutcome,
  type PrincipalRef,
} from "@records/contracts";

import type {
  JiraComment,
  JiraCustomFieldDef,
  JiraIssue,
  JiraPort,
  JiraProject,
  JiraUser,
  JiraWorkflow,
  JiraWriteOptions,
} from "../../src/index.js";

export const ALICE: PrincipalRef = { id: "11111111-1111-4111-8111-111111111111", displayName: "Alice Adams", kind: "human" };
export const BOB: PrincipalRef = { id: "22222222-2222-4222-8222-222222222222", displayName: "Bob Brown", kind: "human" };
export const BOT: PrincipalRef = { id: "33333333-3333-4333-8333-333333333333", displayName: "Build Bot", kind: "service" };
export const CAROL_INACTIVE: PrincipalRef = { id: "44444444-4444-4444-8444-444444444444", displayName: "Carol Gone", kind: "human" };

export const ENG_ID = "aaaaaaaa-0000-4000-8000-000000000001";
export const OPS_ID = "aaaaaaaa-0000-4000-8000-000000000002";

export const STATE_JIRA_IDS: Record<string, number> = { backlog: 10000, todo: 10001, in_progress: 10002, in_review: 10003, done: 10004 };

export const CUSTOM_FIELDS: JiraCustomFieldDef[] = [
  { key: "story_points", name: "Story points", type: "number", options: [], jiraId: 10020 },
  { key: "team", name: "Team", type: "enum", options: ["Core", "Edge"], jiraId: 10021 },
  { key: "notes", name: "Notes", type: "text", options: [], jiraId: 10022 },
];

export type FakeOptions = { me?: PrincipalRef | null; now?: () => Date };

export function createFakePort(options: FakeOptions = {}) {
  const me = options.me === undefined ? ALICE : options.me;
  let clock = Date.parse("2026-09-01T09:00:00.000Z");
  const tick = () => new Date((clock += 60_000)).toISOString();
  let seq = 20000;
  const members: JiraUser[] = [
    { principal: ALICE, active: true, emailAddress: "alice@example.test" },
    { principal: BOB, active: true, emailAddress: "bob@example.test" },
    { principal: BOT, active: true },
    { principal: CAROL_INACTIVE, active: false },
  ];
  const projects: JiraProject[] = [
    { id: ENG_ID, key: "ENG", name: "Engineering", description: "Builds things", revision: 1, createdAt: tick(), updatedAt: tick(), jiraId: 10000, lead: ALICE },
    { id: OPS_ID, key: "OPS", name: "Operations", description: "", revision: 1, createdAt: tick(), updatedAt: tick(), jiraId: 10001 },
  ];
  const workflow: JiraWorkflow = {
    states: DEFAULT_WORKFLOW.states.map((s) => ({ ...s, jiraId: STATE_JIRA_IDS[s.key]! })),
    transitions: DEFAULT_WORKFLOW.transitions,
  };
  const issues: JiraIssue[] = [];
  const comments: JiraComment[] = [];
  const idempotency = new Map<string, MutationOutcome<unknown>>();
  const calls: { op: string; options?: JiraWriteOptions; input: unknown }[] = [];
  let pendingNext = false;

  const principal = (id: string | null | undefined): PrincipalRef | null => (id ? members.find((m) => m.principal.id === id)?.principal ?? null : null);
  const requireMe = (): PrincipalRef => {
    if (!me) throw new RecordsError("unauthenticated", "no caller");
    return me;
  };

  function remember<T>(op: string, input: unknown, opts: JiraWriteOptions, run: () => T): MutationOutcome<T> {
    calls.push({ op, options: opts, input });
    const prior = idempotency.get(`${op}:${opts.idempotencyKey}`);
    if (prior) return prior.status === "applied" ? { ...(prior as MutationOutcome<T> & { status: "applied" }), replayed: true } : (prior as MutationOutcome<T>);
    if (pendingNext) {
      pendingNext = false;
      const out: MutationOutcome<T> = { status: "pending", actionId: 7, idempotencyKey: opts.idempotencyKey };
      idempotency.set(`${op}:${opts.idempotencyKey}`, out);
      return out;
    }
    const out: MutationOutcome<T> = { status: "applied", record: run(), replayed: false };
    idempotency.set(`${op}:${opts.idempotencyKey}`, out);
    return out;
  }

  const port: JiraPort = {
    async myself() {
      const who = requireMe();
      return members.find((m) => m.principal.id === who.id)!;
    },
    async members() {
      requireMe();
      return members;
    },
    async projects() {
      return projects;
    },
    async workflow() {
      return workflow;
    },
    async customFields() {
      return CUSTOM_FIELDS;
    },
    async getIssue(keyOrId) {
      return issues.find((i) => i.key === keyOrId || String(i.jiraId) === keyOrId) ?? null;
    },
    async search(query: IssueQuery, page) {
      const ctx = {
        categoryOf: (s: string) => workflow.states.find((x) => x.key === s)?.category ?? null,
        projectKeyOf: (id: string) => projects.find((p) => p.id === id)?.key ?? null,
      };
      const all = issues.filter((i) => evaluateIssueQuery(query.where, i, ctx)).sort(compareIssues(query.orderBy));
      const offset = page.pageToken ? Number(page.pageToken) : 0;
      const slice = all.slice(offset, offset + page.limit);
      return { issues: slice, nextPageToken: offset + page.limit < all.length ? String(offset + page.limit) : null };
    },
    async createIssue(input, opts) {
      const who = requireMe();
      const parsed = parseInput(CreateIssueInputSchema, input);
      return remember("createIssue", parsed, opts, () => {
        const project = projects.find((p) => p.id === parsed.projectId);
        if (!project) throw new RecordsError("not_found", "no project");
        const number = issues.filter((i) => i.projectId === project.id).length + 1;
        const at = tick();
        const issue: JiraIssue = {
          id: parsed.id ?? crypto.randomUUID(),
          projectId: project.id,
          number,
          key: `${project.key}-${number}`,
          title: parsed.title,
          description: parsed.description,
          state: parsed.state ?? "backlog",
          priority: parsed.priority,
          assignee: principal(parsed.assigneeId),
          customFields: parsed.customFields,
          revision: 1,
          createdAt: at,
          updatedAt: at,
          createdBy: who,
          updatedBy: who,
          jiraId: ++seq,
        };
        issues.push(issue);
        return issue;
      });
    },
    async editIssue(input, opts) {
      const who = requireMe();
      if (input.expectedRevision !== undefined) throw new Error("Jira edits must be last-write-wins");
      const patch = parseInput(EditIssueInputSchema.shape.patch, input.patch);
      return remember("editIssue", input, opts, () => {
        const issue = issues.find((i) => i.id === input.issueId);
        if (!issue) throw new RecordsError("not_found", "no issue");
        if (patch.title !== undefined) issue.title = patch.title;
        if (patch.description !== undefined) issue.description = patch.description;
        if (patch.priority !== undefined) issue.priority = patch.priority;
        if (patch.assigneeId !== undefined) issue.assignee = principal(patch.assigneeId);
        if (patch.customFields) issue.customFields = { ...issue.customFields, ...patch.customFields };
        issue.revision++;
        issue.updatedAt = tick();
        issue.updatedBy = who;
        return { ...issue };
      });
    },
    async transitionIssue(input, opts) {
      const who = requireMe();
      return remember("transitionIssue", input, opts, () => {
        const issue = issues.find((i) => i.id === input.issueId);
        if (!issue) throw new RecordsError("not_found", "no issue");
        if (!workflow.transitions.some((t) => t.from === issue.state && t.to === input.toState)) {
          throw new RecordsError("workflow_conflict", `cannot move from ${issue.state} to ${input.toState}`);
        }
        issue.state = input.toState;
        issue.revision++;
        issue.updatedAt = tick();
        issue.updatedBy = who;
        return { ...issue };
      });
    },
    async addComment(input, opts) {
      const who = requireMe();
      const parsed = parseInput(AddCommentInputSchema, input);
      return remember("addComment", parsed, opts, () => {
        const c: JiraComment = { id: crypto.randomUUID(), issueId: parsed.issueId, body: parsed.body, author: who, createdAt: tick(), jiraId: ++seq };
        comments.push(c);
        return c;
      });
    },
    async listComments(issueId, page) {
      const all = comments.filter((c) => c.issueId === issueId);
      return { comments: all.slice(page.startAt, page.startAt + page.maxResults), total: all.length };
    },
    async getComment(issueId, jiraId) {
      return comments.find((c) => c.issueId === issueId && c.jiraId === jiraId) ?? null;
    },
  };

  return {
    port,
    issues,
    comments,
    calls,
    workflow,
    projects,
    members,
    /** Make the next write come back `pending`. */
    pendNext() {
      pendingNext = true;
    },
  };
}

export type Fake = ReturnType<typeof createFakePort>;
