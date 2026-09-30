// Tables and diagrams in the harness: toolbar insert buttons, editing table cells in place (Tab,
// Enter, a row added past the end), row/column/header controls, pasting a spreadsheet selection,
// and diagrams drawn from the (fake) renderer as images, with the placeholder when no renderer is
// connected and when the source does not render.
//   node scripts/build.mjs && node --test e2e/tables-diagrams.test.mjs
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import * as h from "./harness-helpers.mjs";

const SHOTS = process.env.HARNESS_SHOTS || "/tmp/harness-shots";
let server, browser;
before(async () => {
  await mkdir(SHOTS, { recursive: true });
  server = await h.startHarnessServer({ port: Number(process.env.HARNESS_PORT || 8796) });
  browser = await h.launch();
});
after(async () => { await browser?.close(); server?.stop(); });

const objectsOf = async (page, type) => Object.values((await h.serverBoard(page)).objects).filter((o) => o.type === type);

test("tables: insert, edit cells with Tab and Enter, grow, restructure, paste", async () => {
  const ctx = await h.openHarness(browser, server.url, { names: ["Alice", "Bob"] });
  const { page, frames: { A, B } } = ctx;
  try {
    await h.waitLive(A);
    await h.setCamera(A);
    await A.locator(".wb-toolbar .insert-table").click();
    // The first cell opens for typing straight away.
    const cellEditor = A.locator("textarea.wb-editor");
    await cellEditor.waitFor();
    await page.keyboard.type("Name");
    await page.keyboard.press("Tab");
    await page.keyboard.type("Owner");
    await page.keyboard.press("Enter"); // down: row 2, column 2
    await page.keyboard.type("Alice");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.type("Roadmap");
    // Tab from the last cell of the last row adds a row: (1,0) -> (1,1) (1,2) (2,0) (2,1) (2,2) -> new (3,0).
    for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
    await page.keyboard.type("Hiring");
    await page.keyboard.press("Escape");
    await h.until(async () => (await objectsOf(page, "table"))[0]?.cells?.[3]?.[0] === "Hiring", { message: "cells saved" });
    const [t] = await objectsOf(page, "table");
    assert.deepEqual(t.cells.slice(0, 2), [["Name", "Owner", "Column 3"], ["Roadmap", "Alice", ""]]);
    assert.equal(t.cells.length, 4);
    assert.equal(t.header, true);
    await B.locator(h.SEL.object(t.id)).waitFor();

    await h.inPane(A, (_, canvas, id) => canvas.setSelection([id]), t.id);
    await A.locator(".wb-stylebar .table-add-col").click();
    await A.locator(".wb-stylebar .table-header-btn").click();
    await h.until(async () => {
      const x = (await objectsOf(page, "table"))[0];
      return x.cells[0].length === 4 && x.header === false;
    }, { message: "column added, header off" });
    await A.locator(".wb-stylebar .table-fit-btn").click();
    await h.until(async () => (await objectsOf(page, "table"))[0].colWidths?.length === 4, { message: "fitted" });
    await page.screenshot({ path: `${SHOTS}/table.png` });

    // Paste a spreadsheet selection (tab-separated) onto the board.
    await h.inPane(A, (_, canvas) => canvas.setSelection([]));
    await A.locator(".wb-canvas").focus();
    await A.locator(".wb-canvas").evaluate((el) => {
      const data = new DataTransfer();
      data.setData("text/plain", "Quarter\tRevenue\nQ1\t120\nQ2\t140");
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await h.until(async () => (await objectsOf(page, "table")).length === 2, { message: "pasted table" });
    const pasted = (await objectsOf(page, "table")).find((x) => x.id !== t.id);
    assert.deepEqual(pasted.cells, [["Quarter", "Revenue"], ["Q1", "120"], ["Q2", "140"]]);
    assert.deepEqual(ctx.errors.filter((e) => !/favicon/.test(e)), []);
  } finally { await ctx.context.close(); }
});

test("diagrams render as images, re-render on edit and explain errors", async () => {
  const ctx = await h.openHarness(browser, server.url, { names: ["Alice", "Bob"] });
  const { page, frames: { A, B } } = ctx;
  try {
    await h.waitLive(A);
    await h.setCamera(A);
    await A.locator(".wb-toolbar .insert-diagram").click();
    await h.until(async () => (await objectsOf(page, "diagram")).length === 1, { message: "diagram" });
    const [d] = await objectsOf(page, "diagram");
    assert.equal(d.syntax, "d2");
    // Both panes draw the render as a data: image, never as markup.
    await A.locator(`${h.SEL.object(d.id)} image`).waitFor();
    await B.locator(`${h.SEL.object(d.id)} image`).waitFor();
    const href = await A.locator(`${h.SEL.object(d.id)} image`).getAttribute("href");
    assert.match(href ?? "", /^data:image\/svg\+xml;base64,/);
    await page.screenshot({ path: `${SHOTS}/diagram.png` });
    // Fit gives the box the drawing's proportions.
    await h.inPane(A, (_, canvas, id) => canvas.setSelection([id]), d.id);
    await A.locator(".wb-stylebar .diagram-fit-btn").click();
    await h.until(async () => (await objectsOf(page, "diagram"))[0].h !== 320, { message: "fitted" });

    // Edit the source: a new render.
    await h.inPane(A, (_, canvas, id) => canvas.editText(id), d.id);
    const editor = A.locator("textarea.wb-editor");
    await editor.waitFor();
    await editor.fill("a -> b\nb -> c\nc -> a");
    await page.keyboard.press("Escape");
    await h.until(async () => (await objectsOf(page, "diagram"))[0].text.startsWith("a -> b"), { message: "source saved" });
    await h.until(async () => {
      const src = await A.locator(`${h.SEL.object(d.id)} image`).getAttribute("href").catch(() => null);
      return src && src !== href;
    }, { message: "re-rendered" });

    // Mermaid and layout controls.
    await h.inPane(A, (_, canvas, id) => canvas.setSelection([id]), d.id);
    await A.locator('.wb-stylebar .diagram-layout-btn[data-layout="elk"]').click();
    await h.until(async () => (await objectsOf(page, "diagram"))[0].layout === "elk", { message: "layout" });

    // A render error shows on the placeholder.
    await h.inPane(A, (_, canvas, id) => canvas.editText(id), d.id);
    await A.locator("textarea.wb-editor").fill("x -> !error");
    await page.keyboard.press("Escape");
    await A.locator(h.SEL.object(d.id)).getByText(/Could not render/).waitFor();
    await page.screenshot({ path: `${SHOTS}/diagram-error.png` });

    // Pasting a fenced Mermaid block makes a Mermaid diagram.
    await h.inPane(A, (_, canvas) => canvas.setSelection([]));
    await A.locator(".wb-canvas").focus();
    await A.locator(".wb-canvas").evaluate((el) => {
      const data = new DataTransfer();
      data.setData("text/plain", "```mermaid\nflowchart LR\n  a --> b\n```");
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await h.until(async () => (await objectsOf(page, "diagram")).some((x) => x.syntax === "mermaid"), { message: "pasted mermaid" });
    assert.deepEqual(ctx.errors.filter((e) => !/favicon/.test(e)), []);
  } finally { await ctx.context.close(); }
});

test("without a renderer a diagram says how to connect one", async () => {
  const ctx = await h.openHarness(browser, server.url, { names: ["Alice"], panes: 1, query: "&norender=1" });
  const { page, frames: { A } } = ctx;
  try {
    await h.waitLive(A);
    const id = await h.inPane(A, (_, canvas) => canvas.addAtCenter("diagram"));
    await A.locator(h.SEL.object(id)).getByText(/connect MermaiD2/).waitFor();
    await page.screenshot({ path: `${SHOTS}/diagram-unavailable.png` });
  } finally { await ctx.context.close(); }
});
