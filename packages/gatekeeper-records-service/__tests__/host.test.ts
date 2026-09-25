import { describe, expect, it } from "vitest";
import { recordsOsIntentDigest } from "@records/service/src/cloudflare-os.ts";
import { approvedDatastores, datastoreUrl, parseDatastoreUrl, serviceUrl, type ApprovedDatastore } from "../src/config.js";
import { bindingId, describeAction, fetchModel, pendingStore, queueAdapter, RecordsOsBridge, recordsFailure, recordsHost, addObserver, SessionCore } from "../src/host.js";
import type { RecordsConnection } from "../src/types.js";
import { DATASTORE, KEY, fakeQueue, fakeRecordsService, memoryStorage } from "./fakes.js";

const URL_BASE = "https://records.test";

function setup(access: "read" | "write" = "write", options: Parameters<typeof fakeRecordsService>[0] = {}) {
  const service = fakeRecordsService(options);
  const storage = memoryStorage();
  const workshop = fakeQueue();
  let approved: ApprovedDatastore | undefined = { id: DATASTORE, label: "Team work", key: KEY };
  const resource = parseDatastoreUrl(datastoreUrl(DATASTORE, "work", 1, access));
  const make = (queue: typeof workshop.queue | null) => {
    const pending = pendingStore(storage);
    return new RecordsOsBridge(recordsHost({
      serviceUrl: URL_BASE, resource, storage, fetch: service.fetch, datastore: () => approved,
      queue: queue ? queueAdapter(queue, pending, "Team work") : { consumeViewerAssertion: () => { throw new Error("no"); }, authorizeObservation: () => { throw new Error("no"); }, submitAction: () => { throw new Error("no"); } },
    }));
  };
  const connection: RecordsConnection = { url: resource.url, datastore: DATASTORE, binding: bindingId(storage), label: "Team work", moduleId: "work", apiMajor: 1, access, scopes: [] };
  const session = new SessionCore(make(workshop.queue), connection, () => fetchModel(URL_BASE, "work", 1, service.fetch));
  const trusted = make(null);
  return { service, storage, workshop, session, trusted, connection, revoke: () => { approved = undefined; } };
}

/** What the browser does: hash the complete intent and ask the Workshop for an assertion. */
async function request(env: ReturnType<typeof setup>, command: string, input: Record<string, unknown>, revision?: number) {
  const idempotencyKey = crypto.randomUUID();
  const digest = await recordsOsIntentDigest({
    datastore: env.connection.datastore, binding: env.connection.binding, moduleId: "work", apiMajor: 1, command, input,
    expectedRevision: revision ?? null, idempotencyKey,
  });
  const viewerAssertion = env.workshop.assert(digest);
  return env.session.command(command, input, { viewerAssertion, idempotencyKey, ...(revision === undefined ? {} : { revision }) });
}

describe("configuration", () => {
  it("accepts only bare https origins", () => {
    expect(serviceUrl("https://records.surprisingly.ltd")).toBe("https://records.surprisingly.ltd");
    expect(() => serviceUrl("http://records.surprisingly.ltd")).toThrow();
    expect(() => serviceUrl("https://records.surprisingly.ltd/v1")).toThrow();
    expect(() => serviceUrl(undefined)).toThrow();
  });

  it("parses approved datastores without echoing credentials", () => {
    expect(approvedDatastores(JSON.stringify([{ id: DATASTORE.toUpperCase(), label: " Team ", key: KEY }]))).toEqual([{ id: DATASTORE, label: "Team", key: KEY }]);
    expect(approvedDatastores(undefined)).toEqual([]);
    const bad = () => approvedDatastores(JSON.stringify([{ id: DATASTORE, key: "short" }]));
    expect(bad).toThrow(/credential/);
    try { approvedDatastores(`[{"id":"x","key":"${KEY}"`); } catch (error) { expect(String(error)).not.toContain(KEY); }
    expect(() => approvedDatastores(JSON.stringify([{ id: DATASTORE, key: KEY }, { id: DATASTORE, key: KEY }]))).toThrow(/unique/);
  });

  it("round-trips canonical resource URLs and rejects others", () => {
    const url = datastoreUrl(DATASTORE, "work", 1, "write");
    expect(url).toBe(`records-service://datastore/${DATASTORE}/work/v1/write`);
    expect(parseDatastoreUrl(url)).toMatchObject({ datastore: DATASTORE, moduleId: "work", apiMajor: 1, access: "write" });
    for (const bad of [`records-service://datastore/${DATASTORE}/work/v1/admin`, `records://datastore/${DATASTORE}`, `records-service://datastore/nope/work/v1/read`]) {
      expect(() => parseDatastoreUrl(bad)).toThrow();
    }
  });
});

describe("observed reads", () => {
  it("authorises each read as an observation, excluding no verified observer", async () => {
    const env = setup();
    addObserver(env.storage, "observer-1");
    const snapshot = await env.session.snapshot(100);
    expect(snapshot).toMatchObject({ records: [], seq: 0, complete: true });
    expect(env.workshop.log).toEqual(["observe:Snapshot Records datastore"]);
    expect(env.workshop.excluded).toEqual([]);
    expect(env.service.requests.every((r) => !r.path.includes(KEY))).toBe(true);
  });

  it("excludes observers once the datastore is no longer approved", async () => {
    const env = setup();
    addObserver(env.storage, "observer-1");
    env.revoke();
    await expect(env.session.describe()).rejects.toThrow(/^forbidden: /);
  });

  it("validates queries before calling the service", async () => {
    const env = setup();
    await expect(env.session.records({ entity: "work_item; drop", limit: 10 })).rejects.toThrow(/^invalid_request/);
    await expect(env.session.records({ order: "title" })).rejects.toThrow(/^invalid_request/);
    await expect(env.session.snapshot(9000)).rejects.toThrow(/^invalid_request/);
    expect(env.service.requests).toHaveLength(0);
  });

  it("reports an epoch change as reset_required", async () => {
    const env = setup();
    await expect(env.session.changes(0, 99)).rejects.toThrow(/^reset_required: /);
  });

  it("serves the public model without a credential", async () => {
    const env = setup();
    const model = await env.session.model();
    expect(model.profile?.entities.work_item).toBeDefined();
    expect(model.schemas.work_item).toMatchObject({ type: "object" });
    expect(env.service.requests.filter((r) => r.path.startsWith("/v1/models")).every((r) => !r.headers.authorization)).toBe(true);
  });
});

describe("approved commands", () => {
  it("submits a pending action and executes only on applyAction, once", async () => {
    const env = setup();
    const outcome = await request(env, "work.create", { title: "Ship the board", status: "open" });
    expect(outcome).toEqual({ status: "pending", actionId: 1 });
    expect(env.service.rows.size).toBe(0);
    const [submitted] = env.workshop.submitted;
    expect(submitted!.description.autoApprovable).toBe(true);
    expect(submitted!.description.description).toContain("ada@example.com");
    expect(submitted!.description.description).toContain("Ship the board");
    expect(submitted!.description.actionKind?.tag).toBe("records.work.work.create");

    await env.trusted.applyAction(1);
    await env.trusted.applyAction(1);
    expect(env.service.rows.size).toBe(1);
    const applied = await env.session.getOutcome(1);
    expect(applied).toMatchObject({ status: "applied", result: { record: { data: { title: "Ship the board" } } } });
  });

  it("refuses an assertion made for a different intent", async () => {
    const env = setup();
    const viewerAssertion = env.workshop.assert("0".repeat(64));
    await expect(env.session.command("work.create", { title: "x" }, { viewerAssertion, idempotencyKey: "k-1" })).rejects.toThrow(/^forbidden: /);
    expect(env.workshop.submitted).toHaveLength(0);
  });

  it("refuses commands on a read-only connection before touching the Workshop", async () => {
    const env = setup("read", { scopes: ["work.read"] });
    await expect(request(env, "work.create", { title: "x" })).rejects.toThrow(/^read_only: /);
    expect(env.workshop.log).toEqual([]);
  });

  it("rejects a stale revision at apply time and records the outcome", async () => {
    const env = setup();
    await request(env, "work.create", { title: "First" });
    await env.trusted.applyAction(1);
    const [row] = env.service.rows.values();
    await request(env, "work.update", { id: row!.id, status: "active" }, row!.revision);
    await request(env, "work.update", { id: row!.id, status: "done" }, row!.revision);
    await env.trusted.applyAction(2);
    await expect(env.trusted.applyAction(3)).rejects.toMatchObject({ status: 412 });
    expect(await env.session.getOutcome(3)).toEqual({ status: "rejected", reason: "Records refused the command (412)" });
    expect([...env.service.rows.values()][0]!.data.status).toBe("active");
  });

  it("rejects an approved action whose datastore was removed from the approved list", async () => {
    const env = setup();
    await request(env, "work.create", { title: "Later" });
    env.revoke();
    await expect(env.trusted.applyAction(1)).rejects.toThrow();
    expect(env.service.rows.size).toBe(0);
    const stored = await pendingStore(env.storage).get(1);
    expect(stored?.outcome).toEqual({ status: "rejected", reason: "Viewer authority was revoked or changed" });
  });

  it("marks denied actions rejected without executing them", async () => {
    const env = setup();
    await request(env, "work.create", { title: "No" });
    await env.trusted.rejectAction(1);
    await env.trusted.applyAction(1);
    expect(env.service.rows.size).toBe(0);
    expect(await env.session.getOutcome(1)).toEqual({ status: "rejected", reason: "Approval was denied" });
  });
});

describe("helpers", () => {
  it("maps service statuses to stable codes", async () => {
    const { RecordsError } = await import("@records/service/src/client.ts");
    expect(recordsFailure(new RecordsError(412, {})).message).toMatch(/^stale_revision: /);
    expect(recordsFailure(new RecordsError(413, {})).message).toMatch(/^too_large: /);
    expect(recordsFailure(new RecordsError(503, {})).message).toMatch(/^unavailable: /);
    expect(recordsFailure(new TypeError("fetch failed")).message).toMatch(/^unavailable: /);
  });

  it("describes stored actions for approvers", () => {
    const text = describeAction({
      intent: { datastore: DATASTORE, binding: "b", moduleId: "work", apiMajor: 1, command: "work.update", input: { id: "r-1", title: "New\ntitle" }, expectedRevision: 4, idempotencyKey: "k" },
      digest: "d", viewerId: "ada@example.com", principal: "p",
    }, "Team work");
    expect(text).toContain("Record: `r-1` (revision 4)");
    expect(text).toContain("title: New title");
  });
});
