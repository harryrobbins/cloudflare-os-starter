// Jira's error body: `{ errorMessages: string[], errors: { [field]: message } }`, with the HTTP
// status beside it. Every failure on the Jira surface is one of these, so clients that parse Jira
// errors (jira.js, Python `jira`, jira-cli) show a useful message.

import { RecordsError, type ErrorCode } from "@records/contracts";

export type JiraErrorBody = { errorMessages: string[]; errors: Record<string, string> };

export class JiraError extends Error {
  override name = "JiraError";
  readonly status: number;
  readonly errorMessages: string[];
  readonly errors: Record<string, string>;
  readonly headers: Record<string, string>;

  constructor(status: number, errorMessages: string[], errors: Record<string, string> = {}, headers: Record<string, string> = {}) {
    super(errorMessages[0] ?? Object.values(errors)[0] ?? `HTTP ${status}`);
    this.status = status;
    this.errorMessages = errorMessages;
    this.errors = errors;
    this.headers = headers;
  }

  get body(): JiraErrorBody {
    return { errorMessages: this.errorMessages, errors: this.errors };
  }

  static badRequest(message: string): JiraError {
    return new JiraError(400, [message]);
  }

  static fields(errors: Record<string, string>): JiraError {
    return new JiraError(400, [], errors);
  }
}

// Messages as Jira Cloud words them, where it has a fixed wording.
export const JIRA_MESSAGES = {
  unauthenticated: "You are not authenticated. Authentication required to perform this operation.",
  forbidden: "You do not have permission to perform this operation.",
  issueNotFound: "Issue does not exist or you do not have permission to see it.",
  projectNotFound: (key: string) => `No project could be found with key '${key}'.`,
  userNotFound: (id: string) => `The user with account ID '${id}' does not exist.`,
  commentNotFound: (id: string) => `Can not find a comment for key: ${id}.`,
  notFound: "The requested resource could not be found.",
  searchRemoved:
    "The requested API has been removed. Please migrate to the /rest/api/3/search/jql API. A full migration guideline is available at https://developer.atlassian.com/changelog/#CHANGE-2046",
  fieldCannotBeSet: (field: string) => `Field '${field}' cannot be set. It is not on the appropriate screen, or unknown.`,
  transitionInvalid: (id: string) => `Transition id '${id}' is not valid for this issue.`,
  invalidPageToken: "The provided next page token is invalid or expired.",
} as const;

/**
 * Map a RecordsError (or an error whose message carries a RecordsError code, as after an RPC hop)
 * to the Jira status and body. `context` picks the wording for 404s and conflicts.
 */
export function jiraErrorFromRecords(err: unknown, context: { notFound?: string; conflictStatus?: number } = {}): JiraError {
  if (err instanceof JiraError) return err;
  const code: ErrorCode | null = err instanceof RecordsError ? err.code : RecordsError.codeOf(err);
  const detail = err instanceof RecordsError ? err.detail : err instanceof Error ? err.message.replace(/^[a-z_]+:\s*/, "") : "";
  switch (code) {
    case "unauthenticated":
      return new JiraError(401, [JIRA_MESSAGES.unauthenticated]);
    case "forbidden":
      return new JiraError(403, [JIRA_MESSAGES.forbidden]);
    case "not_found":
      return new JiraError(404, [context.notFound ?? JIRA_MESSAGES.notFound]);
    case "validation_failed": {
      const issues = err instanceof RecordsError ? err.issues ?? [] : [];
      const errors: Record<string, string> = {};
      for (const i of issues) errors[wireFieldToJira(i.path)] = i.message;
      return new JiraError(400, Object.keys(errors).length ? [] : [detail || "The request is invalid."], errors);
    }
    case "revision_conflict":
    case "idempotency_conflict":
    case "duplicate":
    case "datastore_archived":
      return new JiraError(409, [detail || "The request conflicts with the current state of the resource."]);
    case "revision_required":
      return new JiraError(409, [detail || "The issue changed while the request was processed; retry."]);
    case "workflow_conflict":
      return new JiraError(context.conflictStatus ?? 400, [detail || "The transition is not valid for this issue."]);
    case "payload_too_large":
      return new JiraError(413, [detail || "The request is too large."]);
    case "rate_limited":
      return new JiraError(429, [detail || "Rate limit exceeded."], {}, { "retry-after": "5" });
    case "unavailable":
      return new JiraError(503, [detail || "The service is temporarily unavailable."], {}, { "retry-after": "5" });
    default:
      return new JiraError(500, ["Internal server error."]);
  }
}

/** Native wire field names in validation issue paths → Jira field IDs. */
function wireFieldToJira(path: string): string {
  const head = path.split(".")[0] ?? path;
  switch (head) {
    case "title":
      return "summary";
    case "assigneeId":
      return "assignee";
    case "projectId":
      return "project";
    case "body":
      return "comment";
    case "toState":
      return "transition";
    case "patch":
      return wireFieldToJira(path.split(".").slice(1).join(".") || "patch");
    default:
      return head;
  }
}
