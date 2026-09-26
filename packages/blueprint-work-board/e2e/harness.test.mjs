// Harness end-to-end tests: the real built client in the platform's sandboxed frame (capnweb,
// CSP) over the real gadget server and the FakeRecords datastore.
//
//   node scripts/build.mjs && node --test --test-concurrency=1 e2e/harness.test.mjs
//
// Screenshots go to e2e/screenshots/ (gitignored) or $HARNESS_SHOTS. Timings print as "# perf".

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
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
