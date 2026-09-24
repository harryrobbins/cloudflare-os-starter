// Profile panel and list mode against the real app in the harness. Selection goes through
// app.select (canvas clicks on WebGL are flaky in headless Chromium); everything else uses the
// panel's and the list's own DOM, mouse and keyboard.
//
//   node --test e2e/profile.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness, problems, settled, until } from "./helpers.mjs";

const E = (n) => `e_${n.toString(16).padStart(12, "0")}`;
const C = (n) => `c_${n.toString(16).padStart(12, "0")}`;
const FARMS = E(1), MARKET = E(2), COUNCIL = E(5), VOLUNTEERS = E(9), INCOME = E(10), NUTRITION = E(12), AWARENESS = E(16);
const SECTOR = "f_000000000001";

/** @type {Awaited<ReturnType<typeof startHarness>>} */
let harness;
before(async () => { harness = await startHarness({ port: 8811, dist: "dist-profile" }); });
after(async () => { await harness?.close(); });

/** @param {any} frame @param {string[]} ids */
const select = (frame, ids) => frame.evaluate((list) => globalThis.networkMap.app.select(list), ids);
/** @param {any} frame @param {string} id */
const object = (frame, id) => frame.evaluate((i) => globalThis.networkMap.store.objects.get(i) ?? null, id);

/** @param {any} page */
async function assertClean(page) {
  const p = await problems(page);
  assert.deepEqual(p.violations, [], "no CSP violations");
  assert.deepEqual(p.errors, [], "no page errors");
}

test("element profile: rename, choice field, tag, connect to", async () => {
  const { page, frames: [f] } = await harness.open();
  await select(f, [FARMS]);
  const label = f.locator('.nmp [data-pk="label"]');
  assert.equal(await label.inputValue(), "Local farms");

  await label.fill("Local growers");
  await label.press("Enter");
  await until(f, (s) => s.objects.find((o) => o.id === FARMS)?.label === "Local growers");
  // The input keeps focus after the rebuild that the commit caused.
  assert.equal(await f.evaluate(() => document.activeElement?.dataset?.pk), "label");

  await f.selectOption(`.nmp [data-pk="field:${SECTOR}"]`, "Community");
  await until(f, (s) => s.objects.find((o) => o.id === FARMS)?.fields?.[SECTOR] === "Community");

  const tags = f.locator('.nmp [data-pk="tags"]');
  await tags.fill("organic, Local ,organic");
  await tags.press("Tab");
  await until(f, (s) => JSON.stringify(s.objects.find((o) => o.id === FARMS)?.tags) === '["organic","Local"]');

  const combo = f.locator('.nmp [data-pk="connect"]');
  await combo.fill("volunt");
  await f.waitForSelector('.nmp [role="listbox"] [role="option"][aria-selected="true"]');
  assert.equal(await combo.getAttribute("aria-expanded"), "true");
  await combo.press("Enter");
  const s = await until(f, (st) => st.objects.some((o) => o.id[0] === "c" && o.from === FARMS && o.to === VOLUNTEERS));
  assert.equal(s.objects.filter((o) => o.id[0] === "c" && o.from === FARMS && o.to === VOLUNTEERS).length, 1);
  await f.waitForSelector('.nmp-list button:has-text("Volunteers")');
  await settled(f);
  const server = await object(f, FARMS);
  assert.equal(server.label, "Local growers");
  await assertClean(page);
});

test("a new element's label is focused and selected; nothing selected shows map settings", async () => {
  const { page, frames: [f] } = await harness.open();
  // Enter on the canvas adds a connected element and asks the panel to edit its label.
  await select(f, [MARKET]);
  await f.evaluate(() => globalThis.networkMap.app.focusCanvas());
  await page.keyboard.press("Enter");
  await f.waitForFunction(() => document.activeElement?.dataset?.pk === "label" && document.activeElement.value === "New element");
  assert.equal(await f.evaluate(() => document.activeElement.selectionEnd - document.activeElement.selectionStart), "New element".length);
  await page.keyboard.type("Seed bank");
  await page.keyboard.press("Enter");
  const s = await until(f, (st) => st.objects.some((o) => o.id[0] === "e" && o.label === "Seed bank"));
  const added = s.objects.find((o) => o.label === "Seed bank");
  assert.ok(s.objects.some((o) => o.id[0] === "c" && o.from === MARKET && o.to === added.id));

  await select(f, []);
  const title = f.locator('.nmp [data-pk="map-title"]');
  assert.equal(await title.inputValue(), "Local food system (demo)");
  await title.fill("Food map");
  await title.press("Enter");
  await f.waitForFunction(() => globalThis.networkMap.store.meta.title === "Food map");
  assert.deepEqual(await f.locator(".nmp-count strong").allTextContents(), ["17", "23", "2"]);
  await assertClean(page);
});

test("connection profile: swap, polarity, strength; loop profile lists steps", async () => {
  const { page, frames: [f] } = await harness.open();
  const conn = C(18); // Local farms -- Cold storage, undirected, in no loop
  await select(f, [conn]);
  const before = await object(f, conn);
  await f.click('.nmp [data-pk="swap"]');
  await until(f, (s) => s.objects.find((o) => o.id === conn)?.from === before.to);
  await f.selectOption('.nmp [data-pk="polarity"]', "-");
  await until(f, (s) => s.objects.find((o) => o.id === conn)?.polarity === "-");
  const strength = f.locator('.nmp [data-pk="strength"]');
  await strength.fill("2.5");
  await strength.press("Enter");
  await until(f, (s) => s.objects.find((o) => o.id === conn)?.strength === 2.5);
  await f.click('.nmp [data-pk="end:From"]');
  await f.waitForFunction((id) => [...globalThis.networkMap.app.selection].join() === id, before.to);

  await select(f, ["l_000000000001"]);
  const steps = await f.locator(".nmp-steps li").allTextContents();
  assert.equal(steps.length, 3);
  assert.match(steps[0], /Local farms → Farmers market/);
  assert.match(await f.locator(".nmp-derived").textContent(), /reinforcing/);
  await assertClean(page);
});

test("create a loop from three selected connections of a new triangle", async () => {
  const { page, frames: [f] } = await harness.open();
  const ids = await f.evaluate(() => {
    const { app } = globalThis.networkMap;
    const [a, b, c] = [app.newId("element"), app.newId("element"), app.newId("element")];
    const [ab, bc, ca] = [app.newId("connection"), app.newId("connection"), app.newId("connection")];
    app.apply([
      { op: "create", object: { id: a, label: "Alpha" } }, { op: "create", object: { id: b, label: "Beta" } }, { op: "create", object: { id: c, label: "Gamma" } },
      { op: "create", object: { id: ab, from: a, to: b, direction: "directed", polarity: "+" } },
      { op: "create", object: { id: bc, from: b, to: c, direction: "directed", polarity: "-" } },
      { op: "create", object: { id: ca, from: a, to: c, direction: "undirected", polarity: "+" } },
    ]);
    return { a, b, c, ab, bc, ca };
  });
  await settled(f);

  // Two connections do not close: the panel says why.
  await select(f, [ids.ab, ids.bc]);
  await f.click('.nmp [data-pk="make-loop"]');
  await f.waitForSelector(".nmp-problem:not([hidden])");
  assert.match(await f.locator(".nmp-problem").textContent(), /closed loop/);

  // Shuffled order; the undirected one must be walked backwards (Gamma -> Alpha).
  await select(f, [ids.ca, ids.bc, ids.ab]);
  await f.click('.nmp [data-pk="make-loop"]');
  const name = f.locator('.modal input[type="text"]');
  await name.waitFor();
  assert.match(await f.locator(".modal select").textContent(), /Automatic: balancing/);
  await name.fill("Triangle");
  await name.press("Enter");
  const s = await until(f, (st) => st.objects.some((o) => o.id[0] === "l" && o.label === "Triangle" && o.version > 0));
  const loop = s.objects.find((o) => o.id[0] === "l" && o.label === "Triangle");
  assert.equal(loop.steps.length, 3);
  assert.equal(loop.classification, "B");
  assert.deepEqual(loop.steps.find((st) => st.c === ids.ca), { c: ids.ca, fwd: false });
  // The new loop is selected and shown.
  await f.waitForFunction(() => document.querySelector('.nmp [data-pk="classification"]')?.value === "B");
  await settled(f);
  assert.ok(await object(f, loop.id));
  await assertClean(page);
});

test("merge two elements: connections re-pointed, loop kept, loser deleted", async () => {
  const { page, frames: [f] } = await harness.open();
  const touching = await f.evaluate((id) => [...globalThis.networkMap.store.objects.values()].filter((o) => o.id[0] === "c" && (o.from === id || o.to === id)).map((o) => o.id), INCOME);
  assert.equal(touching.length, 3);
  await select(f, [INCOME, FARMS]);
  await f.click('.nmp [data-pk="merge"]');
  await f.waitForSelector('.modal[aria-label="Merge elements"]');
  await f.check(`.modal input[type="radio"][value="${FARMS}"]`);
  const text = await f.locator(".modal").textContent();
  assert.match(text, /Connections moved to “Local farms” \(3\)/);
  assert.match(text, /becomes a self-link/);
  assert.match(text, /Market growth/);
  await f.click('.modal button:text-is("Merge")');
  await until(f, (s) => !s.objects.some((o) => o.id === INCOME));
  await settled(f);
  const s = await until(f, (st) => st.pending === 0);
  const byId = new Map(s.objects.map((o) => [o.id, o]));
  for (const cid of touching) {
    const c = byId.get(cid);
    assert.ok(c, `connection ${cid} kept`);
    assert.ok(c.from === FARMS || c.to === FARMS, `connection ${cid} re-pointed`);
    assert.ok(c.from !== INCOME && c.to !== INCOME);
  }
  assert.ok(byId.get(FARMS).aliases.includes("Farm income"));
  const loop = byId.get("l_000000000001");
  assert.equal(loop?.label, "Market growth", "the loop keeps its id");
  assert.equal(loop.steps.length, 3);
  assert.deepEqual(s.selection, [FARMS]);
  // One history entry: one undo restores everything.
  await f.evaluate(() => globalThis.networkMap.store.undo());
  await until(f, (st) => st.objects.some((o) => o.id === INCOME) && st.objects.some((o) => o.id === "l_000000000001"));
  await assertClean(page);
});

test("bulk edit: set type and add a tag to several elements", async () => {
  const { page, frames: [f] } = await harness.open();
  await select(f, [VOLUNTEERS, NUTRITION, AWARENESS]);
  await f.selectOption('.nmp [data-pk="bulk-type"]', "t_000000000001");
  await f.click('.nmp [data-pk="bulk-type-apply"]');
  await f.fill('.nmp [data-pk="bulk-tag"]', "review");
  await f.press('.nmp [data-pk="bulk-tag"]', "Enter");
  const s = await until(f, (st) => [VOLUNTEERS, NUTRITION, AWARENESS].every((id) => {
    const o = st.objects.find((x) => x.id === id);
    return o.typeId === "t_000000000001" && o.tags?.includes("review");
  }));
  assert.equal(s.selection.length, 3);
  await assertClean(page);
});

test("list mode: 16 demo elements, sorting, keyboard, inline rename, selection sync", async () => {
  const { page, frames: [f] } = await harness.open();
  await f.click('.nm-topbar button:text-is("List")');
  const grid = f.locator('.nml [role="grid"]');
  await grid.waitFor();
  assert.equal(await grid.getAttribute("aria-rowcount"), "17");
  assert.equal(await f.locator(".nml-body .nml-row").count(), 16);
  const firstLabel = () => f.locator(".nml-body .nml-row").first().locator('[role="gridcell"]').first().textContent();
  assert.equal(await firstLabel(), "Child nutrition");

  // Sort by degree, both ways.
  const degreeHeader = f.locator('.nml-head [role="columnheader"]', { hasText: "Connections" });
  await degreeHeader.locator("button").click();
  assert.equal(await degreeHeader.getAttribute("aria-sort"), "ascending");
  await degreeHeader.locator("button").click();
  assert.equal(await degreeHeader.getAttribute("aria-sort"), "descending");
  assert.equal(await firstLabel(), "Local farms");
  await f.locator('.nml-head [role="columnheader"]', { hasText: "Label" }).locator("button").click();
  assert.equal(await firstLabel(), "Child nutrition");

  // Keyboard: Home selects the first row, Down the next; Enter opens it in the Profile panel.
  await grid.focus();
  await page.keyboard.press("Home");
  await f.waitForFunction((id) => [...globalThis.networkMap.app.selection].join() === id, NUTRITION);
  await page.keyboard.press("ArrowDown");
  await f.waitForFunction((id) => [...globalThis.networkMap.app.selection].join() === id, COUNCIL);
  assert.equal(await grid.getAttribute("aria-activedescendant"), `nml-row-${COUNCIL}`);
  await page.keyboard.press("Enter");
  assert.equal(await f.evaluate(() => globalThis.networkMap.app.panel), "profile");
  assert.equal(await f.locator('.nmp [data-pk="label"]').inputValue(), "City council");

  // F2 renames in place; Escape cancels, Enter saves; focus returns to the grid.
  await grid.focus();
  await page.keyboard.press("F2");
  const edit = f.locator(".nml-edit");
  await edit.waitFor();
  await edit.fill("Nope");
  await page.keyboard.press("Escape");
  assert.equal((await object(f, COUNCIL)).label, "City council");
  assert.equal(await f.evaluate(() => document.activeElement?.getAttribute("role")), "grid");
  await page.keyboard.press("F2");
  await edit.fill("Town council");
  await page.keyboard.press("Enter");
  await until(f, (s) => s.objects.find((o) => o.id === COUNCIL)?.label === "Town council");
  await f.waitForSelector(`#nml-row-${COUNCIL} :text("Town council")`);

  // Double-click also renames.
  await f.dblclick(`#nml-row-${MARKET} [role="gridcell"] >> nth=0`);
  await edit.fill("Market square");
  await edit.press("Enter");
  await until(f, (s) => s.objects.find((o) => o.id === MARKET)?.label === "Market square");

  // Filter, and selection from elsewhere marks and reveals the row.
  await f.fill('.nml input[type="search"]', "farm");
  await f.waitForFunction(() => document.querySelectorAll(".nml-body .nml-row").length === 3);
  await f.fill('.nml input[type="search"]', "");
  await f.waitForFunction(() => document.querySelectorAll(".nml-body .nml-row").length === 16);
  await select(f, [AWARENESS]);
  assert.equal(await f.getAttribute(`#nml-row-${AWARENESS}`, "aria-selected"), "true");
  assert.equal(await grid.getAttribute("aria-activedescendant"), `nml-row-${AWARENESS}`);

  // Connections and loops tabs.
  await f.click('.nml [role="tab"]:text-is("Connections")');
  assert.equal(await grid.getAttribute("aria-rowcount"), "23");
  await f.click('.nml [role="tab"]:text-is("Loops")');
  assert.equal(await f.locator(".nml-body .nml-row").count(), 2);

  // Delete from the keyboard.
  await f.click('.nml [role="tab"]:text-is("Elements")');
  await select(f, [VOLUNTEERS]);
  await grid.focus();
  await page.keyboard.press("Delete");
  await until(f, (s) => !s.objects.some((o) => o.id === VOLUNTEERS));
  assert.equal(await grid.getAttribute("aria-rowcount"), "16");
  await assertClean(page);
});

test("list mode windows 10,000 elements", async () => {
  const { page, frames: [f] } = await harness.open({ blank: true });
  await f.evaluate(() => {
    const { app } = globalThis.networkMap;
    for (let i = 0; i < 10; i++) {
      const ops = [];
      for (let j = 0; j < 1000; j++) ops.push({ op: "create", object: { id: app.newId("element"), label: `Item ${i * 1000 + j}` } });
      app.apply(ops);
    }
  });
  await settled(f);
  await f.evaluate(() => globalThis.networkMap.app.setMode("list"));
  const grid = f.locator('.nml [role="grid"]');
  await f.waitForFunction(() => document.querySelector('.nml [role="grid"]')?.getAttribute("aria-rowcount") === "10001", null, { timeout: 20000 });
  const rendered = await f.locator(".nml-body .nml-row").count();
  assert.ok(rendered > 10 && rendered < 120, `rendered ${rendered} rows`);
  await grid.focus();
  await page.keyboard.press("End");
  await f.waitForSelector('.nml-body .nml-row[aria-selected="true"] :text("Item 9999")');
  assert.ok((await f.locator(".nml-body .nml-row").count()) < 120);
  await assertClean(page);
});
