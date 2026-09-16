// Multi-user end-to-end tests against the local harness: the real built client (dist/client.js)
// in side-by-side iframes, over the real board core (src/core) in the parent page.
//
//   node scripts/build.mjs && node --test e2e/harness.test.mjs
//
// Screenshots go to $HARNESS_SHOTS (default: /tmp/harness-shots).

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import * as h from "./harness-helpers.mjs";

const SHOTS = process.env.HARNESS_SHOTS || "/tmp/harness-shots";

/** @type {Awaited<ReturnType<typeof h.startHarnessServer>>} */
let server;
/** @type {import("playwright").Browser} */
let browser;

before(async () => {
  await mkdir(SHOTS, { recursive: true });
  server = await h.startHarnessServer({ port: Number(process.env.HARNESS_PORT || 8790) });
  browser = await h.launch();
});

after(async () => {
  await browser?.close();
  server?.stop();
});

/**
 * Opens a fresh harness (fresh in-page server) and closes it after `fn`.
 * @param {Parameters<typeof h.openHarness>[2]} opts
 * @param {(ctx: Awaited<ReturnType<typeof h.openHarness>>) => Promise<void>} fn
 */
async function withHarness(opts, fn) {
  const ctx = await h.openHarness(browser, server.url, opts);
  try {
    await fn(ctx);
    assert.deepEqual(ctx.errors.filter((e) => !/favicon/.test(e)), [], "no console errors");
  } catch (err) {
    await ctx.page.screenshot({ path: `${SHOTS}/failure-${Date.now()}.png` }).catch(() => {});
    throw err;
  } finally {
    await ctx.context.close();
  }
}

/** @param {import("playwright").Page} page */
function serverBoard(page) {
  return page.evaluate(() => window.harness.getBoard());
}

describe("kanban harness", { concurrency: false }, () => {
  test("1. a card created in A appears in B within a second", async () => {
    await withHarness({ names: ["Alice Adams", "Bob Brown"] }, async ({ page, frames: { A, B } }) => {
      // Presence avatars: each pane sees the other.
      await A.locator('.avatars .avatar[title="Bob Brown"]').waitFor({ timeout: 5000 });
      await B.locator('.avatars .avatar[title="Alice Adams"]').waitFor({ timeout: 5000 });
      const started = Date.now();
      await h.addCard(A, "Backlog", "Set up laptop");
      await h.card(B, "Set up laptop").waitFor({ timeout: 1000 });
      assert.ok(Date.now() - started < 1500);
      // Rapid entry: the composer keeps focus.
      await A.locator(".composer-input").pressSequentially("Order monitor");
      await A.locator(".composer-input").press("Enter");
      await h.card(B, "Order monitor").waitFor({ timeout: 1000 });
      assert.deepEqual(await h.titles(B, "Backlog"), ["Set up laptop", "Order monitor"]);
      await page.screenshot({ path: `${SHOTS}/01-create.png` });
    });
  });

  test("2. drag and drop: within a column, between columns, concurrent drags, column reorder", async () => {
    await withHarness({}, async ({ page, frames: { A, B } }) => {
      for (const t of ["One", "Two", "Three"]) await h.addCard(A, "Backlog", t);
      await h.addCard(A, "To do", "Tee");
      await h.card(B, "Tee").waitFor();

      // Within a column: Three to the top of Backlog.
      await h.dragTo(page, h.card(A, "Three"), await h.topOf(h.card(A, "One")));
      await h.until(async () => (await h.titles(B, "Backlog")).join() === "Three,One,Two", { message: "B sees reorder" });
      assert.deepEqual(await h.titles(A, "Backlog"), ["Three", "One", "Two"]);

      // Between columns: One into To do before Tee, from pane B.
      await h.dragTo(page, h.card(B, "One"), await h.topOf(h.card(B, "Tee")));
      await h.until(async () => (await h.titles(A, "To do")).join() === "One,Tee", { message: "A sees cross-column move" });
      assert.deepEqual(await h.titles(A, "Backlog"), ["Three", "Two"]);

      // Concurrent: with 400 ms latency, A and B each drag a different card before either
      // change reaches the other.
      await page.evaluate(() => window.harness.setLatency(400));
      await h.dragTo(page, h.card(A, "Two"), await h.endOf(h.column(A, "In progress")), {
        hold: async () => {
          // While A holds the drag, B sees the dashed ghost once presence arrives.
          await h.card(B, "Two").and(B.locator(".peer-drag")).waitFor({ timeout: 3000 });
          await page.screenshot({ path: `${SHOTS}/02-drag-ghost.png` });
        },
      });
      await h.dragTo(page, h.card(B, "Tee"), await h.topOf(h.card(B, "Three")));
      await page.evaluate(() => window.harness.setLatency(0));
      const expected = { Backlog: "Tee,Three", "To do": "One", "In progress": "Two" };
      for (const f of [A, B]) {
        for (const [col, want] of Object.entries(expected)) {
          await h.until(async () => (await h.titles(f, col)).join() === want, { timeout: 5000, message: `${col} = ${want}` });
        }
      }
      assert.equal(await A.locator(".card.peer-drag").count(), 0, "ghost cleared");

      // Column reorder by header drag: In progress before Backlog.
      const target = await h.column(A, "Backlog").locator(".column-head").boundingBox();
      await h.dragTo(page, h.column(A, "In progress").locator(".column-head .count"), { x: target.x + 20, y: target.y + 15 });
      for (const f of [A, B]) {
        await h.until(async () => (await h.columnNames(f)).join() === "In progress,Backlog,To do,Done", { message: "column order" });
      }
      const board = await serverBoard(page);
      assert.deepEqual(board.columnOrder.map((id) => board.columns[id].name), ["In progress", "Backlog", "To do", "Done"]);

      // Escape cancels a drag.
      const box = await h.card(A, "Two").boundingBox();
      await page.mouse.move(box.x + 20, box.y + 10);
      await page.mouse.down();
      await page.mouse.move(box.x + 300, box.y + 40, { steps: 5 });
      await page.keyboard.press("Escape");
      await page.mouse.up();
      assert.deepEqual(await h.titles(A, "In progress"), ["Two"]);
      await A.locator(".drag-ghost").waitFor({ state: "detached" });
      await page.screenshot({ path: `${SHOTS}/02-after-drags.png` });
    });
  });

  test("3. same-title edits: the second saver gets the conflict banner; Keep mine and Use theirs", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames: { A, B } }) => {
      await h.addCard(A, "Backlog", "Original");
      await h.card(B, "Original").waitFor();
      await h.card(A, "Original").click();
      await h.card(B, "Original").click();
      const titleA = A.locator(".panel .panel-title");
      const titleB = B.locator(".panel .panel-title");

      async function race(valueA, valueB) {
        await page.evaluate(() => window.harness.setLatency(600));
        await titleA.fill(valueA);
        await titleA.press("Enter");
        await titleB.fill(valueB);
        await titleB.press("Enter");
        const banner = B.locator(".panel .conflict-banner");
        await banner.waitFor({ timeout: 5000 });
        await page.evaluate(() => window.harness.setLatency(0));
        assert.match(await banner.innerText(), /Someone else changed this card/);
        assert.match(await banner.innerText(), new RegExp(valueA));
        return banner;
      }

      // Keep mine
      let banner = await race("Alice title", "Bob title");
      await page.screenshot({ path: `${SHOTS}/03-conflict.png` });
      await banner.locator(".keep-mine").click();
      await banner.waitFor({ state: "detached" });
      await h.card(A, "Bob title").waitFor({ timeout: 3000 });
      await h.card(B, "Bob title").waitFor({ timeout: 3000 });
      await h.until(async () => (await titleA.inputValue()) === "Bob title", { message: "A's open panel follows" });

      // Use theirs
      banner = await race("Alice again", "Bob again");
      await banner.locator(".use-theirs").click();
      await banner.waitFor({ state: "detached" });
      await h.until(async () => (await titleB.inputValue()) === "Alice again", { message: "B takes theirs" });
      await h.card(B, "Alice again").waitFor();
      await h.card(A, "Alice again").waitFor();
      const board = await serverBoard(page);
      assert.deepEqual(Object.values(board.cards).map((c) => c.title), ["Alice again"]);
    });
  });

  test("4. presence ring follows an open card and disappears when the tab dies", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames: { A, B } }) => {
      await h.addCard(A, "To do", "Watched");
      await h.card(B, "Watched").waitFor();
      await h.card(A, "Watched").click();
      const ringed = h.card(B, "Watched").and(B.locator(".peer-open"));
      await ringed.waitFor({ timeout: 3000 });
      assert.equal(await ringed.locator('.peer-badges .avatar[title="Alice"]').count(), 1);
      await page.screenshot({ path: `${SHOTS}/04-ring.png` });

      // Closing the panel clears the ring.
      await A.locator(".panel").press("Escape");
      await h.card(B, "Watched").and(B.locator(".peer-open")).waitFor({ state: "detached", timeout: 3000 });
      await h.card(A, "Watched").click();
      await ringed.waitFor({ timeout: 3000 });

      const killedAt = Date.now();
      await page.evaluate(() => window.harness.killPane("A"));
      await ringed.waitFor({ state: "detached", timeout: 15_000 });
      await B.locator('.avatars .avatar[title="Alice"]').waitFor({ state: "detached", timeout: 15_000 - (Date.now() - killedAt) });
      assert.ok(Date.now() - killedAt < 15_000);
    });
  });

  for (const dispose of [false, true]) {
    test(`6. restart ${dispose ? "+ dispose" : "(no dispose)"}: both panes keep syncing, no lost edit`, async () => {
      await withHarness({ query: "&downtime=800" }, async ({ page, frames: { A, B } }) => {
        await h.addCard(A, "Backlog", "Before restart");
        await h.card(B, "Before restart").waitFor();
        await page.evaluate((d) => window.harness.restart({ dispose: d }), dispose);
        // An edit made while the server is down.
        await h.addCard(B, "To do", "During restart");
        await h.card(A, "During restart").waitFor({ timeout: 15_000 });
        await h.waitLive(A);
        await h.waitLive(B);
        await h.addCard(A, "Done", "After restart");
        await h.card(B, "After restart").waitFor({ timeout: 10_000 });
        await h.addCard(B, "Done", "After restart B");
        await h.card(A, "After restart B").waitFor({ timeout: 10_000 });
        const board = await serverBoard(page);
        const titles = Object.values(board.cards).map((c) => c.title).sort();
        assert.deepEqual(titles, ["After restart", "After restart B", "Before restart", "During restart"]);
        const subs = await page.evaluate(() => window.harness.subscribers().length);
        assert.equal(subs, 2);
        // A recoverable restart must not make the panes reload themselves.
        assert.deepEqual(await page.evaluate(() => [window.harness.paneLoads("A"), window.harness.paneLoads("B")]), [1, 1]);
      });
    });
  }

  test("8a. export pane renders a static board", async () => {
    await withHarness({}, async ({ page, frames: { A } }) => {
      await h.addCard(A, "Backlog", "Exported card");
      await h.card(A, "Exported card").click();
      await A.locator(".panel .description").fill("Line one\nLine two");
      await A.locator(".panel .check-add input").fill("First step");
      await A.locator(".panel .check-add input").press("Enter");
      await A.locator(".panel .label-toggle", { hasText: "Bug" }).click();
      await A.locator(".panel .assignee-input").fill("Sam");
      await A.locator(".panel .assignee-input").press("Tab");
      await A.locator(".panel").press("Escape");
      await h.until(async () => {
        const b = await serverBoard(page);
        const c = Object.values(b.cards)[0];
        return c?.assignee === "Sam" && c.checklist.length === 1 && c.labels.length === 1 && c.description.includes("two");
      }, { message: "card saved" });
      const id = await page.evaluate(() => window.harness.addPane({ exportFormat: "html" }));
      const E = h.pane(page, id);
      await E.locator(".export h3", { hasText: "Exported card" }).waitFor({ timeout: 10_000 });
      const text = await E.locator(".export").innerText();
      for (const want of ["Backlog", "Line two", "First step", "Bug", "Sam", "Checklist: 0/1"]) assert.ok(text.includes(want), want);
      assert.equal(await E.locator("button, input, textarea, select").count(), 0, "no controls");
      await page.screenshot({ path: `${SHOTS}/08-export.png` });
    });
  });

  test("8b. filters and search dim non-matching cards", async () => {
    await withHarness({}, async ({ page, frames: { A, B } }) => {
      for (const t of ["Fix login", "Write docs", "Fix logout"]) await h.addCard(A, "Backlog", t);
      await h.card(A, "Fix login").click();
      await A.locator(".panel .label-toggle", { hasText: "Bug" }).click();
      await A.locator(".panel .assignee-input").fill("Sam");
      await A.locator(".panel .assignee-input").press("Tab");
      await A.locator(".panel").press("Escape");
      await h.card(B, "Fix login").locator(".chip", { hasText: "Bug" }).waitFor();

      const dimmed = async (f) => (await f.locator(".board .card.dim .card-title").allInnerTexts()).sort();
      await B.locator(".label-filter").selectOption({ label: "Bug" });
      assert.deepEqual(await dimmed(B), ["Fix logout", "Write docs"]);
      assert.equal(await h.column(B, "Backlog").locator(".count").innerText(), "1/3");
      assert.deepEqual(await dimmed(A), [], "filters are per viewer");
      await B.locator(".label-filter").selectOption("");
      await B.locator(".assignee-filter").selectOption({ label: "Sam" });
      assert.deepEqual(await dimmed(B), ["Fix logout", "Write docs"]);
      await B.locator(".assignee-filter").selectOption("");
      await B.locator(".search-input").fill("fix");
      assert.deepEqual(await dimmed(B), ["Write docs"]);
      await page.screenshot({ path: `${SHOTS}/08-filter.png` });
      await B.locator(".clear-filters").click();
      assert.deepEqual(await dimmed(B), []);
      const board = await serverBoard(page);
      assert.equal(Object.keys(board.cards).length, 3);
    });
  });

  test("8c. phone width shows a tab strip and one column at a time", async () => {
    await withHarness({ panes: 1, viewport: { width: 400, height: 800 } }, async ({ page, frames: { A } }) => {
      await A.locator(".tabs").waitFor();
      assert.equal(await A.locator(".board section.column:visible").count(), 1);
      assert.equal(await A.locator(".board section.column:visible .column-name").innerText(), "Backlog");
      await h.addCard(A, "Backlog", "Phone card");
      await A.locator('.tabs .tab', { hasText: "To do" }).click();
      assert.equal(await A.locator(".board section.column:visible .column-name").innerText(), "To do");
      await h.addCard(A, "To do", "Second phone card");
      await page.screenshot({ path: `${SHOTS}/08-mobile.png` });
      await h.card(A, "Second phone card").click();
      const panel = await A.locator(".panel").boundingBox();
      const frameBox = await page.locator('iframe[data-pane="A"]').boundingBox();
      assert.ok(Math.abs(panel.width - frameBox.width) < 2, "panel is full width");
      await page.screenshot({ path: `${SHOTS}/08-mobile-panel.png` });
    });
  });

  test("8g. touch drag reorders cards on a phone", async () => {
    await withHarness({ panes: 1, viewport: { width: 400, height: 800 }, hasTouch: true }, async ({ page, frames: { A } }) => {
      for (const t of ["First", "Second", "Third"]) await h.addCard(A, "Backlog", t);
      await A.locator(".composer-input").press("Escape");
      const cdp = await page.context().newCDPSession(page);
      const src = await h.card(A, "Third").boundingBox();
      const dst = await h.card(A, "First").boundingBox();
      const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", {
        type, touchPoints: type === "touchEnd" ? [] : [{ x, y }],
      });
      let x = src.x + 40;
      let y = src.y + 12;
      await touch("touchStart", x, y);
      // Sideways first (vertical panning is left to the browser), then up to the first card.
      for (let i = 0; i < 6; i++) await touch("touchMove", (x += 5), y);
      const targetY = dst.y + 6;
      for (let i = 1; i <= 10; i++) await touch("touchMove", x, y + ((targetY - y) * i) / 10);
      await touch("touchEnd", x, targetY);
      await h.until(async () => (await h.titles(A, "Backlog")).join() === "Third,First,Second", { message: "touch reorder" });
      const board = await serverBoard(page);
      const order = Object.values(board.cards).sort((a, b) => (a.order < b.order ? -1 : 1)).map((c) => c.title);
      assert.deepEqual(order, ["Third", "First", "Second"]);
    });
  });

  test("8d. comments appear live in the other pane", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames: { A, B } }) => {
      await h.addCard(A, "Backlog", "Discuss");
      await h.card(A, "Discuss").click();
      await A.locator(".panel .comment-input").fill("First!");
      await A.locator(".panel .comment-form .comment-send").click();
      await A.locator(".panel .comment-text", { hasText: "First!" }).waitFor();
      await h.card(B, "Discuss").click();
      await B.locator(".panel .comment-text", { hasText: "First!" }).waitFor({ timeout: 3000 });
      await B.locator(".panel .comment-input").fill("Reply from Bob");
      await B.locator(".panel .comment-input").press("Control+Enter");
      await A.locator(".panel .comment-text", { hasText: "Reply from Bob" }).waitFor({ timeout: 2000 });
      assert.equal(await A.locator(".panel .comment").count(), 2);
      assert.equal(await B.locator(".panel .comment").count(), 2);
      await page.screenshot({ path: `${SHOTS}/08-comments.png` });
    });
  });

  test("8f. a server validation error shows a dismissable toast", async () => {
    await withHarness({ panes: 1 }, async ({ page, frames: { A } }) => {
      // Fill the board to the 50-column limit behind the client's back.
      await page.evaluate(async () => {
        const b = await window.harness.getBoard();
        for (let i = b.columnOrder.length; i < 50; i++) await window.harness.rpc("addColumn", { name: "Col " + i, by: "Agent" });
      });
      await A.locator(".board .add-column-btn").click();
      await A.locator(".add-column input").fill("One too many");
      await A.locator(".add-column input").press("Enter");
      const toast = A.locator(".toast");
      await toast.waitFor({ timeout: 3000 });
      await page.screenshot({ path: `${SHOTS}/08-toast.png` });
      await toast.getByRole("button", { name: "Dismiss" }).click();
      await toast.waitFor({ state: "detached" });
      await h.until(async () => (await h.columnNames(A)).length === 50, { message: "optimistic column rolled back" });
    });
  });

  test("9. remote changes never clobber what you are typing; keyboard open/close; deleted-card banner", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames: { A, B } }) => {
      await h.addCard(A, "Backlog", "Typing");
      await A.locator(".composer-input").press("Escape");
      await h.card(B, "Typing").waitFor();

      // B is halfway through typing a new card while A adds cards to the same column.
      await h.column(B, "Backlog").locator(".add-card-btn").click();
      await B.locator(".composer-input").pressSequentially("half-typed");
      // (A third party writes through the RPC surface so focus stays in pane B.)
      await page.evaluate(() => window.harness.rpc("addCards", {
        by: "Agent", cards: ["R1", "R2", "R3"].map((title) => ({ column: "Backlog", title })),
      }));
      await h.card(B, "R3").waitFor();
      assert.equal(await B.locator(".composer-input").inputValue(), "half-typed");
      assert.ok(await B.locator(".composer-input").evaluate((el) => el === document.activeElement));
      await B.locator(".composer-input").press("Escape");

      // B types a description while A edits another field of the same card.
      await h.card(B, "Typing").click();
      const desc = B.locator(".panel .description");
      await desc.click();
      await desc.pressSequentially("Bob is writing");
      await page.evaluate(async () => {
        const [c] = await window.harness.rpc("findCards", { text: "Typing" });
        await window.harness.rpc("updateCard", { cardId: c.id, fields: { assignee: "Sam" }, by: "Agent" });
      });
      await h.until(async () => (await B.locator(".panel .assignee-input").inputValue()) === "Sam", { message: "B sees assignee" });
      assert.ok((await desc.inputValue()).startsWith("Bob is writing"));
      assert.ok(await desc.evaluate((el) => el === document.activeElement), "focus kept");
      await desc.pressSequentially(" more");
      await h.until(async () => {
        const c = Object.values((await serverBoard(page)).cards).find((x) => x.title === "Typing");
        return c.assignee === "Sam" && c.description === "Bob is writing more";
      }, { message: "both fields saved", timeout: 5000 });
      assert.equal(await B.locator(".panel .conflict-banner").count(), 0);

      // A deletes the card B has open.
      await h.card(A, "Typing").click();
      await A.locator(".panel .delete-card").click();
      await A.locator(".confirm-dialog [data-confirm]").click();
      const banner = B.locator(".panel .conflict-banner");
      await banner.waitFor({ timeout: 3000 });
      assert.match(await banner.innerText(), /This card was deleted/);
      await banner.getByRole("button", { name: "Close" }).click();
      await B.locator(".panel").waitFor({ state: "detached" });

      // Keyboard: focus a card, Enter opens, Escape closes and restores focus.
      await h.card(B, "R1").focus();
      await h.card(B, "R1").press("Enter");
      await B.locator(".panel").waitFor();
      await B.locator(".panel").press("Escape");
      await B.locator(".panel").waitFor({ state: "detached" });
      assert.ok(await h.card(B, "R1").evaluate((el) => el === document.activeElement));
    });
  });

  test("10. keyboard moves: panel Move to / Top / Bottom, Alt+Arrow on a card, column menu Move left", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames: { A, B } }) => {
      for (const t of ["One", "Two", "Three"]) await h.addCard(A, "Backlog", t);
      await A.locator(".composer-input").press("Escape");
      await h.card(B, "Three").waitFor();

      // Panel: Move to another column, then back (lands at the bottom), then Top and Bottom.
      await h.card(A, "Two").click();
      const panel = A.locator(".panel");
      await panel.waitFor();
      assert.ok(await A.locator(".app").evaluate((el) => !!el.closest("[inert]")), "board is inert behind the panel");
      const labelledBy = await panel.getAttribute("aria-labelledby");
      assert.equal(await A.locator(`[id="${labelledBy}"]`).inputValue(), "Two", "panel is named by its title field");
      await panel.locator(".move-select").selectOption({ label: "Done" });
      await h.until(async () => (await h.titles(B, "Done")).join() === "Two", { message: "B sees Two in Done" });
      assert.deepEqual(await h.titles(A, "Backlog"), ["One", "Three"]);
      await panel.locator(".move-select").selectOption({ label: "Backlog" });
      await h.until(async () => (await h.titles(B, "Backlog")).join() === "One,Three,Two", { message: "Two back at the bottom" });
      await panel.locator(".move-top").click();
      await h.until(async () => (await h.titles(B, "Backlog")).join() === "Two,One,Three", { message: "Top" });
      await panel.locator(".move-bottom").click();
      await h.until(async () => (await h.titles(B, "Backlog")).join() === "One,Three,Two", { message: "Bottom" });
      await panel.press("Escape");
      await panel.waitFor({ state: "detached" });
      assert.ok(!(await A.locator(".app").evaluate((el) => !!el.closest("[inert]"))), "inert removed after close");
      assert.equal((await h.focused(A)).cardTitle, "Two", "focus back on the card");

      // Alt+Arrow on the focused card; focus follows the card.
      await h.card(A, "Two").press("Alt+ArrowUp");
      await h.until(async () => (await h.titles(A, "Backlog")).join() === "One,Two,Three", { message: "Alt+Up" });
      assert.equal((await h.focused(A)).cardTitle, "Two");
      await h.card(A, "Two").press("Alt+ArrowRight");
      await h.until(async () => (await h.titles(A, "To do")).join() === "Two", { message: "Alt+Right" });
      assert.deepEqual(await h.focused(A).then((f) => [f.cardTitle, f.columnName]), ["Two", "To do"]);
      await h.card(A, "Two").press("Alt+ArrowLeft");
      await h.until(async () => (await h.titles(A, "Backlog")).join() === "Two,One,Three", { message: "Alt+Left lands at the same index" });
      assert.equal((await h.focused(A)).cardTitle, "Two");
      await h.card(A, "Two").press("Alt+ArrowDown");
      await h.until(async () => (await h.titles(A, "Backlog")).join() === "One,Two,Three", { message: "Alt+Down" });
      await h.card(A, "Two").press("Alt+ArrowDown");
      await h.until(async () => (await h.titles(B, "Backlog")).join() === "One,Three,Two", { message: "Alt+Down reaches B" });
      assert.equal((await h.focused(A)).cardTitle, "Two");
      // The live region is filled after a short gap so a repeated message is still announced.
      await h.until(async () => /Two/.test(await h.liveText(A)), { message: "move announced" });

      // Column menu: Move left, focus stays on that column's menu button.
      await h.column(A, "To do").locator(".col-menu-btn").click();
      await A.getByRole("menuitem", { name: "Move left" }).click();
      for (const f of [A, B]) {
        await h.until(async () => (await h.columnNames(f)).join() === "To do,Backlog,In progress,Done", { message: "column moved left" });
      }
      const f = await h.focused(A);
      assert.ok(f.className.includes("col-menu-btn") && f.columnName === "To do", "focus on the moved column's menu button");

      const board = await serverBoard(page);
      const backlog = board.columnOrder.find((id) => board.columns[id].name === "Backlog");
      const order = Object.values(board.cards).filter((c) => c.columnId === backlog)
        .sort((a, b) => (a.order < b.order ? -1 : 1)).map((c) => c.title);
      assert.deepEqual(order, ["One", "Three", "Two"]);
    });
  });

  test("11. focus stays with a card a peer moves, and falls back to Add card when a peer deletes it", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames: { A } }) => {
      for (const t of ["Alpha", "Beta"]) await h.addCard(A, "Backlog", t);
      await A.locator(".composer-input").press("Escape");
      await h.card(A, "Alpha").focus();
      assert.equal((await h.focused(A)).cardTitle, "Alpha");

      // A third party moves it (RPC, so no other pane takes focus).
      const cardId = await page.evaluate(async () => {
        const [c] = await window.harness.rpc("findCards", { text: "Alpha" });
        await window.harness.rpc("moveCard", { cardId: c.id, toColumn: "Done", by: "Agent" });
        return c.id;
      });
      await h.until(async () => (await h.titles(A, "Done")).join() === "Alpha", { message: "A sees the move" });
      await h.until(async () => {
        const f = await h.focused(A);
        return f.cardTitle === "Alpha" && f.columnName === "Done";
      }, { message: "focus followed the moved card" });
      await h.until(async () => /Alpha|Agent/.test(await h.liveText(A)), { message: "move announced" });

      // Now it is deleted: focus lands on that column's Add card button.
      await page.evaluate((id) => window.harness.rpc("deleteCard", { cardId: id, by: "Agent" }), cardId);
      await h.card(A, "Alpha").waitFor({ state: "detached" });
      await h.until(async () => {
        const f = await h.focused(A);
        return f.className.includes("add-card-btn") && f.columnName === "Done";
      }, { message: "focus on Done's Add card" });
      await h.until(async () => /Alpha|Agent/.test(await h.liveText(A)), { message: "delete announced" });
    });
  });

  test("12. label chips have at least 4.5:1 text contrast", async () => {
    await withHarness({ panes: 1 }, async ({ frames: { A } }) => {
      await h.addCard(A, "Backlog", "Colourful");
      await A.locator(".composer-input").press("Escape");
      await h.card(A, "Colourful").click();
      const toggles = A.locator(".panel .label-toggle");
      await toggles.first().waitFor();
      const n = await toggles.count();
      assert.ok(n > 0, "default labels exist");
      for (let i = 0; i < n; i++) {
        const toggle = toggles.nth(i);
        if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
        await h.until(async () => (await toggles.nth(i).getAttribute("aria-pressed")) === "true", { message: `label ${i} on` });
      }
      // Selected toggles in the panel are filled chips too.
      const pressed = await toggles.evaluateAll((els) => els.map((el) => {
        const cs = getComputedStyle(el);
        return { name: el.textContent, color: cs.color, background: cs.backgroundColor };
      }));
      await A.locator(".panel").press("Escape");
      const chips = h.card(A, "Colourful").locator(".chip");
      await h.until(async () => (await chips.count()) === n, { message: "all chips on the card" });
      const colours = await chips.evaluateAll((els) => els.map((el) => {
        const cs = getComputedStyle(el);
        return { name: el.textContent, color: cs.color, background: cs.backgroundColor };
      }));
      for (const c of [...colours, ...pressed]) {
        const ratio = h.contrastRatio(c.color, c.background);
        assert.ok(ratio >= 4.5, `${c.name}: ${c.color} on ${c.background} is ${ratio.toFixed(2)}:1`);
      }
    });
  });

  test("8e. undo from the activity panel", async () => {
    await withHarness({}, async ({ page, frames: { A, B } }) => {
      await h.addCard(A, "Backlog", "Keep me");
      await h.card(B, "Keep me").waitFor();
      await h.card(A, "Keep me").click();
      await A.locator(".panel .delete-card").click();
      await A.locator(".confirm-dialog [data-confirm]").click();
      await h.card(B, "Keep me").waitFor({ state: "detached", timeout: 3000 });
      await A.locator(".activity-toggle").click();
      const first = A.locator(".activity .activity-item").first();
      await first.waitFor();
      assert.match(await first.innerText(), /Keep me/);
      await page.screenshot({ path: `${SHOTS}/08-activity.png` });
      await first.locator(".undo-btn").click();
      await h.card(A, "Keep me").waitFor({ timeout: 3000 });
      await h.card(B, "Keep me").waitFor({ timeout: 3000 });
    });
  });

  test("9a. no form submission needed: name dialog (button and Enter), add column, checklist add", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames: { A, B } }) => {
      // The panes are sandboxed without allow-forms (like the platform), and openHarness already
      // joined both through the Join board button. Now join through Enter.
      await page.evaluate(() => window.harness.reloadPane("B"));
      const input = B.locator(".name-dialog .name-input");
      await input.waitFor({ timeout: 10_000 });
      await input.fill("Bobby Enter");
      await input.press("Enter");
      await input.waitFor({ state: "detached", timeout: 3000 });
      await h.waitLive(B);
      await A.locator('.avatars .avatar[title="Bobby Enter"]').waitFor({ timeout: 5000 });

      // Add column through its button.
      await A.locator(".add-column-btn").click();
      await A.locator('.add-column input[aria-label="New column name"]').fill("Review");
      await A.locator(".add-column .add-column-submit").click();
      await h.column(B, "Review").waitFor({ timeout: 3000 });

      // Checklist item and label through their buttons; card through the composer's button.
      const col = h.column(A, "Backlog");
      await col.locator(".add-card-btn").click();
      await col.locator(".composer-input").fill("Button card");
      await col.locator(".composer-add").click();
      await h.card(B, "Button card").waitFor({ timeout: 3000 });
      await col.locator(".composer-input").press("Escape");
      await h.card(A, "Button card").click();
      await A.locator(".panel .check-add input").fill("Via button");
      await A.locator(".panel .check-add button").click();
      await A.locator(".panel .new-label input").fill("Needs QA");
      await A.locator(".panel .new-label button", { hasText: "Create label" }).click();
      await h.until(async () => {
        const b = await serverBoard(page);
        const c = Object.values(b.cards).find((x) => x.title === "Button card");
        const label = Object.values(b.labels).find((l) => l.name === "Needs QA");
        return c?.checklist.some((i) => i.text === "Via button") && label && c.labels.includes(label.id);
      }, { message: "checklist item and label saved" }).catch(async (e) => {
        const b = await serverBoard(page);
        throw new Error(e.message + " " + JSON.stringify({ cards: Object.values(b.cards), labels: b.labels }));
      });
    });
  });

  test("9b. restart with stale stubs (platform behaviour): panes reload themselves and keep their names", async () => {
    await withHarness({ names: ["Alice Adams", "Bob Brown"] }, async ({ page, frames: { A, B } }) => {
      await h.addCard(A, "Backlog", "Before stale restart");
      await h.card(B, "Before stale restart").waitFor();
      const started = Date.now();
      await page.evaluate(() => window.harness.restart({ staleStub: true }));
      await h.until(() => page.evaluate(() => window.harness.paneLoads("A") >= 2 && window.harness.paneLoads("B") >= 2),
        { timeout: 20_000, message: "both panes reloaded" });
      await h.waitLive(A);
      await h.waitLive(B);
      const recoveredMs = Date.now() - started;
      assert.ok(await page.evaluate(() => window.harness.staleRejections) > 0, "stale stubs were exercised");
      // Names carried across the reload in window.name: no dialog, same avatars.
      assert.equal(await A.locator(".name-dialog").count(), 0);
      assert.equal(await B.locator(".name-dialog").count(), 0);
      await A.locator('.avatars .avatar[title="Bob Brown"]').waitFor({ timeout: 5000 });
      await B.locator('.avatars .avatar[title="Alice Adams"]').waitFor({ timeout: 5000 });
      await h.card(B, "Before stale restart").waitFor();
      await h.addCard(B, "To do", "After stale restart");
      await h.card(A, "After stale restart").waitFor({ timeout: 5000 });
      await h.addCard(A, "Done", "After stale restart A");
      await h.card(B, "After stale restart A").waitFor({ timeout: 5000 });
      assert.deepEqual(await page.evaluate(() => [window.harness.paneLoads("A"), window.harness.paneLoads("B")]), [2, 2],
        "exactly one self-reload per pane");
      console.log(`# 9b recovered in ${recoveredMs} ms`);
    });
  });
});
