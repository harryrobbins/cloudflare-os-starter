// Projects module command handlers. Each parses its input (before any transaction), then in the
// command's transaction reads and locks what it changes (FOR UPDATE), checks the expected revision
// and business rules, and returns a Plan: journal entries in wire field names, audit and outbox
// records, and a `write` that applies the current-row changes once the clock has given it a seq.
// Handlers take every lock they need before the clock (FOR UPDATE), so the clock stays the last
// lock; journaled content is written only in `write`, once the seq is known.
//
// Journal `after`/`before` shapes (wire names):
//   issue create   after = {projectId, number, key, title, description, state, priority, assigneeId, customFields}
//   issue update   only the fields that changed; customFields is the full merged object
//   project create after = {key, name, description}
//   comment create after = {issueId, body, authorId}

import {
  AddCommentInputSchema,
  canonicalJson,
  CreateIssueInputSchema,
  CreateProjectInputSchema,
  EditIssueInputSchema,
  parseInput,
  RecordsError,
  RevisionSchema,
  TransitionIssueInputSchema,
  type CallerContext,
  type Comment,
  type CommandName,
  type DomainOperation,
  type Issue,
  type Project,
} from "@records/contracts";
import type { z } from "zod";

import type { Tx } from "../db/context.js";
import type { Plan } from "../bus/commit.js";
import { loadIssue, requireAssignable, toComment, toProject, validateCustomFields } from "./rows.js";

/** Commands the bus accepts: the frozen CommandName set plus management commands it also journals. */
export type ProjectsCommandName = CommandName | "projects.createProject";

export type Handler<I, T> = {
  /** The operation authorize() checks and the idempotency scope uses. */
  operation: DomainOperation;
  /** Changes an existing record, so it needs an expected revision (If-Match). */
  revisioned: boolean;
  parse(input: unknown): I;
  /**
   * Present only on handlers that may apply without an expected revision ("last write wins"): the
   * Jira surface's edits and transitions, which carry no If-Match (canonical plan §7). The bus
   * uses it instead of `parse` only for `via: 'jira'` with `lastWriteWins` and no revision given;
   * the handler then locks the row and applies to whatever revision is current, still journaling
   * before/after and still enforcing the workflow. Every other channel keeps requiring a revision.
   */
  parseUnconditional?(input: unknown): I;
  prepare(tx: Tx, caller: CallerContext, datastoreId: string, input: I): Promise<Plan<T>>;
};

function handler<S extends z.ZodType, T>(
  operation: DomainOperation,
  schema: S,
  revisioned: boolean,
  prepare: Handler<z.output<S>, T>["prepare"],
): Handler<z.output<S>, T> {
  return { operation, revisioned, parse: (input) => parseInput(schema, input), prepare };
}

/**
 * A revisioned handler that may also run last-write-wins. `h` is built with `expectedRevision`
 * optional; its ordinary `parse` is replaced by `strict`, which requires it, so only the bus's
 * explicit Jira path (parseUnconditional) ever reaches `prepare` without a revision.
 */
function lastWriteWins<I, T>(h: Handler<I, T>, strict: z.ZodType): Handler<I, T> {
  return { ...h, parse: (input) => parseInput(strict, input) as I, parseUnconditional: h.parse };
}

function revisionConflict(current: number): never {
  throw new RecordsError("revision_conflict", "The issue changed since you last read it.", undefined, current);
}

const createIssue = handler("createIssue", CreateIssueInputSchema, false, async (tx, caller, datastoreId, input): Promise<Plan<Issue>> => {
  await requireAssignable(tx, datastoreId, input.assigneeId);
  await validateCustomFields(tx, datastoreId, input.customFields);
  // The project row lock serialises issue-number allocation within the project.
  const [project] = await tx`
    SELECT key, next_issue_number FROM projects.projects
     WHERE datastore_id = ${datastoreId} AND id = ${input.projectId} FOR UPDATE`;
  if (!project) throw new RecordsError("not_found", "Unknown project.");
  let state = input.state;
  if (!state) {
    const [first] = await tx`
      SELECT key FROM projects.workflow_states WHERE datastore_id = ${datastoreId} ORDER BY position LIMIT 1`;
    if (!first) throw new RecordsError("validation_failed", "This datastore has no workflow.");
    state = first.key as string;
  } else {
    const [known] = await tx`SELECT 1 FROM projects.workflow_states WHERE datastore_id = ${datastoreId} AND key = ${state}`;
    if (!known) throw new RecordsError("validation_failed", `Unknown workflow state ${state}.`);
  }
  const id = input.id ?? crypto.randomUUID();
  if (input.id) {
    const [taken] = await tx`SELECT 1 FROM projects.issues WHERE id = ${id}`;
    if (taken) throw new RecordsError("duplicate", "An issue with that ID already exists.");
  }
  const number = project.next_issue_number as number;
  const key = `${project.key as string}-${number}`;
  // Bookkeeping, not journaled content, and the row is already locked: allocate before the clock.
  await tx`
    UPDATE projects.projects SET next_issue_number = next_issue_number + 1
     WHERE datastore_id = ${datastoreId} AND id = ${input.projectId}`;
  const after = {
    projectId: input.projectId, number, key, title: input.title, description: input.description, state,
    priority: input.priority, assigneeId: input.assigneeId, customFields: input.customFields,
  };
  return {
    changes: [{ entityType: "issue", entityId: id, entityRev: 1, op: "create", after, before: null }],
    audit: { operation: "createIssue", targetType: "issue", targetId: id, summary: `Created ${key}` },
    events: [{ eventType: "issue.created", entityType: "issue", entityId: id, revision: 1 }],
    async write(seq) {
      await tx`
        INSERT INTO projects.issues (org_id, datastore_id, id, project_id, number, title, description, state, priority,
                                     assignee_id, custom_fields, created_by, updated_by, last_seq)
        VALUES (${caller.orgId}, ${datastoreId}, ${id}, ${input.projectId}, ${number}, ${input.title}, ${input.description},
                ${state}, ${input.priority}, ${input.assigneeId}, ${tx.json(input.customFields)},
                ${caller.principalId}, ${caller.principalId}, ${seq})`;
      return loadIssue(tx, datastoreId, id);
    },
  };
});

const EDITABLE = ["title", "description", "priority", "assigneeId", "customFields"] as const;

const editIssue = lastWriteWins(handler("editIssue", EditIssueInputSchema.extend({ expectedRevision: RevisionSchema.optional() }), true, async (tx, caller, datastoreId, input): Promise<Plan<Issue>> => {
  const { patch } = input;
  if (patch.assigneeId !== undefined) await requireAssignable(tx, datastoreId, patch.assigneeId);
  if (patch.customFields) await validateCustomFields(tx, datastoreId, patch.customFields);
  const [row] = await tx`
    SELECT i.title, i.description, i.priority, i.assignee_id, i.custom_fields, i.revision, p.key || '-' || i.number AS issue_key
      FROM projects.issues i JOIN projects.projects p ON p.id = i.project_id
     WHERE i.datastore_id = ${datastoreId} AND i.id = ${input.issueId} FOR UPDATE OF i`;
  if (!row) throw new RecordsError("not_found", "Unknown issue.");
  // Undefined only on the last-write-wins path (parseUnconditional): the row lock above makes the
  // change apply to the revision that is current now.
  if (input.expectedRevision !== undefined && row.revision !== input.expectedRevision) revisionConflict(row.revision as number);

  const current: Record<(typeof EDITABLE)[number], unknown> = {
    title: row.title, description: row.description, priority: row.priority,
    assigneeId: row.assignee_id ?? null, customFields: row.custom_fields,
  };
  const next = {
    title: patch.title ?? (current.title as string),
    description: patch.description ?? (current.description as string),
    priority: patch.priority ?? (current.priority as string),
    assigneeId: patch.assigneeId !== undefined ? patch.assigneeId : (current.assigneeId as string | null),
    customFields: { ...(current.customFields as Record<string, unknown>), ...(patch.customFields ?? {}) },
  };
  const after: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};
  for (const field of EDITABLE) {
    if (canonicalJson(next[field]) !== canonicalJson(current[field])) {
      after[field] = next[field];
      before[field] = current[field];
    }
  }
  const revision = (row.revision as number) + 1;
  return {
    changes: [{ entityType: "issue", entityId: input.issueId, entityRev: revision, op: "update", after, before }],
    audit: { operation: "editIssue", targetType: "issue", targetId: input.issueId, summary: `Edited ${row.issue_key as string}`, detail: { fields: Object.keys(patch) } },
    events: [{ eventType: "issue.updated", entityType: "issue", entityId: input.issueId, revision }],
    async write(seq) {
      await tx`
        UPDATE projects.issues SET
          title = ${next.title}, description = ${next.description}, priority = ${next.priority},
          assignee_id = ${next.assigneeId}::uuid, custom_fields = ${tx.json(next.customFields as never)},
          revision = ${revision}, last_seq = ${seq}, updated_by = ${caller.principalId}, updated_at = now()
         WHERE datastore_id = ${datastoreId} AND id = ${input.issueId}`;
      return loadIssue(tx, datastoreId, input.issueId);
    },
  };
}), EditIssueInputSchema);

const transitionIssue = lastWriteWins(handler("transitionIssue", TransitionIssueInputSchema.extend({ expectedRevision: RevisionSchema.optional() }), true, async (tx, caller, datastoreId, input): Promise<Plan<Issue>> => {
  const [row] = await tx`
    SELECT i.state, i.revision, p.key || '-' || i.number AS issue_key
      FROM projects.issues i JOIN projects.projects p ON p.id = i.project_id
     WHERE i.datastore_id = ${datastoreId} AND i.id = ${input.issueId} FOR UPDATE OF i`;
  if (!row) throw new RecordsError("not_found", "Unknown issue.");
  // Undefined only on the last-write-wins path (parseUnconditional): the row lock above makes the
  // change apply to the revision that is current now.
  if (input.expectedRevision !== undefined && row.revision !== input.expectedRevision) revisionConflict(row.revision as number);
  const from = row.state as string;
  const [allowed] = await tx`
    SELECT 1 FROM projects.workflow_transitions
     WHERE datastore_id = ${datastoreId} AND from_state = ${from} AND to_state = ${input.toState}`;
  if (!allowed) throw new RecordsError("workflow_conflict", `The workflow does not allow ${from} → ${input.toState}.`);
  const revision = (row.revision as number) + 1;
  return {
    changes: [{ entityType: "issue", entityId: input.issueId, entityRev: revision, op: "update", after: { state: input.toState }, before: { state: from } }],
    audit: { operation: "transitionIssue", targetType: "issue", targetId: input.issueId, summary: `Moved ${row.issue_key as string} from ${from} to ${input.toState}` },
    events: [{ eventType: "issue.transitioned", entityType: "issue", entityId: input.issueId, revision }],
    async write(seq) {
      await tx`
        UPDATE projects.issues SET state = ${input.toState}, revision = ${revision}, last_seq = ${seq},
               updated_by = ${caller.principalId}, updated_at = now()
         WHERE datastore_id = ${datastoreId} AND id = ${input.issueId}`;
      return loadIssue(tx, datastoreId, input.issueId);
    },
  };
}), TransitionIssueInputSchema);

const addComment = handler("addComment", AddCommentInputSchema, false, async (tx, caller, datastoreId, input): Promise<Plan<Comment>> => {
  // No lock on the issue: the comment's foreign key takes the key-share lock it needs.
  const [issue] = await tx`SELECT id FROM projects.issues WHERE datastore_id = ${datastoreId} AND id = ${input.issueId}`;
  if (!issue) throw new RecordsError("not_found", "Unknown issue.");
  const id = input.id ?? crypto.randomUUID();
  if (input.id) {
    const [taken] = await tx`SELECT 1 FROM projects.comments WHERE id = ${id}`;
    if (taken) throw new RecordsError("duplicate", "A comment with that ID already exists.");
  }
  return {
    changes: [{ entityType: "comment", entityId: id, entityRev: 1, op: "create", after: { issueId: input.issueId, body: input.body, authorId: caller.principalId }, before: null }],
    audit: { operation: "addComment", targetType: "comment", targetId: id, summary: "Added a comment" },
    events: [{ eventType: "comment.created", entityType: "comment", entityId: id, revision: 1 }],
    async write(seq) {
      const [created] = await tx`
        WITH c AS (
          INSERT INTO projects.comments (org_id, datastore_id, id, issue_id, body, author_id, last_seq)
          VALUES (${caller.orgId}, ${datastoreId}, ${id}, ${input.issueId}, ${input.body}, ${caller.principalId}, ${seq})
          RETURNING *)
        SELECT c.*, p.id AS author_id, p.display_name AS author_name, p.kind AS author_kind
          FROM c JOIN records.principals p ON p.id = c.author_id`;
      return toComment(created!);
    },
  };
});

/** A management command, but it creates a journaled entity, so it is journaled like the rest. */
const createProject = handler("createProject", CreateProjectInputSchema, false, async (tx, caller, datastoreId, input): Promise<Plan<Project>> => {
  const id = crypto.randomUUID();
  return {
    changes: [{ entityType: "project", entityId: id, entityRev: 1, op: "create", after: { key: input.key, name: input.name, description: input.description }, before: null }],
    audit: { operation: "createProject", targetType: "project", targetId: id, summary: `Created project ${input.key}` },
    events: [{ eventType: "project.created", entityType: "project", entityId: id, revision: 1 }],
    async write(seq) {
      const [row] = await tx`
        INSERT INTO projects.projects (org_id, datastore_id, id, key, name, description, created_by, updated_by, last_seq)
        VALUES (${caller.orgId}, ${datastoreId}, ${id}, ${input.key}, ${input.name}, ${input.description},
                ${caller.principalId}, ${caller.principalId}, ${seq})
        RETURNING *`;
      return toProject(row!);
    },
  };
});

export const PROJECTS_HANDLERS: Record<ProjectsCommandName, Handler<unknown, unknown>> = {
  "projects.createIssue": createIssue as Handler<unknown, unknown>,
  "projects.editIssue": editIssue as Handler<unknown, unknown>,
  "projects.transitionIssue": transitionIssue as Handler<unknown, unknown>,
  "projects.addComment": addComment as Handler<unknown, unknown>,
  "projects.createProject": createProject as Handler<unknown, unknown>,
};
