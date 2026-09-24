import { describe, expect, it, vi } from "vitest";
import { PokeLog } from "../src/server/pokes.js";
import { createRecordsProxy, WRITE_METHODS } from "../src/server/proxy.js";
import { createPokeChannel } from "../src/client/pokes.js";
import { FakeRecords, memoryKv } from "./fake-records.js";
import REQUIREMENT from "../src/service-requirement.json";
import { ServiceRequirementSchema, checkCompatibility, PROJECTS_API_V1 } from "../../records-contracts/src/manifest.ts";
import { BLUEPRINT_BINDINGS } from "../src/shared/records.js";

const setup = (records) => {
  const pokes = new PokeLog(memoryKv());
  const hookStub = { persistent: true };
  const proxy = createRecordsProxy(() => (records ? { RECORDS: records } : {}), pokes, async () => hookStub);
  return { pokes, proxy, hookStub };
};

describe("service requirement", () => {
  it("is a valid, compatible Projects v1 requirement", () => {
    expect(ServiceRequirementSchema.parse(REQUIREMENT)).toEqual(REQUIREMENT);
    expect(REQUIREMENT).toMatchObject({ service: "records", moduleId: "projects", apiMajor: 1 });
    expect(checkCompatibility(REQUIREMENT, { moduleId: "projects", apiVersions: [1], features: [...PROJECTS_API_V1.features] }, PROJECTS_API_V1.scopes))
      .toEqual({ compatible: true });
  });
  it("declares the RECORDS gatekeeper binding", () => {
    expect(BLUEPRINT_BINDINGS.RECORDS).toMatchObject({ type: "gatekeeper", gatekeeperName: "records" });
  });
});

describe("gadget server proxy", () => {
  it("passes a sync push's request and options through by identity", async () => {
    const records = { syncPush: vi.fn(async () => ({ outcomes: [], head: 0 })) };
    const { proxy } = setup(records);
    expect(WRITE_METHODS).toEqual(["syncPush"]);
    const request = { clientGroupId: "g", clientId: "c", mutations: [{ id: 1, name: "projects.editIssue", args: { patch: { title: "t", extra: undefined } } }] };
    const options = [{ viewerAssertion: "a" }];
    await proxy.syncPush(request, options);
    expect(records.syncPush.mock.calls[0][0]).toBe(request);
    expect(records.syncPush.mock.calls[0][1]).toBe(options);
    expect(Object.keys(request.mutations[0].args.patch)).toEqual(["title", "extra"]); // not normalised
  });

  it("no longer exposes the single-write methods", () => {
    const { proxy } = setup(new FakeRecords());
    for (const m of ["createIssue", "editIssue", "transitionIssue", "addComment", "getWriteOutcome", "getChanges"]) expect(proxy).not.toHaveProperty(m);
  });

  it("reports a missing binding as not_connected", async () => {
    const { proxy } = setup(null);
    expect(await proxy.getSetup()).toMatchObject({ connected: false, binding: null });
    expect(() => proxy.syncPull({ clientGroupId: "g", cookie: null })).toThrow(/^not_connected:/);
  });

  it("reports describe() failures without throwing", async () => {
    const records = new FakeRecords();
    records.readError = new Error("forbidden: not a member");
    const { proxy } = setup(records);
    expect(await proxy.getSetup()).toMatchObject({ connected: true, binding: null, error: "forbidden: not a member" });
  });

  it("registers the persistent hook for pokes and marks live updates requested", async () => {
    const records = new FakeRecords();
    const { proxy, hookStub } = setup(records);
    const summary = await proxy.requestLiveUpdates();
    expect(records.hooks).toEqual([{ callback: hookStub, options: { deliver: "pokes" } }]);
    expect(summary.live).toBe("requested");
  });
});

describe("poke log", () => {
  it("keeps the highest head and goes active on first delivery", () => {
    const log = new PokeLog(memoryKv());
    expect(log.summary()).toMatchObject({ live: "off", head: null, nudges: 0 });
    log.markRequested();
    expect(log.summary().live).toBe("requested");
    log.poked({ datastoreId: "ds", head: 7 });
    log.poked({ datastoreId: "ds", head: 5 }); // out of order
    log.poked({ datastoreId: "ds", head: "9" }); // malformed
    log.poked(null);
    expect(log.summary()).toMatchObject({ live: "active", head: 7, nudges: 0, datastoreId: "ds" });
  });

  it("nudges on a legacy change notification or a different datastore", () => {
    const log = new PokeLog(memoryKv());
    log.poked({ datastoreId: "ds", head: 40 });
    log.nudge();
    expect(log.summary().nudges).toBe(1);
    log.poked({ datastoreId: "other", head: 3 });
    expect(log.summary()).toMatchObject({ head: 3, nudges: 2, datastoreId: "other" });
  });
});

describe("poke channel", () => {
  it("pokes the client with a newer head, and falls back to timed pulls until live", async () => {
    vi.useFakeTimers();
    try {
      const log = new PokeLog(memoryKv());
      const gadget = { getPokes: async () => log.summary(), requestLiveUpdates: async () => { log.markRequested(); return log.summary(); } };
      const heads = [];
      const channel = createPokeChannel({ gadget, liveTickMs: 100, pollMs: 1_000 });
      const stop = channel.subscribe((h) => heads.push(h));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(heads).toEqual([Infinity]); // not live: a pull per poll interval
      await channel.requestLive();
      log.poked({ datastoreId: "ds", head: 12 });
      await vi.advanceTimersByTimeAsync(100);
      expect(heads).toEqual([Infinity, 12]);
      expect(channel.live).toBe("active");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(heads).toEqual([Infinity, 12]); // live and unchanged: no pulls from the channel
      log.nudge();
      await vi.advanceTimersByTimeAsync(100);
      expect(heads).toEqual([Infinity, 12, Infinity]);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
