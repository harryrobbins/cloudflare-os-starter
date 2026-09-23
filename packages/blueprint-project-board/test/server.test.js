import { describe, expect, it, vi } from "vitest";
import { ChangeFeed, MAX_RETAINED } from "../src/server/feed.js";
import { createRecordsProxy, WRITE_METHODS } from "../src/server/proxy.js";
import { FakeRecords, memoryKv } from "./fake-records.js";
import REQUIREMENT from "../src/service-requirement.json";
import { ServiceRequirementSchema, checkCompatibility, PROJECTS_API_V1 } from "../../records-contracts/src/manifest.ts";
import { BLUEPRINT_BINDINGS } from "../src/shared/records.js";

const setup = (records) => {
  const feed = new ChangeFeed(memoryKv());
  const hookStub = { persistent: true };
  const proxy = createRecordsProxy(() => (records ? { RECORDS: records } : {}), feed, async () => hookStub);
  return { feed, proxy, hookStub };
};

describe("service requirement", () => {
  it("is a valid, compatible Projects v1 requirement", () => {
    expect(ServiceRequirementSchema.parse(REQUIREMENT)).toEqual(REQUIREMENT);
    expect(checkCompatibility(REQUIREMENT, { moduleId: "projects", apiVersions: [1], features: [...PROJECTS_API_V1.features] }, PROJECTS_API_V1.scopes))
      .toEqual({ compatible: true });
  });
  it("declares the RECORDS gatekeeper binding", () => {
    expect(BLUEPRINT_BINDINGS.RECORDS).toMatchObject({ type: "gatekeeper", gatekeeperName: "records" });
  });
});

describe("gadget server proxy", () => {
  it("passes every write's input and options through by identity", async () => {
    const records = { };
    for (const m of WRITE_METHODS) records[m] = vi.fn(async () => ({ status: "applied", record: {}, replayed: false }));
    const { proxy } = setup(records);
    for (const m of WRITE_METHODS) {
      const input = { issueId: "x", patch: { title: "t", extra: undefined } };
      const options = { idempotencyKey: "k", viewerAssertion: "a" };
      await proxy[m](input, options);
      expect(records[m]).toHaveBeenCalledTimes(1);
      expect(records[m].mock.calls[0][0]).toBe(input);
      expect(records[m].mock.calls[0][1]).toBe(options);
      expect(Object.keys(input.patch)).toEqual(["title", "extra"]); // not normalised
    }
  });

  it("reports a missing binding as not_connected", async () => {
    const { proxy } = setup(null);
    expect(await proxy.getSetup()).toMatchObject({ connected: false, binding: null });
    expect(() => proxy.listProjects()).toThrow(/^not_connected:/);
  });

  it("reports describe() failures without throwing", async () => {
    const records = new FakeRecords();
    records.readError = new Error("forbidden: not a member");
    const { proxy } = setup(records);
    expect(await proxy.getSetup()).toMatchObject({ connected: true, binding: null, error: "forbidden: not a member" });
  });

  it("registers the persistent hook stub and marks live updates requested", async () => {
    const records = new FakeRecords();
    const { proxy, hookStub } = setup(records);
    const feed = await proxy.requestLiveUpdates();
    expect(records.hooks).toEqual([hookStub]);
    expect(feed.live).toBe("requested");
  });
});

describe("change feed", () => {
  it("returns changes after a cursor and goes active on first delivery", () => {
    const feed = new ChangeFeed(memoryKv());
    const start = feed.since();
    expect(start).toMatchObject({ seq: 0, live: "off", refetchAll: false });
    feed.record([{ entityType: "issue", entityId: "iss-1", revision: 2, eventType: "issue.edited" }, { bogus: true }]);
    const next = feed.since({ epoch: start.epoch, seq: 0 });
    expect(next.live).toBe("active");
    expect(next.changes).toEqual([{ seq: 1, entityType: "issue", entityId: "iss-1", revision: 2, eventType: "issue.edited" }]);
    expect(feed.since({ epoch: start.epoch, seq: 1 }).changes).toEqual([]);
  });

  it("asks for a full refetch on resync, epoch change or a gap", () => {
    const feed = new ChangeFeed(memoryKv());
    const { epoch } = feed.since();
    feed.resync();
    expect(feed.since({ epoch, seq: 0 }).refetchAll).toBe(true);
    expect(feed.since({ epoch, seq: 1 }).refetchAll).toBe(false);
    expect(feed.since({ epoch: "other", seq: 1 }).refetchAll).toBe(true);
    feed.record(Array.from({ length: MAX_RETAINED + 5 }, (_, i) => ({ entityType: "issue", entityId: `i${i}`, revision: 1 })));
    expect(feed.since({ epoch, seq: 1 }).refetchAll).toBe(true);
  });
});
