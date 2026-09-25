import { test } from "node:test";
import assert from "node:assert/strict";
import * as h from "./harness-helpers.mjs";
test("URL paste syncs a safe card with a visible website action", async () => {
  const server = await h.startHarnessServer({ port: 8796 });
  let browser, ctx;
  try {
    browser = await h.launch();
    ctx = await h.openHarness(browser, server.url, { names: ["Alice", "Bob"] });
    const { page, frames: { A, B } } = ctx;
    const outgoing = [];
    page.on("request", (r) => { if (/youtube|youtu\.be/.test(r.url())) outgoing.push(r.url()); });
    const url = "https://youtu.be/dQw4w9WgXcQ?t=43";
    await h.inPane(A, (_, canvas) => canvas.element.focus());
    await A.locator("body").evaluate((_, text) => {
      const dt = new DataTransfer(); dt.setData("text/plain", text);
      document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, url);
    const card = await h.until(async () => Object.values((await h.serverBoard(page)).objects).find((o) => o.text.includes(url)), { message: "URL card syncs" });
    assert.equal(card.type, "rect"); assert.match(card.text, /YouTube video/);
    await B.locator(h.SEL.object(card.id)).waitFor();
    await A.locator(".open-website-btn").click();
    const dialog = A.locator(".wb-link");
    assert.equal(await dialog.locator("input").inputValue(), url);
    await page.screenshot({ path: "/tmp/whiteboard-link-card.png" });
    const anchor = dialog.locator("a");
    assert.equal(await anchor.getAttribute("href"), url);
    assert.equal(await anchor.getAttribute("rel"), "noopener noreferrer");
    assert.equal(await anchor.getAttribute("target"), "_blank");
    assert.deepEqual(outgoing, [], "pasting and inspecting never contacts the website");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+z");
    await h.until(async () => !(await h.serverBoard(page)).objects[card.id], { message: "one undo removes card" });
    assert.deepEqual(ctx.errors, []);
  } catch (error) { console.error(ctx?.errors, ctx && await h.serverBoard(ctx.page), ctx && await ctx.frames.A.locator(".toast").allTextContents()); throw error; } finally { await ctx?.context.close(); await browser?.close(); server.stop(); }
});
