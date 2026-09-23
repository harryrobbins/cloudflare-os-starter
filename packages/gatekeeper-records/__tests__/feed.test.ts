import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ChangeEvent, ChangeNotification } from "@records/contracts";

import type { Db } from "../src/db/context.ts";
import { consumeChanges } from "../src/feed/consumer.ts";
import { backoffSeconds, outboxLag, publishPending, pruneDelivered } from "../src/feed/publisher.ts";
import { createWorld, key, type World } from "./world.ts";

let w: World;
let publisher: Db;

class Sink {
  sent: ChangeEvent[] = [];
  fail = false;
  async sendBatch(messages: { body: ChangeEvent }[]) {
    if (this.fail) throw new Error("queue unavailable");
    this.sent.push(...messages.map((m) => m.body));
  }
}

beforeAll(async () => {
  w = await createWorld();
  publisher = postgres(w.db.publisherUrl, { max: 3, onnotice: () => {} }) as unknown as Db;
});
afterAll(async () => {
  await (publisher as unknown as { end(): Promise<void> })?.end();
  await w?.close();
});

async function drain(sink: Sink) {
  let total = 0;
  for (;;) {
    const r = await publishPending(publisher, sink);
    total += r.published;
    if (r.claimed === 0) return total;
  }
}

describe("outbox publication", () => {
  it("publishes every committed change exactly once in the happy path", async () => {
    const sink = new Sink();
    await drain(sink); // setup events
    sink.sent = [];
    const { record } = await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Feed" }, key());
    await w.service.projects.editIssue(w.ed.caller, w.ds1, { issueId: record.id, expectedRevision: 1, patch: { title: "Feed 2" } }, key());
    expect(await drain(sink)).toBe(2);
    expect(sink.sent.map((e) => [e.eventType, e.revision])).toEqual([["issue.created", 1], ["issue.updated", 2]]);
    expect(sink.sent.every((e) => e.datastoreId === w.ds1 && e.entityId === record.id)).toBe(true);
    // Nothing left.
    expect(await drain(sink)).toBe(0);
  });

  it("does not lose an event whose transaction commits after a later one was published", async () => {
    const sink = new Sink();
    await drain(sink);
    const early = postgres(w.db.appUrl, { max: 1, onnotice: () => {} });
    const eventId = crypto.randomUUID();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const slow = early.begin(async (tx) => {
      await tx`SELECT set_config('records.org_id', ${w.orgA}, true), set_config('records.datastore_id', ${w.ds1}, true)`;
      await tx`INSERT INTO records.outbox (event_id, org_id, datastore_id, event_type, entity_type, entity_id, revision)
               VALUES (${eventId}, ${w.orgA}, ${w.ds1}, 'issue.updated', 'issue', ${crypto.randomUUID()}, 7)`;
      await held; // stay uncommitted while a later transaction commits and is published
    });
    await new Promise((r) => setTimeout(r, 50));
    await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Later" }, key());
    expect(await drain(sink)).toBe(1);
    expect(sink.sent.some((e) => e.eventId === eventId)).toBe(false);
    release();
    await slow;
    await early.end();
    expect(await drain(sink)).toBe(1);
    expect(sink.sent.some((e) => e.eventId === eventId)).toBe(true);
  });

  it("backs off on failure and retries, and marks rows dead after max attempts", async () => {
    const sink = new Sink();
    await drain(sink);
    await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Retry" }, key());
    sink.fail = true;
    const failed = await publishPending(publisher, sink);
    expect(failed).toMatchObject({ claimed: 1, published: 0, failed: 1 });
    // Not yet available again (backoff), so nothing is claimed.
    expect((await publishPending(publisher, sink)).claimed).toBe(0);
    await (publisher as unknown as postgres.Sql)`UPDATE records.outbox SET available_at = now() WHERE state = 'pending'`;
    sink.fail = false;
    expect((await publishPending(publisher, sink)).published).toBe(1);

    await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Dead" }, key());
    sink.fail = true;
    const r = await publishPending(publisher, sink, { maxAttempts: 1 });
    expect(r.failed).toBe(1);
    expect((await outboxLag(publisher)).dead).toBeGreaterThanOrEqual(1);
    expect(backoffSeconds(1)).toBe(5);
    expect(backoffSeconds(30)).toBe(600);
  });

  it("re-sends after a crash between send and mark (lease expiry), producing a duplicate", async () => {
    const sink = new Sink();
    await drain(sink);
    await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Crash" }, key());
    // Simulate a publisher that claimed and sent, then crashed before marking.
    const claimed = await (publisher as unknown as postgres.Sql)`
      UPDATE records.outbox SET lease_owner = gen_random_uuid(), lease_until = now() - interval '1 second', attempts = attempts + 1
       WHERE state = 'pending' RETURNING event_id`;
    expect(claimed).toHaveLength(1);
    expect(await drain(sink)).toBe(1);
    expect(sink.sent[0]!.eventId).toBe(claimed[0]!.event_id);
  });

  it("concurrent publishers never claim the same row", async () => {
    const sink = new Sink();
    await drain(sink);
    for (let i = 0; i < 20; i++) await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: `Burst ${i}` }, key());
    const results = await Promise.all([1, 2, 3].map(() => publishPending(publisher, sink, { batch: 8 })));
    const claimed = results.reduce((n, r) => n + r.claimed, 0);
    await drain(sink);
    const ids = sink.sent.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(20);
    expect(claimed).toBeLessThanOrEqual(20);
  });

  it("prunes delivered rows and expired idempotency outcomes", async () => {
    await (publisher as unknown as postgres.Sql)`UPDATE records.outbox SET published_at = now() - interval '30 days' WHERE state = 'published'`;
    const pruned = await pruneDelivered(publisher);
    expect(pruned.outbox).toBeGreaterThan(0);
  });

  it("the publisher role cannot read business records even through the outbox", async () => {
    await expect((publisher as unknown as postgres.Sql)`SELECT title FROM projects.issues`).rejects.toThrow(/permission denied/);
  });
});

describe("queue consumer", () => {
  function message(body: unknown, attempts = 1) {
    const m = { id: crypto.randomUUID(), body, attempts, acked: false, retried: false, ack() { m.acked = true; }, retry() { m.retried = true; } };
    return m;
  }
  const event = (datastoreId: string, revision: number): ChangeEvent => ({
    v: 1, eventId: crypto.randomUUID(), orgId: crypto.randomUUID(), datastoreId, eventType: "issue.updated",
    entityType: "issue", entityId: "00000000-0000-4000-8000-000000000001", revision, occurredAt: new Date().toISOString(),
  });

  it("groups by datastore, acks delivered and invalid messages, retries failed groups", async () => {
    const a = crypto.randomUUID(), b = crypto.randomUUID();
    const msgs = [message(event(a, 1)), message(event(b, 2)), message({ nope: true }), message(event(a, 3))];
    const delivered: Record<string, ChangeNotification[]> = {};
    await consumeChanges({ messages: msgs } as never, {
      async deliver(ds, notes) {
        if (ds === b) throw new Error("feed down");
        delivered[ds] = notes;
      },
    });
    expect(delivered[a]!.map((n) => n.revision)).toEqual([1, 3]);
    expect(Object.keys(delivered[a]![0]!)).not.toContain("orgId");
    expect(msgs.map((m) => [m.acked, m.retried])).toEqual([[true, false], [false, true], [true, false], [true, false]]);
  });
});
