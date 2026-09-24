// Harness e2e for the Data and Activity panels (node --test): paste imports through reviewed
// changesets, re-import by source name, undo of an import with a later edit kept, Kumu JSON,
// per-entry undo in Activity, and import progress in a second pane.
//
//   node --test e2e/data.test.mjs
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { problems, settled, startHarness, until } from "./helpers.mjs";

let h;
before(async () => { h = await startHarness({ port: 8831, dist: "dist-data" }); });
after(async () => { await h?.close(); });

const ELEMENTS = [
  ["Label", "Type", "Tags", "Budget", "Status", "Description"],
  ["Food bank", "Actor", "food|charity", "1200", "Active", "A second food bank"],
  ["Seed library", "Charity", "seeds", "300", "Active", ""],
  ["Compost hub", "Charity", "waste|soil", "450", "Planned", ""],
  ["Tool share", "Charity", "", "80", "Planned", ""],
].map((r) => r.join("\t")).join("\n");

const CONNECTIONS = [
  ["From", "To", "Type", "Strength"],
  ["Seed library", "Compost hub", "Supports", "2"],
  ["Compost hub", "Food bank", "Supports", "1"],
  ["Tool share", "Seed library", "Partners", ""],
].map((r) => r.join("\t")).join("\n");

const KUMU_JSON = JSON.stringify({
  elements: [
    { label: "River trust", type: "Charity", tags: ["water"], Budget: 50 },
    { label: "Mill", type: "Actor" },
  ],
  connections: [{ from: "River trust", to: "Mill", type: "Supports" }],
});

/** Everything the store holds, plus helpers resolved in the page. @param {any} frame */
const mapOf = (frame) => frame.evaluate(() => {
  const objects = [...globalThis.networkMap.store.objects.values()];
  return { objects, fields: objects.filter((o) => o.id[0] === "f"), types: objects.filter((o) => o.id[0] === "t") };
});

/** @param {any} frame */
const openTab = async (frame, name) => {
  await frame.click(`#nm-tab-${name}`);
  await frame.waitForSelector(name === "data" ? ".nm-data" : ".nm-activity");
};

/** Fills the Kumu sheet inputs and the source name, then previews. @param {any} frame */
async function pasteSheets(frame, elements, connections, source) {
  await frame.check('.nm-data input[type="radio"][value="kumu-sheets"]');
  await frame.fill('textarea[id^="nm-data-elements-"]', elements);
  await frame.fill('textarea[id^="nm-data-connections-"]', connections);
  await frame.fill('input[id^="nm-data-source-"]', source);
  await frame.click('.nm-data button:text-is("Preview")');
  await frame.waitForSelector(".nm-data .preview .summary");
}

/** Stages the previewed plan and waits for the review. @param {any} frame */
async function continueToReview(frame) {
  await frame.click('.nm-data button:text-is("Continue to review")');
  await frame.waitForSelector('.nm-data .review [data-key="accept"]:not([disabled])', { timeout: 15000 });
}

/** Accepts and waits for the outcome. @param {any} frame */
async function accept(frame, expectedLabel) {
  const btn = frame.locator('.nm-data [data-key="accept"]');
  if (expectedLabel) await frame.waitForFunction((t) => document.querySelector('.nm-data [data-key="accept"]')?.textContent === t, expectedLabel, { timeout: 5000 });
  await btn.click();
  await frame.waitForSelector('.nm-data [data-outcome]', { timeout: 20000 });
  return frame.getAttribute('.nm-data [data-outcome]', "data-outcome");
}

/** @param {any} frame */
const newestChangeset = (frame) => frame.evaluate(() => [...globalThis.networkMap.store.changesets.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0]);

describe("imports", () => {
  it("previews, reviews, imports, re-imports by source name and shows progress in another pane", async () => {
    const { page, frames } = await h.open({ panes: 2, viewport: { width: 2600, height: 1000 } });
    const [one, two] = frames;
    await openTab(one, "data");
    await openTab(two, "data");

    await pasteSheets(two, ELEMENTS, CONNECTIONS, "Allotments");
    const summary = await two.textContent(".nm-data .preview .summary");
    assert.equal(summary, "4 elements · 3 connections · 4 types · 2 fields");
    assert.equal(await two.textContent('.nm-data .field-list li[data-field="Budget"] .kind'), "number");
    assert.equal(await two.textContent('.nm-data .field-list li[data-field="Status"] .kind'), "choice");
    assert.match(await two.textContent(".nm-data .preview"), /Tab \(pasted from a spreadsheet\)/);

    await continueToReview(two);
    // "Food bank" matches the demo element by label: suggested as "use existing".
    const foodBank = two.locator('select[aria-label="Action for Food bank · Actor"]');
    assert.match(await foodBank.inputValue(), /^use-existing:e_/);
    await foodBank.selectOption("create");
    await two.waitForFunction(() => document.querySelector('select[aria-label="Action for Food bank · Actor"]')?.value === "create");
    // Pane 1 records the statuses it is sent while pane 2 imports.
    await one.evaluate(() => {
      const { store } = globalThis.networkMap;
      globalThis.seenStatuses = [];
      store.subscribe((c) => { if (c.type === "changesets") for (const m of store.changesets.values()) globalThis.seenStatuses.push(m.status); });
    });
    assert.equal(await accept(two, "Import 4 elements and 3 connections"), "applied");

    const cs = await newestChangeset(two);
    assert.equal(cs.status, "applied");
    const { objects, fields, types } = await mapOf(two);
    const budget = fields.find((f) => f.name === "Budget");
    const status = fields.find((f) => f.name === "Status");
    assert.equal(budget.kind, "number");
    assert.equal(status.kind, "choice");
    assert.deepEqual([...status.choices].sort(), ["Active", "Planned"]);
    assert.ok(types.some((t) => t.name === "Charity" && t.appliesTo === "element"));
    assert.ok(types.some((t) => t.name === "Partners" && t.appliesTo === "connection"));
    const seed = objects.find((o) => o.label === "Seed library");
    assert.equal(seed.fields[budget.id], 300);
    assert.equal(seed.fields[status.id], "Active");
    assert.deepEqual(seed.tags, ["seeds"]);
    assert.equal(seed.provenance.origin, "import");
    assert.equal(seed.provenance.changesetId, cs.id);
    const foodBanks = objects.filter((o) => o.label === "Food bank");
    assert.equal(foodBanks.length, 2, "a new Food bank next to the demo's");
    const imported = foodBanks.find((o) => o.provenance?.origin === "import");
    assert.deepEqual(imported.tags, ["food", "charity"]);
    const conns = objects.filter((o) => o.id[0] === "c" && o.provenance?.changesetId === cs.id);
    assert.equal(conns.length, 3);
    assert.ok(conns.some((c) => c.to === imported.id), "the connection goes to the new Food bank");
    assert.ok(conns.every((c) => c.externalRefs[0].sourceId === "kumu:allotments"));
    assert.equal(conns.find((c) => c.strength === 2)?.from, seed.id);

    // Pane 1 got the manifests (store.changesets) and lists the import as done.
    await one.waitForFunction((id) => globalThis.networkMap.store.changesets.get(id)?.status === "applied", cs.id, { timeout: 10000 });
    await one.waitForSelector(`.nm-data .imports li[data-changeset="${cs.id}"][data-status="applied"]`);
    assert.match(await one.textContent(`.nm-data .imports li[data-changeset="${cs.id}"]`), /Imported/);
    const seen = await one.evaluate(() => globalThis.seenStatuses);
    assert.ok(seen.includes("applying") && seen.includes("applied"), `pane 1 saw ${seen.join(", ")}`);

    // Selecting the imported elements.
    await two.click('.nm-data [data-key="select"]');
    await two.waitForFunction(() => globalThis.networkMap.app.selection.size === 4);

    // Re-import with the same source name and a changed budget: updates, no duplicates.
    await two.click('.nm-data [data-key="another"]');
    await pasteSheets(two, ELEMENTS.replace("Seed library\tCharity\tseeds\t300", "Seed library\tCharity\tseeds\t999"), CONNECTIONS, "Allotments");
    await continueToReview(two);
    assert.equal(await two.textContent('.nm-data .counts .chip[data-action="update"]'), "Update: 7");
    assert.equal(await accept(two, "Import 4 elements and 3 connections"), "applied");
    const again = await mapOf(two);
    assert.equal(again.objects.filter((o) => o.label === "Seed library").length, 1);
    assert.equal(again.objects.find((o) => o.label === "Seed library").fields[budget.id], 999);
    assert.equal(again.objects.filter((o) => o.label === "Food bank").length, 2);
    assert.equal(again.objects.filter((o) => o.id[0] === "c" && o.externalRefs?.[0]?.sourceId === "kumu:allotments").length, 3);

    // Undo the re-import from the list: the budget goes back.
    const reimport = await newestChangeset(two);
    await two.click(`.nm-data [data-key="undo:${reimport.id}"]`);
    await two.waitForSelector(`.nm-data .imports li[data-changeset="${reimport.id}"] .chip:text-is("Undone")`, { timeout: 10000 });
    await until(two, (s) => s.objects.find((o) => o.label === "Seed library")?.fields?.[budget.id] === 300);

    assert.deepEqual(await problems(page), { violations: [], errors: [] });
  });

  it("imports Kumu JSON, and undoing it keeps an element someone connected since", async () => {
    const { page, frames } = await h.open();
    const [frame] = frames;
    await openTab(frame, "data");
    await frame.check('.nm-data input[type="radio"][value="kumu-json"]');
    await frame.fill('textarea[id^="nm-data-json-"]', KUMU_JSON);
    await frame.fill('input[id^="nm-data-source-"]', "River");
    await frame.click('.nm-data button:text-is("Preview")');
    assert.equal(await frame.textContent(".nm-data .preview .summary"), "2 elements · 1 connection · 3 types · 1 field");
    await continueToReview(frame);
    assert.equal(await accept(frame, "Import 2 elements and 1 connection"), "applied");
    const cs = await newestChangeset(frame);
    const { objects, fields } = await mapOf(frame);
    const river = objects.find((o) => o.label === "River trust");
    const mill = objects.find((o) => o.label === "Mill");
    assert.equal(river.provenance.origin, "import");
    assert.deepEqual(river.tags, ["water"]);
    assert.equal(river.fields[fields.find((f) => f.name === "Budget").id], 50);
    assert.ok(objects.some((o) => o.id[0] === "c" && o.from === river.id && o.to === mill.id));

    // Someone connects the demo's City council to the imported Mill, then the import is undone.
    const council = objects.find((o) => o.label === "City council");
    await frame.evaluate(([from, to]) => {
      const { app } = globalThis.networkMap;
      app.apply([{ op: "create", object: { id: app.newId("connection"), from, to, direction: "directed" } }]);
    }, [council.id, mill.id]);
    await settled(frame);
    await frame.click(`.nm-data [data-key="undo:${cs.id}"]`);
    await frame.waitForFunction(() => /changed since and kept/.test(document.querySelector(".nm-data .imports + .status-line")?.textContent ?? ""), null, { timeout: 10000 });
    const after = await until(frame, (s) => !s.objects.some((o) => o.label === "River trust"));
    assert.ok(after.objects.some((o) => o.label === "Mill"), "Mill has a connection added later, so it stays");
    assert.ok(after.objects.some((o) => o.id[0] === "c" && o.from === council.id && o.to === mill.id));
    assert.ok(!after.objects.some((o) => o.id[0] === "c" && o.from === river.id));

    assert.deepEqual(await problems(page), { violations: [], errors: [] });
  });

  it("discards a reviewed import", async () => {
    const { page, frames } = await h.open();
    const [frame] = frames;
    await openTab(frame, "data");
    await pasteSheets(frame, "Label\nOnly here", "", "Discard me");
    await continueToReview(frame);
    const cs = await newestChangeset(frame);
    await frame.click('.nm-data .review [data-key="discard"]');
    await frame.waitForFunction((id) => globalThis.networkMap.store.changesets.get(id)?.status === "rejected", cs.id);
    assert.ok(!(await mapOf(frame)).objects.some((o) => o.label === "Only here"));
    assert.deepEqual(await problems(page), { violations: [], errors: [] });
  });
});

describe("activity", () => {
  it("lists the import and a normal edit, and undoes one entry", async () => {
    const { page, frames } = await h.open();
    const [frame] = frames;
    await openTab(frame, "data");
    await pasteSheets(frame, "Label\tType\nPond\tResource", "", "Ponds");
    await continueToReview(frame);
    assert.equal(await accept(frame, "Import 1 element"), "applied");

    const farmland = (await mapOf(frame)).objects.find((o) => o.label === "Farmland");
    await frame.evaluate((id) => globalThis.networkMap.app.apply([{ op: "update", id, patch: { label: "Farmland (edited)" } }]), farmland.id);
    await settled(frame);

    await openTab(frame, "activity");
    await frame.waitForSelector('.nm-activity .history li[data-entry] >> text=/Imported 1 element/');
    const entries = await frame.evaluate(() => globalThis.networkMap.store.history.map((e) => ({ id: e.id, summary: e.summary, groupId: e.groupId })));
    const edit = entries[0];
    assert.ok(!edit.groupId);
    assert.ok(entries.some((e) => e.groupId && /Imported 1 element/.test(e.summary)));
    assert.ok(await frame.isVisible(`.nm-activity li[data-entry="${entries.find((e) => e.groupId).id}"] .chip[data-badge="group"]`));

    await frame.click(`.nm-activity [data-key="undo:${edit.id}"]`);
    await until(frame, (s) => s.objects.find((o) => o.id === farmland.id)?.label === "Farmland");
    await frame.waitForSelector(`.nm-activity li[data-entry="${edit.id}"][data-undone]`);
    assert.match(await frame.textContent(".nm-activity .status-line"), /Undone/);

    // "Undo whole import" from an import entry.
    const importEntry = entries.find((e) => e.groupId);
    await frame.click(`.nm-activity [data-key="group:${importEntry.id}"]`);
    await until(frame, (s) => !s.objects.some((o) => o.label === "Pond"));

    assert.deepEqual(await problems(page), { violations: [], errors: [] });
  });

  it("shows the people here and follows one", async () => {
    const { page, frames } = await h.open({ panes: 2, viewport: { width: 2600, height: 1000 } });
    const [one, two] = frames;
    await openTab(one, "activity");
    await one.waitForSelector(".nm-activity .people li[data-client] button");
    await one.click(".nm-activity .people li[data-client] button");
    await one.waitForSelector('.nm-activity .people button[aria-pressed="true"]');
    await two.waitForFunction(() => [...globalThis.networkMap.store.peers.values()].some((p) => p.following === globalThis.networkMap.store.viewer.clientId), null, { timeout: 10000 });
    assert.deepEqual(await problems(page), { violations: [], errors: [] });
  });
});
