// The client spatial index (src/client/model/spatial-index.js): effective bounds, grid queries
// versus a brute-force scan, incremental updates (connectors follow their endpoints), fuzzing, the
// debug mode, and staying consistent with a live store through creates, updates, deletes, undo,
// redo, rebases, remote changes and snapshot replacement.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TYPE_DEFAULTS } from "../../src/shared/protocol.js";
import { rotatedBounds, connectorRoute, pointsBounds, rectsIntersect } from "../../src/shared/geometry.js";
import { SpatialIndex, effectiveBounds, applyStoreChange, CELL_SIZE } from "../../src/client/model/spatial-index.js";
import { hitObject, topObjectAt, objectsInRect, stackOrder } from "../../src/client/ui/canvas/model.js";
import { sortedObjects } from "../../src/shared/protocol.js";
import { Net, mulberry32 } from "./net.js";

let seq = 0;
const nid = () => "o_" + (0x200000000000 + ++seq).toString(16).slice(-12);

/** @returns {any} */
function obj(type, fields = {}) {
  const d = TYPE_DEFAULTS[type];
  const o = {
    id: fields.id ?? nid(), type, x: 0, y: 0, w: d.w, h: d.h, rot: 0, z: "a0", frameId: null, text: d.text,
    style: { ...d.style }, version: 1, createdAt: 0, updatedAt: 0, createdBy: "t", ...fields,
  };
  if (type === "pen" && !o.points) o.points = [0, 0, 1, 1];
  if (type === "connector") Object.assign(o, { x: 0, y: 0, w: 1, h: 1, fromSide: "auto", toSide: "auto", routing: "straight", ...fields });
  return o;
}
const board = (...list) => Object.fromEntries(list.map((o) => [o.id, o]));
const sortIds = (ids) => [...ids].sort();

describe("effective bounds", () => {
  it("uses rotated bounds for rotated shapes and the name strip for frames", () => {
    const r = obj("rect", { x: 0, y: 0, w: 200, h: 100, rot: 45 });
    expect(effectiveBounds(r, () => undefined)).toEqual(rotatedBounds(r));
    const f = obj("frame", { x: 0, y: 100, w: 400, h: 300 });
    const b = effectiveBounds(f, () => undefined);
    expect(b.y).toBeLessThan(100);
    expect(b.y + b.h).toBe(400);
    expect(b.x).toBe(0);
    expect(b.w).toBe(400);
  });

  it("pads connector routes, includes labels, and has no bounds without both endpoints", () => {
    const a = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
    const c = obj("rect", { x: 0, y: 400, w: 100, h: 100 });
    const conn = obj("connector", { from: a.id, to: c.id, text: "a long label for the connector" });
    const all = board(a, c, conn);
    const b = effectiveBounds(conn, (id) => all[id]);
    const route = pointsBounds(connectorRoute(conn, a, c).points);
    expect(b.x).toBeLessThan(route.x);
    expect(b.w).toBeGreaterThan(200); // the label is wider than the vertical line
    expect(effectiveBounds(conn, (id) => (id === a.id ? a : undefined))).toBeNull();
  });

  it("covers every point that hits the object", () => {
    const rng = mulberry32(7);
    const f = obj("frame", { x: 0, y: 0, w: 300, h: 300, text: "Frame" });
    const e = obj("ellipse", { x: 500, y: 0, w: 200, h: 120, rot: 30 });
    const p = obj("pen", { x: 0, y: 500, w: 200, h: 200, points: [0, 0, 1, 1], style: { ...TYPE_DEFAULTS.pen.style, strokeWidth: 8 } });
    const conn = obj("connector", { from: f.id, to: e.id, style: { ...TYPE_DEFAULTS.connector.style, strokeWidth: 12 } });
    const all = board(f, e, p, conn);
    const resolve = (id) => all[id];
    for (const zoom of [0.1, 1, 8]) {
      for (let i = 0; i < 4000; i++) {
        const q = { x: -100 + rng() * 1000, y: -100 + rng() * 900 };
        for (const o of Object.values(all)) {
          if (!hitObject(o, q, zoom, resolve)) continue;
          const b = effectiveBounds(o, resolve);
          const tol = 6 / zoom;
          expect(rectsIntersect(b, { x: q.x - tol, y: q.y - tol, w: 2 * tol, h: 2 * tol })).toBe(true);
        }
      }
    }
  });
});

describe("SpatialIndex", () => {
  it("answers rect and point queries like a scan, including huge objects", () => {
    const a = obj("sticky", { x: 0, y: 0 });
    const b = obj("rect", { x: 5000, y: 5000, w: 100, h: 100 });
    const big = obj("frame", { x: -50000, y: -50000, w: 100000, h: 100000 });
    const neg = obj("rect", { x: -700, y: -300, w: 50, h: 50, rot: 10 });
    const all = board(a, b, big, neg);
    const index = new SpatialIndex({ debug: true });
    index.reset(all);
    expect(index.size).toBe(4);
    expect(index.large.has(big.id)).toBe(true);
    for (const rect of [
      { x: 0, y: 0, w: 10, h: 10 }, { x: 4000, y: 4000, w: 2000, h: 2000 }, { x: -800, y: -400, w: 200, h: 200 },
      { x: 1e5, y: 1e5, w: 5, h: 5 }, { x: -1e6, y: -1e6, w: 2e6, h: 2e6 },
    ]) expect(sortIds(index.query(rect))).toEqual(sortIds(index.bruteForce(rect)));
    expect(index.queryPoint({ x: 5050, y: 5050 })).toContain(b.id);
    expect(index.stats.mismatches).toBe(0);
  });

  it("keeps connectors in step with their endpoints and forgets deleted objects", () => {
    const a = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
    const b = obj("rect", { x: 300, y: 0, w: 100, h: 100 });
    const conn = obj("connector", { from: a.id, to: b.id });
    const all = board(a, b, conn);
    const index = new SpatialIndex();
    index.reset(all);
    const far = { x: 5000, y: 5000, w: 10, h: 10 };
    expect(index.query(far)).toEqual([]);
    all[b.id] = { ...b, x: 5000, y: 5000 };
    const touched = index.update([b.id], all);
    expect(touched.has(conn.id)).toBe(true);
    expect(sortIds(index.query({ x: 2000, y: 2000, w: 10, h: 10 }))).toEqual([conn.id]);
    delete all[a.id];
    delete all[conn.id];
    index.update([a.id, conn.id], all);
    expect(index.bounds(conn.id)).toBeNull();
    expect(index.query({ x: 0, y: 0, w: 100, h: 100 })).toEqual([]);
    expect(index.dependents.size).toBe(0);
    expect(index.verify()).toEqual({ missing: [], extra: [], stale: [] });
  });

  it("indexes a connector once its missing endpoint appears", () => {
    const a = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
    const b = obj("rect", { x: 300, y: 0, w: 100, h: 100 });
    const conn = obj("connector", { from: a.id, to: b.id });
    const all = board(a, conn);
    const index = new SpatialIndex();
    index.reset(all);
    expect(index.bounds(conn.id)).toBeNull();
    all[b.id] = b;
    index.update([b.id], all);
    expect(index.bounds(conn.id)).not.toBeNull();
  });

  it("debug mode counts a query that disagrees with the scan (and logs nothing about the board)", () => {
    const a = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
    const all = board(a);
    const index = new SpatialIndex({ debug: true });
    index.reset(all);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    all[a.id] = { ...a, x: 900 }; // changed without telling the index
    index.query({ x: 0, y: 0, w: 50, h: 50 });
    expect(index.stats.mismatches).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).not.toContain(a.id);
    expect(index.verify().stale).toEqual([a.id]);
    warn.mockRestore();
  });

  it("fuzz: random creates, moves, rotations, resizes, reconnects and deletes match a brute-force scan", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const rng = mulberry32(seed);
      const pick = (arr) => arr[Math.floor(rng() * arr.length)];
      const coord = () => (rng() - 0.5) * 8000;
      /** @type {Record<string, any>} */
      const all = {};
      const index = new SpatialIndex({ cellSize: [64, CELL_SIZE, 1000][seed % 3] });
      index.reset(all);
      for (let step = 0; step < 600; step++) {
        const ids = Object.keys(all);
        const shapes = ids.filter((id) => all[id].type !== "connector");
        const r = rng();
        /** @type {string[]} */
        let changed = [];
        if (r < 0.3 || ids.length < 3) {
          const type = pick(["sticky", "rect", "ellipse", "text", "frame", "pen"]);
          const size = rng() < 0.05 ? 20000 : 10 + rng() * 400;
          const o = obj(type, { x: coord(), y: coord(), w: size, h: 10 + rng() * 400, rot: type === "rect" ? Math.floor(rng() * 360) : 0 });
          all[o.id] = o;
          changed = [o.id];
        } else if (r < 0.4 && shapes.length >= 2) {
          const from = pick(shapes);
          const to = pick(shapes.filter((id) => id !== from));
          const c = obj("connector", { from, to, routing: rng() < 0.5 ? "elbow" : "straight", text: rng() < 0.3 ? "label" : "" });
          all[c.id] = c;
          changed = [c.id];
        } else if (r < 0.7) {
          const id = pick(shapes);
          all[id] = { ...all[id], x: all[id].x + (rng() - 0.5) * 3000, y: all[id].y + (rng() - 0.5) * 3000 };
          changed = [id];
        } else if (r < 0.8) {
          const id = pick(shapes);
          all[id] = { ...all[id], w: 1 + rng() * 3000, rot: all[id].type === "rect" ? Math.floor(rng() * 360) : 0 };
          changed = [id];
        } else if (r < 0.87) {
          const conns = ids.filter((id) => all[id].type === "connector");
          if (conns.length && shapes.length >= 3) {
            const id = pick(conns);
            const other = all[id].to;
            all[id] = { ...all[id], from: pick(shapes.filter((s) => s !== other)) };
            changed = [id];
          }
        } else {
          const id = pick(ids);
          delete all[id];
          changed = [id];
          // The store hides connectors whose endpoint is gone (and the server deletes them).
          for (const c of Object.keys(all)) {
            if (all[c].type === "connector" && (all[c].from === id || all[c].to === id)) { delete all[c]; changed.push(c); }
          }
        }
        index.update(changed, all);
        if (step % 25 === 0) expect(index.verify()).toEqual({ missing: [], extra: [], stale: [] });
        for (let q = 0; q < 3; q++) {
          const rect = { x: coord(), y: coord(), w: rng() * 3000, h: rng() * 3000 };
          expect(sortIds(index.query(rect))).toEqual(sortIds(index.bruteForce(rect)));
        }
      }
      expect(index.verify()).toEqual({ missing: [], extra: [], stale: [] });
    }
    // Elbow connectors route around obstacles, so the brute-force side re-routes every one of them
    // for each check: slow on purpose, and it verifies the index's route-region tracking.
  }, 120_000);

  it("index-backed hit tests and marquees agree with full scans", () => {
    const rng = mulberry32(11);
    /** @type {Record<string, any>} */
    const all = {};
    for (let i = 0; i < 300; i++) {
      const type = ["sticky", "rect", "ellipse", "text", "frame", "pen"][i % 6];
      const o = obj(type, { x: rng() * 3000, y: rng() * 3000, w: 20 + rng() * 300, h: 20 + rng() * 300, z: "a" + i, rot: type === "rect" ? 30 : 0 });
      all[o.id] = o;
    }
    const shapes = Object.keys(all);
    for (let i = 0; i < 60; i++) {
      const c = obj("connector", { from: shapes[i], to: shapes[i + 100], z: "b" + i });
      all[c.id] = c;
    }
    const index = new SpatialIndex();
    index.reset(all);
    const resolve = (id) => all[id];
    const sorted = sortedObjects(all);
    for (const zoom of [0.2, 1, 4]) {
      for (let i = 0; i < 400; i++) {
        const p = { x: rng() * 3300, y: rng() * 3300 };
        const near = stackOrder(all, index.queryPoint(p, 6 / zoom));
        expect(topObjectAt(near, p, zoom, resolve)?.id).toBe(topObjectAt(sorted, p, zoom, resolve)?.id);
      }
    }
    for (let i = 0; i < 100; i++) {
      const rect = { x: rng() * 3000, y: rng() * 3000, w: rng() * 1500, h: rng() * 1500 };
      expect(objectsInRect(stackOrder(all, index.query(rect)), rect, resolve))
        .toEqual(objectsInRect(sorted, rect, resolve));
    }
    // The index scans far fewer objects than the board holds for a small query.
    const before = index.stats.scanned;
    index.query({ x: 1000, y: 1000, w: 50, h: 50 });
    expect(index.stats.scanned - before).toBeLessThan(60);
  });
});

describe("SpatialIndex with a live store", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const tick = (ms) => vi.advanceTimersByTimeAsync(ms);

  /** An index fed by `store` exactly as the canvas feeds it, checked after every change. */
  function track(store) {
    const index = new SpatialIndex({ debug: true });
    index.reset(store.getState().board.objects);
    let checks = 0;
    const problems = [];
    store.subscribe((state, change) => {
      applyStoreChange(index, state, change);
      checks++;
      const v = index.verify();
      if (v.missing.length || v.extra.length || v.stale.length) problems.push({ kind: change.kind, ...v });
    });
    return { index, problems, checks: () => checks };
  }

  it("stays consistent through creates, moves, connectors, deletes, undo, redo, rebases and resyncs", async () => {
    const net = new Net({ rng: mulberry32(3), minLat: 0, maxLat: 60 });
    const a = await net.startStore("a");
    const b = await net.startStore("b");
    await tick(200);
    const ta = track(a), tb = track(b);
    const [x, y, z] = a.createObjects([
      { type: "rect", x: 0, y: 0, w: 100, h: 100 },
      { type: "rect", x: 400, y: 0, w: 100, h: 100 },
      { type: "sticky", x: 0, y: 400 },
    ]);
    const [c1] = a.createObjects([{ type: "connector", from: x, to: y }]);
    await tick(300);
    // Concurrent moves of the same object: rebased on both sides.
    a.updateObjects([{ id: x, patch: { x: 50 } }]);
    b.updateObjects([{ id: x, patch: { x: 30, y: 20 } }]);
    b.updateObjects([{ id: y, patch: { rot: 45 } }]);
    await tick(1000);
    a.updateObjects([{ id: c1, patch: { to: z } }]);
    await tick(300);
    b.deleteObjects([z]); // takes the connector with it
    await tick(300);
    a.undo(); // the reconnect (skipped: the connector is gone)
    a.undo(); // the move
    await tick(300);
    a.redo();
    await tick(300);
    b.undo(); // brings z and the connector back
    await tick(500);
    // Snapshot replacement.
    net.restart();
    await tick(8000);
    for (const t of [ta, tb]) {
      expect(t.problems).toEqual([]);
      expect(t.checks()).toBeGreaterThan(5);
      expect(t.index.stats.mismatches).toBe(0);
      expect(t.index.stats.resets).toBeGreaterThanOrEqual(2); // the resync after the restart
    }
    const server = await net.board.getBoard();
    expect(sortIds(ta.index.query({ x: -1e6, y: -1e6, w: 2e6, h: 2e6 }))).toEqual(sortIds(Object.keys(server.objects)));
  });
});
