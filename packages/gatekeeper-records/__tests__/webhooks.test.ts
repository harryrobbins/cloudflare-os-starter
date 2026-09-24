// Outbound webhooks end to end in Node against a real Postgres: payloads built from real journal
// entries (native and Jira-shaped), signatures, retries and dead-lettering, SSRF refusals at send
// time, the creator re-check, and the Queue consumer trigger.

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { JournalEntry } from "@records/contracts";
import { WebhookService, type Db } from "@records/core";
import { verifyWebhookSignature } from "@records/jira";

import { consumeChanges } from "../src/feed/consumer.ts";
import { deliverWebhooks, sendWebhook, type WebhookDeps } from "../src/webhooks/deliver.ts";
import { jiraBaseUrl } from "../src/webhooks/payloads.ts";
import { signRecordsWebhook, verifyRecordsSignature } from "../src/webhooks/sign.ts";
import { createWorld, key, type World } from "./world.ts";

let w: World;
let publisher: Db;
let hooks: WebhookService;

type Sent = { url: string; headers: Record<string, string>; body: string; redirect: string | undefined };

/** A receiver: records every request and answers with the next scripted status (default 200). */
class Receiver {
  sent: Sent[] = [];
  statuses: number[] = [];
  hang = false;
  fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    this.sent.push({ url: String(input), headers, body: String(init?.body), redirect: init?.redirect });
    if (this.hang) {
      await new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    }
    const status = this.statuses.shift() ?? 200;
    return new Response(status === 204 ? null : "ok", { status, headers: status >= 300 && status < 400 ? { location: "https://elsewhere.example/" } : {} });
  }) as typeof fetch;
  reset() {
    this.sent = [];
    this.statuses = [];
    this.hang = false;
  }
}

const receiver = new Receiver();
const BASE = "https://records.example.test";
let deps: WebhookDeps;

beforeAll(async () => {
  w = await createWorld();
  publisher = postgres(w.db.publisherUrl, { max: 3, onnotice: () => {}, fetch_types: true }) as unknown as Db;
  hooks = new WebhookService(w.app);
  deps = { publisher, service: w.service, publicBaseUrl: BASE, fetch: receiver.fetch, timeoutMs: 200 };
  await w.owner`
    INSERT INTO projects.custom_fields (org_id, datastore_id, key, name, type, options)
    VALUES (${w.orgA}, ${w.ds1}, 'points', 'Story points', 'number', '{}')`;
});
afterAll(async () => {
  await (publisher as unknown as { end(): Promise<void> })?.end();
  await w?.close();
});

let hookIds: string[] = [];
beforeEach(async () => {
  receiver.reset();
  // One webhook under test at a time: disable earlier ones.
  for (const id of hookIds) await w.owner`UPDATE records.webhooks SET status = 'disabled', disabled_at = now() WHERE id = ${id} AND status = 'active'`;
  hookIds = [];
});

async function createHook(input: Record<string, unknown>, caller = w.olive.caller, ds = w.ds1) {
  const created = await hooks.createWebhook(caller, ds, { label: "Test", url: "https://hooks.example.com/in", ...input });
  hookIds.push(created.webhook.id);
  return created;
}

const run = (opts: Parameters<typeof deliverWebhooks>[1] = {}) => deliverWebhooks(deps, { datastoreIds: [w.ds1], ...opts });

describe("native format", () => {
  it("delivers the journal entries of each seq, signed with a timestamp", async () => {
    const { webhook, secret } = await createHook({});
    const issue = (await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Hooked" }, key())).record;
    await w.service.projects.editIssue(w.ed.caller, w.ds1, { issueId: issue.id, expectedRevision: 1, patch: { title: "Hooked 2" } }, key());

    const result = await run();
    expect(result).toMatchObject({ expanded: 2, delivered: 2, failed: 0 });
    expect(receiver.sent).toHaveLength(2);

    const bodies = receiver.sent.map((s) => JSON.parse(s.body) as { v: number; type: string; datastoreId: string; webhookId: string; seq: number; entries: JournalEntry[] });
    // Exactly what the changes feed returns for those seqs.
    const feed = await w.service.journal.changes(w.olive.caller, w.ds1, { after: bodies[0]!.seq - 1 });
    expect(bodies.flatMap((b) => b.entries)).toEqual(feed.entries.filter((e) => e.seq <= bodies[1]!.seq));
    expect(bodies.map((b) => [b.type, b.webhookId, b.datastoreId, b.entries[0]!.op, b.entries[0]!.after.title])).toEqual([
      ["change", webhook.id, w.ds1, "create", "Hooked"],
      ["change", webhook.id, w.ds1, "update", "Hooked 2"],
    ]);
    expect(bodies[1]!.entries[0]!.before).toEqual({ title: "Hooked" });

    const first = receiver.sent[0]!;
    expect(first.url).toBe("https://hooks.example.com/in");
    expect(first.redirect).toBe("manual");
    expect(first.headers).toMatchObject({ "content-type": "application/json; charset=utf-8", "x-records-event": "change", "user-agent": "Records-Webhooks/1" });
    expect(first.headers["x-hub-signature"]).toBeUndefined();
    const delivery = first.headers["x-records-delivery"]!;
    expect(delivery).toMatch(/^[0-9a-f-]{36}$/);
    const sig = { timestamp: first.headers["x-records-timestamp"]!, signature: first.headers["x-records-signature"]! };
    expect(await verifyRecordsSignature(secret, first.body, sig)).toBe(true);
    // Tampered body, wrong secret, or a replay outside the tolerance all fail.
    expect(await verifyRecordsSignature(secret, first.body.replace("Hooked", "Hacked"), sig)).toBe(false);
    expect(await verifyRecordsSignature("whsec_wrong_wrong_wrong_wrong_wrong_wrong_wrong", first.body, sig)).toBe(false);
    expect(await verifyRecordsSignature(secret, first.body, sig, { now: Date.now() + 10 * 60_000 })).toBe(false);
    // The timestamp is inside the signed bytes: moving it breaks the signature.
    expect(await verifyRecordsSignature(secret, first.body, { ...sig, timestamp: String(Number(sig.timestamp) + 1) })).toBe(false);

    // Settled: nothing more to send.
    receiver.reset();
    expect(await run()).toMatchObject({ claimed: 0 });
    expect((await hooks.listDeliveries(w.olive.caller, w.ds1, webhook.id)).map((d) => d.state)).toEqual(["delivered", "delivered"]);
  });

  it("skips seqs that match none of the webhook's events", async () => {
    const { webhook } = await createHook({ events: ["comment.created"] });
    const issue = (await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Quiet" }, key())).record;
    await w.service.projects.addComment(w.ed.caller, w.ds1, { issueId: issue.id, body: "Loud" }, key());
    expect(await run()).toMatchObject({ skipped: 1, delivered: 1 });
    expect(receiver.sent).toHaveLength(1);
    const body = JSON.parse(receiver.sent[0]!.body);
    expect(body.entries.map((e: JournalEntry) => [e.entityType, e.op, e.after.body])).toEqual([["comment", "create", "Loud"]]);
    expect((await hooks.listDeliveries(w.olive.caller, w.ds1, webhook.id)).map((d) => d.state).toSorted()).toEqual(["delivered", "skipped"]);
  });

  it("sends a queued ping", async () => {
    const { webhook, secret } = await createHook({});
    const ping = await hooks.pingWebhook(w.olive.caller, w.ds1, webhook.id);
    expect(await run()).toMatchObject({ delivered: 1 });
    const sent = receiver.sent[0]!;
    expect(JSON.parse(sent.body)).toMatchObject({ v: 1, type: "ping", webhookId: webhook.id, datastoreId: w.ds1 });
    expect(sent.headers["x-records-delivery"]).toBe(ping.id);
    expect(await verifyRecordsSignature(secret, sent.body, { timestamp: sent.headers["x-records-timestamp"]!, signature: sent.headers["x-records-signature"]! })).toBe(true);
  });
});

describe("Jira format", () => {
  it("sends jira:issue_created, jira:issue_updated with a changelog, and comment_created, with X-Hub-Signature", async () => {
    const { secret } = await createHook({ format: "jira" });
    const issue = (await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Jira hook", customFields: { points: 3 } }, key())).record;
    await w.service.projects.editIssue(w.ed.caller, w.ds1, {
      issueId: issue.id, expectedRevision: 1, patch: { title: "Jira hook 2", priority: "high", customFields: { points: 5 } },
    }, key());
    await w.service.projects.transitionIssue(w.ed.caller, w.ds1, { issueId: issue.id, expectedRevision: 2, toState: "todo" }, key());
    await w.service.projects.addComment(w.ed.caller, w.ds1, { issueId: issue.id, body: "Looks good" }, key());

    expect(await run()).toMatchObject({ delivered: 4, failed: 0 });
    const payloads = receiver.sent.map((s) => JSON.parse(s.body));
    expect(payloads.map((p) => [p.webhookEvent, p.issue_event_type_name ?? null])).toEqual([
      ["jira:issue_created", "issue_created"],
      ["jira:issue_updated", "issue_updated"],
      ["jira:issue_updated", "issue_generic"],
      ["comment_created", null],
    ]);
    const [created, edited, moved, commented] = payloads;
    const base = jiraBaseUrl(BASE, w.ds1);
    expect(created.issue.key).toMatch(/^ENG-\d+$/);
    expect(created.issue.self).toBe(`${base}/rest/api/2/issue/${created.issue.id}`);
    expect(created.user).toMatchObject({ accountId: w.ed.id, displayName: "Ed" });
    expect(edited.changelog.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "summary", fromString: "Jira hook", toString: "Jira hook 2" }),
      expect.objectContaining({ field: "priority", toString: "High" }),
      expect.objectContaining({ field: "Story points", fieldtype: "custom", fromString: "3", toString: "5" }),
    ]));
    expect(moved.changelog.items).toEqual([expect.objectContaining({ field: "status", fromString: "Backlog", toString: "To do" })]);
    expect(commented.comment).toMatchObject({ body: "Looks good", author: { accountId: w.ed.id } });
    expect(commented.issue.key).toBe(created.issue.key);

    for (const [i, sent] of receiver.sent.entries()) {
      expect(await verifyWebhookSignature(secret, sent.body, sent.headers["x-hub-signature"]!)).toBe(true);
      expect(sent.headers["x-records-event"]).toBe(payloads[i].webhookEvent);
      expect(sent.headers["x-atlassian-webhook-identifier"]).toBe(`${sent.headers["x-records-delivery"]}.0`);
      expect(await verifyRecordsSignature(secret, sent.body, { timestamp: sent.headers["x-records-timestamp"]!, signature: sent.headers["x-records-signature"]! })).toBe(true);
    }
  });

  it("leaves out project events (Jira has none)", async () => {
    await createHook({ format: "jira", events: ["project.created", "issue.created"] });
    await w.service.projects.createProject(w.olive.caller, w.ds1, { key: `P${Date.now().toString(36).slice(-4).toUpperCase().replace(/[^A-Z]/g, "Q")}`, name: "Side" });
    expect(await run()).toMatchObject({ skipped: 1, delivered: 0 });
    expect(receiver.sent).toHaveLength(0);
  });
});

describe("failures", () => {
  it("retries 5xx and redirects with backoff, never following a redirect, then dead-letters", async () => {
    const { webhook } = await createHook({});
    await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Flaky" }, key());
    receiver.statuses = [503];
    expect(await run({ maxAttempts: 3 })).toMatchObject({ failed: 1, delivered: 0 });
    let [d] = await hooks.listDeliveries(w.olive.caller, w.ds1, webhook.id);
    expect(d).toMatchObject({ state: "pending", attempts: 1, lastStatus: 503, lastError: "The receiver answered 503." });

    await w.owner`UPDATE records.webhook_deliveries SET available_at = now() WHERE webhook_id = ${webhook.id}`;
    receiver.statuses = [302];
    expect(await run({ maxAttempts: 3 })).toMatchObject({ failed: 1 });
    expect(receiver.sent).toHaveLength(2); // the redirect target was never requested
    [d] = await hooks.listDeliveries(w.olive.caller, w.ds1, webhook.id);
    expect(d).toMatchObject({ state: "pending", attempts: 2, lastStatus: 302, lastError: "Redirect (302) not followed." });

    await w.owner`UPDATE records.webhook_deliveries SET available_at = now() WHERE webhook_id = ${webhook.id}`;
    receiver.hang = true;
    expect(await run({ maxAttempts: 3 })).toMatchObject({ failed: 1 });
    [d] = await hooks.listDeliveries(w.olive.caller, w.ds1, webhook.id);
    expect(d).toMatchObject({ state: "dead", attempts: 3, lastError: "The receiver did not answer in time." });
    const [hook] = await hooks.listWebhooks(w.olive.caller, w.ds1).then((l) => l.filter((h) => h.id === webhook.id));
    expect(hook).toMatchObject({ status: "active", consecutiveFailures: 3 });
  });

  it("refuses a private destination at send time and disables the webhook, without a request", async () => {
    const { webhook } = await createHook({});
    await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "SSRF" }, key());
    // Only the migration owner could do this (the URL is validated on creation and the app role
    // cannot update it); the deliverer checks again anyway.
    await w.owner`UPDATE records.webhooks SET url = 'https://169.254.169.254/latest/meta-data' WHERE id = ${webhook.id}`;
    expect(await run()).toMatchObject({ abandoned: 1 });
    expect(receiver.sent).toHaveLength(0);
    const [hook] = (await hooks.listWebhooks(w.olive.caller, w.ds1)).filter((h) => h.id === webhook.id);
    expect(hook).toMatchObject({ status: "disabled", disabledReason: expect.stringMatching(/private/) });
  });

  it("sendWebhook refuses non-https and localhost destinations outright", async () => {
    for (const url of ["http://hooks.example.com/", "https://localhost/x", "https://[::1]/x", "https://10.0.0.8/x"]) {
      const result = await sendWebhook({ fetch: receiver.fetch }, { id: crypto.randomUUID(), webhook: { url, secret: "s".repeat(40), format: "native", events: [], label: "x", createdBy: w.olive.id } }, { event: "ping", body: "{}" });
      expect(result.ok).toBe(false);
    }
    expect(receiver.sent).toHaveLength(0);
  });

  it("stops when the creator loses bindings.manage", async () => {
    const { webhook } = await createHook({}, w.adam.caller);
    await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "After Adam" }, key());
    await w.service.registry.setMemberRole(w.olive.caller, w.ds1, { principalId: w.adam.id, role: "editor" });
    try {
      expect(await run()).toMatchObject({ abandoned: 1, delivered: 0 });
      expect(receiver.sent).toHaveLength(0);
      const [row] = await w.owner`SELECT status, disabled_reason FROM records.webhooks WHERE id = ${webhook.id}`;
      expect(row).toEqual({ status: "disabled", disabled_reason: expect.stringMatching(/no longer manages/) });
    } finally {
      await w.service.registry.setMemberRole(w.olive.caller, w.ds1, { principalId: w.adam.id, role: "admin" });
    }
  });

  it("never logs payloads or secrets", async () => {
    const { secret } = await createHook({});
    await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Top secret title" }, key());
    receiver.statuses = [500];
    const lines: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      await run();
    } finally {
      Object.assign(console, original);
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toMatch(/Top secret title|whsec_/);
    expect(lines.join("\n")).not.toContain(secret);
  });
});

describe("signatures", () => {
  it("signs `<timestamp>.<body>` with HMAC-SHA256", async () => {
    const { createHmac } = await import("node:crypto");
    const expected = createHmac("sha256", "whsec_test").update("1700000000.{\"a\":1}").digest("hex");
    expect(await signRecordsWebhook("whsec_test", 1700000000, "{\"a\":1}")).toBe(`sha256=${expected}`);
  });
});

describe("Queue trigger", () => {
  it("the consumer runs webhooks for the batch's datastores, and a webhook failure never retries the feed", async () => {
    const acked: string[] = [];
    const retried: string[] = [];
    const message = (id: string, datastoreId: string) => ({
      id, attempts: 1, timestamp: new Date(),
      body: { v: 1, eventId: crypto.randomUUID(), orgId: w.orgA, datastoreId, eventType: "issue.created", entityType: "issue", entityId: crypto.randomUUID(), revision: 1, occurredAt: new Date().toISOString() },
      ack: () => void acked.push(id), retry: () => void retried.push(id),
    });
    const batch = { queue: "records-changes", messages: [message("m1", w.ds1), message("m2", w.ds2), message("m3", w.ds1)] } as unknown as MessageBatch<unknown>;
    const seen: string[][] = [];
    await consumeChanges(batch, {
      deliver: async () => 1,
      webhooks: async (ids) => {
        seen.push(ids);
        throw new Error("database down");
      },
    });
    expect(seen).toEqual([[w.ds1, w.ds2]]);
    expect(acked.toSorted()).toEqual(["m1", "m2", "m3"]);
    expect(retried).toEqual([]);
  });
});
