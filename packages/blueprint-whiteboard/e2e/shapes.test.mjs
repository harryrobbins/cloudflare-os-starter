// Shapes and connector styling in the harness: the Shapes tool and its picker, the style bar's
// Shape, Line pattern and end-marker pickers, and dragging a connection handle to empty canvas
// (a connected copy, seen by the other pane, one undo removes both).
//   node scripts/build.mjs && node --test e2e/shapes.test.mjs
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import * as h from "./harness-helpers.mjs";

const SHOTS = process.env.HARNESS_SHOTS || "/tmp/harness-shots";
let server, browser;
before(async () => {
  await mkdir(SHOTS, { recursive: true });
  server = await h.startHarnessServer({ port: Number(process.env.HARNESS_PORT || 8795) });
  browser = await h.launch();
});
after(async () => { await browser?.close(); server?.stop(); });

const objectsOf = async (page, type) => Object.values((await h.serverBoard(page)).objects).filter((o) => o.type === type);

test("the Shapes tool draws the picked shape; the style bar changes shape, pattern and markers", async () => {
  const ctx = await h.openHarness(browser, server.url, { names: ["Alice", "Bob"] });
  const { page, frames: { A, B } } = ctx;
  try {
    await h.waitLive(A);
    await h.setCamera(A);
    // Pick the database shape from the toolbar's Shapes tool and click the board.
    await A.locator(h.SEL.tool("rect")).click();
    await A.locator('.shape-pop [data-value="cylinder"]').click();
    assert.equal(await h.inPane(A, (_, canvas) => canvas.getShape()), "cylinder");
    const at = await h.panePoint(page, "A", 400, 300);
    await page.mouse.click(at.x, at.y);
    await h.until(async () => (await objectsOf(page, "rect")).length === 1, { message: "a rect" });
    const [db] = await objectsOf(page, "rect");
    assert.equal(db.style.shape, "cylinder");
    assert.deepEqual([db.w, db.h], [140, 160]);
    await B.locator(`${h.SEL.object(db.id)} path`).first().waitFor();

    // A diamond from the Add menu, then connect the two and style the connector.
    const diamond = await h.inPane(A, (_, canvas) => canvas.addAtCenter("rect", { shape: "diamond" }));
    await h.inPane(A, (_, canvas, id) => canvas.setSelection([id]), db.id);
    await A.locator(".wb-stylebar .shape-btn").click();
    await A.locator('.shape-pop [data-value="hexagon"]').click();
    await h.until(async () => (await h.serverBoard(page)).objects[db.id].style.shape === "hexagon", { message: "hexagon" });
    await A.locator('.wb-stylebar .dash-btn[data-dash="dashed"]').click();
    await h.until(async () => (await h.serverBoard(page)).objects[db.id].style.dash === "dashed", { message: "dashed" });

    await h.inPane(A, (_, canvas, ids) => canvas.setSelection(ids), [db.id, diamond]);
    await A.locator(".wb-stylebar .connect-btn").click();
    await h.until(async () => (await objectsOf(page, "connector")).length === 1, { message: "a connector" });
    const [conn] = await objectsOf(page, "connector");
    await h.inPane(A, (_, canvas, id) => canvas.setSelection([id]), conn.id);
    await A.locator(".wb-stylebar .arrow-end-btn").click();
    await A.locator('.marker-pop [data-value="crow"]').click();
    await A.locator(".wb-stylebar .arrow-start-btn").click();
    await A.locator('.marker-pop [data-value="bar"]').click();
    await h.until(async () => {
      const s = (await h.serverBoard(page)).objects[conn.id].style;
      return s.arrowEnd === "crow" && s.arrowStart === "bar";
    }, { message: "markers" });
    await A.locator(".wb-stylebar .arrow-swap-btn").click();
    await h.until(async () => (await h.serverBoard(page)).objects[conn.id].style.arrowEnd === "bar", { message: "swapped" });
    await page.screenshot({ path: `${SHOTS}/shapes-styled.png` });
    assert.deepEqual(ctx.errors.filter((e) => !/favicon/.test(e)), []);
  } finally { await ctx.context.close(); }
});

test("every shape renders, and a handle dragged to empty canvas adds a connected copy", async () => {
  const ctx = await h.openHarness(browser, server.url, { names: ["Alice", "Bob"] });
  const { page, frames: { A, B } } = ctx;
  try {
    await h.waitLive(A);
    await h.setCamera(A, { x: -40, y: -40, zoom: 0.6 });
    const shapes = ["rect", "rounded", "pill", "diamond", "triangle", "hexagon", "octagon", "pentagon", "parallelogram",
      "trapezoid", "cylinder", "document", "cloud", "callout", "star", "cross", "arrow", "chevron"];
    const ids = await h.createObjects(page, shapes.map((shape, i) => ({
      type: "rect", x: (i % 6) * 240, y: Math.floor(i / 6) * 220, w: 180, h: 140, text: shape, style: { shape, fill: "#b5d8ff" },
    })));
    for (const id of ids) await A.locator(h.SEL.object(id)).waitFor();
    await page.screenshot({ path: `${SHOTS}/shapes-all.png` });

    // Drag the pentagon's right handle to empty space (below the shapes, clear of the minimap).
    const source = ids[shapes.indexOf("pentagon")];
    await h.setCamera(A);
    await h.inPane(A, (_, canvas, id) => canvas.setSelection([id]), source);
    const handle = A.locator('.wb-connect-handle[data-side="right"] circle');
    await handle.waitFor();
    const box = await handle.boundingBox();
    const empty = await h.panePoint(page, "A", 500, 760);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(empty.x, empty.y, { steps: 12 });
    await A.locator(".wb-preview-ghost").waitFor();
    await page.screenshot({ path: `${SHOTS}/shapes-drag-to-empty.png` });
    await page.mouse.up();
    await h.until(async () => (await objectsOf(page, "connector")).length === 1, { message: "connector" });
    const board = await h.serverBoard(page);
    const [conn] = Object.values(board.objects).filter((o) => o.type === "connector");
    const copy = board.objects[conn.to];
    assert.equal(conn.from, source);
    assert.equal(conn.fromSide, "right");
    assert.equal(copy.style.shape, "pentagon");
    assert.equal(copy.text, "");
    assert.deepEqual(await h.inPane(A, (_, canvas) => canvas.getSelection()), [copy.id]);
    await B.locator(h.SEL.object(copy.id)).waitFor();
    await B.locator(h.SEL.object(conn.id)).waitFor();

    // One undo removes the copy and its connector.
    await A.locator(".wb-canvas").focus();
    await page.keyboard.press("Control+z");
    await h.until(async () => !(await h.serverBoard(page)).objects[copy.id], { message: "undo" });
    assert.equal((await objectsOf(page, "connector")).length, 0);
    assert.deepEqual(ctx.errors.filter((e) => !/favicon/.test(e)), []);
  } finally { await ctx.context.close(); }
});
