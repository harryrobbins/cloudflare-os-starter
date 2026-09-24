import { describe, expect, it, vi } from "vitest";
import { intentDigest } from "../../records-contracts/src/caller.ts";
import { SyncTransportError } from "../../records-sync-client/src/index.ts";
import { gadgetTransport, syncIdempotencyKey, toTransportError } from "../src/client/transport.js";
import { FakeRecords, fakeGadget } from "./fake-records.js";

const push = (mutations, clientId = "client-000001") => ({ clientGroupId: "group-000001", clientId, mutations });
const move = (id, toState = "todo") => ({ id, name: "projects.transitionIssue", args: { issueId: "iss-1", expectedRevision: id, toState }, timestamp: 1 });

describe("gadget sync transport", () => {
  it("asserts each mutation's sync intent and passes request and assertions through", async () => {
    const records = new FakeRecords();
    const gadget = fakeGadget(records);
    const request = push([move(1), { id: 2, name: "projects.addComment", args: { id: "c-1", issueId: "iss-1", body: "hi" } }]);
    const res = await gadgetTransport(gadget).push(request);
    expect(res.outcomes.map((o) => o.status)).toEqual(["applied", "applied"]);
    const expected = await Promise.all([
      intentDigest({ operation: "transitionIssue", input: request.mutations[0].args, idempotencyKey: "sync:client-000001:1" }),
      intentDigest({ operation: "addComment", input: request.mutations[1].args, idempotencyKey: "sync:client-000001:2" }),
    ]);
    expect(gadget.assertions).toEqual(expected.map((digest) => ({ binding: "RECORDS", digest })));
    const [call] = records.pushCalls();
    expect(call.request).toEqual(request);
    expect(call.options.map((o) => o.viewerAssertion.startsWith(`assert:${expected[0]}:`) || o.viewerAssertion.startsWith(`assert:${expected[1]}:`))).toEqual([true, true]);
    expect(syncIdempotencyKey("abc", 7)).toBe("sync:abc:7");
  });

  it("is refused by the gatekeeper when a mutation changes after it was asserted", async () => {
    const records = new FakeRecords();
    const gadget = fakeGadget(records);
    const tampering = { ...gadget, syncPush: (req, options) => gadget.syncPush({ ...req, mutations: [move(1, "done")] }, options) };
    const err = await gadgetTransport(tampering).push(push([move(1)])).catch((e) => e);
    expect(err).toBeInstanceOf(SyncTransportError);
    expect(err).toMatchObject({ kind: "client", status: 401, code: "unauthenticated" });
    expect(records.issue("iss-1").state).toBe("backlog");
  });

  it("sends nothing without an assertion", async () => {
    const records = new FakeRecords();
    const err = await gadgetTransport(fakeGadget(records, { assertion: () => null })).push(push([move(1)])).catch((e) => e);
    expect(err).toMatchObject({ kind: "client", code: "assertion_unavailable" });
    const thrown = await gadgetTransport(fakeGadget(records, { assertion: () => { throw new Error("not signed in"); } })).push(push([move(1)])).catch((e) => e);
    expect(thrown).toMatchObject({ kind: "client", code: "assertion_failed" });
    expect(thrown.message).toContain("not signed in");
    expect(records.pushCalls()).toHaveLength(0);
  });

  it("mints fresh assertions for a retried push", async () => {
    const records = new FakeRecords();
    const gadget = fakeGadget(records);
    const transport = gadgetTransport(gadget);
    records.nextPushThrows = new Error("Network connection lost.");
    await expect(transport.push(push([move(1)]))).rejects.toMatchObject({ kind: "network" });
    const res = await transport.push(push([move(1)]));
    expect(res.outcomes[0].status).toBe("applied");
    const [a, b] = records.pushCalls().map((c) => c.options[0].viewerAssertion);
    expect(a).not.toBe(b);
  });

  it("pulls and checks approvals through the gadget", async () => {
    const records = new FakeRecords({ approvals: true });
    const transport = gadgetTransport(fakeGadget(records));
    const res = await transport.push(push([move(1)]));
    expect(res.outcomes[0]).toMatchObject({ status: "pending", actionId: 1 });
    expect(await transport.approvals([1, 99])).toEqual([{ actionId: 1, status: "pending" }, { actionId: 99, status: "expired" }]);
    const pull = await transport.pull({ clientGroupId: "group-000001", cookie: null });
    expect(pull.patch[0]).toEqual({ op: "clear" });
    expect(pull.lastMutationIdChanges).toEqual({ "client-000001": 1 });
  });

  it("maps Records errors to retry behaviour", () => {
    expect(toTransportError(new Error("unavailable: db down"))).toMatchObject({ kind: "server", status: 503, retryable: true });
    expect(toTransportError(new Error("rate_limited: slow down"))).toMatchObject({ kind: "server", status: 429 });
    expect(toTransportError(new Error("Network connection lost."))).toMatchObject({ kind: "network", retryable: true });
    expect(toTransportError(new Error("validation_failed: bad args"))).toMatchObject({ kind: "client", status: 400, code: "validation_failed" });
    expect(toTransportError(new Error("forbidden: no"))).toMatchObject({ kind: "client", status: 403, retryable: false, message: "no" });
    expect(toTransportError(new Error("payload_too_large: big"))).toMatchObject({ kind: "client", status: 413 });
    const already = new SyncTransportError("client", "x", 401, "y");
    expect(toTransportError(already)).toBe(already);
    expect(vi.isMockFunction(toTransportError)).toBe(false);
  });
});
