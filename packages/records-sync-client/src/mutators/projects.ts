// Projects module mutators: pure `(tx, args) => void` functions that predict what the server will
// do with each command (plan §4, last paragraph). The server's result always wins: a pull replaces
// these guesses with the committed rows.
//
// Differences from the server, by design:
// - A created issue has `number: 0` and key `<PROJECT>-?` (the placeholder) until the server's
//   version arrives, because numbers are allocated in the server's transaction. A server running
//   these mutators passes `context.allocateIssueNumber` and gets real numbers.
// - `createdAt`/`updatedAt` use the mutation's client timestamp; the server's clock replaces them.
// - An assignee's display name is taken from any record that already mentions that principal; an
//   unknown assignee shows with an empty display name until the pull.

import type {
  AddCommentInput,
  Comment,
  CreateIssueInput,
  EditIssueInput,
  Issue,
  PrincipalRef,
  Project,
  TransitionIssueInput,
  Workflow,
} from "@records/contracts";

import { MutationError } from "../errors.js";
import { commentKey, issueKey, projectKey, WORKFLOW_KEY, type Mutator, type ReadTx, type WriteTx } from "../types.js";

/** Key suffix shown until the server allocates the issue's number. */
export const PLACEHOLDER_NUMBER = 0;
export const placeholderIssueKey = (projectKey: string): string => `${projectKey}-?`;
/** True while an issue is an unconfirmed local create. */
export const isProvisionalIssue = (issue: Pick<Issue, "number">): boolean => issue.number === PLACEHOLDER_NUMBER;

/** Args after `prepareProjectArgs`: creates always carry their client-chosen id. */
export type CreateIssueArgs = CreateIssueInput & { id: string };
export type AddCommentArgs = AddCommentInput & { id: string };

const TITLE_MAX = 200;
const COMMENT_MAX = 10_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function requireIssue(tx: ReadTx, issueId: string): Issue {
  const issue = tx.get<Issue>(issueKey(issueId));
  if (!issue) throw new MutationError("not_found", "Unknown issue.");
  return issue;
}

function requireRevision(issue: Issue, expected: number): void {
  if (issue.revision !== expected) {
    throw new MutationError("revision_conflict", "The issue changed since you last read it.", issue.revision);
  }
}

/** Best local guess at a principal's display attributes. */
export function resolvePrincipal(tx: ReadTx, id: string, self: PrincipalRef): PrincipalRef {
  if (id === self.id) return self;
  for (const [, issue] of tx.scan<Issue>("issue/")) {
    for (const p of [issue.assignee, issue.createdBy, issue.updatedBy]) if (p && p.id === id) return p;
  }
  for (const [, c] of tx.scan<Comment>("comment/")) if (c.author.id === id) return c.author;
  return { id, displayName: "", kind: "human" };
}

function checkTitle(title: string | undefined): string | undefined {
  if (title === undefined) return undefined;
  const t = title.trim();
  if (!t || t.length > TITLE_MAX) throw new MutationError("validation_failed", `A title is 1-${TITLE_MAX} characters.`);
  return t;
}

export const createIssue: Mutator<CreateIssueArgs> = (tx, args) => {
  const project = tx.get<Project>(projectKey(args.projectId));
  if (!project) throw new MutationError("not_found", "Unknown project.");
  if (tx.has(issueKey(args.id))) throw new MutationError("duplicate", "An issue with this id already exists.");
  const workflow = tx.get<Workflow>(WORKFLOW_KEY);
  const states = workflow ? [...workflow.states].sort((a, b) => a.position - b.position) : [];
  const state = args.state ?? states[0]?.key;
  if (!state) throw new MutationError("not_found", "The workflow has not loaded yet.");
  if (workflow && !states.some((s) => s.key === state)) {
    throw new MutationError("validation_failed", `Unknown workflow state ${state}.`);
  }
  const { principal, timestamp, allocateIssueNumber } = tx.context;
  const number = allocateIssueNumber ? allocateIssueNumber(args.projectId) : PLACEHOLDER_NUMBER;
  const at = iso(timestamp);
  const issue: Issue = {
    id: args.id,
    projectId: args.projectId,
    number,
    key: number === PLACEHOLDER_NUMBER ? placeholderIssueKey(project.key) : `${project.key}-${number}`,
    title: checkTitle(args.title)!,
    description: args.description ?? "",
    state,
    priority: args.priority ?? "none",
    assignee: args.assigneeId ? resolvePrincipal(tx, args.assigneeId, principal) : null,
    customFields: { ...(args.customFields ?? {}) },
    revision: 1,
    createdAt: at,
    updatedAt: at,
    createdBy: principal,
    updatedBy: principal,
  };
  tx.put(issueKey(issue.id), issue);
};

export const editIssue: Mutator<EditIssueInput> = (tx, args) => {
  const issue = requireIssue(tx, args.issueId);
  requireRevision(issue, args.expectedRevision);
  const { patch } = args;
  if (Object.keys(patch).length === 0) throw new MutationError("validation_failed", "An edit must change something.");
  const { principal, timestamp } = tx.context;
  const next: Issue = {
    ...issue,
    revision: issue.revision + 1,
    updatedAt: iso(timestamp),
    updatedBy: principal,
  };
  if (patch.title !== undefined) next.title = checkTitle(patch.title)!;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.priority !== undefined) next.priority = patch.priority;
  if (patch.assigneeId !== undefined) {
    next.assignee = patch.assigneeId === null ? null : resolvePrincipal(tx, patch.assigneeId, principal);
  }
  // The server merges custom fields (jsonb ||), so an edit only replaces the named fields.
  if (patch.customFields !== undefined) next.customFields = { ...issue.customFields, ...patch.customFields };
  tx.put(issueKey(issue.id), next);
};

export const transitionIssue: Mutator<TransitionIssueInput> = (tx, args) => {
  const issue = requireIssue(tx, args.issueId);
  requireRevision(issue, args.expectedRevision);
  const workflow = tx.get<Workflow>(WORKFLOW_KEY);
  if (!workflow?.transitions.some((t) => t.from === issue.state && t.to === args.toState)) {
    throw new MutationError("workflow_conflict", `The workflow does not allow ${issue.state} → ${args.toState}.`);
  }
  const { principal, timestamp } = tx.context;
  tx.put(issueKey(issue.id), {
    ...issue,
    state: args.toState,
    revision: issue.revision + 1,
    updatedAt: iso(timestamp),
    updatedBy: principal,
  } satisfies Issue);
};

export const addComment: Mutator<AddCommentArgs> = (tx, args) => {
  requireIssue(tx, args.issueId);
  if (tx.has(commentKey(args.id))) throw new MutationError("duplicate", "A comment with this id already exists.");
  const body = args.body.trim();
  if (!body || body.length > COMMENT_MAX) throw new MutationError("validation_failed", `A comment is 1-${COMMENT_MAX} characters.`);
  const { principal, timestamp } = tx.context;
  // Comments do not change the issue's revision on the server either.
  tx.put(commentKey(args.id), {
    id: args.id,
    issueId: args.issueId,
    body,
    author: principal,
    createdAt: iso(timestamp),
  } satisfies Comment);
};

export const projectMutators = {
  "projects.createIssue": createIssue,
  "projects.editIssue": editIssue,
  "projects.transitionIssue": transitionIssue,
  "projects.addComment": addComment,
};
export type ProjectMutators = typeof projectMutators;

/**
 * Fixes a mutation's args before it is queued, so every replay (and the server) sees the same
 * values: drops undefined members (plain JSON) and gives creates a client-chosen `id`.
 */
export function prepareProjectArgs(name: string, args: unknown, env: { randomUUID: () => string }): unknown {
  const plain = JSON.parse(JSON.stringify(args ?? {})) as Record<string, unknown>;
  if ((name === "projects.createIssue" || name === "projects.addComment") && typeof plain.id !== "string") {
    plain.id = env.randomUUID();
  }
  return plain;
}

/**
 * Whether a command that went to approval now shows in server state, so its "awaiting approval"
 * entry can be retired. Edits and transitions count as shown once the issue moved past the
 * revision the user saw and carries the requested values.
 */
export function projectAppliedIn(name: string, server: ReadTx, args: any): boolean {
  switch (name) {
    case "projects.createIssue":
      return server.has(issueKey(args.id));
    case "projects.addComment":
      return server.has(commentKey(args.id));
    case "projects.transitionIssue": {
      const issue = server.get<Issue>(issueKey(args.issueId));
      return !!issue && issue.revision > args.expectedRevision && issue.state === args.toState;
    }
    case "projects.editIssue": {
      const issue = server.get<Issue>(issueKey(args.issueId));
      if (!issue || issue.revision <= args.expectedRevision) return false;
      const p = args.patch ?? {};
      if (p.title !== undefined && issue.title !== String(p.title).trim()) return false;
      if (p.description !== undefined && issue.description !== p.description) return false;
      if (p.priority !== undefined && issue.priority !== p.priority) return false;
      if (p.assigneeId !== undefined && (issue.assignee?.id ?? null) !== p.assigneeId) return false;
      for (const [k, v] of Object.entries(p.customFields ?? {})) if (issue.customFields[k] !== v) return false;
      return true;
    }
    default:
      return false;
  }
}

/** Short human label for a mutation, for pending/awaiting lists. */
export function describeProjectMutation(name: string, args: any, view?: ReadTx): string {
  const issue = args?.issueId && view ? view.get<Issue>(issueKey(args.issueId)) : undefined;
  const ref = issue ? issue.key : "issue";
  switch (name) {
    case "projects.createIssue":
      return `Create “${args.title}”`;
    case "projects.editIssue":
      return `Edit ${ref}`;
    case "projects.transitionIssue":
      return `Move ${ref} to ${args.toState}`;
    case "projects.addComment":
      return `Comment on ${ref}`;
    default:
      return name;
  }
}
