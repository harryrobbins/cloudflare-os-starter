// The interface the Records service implements for the Jira surface. One JiraPort is bound to one
// caller and one datastore (the integrator authenticates the request and builds the port); the
// router never sees credentials or datastore IDs.
//
// Numeric Jira ids: the domain DTOs do not carry `jira_id` yet, so every record the port returns
// carries `jiraId` beside the DTO. The integration supplies them from the `jira_id bigint`
// sequence columns (canonical plan §7, "Identifiers").
//
// Errors: the port throws RecordsError (or an error whose message starts with a RecordsError code,
// as after an RPC hop). The router maps them to Jira's status codes and bodies.

import type {
  AddCommentInput,
  Comment,
  CreateIssueInput,
  EditIssueInput,
  Issue,
  IssueQuery,
  MutationOutcome,
  PrincipalRef,
  Project,
  WorkflowState,
} from "@records/contracts";

export type JiraIssue = Issue & { jiraId: number };
export type JiraProject = Project & { jiraId: number; lead?: PrincipalRef | null };
export type JiraComment = Comment & { jiraId: number };
export type JiraWorkflowState = WorkflowState & { jiraId: number };
export type JiraWorkflow = { states: JiraWorkflowState[]; transitions: { from: string; to: string }[] };

/** A datastore member (or the caller). `accountId` on the Jira surface is `principal.id`. */
export type JiraUser = { principal: PrincipalRef; active: boolean; emailAddress?: string | null; timeZone?: string | null };

/**
 * A custom field definition. `jiraId` is the `<n>` in `customfield_<n>`: the integration assigns
 * it once per definition (from a sequence, conventionally starting at 10000) and never reuses it,
 * so client configurations that name `customfield_10003` keep working.
 */
export type JiraCustomFieldDef = {
  key: string;
  name: string;
  type: "text" | "number" | "boolean" | "enum";
  options: string[];
  jiraId: number;
};

/**
 * Accompanies every write. `idempotencyKey` is the client's `Idempotency-Key` header when it sent
 * one; otherwise it is derived by the router (see `deriveIdempotencyKey` in router.ts) and
 * `idempotencyKeyDerived` is true, so the service may keep derived keys for a shorter time.
 */
export type JiraWriteOptions = { idempotencyKey: string; idempotencyKeyDerived: boolean };

/**
 * Jira edits carry no If-Match. Decision for the integrator: `expectedRevision` is `undefined`,
 * meaning "last write wins" — the service applies the patch to whatever revision is current,
 * inside its transaction, and still journals before/after values so nothing is lost from
 * history. Only the fields in `patch` change; `customFields` is merged key by key (as the core
 * already does).
 */
export type JiraEditInput = { issueId: string; expectedRevision?: undefined; patch: EditIssueInput["patch"] };

/** As for edits: no revision check; the workflow rule (from → to must be allowed) still applies. */
export type JiraTransitionInput = { issueId: string; expectedRevision?: undefined; toState: string };

export type JiraSearchPage = { issues: JiraIssue[]; nextPageToken: string | null };

export interface JiraPort {
  /** The caller. Throw RecordsError("unauthenticated") when there is none. */
  myself(): Promise<JiraUser>;
  /** Members of the datastore: the people who can be assignees. */
  members(): Promise<JiraUser[]>;
  projects(): Promise<JiraProject[]>;
  workflow(): Promise<JiraWorkflow>;
  customFields(): Promise<JiraCustomFieldDef[]>;

  /** By issue key (`ENG-12`, already upper-cased) or numeric Jira id; null when absent or not visible. */
  getIssue(keyOrId: string): Promise<JiraIssue | null>;
  /**
   * Run a typed query. `pageToken` is the port's own opaque token from a previous page of the same
   * query, or null for the first page. The router wraps it so it cannot be replayed on another query.
   */
  search(query: IssueQuery, page: { limit: number; pageToken: string | null }): Promise<JiraSearchPage>;

  createIssue(input: CreateIssueInput, options: JiraWriteOptions): Promise<MutationOutcome<JiraIssue>>;
  editIssue(input: JiraEditInput, options: JiraWriteOptions): Promise<MutationOutcome<JiraIssue>>;
  transitionIssue(input: JiraTransitionInput, options: JiraWriteOptions): Promise<MutationOutcome<JiraIssue>>;
  addComment(input: AddCommentInput, options: JiraWriteOptions): Promise<MutationOutcome<JiraComment>>;

  /** Oldest first, offset-paged as Jira pages comments. */
  listComments(issueId: string, page: { startAt: number; maxResults: number }): Promise<{ comments: JiraComment[]; total: number }>;
  /** One comment of an issue by its numeric Jira id; null when absent. */
  getComment(issueId: string, commentJiraId: number): Promise<JiraComment | null>;
}
