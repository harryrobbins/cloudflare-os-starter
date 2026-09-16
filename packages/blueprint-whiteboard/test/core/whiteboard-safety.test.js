// Caps, byte budgets, hostile inputs and storage failures.
import { describe, expect, it } from "vitest";
import { BACKGROUNDS, LIMITS, OBJECT_TYPES, SIDES, isId, isOrderKey, storedBytes } from "../../src/shared/protocol.js";
import { InMemoryRepository } from "../../src/core/repository.js";
import { createWhiteboard } from "../../src/core/whiteboard.js";
import { apply, create, createOp, deleteOp, oid, pen, setup, updateOp } from "./helpers.js";

const creates = (n, object = {}) => Array.from({ length: n }, () => createOp(object));
const codes = (r) => r.errors.map((e) => [e.index, e.code]);

describe("count caps", () => {
  it("objects (real limit)", async () => {
    const { board } = setup();
    for (let i = 0; i < LIMITS.objects / LIMITS.opsPerRequest; i++) {
      expect((await apply(board, { objectOps: creates(LIMITS.opsPerRequest) })).errors).toEqual([]);
    }
    const r = await apply(board, { objectOps: creates(2) });
    expect(codes(r)).toEqual([[0, "limit"], [1, "limit"]]);
    expect(Object.keys((await board.getBoard()).objects)).toHaveLength(LIMITS.objects);
    // Deleting frees room within the same request.
    const id = Object.keys((await board.getBoard()).objects)[0];
    const r2 = await apply(board, { objectOps: [deleteOp(id, 1), ...creates(1)] });
    expect(r2.errors).toEqual([]);
  }, 30000);

  it("frames (real limit)", async () => {
    const { board } = setup();
    const r = await apply(board, { objectOps: creates(LIMITS.frames + 1, { type: "frame" }) });
    expect(codes(r)).toEqual([[LIMITS.frames, "limit"]]);
    expect(r.errors[0].message).toMatch(/frames/);
  });

  it("members of one frame count effective members (real limit)", async () => {
    const { board } = setup();
    const frame = await create(board, { type: "frame" });
    const other = await create(board, { type: "frame" });
    const half = LIMITS.objectsPerFrame / 2;
    const r = await apply(board, { objectOps: creates(half, { frameId: frame.id }) });
    expect(r.errors).toEqual([]);
    expect((await apply(board, { objectOps: creates(half, { frameId: frame.id }) })).errors).toEqual([]);
    const loose = await create(board);
    const r2 = await apply(board, { objectOps: [createOp({ frameId: frame.id }), updateOp(loose.id, 1, { frameId: frame.id }), createOp({ frameId: other.id })] });
    expect(codes(r2)).toEqual([[0, "limit"], [1, "limit"]]);
    // Moving a member out frees a slot in the same request; updates that keep the frame still work.
    const member = r.upserts[0];
    const r3 = await apply(board, { objectOps: [
      updateOp(member.id, 1, { frameId: other.id }), updateOp(loose.id, 1, { frameId: frame.id }),
      updateOp(r.upserts[1].id, 1, { text: "still fine" }),
    ] });
    expect(r3.errors).toEqual([]);
  }, 30000);

  it("ops per request: the whole request is rejected and nothing applied", async () => {
    const { board, repo } = setup();
    await board.getBoard();
    const commits = repo.commits;
    const r = await apply(board, { objectOps: creates(LIMITS.opsPerRequest + 1), structure: { title: "no" } });
    expect(r).toMatchObject({ status: "unchanged", revision: 0, upserts: [] });
    expect(codes(r)).toEqual([[-1, "limit"]]);
    expect(repo.commits).toBe(commits);
    const sparse = await apply(board, { objectOps: new Array(10_000_000) });
    expect(codes(sparse)).toEqual([[-1, "limit"]]);
  });

  it("commitObjects: an op whose cascade would pass the cap fails, earlier ops apply", async () => {
    const { board } = setup({ limits: { commitObjects: 10 } });
    const hub = await create(board);
    const spokes = [];
    for (let i = 0; i < 6; i++) {
      const s = await create(board);
      spokes.push(s.id);
      await create(board, { type: "connector", from: hub.id, to: s.id });
    }
    // 4 creates + (hub + 6 connectors) = 11 > 10
    let r = await apply(board, { objectOps: [...creates(4), deleteOp(hub.id, 1)] });
    expect(codes(r)).toEqual([[4, "limit"]]);
    expect(r.upserts).toHaveLength(4);
    r = await apply(board, { objectOps: [...creates(3), deleteOp(hub.id, 1)] });
    expect(r.errors).toEqual([]);
    expect(r.deletes).toHaveLength(7);
    r = await apply(board, { objectOps: spokes.map((id) => updateOp(id, 1, { x: 1 })).concat(spokes.map((id) => updateOp(id, 1, { y: 1 }))) });
    expect(r.errors).toEqual([]); // the same object counts once
    r = await apply(board, { objectOps: creates(11) });
    expect(codes(r)).toEqual([[10, "limit"]]);
  });
});

describe("byte caps", () => {
  it("objectBytes per object", async () => {
    const { board } = setup({ limits: { objectBytes: 600 } });
    const small = await create(board, { text: "x" });
    const size = storedBytes(small.obj);
    expect(size).toBeLessThan(600);
    let r = await apply(board, { objectOps: [createOp({ text: "y".repeat(400) })] });
    expect(codes(r)).toEqual([[0, "limit"]]);
    r = await apply(board, { objectOps: [updateOp(small.id, 1, { text: "z".repeat(400) })] });
    expect(codes(r)).toEqual([[0, "limit"]]);
    expect((await apply(board, { objectOps: [updateOp(small.id, 1, { x: 12345.67 })] })).errors).toEqual([]);
  });

  it("boardBytes: creates and growing updates fail; shrinking updates, moves and deletes work", async () => {
    const { board, repo } = setup({ limits: { boardBytes: 20_000 } });
    const big = await create(board, { text: "€".repeat(2000) });
    const small = await create(board, { text: "s" });
    for (;;) {
      const r = await apply(board, { objectOps: [createOp({ text: "x".repeat(500) })] });
      if (r.errors.length) { expect(codes(r)).toEqual([[0, "limit"]]); break; }
    }
    const used = () => Object.values(repo.objects).length && [...repo.objects.values()].reduce((n, o) => n + storedBytes(o), 0);
    expect(used()).toBeLessThanOrEqual(20_000);
    expect(codes(await apply(board, { objectOps: [updateOp(small.id, 1, { text: "g".repeat(3000) })] }))).toEqual([[0, "limit"]]);
    // Moves are never refused, even when the new coordinates are longer.
    for (let i = 0; i < 5; i++) {
      const cur = (await board.getBoard()).objects[small.id];
      expect((await apply(board, { objectOps: [updateOp(small.id, cur.version, { x: -999_999.99 + i, y: 999_999.99 - i })] })).errors).toEqual([]);
    }
    const shrink = await apply(board, { objectOps: [updateOp(big.id, 1, { text: "" })] });
    expect(shrink.errors).toEqual([]);
    expect((await apply(board, { objectOps: [createOp({ text: "fits now" })] })).errors).toEqual([]);
    // A fresh board over the same storage computes the same budget at load.
    const again = createWhiteboard(repo, { limits: { boardBytes: 20_000 } });
    let r;
    do r = await apply(again, { objectOps: [createOp({ text: "x".repeat(500) })] }); while (!r.errors.length);
    expect(r.errors[0].message).toMatch(/full/);
    expect(used()).toBeLessThanOrEqual(20_000);
  });

  it("undo restoring a deleted object is refused when the board has filled since", async () => {
    const { board } = setup({ limits: { boardBytes: 5_000 } });
    const s = await create(board, { text: "s".repeat(1500) });
    const del = await apply(board, { objectOps: [deleteOp(s.id, 1)] });
    await apply(board, { objectOps: creates(3, { text: "t".repeat(1200) }) });
    const u = await board.undo({ historyId: del.history.id });
    expect(u.result.status).toBe("unchanged");
    expect(u.result.errors[0].code).toBe("limit");
  });
});

describe("hostile inputs", () => {
  const hostile = [
    undefined, null, 0, "x", [], [[]], { objectOps: "nope" }, { objectOps: [null, 1, "a", [], {}] },
    { objectOps: [{ op: "create", object: [] }, { op: "create", object: { id: ["o_000000000001"], type: "sticky" } }] },
    { objectOps: [{ op: "create", object: JSON.parse('{"id":"o_0000000000aa","type":"sticky","__proto__":{"polluted":1},"style":{"__proto__":{"fill":"#000000"}}}') }] },
    { objectOps: [{ op: "create", object: { id: "o_0000000000ab", type: "rect", x: NaN, y: Infinity, w: -Infinity, h: 1e308, rot: NaN, z: {}, text: { toString: 1 }, style: [], frameId: "__proto__" } }] },
    { objectOps: [{ op: "create", object: { id: "o_0000000000ac", type: "text", text: " ‮".repeat(10) + "x".repeat(1_000_000) } }] },
    { objectOps: [{ op: "create", object: { id: "o_0000000000ad", type: "pen", points: Array.from({ length: 20_000 }, (_, i) => (i % 7) / 7) } }] },
    { objectOps: [{ op: "create", object: { id: "o_0000000000ae", type: "pen", points: Array.from({ length: 20_000 }, () => NaN) } }] },
    { objectOps: [{ op: "create", object: { id: "o_0000000000af", type: "connector", from: "constructor", to: "__proto__" } }] },
    { objectOps: [{ op: "update", id: "__proto__", baseVersion: 1, patch: {} }, { op: "delete", id: "constructor", baseVersion: 1 }] },
    { objectOps: [{ op: "update", id: "o_0000000000aa", baseVersion: 1, patch: JSON.parse('{"__proto__":{"x":5},"style":{"__proto__":{"fill":"#000000"},"fontSize":1e9}}') }] },
    { objectOps: [{ op: "update", id: "o_0000000000ab", baseVersion: 1, patch: { points: "x", from: {}, text: ["a"] } }] },
    { objectOps: [{ op: "delete", id: "o_0000000000ac", baseVersion: { valueOf: () => 1 } }] },
    { structure: { title: "t".repeat(100_000), background: "__proto__" }, by: { name: 1 }, senderId: ["x"], requestId: {} },
    { requestId: "x".repeat(65), objectOps: [] },
  ];

  it("never throws out of applyOperation or undo, and never stores invalid data", async () => {
    const { board, repo } = setup();
    for (const req of hostile) {
      const { result } = await board.applyOperation(req);
      expect(result.status).toMatch(/^(applied|unchanged|conflict)$/);
      for (const e of result.errors) expect(typeof e.message).toBe("string");
    }
    // The long pen was truncated to the cap, the NaN pen refused.
    expect(repo.objects.get("o_0000000000ad").points).toHaveLength(LIMITS.penPoints * 2);
    expect(repo.objects.has("o_0000000000ae")).toBe(false);
    expect(repo.objects.get("o_0000000000ac").text).toHaveLength(LIMITS.text);
    // (The undos below walk back through the changes above.)
    for (const args of [undefined, null, 5, { historyId: {} }, { by: ["x"] }, { historyId: "__proto__" }]) {
      const { result } = await board.undo(args);
      expect(result.status).toMatch(/^(applied|unchanged)$/);
    }
    expect({}.polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("fill");
    for (const [key, o] of repo.objects) {
      expect(key).toBe(o.id);
      assertValid(o, Object.fromEntries(repo.objects));
    }
    expect(repo.meta.title.length).toBeLessThanOrEqual(LIMITS.boardTitle);
    expect(BACKGROUNDS).toContain(repo.meta.background);
  });

  it("random op soup keeps every stored object valid", async () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const ids = Array.from({ length: 12 }, () => oid());
    const junk = () => pick([undefined, null, NaN, -1e12, 1e12, "5", 3.14159, [], {}, true, "#FFAA00", "none", "a0", "o_zz", ...ids]);
    const { board, repo } = setup();
    for (let round = 0; round < 150; round++) {
      const objectOps = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => {
        const kind = pick(["create", "update", "delete", "bogus"]);
        const id = pick(ids);
        const fields = { x: junk(), y: junk(), w: junk(), h: junk(), rot: junk(), z: junk(), frameId: junk(), text: junk(), from: pick(ids), to: pick(ids), points: pick([[0, 0, 1, 1], junk()]), style: { fill: junk(), strokeWidth: junk(), align: junk() }, fromSide: pick([...SIDES, "up"]) };
        if (kind === "create") return { op: "create", object: { id, type: pick([...OBJECT_TYPES, "blob"]), ...fields } };
        if (kind === "update") return { op: "update", id, baseVersion: pick([0, 1, 2, 3, junk()]), patch: fields };
        if (kind === "delete") return { op: "delete", id, baseVersion: pick([0, 1, 2, 3]) };
        return junk();
      });
      await board.applyOperation({ objectOps });
      if (round % 25 === 0) await board.undo({});
    }
    const objects = Object.fromEntries(repo.objects);
    for (const o of Object.values(objects)) assertValid(o, objects);
    // The cached state matches storage.
    expect((await board.getBoard()).objects).toEqual(objects);
    expect(await createWhiteboard(repo).getBoard()).toEqual(await board.getBoard());
  });
});

/** Structural invariants of a stored object. */
function assertValid(o, objects) {
  expect(isId(o.id)).toBe(true);
  expect(OBJECT_TYPES).toContain(o.type);
  for (const k of ["x", "y"]) expect(Math.abs(o[k])).toBeLessThanOrEqual(LIMITS.coord);
  for (const k of ["w", "h"]) {
    expect(o[k]).toBeGreaterThanOrEqual(LIMITS.sizeMin);
    expect(o[k]).toBeLessThanOrEqual(LIMITS.sizeMax);
  }
  expect(Number.isFinite(o.rot) && o.rot >= 0 && o.rot < 360).toBe(true);
  expect(isOrderKey(o.z)).toBe(true);
  expect(typeof o.text).toBe("string");
  expect(o.version).toBeGreaterThanOrEqual(1);
  expect(storedBytes(o)).toBeLessThanOrEqual(LIMITS.objectBytes);
  if (o.type === "frame" || o.type === "connector") expect(o.frameId).toBeNull();
  if (o.type === "pen") expect(o.points.length).toBeGreaterThanOrEqual(4);
  if (o.type === "connector") {
    expect(o.from).not.toBe(o.to);
    for (const end of [o.from, o.to]) {
      expect(objects[end]).toBeDefined();
      expect(objects[end].type).not.toBe("connector");
    }
  }
}

describe("storage failures", () => {
  it("a throwing commit drops the cache and does not stall the queue", async () => {
    const repo = new InMemoryRepository();
    const board = createWhiteboard(repo);
    const kept = await create(board, { text: "kept" });
    const real = repo.commit.bind(repo);
    let fail = true;
    repo.commit = async (c) => { if (fail) throw new Error("disk on fire"); return real(c); };
    const failing = board.applyOperation({ objectOps: [updateOp(kept.id, 1, { text: "lost" })] });
    const queued = board.getBoard();
    await expect(failing).rejects.toThrow("disk on fire");
    // The queued read reloads from storage (the cache was dropped): the failed write is not visible.
    fail = false;
    expect((await queued).objects[kept.id].text).toBe("kept");
    const r = await apply(board, { objectOps: [updateOp(kept.id, 1, { text: "second try" })] });
    expect(r).toMatchObject({ status: "applied", revision: 2 });
  });

  it("a request-record-only commit failure also rejects without stalling", async () => {
    const repo = new InMemoryRepository();
    const board = createWhiteboard(repo);
    await board.getBoard();
    repo.commit = async () => { throw new Error("nope"); };
    await expect(board.applyOperation({ requestId: "r1" })).rejects.toThrow("nope");
    await expect(board.getRevision()).resolves.toBe(0);
  });

  it("a throwing onEvent listener does not fail the write", async () => {
    const board = createWhiteboard(new InMemoryRepository(), { onEvent: () => { throw new Error("listener"); } });
    const { result } = await board.applyOperation({ objectOps: [createOp(pen())] });
    expect(result.status).toBe("applied");
  });
});
