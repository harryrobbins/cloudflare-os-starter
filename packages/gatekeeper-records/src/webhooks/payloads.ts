// Webhook request bodies for one delivery.
//
//   native  one request per seq: `{ v: 1, type: "change", datastoreId, webhookId, seq, entries }`,
//           the journal entries of that seq that match the webhook's event filter (wire names, as
//           the changes feed returns them).
//   jira    one request per matching entry, in the entry order: `jira:issue_created`,
//           `jira:issue_updated` (changelog from the entry's before/after) and `comment_created`,
//           built by @records/jira from the records as the webhook's creator can read them now.
//           Project events have no Jira webhook and are not sent in this format.
//   ping    `{ v: 1, type: "ping", datastoreId, webhookId, sentAt }` in either format.
//
// Every read runs as the webhook's creator (RLS by principal): nothing here widens what they see.

import { RecordsError, type CallerContext, type JournalEntry, type PrincipalRef } from "@records/contracts";
import {
  authorize,
  contextOf,
  matchesWebhook,
  toJiraComment,
  withContext,
  type ClaimedDelivery,
  type RecordsService,
} from "@records/core";
import {
  buildCommentCreated,
  buildIssueCreated,
  buildIssueUpdated,
  type JiraComment,
  type JiraPort,
  type WebhookContext,
} from "@records/jira";

import { createJiraPort } from "../jira/port.js";

export type OutboundRequest = {
  /** `change`, `ping`, or the Jira `webhookEvent`. */
  event: string;
  body: string;
};

export function nativeChangeBody(delivery: Pick<ClaimedDelivery, "datastoreId" | "webhookId">, seq: number, entries: JournalEntry[]): string {
  return JSON.stringify({ v: 1, type: "change", datastoreId: delivery.datastoreId, webhookId: delivery.webhookId, seq, entries });
}

export function pingBody(delivery: Pick<ClaimedDelivery, "datastoreId" | "webhookId">, now: Date): string {
  return JSON.stringify({ v: 1, type: "ping", datastoreId: delivery.datastoreId, webhookId: delivery.webhookId, sentAt: now.toISOString() });
}

/** The Jira root a datastore's Jira surface is served at (no trailing slash). */
export function jiraBaseUrl(publicBaseUrl: string, datastoreId: string): string {
  return new URL(`/gatekeeper/records/v1/datastores/${datastoreId}/jira`, publicBaseUrl).toString().replace(/\/$/, "");
}

async function webhookContext(port: JiraPort, baseUrl: string): Promise<WebhookContext> {
  const [projects, workflow, customFields, members] = await Promise.all([port.projects(), port.workflow(), port.customFields(), port.members()]);
  const people = new Map<string, PrincipalRef>(members.map((m) => [m.principal.id, m.principal]));
  return {
    baseUrl,
    projects: new Map(projects.map((p) => [p.id, p])),
    states: new Map(workflow.states.map((s) => [s.key, s])),
    customFields,
    principal: (id) => people.get(id) ?? null,
  };
}

async function readComment(service: RecordsService, caller: CallerContext, datastoreId: string, commentId: string): Promise<JiraComment | null> {
  return withContext(service.db, contextOf(caller, datastoreId), async (tx) => {
    await authorize(tx, caller, datastoreId, "listComments");
    const [row] = await tx`
      SELECT c.*, p.id AS author_id, p.display_name AS author_name, p.kind AS author_kind
        FROM projects.comments c JOIN records.principals p ON p.id = c.author_id
       WHERE c.datastore_id = ${datastoreId} AND c.id = ${commentId}`;
    return row ? toJiraComment(row) : null;
  }, 3, { readOnly: true });
}

/**
 * Jira-format requests for the entries of one seq. Entries whose record is no longer visible (or
 * that Jira has no event for) are left out; an empty result means the delivery is skipped.
 */
export async function jiraRequests(
  service: RecordsService,
  caller: CallerContext,
  datastoreId: string,
  entries: JournalEntry[],
  publicBaseUrl: string,
): Promise<OutboundRequest[]> {
  const relevant = entries.filter((e) => e.entityType === "issue" || (e.entityType === "comment" && e.op === "create"));
  if (relevant.length === 0) return [];
  const port = createJiraPort(service, caller, datastoreId);
  const ctx = await webhookContext(port, jiraBaseUrl(publicBaseUrl, datastoreId));
  const actorOf = (entry: JournalEntry): PrincipalRef => ctx.principal(entry.actorId) ?? { id: entry.actorId, displayName: entry.actorId, kind: "human" };
  const out: OutboundRequest[] = [];
  for (const entry of relevant) {
    if (entry.entityType === "issue") {
      const issue = await port.getIssue(entry.entityId);
      if (!issue) continue;
      const payload = entry.op === "create"
        ? buildIssueCreated({ ctx, issue, actor: actorOf(entry), timestamp: entry.occurredAt })
        : buildIssueUpdated({ ctx, issue, entry, actor: actorOf(entry) });
      out.push({ event: payload.webhookEvent, body: JSON.stringify(payload) });
    } else {
      const issueId = typeof entry.after.issueId === "string" ? entry.after.issueId : null;
      if (!issueId) continue;
      const [issue, comment] = await Promise.all([port.getIssue(issueId), readComment(service, caller, datastoreId, entry.entityId)]);
      if (!issue || !comment) continue;
      const payload = buildCommentCreated({ ctx, issue, comment });
      out.push({ event: payload.webhookEvent, body: JSON.stringify(payload) });
    }
  }
  return out;
}

/** The requests for one claimed change delivery, given its journal entries. */
export async function changeRequests(
  service: RecordsService,
  delivery: ClaimedDelivery,
  seq: number,
  entries: JournalEntry[],
  publicBaseUrl: string,
  caller: CallerContext,
): Promise<OutboundRequest[]> {
  const matching = entries.filter((e) => matchesWebhook(e, delivery.webhook.events));
  if (matching.length === 0) return [];
  if (delivery.webhook.format === "native") return [{ event: "change", body: nativeChangeBody(delivery, seq, matching) }];
  if (delivery.webhook.format === "jira") return jiraRequests(service, caller, delivery.datastoreId, matching, publicBaseUrl);
  throw new RecordsError("internal", "Unknown webhook format.");
}
