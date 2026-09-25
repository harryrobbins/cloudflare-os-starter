import { describe, expect, it } from "vitest";
import { applyChanges, changedFields, columns, fromSnapshot, isWorkV1, validTitle } from "../src/client/model.js";

const rec = (id, revision, data) => ({ id, entity: "work_item", revision, data });

describe("board model", () => {
  it("groups items by status, defaulting unknown statuses to open", () => {
    const state = fromSnapshot({ records: [rec("b", 1, { title: "B", status: "active" }), rec("a", 2, { title: "A", status: "weird" }), rec("c", 3, { title: "C", status: "done" })], seq: 3, permission_epoch: 1 });
    const grouped = columns(state);
    expect(grouped.open.map((i) => i.id)).toEqual(["a"]);
    expect(grouped.active.map((i) => i.id)).toEqual(["b"]);
    expect(grouped.done.map((i) => i.id)).toEqual(["c"]);
    expect(state).toMatchObject({ cursor: 3, epoch: 1 });
  });

  it("applies a journal page, ignoring replays and other entities", () => {
    const state = fromSnapshot({ records: [rec("a", 2, { title: "A", status: "open" })], seq: 2, permission_epoch: 1 });
    const next = applyChanges(state, { changes: [
      { entity: "work_item", record_id: "a", revision: 1, data: { title: "old" } },
      { entity: "work_item", record_id: "a", revision: 4, data: { title: "A2", status: "done" } },
      { entity: "message", record_id: "m", revision: 5, data: {} },
      { entity: "work_item", record_id: "n", revision: 6, data: { title: "New" } },
    ], cursor: 6, permission_epoch: 1 });
    expect(next.items.get("a")).toMatchObject({ revision: 4, data: { title: "A2" } });
    expect(next.items.has("m")).toBe(false);
    expect(next.items.get("n").revision).toBe(6);
    expect(next.cursor).toBe(6);
    expect(state.items.get("a").revision).toBe(2);
  });

  it("validates titles and diffs edits", () => {
    expect(validTitle("  x ")).toEqual({ ok: true, title: "x" });
    expect(validTitle("   ").ok).toBe(false);
    expect(validTitle("x".repeat(501)).ok).toBe(false);
    expect(changedFields(rec("a", 1, { title: "A", status: "open" }), { title: "A", description: "", status: "done" })).toEqual({ status: "done" });
    expect(isWorkV1({ module_id: "work", api_major: 1 })).toBe(true);
    expect(isWorkV1({ module_id: "messaging", api_major: 1 })).toBe(false);
  });
});
