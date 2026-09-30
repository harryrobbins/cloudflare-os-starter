// The embeddable whiteboard's storage seam: several boards in one Durable Object, each under its
// own key prefix (src/server/do-repository.js, src/embed/server.js).
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createWhiteboard } from "../../src/core/whiteboard.js";
import { DoStorageRepository } from "../../src/server/do-repository.js";
import { DrawingHost, prefixOf } from "../../src/embed/server.js";

const fresh = () => env.GADGET.get(env.GADGET.idFromName(crypto.randomUUID()));

describe("DoStorageRepository with a prefix", () => {
  it("keeps boards apart and leaves unprefixed keys alone", async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const plain = createWhiteboard(new DoStorageRepository(state.storage));
      const a = createWhiteboard(new DoStorageRepository(state.storage, { prefix: "drawing:a:" }));
      const b = createWhiteboard(new DoStorageRepository(state.storage, { prefix: "drawing:b:" }));
      await plain.addStickies({ stickies: ["plain"] });
      await a.addStickies({ stickies: ["in a", "also in a"] });
      await b.addStickies({ stickies: ["in b"] });
      const reopened = createWhiteboard(new DoStorageRepository(state.storage, { prefix: "drawing:a:" }));
      const texts = (board) => Object.values(board.objects).map((o) => o.text).sort();
      expect(texts(await reopened.getBoard())).toEqual(["also in a", "in a"]);
      expect(texts(await b.getBoard())).toEqual(["in b"]);
      // The unprefixed board lists "obj:" keys only, never another board's "drawing:…:obj:" keys.
      expect(texts(await createWhiteboard(new DoStorageRepository(state.storage)).getBoard())).toEqual(["plain"]);
      const keys = [...(await state.storage.list()).keys()];
      expect(keys.filter((k) => k.startsWith("drawing:a:obj:"))).toHaveLength(2);
      expect(keys).toContain("drawing:b:meta");
    });
  });
});

describe("DrawingHost", () => {
  it("creates, lists, calls and removes drawings", async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const changes = [];
      const host = new DrawingHost(state.storage, { onChange: (id) => changes.push(id), defaultTitle: "Sketch" });
      const { id, title } = await host.create({});
      expect(title).toBe("Sketch");
      await host.call(id, "addStickies", { stickies: ["x"] });
      expect(changes).toContain(id);
      expect(await host.list()).toMatchObject([{ id, title: "Sketch", objects: 1, openBy: [] }]);
      await expect(host.call(id, "subscribe", {})).rejects.toThrow(/unknown method/);
      expect(await host.remove(id)).toEqual({ removed: true });
      expect([...(await state.storage.list({ prefix: prefixOf(id) })).keys()]).toEqual([]);
      await expect(host.call(id, "getBoard")).rejects.toThrow(/No drawing/);
    });
  });

  it("caps the number of drawings", async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const host = new DrawingHost(state.storage, { limits: { drawings: 2 } });
      await host.create({});
      await host.create({});
      await expect(host.create({})).rejects.toThrow(/at most 2 drawings/);
    });
  });
});

describe("DoStorageRepository diagram renders", () => {
  it("stores large renders in chunks, replaces and removes them, per prefix", async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const repo = new DoStorageRepository(state.storage, { prefix: "drawing:a:" });
      const big = "<svg>" + "é".repeat(150_000) + "</svg>";
      await repo.putRender("o_000000000001", { hash: "h1", status: "ok", svg: big, w: 10, h: 20 });
      expect(await repo.getRender("o_000000000001")).toEqual({ hash: "h1", status: "ok", svg: big, w: 10, h: 20, length: big.length });
      let keys = [...(await state.storage.list({ prefix: "drawing:a:render:" })).keys()];
      expect(keys.length).toBe(1 + Math.ceil(big.length / 60_000));
      await repo.putRender("o_000000000001", { hash: "h2", status: "error", error: "bad" });
      expect(await repo.getRender("o_000000000001")).toMatchObject({ hash: "h2", status: "error", error: "bad" });
      keys = [...(await state.storage.list({ prefix: "drawing:a:render:" })).keys()];
      expect(keys).toEqual(["drawing:a:render:o_000000000001"]);
      expect(await new DoStorageRepository(state.storage).getRender("o_000000000001")).toBeNull();
      await repo.putRender("o_000000000001", null);
      expect(await repo.getRender("o_000000000001")).toBeNull();
      expect([...(await state.storage.list({ prefix: "drawing:a:render:" })).keys()]).toEqual([]);
      // Board objects never pick up render keys.
      const board = createWhiteboard(repo, { renderDiagram: async () => ({ data: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"/>') }) });
      const { created } = await board.addObjects({ objects: [{ type: "diagram", source: "a -> b" }] });
      expect(await board.diagramRender(created[0].id)).toMatchObject({ status: "ok", w: 4, h: 2 });
      const reopened = createWhiteboard(repo);
      expect(Object.keys((await reopened.getBoard()).objects)).toEqual([created[0].id]);
      expect(await reopened.diagramRender(created[0].id)).toMatchObject({ status: "ok" });
    });
  });
});

describe("DrawingHost diagram renders", () => {
  it("passes its renderer to every drawing and exposes getDiagramRender", async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const calls = [];
      const host = new DrawingHost(state.storage, {
        renderDiagram: async (req) => { calls.push(req.source); return { data: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="4"/>' }; },
      });
      const { id } = await host.create({});
      const { api } = await host.open(id);
      const { created } = await api.addObjects({ objects: [{ type: "diagram", source: "x -> y" }] });
      expect(await api.getDiagramRender(created[0].id)).toMatchObject({ status: "ok", w: 8, h: 4 });
      expect(calls).toEqual(["x -> y"]);
      const bare = new DrawingHost(state.storage);
      const other = await bare.create({});
      const made = await (await bare.open(other.id)).api.addObjects({ objects: [{ type: "diagram", source: "a" }] });
      expect(await (await bare.open(other.id)).api.getDiagramRender(made.created[0].id)).toMatchObject({ status: "unavailable" });
    });
  });
});
