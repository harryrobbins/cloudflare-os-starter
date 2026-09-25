import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as h from "./harness-helpers.mjs";
let server, browser;
before(async () => {
  server = await h.startHarnessServer({ port: Number(process.env.HARNESS_PORT || 8794) });
  browser = await h.launch();
});
after(async () => { await browser?.close(); server?.stop(); });

test("selected shapes connect by handle drag, handle tap and keyboard picker", async () => {
  const ctx = await h.openHarness(browser, server.url, { names: ["Alice", "Bob"] });
  const { page, frames: { A, B } } = ctx;
  try {
    const [source, target] = await h.createObjects(page, [
      { type: "rect", x: 160, y: 200, w: 100, h: 100, text: "Source" },
      { type: "rect", x: 400, y: 200, w: 100, h: 100, text: "Destination" },
    ]);
    await A.locator(h.SEL.object(target)).waitFor();
    await h.setCamera(A);
    const select = () => h.inPane(A, (_, canvas, id) => canvas.setSelection([id]), source);
    await select();
    const handle = A.locator('.wb-connect-handle[data-side="right"] circle');
    await handle.waitFor();
    await page.screenshot({ path: "/tmp/whiteboard-connection-handles.png" });
    const box = await handle.boundingBox();
    const end = await h.objectCenter(A, target);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 12 });
    await page.mouse.up();
    const waitCount = async (count) => {
      await page.waitForFunction(async (n) => Object.values((await window.harness.getBoard()).objects).filter((o) => o.type === "connector").length === n, count);
    };
    await waitCount(1);
    let conns = Object.values((await h.serverBoard(page)).objects).filter((o) => o.type === "connector");
    assert.equal(conns[0].fromSide, "right");
    assert.equal(conns[0].from, source);
    assert.equal(conns[0].to, target);
    await B.locator(h.SEL.object(conns[0].id)).waitFor();
    await select();
    const clickBox = await handle.boundingBox();
    await page.mouse.click(clickBox.x + clickBox.width / 2, clickBox.y + clickBox.height / 2);
    await A.getByRole("combobox", { name: "Search objects" }).fill("Destination");
    await page.keyboard.press("Enter");
    await waitCount(2);
    await select();
    await A.locator(".wb-canvas").focus();
    await page.keyboard.press("Shift+C");
    await A.getByRole("combobox", { name: "Search objects" }).fill("Destination");
    await page.keyboard.press("Enter");
    await waitCount(3);
    await select();
    await A.locator(".connect-to-btn").click();
    await A.getByRole("combobox", { name: "Search objects" }).waitFor();
    await page.keyboard.press("Escape");
    assert.equal(Object.values((await h.serverBoard(page)).objects).filter((o) => o.type === "connector").length, 3);
    assert.deepEqual(ctx.errors.filter((e) => !/favicon/.test(e)), []);
  } finally { await ctx.context.close(); }
});
