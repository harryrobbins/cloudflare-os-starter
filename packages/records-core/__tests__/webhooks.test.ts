// Outbound webhooks (migration 0008, src/domain/webhooks.ts): management through the service,
// delivery state as the publisher role, the creator re-check, and the database as a second line.

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CallerContext } from "@records/contracts";

import {
  claimWebhookDeliveries,
  contextOf,
  expandWebhookDeliveries,
  pruneWebhookDeliveries,
  readWebhookChange,
  settleWebhookDelivery,
  webhookBackoffSeconds,
  webhookEventOf,
  webhookUrlProblem,
  WebhookService,
  withContext,
  type Db,
  type Tx,
} from "../src/index.js";
import { code, createWorld, key, type World } from "./world.js";

let w: World;
let publisher: Db;
let hooks: WebhookService;

beforeAll(async () => {
  w = await createWorld();
  publisher = postgres(w.db.publisherUrl, { max: 3, onnotice: () => {}, fetch_types: true }) as unknown as Db;
  hooks = new WebhookService(w.app);
});
afterAll(async () => {
  await (publisher as unknown as { end(): Promise<void> })?.end();
  await w?.close();
});

const unchecked = <T>(caller: CallerContext, ds: string, fn: (tx: Tx) => Promise<T>) => withContext(w.app, contextOf(caller, ds), fn, 1);
const createIssue = async (title: string, ds = w.ds1, project = w.eng) =>
  (await w.service.projects.createIssue(w.olive.caller, ds, { projectId: project, title }, key())).record;

/** Settle everything pending for a webhook so each test starts clean. */
async function drain(webhookId: string) {
  await w.owner`UPDATE records.webhook_deliveries SET state = 'skipped', settled_at = now() WHERE webhook_id = ${webhookId} AND state = 'pending'`;
}

describe("URL guard", () => {
  it.each([
    ["http://example.com/hook", /https/],
    ["https://user:pw@example.com/hook", /user name/],
    ["https://localhost/hook", /public host/],
    ["https://api.localhost/hook", /public host/],
    ["https://printer.local/hook", /public host/],
    ["https://intranet/hook", /public host/],
    ["https://127.0.0.1/hook", /private/],
    ["https://2130706433/hook", /private/], // decimal 127.0.0.1
    ["https://0x7f.1/hook", /private/],
    ["https://10.1.2.3/hook", /private/],
    ["https://172.20.0.1/hook", /private/],
    ["https://192.168.1.1/hook", /private/],
    ["https://169.254.169.254/latest/meta-data", /private/],
    ["https://100.64.0.1/hook", /private/],
    ["https://0.0.0.0/hook", /private/],
    ["https://[::1]/hook", /private/],
    ["https://[::]/hook", /private/],
    ["https://[::ffff:127.0.0.1]/hook", /private/],
    ["https://[fe80::1]/hook", /private/],
    ["https://[fd00::1]/hook", /private/],
    ["https://[64:ff9b::a00:1]/hook", /private/],
    ["not a url", /valid URL/],
  ])("refuses %s", (url, reason) => {
    expect(webhookUrlProblem(url)).toMatch(reason);
  });

  it.each(["https://hooks.example.com/records?t=1", "https://8.8.8.8/hook", "https://[2606:4700::1111]/hook", "https://example.com:8443/x"])(
    "allows %s", (url) => expect(webhookUrlProblem(url)).toBeNull(),
  );

  it("maps journal entries to events", () => {
    expect(webhookEventOf({ entityType: "issue", op: "create" })).toBe("issue.created");
    expect(webhookEventOf({ entityType: "issue", op: "archive" })).toBe("issue.updated");
    expect(webhookEventOf({ entityType: "comment", op: "update" })).toBeNull();
  });

  it("backs off exponentially with a cap", () => {
    expect([1, 2, 3, 20].map(webhookBackoffSeconds)).toEqual([30, 60, 120, 6 * 3600]);
  });
});

describe("management", () => {
  it("creates a webhook, shows the secret once, and audits the host only", async () => {
    const created = await hooks.createWebhook(w.olive.caller, w.ds1, { label: "CI", url: "https://hooks.example.com/ci?token=abc" });
    expect(created.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(created.webhook).toMatchObject({ label: "CI", format: "native", status: "active", createdBy: w.olive.id });
    expect(created.webhook.events).toEqual(["project.created", "project.updated", "issue.created", "issue.updated", "comment.created"]);
    expect(JSON.stringify(created.webhook)).not.toContain(created.secret);
    const list = await hooks.listWebhooks(w.olive.caller, w.ds1);
    expect(list.map((h) => h.id)).toContain(created.webhook.id);
    expect(JSON.stringify(list)).not.toContain(created.secret);
    const [event] = await w.owner`SELECT operation, detail FROM records.audit_events WHERE target_id = ${created.webhook.id}`;
    expect(event).toMatchObject({ operation: "createWebhook", detail: { host: "hooks.example.com", format: "native" } });
    expect(JSON.stringify(event!.detail)).not.toContain("token");
    // Stored as given, readable by the publisher only.
    const [row] = await publisher`SELECT secret FROM records.webhooks WHERE id = ${created.webhook.id}`;
    expect(row!.secret).toBe(created.secret);
  });

  it("defaults Jira-format webhooks to the Jira events and validates input", async () => {
    const jira = await hooks.createWebhook(w.olive.caller, w.ds1, { label: "Jira", url: "https://j.example.com/", format: "jira" });
    expect(jira.webhook.events).toEqual(["issue.created", "issue.updated", "comment.created"]);
    expect(await code(hooks.createWebhook(w.olive.caller, w.ds1, { label: "Bad", url: "https://10.0.0.1/" }))).toBe("validation_failed");
    expect(await code(hooks.createWebhook(w.olive.caller, w.ds1, { label: "Bad", url: "https://x.example.com/", events: ["issue.deleted"] }))).toBe("validation_failed");
    expect(await code(hooks.createWebhook(w.olive.caller, w.ds1, { label: "Bad", url: "https://x.example.com/", secret: "mine" }))).toBe("validation_failed");
  });

  it("needs bindings.manage, and is refused to credentials", async () => {
    const input = { label: "Nope", url: "https://hooks.example.com/" };
    expect(await code(hooks.createWebhook(w.ed.caller, w.ds1, input))).toBe("forbidden");
    expect(await code(hooks.listWebhooks(w.ed.caller, w.ds1))).toBe("forbidden");
    expect(await code(hooks.listWebhooks(w.nia.caller, w.ds1))).toBe("not_found");
    expect(await code(hooks.listWebhooks(w.ada.caller, w.ds1))).toBe("not_found");
    const scoped = { ...w.olive.caller, scopes: ["projects.read", "bindings.manage"] };
    expect(await code(hooks.createWebhook(scoped, w.ds1, input))).toBe("forbidden");
  });

  it("pings, lists deliveries, disables, enables and deletes (cascading its deliveries)", async () => {
    const { webhook } = await hooks.createWebhook(w.olive.caller, w.ds1, { label: "Ping", url: "https://hooks.example.com/p" });
    const ping = await hooks.pingWebhook(w.olive.caller, w.ds1, webhook.id);
    expect(ping).toMatchObject({ kind: "ping", seq: null, state: "pending", attempts: 0 });
    expect((await hooks.listDeliveries(w.olive.caller, w.ds1, webhook.id)).map((d) => d.id)).toEqual([ping.id]);
    expect(await code(hooks.pingWebhook(w.ed.caller, w.ds1, webhook.id))).toBe("forbidden");

    const off = await hooks.setWebhookEnabled(w.olive.caller, w.ds1, webhook.id, false);
    expect(off).toMatchObject({ status: "disabled", disabledReason: "Disabled by a manager." });
    expect(await code(hooks.pingWebhook(w.olive.caller, w.ds1, webhook.id))).toBe("validation_failed");
    expect((await hooks.setWebhookEnabled(w.olive.caller, w.ds1, webhook.id, true)).status).toBe("active");

    await hooks.deleteWebhook(w.olive.caller, w.ds1, webhook.id);
    expect(await code(hooks.deleteWebhook(w.olive.caller, w.ds1, webhook.id))).toBe("not_found");
    const [left] = await w.owner`SELECT count(*)::int AS n FROM records.webhook_deliveries WHERE webhook_id = ${webhook.id}`;
    expect(left!.n).toBe(0);
    const ops = await w.owner`SELECT operation FROM records.audit_events WHERE target_id = ${webhook.id} ORDER BY seq`;
    expect(ops.map((o) => o.operation)).toEqual(["createWebhook", "pingWebhook", "disableWebhook", "enableWebhook", "deleteWebhook"]);
  });
});

describe("the database as a second line", () => {
  let hookId: string;
  beforeAll(async () => {
    hookId = (await hooks.createWebhook(w.olive.caller, w.ds1, { label: "RLS", url: "https://hooks.example.com/rls" })).webhook.id;
  });

  it("the app role can never read the secret, even as the owner", async () => {
    expect(await code(unchecked(w.olive.caller, w.ds1, (tx) => tx`SELECT secret FROM records.webhooks`))).toBe("internal");
    expect(await code(unchecked(w.olive.caller, w.ds1, (tx) => tx`SELECT * FROM records.webhooks`))).toBe("internal");
    expect(await code(unchecked(w.olive.caller, w.ds1, (tx) => tx`SELECT id FROM records.webhooks WHERE secret LIKE 'whsec_%'`))).toBe("internal");
    expect(await code(unchecked(w.olive.caller, w.ds1, (tx) => tx`UPDATE records.webhooks SET url = 'https://evil.example.com/'`))).toBe("internal");
  });

  it("non-members and members without bindings.manage see no webhooks or deliveries", async () => {
    await hooks.pingWebhook(w.olive.caller, w.ds1, hookId);
    const count = (caller: CallerContext, ds = w.ds1) => unchecked(caller, ds, async (tx) => {
      const [r] = await tx`SELECT (SELECT count(*)::int FROM records.webhooks) AS hooks, (SELECT count(*)::int FROM records.webhook_deliveries) AS deliveries`;
      return r;
    });
    expect((await count(w.olive.caller))!.hooks).toBeGreaterThan(0);
    for (const who of [w.nia, w.ed, w.rae, w.ada]) expect(await count(who.caller)).toEqual({ hooks: 0, deliveries: 0 });
    // Another datastore's context sees none of ds1's.
    const other = await unchecked(w.olive.caller, w.ds2, (tx) => tx`SELECT id FROM records.webhooks WHERE id = ${hookId}`);
    expect(other).toHaveLength(0);
    // A binding narrowed to reads loses the webhooks too.
    expect(await count({ ...w.olive.caller, scopes: ["projects.read"] })).toEqual({ hooks: 0, deliveries: 0 });
  });

  it("the app role may queue pings only, and cannot settle deliveries", async () => {
    const insert = (kind: string, seq: number | null) => unchecked(w.olive.caller, w.ds1, (tx) => tx`
      INSERT INTO records.webhook_deliveries (org_id, datastore_id, id, webhook_id, kind, seq)
      VALUES (${w.orgA}, ${w.ds1}, gen_random_uuid(), ${hookId}, ${kind}, ${seq})`);
    expect(await code(insert("change", 1))).toBe("internal"); // no INSERT privilege on seq
    expect(await code(unchecked(w.olive.caller, w.ds1, (tx) => tx`
      INSERT INTO records.webhook_deliveries (org_id, datastore_id, id, webhook_id, kind)
      VALUES (${w.orgA}, ${w.ds1}, gen_random_uuid(), ${hookId}, 'change')`))).not.toBe("ok"); // RLS or the seq check
    expect(await code(unchecked(w.olive.caller, w.ds1, (tx) => tx`UPDATE records.webhook_deliveries SET state = 'delivered'`))).toBe("internal");
    // A member without bindings.manage cannot queue a ping either.
    expect(await code(unchecked(w.ed.caller, w.ds1, (tx) => tx`
      INSERT INTO records.webhook_deliveries (org_id, datastore_id, id, webhook_id, kind)
      VALUES (${w.orgA}, ${w.ds1}, gen_random_uuid(), ${hookId}, 'ping')`))).toBe("internal");
  });

  it("the publisher reads delivery state and the clock head, but no record content", async () => {
    expect((await publisher`SELECT seq FROM records.datastore_clock WHERE datastore_id = ${w.ds1}`)).toHaveLength(1);
    await expect(publisher`SELECT seq FROM records.journal`).rejects.toThrow(/permission denied/);
    await expect(publisher`SELECT id FROM projects.issues`).rejects.toThrow(/permission denied/);
    await expect(publisher`UPDATE records.webhooks SET url = 'https://evil.example.com/'`).rejects.toThrow(/permission denied/);
    await expect(publisher`UPDATE records.webhooks SET secret = 'x'`).rejects.toThrow(/permission denied/);
  });

  it("refuses non-https URLs and cross-datastore deliveries even for the owner role", async () => {
    await expect(w.owner`UPDATE records.webhooks SET url = 'http://example.com/' WHERE id = ${hookId}`).rejects.toThrow(/check constraint/);
    await expect(w.owner`
      INSERT INTO records.webhook_deliveries (org_id, datastore_id, id, webhook_id, kind)
      VALUES (${w.orgA}, ${w.ds2}, gen_random_uuid(), ${hookId}, 'ping')`).rejects.toThrow(/foreign key/);
  });
});

describe("delivery state", () => {
  let hookId: string;
  const own = { datastoreIds: [] as string[] };

  beforeAll(async () => {
    hookId = (await hooks.createWebhook(w.olive.caller, w.ds2, { label: "Deliver", url: "https://hooks.example.com/d" })).webhook.id;
    own.datastoreIds = [w.ds2];
  });

  it("expands one delivery per new seq, from creation onwards, exactly once", async () => {
    await expandWebhookDeliveries(publisher, own);
    await drain(hookId);
    const [{ seq: before }] = (await w.owner`SELECT seq FROM records.datastore_clock WHERE datastore_id = ${w.ds2}`) as unknown as [{ seq: string }];
    await createIssue("One", w.ds2, w.ops);
    await createIssue("Two", w.ds2, w.ops);
    expect(await expandWebhookDeliveries(publisher, own)).toBe(2);
    expect(await expandWebhookDeliveries(publisher, own)).toBe(0);
    const rows = await w.owner`SELECT seq FROM records.webhook_deliveries WHERE webhook_id = ${hookId} AND state = 'pending' ORDER BY seq`;
    expect(rows.map((r) => Number(r.seq))).toEqual([Number(before) + 1, Number(before) + 2]);
  });

  it("expands in bounded steps", async () => {
    await drain(hookId);
    for (let i = 0; i < 3; i++) await createIssue(`Step ${i}`, w.ds2, w.ops);
    expect(await expandWebhookDeliveries(publisher, { ...own, perWebhook: 2 })).toBe(2);
    expect(await expandWebhookDeliveries(publisher, { ...own, perWebhook: 2 })).toBe(1);
  });

  it("claims with a lease, carries the secret, and settles delivered once", async () => {
    await drain(hookId);
    await createIssue("Claim", w.ds2, w.ops);
    await expandWebhookDeliveries(publisher, own);
    const first = await claimWebhookDeliveries(publisher, own);
    expect(first.deliveries).toHaveLength(1);
    const d = first.deliveries[0]!;
    expect(d).toMatchObject({ webhookId: hookId, kind: "change", attempts: 1, webhook: { url: "https://hooks.example.com/d", format: "native" } });
    expect(d.webhook.secret).toMatch(/^whsec_/);
    // Leased: a concurrent claim gets nothing.
    expect((await claimWebhookDeliveries(publisher, own)).deliveries).toHaveLength(0);
    // Only the lease holder can settle.
    expect(await settleWebhookDelivery(publisher, crypto.randomUUID(), d, { outcome: "delivered", status: 200 })).toBe(false);
    expect(await settleWebhookDelivery(publisher, first.owner, d, { outcome: "delivered", status: 204 })).toBe(true);
    expect(await settleWebhookDelivery(publisher, first.owner, d, { outcome: "delivered", status: 204 })).toBe(false);
    const [row] = await w.owner`SELECT state, last_status FROM records.webhook_deliveries WHERE id = ${d.id}`;
    expect(row).toEqual({ state: "delivered", last_status: 204 });
    const [hook] = await w.owner`SELECT consecutive_failures, last_success_at FROM records.webhooks WHERE id = ${hookId}`;
    expect(hook!.consecutive_failures).toBe(0);
    expect(hook!.last_success_at).not.toBeNull();
  });

  it("retries failures with backoff, then dead-letters them", async () => {
    await drain(hookId);
    await createIssue("Fail", w.ds2, w.ops);
    await expandWebhookDeliveries(publisher, own);
    let claim = await claimWebhookDeliveries(publisher, own);
    const id = claim.deliveries[0]!.id;
    await settleWebhookDelivery(publisher, claim.owner, claim.deliveries[0]!, { outcome: "failed", status: 500, error: "The receiver answered 500." }, { maxAttempts: 2 });
    const [pending] = await w.owner`SELECT state, attempts, available_at > now() + interval '20 seconds' AS later, last_status FROM records.webhook_deliveries WHERE id = ${id}`;
    expect(pending).toEqual({ state: "pending", attempts: 1, later: true, last_status: 500 });
    // Not due yet.
    expect((await claimWebhookDeliveries(publisher, own)).deliveries).toHaveLength(0);
    await w.owner`UPDATE records.webhook_deliveries SET available_at = now() WHERE id = ${id}`;
    claim = await claimWebhookDeliveries(publisher, own);
    expect(claim.deliveries[0]).toMatchObject({ id, attempts: 2 });
    await settleWebhookDelivery(publisher, claim.owner, claim.deliveries[0]!, { outcome: "failed", error: "The receiver could not be reached." }, { maxAttempts: 2 });
    const [dead] = await w.owner`SELECT state, settled_at IS NOT NULL AS settled FROM records.webhook_deliveries WHERE id = ${id}`;
    expect(dead).toEqual({ state: "dead", settled: true });
    const [hook] = await w.owner`SELECT consecutive_failures, status FROM records.webhooks WHERE id = ${hookId}`;
    expect(hook).toEqual({ consecutive_failures: 2, status: "active" });
  });

  it("disables a webhook after sustained failure; its deliveries wait; re-enabling resumes", async () => {
    await drain(hookId);
    await createIssue("Sustained", w.ds2, w.ops);
    await expandWebhookDeliveries(publisher, own);
    await w.owner`UPDATE records.webhooks SET failing_since = now() - interval '2 days' WHERE id = ${hookId}`;
    const claim = await claimWebhookDeliveries(publisher, own);
    await settleWebhookDelivery(publisher, claim.owner, claim.deliveries[0]!, { outcome: "failed", status: 503, error: "The receiver answered 503." },
      { disableAfterFailures: 3, disableAfterHours: 24 });
    const [hook] = await w.owner`SELECT status, disabled_reason FROM records.webhooks WHERE id = ${hookId}`;
    expect(hook!.status).toBe("disabled");
    expect(hook!.disabled_reason).toMatch(/consecutive failed deliveries/);
    // Disabled: nothing expands or is claimed.
    await w.owner`UPDATE records.webhook_deliveries SET available_at = now() WHERE webhook_id = ${hookId}`;
    await createIssue("While disabled", w.ds2, w.ops);
    expect(await expandWebhookDeliveries(publisher, own)).toBe(0);
    expect((await claimWebhookDeliveries(publisher, own)).deliveries).toHaveLength(0);
    // Re-enabled by a manager: the backlog expands and is delivered.
    await hooks.setWebhookEnabled(w.olive.caller, w.ds2, hookId, true);
    expect(await expandWebhookDeliveries(publisher, own)).toBe(1);
    expect((await claimWebhookDeliveries(publisher, own)).deliveries).toHaveLength(2);
  });

  it("reads the change as the creator, and reports lost access", async () => {
    await w.service.registry.addMember(w.olive.caller, w.ds2, { principalId: w.nia.id, role: "admin" });
    const nias = (await hooks.createWebhook(w.nia.caller, w.ds2, { label: "Nia's", url: "https://hooks.example.com/n" })).webhook.id;
    const issue = await createIssue("Read me", w.ds2, w.ops);
    await expandWebhookDeliveries(publisher, own);
    const claim = await claimWebhookDeliveries(publisher, { ...own, batch: 50 });
    const mine = claim.deliveries.find((d) => d.webhookId === nias)!;
    const change = await readWebhookChange(w.app, mine, mine.seq!);
    expect("entries" in change && change.entries.map((e) => [e.entityType, e.op, e.entityId, e.after.title])).toEqual([["issue", "create", issue.id, "Read me"]]);

    await w.service.registry.removeMember(w.olive.caller, w.ds2, { principalId: w.nia.id });
    const lost = await readWebhookChange(w.app, mine, mine.seq!);
    expect(lost).toEqual({ lost: expect.stringMatching(/no longer manages/) });
    await settleWebhookDelivery(publisher, claim.owner, mine, { outcome: "abandoned", error: (lost as { lost: string }).lost });
    const [hook] = await w.owner`SELECT status, disabled_reason FROM records.webhooks WHERE id = ${nias}`;
    expect(hook).toEqual({ status: "disabled", disabled_reason: expect.stringMatching(/no longer manages/) });
  });

  it("prunes settled deliveries past retention", async () => {
    await w.owner`UPDATE records.webhook_deliveries SET settled_at = now() - interval '40 days' WHERE webhook_id = ${hookId} AND state <> 'pending'`;
    expect(await pruneWebhookDeliveries(publisher)).toBeGreaterThan(0);
    const [left] = await w.owner`SELECT count(*)::int AS n FROM records.webhook_deliveries WHERE webhook_id = ${hookId} AND state <> 'pending'`;
    expect(left!.n).toBe(0);
  });
});
