import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as h from "./harness-helpers.mjs";
let server, browser;
before(async () => {
  server = await h.startHarnessServer({ port: Number(process.env.HARNESS_PORT || 8796) });
  browser = await h.launch();
});
after(async () => { await browser?.close(); server?.stop(); });
test("help searches commands and disabled character shortcuts retain a visible recovery route", async () => {
  const ctx = await h.openHarness(browser, server.url, { names: ["Alice", "Bob"] });
  const { page, frames: { A, B } } = ctx;
  try {
    const open = async () => {
      await A.locator(".wb-board-menu").click();
      await A.getByRole("menuitem", { name: "Keyboard shortcuts (?)", exact: true }).click();
      await A.locator(h.SEL.helpDialog).waitFor();
    };
    await open();
    const search = A.getByRole("searchbox", { name: "Find a command or shortcut" });
    await search.fill("code");
    assert.ok((await A.locator(".wb-help table").innerText()).toLowerCase().includes("code"));
    await search.fill("zznonexistentcommand");
    await A.getByRole("status").filter({ hasText: "No matching shortcuts" }).waitFor();
    await A.getByRole("checkbox", { name: "Enable single-character shortcuts" }).uncheck();
    await A.getByRole("button", { name: "Close", exact: true }).click();
    await A.locator(".wb-canvas").focus();
    for (const key of ["n", "a", "?"]) await page.keyboard.press(key);
    assert.equal(await h.inPane(A, (_, canvas) => canvas.getTool()), "select");
    assert.equal(await A.locator(".wb-help, .menu").count(), 0);
    // Preference is private to this viewer: a second editor keeps their shortcuts.
    await B.locator(".wb-canvas").focus();
    await page.keyboard.press("n");
    assert.equal(await h.inPane(B, (_, canvas) => canvas.getTool()), "sticky");
    await open();
    assert.equal(await A.getByRole("checkbox", { name: "Enable single-character shortcuts" }).isChecked(), false);
    await A.getByRole("checkbox", { name: "Enable single-character shortcuts" }).check();
    await A.getByRole("button", { name: "Close", exact: true }).click();
    await A.locator(".wb-canvas").focus();
    await page.keyboard.press("n");
    assert.equal(await h.inPane(A, (_, canvas) => canvas.getTool()), "sticky");
    assert.deepEqual(ctx.errors.filter((e) => !/favicon/.test(e)), []);
  } finally { await ctx.context.close(); }
});
