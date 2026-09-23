// Agent- and gadget-facing API of the Records Gatekeeper (Projects module, API v1).
//
// One binding = one organisation datastore, with the operation scopes granted when it was
// connected. Records belong to the organisation, not to this gadget: removing the gadget or the
// connection never deletes them.
//
// Reads return current data (each read is recorded as an observation). Writes need the person
// using the gadget to assert the exact write: in gadget UI code,
//
//     const idempotencyKey = crypto.randomUUID();
//     const digest = await recordsIntentDigest("createIssue", input, idempotencyKey);
//     const viewerAssertion = await gadget.$createViewerAssertion("RECORDS", digest);
//     const outcome = await gadget.createIssue(input, { idempotencyKey, viewerAssertion });
//
// and the gadget server passes both through unchanged to `RECORDS.createIssue(input, options)`.
// `recordsIntentDigest` is SHA-256 over canonical JSON (see `RecordsSession.intentFormat`). The
// assertion is valid once, for 60 seconds, for exactly that input and key. A write is only saved
// when the outcome's status is "applied"; "pending" means it awaits approval in the Workshop.

/** A person or service principal, for display only. */
export type RecordsPrincipal = { id: string; displayName: string; kind: "human" | "service" };

export type RecordsPriority = "none" | "low" | "medium" | "high" | "urgent";

export type RecordsProject = {
  id: string;
  /** Short key, e.g. "ENG"; issue keys are `${key}-${number}`. */
  key: string;
  name: string;
  description: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type RecordsWorkflowState = {
  key: string;
  name: string;
  category: "todo" | "in_progress" | "done";
  position: number;
};

export type RecordsWorkflow = {
  states: RecordsWorkflowState[];
  /** Allowed state changes. `transitionIssue` refuses any other. */
  transitions: { from: string; to: string }[];
};

export type RecordsIssue = {
  id: string;
  projectId: string;
  number: number;
  /** Display key, e.g. "ENG-12". */
  key: string;
  title: string;
  description: string;
  state: string;
  priority: RecordsPriority;
  assignee: RecordsPrincipal | null;
  customFields: Record<string, string | number | boolean | null>;
  /** Increments on every change. Pass it back as `expectedRevision` when changing the issue. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  createdBy: RecordsPrincipal;
  updatedBy: RecordsPrincipal;
};

export type RecordsComment = {
  id: string;
  issueId: string;
  body: string;
  author: RecordsPrincipal;
  createdAt: string;
};

export type RecordsPage<T> = { items: T[]; nextCursor: string | null };

export type RecordsListIssuesInput = {
  projectId?: string;
  state?: string;
  assigneeId?: string;
  /** Case-insensitive title substring. */
  query?: string;
  order?: "updated_desc" | "number_asc";
  /** 1-100, default 50. */
  limit?: number;
  cursor?: string;
};

export type RecordsCreateIssueInput = {
  projectId: string;
  title: string;
  description?: string;
  /** Defaults to the workflow's first state. */
  state?: string;
  priority?: RecordsPriority;
  assigneeId?: string | null;
  customFields?: Record<string, string | number | boolean | null>;
};

export type RecordsEditIssueInput = {
  issueId: string;
  expectedRevision: number;
  patch: {
    title?: string;
    description?: string;
    priority?: RecordsPriority;
    assigneeId?: string | null;
    customFields?: Record<string, string | number | boolean | null>;
  };
};

export type RecordsTransitionIssueInput = { issueId: string; expectedRevision: number; toState: string };

export type RecordsAddCommentInput = { issueId: string; body: string };

/** Accompanies every write. Both values come from the gadget UI; see the file header. */
export type RecordsWriteOptions = { idempotencyKey: string; viewerAssertion: string };

/**
 * Result of a write. Only "applied" means saved.
 *
 * Refusals that depend on who asked (not permitted, not in the directory, datastore archived) are
 * returned as "rejected". Malformed input, a missing/invalid/reused viewer assertion and service
 * failures are thrown. Retrying with the SAME idempotency key and input (and a fresh assertion)
 * never applies twice: once applied, it returns the saved outcome with `replayed: true`.
 *
 * "pending" awaits approval (check later with `getWriteOutcome`); "rejected" and "conflict" were
 * not saved. On "conflict", re-read the issue and let the person decide again.
 */
export type RecordsWriteOutcome<T> =
  | { status: "applied"; record: T; replayed: boolean }
  | { status: "pending"; actionId: number; idempotencyKey: string }
  | { status: "rejected"; code: string; message: string }
  | { status: "conflict"; code: "revision_conflict" | "workflow_conflict"; message: string; currentRevision?: number };

/** What this binding is connected to. */
export type RecordsBindingInfo = {
  datastore: { id: string; name: string; description: string; lifecycle: "active" | "archived" };
  moduleId: "projects";
  apiMajor: 1;
  /** Operations this binding may perform, e.g. ["projects.read", "issues.read"]. */
  scopes: string[];
};

/** A change notification. Carries identifiers only: refetch to see the change. */
export type RecordsChange = {
  datastoreId: string;
  eventType: string;
  entityType: "datastore" | "project" | "issue" | "comment" | "membership" | "binding";
  entityId: string;
  revision: number;
};

/** Callback interface for `onChange`. Delivery is at-least-once and may be out of order. */
export interface RecordsChangeHook {
  /** One or more changes happened. Refetch what you display; ignore revisions you already have. */
  changed(changes: RecordsChange[]): void | Promise<void>;
  /** Continuity was lost (e.g. after a long disconnect): refetch everything you display. */
  resync(): void | Promise<void>;
}

/** The Projects datastore bound to this gadget. */
export interface RecordsSession {
  /** Datastore, module and granted scopes. */
  describe(): Promise<RecordsBindingInfo>;

  /**
   * How to compute the intent digest for `$createViewerAssertion`:
   * SHA-256 hex of canonical JSON (keys sorted, no whitespace, undefined members dropped) of
   * `{ v: 1, service: "records", operation, input, key: idempotencyKey }`.
   */
  intentFormat(): Promise<string>;

  listProjects(): Promise<RecordsProject[]>;
  getWorkflow(): Promise<RecordsWorkflow>;
  /** Issues across every project unless `projectId` is given. */
  listIssues(input?: RecordsListIssuesInput): Promise<RecordsPage<RecordsIssue>>;
  getIssue(issueId: string): Promise<RecordsIssue>;
  listComments(input: { issueId: string; limit?: number; cursor?: string }): Promise<RecordsPage<RecordsComment>>;
  /** The people who can be assigned issues (the datastore's members), for pickers. */
  listAssignees(): Promise<RecordsPrincipal[]>;

  createIssue(input: RecordsCreateIssueInput, options: RecordsWriteOptions): Promise<RecordsWriteOutcome<RecordsIssue>>;
  editIssue(input: RecordsEditIssueInput, options: RecordsWriteOptions): Promise<RecordsWriteOutcome<RecordsIssue>>;
  transitionIssue(input: RecordsTransitionIssueInput, options: RecordsWriteOptions): Promise<RecordsWriteOutcome<RecordsIssue>>;
  addComment(input: RecordsAddCommentInput, options: RecordsWriteOptions): Promise<RecordsWriteOutcome<RecordsComment>>;

  /** The current outcome of an earlier write that returned "pending". */
  getWriteOutcome(actionId: number): Promise<RecordsWriteOutcome<RecordsIssue | RecordsComment>>;

  /**
   * Ask to be told when records in this datastore change. Registers a persistent hook, which the
   * Workshop owner approves once. `callback` must be a persistent stub (see ctx.restore).
   */
  onChange(callback: RecordsChangeHook): Promise<void>;
}
