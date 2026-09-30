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
