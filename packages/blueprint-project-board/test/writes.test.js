import { afterEach, describe, expect, it, vi } from "vitest";
import { intentDigest } from "../../records-contracts/src/caller.ts";
import { createWriteTracker, outcomeFromError, plainInput, submitWrite } from "../src/client/writes.js";
import { FakeRecords, fakeGadget } from "./fake-records.js";

afterEach(() => vi.useRealTimers());

const edit = (records, patch = { title: "Renamed" }) =>
  ({ issueId: "iss-1", expectedRevision: records.issues.get("iss-1").revision, patch });

describe("digest pass-through", () => {
  it("asks the host for an assertion over exactly the input and key it sends", async () => {
    const records = new FakeRecords();
    const gadget = fakeGadget(records);
    const input = plainInput(edit(records));
    const outcome = await submitWrite(gadget, "editIssue", input, "key-1");
    expect(outcome.status).toBe("applied");
    const expected = await intentDigest({ operation: "editIssue", input, idempotencyKey: "key-1" });
    expect(gadget.assertions).toEqual([{ binding: "RECORDS", digest: expected }]);
    const call = records.writeCalls()[0];
    expect(call.input).toEqual(input);
    expect(call.options).toEqual({ idempotencyKey: "key-1", viewerAssertion: `assert:${expected}` });
  });

  it("is rejected by the gatekeeper when the input changes after digesting", async () => {
    const records = new FakeRecords();
    const gadget = fakeGadget(records);
    const tampering = { ...gadget, editIssue: (input, options) => gadget.editIssue({ ...input, patch: { title: "Other" } }, options) };
    tampering.$createViewerAssertion = gadget.$createViewerAssertion;
    expect((await submitWrite(tampering, "editIssue", plainInput(edit(records)), "k")).status).toBe("rejected");
    expect(records.issues.get("iss-1").title).toBe("Issue 1");
  });

  it("drops undefined members before digesting", () => {
    expect(plainInput({ a: 1, b: undefined, c: { d: undefined } })).toEqual({ a: 1, c: {} });
  });

  it("does not send a write when no assertion is available", async () => {
    const records = new FakeRecords();
    const gadget = fakeGadget(records, { assertion: () => null });
    const outcome = await submitWrite(gadget, "editIssue", plainInput(edit(records)), "k");
    expect(outcome).toMatchObject({ status: "rejected", code: "assertion_unavailable" });
    expect(records.writeCalls()).toHaveLength(0);
  });
});

describe("outcome handling", () => {
  it("classifies thrown errors", () => {
    expect(outcomeFromError(new Error("revision_conflict: stale"))).toMatchObject({ status: "conflict", code: "revision_conflict" });
    expect(outcomeFromError(new Error("forbidden: no"))).toMatchObject({ status: "rejected", code: "forbidden" });
    expect(outcomeFromError(new Error("unavailable: db down"))).toMatchObject({ status: "unknown" });
    expect(outcomeFromError(new Error("Network connection lost."))).toMatchObject({ status: "unknown", code: "transport" });
  });

  it("reports applied only when Records applied it", async () => {
    const records = new FakeRecords();
    const updates = [];
    const tracker = createWriteTracker({ gadget: fakeGadget(records), onUpdate: (e) => updates.push(e.status) });
    const entry = await tracker.start("editIssue", edit(records), { label: "edit", issueId: "iss-1" });
    expect(entry.status).toBe("applied");
    expect(entry.record.title).toBe("Renamed");
    expect(updates).toEqual(["saving", "applied"]);
  });

  it("polls a pending approval until it is applied, persisting its id meanwhile", async () => {
    vi.useFakeTimers();
    const records = new FakeRecords({ writeMode: "pending" });
    const persisted = [];
    const applied = [];
    const tracker = createWriteTracker({ gadget: fakeGadget(records), persist: (p) => persisted.push(p), onApplied: (e) => applied.push(e) });
    const entry = await tracker.start("transitionIssue", { issueId: "iss-1", expectedRevision: 1, toState: "doing" }, { label: "move", issueId: "iss-1" });
    expect(entry).toMatchObject({ status: "pending", actionId: 101 });
    expect(records.issues.get("iss-1").state).toBe("todo");
    expect(persisted.at(-1)).toEqual([expect.objectContaining({ actionId: 101 })]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(entry.status).toBe("pending");
    records.approve(101);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(entry.status).toBe("applied");
    expect(applied).toHaveLength(1);
    expect(persisted.at(-1)).toEqual([]);
    tracker.dispose();
  });

  it("reports a declined approval as rejected", async () => {
    vi.useFakeTimers();
    const records = new FakeRecords({ writeMode: "pending" });
    const tracker = createWriteTracker({ gadget: fakeGadget(records) });
    const entry = await tracker.start("addComment", { issueId: "iss-1", body: "hi" }, { label: "c", issueId: "iss-1" });
    records.approve(entry.actionId, false);
    await tracker.refreshPending(entry.id);
    expect(entry).toMatchObject({ status: "rejected", code: "denied" });
  });

  it("surfaces revision conflicts", async () => {
    const records = new FakeRecords();
    const tracker = createWriteTracker({ gadget: fakeGadget(records) });
    const input = edit(records);
    records.touch("iss-1", { title: "Bob's title" });
    const entry = await tracker.start("editIssue", input, { label: "edit", issueId: "iss-1" });
    expect(entry).toMatchObject({ status: "conflict", code: "revision_conflict", currentRevision: 2 });
    expect(records.issues.get("iss-1").title).toBe("Bob's title");
  });

  it("checks a lost reply again with the same key and input, and Records replays it", async () => {
    const records = new FakeRecords();
    const gadget = fakeGadget(records);
    const tracker = createWriteTracker({ gadget });
    records.loseNextReply = true;
    const entry = await tracker.start("createIssue", { projectId: "prj-1", title: "Once" }, { label: "new", issueId: null });
    expect(entry.status).toBe("unknown");
    await tracker.checkAgain(entry.id);
    expect(entry.status).toBe("applied");
    const [first, second] = records.writeCalls();
    expect(second.options.idempotencyKey).toBe(first.options.idempotencyKey);
    expect(second.input).toEqual(first.input);
    expect([...records.issues.values()].filter((i) => i.title === "Once")).toHaveLength(1);
  });

  it("re-adopts pending approvals after a reload", async () => {
    const records = new FakeRecords({ writeMode: "pending" });
    const t1 = createWriteTracker({ gadget: fakeGadget(records) });
    const e1 = await t1.start("addComment", { issueId: "iss-1", body: "x" }, { label: "c", issueId: "iss-1" });
    records.approve(e1.actionId);
    const t2 = createWriteTracker({ gadget: fakeGadget(records) });
    t2.restore([{ actionId: e1.actionId, idempotencyKey: e1.idempotencyKey, operation: "addComment", label: "c", issueId: "iss-1" }]);
    await vi.waitFor(() => expect(t2.list()[0].status).toBe("applied"));
    t1.dispose(); t2.dispose();
  });
});
