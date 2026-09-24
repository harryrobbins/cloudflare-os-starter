// Design panel e2e (node --test): rules, filter / showcase / focus, views, types and fields,
// driven through the real DOM of the Design tab in the harness.
//
//   node --test e2e/design.test.mjs

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startHarness, settled, problems } from "./helpers.mjs";

const SECTOR = "f_000000000001";
const T = { actor: "t_000000000001", outcome: "t_000000000003" };
const E = { localFarms: "e_000000000001", schoolKitchens: "e_000000000003", cityCouncil: "e_000000000005" };

/** @type {Awaited<ReturnType<typeof startHarness>>} */
let h;
before(async () => { h = await startHarness({ port: 8821, dist: "dist-design" }); });
after(async () => { await h?.close(); });

/** Opens a fresh map with the Design tab showing. @param {number} [panes] */
async function openDesign(panes = 1) {
  // Wide enough that each pane shows the panel beside the canvas (narrow panes use sheets).
  const { page, frames } = await h.open({ panes, viewport: { width: 1400 * panes, height: 900 } });
  for (const f of frames) await f.evaluate(() => globalThis.networkMap.app.setPanel("design"));
  await frames[0].waitForSelector(".nm-design");
  return { page, frames, frame: frames[0] };
}

/** Evaluates in the pane until `fn` returns truthy. @param {any} frame @param {Function} fn @param {any} [arg] */
async function waitFor(frame, fn, arg) {
  await frame.waitForFunction(fn, arg, { timeout: 10000 });
}

/** @param {any} frame @param {string} key */
async function openSection(frame, key) {
  const open = await frame.$eval(`details[data-section="${key}"]`, (d) => d.open);
  if (!open) await frame.click(`details[data-section="${key}"] > summary`);
}

/** @param {any} page */
async function assertClean(page) {
  const p = await problems(page);
  assert.deepEqual(p.violations, [], "no CSP violations");
  assert.deepEqual(p.errors, [], "no page errors");
}

/** The current view's rules. @param {any} frame */
const rules = (frame) => frame.evaluate(() => globalThis.networkMap.app.view.rules);
/** @param {any} frame @param {string} id */
const colorOf = (frame, id) => frame.evaluate((i) => globalThis.networkMap.app.model.decor.elements.get(i).color, id);

/**
 * Adds "elements where Sector = Public -> colour #e15759" through the rule editor.
 * @param {any} frame
 */
async function addPublicRedRule(frame) {
  await frame.click('[data-section="rules"] button:has-text("Add rule")');
  const editor = frame.locator(".nm-rule-editor");
  await editor.waitFor();
  await editor.locator('button:has-text("Condition")').click();
  await editor.locator('[aria-label="Condition 1 subject"]').selectOption(`field:${SECTOR}`);
  await editor.locator('[aria-label="Condition 1 operator"]').selectOption("eq");
  await editor.locator('[aria-label="Condition 1 value"]').selectOption("Public");
  await editor.locator('select[aria-label="Colour"]').selectOption("fixed");
  await editor.locator('[aria-label="Red #e15759"]').click();
  await editor.locator(".preview:has-text('Matches 4 elements')").waitFor();
  await editor.locator('[data-action="save-rule"]').click();
  await editor.waitFor({ state: "detached" });
}

describe("design panel", () => {
  it("adds, toggles, reorders and deletes rules", async () => {
    const { page, frame } = await openDesign();
    await addPublicRedRule(frame);
    await waitFor(frame, (id) => globalThis.networkMap.app.model.decor.elements.get(id).color === "#e15759", E.schoolKitchens);
    assert.equal(await colorOf(frame, E.cityCouncil), "#e15759");
    assert.equal(await colorOf(frame, E.localFarms), "#4e79a7", "a private actor keeps its type colour");
    const [rule] = await rules(frame);
    assert.deepEqual(rule, { selector: { target: "element", match: "all", where: [{ subject: { k: "field", id: SECTOR }, op: "eq", value: "Public" }] }, set: { color: { value: "#e15759" } } });
    assert.match(await frame.locator(".nm-rule").first().innerText(), /Sector = Public/);

    // Off and on again.
    await frame.click('[aria-label="Rule 1 on"]');
    await waitFor(frame, (id) => globalThis.networkMap.app.model.decor.elements.get(id).color === "#4e79a7", E.schoolKitchens);
    assert.equal((await rules(frame))[0].off, true);
    await frame.click('[aria-label="Rule 1 on"]');
    await waitFor(frame, (id) => globalThis.networkMap.app.model.decor.elements.get(id).color === "#e15759", E.schoolKitchens);

    // A second rule, then reorder: the later rule wins.
    await frame.click('[data-section="rules"] button:has-text("Add rule")');
    const editor = frame.locator(".nm-rule-editor");
    await editor.locator('select[aria-label="Colour"]').selectOption("fixed");
    await editor.locator('[aria-label="Green #59a14f"]').click();
    await editor.locator('select[aria-label="Shape"]').selectOption("square");
    await editor.locator('#nm-rule-name').first().fill("Everything green");
    await editor.locator('[data-action="save-rule"]').click();
    await waitFor(frame, (id) => globalThis.networkMap.app.model.decor.elements.get(id).color === "#59a14f", E.schoolKitchens);
    assert.equal(await frame.evaluate((id) => globalThis.networkMap.app.model.decor.elements.get(id).shape, E.localFarms), "square");
    await frame.click('[aria-label="Move rule 2 up"]');
    await waitFor(frame, () => globalThis.networkMap.app.view.rules[0].name === "Everything green");
    await waitFor(frame, (id) => globalThis.networkMap.app.model.decor.elements.get(id).color === "#e15759", E.schoolKitchens);
    assert.equal(await frame.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Move rule 1 down", "focus follows the moved rule");

    // Edit rule 2 (the Public rule) and check the editor reopens with its values.
    await frame.click('[aria-label="Edit rule 2"]');
    assert.equal(await editor.locator('[aria-label="Condition 1 value"]').inputValue(), "Public");
    assert.equal(await editor.locator('[aria-label="Rule colour (hex)"]').inputValue(), "#e15759");
    await editor.locator('select[aria-label="Visibility"]').selectOption("hide");
    await editor.locator('[data-action="save-rule"]').click();
    await waitFor(frame, () => globalThis.networkMap.app.model.nodes.size === 12);

    // Delete both.
    await frame.click('[aria-label="Delete rule 1"]');
    await waitFor(frame, () => globalThis.networkMap.app.view.rules.length === 1);
    assert.equal((await rules(frame))[0].set.hidden, true);
    await frame.click('[aria-label="Delete rule 1"]');
    await waitFor(frame, () => globalThis.networkMap.app.view.rules.length === 0 && globalThis.networkMap.app.model.nodes.size === 16);
    await settled(frame);
    await assertClean(page);
  });

  it("shows validation errors from the rule editor", async () => {
    const { page, frame } = await openDesign();
    await frame.click('[data-section="rules"] button:has-text("Add rule")');
    const editor = frame.locator(".nm-rule-editor");
    await editor.locator('[data-action="save-rule"]').click();
    await editor.locator('[role="alert"]:has-text("at least one thing")').waitFor();
    await editor.locator('button:has-text("Condition")').click();
    await editor.locator('[aria-label="Condition 1 subject"]').selectOption("metric:degree");
    await editor.locator('[aria-label="Condition 1 value"]').fill("");
    await editor.locator('select[aria-label="Size"]').selectOption("fixed");
    await editor.locator('[aria-label="Size value"]').fill("500");
    await editor.locator('[role="alert"]:has-text("Condition 1: Connections needs a value")').waitFor();
    await editor.locator('[aria-label="Condition 1 value"]').fill("3");
    await editor.locator('[role="alert"]:has-text("Size must be a number from 1 to 100")').waitFor();
    await editor.locator('[aria-label="Size value"]').fill("20");
    await editor.locator('[data-action="save-rule"]').click();
    await editor.waitFor({ state: "detached" });
    await waitFor(frame, (id) => globalThis.networkMap.app.model.decor.elements.get(id).size === 20, E.localFarms);
    assert.equal(await frame.evaluate(() => globalThis.networkMap.app.model.decor.elements.get("e_000000000009").size), 8, "a weakly connected element keeps its size");
    await assertClean(page);
  });

  it("filters, showcases and focuses", async () => {
    const { page, frame } = await openDesign();
    await openSection(frame, "filter");
    assert.equal(await frame.evaluate(() => globalThis.networkMap.app.model.nodes.size), 16);
    const filter = frame.locator('[data-editor="filter"]');
    await filter.locator('button:has-text("Condition")').click();
    await filter.locator('[aria-label="Filter condition 1 subject"]').selectOption("type");
    await filter.locator('[aria-label="Filter condition 1 operator"]').selectOption("ne");
    await filter.locator('[aria-label="Filter condition 1 value"]').selectOption(T.outcome);
    await filter.locator('button:has-text("Apply")').click();
    await waitFor(frame, () => globalThis.networkMap.app.model.nodes.size === 10);
    await filter.locator('[role="status"]:has-text("Matches 10 of 16 elements")').waitFor();
    await filter.locator('button:has-text("Clear")').click();
    await waitFor(frame, () => globalThis.networkMap.app.model.nodes.size === 16 && !globalThis.networkMap.app.view.filter);

    const showcase = frame.locator('[data-editor="showcase"]');
    await showcase.locator('button:has-text("Condition")').click();
    await showcase.locator('[aria-label="Showcase condition 1 subject"]').selectOption("type");
    await showcase.locator('[aria-label="Showcase condition 1 value"]').selectOption(T.actor);
    await showcase.locator('button:has-text("Apply")').click();
    await waitFor(frame, () => globalThis.networkMap.app.view.showcase);
    const [actor, farmland] = await frame.evaluate(() => ["e_000000000001", "e_000000000007"].map((id) => globalThis.networkMap.app.model.decor.elements.get(id).opacity));
    assert.equal(actor, 1);
    assert.ok(farmland < 0.5, "a non-matching element dims");
    await showcase.locator('button:has-text("Clear")').click();
    await waitFor(frame, () => !globalThis.networkMap.app.view.showcase);

    // Focus on Local farms, one step: itself and its six neighbours.
    const focus = frame.locator('[data-editor="focus"]');
    assert.equal(await focus.locator('button:has-text("Use selection as roots")').getAttribute("aria-disabled"), "true");
    await frame.evaluate((id) => globalThis.networkMap.app.select([id]), E.localFarms);
    assert.equal(await focus.locator('button:has-text("Use selection as roots")').getAttribute("aria-disabled"), "false");
    await focus.locator('button:has-text("Use selection as roots")').click();
    await waitFor(frame, () => globalThis.networkMap.app.model.nodes.size === 7);
    assert.deepEqual(await frame.evaluate(() => globalThis.networkMap.app.view.focus), { roots: [E.localFarms], depth: 1, direction: "both" });
    await frame.locator('[data-editor="focus"] [aria-label="Focus depth"]').selectOption("2");
    await waitFor(frame, () => globalThis.networkMap.app.view.focus?.depth === 2 && globalThis.networkMap.app.model.nodes.size > 7);
    await frame.locator('[data-editor="focus"] .chip:has-text("Local farms")').waitFor();
    await frame.locator('[data-editor="focus"] button:has-text("Clear focus")').click();
    await waitFor(frame, () => !globalThis.networkMap.app.view.focus && globalThis.networkMap.app.model.nodes.size === 16);
    await settled(frame);
    await assertClean(page);
  });

  it("duplicates a view, makes it the default and gives it its own layout", async () => {
    const { page, frame } = await openDesign();
    const first = await frame.evaluate(() => globalThis.networkMap.app.viewId);
    assert.equal(await frame.locator('[data-section="view"] button:has-text("Delete")').getAttribute("aria-disabled"), "true", "the default view cannot be deleted");
    await frame.click('[data-section="view"] button:has-text("Duplicate")');
    await waitFor(frame, (v) => globalThis.networkMap.app.viewId !== v && globalThis.networkMap.app.view?.name === "By type copy", first);
    const copy = await frame.evaluate(() => globalThis.networkMap.app.viewId);

    await frame.fill("#nm-view-name", "Working view");
    await frame.press("#nm-view-name", "Enter");
    await waitFor(frame, () => globalThis.networkMap.app.view.name === "Working view");

    await frame.click('[data-section="view"] button:has-text("Make default")');
    await waitFor(frame, (id) => globalThis.networkMap.store.meta.defaultViewId === id, copy);
    await frame.locator('[data-section="view"] .chip:has-text("Default view")').waitFor();

    await frame.check('[data-section="view"] input[data-fkey="view-own"]');
    await waitFor(frame, (id) => globalThis.networkMap.store.positions.get(id)?.size === 16 && globalThis.networkMap.app.view.layout.own === true, copy);
    await settled(frame);
    const { same, layout } = await frame.evaluate((id) => {
      const { store, app } = globalThis.networkMap;
      const own = store.positions.get(id), shared = store.positions.get("shared");
      return { same: [...own].every(([e, p]) => shared.get(e)?.x === p.x && shared.get(e)?.y === p.y), layout: app.layoutKey };
    }, copy);
    assert.ok(same, "the own layout starts from the shared positions");
    assert.equal(layout, copy);

    await frame.locator('[aria-label="Preferred layout"]').selectOption("circle");
    await waitFor(frame, () => globalThis.networkMap.app.view.layout.kind === "circle" && globalThis.networkMap.app.view.layout.own === true);

    // Back to the first view, make it the default again, then delete the copy.
    await frame.evaluate((id) => globalThis.networkMap.app.setView(id), first);
    await frame.click('[data-section="view"] button:has-text("Make default")');
    await waitFor(frame, (id) => globalThis.networkMap.store.meta.defaultViewId === id, first);
    await frame.evaluate((id) => globalThis.networkMap.app.setView(id), copy);
    await frame.click('[data-section="view"] button:has-text("Delete")');
    await frame.click('.modal button:has-text("Delete view")');
    await waitFor(frame, (id) => !globalThis.networkMap.store.objects.has(id) && globalThis.networkMap.app.view.id !== id, copy);
    await settled(frame);
    await assertClean(page);
  });

  it("adds, renames and deletes a type; a used type cannot be deleted", async () => {
    const { page, frame } = await openDesign();
    await openSection(frame, "types");
    const actorDelete = frame.locator('[aria-label="Delete the type Actor"]');
    assert.equal(await actorDelete.getAttribute("aria-disabled"), "true");
    assert.match(await actorDelete.getAttribute("title"), /Used by 6 items/);
    await actorDelete.click({ force: true });
    await frame.locator('.toast:has-text("Change their type first")').waitFor();
    await frame.fill('[aria-label="New element type name"]', "Stakeholder");
    await frame.press('[aria-label="New element type name"]', "Enter");
    await waitFor(frame, () => [...globalThis.networkMap.store.objects.values()].some((o) => o.id[0] === "t" && o.name === "Stakeholder"));
    const id = await frame.evaluate(() => [...globalThis.networkMap.store.objects.values()].find((o) => o.name === "Stakeholder").id);
    assert.equal(await frame.evaluate((i) => globalThis.networkMap.store.objects.get(i).appliesTo, id), "element");
    assert.equal(await frame.evaluate((i) => globalThis.networkMap.store.objects.has(i), T.actor), true, "Actor is still there");

    await frame.click(`[data-fkey="type-${id}-name"]`);
    await frame.fill(`li[data-type-id="${id}"] input`, "Partner");
    await frame.press(`li[data-type-id="${id}"] input`, "Enter");
    await waitFor(frame, (i) => globalThis.networkMap.store.objects.get(i)?.name === "Partner", id);

    await frame.locator(`li[data-type-id="${id}"] [aria-label="Shape of Partner"]`).selectOption("hexagon");
    await waitFor(frame, (i) => globalThis.networkMap.store.objects.get(i)?.shape === "hexagon", id);

    await frame.click(`[data-fkey="type-${id}-color"]`);
    await frame.click('.modal [aria-label="Pink #ff9da7"]');
    await frame.click('.modal button:has-text("Save")');
    await waitFor(frame, (i) => globalThis.networkMap.store.objects.get(i)?.color === "#ff9da7", id);

    assert.equal(await frame.locator('[aria-label="Delete the type Partner"]').getAttribute("aria-disabled"), null);
    await frame.click('[aria-label="Delete the type Partner"]');
    await waitFor(frame, (i) => !globalThis.networkMap.store.objects.has(i), id);
    await settled(frame);
    await assertClean(page);
  });

  it("adds a choice field, guards its used choices and uses it in a rule", async () => {
    const { page, frame } = await openDesign();
    await openSection(frame, "fields");
    await frame.fill('[aria-label="New field name"]', "Stage");
    await frame.locator('[aria-label="New field kind"]').selectOption("choice");
    await frame.fill('[aria-label="New field choices, separated by commas"]', "Early, Late, Mature");
    await frame.click('button:has-text("Add field")');
    await waitFor(frame, () => [...globalThis.networkMap.store.objects.values()].some((o) => o.id[0] === "f" && o.name === "Stage"));
    const field = await frame.evaluate(() => [...globalThis.networkMap.store.objects.values()].find((o) => o.name === "Stage"));
    assert.deepEqual(field.choices, ["Early", "Late", "Mature"]);
    await frame.evaluate(({ e, f }) => globalThis.networkMap.app.apply([{ op: "update", id: e, patch: { fields: { [f]: "Early" } } }]), { e: E.localFarms, f: field.id });
    await settled(frame);

    // A used choice cannot be removed; an unused one can.
    await frame.click('[aria-label="Remove the choice Early"]');
    await frame.locator('.toast:has-text("is used by 1 item")').waitFor();
    await frame.click('[aria-label="Remove the choice Mature"]');
    await waitFor(frame, (id) => globalThis.networkMap.store.objects.get(id).choices.join() === "Early,Late", field.id);
    await frame.fill('[aria-label="New choice for Stage"]', "Scaling");
    await frame.press('[aria-label="New choice for Stage"]', "Enter");
    await waitFor(frame, (id) => globalThis.networkMap.store.objects.get(id).choices.join() === "Early,Late,Scaling", field.id);
    assert.equal(await frame.evaluate(() => document.activeElement?.getAttribute("aria-label")), "New choice for Stage", "focus stays in the choice input");

    // Kind is locked while values exist.
    assert.equal(await frame.locator('[aria-label="Kind of Stage"]').isDisabled(), true);

    // Use it in a rule.
    await frame.click('[data-section="rules"] button:has-text("Add rule")');
    const editor = frame.locator(".nm-rule-editor");
    await editor.locator('button:has-text("Condition")').click();
    await editor.locator('[aria-label="Condition 1 subject"]').selectOption(`field:${field.id}`);
    assert.deepEqual(await editor.locator('[aria-label="Condition 1 value"] option').allTextContents(), ["Early", "Late", "Scaling"]);
    await editor.locator('[aria-label="Condition 1 value"]').selectOption("Early");
    await editor.locator('select[aria-label="Label"]').selectOption(`field:${field.id}`);
    await editor.locator('select[aria-label="Shape"]').selectOption("triangle");
    await editor.locator(".preview:has-text('Matches 1 element')").waitFor();
    await editor.locator('[data-action="save-rule"]').click();
    await waitFor(frame, (id) => {
      const d = globalThis.networkMap.app.model.decor.elements.get(id);
      return d.shape === "triangle" && d.label === "Early";
    }, E.localFarms);
    await frame.locator('.nm-rule:has-text("Stage = Early")').waitFor();

    // Delete the field (confirmed): its values stay stored.
    await frame.click('[aria-label="Delete the field Stage"]');
    await frame.locator('.modal:has-text("values stay stored but are hidden")').waitFor();
    await frame.click('.modal button:has-text("Delete field")');
    await waitFor(frame, (id) => !globalThis.networkMap.store.objects.has(id), field.id);
    await settled(frame);
    await assertClean(page);
  });

  it("syncs a rule added in one pane to another", async () => {
    const { page, frames } = await openDesign(2);
    await addPublicRedRule(frames[0]);
    await waitFor(frames[1], () => globalThis.networkMap.app.view.rules.length === 1);
    await waitFor(frames[1], (id) => globalThis.networkMap.app.model.decor.elements.get(id).color === "#e15759", E.schoolKitchens);
    await frames[1].locator('.nm-rule:has-text("Sector = Public")').waitFor();
    await assertClean(page);
  });
});
