// Projects module operations (API v1). Typed domain methods only: bounded filters, ordering and
// page sizes, no client-defined SQL. Every method takes the caller context built by a transport
// adapter and authorises inside its own transaction.
//
// Reads run here. Mutations are thin wrappers over the command bus, which journals them, takes the
// clock and returns the seq; their public signatures are unchanged for the gadget and HTTP adapters.

import {
  ListCommentsInputSchema,
  ListIssuesInputSchema,
  parseInput,
  TransitionIssueInputSchema,
  type CallerContext,
  type Comment,
  type Issue,
  type Page,
  type Project,
  type Workflow,
} from "@records/contracts";

import { CommandBus } from "../bus/bus.js";
import type { BusHooks } from "../bus/commit.js";
import { contextOf, withContext, type Db } from "../db/context.js";
import { issueSelect, loadIssue, loadWorkflow, toComment, toProject, toIssue } from "../projects/rows.js";
import { authorize } from "./authorize.js";
import { decodeCursor, encodeCursor, likePattern } from "./cursor.js";
import type { Idempotent } from "./idempotency.js";

export class ProjectsService {
  readonly bus: CommandBus;

  constructor(private readonly db: Db, bus?: CommandBus, hooks?: BusHooks) {
    this.bus = bus ?? new CommandBus(db, hooks);
  }

  // -------------------------------------------------------------------------------------------
  // Reads

  async listProjects(caller: CallerContext, datastoreId: string): Promise<Project[]> {
    return withContext(this.db, contextOf(caller, datastoreId), async (tx) => {
      await authorize(tx, caller, datastoreId, "listProjects");
      const rows = await tx`
        SELECT * FROM projects.projects WHERE datastore_id = ${datastoreId} ORDER BY key LIMIT 200`;
      return rows.map(toProject);
    });
  }

  async getWorkflow(caller: CallerContext, datastoreId: string): Promise<Workflow> {
    return withContext(this.db, contextOf(caller, datastoreId), async (tx) => {
      await authorize(tx, caller, datastoreId, "getWorkflow");
      return loadWorkflow(tx, datastoreId);
    });
  }

  async listIssues(caller: CallerContext, datastoreId: string, rawInput: unknown): Promise<Page<Issue>> {
    const input = parseInput(ListIssuesInputSchema, rawInput ?? {});
    return withContext(this.db, contextOf(caller, datastoreId), async (tx) => {
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
    return withContext(this.db, contextOf(caller, datastoreId), async (tx) => {
      await authorize(tx, caller, datastoreId, "getIssue");
      return loadIssue(tx, datastoreId, parseInput(TransitionIssueInputSchema.shape.issueId, issueId));
    });
  }

  async listComments(caller: CallerContext, datastoreId: string, rawInput: unknown): Promise<Page<Comment>> {
    const input = parseInput(ListCommentsInputSchema, rawInput);
    return withContext(this.db, contextOf(caller, datastoreId), async (tx) => {
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
  // Mutations: the command bus authorises with locks, checks idempotency, applies with revision
  // checks, takes the clock, and writes journal, audit and outbox in one transaction.

  async createProject(caller: CallerContext, datastoreId: string, rawInput: unknown): Promise<Project> {
    return (await this.bus.run(caller, datastoreId, "projects.createProject", rawInput, {})).record as Project;
  }

  async createIssue(caller: CallerContext, datastoreId: string, rawInput: unknown, idempotencyKey: string): Promise<Idempotent<Issue>> {
    return this.mutate<Issue>(caller, datastoreId, "projects.createIssue", rawInput, idempotencyKey);
  }

  async editIssue(caller: CallerContext, datastoreId: string, rawInput: unknown, idempotencyKey: string): Promise<Idempotent<Issue>> {
    return this.mutate<Issue>(caller, datastoreId, "projects.editIssue", rawInput, idempotencyKey);
  }

  async transitionIssue(caller: CallerContext, datastoreId: string, rawInput: unknown, idempotencyKey: string): Promise<Idempotent<Issue>> {
    return this.mutate<Issue>(caller, datastoreId, "projects.transitionIssue", rawInput, idempotencyKey);
  }

  async addComment(caller: CallerContext, datastoreId: string, rawInput: unknown, idempotencyKey: string): Promise<Idempotent<Comment>> {
    return this.mutate<Comment>(caller, datastoreId, "projects.addComment", rawInput, idempotencyKey);
  }

  private async mutate<T>(
    caller: CallerContext,
    datastoreId: string,
    name: "projects.createIssue" | "projects.editIssue" | "projects.transitionIssue" | "projects.addComment",
    input: unknown,
    idempotencyKey: string,
  ): Promise<Idempotent<T>> {
    const out = await this.bus.execute(caller, datastoreId, { name, input }, { idempotencyKey });
    return { record: out.record as T, replayed: out.replayed, seq: out.seq };
  }
}

export { seedWorkflow } from "../projects/rows.js";
