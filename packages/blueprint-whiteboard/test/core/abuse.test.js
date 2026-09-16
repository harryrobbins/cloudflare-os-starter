// What one hostile or unlucky caller can do to everyone else: requestId poisoning, stored values
// that outgrow storage once V8-serialised, order-key ceilings, oversized convenience calls, CPU
// spent exporting crafted text, and walking back through undo.
import { serialize } from "node:v8";
import { describe, expect, it } from "vitest";
import { LIMITS, isAcceptableOrderKey, storedBytes } from "../../src/shared/protocol.js";
import { isValidOrderKey, keyBetween } from "../../src/shared/order.js";
import { InMemoryRepository } from "../../src/core/repository.js";
import { createWhiteboard } from "../../src/core/whiteboard.js";
import { EXPORT_TEXT_BUDGET } from "../../src/shared/render.js";
import { apply, create, createOp, deleteOp, oid, setup, updateOp } from "./helpers.js";

const KIB = 1024;
/** Durable Object storage (KV backend) accepts at most this many bytes per value. */
const VALUE_MAX = 128 * KIB;

describe("requestId records are per sender", () => {
  it("a peer recording a victim's requestIds first cannot suppress the victim's request", async () => {
    const { board, repo } = setup();
    for (let seq = 1; seq <= 5; seq++) await apply(board, { senderId: "attacker", requestId: `victim:${seq}` });
    for (let seq = 1; seq <= 5; seq++) await apply(board, { requestId: `victim:${seq}` }); // no senderId at all
    const op = createOp({ text: "important" });
    const r = await apply(board, { senderId: "victim", requestId: "victim:1", objectOps: [op] });
    expect(r).toMatchObject({ status: "applied" });
    expect(r.duplicate).toBeUndefined();
    expect((await board.getBoard()).objects[op.object.id]).toMatchObject({ text: "important" });
    // The victim's own replay is still a duplicate, and the attacker's record is kept.
    const again = await apply(board, { senderId: "victim", requestId: "victim:1", objectOps: [createOp({})] });
    expect(again).toMatchObject({ duplicate: true, status: "applied", upserts: [] });
    expect(repo.requests.filter((x) => x.requestId === "victim:1").map((x) => x.senderId).sort()).toEqual(["", "attacker", "victim"]);
    // Undo goes through the same records.
    const u = await board.undo({ senderId: "victim", requestId: "victim:2", by: "Anonymous" });
    expect(u.result.duplicate).toBeUndefined();
    expect(u.result.status).toBe("applied");
    const u2 = await board.undo({ senderId: "victim", requestId: "victim:2", by: "Anonymous" });
    expect(u2.result.duplicate).toBe(true);
  });

  it("a record stored before senderIds were recorded still matches any sender", async () => {
    const repo = new InMemoryRepository();
    await createWhiteboard(repo).getBoard();
    repo.requests = [{ requestId: "old:1", revision: 0, status: "unchanged", conflicts: [], errors: [] }];
    const board = createWhiteboard(repo);
    const r = await apply(board, { senderId: "anyone", requestId: "old:1", objectOps: [createOp({})] });
    expect(r.duplicate).toBe(true);
  });
});

describe("stored values stay within storage limits once V8-serialised", () => {
  /** Values of 4-decimal pen coordinates: 6 JSON chars, 13 V8 bytes in a holey array. */
  const points = (n) => Array.from({ length: 2 * n }, (_, i) => ((i * 7919) % 9999 + 1) / 10000);

  it("history of pen deletes with inverses just under inverseBytes", async () => {
    const { board, repo } = setup();
    // The largest pen whose delete inverse still fits inverseBytes in the new measure.
    let n = 10;
    for (;;) {
      const inv = { objectOps: [{ op: "create", object: { id: oid(), type: "pen", points: points(n + 50) }, restore: { createdAt: 1, createdBy: "x".repeat(40), version: 1 } }] };
      if (storedBytes(inv) > LIMITS.inverseBytes - 800) break;
      n += 50;
    }
    for (let i = 0; i < 30; i++) {
      const c = await create(board, { type: "pen", points: points(n), w: 100, h: 100, x: -999999.99, y: 999999.99 }, { by: "x".repeat(40) });
      const d = await apply(board, { by: "x".repeat(40), objectOps: [deleteOp(c.id, 1)] });
      expect(d.history.inverse).not.toBeNull();
    }
    expect(repo.history.length).toBeLessThan(30); // trimmed by bytes
    expect(storedBytes(repo.history)).toBeLessThanOrEqual(LIMITS.historyBytes);
    expect(serialize(repo.history).length).toBeLessThanOrEqual(LIMITS.historyBytes);
    // A pen near the point cap has no server-side inverse: V8 would store it at ~13 bytes a number.
    const big = await create(board, { type: "pen", points: points(LIMITS.penPoints) });
    const del = await apply(board, { objectOps: [deleteOp(big.id, 1)] });
    expect(del.history.inverse).toBeNull();
  });

  it("history of many small numeric edits", async () => {
    const { board, repo } = setup();
    const ids = [];
    for (let i = 0; i < 50; i++) ids.push((await create(board)).id);
    const versions = new Map(ids.map((id) => [id, 1]));
    for (let k = 0; k < LIMITS.historyEntries + 20; k++) {
      const ops = ids.map((id) => updateOp(id, versions.get(id), { x: -999999.99 + k / 100, y: 999999.99 - k / 100, w: 99999.99, h: 1.01, rot: 359.9 }));
      const r = await apply(board, { by: "x".repeat(40), objectOps: ops });
      for (const o of r.upserts) versions.set(o.id, o.version);
    }
    expect(storedBytes(repo.history)).toBeLessThanOrEqual(LIMITS.historyBytes);
    expect(serialize(repo.history).length).toBeLessThan(VALUE_MAX);
  }, 30000);

  it("request records full of errors", async () => {
    const { board, repo } = setup();
    for (let k = 0; k < 40; k++) {
      const ops = Array.from({ length: LIMITS.opsPerRequest }, () => ({ op: "update", id: "o_" + "f".repeat(12), baseVersion: 1, patch: { x: 1 } }));
      ops.push(...Array.from({ length: 0 }));
      await apply(board, { senderId: "s".repeat(64), requestId: "r".repeat(60) + String(k).padStart(4, "0"), objectOps: ops.slice(0, LIMITS.opsPerRequest) });
    }
    expect(repo.requests.length).toBeGreaterThan(1);
    expect(storedBytes(repo.requests)).toBeLessThanOrEqual(LIMITS.requestRecordBytes);
    expect(serialize(repo.requests).length).toBeLessThan(VALUE_MAX);
  });

  it("the largest objects, and a full board's snapshot", async () => {
    const { board, repo } = setup();
    const style = { fill: "#123456", stroke: "#123456", strokeWidth: 63.5, textColor: "#123456", fontSize: 200, align: "center" };
    const maxPen = await create(board, { type: "pen", points: points(LIMITS.penPoints), x: -999999.99, y: -999999.99, w: 99999.99, h: 99999.99, style }, { by: "名".repeat(40) });
    const maxText = await create(board, { type: "sticky", text: "\u{1F600}名".repeat(LIMITS.text), x: -999999.99, style }, { by: "名".repeat(40) });
    for (const made of [maxPen, maxText]) {
      expect(made.result.errors).toEqual([]);
      const stored = repo.objects.get(made.id);
      expect(storedBytes(stored)).toBeLessThanOrEqual(LIMITS.objectBytes);
      expect(serialize(stored).length).toBeLessThanOrEqual(storedBytes(stored));
      expect(serialize(stored).length).toBeLessThan(VALUE_MAX);
    }
    // Fill the board with maximal pens: the snapshot stays within boardBytes serialised.
    let r;
    do r = await apply(board, { objectOps: Array.from({ length: 20 }, () => createOp({ type: "pen", points: points(LIMITS.penPoints), x: -999999.99, style })) });
    while (!r.errors.length);
    expect(r.errors[0].message).toMatch(/full/);
    const snapshot = await board.getBoard();
    expect(serialize(snapshot).length).toBeLessThanOrEqual(LIMITS.boardBytes + 64 * KIB);
    expect(serialize(snapshot).length).toBeLessThan(32 * 1024 * KIB);
  }, 30000);
});

describe("order keys", () => {
  const ceiling = "z".repeat(LIMITS.orderKey);
  const floor = "A" + "0".repeat(26) + "1".repeat(LIMITS.orderKey - 27);
  const zOf = async (board, id) => (await board.getBoard()).objects[id].z;

  it("keys at the ends of the key space become server keys; bring to front and send to back keep working", async () => {
    const { board, repo } = setup();
    const r = await apply(board, { objectOps: [
      createOp({ z: "a0" }), createOp({ z: "y" + "z".repeat(25) }), createOp({ z: ceiling }), createOp({ z: "z".repeat(64) }),
      createOp({ z: floor }), createOp({ z: "a0" + "V".repeat(63) }),
    ] });
    expect(r.errors).toEqual([]);
    const [low, planted, high, high2, bottom, long] = r.upserts;
    expect(planted.z).toBe("y" + "z".repeat(25));
    for (const o of r.upserts) expect(o.z.length).toBeLessThanOrEqual(LIMITS.orderKeyAccept);
    // Keys above everything became server keys on top (above the planted "yzz…" key), the floor
    // key one below everything; an over-long key inside the range is ignored (a create goes on top).
    expect(planted.z < high.z && high.z < high2.z && high2.z < long.z).toBe(true);
    expect(bottom.z < low.z).toBe(true);
    // An honest client's bring to front: keyBetween(top, null), repeated many times.
    for (let i = 0; i < 300; i++) {
      const top = [...repo.objects.values()].map((o) => o.z).sort().at(-1);
      const v = repo.objects.get(low.id).version;
      const front = await apply(board, { objectOps: [updateOp(low.id, v, { z: keyBetween(top, null) })] });
      expect(front.upserts[0].z > top).toBe(true);
    }
    // ... and send to back, from below the floor-ish key.
    for (let i = 0; i < 300; i++) {
      const min = [...repo.objects.values()].map((o) => o.z).sort()[0];
      const v = repo.objects.get(high.id).version;
      const back = await apply(board, { objectOps: [updateOp(high.id, v, { z: keyBetween(null, min) })] });
      expect(back.upserts[0].z < min).toBe(true);
    }
    for (let i = 0; i < 300; i++) await apply(board, { objectOps: [createOp({})] });
    for (const o of repo.objects.values()) {
      expect(isValidOrderKey(o.z)).toBe(true);
      expect(o.z.length).toBeLessThanOrEqual(LIMITS.orderKeyAccept);
    }
    // An update to a valid key strictly inside the range that is not acceptable changes nothing.
    const v = repo.objects.get(planted.id).version;
    const ignored = await apply(board, { objectOps: [updateOp(planted.id, v, { z: "a0" + "V".repeat(LIMITS.orderKeyAccept) })] });
    expect(ignored).toMatchObject({ status: "unchanged", upserts: [] });
    expect(await zOf(board, planted.id)).toBe(planted.z);
  }, 60000);

  it("a legacy over-long top key is ignored for placement, so it does not spread", async () => {
    const repo = new InMemoryRepository();
    const board0 = createWhiteboard(repo);
    const legacy = await create(board0);
    // Simulate data stored before keys were bounded.
    repo.objects.set(legacy.id, { ...repo.objects.get(legacy.id), z: ceiling });
    const board = createWhiteboard(repo);
    const r = await apply(board, { objectOps: Array.from({ length: 300 }, () => createOp({})) });
    expect(r.errors).toEqual([]);
    for (const o of r.upserts) expect(isAcceptableOrderKey(o.z)).toBe(true);
    expect(new Set(r.upserts.map((o) => o.z)).size).toBe(300);
    // A client bringing something above it gets a server key above everything.
    const front = await apply(board, { objectOps: [updateOp(r.upserts[0].id, 1, { z: keyBetween(ceiling.slice(0, 127) + "y", null) })] });
    expect(front.upserts[0].z.length).toBeLessThanOrEqual(LIMITS.orderKeyAccept);
    expect(front.upserts[0].z > r.upserts[299].z).toBe(true);
  });

  it("the group's top is recomputed when its holder is deleted or lowered", async () => {
    const { board } = setup();
    await create(board, { z: "a0" });
    const high = await create(board, { z: "a5" });
    await apply(board, { objectOps: [deleteOp(high.id, 1)] });
    expect((await create(board)).obj.z).toBe("a1");
    const lowered = await create(board, { z: "b00" });
    await apply(board, { objectOps: [updateOp(lowered.id, 1, { z: "Zz" })] });
    expect((await create(board)).obj.z).toBe("a2");
    // Moving the top holder without changing z keeps the top.
    const top = await create(board);
    await apply(board, { objectOps: [updateOp(top.id, 1, { x: 50 })] });
    expect((await create(board)).obj.z).toBe(keyBetween(top.obj.z, null));
    // Frames stack separately.
    expect((await create(board, { type: "frame" })).obj.z).toBe("a0");
  });
});

describe("convenience calls with huge inputs", () => {
  it("addStickies, addObjects and updateObjects refuse more items than one request may carry, cleanly", async () => {
    const { board, repo } = setup();
    const many = Array.from({ length: 1_000_000 }, () => "a");
    const r = await board.addStickies({ stickies: many });
    expect(r).toMatchObject({ created: [], errors: [expect.objectContaining({ index: -1, code: "limit" })] });
    expect(r.errors[0].message).toMatch(/at most 1000/);
    const o = await board.addObjects({ objects: many });
    expect(o.errors).toEqual([expect.objectContaining({ code: "limit" })]);
    const u = await board.updateObjects({ updates: many });
    expect(u.result.errors).toEqual([expect.objectContaining({ code: "limit" })]);
    expect(repo.objects.size).toBe(0);
    const ok = await board.addStickies({ stickies: Array.from({ length: LIMITS.opsPerRequest }, () => "a") });
    expect(ok.created).toHaveLength(LIMITS.opsPerRequest);
  }, 30000);

  it("grids are placed so every cell is within the coordinate range", async () => {
    const { board } = setup();
    const r = await board.addStickies({ stickies: Array.from({ length: 900 }, () => "a"), columns: 0, gap: NaN, at: { x: 1e300, y: -1e300 } });
    expect(r.errors).toEqual([]);
    const cells = new Set(r.created.map((o) => `${o.x},${o.y}`));
    expect(cells.size).toBe(900);
    for (const o of r.created) {
      expect(o.x + o.w).toBeLessThanOrEqual(LIMITS.coord);
      expect(o.y).toBeGreaterThanOrEqual(-LIMITS.coord);
    }
    const g = await board.arrangeGrid({ ids: r.created.map((o) => o.id), columns: 30, at: { x: LIMITS.coord, y: LIMITS.coord } });
    const moved = g.result.upserts;
    expect(new Set(moved.map((o) => `${o.x},${o.y}`)).size).toBe(moved.length);
    for (const o of moved) {
      expect(o.x + o.w).toBeLessThanOrEqual(LIMITS.coord);
      expect(o.y + o.h).toBeLessThanOrEqual(LIMITS.coord);
    }
  });
});

describe("exportSvg on crafted text", () => {
  it("a board full of long one-line texts exports in well under a second", async () => {
    const board = createWhiteboard(new InMemoryRepository());
    const text = "i ".repeat(2000);
    for (;;) {
      const ops = Array.from({ length: 500 }, () => createOp({ type: "text", w: 100000, h: 40, text, style: { fontSize: 8 } }));
      const { result } = await board.applyOperation({ objectOps: ops });
      if (result.errors.length) break;
    }
    const t = performance.now();
    const svg = await board.exportSvg({});
    expect(performance.now() - t).toBeLessThan(1000);
    // Text beyond the export budget is left out.
    expect(svg.match(/<text /g).length).toBeLessThanOrEqual(Math.ceil(EXPORT_TEXT_BUDGET / text.length) + 1);
  }, 60000);
});

describe("undo without historyId", () => {
  it("walks back through the caller's changes instead of redoing, and a redo makes a change undoable again", async () => {
    const { board, repo } = setup();
    const made = await create(board, { text: "v1" }, { by: "Ann" });
    const moved = await apply(board, { by: "Ann", objectOps: [updateOp(made.id, 1, { x: 40 })] });
    await apply(board, { by: "Bob", objectOps: [createOp({})] });
    await apply(board, { by: "Ann", objectOps: [updateOp(made.id, 2, { text: "v2" })] });
    const objects = async () => (await board.getBoard()).objects;

    const u1 = await board.undo({ by: "Ann" });
    expect((await objects())[made.id]).toMatchObject({ text: "v1", x: 40 });
    const u2 = await board.undo({ by: "Ann" });
    expect((await objects())[made.id]).toMatchObject({ text: "v1", x: 0 });
    const u3 = await board.undo({ by: "Ann" });
    expect((await objects())[made.id]).toBeUndefined();
    const u4 = await board.undo({ by: "Ann" });
    expect(u4.result.errors[0].message).toMatch(/Nothing to undo/);
    expect(repo.history.find((h) => h.id === moved.history.id).undoneBy).toBe(u2.result.history.id);
    expect(u2.result.history.undoOf).toBe(moved.history.id);
    void u1;

    // Redo the create (undo its undo by id): the create is in effect again, so a plain undo takes it back.
    const redo = await board.undo({ by: "Ann", historyId: u3.result.history.id });
    expect((await objects())[made.id]).toBeDefined();
    expect(repo.history.find((h) => h.id === made.result.history.id).undoneBy).toBeUndefined();
    expect(repo.history.find((h) => h.id === u3.result.history.id).undoneBy).toBe(redo.result.history.id);
    await board.undo({ by: "Ann" });
    expect((await objects())[made.id]).toBeUndefined();
  });
});
