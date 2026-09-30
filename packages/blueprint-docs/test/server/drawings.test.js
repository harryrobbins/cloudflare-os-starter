// Server tests in workerd: drawings inside the Docs Durable Object, over real DO storage and RPC.
// Storage persists between tests, so each test uses its own Durable Object.
import { env, RpcTarget } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { ExportHandler } from "../../src/server/index.js";
import { DrawingHost, PREVIEW_CHUNK, prefixOf } from "blueprint-whiteboard/embed/server";

class DocCallbacks extends RpcTarget {
  events = [];
  presences = [];
  operation(event) { this.events.push(event); }
  presence(event) { this.presences.push(event); }
}

class BoardCallbacks extends RpcTarget {
  ops = [];
  calls = [];
  operation(event) { this.ops.push(event); }
  presence(events) { this.calls.push(events); }
}

const fresh = () => env.GADGET.get(env.GADGET.idFromName(crypto.randomUUID()));
const drawingId = () => "d_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);

async function seed(stub, texts = ["Intro", "Body"]) {
  const blocks = texts.map((t, i) => ({ id: "b_" + i, html: `<p data-block-id="b_${i}">${t}</p>` }));
  return stub.setDocument({ title: "Plan", blocks, senderId: "seed" });
}

describe("createDrawing", () => {
  it("adds a figure block at the end by default and lists the drawing", async () => {
    const stub = fresh();
    await seed(stub);
    const created = await stub.createDrawing({ title: "Architecture" });
    expect(created.id).toMatch(/^d_[0-9a-f]{12}$/);
    expect(created.title).toBe("Architecture");
    const doc = await stub.getDocument();
    expect(doc.blocks.map((b) => b.id)).toEqual(["b_0", "b_1", created.blockId]);
    expect(doc.blocks[2].html).toBe(
      `<figure data-block-id="${created.blockId}" class="doc-drawing" data-drawing-id="${created.id}" contenteditable="false"></figure>`);
    const list = await stub.listDrawings();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: created.id, title: "Architecture", objects: 0, blockIds: [created.blockId], openBy: [] });
  });

  it("inserts after a named block or at the start, and works on a document never opened", async () => {
    const stub = fresh();
    const first = await stub.createDrawing({});
    expect((await stub.getDocument()).blocks.map((b) => b.id)).toEqual([first.blockId]);
    await seed(stub);
    const after = await stub.createDrawing({ insertAfter: "b_0" });
    const start = await stub.createDrawing({ insertAfter: "start" });
    expect((await stub.getDocument()).blocks.map((b) => b.id)).toEqual([start.blockId, "b_0", after.blockId, "b_1"]);
  });

  it("with insertAfter null only creates data (the editor inserts its own figure), and rejects reused ids", async () => {
    const stub = fresh();
    await seed(stub);
    const id = drawingId();
    const created = await stub.createDrawing({ id, insertAfter: null });
    expect(created).toMatchObject({ id, blockId: null });
    expect((await stub.getDocument()).blocks).toHaveLength(2);
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.createDrawing({ id, insertAfter: null })).rejects.toThrow(/already exists/);
      await expect(instance.createDrawing({ id: "o_123", insertAfter: null })).rejects.toThrow(/id must look like/);
    });
  });

  it("imports a whiteboard backup", async () => {
    const stub = fresh();
    const data = { format: "cloudflare-os-whiteboard", version: 1, title: "Imported", objects: [
      { id: "a", type: "sticky", x: 0, y: 0, w: 200, h: 200, text: "One" },
      { id: "b", type: "sticky", x: 300, y: 0, w: 200, h: 200, text: "Two" },
    ] };
    const created = await stub.createDrawing({ data });
    expect(created.title).toBe("Imported");
    expect(created.imported.created).toBe(2);
    const board = await stub.drawing(created.id, "getBoard");
    expect(Object.values(board.objects).map((o) => o.text).sort()).toEqual(["One", "Two"]);
  });
});

describe("drawing(id, method, args)", () => {
  it("passes the whiteboard's convenience methods through, and rejects others", async () => {
    const stub = fresh();
    const { id } = await stub.createDrawing({});
    const { created } = await stub.drawing(id, "addStickies", { stickies: ["Ship it", "Test it"], by: "Assistant" });
    expect(created).toHaveLength(2);
    const { connector } = await stub.drawing(id, "connectObjects", { from: created[0].id, to: created[1].id, label: "then" });
    expect(connector.type).toBe("connector");
    const found = await stub.drawing(id, "findObjects", { type: "sticky", text: "ship" });
    expect(found.map((o) => o.text)).toEqual(["Ship it"]);
    // Rejections are checked inside the object: across RPC the pool reports them as unhandled.
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.drawing(id, "subscribe", {})).rejects.toThrow(/unknown method/);
      await expect(instance.drawing(drawingId(), "getBoard")).rejects.toThrow(/No drawing/);
      await expect(instance.drawing("nonsense", "getBoard")).rejects.toThrow(/No drawing/);
    });
  });

  it("keeps two drawings apart", async () => {
    const stub = fresh();
    const a = await stub.createDrawing({ title: "A" });
    const b = await stub.createDrawing({ title: "B" });
    await stub.drawing(a.id, "addStickies", { stickies: ["only in A"] });
    expect(Object.keys((await stub.drawing(a.id, "getBoard")).objects)).toHaveLength(1);
    expect(Object.keys((await stub.drawing(b.id, "getBoard")).objects)).toHaveLength(0);
    const list = await stub.listDrawings();
    expect(list.map((d) => [d.title, d.objects]).sort()).toEqual([["A", 1], ["B", 0]]);
  });
});

describe("previews", () => {
  it("re-renders after a change and announces it to document subscribers", async () => {
    const stub = fresh();
    await seed(stub);
    const callbacks = new DocCallbacks();
    await stub.subscribe(callbacks, { clientId: "c1", name: "Ann" });
    const { id } = await stub.createDrawing({ title: "Flow" });
    await stub.drawing(id, "addStickies", { stickies: ["Preview me"] });
    await vi.waitFor(async () => {
      const preview = await stub.getDrawingPreview(id);
      expect(preview.svg).toContain("Preview me");
    }, { timeout: 6000, interval: 100 });
    await vi.waitFor(() => {
      const announced = callbacks.events.filter((e) => e.type === "drawing" && e.id === id);
      expect(announced.at(-1)?.revision).toBeGreaterThanOrEqual(2);
    }, { timeout: 6000, interval: 100 });
    // The figure block itself never changes: a preview is not a document edit.
    const figure = (await stub.getDocument()).blocks.find((b) => b.html.includes(id));
    expect(figure.version).toBe(1);
  });

  it("renders on demand when none is stored, and returns null for unknown drawings", async () => {
    const stub = fresh();
    const id = drawingId();
    await stub.createDrawing({ id, insertAfter: null });
    const preview = await stub.getDrawingPreview(id);
    expect(preview.svg).toContain("<svg");
    expect(await stub.getDrawingPreview(drawingId())).toBeNull();
  });

  it("stores a large preview in chunks and reassembles it", async () => {
    const stub = fresh();
    await runInDurableObject(stub, async (_instance, state) => {
      const host = new DrawingHost(state.storage);
      const { id } = await host.create({});
      const long = "x".repeat(900);
      const { api } = await host.open(id);
      await api.addStickies({ stickies: Array.from({ length: 150 }, (_, i) => `${i} ${long}`) });
      const meta = await host.refreshPreview(id);
      expect(meta.chunks).toBeGreaterThan(1);
      expect(meta.length).toBeGreaterThan(PREVIEW_CHUNK);
      const preview = await host.getPreview(id);
      expect(preview.svg.length).toBe(meta.length);
      expect(preview.svg.trimEnd().endsWith("</svg>")).toBe(true);
      // Fewer chunks after the drawing shrinks: the stale ones are removed.
      await api.deleteObjects({ ids: Object.keys((await api.getBoard()).objects) });
      const small = await host.refreshPreview(id);
      expect(small.chunks).toBe(1);
      const keys = [...(await state.storage.list({ prefix: prefixOf(id) + "preview:" })).keys()];
      expect(keys).toEqual([prefixOf(id) + "preview:0"]);
    });
  });

  it("marks a drawing too large to preview instead of storing it", async () => {
    const stub = fresh();
    await runInDurableObject(stub, async (_instance, state) => {
      const host = new DrawingHost(state.storage, { limits: { previewChars: 100 } });
      const { id } = await host.create({});
      const preview = await host.getPreview(id);
      expect(preview).toMatchObject({ svg: null, tooLarge: true });
    });
  });
});

describe("the editor's live channel", () => {
  it("subscribes, applies operations, reports who has it open, and leaves", async () => {
    const stub = fresh();
    const { id } = await stub.createDrawing({});
    const watcher = new BoardCallbacks();
    const snap = await stub.drawingSubscribe(id, watcher, { clientId: "w1", name: "Watcher", color: "#112233" });
    expect(snap.revision).toBeGreaterThanOrEqual(0);
    expect(typeof snap.session).toBe("string");
    const editor = new BoardCallbacks();
    const second = await stub.drawingSubscribe(id, editor, { clientId: "e1", name: "Editor", color: "#445566" });
    const objectId = "o_" + "1a".repeat(6);
    const result = await stub.drawingApply(id, {
      senderId: "e1", by: "Editor",
      objectOps: [{ op: "create", object: { id: objectId, type: "rect", x: 0, y: 0, w: 100, h: 60, text: "Box" } }],
    });
    expect(result.upserts.map((o) => o.id)).toEqual([objectId]);
    await vi.waitFor(() => expect(watcher.ops.some((e) => e.upserts?.some((o) => o.id === objectId))).toBe(true));
    const presence = await stub.drawingPresence(id, { clientId: "e1", session: second.session, cursor: { x: 5, y: 5 } });
    expect(presence.known).toBe(true);
    expect((await stub.listDrawings())[0].openBy.sort()).toEqual(["Editor", "Watcher"]);
    await stub.drawingLeave(id, "e1", second.session);
    await stub.drawingLeave(id, "w1", snap.session);
    expect((await stub.listDrawings())[0].openBy).toEqual([]);
    const undone = await stub.drawingUndo(id, { by: "Editor", senderId: "e1" });
    expect(undone.deletes).toContain(objectId);
    expect((await stub.drawingHistory(id, 10)).length).toBeGreaterThanOrEqual(2);
  });

  it("refuses drawings that do not exist, without creating them", async () => {
    const stub = fresh();
    const id = drawingId();
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.drawingSubscribe(id, new BoardCallbacks(), { clientId: "x" })).rejects.toThrow(/No drawing/);
      await expect(instance.drawingApply(id, { objectOps: [] })).rejects.toThrow(/No drawing/);
    });
    expect(await stub.listDrawings()).toEqual([]);
  });
});

describe("the document around drawings", () => {
  it("accepts text edits while a drawing changes", async () => {
    const stub = fresh();
    await seed(stub);
    const { id, blockId } = await stub.createDrawing({});
    const doc = await stub.getDocument();
    const [text, drawing] = await Promise.all([
      stub.applyOperation({ senderId: "c1", upserts: [{ id: "b_0", html: '<p data-block-id="b_0">Intro, edited</p>', baseVersion: 1 }], order: doc.blocks.map((b) => b.id) }),
      stub.drawing(id, "addStickies", { stickies: ["meanwhile"] }),
    ]);
    expect(text.status).toBe("applied");
    expect(drawing.created).toHaveLength(1);
    const after = await stub.getDocument();
    expect(after.blocks.map((b) => b.id)).toEqual(["b_0", "b_1", blockId]);
  });

  it("removeDrawing deletes its figures and its data", async () => {
    const stub = fresh();
    await seed(stub);
    const { id } = await stub.createDrawing({});
    await stub.drawing(id, "addStickies", { stickies: ["gone soon"] });
    expect(await stub.removeDrawing(id)).toEqual({ removed: true });
    expect((await stub.getDocument()).blocks.map((b) => b.id)).toEqual(["b_0", "b_1"]);
    expect(await stub.listDrawings()).toEqual([]);
    await runInDurableObject(stub, async (_instance, state) => {
      expect([...(await state.storage.list({ prefix: prefixOf(id) })).keys()]).toEqual([]);
    });
  });

  it("exports Markdown with each drawing as an SVG image", async () => {
    const stub = fresh();
    await seed(stub);
    const { id } = await stub.createDrawing({ title: "Flow [v2]" });
    await stub.drawing(id, "addStickies", { stickies: ["Exported"] });
    const handler = new ExportHandler({}, {});
    const body = await handler.export(stub, "markdown");
    const markdown = await new Response(body).text();
    expect(markdown).toContain("Intro");
    const match = /!\[Flow \\\[v2\\\]\]\(data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)\)/.exec(markdown);
    expect(match).not.toBeNull();
    const svg = new TextDecoder().decode(Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0)));
    expect(svg).toContain("Exported");
  });
});

describe("the README's example", () => {
  it("runs as written", async () => {
    const Doc = fresh();
    await seed(Doc);
    const { id, blockId } = await Doc.createDrawing({ title: "Deploy pipeline", insertAfter: "b_0", by: "Assistant" });
    expect((await Doc.getDocument()).blocks.map((b) => b.id)).toEqual(["b_0", blockId, "b_1"]);
    const { created } = await Doc.drawing(id, "addStickies", {
      by: "Assistant", stickies: ["Build", "Test", { text: "Deploy", color: "green" }], columns: 3,
    });
    await Doc.drawing(id, "connectObjects", { from: created[0].id, to: created[1].id, routing: "elbow", by: "Assistant" });
    await Doc.drawing(id, "connectObjects", { from: created[1].id, to: created[2].id, routing: "elbow", by: "Assistant" });
    const hits = await Doc.drawing(id, "findIcons", { query: "database", limit: 3 });
    const icons = await Doc.drawing(id, "addIcons", { icons: [`${hits[0].packId}/${hits[0].iconId}`], by: "Assistant" });
    expect(icons.errors).toEqual([]);
    const [listed] = await Doc.listDrawings();
    expect(listed).toMatchObject({ id, title: "Deploy pipeline", objects: 6, blockIds: [blockId] });
    const svg = await Doc.drawing(id, "exportSvg", {});
    expect(svg).toContain("Deploy");
    expect(await Doc.removeDrawing(id)).toEqual({ removed: true });
  });

  it("titles a drawing created without one", async () => {
    const stub = fresh();
    expect((await stub.createDrawing({})).title).toBe("Untitled drawing");
  });
});
