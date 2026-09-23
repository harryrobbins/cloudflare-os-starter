// Projects module operations (API v1). Typed domain methods only: bounded filters, ordering and
// page sizes, no client-defined SQL. Every method takes the caller context built by a transport
// adapter and authorises inside its own transaction.

import {
  AddCommentInputSchema,
  CreateIssueInputSchema,
  CreateProjectInputSchema,
  EditIssueInputSchema,
  IdempotencyKeySchema,
  ListCommentsInputSchema,
  ListIssuesInputSchema,
  parseInput,
  RecordsError,
  TransitionIssueInputSchema,
  type CallerContext,
  type Comment,
  type Issue,
  type Page,
  type Priority,
  type PrincipalRef,
  type Project,
  type Workflow,
  type WorkflowCategory,
} from "@records/contracts";

import { withContext, type Db, type Tx } from "../db/context.js";
import { authorize, requireWritable } from "./authorize.js";
import { decodeCursor, encodeCursor, likePattern } from "./cursor.js";
import { idempotent, type Idempotent } from "./idempotency.js";
import { audit, emit } from "./journal.js";

type Row = Record<string, unknown>;

const iso = (v: unknown) => (v as Date).toISOString();

function ref(row: Row, prefix: string): PrincipalRef {
  return {
    id: row[`${prefix}_id`] as string,
    displayName: row[`${prefix}_name`] as string,
    kind: row[`${prefix}_kind`] as "human" | "service",
  };
}

function toProject(r: Row): Project {
  return {
    id: r.id as string,
    key: r.key as string,
    name: r.name as string,
    description: r.description as string,
    revision: r.revision as number,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function toIssue(r: Row): Issue {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    number: r.number as number,
    key: `${r.project_key as string}-${r.number as number}`,
    title: r.title as string,
    description: r.description as string,
    state: r.state as string,
    priority: r.priority as Priority,
    assignee: r.assignee_id ? ref(r, "assignee") : null,
    customFields: r.custom_fields as Issue["customFields"],
    revision: r.revision as number,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    createdBy: ref(r, "creator"),
    updatedBy: ref(r, "updater"),
  };
}

function toComment(r: Row): Comment {
  return { id: r.id as string, issueId: r.issue_id as string, body: r.body as string, author: ref(r, "author"), createdAt: iso(r.created_at) };
}

/** SELECT list for issues with display joins. `WHERE` is appended by callers. */
function issueSelect(tx: Tx, datastoreId: string) {
  return tx`
    SELECT i.*, p.key AS project_key,
           a.id AS assignee_id, a.display_name AS assignee_name, a.kind AS assignee_kind,
           c.id AS creator_id, c.display_name AS creator_name, c.kind AS creator_kind,
           u.id AS updater_id, u.display_name AS updater_name, u.kind AS updater_kind
      FROM projects.issues i
      JOIN projects.projects p ON p.id = i.project_id AND p.datastore_id = i.datastore_id
      LEFT JOIN records.principals a ON a.id = i.assignee_id
      JOIN records.principals c ON c.id = i.created_by
      JOIN records.principals u ON u.id = i.updated_by
     WHERE i.datastore_id = ${datastoreId}`;
}

async function loadIssue(tx: Tx, datastoreId: string, issueId: string): Promise<Issue> {
  const [row] = await tx`${issueSelect(tx, datastoreId)} AND i.id = ${issueId}`;
  if (!row) throw new RecordsError("not_found", "Unknown issue.");
  return toIssue(row);
}

async function requireAssignable(tx: Tx, datastoreId: string, assigneeId: string | null | undefined): Promise<void> {
  if (!assigneeId) return;
  const [m] = await tx`
    SELECT 1 FROM records.memberships m JOIN records.principals p ON p.id = m.principal_id
     WHERE m.datastore_id = ${datastoreId} AND m.principal_id = ${assigneeId} AND p.status = 'active'`;
  if (!m) throw new RecordsError("validation_failed", "The assignee is not a member of this datastore.");
}

async function validateCustomFields(tx: Tx, datastoreId: string, fields: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const defs = await tx`
    SELECT key, type, options FROM projects.custom_fields WHERE datastore_id = ${datastoreId} AND key = ANY(${keys})`;
  const byKey = new Map(defs.map((d) => [d.key as string, d]));
  for (const [key, value] of Object.entries(fields)) {
    const def = byKey.get(key);
    if (!def) throw new RecordsError("validation_failed", `Unknown custom field ${key}.`);
    if (value === null) continue;
    const ok =
      (def.type === "text" && typeof value === "string") ||
      (def.type === "number" && typeof value === "number") ||
      (def.type === "boolean" && typeof value === "boolean") ||
      (def.type === "enum" && typeof value === "string" && (def.options as string[]).includes(value));
    if (!ok) throw new RecordsError("validation_failed", `Custom field ${key} expects ${def.type as string}.`);
  }
}

function requireKey(key: unknown): string {
  return parseInput(IdempotencyKeySchema, key);
}

export class ProjectsService {
  constructor(private readonly db: Db) {}

  // -------------------------------------------------------------------------------------------
  // Reads

  async listProjects(caller: CallerContext, datastoreId: string): Promise<Project[]> {
    return withContext(this.db, { orgId: caller.orgId, datastoreId }, async (tx) => {
      await authorize(tx, caller, datastoreId, "listProjects");
      const rows = await tx`
        SELECT * FROM projects.projects WHERE datastore_id = ${datastoreId} ORDER BY key LIMIT 200`;
      return rows.map(toProject);
    });
  }

  async getWorkflow(caller: CallerContext, datastoreId: string): Promise<Workflow> {
    return withContext(this.db, { orgId: caller.orgId, datastoreId }, async (tx) => {
      await authorize(tx, caller, datastoreId, "getWorkflow");
      const states = await tx`
        SELECT key, name, category, position FROM projects.workflow_states
         WHERE datastore_id = ${datastoreId} ORDER BY position, key`;
      const transitions = await tx`
        SELECT from_state, to_state FROM projects.workflow_transitions
         WHERE datastore_id = ${datastoreId} ORDER BY from_state, to_state`;
      return {
        states: states.map((s) => ({ key: s.key as string, name: s.name as string, category: s.category as WorkflowCategory, position: s.position as number })),
        transitions: transitions.map((t) => ({ from: t.from_state as string, to: t.to_state as string })),
      };
    });
  }

  async listIssues(caller: CallerContext, datastoreId: string, rawInput: unknown): Promise<Page<Issue>> {
    const input = parseInput(ListIssuesInputSchema, rawInput ?? {});
    return withContext(this.db, { orgId: caller.orgId, datastoreId }, async (tx) => {
      await authorize(tx, caller, datastoreId, "listIssues");
      const after = decodeCursor(`issues:${input.order}`, input.cursor);
      const filters = [
        input.projectId ? tx`AND i.project_id = ${input.projectId}` : tx``,
        input.state ? tx`AND i.state = ${input.state}` : tx``,
        input.assigneeId ? tx`AND i.assignee_id = ${input.assigneeId}` : tx``,
        input.query ? tx`AND i.title ILIKE ${likePattern(input.query)}` : tx``,
      ];
      let rows;
      if (input.order === "updated_desc") {
        const page = after ? tx`AND (i.updated_at, i.id) < (${new Date(after[0] as string)}, ${after[1] as string})` : tx``;
        rows = await tx`${issueSelect(tx, datastoreId)} ${filters[0]!} ${filters[1]!} ${filters[2]!} ${filters[3]!} ${page}
          ORDER BY i.updated_at DESC, i.id DESC LIMIT ${input.limit + 1}`;
      } else {
        const page = after ? tx`AND (p.key, i.number) > (${after[0] as string}, ${after[1] as number})` : tx``;
        rows = await tx`${issueSelect(tx, datastoreId)} ${filters[0]!} ${filters[1]!} ${filters[2]!} ${filters[3]!} ${page}
          ORDER BY p.key, i.number LIMIT ${input.limit + 1}`;
      }
      const items = rows.slice(0, input.limit).map(toIssue);
      const last = items.at(-1);
      const nextCursor = rows.length > input.limit && last
        ? input.order === "updated_desc"
          ? encodeCursor(`issues:${input.order}`, [last.updatedAt, last.id])
          : encodeCursor(`issues:${input.order}`, [last.key.split("-")[0]!, last.number])
        : null;
      return { items, nextCursor };
    });
  }

  async getIssue(caller: CallerContext, datastoreId: string, issueId: string): Promise<Issue> {
    return withContext(this.db, { orgId: caller.orgId, datastoreId }, async (tx) => {
      await authorize(tx, caller, datastoreId, "getIssue");
      return loadIssue(tx, datastoreId, parseInput(TransitionIssueInputSchema.shape.issueId, issueId));
    });
  }

  async listComments(caller: CallerContext, datastoreId: string, rawInput: unknown): Promise<Page<Comment>> {
    const input = parseInput(ListCommentsInputSchema, rawInput);
    return withContext(this.db, { orgId: caller.orgId, datastoreId }, async (tx) => {
      await authorize(tx, caller, datastoreId, "listComments");
      const after = decodeCursor("comments", input.cursor);
      const page = after ? tx`AND (c.created_at, c.id) > (${new Date(after[0] as string)}, ${after[1] as string})` : tx``;
      const rows = await tx`
        SELECT c.*, p.id AS author_id, p.display_name AS author_name, p.kind AS author_kind
          FROM projects.comments c JOIN records.principals p ON p.id = c.author_id
         WHERE c.datastore_id = ${datastoreId} AND c.issue_id = ${input.issueId} ${page}
         ORDER BY c.created_at, c.id LIMIT ${input.limit + 1}`;
      const items = rows.slice(0, input.limit).map(toComment);
      const last = items.at(-1);
      return { items, nextCursor: rows.length > input.limit && last ? encodeCursor("comments", [last.createdAt, last.id]) : null };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Mutations. Each: authorise with locks → idempotency → apply with revision checks → audit +
  // outbox, all in one transaction.

  async createProject(caller: CallerContext, datastoreId: string, rawInput: unknown): Promise<Project> {
    const input = parseInput(CreateProjectInputSchema, rawInput);
    return withContext(this.db, { orgId: caller.orgId, datastoreId }, async (tx) => {
      requireWritable(await authorize(tx, caller, datastoreId, "createProject", { lock: true }));
      const [row] = await tx`
        INSERT INTO projects.projects (org_id, datastore_id, id, key, name, description, created_by, updated_by)
        VALUES (${caller.orgId}, ${datastoreId}, ${crypto.randomUUID()}, ${input.key}, ${input.name}, ${input.description},
                ${caller.principalId}, ${caller.principalId})
        RETURNING *`;
      const project = toProject(row!);
      await audit(tx, caller, { datastoreId, operation: "createProject", targetType: "project", targetId: project.id, summary: `Created project ${project.key}` });
      await emit(tx, caller.orgId, { datastoreId, eventType: "project.created", entityType: "project", entityId: project.id, revision: 1 });
      return project;
    });
  }

  async createIssue(caller: CallerContext, datastoreId: string, rawInput: unknown, idempotencyKey: string): Promise<Idempotent<Issue>> {
    const input = parseInput(CreateIssueInputSchema, rawInput);
    const key = requireKey(idempotencyKey);
    return withContext(this.db, { orgId: caller.orgId, datastoreId }, async (tx) => {
      requireWritable(await authorize(tx, caller, datastoreId, "createIssue", { lock: true }));
      return idempotent(tx, caller, datastoreId, "createIssue", key, rawInput, async () => {
        await requireAssignable(tx, datastoreId, input.assigneeId);
        await validateCustomFields(tx, datastoreId, input.customFields);
        // Row lock on the project serialises number allocation within it.
        const [project] = await tx`
          UPDATE projects.projects SET next_issue_number = next_issue_number + 1
           WHERE datastore_id = ${datastoreId} AND id = ${input.projectId}
          RETURNING next_issue_number - 1 AS number`;
        if (!project) throw new RecordsError("not_found", "Unknown project.");
        let state = input.state;
        if (!state) {
          const [first] = await tx`
            SELECT key FROM projects.workflow_states WHERE datastore_id = ${datastoreId} ORDER BY position LIMIT 1`;
          state = first!.key as string;
        }
        const id = crypto.randomUUID();
        await tx`
          INSERT INTO projects.issues (org_id, datastore_id, id, project_id, number, title, description, state, priority,
                                       assignee_id, custom_fields, created_by, updated_by)
          VALUES (${caller.orgId}, ${datastoreId}, ${id}, ${input.projectId}, ${project.number as number}, ${input.title},
                  ${input.description}, ${state}, ${input.priority}, ${input.assigneeId}, ${tx.json(input.customFields)},
                  ${caller.principalId}, ${caller.principalId})`;
        const issue = await loadIssue(tx, datastoreId, id);
        await audit(tx, caller, { datastoreId, operation: "createIssue", targetType: "issue", targetId: id, summary: `Created ${issue.key}` });
        await emit(tx, caller.orgId, { datastoreId, eventType: "issue.created", entityType: "issue", entityId: id, revision: 1 });
        return issue;
      });
    });
  }

  async editIssue(caller: CallerContext, datastoreId: string, rawInput: unknown, idempotencyKey: string): Promise<Idempotent<Issue>> {
    const input = parseInput(EditIssueInputSchema, rawInput);
    const key = requireKey(idempotencyKey);
    return withContext(this.db, { orgId: caller.orgId, datastoreId }, async (tx) => {
      requireWritable(await authorize(tx, caller, datastoreId, "editIssue", { lock: true }));
      return idempotent(tx, caller, datastoreId, "editIssue", key, rawInput, async () => {
        const { patch } = input;
        if (patch.assigneeId !== undefined) await requireAssignable(tx, datastoreId, patch.assigneeId);
        if (patch.customFields) await validateCustomFields(tx, datastoreId, patch.customFields);
        const updated = await tx`
          UPDATE projects.issues SET
            title = coalesce(${patch.title ?? null}, title),
            description = coalesce(${patch.description ?? null}, description),
            priority = coalesce(${patch.priority ?? null}, priority),
            assignee_id = CASE WHEN ${patch.assigneeId !== undefined} THEN ${patch.assigneeId ?? null}::uuid ELSE assignee_id END,
            custom_fields = custom_fields || ${tx.json(patch.customFields ?? {})},
            revision = revision + 1, updated_by = ${caller.principalId}, updated_at = now()
          WHERE datastore_id = ${datastoreId} AND id = ${input.issueId} AND revision = ${input.expectedRevision}
          RETURNING revision`;
        if (updated.count === 0) await revisionConflict(tx, datastoreId, input.issueId);
        const issue = await loadIssue(tx, datastoreId, input.issueId);
        await audit(tx, caller, {
          datastoreId, operation: "editIssue", targetType: "issue", targetId: issue.id,
          summary: `Edited ${issue.key}`, detail: { fields: Object.keys(patch) },
        });
        await emit(tx, caller.orgId, { datastoreId, eventType: "issue.updated", entityType: "issue", entityId: issue.id, revision: issue.revision });
        return issue;
      });
    });
  }

  async transitionIssue(caller: CallerContext, datastoreId: string, rawInput: unknown, idempotencyKey: string): Promise<Idempotent<Issue>> {
    const input = parseInput(TransitionIssueInputSchema, rawInput);
    const key = requireKey(idempotencyKey);
    return withContext(this.db, { orgId: caller.orgId, datastoreId }, async (tx) => {
      requireWritable(await authorize(tx, caller, datastoreId, "transitionIssue", { lock: true }));
      return idempotent(tx, caller, datastoreId, "transitionIssue", key, rawInput, async () => {
        const [current] = await tx`
          SELECT state, revision FROM projects.issues
           WHERE datastore_id = ${datastoreId} AND id = ${input.issueId} FOR UPDATE`;
        if (!current) throw new RecordsError("not_found", "Unknown issue.");
        if (current.revision !== input.expectedRevision) {
          throw new RecordsError("revision_conflict", "The issue changed since you last read it.", undefined, current.revision as number);
        }
        const [allowed] = await tx`
          SELECT 1 FROM projects.workflow_transitions
           WHERE datastore_id = ${datastoreId} AND from_state = ${current.state as string} AND to_state = ${input.toState}`;
        if (!allowed) {
          throw new RecordsError("workflow_conflict", `The workflow does not allow ${current.state as string} → ${input.toState}.`);
        }
        await tx`
          UPDATE projects.issues SET state = ${input.toState}, revision = revision + 1,
                 updated_by = ${caller.principalId}, updated_at = now()
           WHERE datastore_id = ${datastoreId} AND id = ${input.issueId}`;
        const issue = await loadIssue(tx, datastoreId, input.issueId);
        await audit(tx, caller, {
          datastoreId, operation: "transitionIssue", targetType: "issue", targetId: issue.id,
          summary: `Moved ${issue.key} from ${current.state as string} to ${input.toState}`,
        });
        await emit(tx, caller.orgId, { datastoreId, eventType: "issue.transitioned", entityType: "issue", entityId: issue.id, revision: issue.revision });
        return issue;
      });
    });
  }

  async addComment(caller: CallerContext, datastoreId: string, rawInput: unknown, idempotencyKey: string): Promise<Idempotent<Comment>> {
    const input = parseInput(AddCommentInputSchema, rawInput);
    const key = requireKey(idempotencyKey);
    return withContext(this.db, { orgId: caller.orgId, datastoreId }, async (tx) => {
      requireWritable(await authorize(tx, caller, datastoreId, "addComment", { lock: true }));
      return idempotent(tx, caller, datastoreId, "addComment", key, rawInput, async () => {
        const [issue] = await tx`SELECT id FROM projects.issues WHERE datastore_id = ${datastoreId} AND id = ${input.issueId}`;
        if (!issue) throw new RecordsError("not_found", "Unknown issue.");
        const id = crypto.randomUUID();
        const [row] = await tx`
          WITH c AS (
            INSERT INTO projects.comments (org_id, datastore_id, id, issue_id, body, author_id)
            VALUES (${caller.orgId}, ${datastoreId}, ${id}, ${input.issueId}, ${input.body}, ${caller.principalId})
            RETURNING *)
          SELECT c.*, p.id AS author_id, p.display_name AS author_name, p.kind AS author_kind
            FROM c JOIN records.principals p ON p.id = c.author_id`;
        const comment = toComment(row!);
        await audit(tx, caller, { datastoreId, operation: "addComment", targetType: "comment", targetId: id, summary: "Added a comment" });
        await emit(tx, caller.orgId, { datastoreId, eventType: "comment.created", entityType: "comment", entityId: id, revision: 1 });
        return comment;
      });
    });
  }
}

async function revisionConflict(tx: Tx, datastoreId: string, issueId: string): Promise<never> {
  const [row] = await tx`SELECT revision FROM projects.issues WHERE datastore_id = ${datastoreId} AND id = ${issueId}`;
  if (!row) throw new RecordsError("not_found", "Unknown issue.");
  throw new RecordsError("revision_conflict", "The issue changed since you last read it.", undefined, row.revision as number);
}

/** Seed the default workflow for a new datastore (called inside createDatastore). */
export async function seedWorkflow(tx: Tx, orgId: string, datastoreId: string, workflow: Workflow): Promise<void> {
  for (const s of workflow.states) {
    await tx`
      INSERT INTO projects.workflow_states (org_id, datastore_id, key, name, category, position)
      VALUES (${orgId}, ${datastoreId}, ${s.key}, ${s.name}, ${s.category}, ${s.position})`;
  }
  for (const t of workflow.transitions) {
    await tx`
      INSERT INTO projects.workflow_transitions (org_id, datastore_id, from_state, to_state)
      VALUES (${orgId}, ${datastoreId}, ${t.from}, ${t.to})`;
  }
}
