// Harness end-to-end tests: the real built client in the platform's sandboxed frame (capnweb,
// CSP) over the real gadget server and the FakeRecords datastore.
//
//   node scripts/build.mjs && node --test --test-concurrency=1 e2e/harness.test.mjs
//
// Screenshots go to e2e/screenshots/ (gitignored) or $HARNESS_SHOTS. Timings print as "# perf".

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appState, axe, paneFrame, problems, screenshot, smallTargets, startHarness, until, waitReady } from "./helpers.mjs";

/** @type {Awaited<ReturnType<typeof startHarness>>} */
let h;
before(async () => { h = await startHarness({ port: Number(process.env.HARNESS_PORT || 8797) }); });
after(async () => { await h?.close(); });

/** @param {import("playwright").Frame} frame @param {string} fn @param {any} [arg] */
const inApp = (frame, fn, arg) => frame.evaluate(`(${fn})(globalThis.workBoard.app, globalThis.workBoard.store, ${JSON.stringify(arg ?? null)})`);
/** @param {import("playwright").Page} page */
const pending = (page) => page.evaluate(() => window.harness.pending());
/** @param {import("playwright").Page} page @param {number} n */
const rowByNumber = (page, n) => page.evaluate((x) => [...window.harness.fake.rows.values()].find((r) => r.entity === "work_item" && r.data.number === x), n);
/** @param {import("playwright").Frame} frame */
const focused = (frame) => frame.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.className ?? "");
/** @param {import("playwright").Frame} frame */
const pull = (frame) => frame.evaluate(() => globalThis.workBoard.store.pull());
/** Puts keyboard focus inside the gadget frame, on the board (as Tab from the Workshop would). @param {import("playwright").Frame} frame */
const focusBoard = (frame) => frame.locator(".board-scroll").focus();

async function assertClean(/** @type {import("playwright").Page} */ page, /** @type {string[]} */ errors) {
  const p = await problems(page, errors);
  assert.deepEqual(p.violations, [], "no CSP violations");
  assert.deepEqual(p.errors, [], "no console errors");
}

describe("boot and accessibility", () => {
  it("loads 300 seeded items under the platform CSP with no errors and no serious axe violations", async () => {
    const { page, frame, errors } = await h.open({ seed: 300 });
    const s = await appState(frame);
    assert.equal(s.phase, "ready");
    assert.equal(await frame.locator("h1").count(), 1);
    assert.ok(await frame.locator("article.card").count() > 20);
    assert.deepEqual(await axe(frame), [], "board");
    await frame.locator("article.card").first().hover();
    assert.deepEqual(await smallTargets(frame), [], "target size, board");
    await assertClean(page, errors);
  });

  it("screens pass axe: lanes, list, detail, create, palette, settings, shortcuts", async () => {
    const { page, frame, errors } = await h.open({ seed: 120 });
    await inApp(frame, "(app) => app.loadView({ ...app.view, id: null, name: 'Lanes', swimlanesBy: 'assignee' })");
    assert.deepEqual(await axe(frame), [], "lanes");
    assert.deepEqual(await smallTargets(frame), [], "target size, lanes");
    await inApp(frame, "(app) => app.setLayout('list')");
    assert.deepEqual(await axe(frame), [], "list");
    assert.deepEqual(await smallTargets(frame), [], "target size, list");
    await inApp(frame, "(app, store) => app.openDetail(store.index().itemList.find((i) => (store.index().children.get(i.id)?.length ?? 0) > 1), { focus: true })");
    assert.deepEqual(await axe(frame), [], "detail");
    assert.deepEqual(await smallTargets(frame), [], "target size, detail");
    await inApp(frame, "(app) => app.closeDetail()");
    for (const [action, name] of [["create", "create"], ["palette", "palette"], ["settings", "settings"], ["help", "shortcuts"]]) {
      await inApp(frame, `(app) => app.runAction(${JSON.stringify(action)})`);
      await frame.locator('[role="dialog"]').first().waitFor();
      assert.deepEqual(await axe(frame), [], name);
      assert.deepEqual(await smallTargets(frame), [], `target size, ${name}`);
      await frame.locator('[role="dialog"]').first().press("Escape");
      await frame.locator('[role="dialog"]').first().waitFor({ state: "detached" });
    }
    await assertClean(page, errors);
  });
});

describe("keyboard-only journeys", () => {
  it("creates an item with tokens, sees the pending card, and it lands after approval", async () => {
    const { page, frame, errors } = await h.open({ seed: 30, approval: "manual" });
    await focusBoard(frame);
    await frame.page().keyboard.press("c");
    const title = frame.locator(".create-title");
    await title.waitFor();
    await page.keyboard.type("Keyboard-made item #bug @me !high");
    await page.keyboard.press("Enter");
    const [action] = await until(async () => { const p = await pending(page); return p.length === 1 && p; }, { message: "pending create" });
    assert.equal(action.command, "work.create");
    assert.equal(action.actor, "cloudflare-os:ada@example.com");
    assert.deepEqual(action.input.labels, ["bug"]);
    assert.equal(action.input.priority, 2);
    await frame.locator("article.card.ghost", { hasText: "Keyboard-made item" }).waitFor();
    await page.evaluate(() => window.harness.approveAll());
    await pull(frame);
    await frame.locator("article.card:not(.ghost)", { hasText: "Keyboard-made item" }).waitFor();
    assert.equal(await frame.locator("article.card.ghost").count(), 0);
    await assertClean(page, errors);
  });

  it("moves a card to another lane with Shift+arrows, changing the assignee", async () => {
    const { page, frame, errors } = await h.open({ seed: 60 });
    await inApp(frame, "(app) => app.loadView({ ...app.view, id: null, name: 'Lanes', swimlanesBy: 'assignee' })");
    // Focus the first card of the first lane.
    await focusBoard(frame);
    await frame.page().keyboard.press("ArrowDown");
    const label = await focused(frame);
    const key = /^([A-Z]+-\d+):/.exec(label)?.[1];
    assert.ok(key, `a card is focused (${label})`);
    const n = Number(key.split("-")[1]);
    const original = await rowByNumber(page, n);
    await page.keyboard.press("Shift+ArrowDown");
    const announcement = await frame.evaluate(() => new Promise((r) => setTimeout(() => r(document.querySelector('[data-live="polite"]').textContent), 80)));
    assert.match(announcement, new RegExp(`Moving ${key} to .+ lane .+ Press Enter to confirm, Escape to cancel`));
    // Down again walks into the next lane (cards are in manual order, so it may take a few steps).
    for (let i = 0; i < 40; i++) {
      const text = await frame.evaluate(() => document.querySelector('[data-live="polite"]').textContent);
      const lane = /lane ([^,.]+)/.exec(text)?.[1];
      const current = await frame.evaluate((k) => globalThis.workBoard.store.index().itemList.find((x) => x.key === k)?.assignee ?? null, key);
      const laneActor = await frame.evaluate((name) => [...globalThis.workBoard.store.index().people.values()].find((p) => p.name === name)?.id ?? null, lane ?? "");
      if (lane && laneActor !== current) break;
      await page.keyboard.press(i < 20 ? "ArrowDown" : "ArrowUp");
      await page.waitForTimeout(40);
    }
    await page.keyboard.press("Enter");
    const changed = await until(async () => { const r = await rowByNumber(page, n); return r.revision !== original.revision && r; }, { message: "assignee change applied" });
    assert.notEqual(changed.data.assignee ?? null, original.data.assignee ?? null);
    await pull(frame);
    await until(async () => (await focused(frame)).startsWith(`${key}:`), { message: "focus follows the moved card" });
    await assertClean(page, errors);
  });

  it("bulk assigns with X and A, one command per item", async () => {
    const { page, frame, errors } = await h.open({ seed: 40, approval: "manual" });
    await focusBoard(frame);
    await frame.page().keyboard.press("ArrowDown");
    // Select three cards: X, then J to the next card (or → to the next column at a column's end).
    for (let picked = 0; picked < 3;) {
      await page.keyboard.press("x");
      picked = (await appState(frame)).selection.length;
      if (picked >= 3) break;
      const was = await focused(frame);
      await page.keyboard.press("j");
      if ((await focused(frame)) === was) await page.keyboard.press("ArrowRight");
    }
    await frame.locator(".bulk-count", { hasText: "3 selected" }).waitFor();
    await page.keyboard.press("a");
    await frame.locator(".picker-input").waitFor();
    await page.keyboard.type("grace");
    await page.keyboard.press("Enter");
    // One command per selected item that is not already Grace's.
    const expected = await inApp(frame, "(app, store) => [...app.selection].filter((id) => store.index().items.get(id)?.assignee !== 'cloudflare-os:grace@example.com').length");
    assert.ok(expected >= 1);
    const actions = await until(async () => { const p = await pending(page); return p.length === expected && p; }, { message: `${expected} pending updates` });
    assert.ok(actions.every((a) => a.command === "work.update" && a.input.assignee === "cloudflare-os:grace@example.com"));
    await page.evaluate(() => window.harness.approveAll());
    await pull(frame);
    await until(() => inApp(frame, `(app, store) => store.changes.filter((c) => c.status === 'applied').length === ${expected}`), { message: "all saved" });
    await assertClean(page, errors);
  });

  it("filters with / and saves a shared view from the palette", async () => {
    const { page, frame, errors } = await h.open({ seed: 80 });
    await focusBoard(frame);
    await frame.page().keyboard.press("/");
    await page.keyboard.type("is:blocked priority:<=high");
    await page.keyboard.press("Enter");
    await until(() => inApp(frame, "(app) => app.view.query === 'is:blocked priority:<=high'"), { message: "query applied" });
    const shown = await frame.locator("article.card").count();
    const expected = await page.evaluate(async () => (await window.harness.rpc("query", "is:blocked priority:<=high", { limit: 500 })).total);
    assert.equal(shown, expected, "the board and the agent's query() agree");
    await focusBoard(frame);
    await frame.page().keyboard.press("Control+k");
    await page.keyboard.type("save as");
    await page.keyboard.press("Enter");
    await frame.locator("#wb-view-name").waitFor();
    await page.keyboard.type("Blocked, high or urgent");
    await page.keyboard.press("Enter");
    const saved = await until(async () => page.evaluate(() => [...window.harness.storage.map.values()].find((v) => v.name === "Blocked, high or urgent")), { message: "saved view" });
    assert.equal(saved.query, "is:blocked priority:<=high");
    await assertClean(page, errors);
  });
});

describe("pointer", () => {
  it("drags a card to another column (and the Move menu does the same without dragging)", async () => {
    const { page, frame, errors } = await h.open({ seed: 40, viewport: { width: 1600, height: 900 } });
    const card = frame.locator('ul.cell[data-col="todo"] article.card').first();
    const key = /^([A-Z]+-\d+)/.exec(await card.getAttribute("aria-label") ?? "")?.[1];
    const target = frame.locator('ul.cell[data-col="in_progress"]').first();
    const from = await card.boundingBox(), to = await target.boundingBox();
    assert.ok(from && to);
    await page.mouse.move(from.x + 40, from.y + 20);
    await page.mouse.down();
    await page.mouse.move(from.x + 80, from.y + 40, { steps: 5 });
    await page.mouse.move(to.x + 60, to.y + 30, { steps: 20 });
    await page.mouse.up();
    const n = Number(key?.split("-")[1]);
    await until(async () => (await rowByNumber(page, n)).data.state === "in_progress", { message: "drag applied" });
    // Single-pointer alternative (WCAG 2.5.7): the card's menu button.
    const second = frame.locator('ul.cell[data-col="todo"] article.card').first();
    const key2 = /^([A-Z]+-\d+)/.exec(await second.getAttribute("aria-label") ?? "")?.[1];
    await second.hover();
    await second.locator(".card-menu").click();
    await frame.locator('[role="option"]', { hasText: "In Review" }).click();
    await until(async () => (await rowByNumber(page, Number(key2?.split("-")[1]))).data.state === "in_review", { message: "menu move applied" });
    await assertClean(page, errors);
  });
});

describe("robustness", () => {
  it("re-snapshots after a permission epoch change and reloads itself after a facet restart", async () => {
    const { page, frame, errors } = await h.open({ seed: 30 });
    await page.evaluate(() => window.harness.bumpEpoch());
    await pull(frame);
    assert.equal((await appState(frame)).phase, "ready");
    const loads = await page.evaluate(() => window.harness.handshakes);
    await page.evaluate(() => window.harness.restartFacet());
    // The next calls fail on the stale stub; the frame reloads itself and reconnects.
    await frame.evaluate(() => globalThis.workBoard.store.refresh()).catch(() => {});
    await frame.evaluate(() => globalThis.workBoard.store.refresh()).catch(() => {});
    await frame.evaluate(() => globalThis.workBoard.store.refresh()).catch(() => {});
    await until(async () => (await page.evaluate(() => window.harness.handshakes)) > loads, { timeout: 15_000, message: "frame reloaded" });
    const fresh = await paneFrame(page, 0);
    await waitReady(fresh);
    const p = await problems(page, errors);
    assert.deepEqual(p.violations, []);
    assert.ok(p.errors.every((e) => /restarted/i.test(e)), `only restart errors: ${JSON.stringify(p.errors)}`);
  });

  it("shows an offline banner after repeated failures and recovers", async () => {
    const { page, frame } = await h.open({ seed: 20 });
    await page.evaluate(() => window.harness.dropNextCalls(4));
    await pull(frame);
    await pull(frame);
    await frame.locator(".banner.warn", { hasText: "Can't reach the Records service" }).waitFor();
    await frame.getByRole("button", { name: "Retry now" }).click();
    await frame.locator(".banner.warn").waitFor({ state: "detached" });
  });

  it("works on a v1-only datastore and read-only connections", async () => {
    const v1 = await h.open({ v1: true, seed: 20 });
    assert.deepEqual(await v1.frame.locator(".col-head .col-name").allTextContents(), ["Open", "Active", "Done"]);
    assert.deepEqual(await axe(v1.frame), []);
    await assertClean(v1.page, v1.errors);
    const ro = await h.open({ access: "read", seed: 20 });
    assert.equal(await ro.frame.getByRole("button", { name: "New item" }).count(), 0);
    await assertClean(ro.page, ro.errors);
  });
});

describe("round 2", () => {
  it("keeps the focused card in the DOM when a windowed column scrolls away from it", async () => {
    const { page, frame, errors } = await h.open({ seed: 2000 });
    await frame.locator(".board-scroll").focus();
    await page.keyboard.press("ArrowDown");
    const label = await focused(frame);
    assert.match(label, /^[A-Z]+-\d+:/);
    await frame.locator(".board-scroll").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(150);
    assert.equal(await focused(frame), label, "focus stayed on the same card");
    await page.keyboard.press("ArrowDown");
    assert.notEqual(await focused(frame), label, "arrow keys still move from it");
    await assertClean(page, errors);
  });

  it("shows names for colleagues and times from the service", async () => {
    const { page, frame, errors } = await h.open({ seed: 120 });
    await inApp(frame, "(app) => app.setLayout('list')");
    const updated = await frame.locator(".lg-row .col-updated").first().textContent();
    assert.notEqual(updated?.trim(), "—");
    const names = await frame.locator(".lg-row .col-assignee").allTextContents();
    assert.ok(names.some((n) => /Hopper|Turing|Johnson|Torvalds|Hamilton|Lovelace/.test(n)), names.slice(0, 5).join(" | "));
    assert.ok(!names.some((n) => n.includes("@")), "no account emails as names");
    await assertClean(page, errors);
  });

  it("phones: one column with a switcher, filter behind a button, no horizontal page scroll", async () => {
    const { page, frame, errors } = await h.open({ seed: 120, viewport: { width: 375, height: 812 }, hasTouch: true });
    assert.equal(await frame.locator(".narrow-bar").isVisible(), true);
    assert.equal(await frame.locator(".col-head").count(), 1);
    assert.equal(await frame.locator("#wb-wql").isVisible(), false);
    await frame.getByRole("button", { name: "Filter" }).click();
    assert.equal(await frame.locator("#wb-wql").isVisible(), true);
    await page.keyboard.press("Escape");
    const previous = await frame.locator('.narrow-tab[aria-pressed="true"]').textContent();
    await frame.locator(".narrow-tab").nth(4).click();
    assert.notEqual(await frame.locator('.narrow-tab[aria-pressed="true"]').textContent(), previous);
    const overflow = await frame.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px`);
    assert.deepEqual(await axe(frame), []);
    assert.deepEqual(await smallTargets(frame), []);
    await screenshot(page, "narrow-375-light");
    await assertClean(page, errors);
  });
});

describe("screenshots", () => {
  for (const scheme of /** @type {const} */ (["light", "dark"])) {
    for (const [w, hgt] of [[375, 812], [768, 1024], [1440, 900]]) {
      it(`board at ${w}px, ${scheme}`, async () => {
        const { page, frame, errors } = await h.open({ seed: 300, viewport: { width: w, height: hgt }, colorScheme: scheme });
        await screenshot(page, `board-${w}-${scheme}`);
        if (w === 375) {
          await inApp(frame, "(app, store) => app.openDetail(store.index().itemList.find((i) => (store.index().children.get(i.id)?.length ?? 0) > 2), { focus: true })");
          await screenshot(page, `detail-${w}-${scheme}`);
          await inApp(frame, "(app) => app.closeDetail()");
        }
        if (w === 1440) {
          await inApp(frame, "(app) => app.loadView({ ...app.view, id: null, name: 'Current cycle by person', query: 'cycle:current', swimlanesBy: 'assignee' })");
          await screenshot(page, `lanes-${w}-${scheme}`);
          await inApp(frame, "(app) => app.setLayout('list')");
          await screenshot(page, `list-${w}-${scheme}`);
          await inApp(frame, "(app, store) => app.openDetail(store.index().itemList.find((i) => (store.index().children.get(i.id)?.length ?? 0) > 2), { focus: true })");
          await screenshot(page, `detail-${w}-${scheme}`);
        }
        assert.deepEqual(await axe(frame), [], `axe ${w} ${scheme}`);
        await assertClean(page, errors);
      });
    }
  }
});

describe("performance", () => {
  it("2,000 items: first render, filter/regroup and drag frame times", async () => {
    const { page, frame, errors } = await h.open({ seed: 2000, viewport: { width: 1440, height: 900 } });
    const firstRender = await frame.evaluate(() => performance.getEntriesByName("wb:snapshot-to-render")[0]?.duration ?? -1);
    const timings = await frame.evaluate(() => {
      const { app } = globalThis.workBoard;
      /** @type {[string, () => void][]} */
      const steps = [
        ["filter", () => app.loadView({ ...app.view, id: null, name: "p", query: "priority:<=high -is:blocked" })],
        ["regroupLanes", () => app.loadView({ ...app.view, swimlanesBy: "assignee" })],
        ["regroupColumns", () => app.loadView({ ...app.view, columnsBy: "priority", swimlanesBy: null })],
        ["clear", () => app.loadView({ ...app.view, query: "", columnsBy: "state" })],
        ["list", () => app.setLayout("list")],
        ["board", () => app.setLayout("board")],
      ];
      /** @type {Record<string, number>} */
      const out = {};
      for (const [name, step] of steps) { const t0 = performance.now(); step(); out[name] = performance.now() - t0; }
      return out;
    });
    // Drag across the board and record frame intervals.
    const card = frame.locator("article.card").first();
    const box = await card.boundingBox();
    assert.ok(box);
    await frame.evaluate(() => { globalThis.__frames = []; let last = performance.now(); const tick = (t) => { globalThis.__frames.push(t - last); last = t; if (globalThis.__frames.length < 400) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
    await page.mouse.move(box.x + 30, box.y + 20);
    await page.mouse.down();
    for (let i = 0; i < 60; i++) await page.mouse.move(box.x + 30 + i * 12, box.y + 20 + (i % 10) * 6);
    const frames = await frame.evaluate(() => globalThis.__frames.slice(2));
    await page.keyboard.press("Escape");
    await page.mouse.up();
    const sorted = [...frames].toSorted((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const fps = 1000 / (frames.reduce((s, x) => s + x, 0) / Math.max(1, frames.length));
    const dom = await frame.evaluate(() => document.querySelectorAll("*").length);
    console.log(`# perf 2000 items: snapshot→first render ${firstRender.toFixed(1)} ms; ${JSON.stringify(Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v * 10) / 10])))} ms; drag ${fps.toFixed(0)} fps (p95 frame ${p95.toFixed(1)} ms); ${dom} DOM nodes`);
    assert.ok(firstRender > 0 && firstRender < 300, `first render ${firstRender} ms`);
    assert.ok(timings.filter < 50 && timings.regroupLanes < 50, `filter/regroup ${JSON.stringify(timings)}`);
    await assertClean(page, errors);
  });
});

// ---------------------------------------------------------------------------------------------
// Insights, proposals, Jev and the agent skill

/** Waits until every visible report card has drawn its chart (or an empty state). @param {import("playwright").Frame} frame */
const chartsDrawn = (frame) => frame.waitForFunction(() => {
  const cards = [...document.querySelectorAll(".report-card")];
  return cards.length > 0 && cards.every((c) => c.querySelector(".report-chart svg, .report-empty")) && !globalThis.workBoard.app.insights.loading;
}, null, { timeout: 20_000 });

describe("insights", () => {
  for (const scheme of /** @type {const} */ (["light", "dark"])) {
    for (const [w, hgt] of [[375, 812], [768, 1024], [1440, 900]]) {
      it(`reports at ${w}px, ${scheme}: every chart draws, axe clean, 24px targets`, async () => {
        const { page, frame, errors } = await h.open({ seed: 300, viewport: { width: w, height: hgt }, colorScheme: scheme });
        await inApp(frame, "(app) => app.setLayout('insights')");
        await chartsDrawn(frame);
        assert.equal(await frame.locator(".report-card").count(), 8);
        assert.equal(await frame.locator(".report-chart svg").count(), 8);
        await screenshot(page, `insights-${w}-${scheme}`);
        await frame.locator('[data-report="dependencies"]').scrollIntoViewIfNeeded();
        await screenshot(page, `insights-${w}-${scheme}-end`);
        if (w === 1440) {
          await frame.locator('[data-report="cfd"] [data-focus-key="data"]').click();
          await frame.locator('[data-report="cfd"] table').waitFor();
          await frame.locator('[data-report="cfd"]').scrollIntoViewIfNeeded();
          await screenshot(page, `insights-${w}-${scheme}-table`);
        }
        const overflow = await frame.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px`);
        assert.deepEqual(await axe(frame), [], `axe ${w} ${scheme}`);
        assert.deepEqual(await smallTargets(frame), [], `targets ${w} ${scheme}`);
        await assertClean(page, errors);
      });
    }
  }

  it("keyboard: G then I opens insights, arrows move between reports, the graph is operable", async () => {
    const { page, frame, errors } = await h.open({ seed: 300 });
    await focusBoard(frame);
    await page.keyboard.press("g");
    await page.keyboard.press("i");
    await until(() => inApp(frame, "(app) => app.view.layout === 'insights'"), { message: "insights layout" });
    await chartsDrawn(frame);
    await frame.locator('[data-report="cfd"] h3').focus();
    await page.keyboard.press("ArrowDown");
    assert.match(await frame.evaluate(() => document.activeElement?.textContent ?? ""), /Cycle time/);
    const node = frame.locator('[data-report="dependencies"] .dep-node[tabindex="0"]');
    await node.focus();
    const first = await node.getAttribute("aria-label");
    await page.keyboard.press("ArrowRight");
    const second = await frame.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    assert.notEqual(second, first);
    await page.keyboard.press("Enter");
    await until(() => inApp(frame, "(app) => Boolean(app.detail.itemId)"), { message: "item opened" });
    assert.match(second ?? "", new RegExp(`^${await inApp(frame, "(app, store) => store.index().items.get(app.detail.itemId).key")}:`));
    await inApp(frame, "(app) => app.closeDetail()");
    // Only chains: fewer nodes, still operable; a legend explains shapes and colours.
    const all = await frame.locator('[data-report="dependencies"] .dep-node').count();
    await frame.locator('[data-report="dependencies"] .seg', { hasText: "Only chains" }).click();
    await until(async () => { const n = await frame.locator('[data-report="dependencies"] .dep-node').count(); return n > 0 && n < all; }, { message: "chains only" });
    assert.match(await frame.locator('[data-report="dependencies"] .graph-legend').textContent() ?? "", /Blocked.*Part of a chain/);
    await frame.locator('[data-report="dependencies"]').scrollIntoViewIfNeeded();
    await screenshot(page, "insights-1440-light-chains");
    // Ask the agent: selectable prompts.
    await frame.getByRole("button", { name: "Ask the agent" }).click();
    const prompt = await frame.locator("#wb-ask-main").inputValue();
    assert.match(prompt, /^Using the Work Board skill, build a burndown for Cycle 24 split by project/);
    await screenshot(page, "insights-ask-agent-1440-light");
    assert.deepEqual(await axe(frame), []);
    await page.keyboard.press("Escape");
    await assertClean(page, errors);
  });

  it("2,000 items: dataset computation and the batched insights read", async () => {
    const { page, frame, errors } = await h.open({ seed: 2000 });
    const timing = await page.evaluate(async () => {
      const reports = (await window.harness.rpc("listReports")).map((r) => ({ id: r.id, dataset: r.dataset, params: r.params, query: r.query }));
      const t0 = performance.now();
      await window.harness.rpc("insights", { reports });
      const cold = performance.now() - t0;
      const t1 = performance.now();
      await window.harness.rpc("insights", { reports, query: "-label:docs" });
      const filtered = performance.now() - t1;
      /** @type {Record<string, number>} */
      const each = {};
      for (const d of await window.harness.rpc("datasets")) {
        const t = performance.now();
        await window.harness.rpc("dataset", d.name, { query: "priority:<=medium" });
        each[d.name] = Math.round((performance.now() - t) * 10) / 10;
      }
      return { cold: Math.round(cold), filtered: Math.round(filtered), each, journal: window.harness.fake.journal.length };
    });
    await inApp(frame, "(app) => app.setLayout('insights')");
    const t = Date.now();
    await chartsDrawn(frame);
    const drawn = Date.now() - t;
    console.log(`# perf insights 2000 items (journal ${timing.journal} entries): first read incl. full journal backfill ${timing.cold} ms; filtered re-read of 8 reports ${timing.filtered} ms; per dataset ${JSON.stringify(timing.each)} ms; screen drawn in ${drawn} ms`);
    assert.ok(timing.filtered < 500, `8 reports in ${timing.filtered} ms`);
    await assertClean(page, errors);
  });
});

describe("proposals and Jev", () => {
  it("keyboard only: G then P opens the tray; untick one change, apply the rest as the viewer", async () => {
    const { page, frame, errors } = await h.open({ seed: 120, approval: "manual" });
    const p = await page.evaluate(() => window.harness.rpc("propose", [
      { command: "work.update", input: { id: "TW-12", priority: "urgent" }, reason: "Customer escalation" },
      { command: "work.update", input: { id: "TW-14", title: "Renamed by the agent" } },
      { command: "work.create", input: { title: "Write the migration guide", parent: "TW-12" } },
    ], { title: "Escalate TW-12", reason: "Acme is blocked." }));
    await inApp(frame, "(app, store) => store.loadProposals()");
    await frame.locator(".proposals-btn .badge", { hasText: "1" }).waitFor();
    await focusBoard(frame);
    await page.keyboard.press("g");
    await page.keyboard.press("p");
    await frame.locator(".tray").waitFor();
    assert.equal(await frame.evaluate(() => document.activeElement?.getAttribute("type")), "checkbox", "focus starts on the first change");
    // Tab to the second change's checkbox and untick it with Space.
    for (let i = 0; i < 6 && !(await frame.evaluate(() => document.activeElement?.id?.endsWith("-c2"))); i++) await page.keyboard.press("Tab");
    await page.keyboard.press("Space");
    for (let i = 0; i < 12 && !(await frame.evaluate(() => document.activeElement?.textContent ?? "")).startsWith("Apply"); i++) await page.keyboard.press("Tab");
    assert.equal(await frame.evaluate(() => document.activeElement?.textContent), "Apply 2 selected");
    await page.keyboard.press("Enter");
    const actions = await until(async () => { const x = await pending(page); return x.length === 2 && x; }, { message: "2 pending" });
    assert.deepEqual(actions.map((a) => a.actor), ["cloudflare-os:ada@example.com", "cloudflare-os:ada@example.com"]);
    const stored = await until(async () => { const x = await page.evaluate((id) => window.harness.rpc("getProposal", id), p.id); return x.status === "partial" && x; }, { message: "recorded" });
    assert.equal(stored.applied_by.name, "Ada Lovelace");
    assert.ok(await frame.evaluate(() => document.querySelector(".tray")?.contains(document.activeElement)), "focus stays in the tray");
    await screenshot(page, "proposals-applied-1440-light");
    assert.deepEqual(await axe(frame), []);
    await page.keyboard.press("Escape");
    await frame.locator(".tray").waitFor({ state: "detached" });
    await assertClean(page, errors);
  });

  it("Jev: Triage with Jev from the Triage view, confidence as text, applied as a proposal", async () => {
    const { page, frame, errors } = await h.open({ seed: 120 });
    await inApp(frame, "(app) => app.loadView({ ...app.view, id: 'builtin:triage', name: 'Triage', query: 'kind:triage', layout: 'list' })");
    await frame.getByRole("button", { name: "Triage with Jev" }).click();
    await frame.locator(".suggest-list input").first().waitFor();
    // Duplicates name the candidate and can be peeked; each item shows its current values.
    const dup = frame.locator(".peek-dup").first();
    if (await dup.count()) {
      await dup.locator("summary").click();
      assert.match(await dup.textContent() ?? "", /^Peek TW-\d+TW-\d+ .+/);
    }
    assert.ok(await frame.locator(".suggest-now").count() > 0);
    assert.ok(await frame.locator(".suggest-foot .btn.primary").isVisible(), "footer pinned");
    await screenshot(page, "jev-triage-1440-light");
    const rows = await frame.locator(".suggest-list li").allTextContents();
    assert.ok(rows.length > 0 && rows.every((r) => /\d+% likely/.test(r)), rows.slice(0, 3).join(" | "));
    assert.ok(await frame.locator(".suggest-list input:checked").count() > 0, "some suggestions pre-selected");
    assert.deepEqual(await axe(frame), []);
    const journalBefore = await page.evaluate(() => window.harness.fake.journal.length);
    await frame.locator(".suggest .btn.primary").click();
    await until(async () => (await page.evaluate(() => window.harness.fake.journal.length)) > journalBefore, { message: "applied" });
    const [p] = await page.evaluate(() => window.harness.rpc("listProposals", { status: "all" }));
    assert.equal(p.proposed_by.kind, "jev");
    assert.ok((await page.evaluate(() => window.harness.jev.calls.length)) >= 1);
    await assertClean(page, errors);
  });

  it("without the optional Jev connection the board offers no Jev actions", async () => {
    const { page, frame, errors } = await h.open({ seed: 40, extra: "&jev=0" });
    await inApp(frame, "(app, store) => app.openDetail(store.index().itemList[0], { focus: true })");
    assert.equal(await frame.getByRole("button", { name: "Suggest" }).count(), 0);
    await assert.rejects(page.evaluate(() => window.harness.rpc("triage", "TW-1")), /not_connected/);
    await assertClean(page, errors);
  });
});

describe("agent skill", () => {
  it("every SKILL.md recipe runs verbatim against the harness server RPC", async () => {
    const { page } = await h.open({ seed: 300 });
    const skill = readFileSync(new URL("../src/SKILL.md", import.meta.url), "utf8");
    const recipes = [...skill.matchAll(/```js\n\/\/ Recipe: ([^\n]+)\n([\s\S]*?)```/g)].map((m) => ({ name: m[1], code: m[2] }));
    assert.equal(recipes.length, 8);
    for (const r of recipes) {
      const out = await page.evaluate(async (code) => {
        const WorkBoard = new Proxy({}, { get: (_t, m) => async (...args) => structuredClone(await window.harness.rpc(m, ...structuredClone(args))) });
        const fn = new (Object.getPrototypeOf(async function () {}).constructor)("env", code);
        try { return { ok: true, value: await fn({ WorkBoard }) }; } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
      }, r.code);
      assert.ok(out.ok, `${r.name}: ${out.error}`);
      console.log(`# recipe "${r.name}": ${JSON.stringify(out.value).slice(0, 160)}`);
    }
  });
});
