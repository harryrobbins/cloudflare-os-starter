// The Records service behind the Jira-compatible surface: a JiraPort (@records/jira) bound to one
// authenticated caller and one datastore.
//
// Reads run in the caller's trusted context (RLS by principal) after authorize(), exactly as the
// native API's reads do, and return the numeric `jira_id` of each record beside its DTO. Writes go
// through the command bus with `via: 'jira'` and the router's idempotency key:
//   - edits and transitions carry no revision: `lastWriteWins` applies them to the revision that is
//     current inside the command's transaction (the row is locked; the journal keeps before/after;
//     the workflow rule still applies);
//   - approvals do not apply on this path (the caller is a service credential over HTTP), so an
//     outcome is applied, rejected or conflict, never pending;
//   - derived idempotency keys (`idempotencyKeyDerived`) are stored like client keys, for the
//     standard retention. A shorter retention for them is a possible later optimisation.

import {
  RecordsError,
  type AddCommentInput,
  type CallerContext,
  type CommandName,
  type Comment,
  type CreateIssueInput,
  type DomainOperation,
  type Issue,
  type MutationOutcome,
  type WorkflowCategory,
} from "@records/contracts";
import {
  authorize,
  contextOf,
  issueSelect,
  jiraIdOf,
  searchIssues,
  settle,
  toJiraComment,
  toJiraIssue,
  toProject,
  withContext,
  type AppliedOutcome,
  type RecordsService,
  type Tx,
} from "@records/core";
import type {
  JiraComment,
  JiraCustomFieldDef,
  JiraEditInput,
  JiraIssue,
  JiraPort,
  JiraProject,
  JiraTransitionInput,
  JiraUser,
  JiraWorkflow,
  JiraWriteOptions,
} from "@records/jira";

const ISSUE_KEY = /^([A-Z][A-Z0-9]{1,9})-([1-9][0-9]{0,9})$/;
const NUMERIC_ID = /^[1-9][0-9]{0,17}$/;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Row = Record<string, unknown>;

function toUser(r: Row): JiraUser {
  const expired = r.expires_at ? (r.expires_at as Date).getTime() <= Date.now() : false;
  return {
    principal: { id: r.id as string, displayName: r.display_name as string, kind: r.kind as "human" | "service" },
    active: r.status === "active" && !expired,
    emailAddress: (r.email as string | null) ?? null,
  };
}

export function createJiraPort(service: RecordsService, caller: CallerContext, datastoreId: string): JiraPort {
  const db = service.db;

  /** A read in the caller's datastore context, authorised for `operation`. */
  const read = <T>(operation: DomainOperation, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    withContext(db, contextOf(caller, datastoreId), async (tx) => {
      await authorize(tx, caller, datastoreId, operation);
      return fn(tx);
    });

  /** The jira_id of a record the caller has just written (RLS still applies). */
  const jiraIdFor = (table: "issues" | "comments", id: string): Promise<number> =>
    withContext(db, contextOf(caller, datastoreId), async (tx) => {
      const [row] = table === "issues"
        ? await tx`SELECT jira_id FROM projects.issues WHERE datastore_id = ${datastoreId} AND id = ${id}`
        : await tx`SELECT jira_id FROM projects.comments WHERE datastore_id = ${datastoreId} AND id = ${id}`;
      if (!row) throw new RecordsError("not_found", "Unknown record.");
      return jiraIdOf(row);
    });

  async function write<T extends { id: string }, R>(
    name: CommandName,
    input: unknown,
    options: JiraWriteOptions,
    lastWriteWins: boolean,
    finish: (record: T) => Promise<R>,
  ): Promise<MutationOutcome<R>> {
    const outcome = await settle<T>(
      service.commands.execute(caller, datastoreId, { name, input }, {
        idempotencyKey: options.idempotencyKey,
        via: "jira",
        ...(lastWriteWins ? { lastWriteWins: true } : {}),
      }) as Promise<AppliedOutcome<T>>,
    );
    if (outcome.status !== "applied") return outcome;
    return { status: "applied", record: await finish(outcome.record), replayed: outcome.replayed };
  }

  const withIssueJiraId = async (issue: Issue): Promise<JiraIssue> => ({
    ...issue,
    jiraId: await jiraIdFor("issues", issue.id),
  });

  return {
    async myself() {
      return withContext(db, contextOf(caller), async (tx) => {
        const [p] = await tx`
          SELECT id, display_name, kind, email, status, expires_at FROM records.principals WHERE id = ${caller.principalId}`;
        if (!p) throw new RecordsError("unauthenticated", "Unknown identity.");
        return toUser(p);
      });
    },

    async members() {
      return read("listIssues", async (tx) => {
        const rows = await tx`
          SELECT p.id, p.display_name, p.kind, p.email, p.status, p.expires_at
            FROM records.memberships m JOIN records.principals p ON p.id = m.principal_id
           WHERE m.datastore_id = ${datastoreId}
           ORDER BY p.display_name, p.id LIMIT 500`;
        return rows.map(toUser);
      });
    },

    async projects() {
      return read("listProjects", async (tx) => {
        const rows = await tx`
          SELECT * FROM projects.projects WHERE datastore_id = ${datastoreId} ORDER BY key LIMIT 200`;
        return rows.map((r): JiraProject => ({ ...toProject(r), jiraId: jiraIdOf(r) }));
      });
    },

    async workflow() {
      return read("getWorkflow", async (tx): Promise<JiraWorkflow> => {
        const states = await tx`
          SELECT key, name, category, position, jira_id FROM projects.workflow_states
           WHERE datastore_id = ${datastoreId} ORDER BY position, key`;
        const transitions = await tx`
          SELECT from_state, to_state FROM projects.workflow_transitions
           WHERE datastore_id = ${datastoreId} ORDER BY from_state, to_state`;
        return {
          states: states.map((s) => ({
            key: s.key as string, name: s.name as string, category: s.category as WorkflowCategory, position: s.position as number, jiraId: jiraIdOf(s),
          })),
          transitions: transitions.map((t) => ({ from: t.from_state as string, to: t.to_state as string })),
        };
      });
    },

    async customFields() {
      return read("getWorkflow", async (tx) => {
        const rows = await tx`
          SELECT key, name, type, options, jira_id FROM projects.custom_fields
           WHERE datastore_id = ${datastoreId} ORDER BY jira_id LIMIT 200`;
        return rows.map((r): JiraCustomFieldDef => ({
          key: r.key as string, name: r.name as string, type: r.type as JiraCustomFieldDef["type"], options: (r.options as string[]) ?? [], jiraId: jiraIdOf(r),
        }));
      });
    },

    async getIssue(keyOrId) {
      const key = ISSUE_KEY.exec(keyOrId);
      const numeric = NUMERIC_ID.test(keyOrId);
      const uuid = LOWER_UUID.test(keyOrId);
      if (!key && !numeric && !uuid) return null;
      return read("getIssue", async (tx) => {
        const match = key
          ? tx`AND p.key = ${key[1]!} AND i.number = ${Number(key[2])}`
          : numeric
            ? tx`AND i.jira_id = ${keyOrId}::bigint`
            : tx`AND i.id = ${keyOrId}::uuid`;
        const [row] = await tx`${issueSelect(tx, datastoreId)} ${match}`;
        return row ? toJiraIssue(row) : null;
      });
    },

    async search(query, page) {
      const result = await searchIssues(db, caller, datastoreId, query, { limit: page.limit, cursor: page.pageToken });
      return { issues: result.items, nextPageToken: result.nextCursor };
    },

    async createIssue(input: CreateIssueInput, options) {
      return write("projects.createIssue", input, options, false, withIssueJiraId);
    },

    async editIssue(input: JiraEditInput, options) {
      if (input.expectedRevision !== undefined) throw new RecordsError("validation_failed", "Jira edits carry no revision.");
      return write("projects.editIssue", { issueId: input.issueId, patch: input.patch }, options, true, withIssueJiraId);
    },

    async transitionIssue(input: JiraTransitionInput, options) {
      if (input.expectedRevision !== undefined) throw new RecordsError("validation_failed", "Jira transitions carry no revision.");
      return write("projects.transitionIssue", { issueId: input.issueId, toState: input.toState }, options, true, withIssueJiraId);
    },

    async addComment(input: AddCommentInput, options) {
      return write("projects.addComment", input, options, false, async (comment: Comment): Promise<JiraComment> => ({
        ...comment,
        jiraId: await jiraIdFor("comments", comment.id),
      }));
    },

    async listComments(issueId, page) {
      if (!LOWER_UUID.test(issueId)) return { comments: [], total: 0 };
      const startAt = Math.max(0, Math.floor(page.startAt));
      const maxResults = Math.min(100, Math.max(1, Math.floor(page.maxResults)));
      return read("listComments", async (tx) => {
        const [count] = await tx`
          SELECT count(*)::int AS n FROM projects.comments WHERE datastore_id = ${datastoreId} AND issue_id = ${issueId}`;
        const rows = await tx`
          SELECT c.*, p.id AS author_id, p.display_name AS author_name, p.kind AS author_kind
            FROM projects.comments c JOIN records.principals p ON p.id = c.author_id
           WHERE c.datastore_id = ${datastoreId} AND c.issue_id = ${issueId}
           ORDER BY c.created_at, c.id OFFSET ${startAt} LIMIT ${maxResults}`;
        return { comments: rows.map(toJiraComment), total: count!.n as number };
      });
    },

    async getComment(issueId, commentJiraId) {
      if (!LOWER_UUID.test(issueId) || !Number.isSafeInteger(commentJiraId) || commentJiraId < 1) return null;
      return read("listComments", async (tx) => {
        const [row] = await tx`
          SELECT c.*, p.id AS author_id, p.display_name AS author_name, p.kind AS author_kind
            FROM projects.comments c JOIN records.principals p ON p.id = c.author_id
           WHERE c.datastore_id = ${datastoreId} AND c.issue_id = ${issueId} AND c.jira_id = ${String(commentJiraId)}::bigint`;
        return row ? toJiraComment(row) : null;
      });
    },
  };
}
