// Jira-shaped webhook payloads, built from domain records and journal entries, and their
// `X-Hub-Signature: sha256=<hex>` signatures. Pure: the outbox decides when to deliver.
//
// Payload fields are in the v2 representation (plain-text description and comment bodies), as
// Jira's own webhooks are.

import type { JournalEntry, PrincipalRef } from "@records/contracts";

import { commentToJira, fieldSelector, issueToJira, jiraDate, userToJira, type MapContext } from "./map/outbound.js";
import type { JiraComment, JiraIssue } from "./port.js";
import { priorityToJira } from "./values.js";

export type WebhookContext = Omit<MapContext, "version"> & {
  /** Display details for principals named in journal entries. */
  principal(id: string): PrincipalRef | null;
};

const v2 = (ctx: WebhookContext): MapContext => ({ ...ctx, version: 2 });

export type ChangelogItem = {
  field: string;
  fieldtype: "jira" | "custom";
  fieldId: string;
  from: string | null;
  fromString: string | null;
  to: string | null;
  toString: string | null;
};

function principalOf(ctx: WebhookContext, value: unknown): PrincipalRef | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return ctx.principal(value) ?? { id: value, displayName: value, kind: "human" };
  if (typeof value === "object" && typeof (value as PrincipalRef).id === "string") return value as PrincipalRef;
  return null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** Changelog items for the fields a journal entry changed. Unmapped fields are left out. */
export function changelogItems(entry: Pick<JournalEntry, "before" | "after">, ctx: WebhookContext): ChangelogItem[] {
  const before = entry.before ?? {};
  const after = entry.after;
  const items: ChangelogItem[] = [];
  const has = (k: string) => k in after;
  if (has("title")) {
    items.push({ field: "summary", fieldtype: "jira", fieldId: "summary", from: null, fromString: str(before.title), to: null, toString: str(after.title) });
  }
  if (has("description")) {
    items.push({ field: "description", fieldtype: "jira", fieldId: "description", from: null, fromString: str(before.description), to: null, toString: str(after.description) });
  }
  if (has("state")) {
    const from = typeof before.state === "string" ? ctx.states.get(before.state) : undefined;
    const to = typeof after.state === "string" ? ctx.states.get(after.state) : undefined;
    items.push({
      field: "status", fieldtype: "jira", fieldId: "status",
      from: from ? String(from.jiraId) : null, fromString: from?.name ?? str(before.state),
      to: to ? String(to.jiraId) : null, toString: to?.name ?? str(after.state),
    });
  }
  if (has("priority")) {
    const from = typeof before.priority === "string" ? priorityToJira(before.priority as never) : null;
    const to = typeof after.priority === "string" ? priorityToJira(after.priority as never) : null;
    items.push({
      field: "priority", fieldtype: "jira", fieldId: "priority",
      from: from?.id ?? null, fromString: from?.name ?? null, to: to?.id ?? null, toString: to?.name ?? null,
    });
  }
  const assigneeKey = has("assigneeId") ? "assigneeId" : has("assignee") ? "assignee" : null;
  if (assigneeKey) {
    const from = principalOf(ctx, before[assigneeKey]);
    const to = principalOf(ctx, after[assigneeKey]);
    items.push({
      field: "assignee", fieldtype: "jira", fieldId: "assignee",
      from: from?.id ?? null, fromString: from?.displayName ?? null, to: to?.id ?? null, toString: to?.displayName ?? null,
    });
  }
  if (has("customFields")) {
    const b = (before.customFields ?? {}) as Record<string, unknown>;
    const a = (after.customFields ?? {}) as Record<string, unknown>;
    for (const def of ctx.customFields) {
      if (!(def.key in a) || JSON.stringify(a[def.key]) === JSON.stringify(b[def.key])) continue;
      items.push({
        field: def.name, fieldtype: "custom", fieldId: `customfield_${def.jiraId}`,
        from: null, fromString: b[def.key] == null ? null : String(b[def.key]),
        to: null, toString: a[def.key] == null ? null : String(a[def.key]),
      });
    }
  }
  return items;
}

function issuePayload(ctx: WebhookContext, issue: JiraIssue) {
  return issueToJira(v2(ctx), issue, fieldSelector(undefined, "*navigable"));
}

export function buildIssueCreated(input: { ctx: WebhookContext; issue: JiraIssue; actor: PrincipalRef; timestamp: string }) {
  return {
    timestamp: Date.parse(input.timestamp),
    webhookEvent: "jira:issue_created",
    issue_event_type_name: "issue_created",
    user: userToJira(v2(input.ctx), input.actor),
    issue: issuePayload(input.ctx, input.issue),
  };
}

/**
 * `jira:issue_updated` for one journal entry. `issue_event_type_name` follows Jira: a status-only
 * change is `issue_generic`, an assignee-only change `issue_assigned`, anything else
 * `issue_updated`. `changelog.id` is the entry's `seq` and `ordinal` (unique per datastore).
 */
export function buildIssueUpdated(input: { ctx: WebhookContext; issue: JiraIssue; entry: JournalEntry; actor?: PrincipalRef }) {
  const { ctx, entry } = input;
  const items = changelogItems(entry, ctx);
  const fields = new Set(items.map((i) => i.fieldId));
  const type = fields.size === 1 && fields.has("status") ? "issue_generic" : fields.size === 1 && fields.has("assignee") ? "issue_assigned" : "issue_updated";
  const actor = input.actor ?? ctx.principal(entry.actorId) ?? { id: entry.actorId, displayName: entry.actorId, kind: "human" as const };
  return {
    timestamp: Date.parse(entry.occurredAt),
    webhookEvent: "jira:issue_updated",
    issue_event_type_name: type,
    user: userToJira(v2(ctx), actor),
    issue: issuePayload(ctx, input.issue),
    changelog: { id: String(entry.seq * 1000 + entry.ordinal), items },
  };
}

export function buildCommentCreated(input: { ctx: WebhookContext; issue: JiraIssue; comment: JiraComment }) {
  const full = issuePayload(input.ctx, input.issue) as { id: string; self: string; key: string; fields: Record<string, unknown> };
  const pick = ["summary", "status", "priority", "assignee", "issuetype", "project"];
  return {
    timestamp: Date.parse(input.comment.createdAt),
    webhookEvent: "comment_created",
    comment: commentToJira(v2(input.ctx), input.issue, input.comment),
    issue: { id: full.id, self: full.self, key: full.key, fields: Object.fromEntries(Object.entries(full.fields).filter(([k]) => pick.includes(k))) },
  };
}

export { jiraDate };

// ---------------------------------------------------------------------------------------------
// Signatures

async function hmacHex(secret: string, body: string | Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const data = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const sig = await crypto.subtle.sign("HMAC", key, data as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The `X-Hub-Signature` header value for `body` (the exact bytes delivered): `sha256=<hex>`. */
export async function signWebhook(secret: string, body: string | Uint8Array): Promise<string> {
  return `sha256=${await hmacHex(secret, body)}`;
}

/** Constant-time check of an `X-Hub-Signature` header. */
export async function verifyWebhookSignature(secret: string, body: string | Uint8Array, header: string | null): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const expected = await signWebhook(secret, body);
  if (expected.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}
