// The adapt block's core extension points in the real built client (dist/client.lib.js +
// dist/client.js, assembled as the platform does): a fixture adapt block replaces the shipped one
// in client.js, as an agent's edit would, and the test checks that an extra action appears in the
// board menu and the right-click menu and runs from the keyboard, extra styles apply, a failing
// action is reported without breaking the board, and onReady fires once with the app handle.
//
//   node scripts/build.mjs && node --test e2e/adapt.test.mjs
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as h from "./harness-helpers.mjs";

const FIXTURE = `const adapt = {
  newObjectColors: { sticky: "blue" },
  minimap: false,
  styles: ".wb-topbar { outline: 3px solid rgb(255, 0, 0); }",
  actions: [
    { id: "add-row", label: "Add a test row", title: "Adds three sticky notes", run(app) {
      const { created } = app.addStickies({ stickies: ["A", "B", { text: "C", color: "green" }], columns: 3 });
      app.setSelection(created.map((o) => o.id));
      app.toast("Added " + created.length + " notes");
    } },
    { id: "broken", label: "Broken action", run() { throw new Error("nope"); } },
    { label: "" },
  ],
  onReady(app) { window.__adaptReady = (window.__adaptReady ?? 0) + 1; window.__adaptVerbs = Object.keys(app).sort(); },
};
`;

let server, browser;
before(async () => {
  server = await h.startHarnessServer({ port: Number(process.env.HARNESS_PORT || 8797) });
  browser = await h.launch();
});
after(async () => { await browser?.close(); server?.stop(); });

test("an adapt block's action, styles, settings and onReady work in the built client", async () => {
  // Swap the shipped adapt block for the fixture before the pane loads client.js.
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  let swapped = false;
  await context.route("**/dist/client.js", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/const adapt = \{[\s\S]*?\n\};\n/, () => { swapped = true; return FIXTURE; });
    await route.fulfill({ response, body });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await page.goto(h.harnessUrl(server.url, { panes: 1, names: ["Alice"] }));
    await page.waitForFunction(() => window.harness?.ready === true, null, { timeout: 30_000 });
    const [id] = await page.evaluate(() => window.harness.panes());
    const A = h.pane(page, id);
    await h.waitLive(A);
    assert.ok(swapped, "the fixture replaced the adapt block");
    const inFrame = (fn) => A.locator("body").evaluate(fn);

    // onReady: once, with the documented handle.
    assert.equal(await inFrame(() => window.__adaptReady), 1);
    assert.deepEqual(await inFrame(() => window.__adaptVerbs), [
      "addObjects", "addStickies", "arrangeGrid", "connectObjects", "deleteObjects", "findObjects", "getBoard",
      "getSelection", "getViewport", "moveObjects", "onChange", "setSelection", "showObjects", "toast", "updateObjects",
    ]);

    // styles apply after the built-in ones; minimap: false hides the minimap.
    assert.equal(await A.locator(".wb-topbar").evaluate((el) => getComputedStyle(el).outlineColor), "rgb(255, 0, 0)");
    assert.equal(await A.locator(h.SEL.minimap).isVisible(), false);

    // The action is first in the board menu and runs from the keyboard.
    await A.locator(h.SEL.boardMenu).focus();
    await page.keyboard.press("Enter");
    const first = A.locator(".menu [role=menuitem]").first();
    assert.equal(await first.textContent(), "Add a test row");
    assert.equal(await first.getAttribute("title"), "Adds three sticky notes");
    assert.equal(await A.getByRole("menuitem", { name: "Broken action" }).count(), 1);
    assert.equal(await A.locator(".menu .adapt-action").count(), 2, "the invalid action is left out");
    await page.keyboard.press("Enter");
    await A.locator(h.SEL.toast).filter({ hasText: "Added 3 notes" }).waitFor();
    await h.until(async () => {
      const board = await page.evaluate(() => window.harness.getBoard());
      return Object.values(board.objects).filter((o) => o.type === "sticky").length === 3;
    }, { timeout: 5000, message: "three stickies reached the server" });
    const board = await page.evaluate(() => window.harness.getBoard());
    const notes = Object.values(board.objects).sort((a, b) => a.x - b.x);
    assert.deepEqual(notes.map((o) => o.text), ["A", "B", "C"]);
    assert.equal(new Set(notes.map((o) => o.y)).size, 1, "one row");
    assert.equal(notes[2].style.fill, "#c7f0b0", "a named colour");
    assert.deepEqual((await h.inPane(A, (_, canvas) => canvas.getSelection())).sort(), notes.map((o) => o.id).sort());

    // newObjectColors: a note from the Add menu is blue.
    await h.inPane(A, (_, canvas) => canvas.addAtCenter("sticky"));
    await page.keyboard.press("Escape");
    await h.until(async () => Object.values((await page.evaluate(() => window.harness.getBoard())).objects).length === 4, { timeout: 5000 });
    const added = Object.values((await page.evaluate(() => window.harness.getBoard())).objects).find((o) => !notes.some((n) => n.id === o.id));
    assert.equal(added.style.fill, "#b5d8ff");

    // The right-click menu on empty canvas lists the actions too.
    await h.inPane(A, (_, canvas) => canvas.setSelection([]));
    await A.locator(".wb-canvas").focus();
    await page.keyboard.press("Shift+F10");
    await A.getByRole("menuitem", { name: "Add a test row" }).waitFor();
    await page.keyboard.press("Escape");

    // A failing action is reported and the board keeps working.
    await A.locator(h.SEL.boardMenu).click();
    await A.getByRole("menuitem", { name: "Broken action" }).click();
    await A.locator(h.SEL.toast).filter({ hasText: "Broken action failed: nope" }).waitFor();
    await h.waitLive(A);
    assert.equal(await inFrame(() => window.__adaptReady), 1, "onReady ran once");
    assert.deepEqual(errors.filter((e) => !/favicon|\[whiteboard adapt\] Broken action failed/.test(e)), []);
  } finally {
    await context.close();
  }
});
