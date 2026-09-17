// Multi-user end-to-end tests against the local harness: the real built client (dist/client.js)
// in side-by-side iframes, over the real Wave core (src/core) and a fake Model in the parent page.
//
//   node scripts/build.mjs && node --test e2e/harness.test.mjs
//
// Screenshots go to $HARNESS_SHOTS (default: /tmp/wave-harness-shots). Numbered tests are the
// harness equivalents of the platform tests in docs/plans/wave-blueprint-implementation-1.md
// section 5.6 (T8, T9, T12 and T13 need the real platform and live in platform.test.mjs).

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import * as h from "./harness-helpers.mjs";

const { SEL, until, sleep } = h;
const SHOTS = h.SHOTS;

/** @type {Awaited<ReturnType<typeof h.startHarnessServer>>} */
let server;
/** @type {import("playwright").Browser} */
let browser;

before(async () => {
  await mkdir(SHOTS, { recursive: true });
  server = await h.startHarnessServer();
  browser = await h.launch();
});

after(async () => {
  await browser?.close();
  server?.stop();
});

/**
 * Opens a fresh harness (fresh in-page server) and closes it after `fn`. Console errors fail the
 * test unless they match one of `ignore`.
 * @param {Parameters<typeof h.openHarness>[2]} opts
 * @param {(ctx: Awaited<ReturnType<typeof h.openHarness>>) => Promise<void>} fn
 * @param {{ignore?: RegExp[]}} [extra]
 */
async function withHarness(opts, fn, { ignore = [] } = {}) {
  const ctx = await h.openHarness(browser, server.url, opts);
  try {
    await fn(ctx);
    const bad = ctx.errors.filter((e) => !/favicon/.test(e) && !ignore.some((re) => re.test(e)));
    assert.deepEqual(bad, [], "no console errors");
  } catch (err) {
    await ctx.page.screenshot({ path: `${SHOTS}/failure-${Date.now()}.png` }).catch(() => {});
    if (ctx.errors.length) console.log("# console errors:", ctx.errors.slice(0, 10));
    throw err;
  } finally {
    await ctx.context.close();
  }
}

/** Every token of `wanted` appears in `text`, in order (a subsequence); returns the missing ones. */
function missingInOrder(text, wanted) {
  let from = 0;
  const missing = [];
  for (const w of wanted) {
    const i = text.indexOf(w, from);
    if (i === -1) missing.push(w);
    else from = i + w.length;
  }
  return missing;
}

/** Tokens of `wanted` that occur more than once in `text` (Re-insert must not repeat saved text). */
function repeated(text, wanted) {
  return wanted.filter((w) => text.split(w).length - 1 > 1);
}

/** Ids of the blips with a given kind in the server's snapshot. */
async function blipsOfKind(page, kind) {
  const wave = await h.serverWave(page);
  return Object.values(wave.blips).filter((b) => b.kind === kind && !b.deleted).map((b) => b.id);
}

describe("wave harness", { concurrency: false }, () => {
  test("0. boots under account names with no name prompt; no <form>; templates on first open, first pick wins", async () => {
    await withHarness({ names: ["Alice", "Bob"], template: null }, async ({ page, frames: { A, B } }) => {
      // openHarness checked both panes run under their account names without a dialog. The Wave
      // is empty: the picker shows.
      for (const f of [A, B]) {
        await f.locator(".template-btn").first().waitFor({ timeout: 10_000 });
        assert.equal(await f.locator("form").count(), 0, "no <form> in the client");
      }
      const offered = await A.locator(".template-btn").evaluateAll((els) => els.map((el) => el.getAttribute("data-template")));
      for (const id of ["blank", "decision", "design_review", "retrospective", "incident_review"]) {
        assert.ok(offered.includes(id), `template ${id} offered (${offered})`);
      }
      await page.screenshot({ path: `${SHOTS}/00-templates.png` });
      await h.pickTemplate(A, "decision");
      await B.locator(".template-btn").first().waitFor({ state: "hidden", timeout: 10_000 });
      const wave = await h.serverWave(page);
      assert.equal(wave.meta.template, "decision");
      const briefs = await blipsOfKind(page, "brief");
      assert.equal(briefs.length, 1, "one pinned brief");
      const notes = await blipsOfKind(page, "note");
      assert.ok(notes.length >= 2, `starter threads (${notes.length})`);
      for (const f of [A, B]) {
        await h.card(f, briefs[0]).waitFor({ timeout: 5000 });
        assert.equal(await f.locator('.wave-blip[data-kind="brief"]').count(), 1);
      }
      // B reloads and comes back under its account name, without being asked.
      await page.evaluate(() => window.harness.reloadPane("B"));
      await until(() => page.evaluate(() => window.harness.paneLoads("B") >= 2), { message: "B reloaded" });
      await h.waitLive(B);
      await h.expectAccountName(B, "Bob");
      assert.equal(await B.locator(".template-btn:visible").count(), 0, "no picker once a template is applied");
      await h.openPanel(A, "people");
      await h.peerNamed(A, "Bob").waitFor({ timeout: 5000 });
      assert.equal(await B.locator("form").count(), 0);
      await page.screenshot({ path: `${SHOTS}/00-joined.png` });
    });
  });

  test("0b. account names: a new pane has its own, the People tab and me button change only the colour", async () => {
    await withHarness({ panes: 1, names: ["Alice"] }, async ({ page, frames: { A } }) => {
      // A pane added later starts under its own account name ("User B"), also without a dialog.
      const paneId = await page.evaluate(() => window.harness.addPane());
      const B = h.pane(page, paneId);
      await h.waitLive(B);
      await h.expectAccountName(B, `User ${paneId}`);
      await h.openPanel(A, "people");
      await h.peerNamed(A, `User ${paneId}`).waitFor({ timeout: 5000 });
      assert.equal(await A.locator(".change-name-btn").count(), 0, "no Change name button");

      // The me button opens a colour-only dialog: no name field; the name stays the account's.
      await A.locator(".me-btn").click();
      const dialog = A.locator(SEL.colorDialog);
      await dialog.waitFor();
      assert.equal(await dialog.locator("input, textarea, [contenteditable]").count(), 0, "no name field in the colour dialog");
      assert.equal(await A.locator(SEL.namePrompt).count(), 0);
      assert.equal(await dialog.locator(".color-dialog-name").innerText(), "Alice");
      const before = await h.inPane(A, (store) => store.getState().viewer.color);
      await dialog.locator('.swatch[aria-checked="false"]').first().click();
      await dialog.locator(".save-btn").click();
      await dialog.waitFor({ state: "detached" });
      const after = await until(async () => {
        const c = await h.inPane(A, (store) => store.getState().viewer.color);
        return c !== before && c;
      }, { message: "A's colour changed" });
      await h.expectAccountName(A, "Alice");
      await until(() => h.inPane(B, (store, _, color) =>
        [...store.getState().peers.values()].some((p) => p.name === "Alice" && p.color === color), after),
      { message: "the other pane sees Alice with her new colour" });

      // The People tab's own button opens the same colour-only dialog.
      await A.locator(".change-color-btn").click();
      await dialog.waitFor();
      assert.equal(await dialog.locator("input, textarea, [contenteditable]").count(), 0);
      await dialog.locator("button", { hasText: "Cancel" }).click();
      await dialog.waitFor({ state: "detached" });
      await h.expectAccountName(A, "Alice");
    });
  });

  test("0c. attribution: blips, decisions, proposal reviews, participants and events carry the account name", async () => {
    await withHarness({ names: ["Ada Lovelace", "Grace Hopper"] }, async ({ page, frames: { A, B } }) => {
      const root = await h.inPane(A, (store) => store.createBlip({ parentId: null, text: "Which approach?" }));
      await h.waitCard(page, [A, B], root);
      const reply = await h.inPane(B, (store, _, pid) => store.createBlip({ parentId: pid, text: "Option B." }), root);
      // Replies may sit in a collapsed thread: wait for the stores, not the cards.
      const inStores = (/** @type {string} */ id) => until(async () => {
        for (const f of [A, B]) if (!(await h.inPane(f, (store, _, bid) => !!store.getState().blips[bid], id))) return false;
        return true;
      }, { timeout: 10_000, message: `${id} in both stores` });
      await inStores(reply);
      const decision = await h.inPane(B, (store, _, threadId) =>
        store.recordDecision({ threadId, text: "We choose option B.", rationale: "Cheaper." }).then((r) => r.blip?.id ?? JSON.stringify(r)), root);
      assert.match(decision, /^b_/, "decision recorded");
      const proposal = (await h.rpc(page, "propose", { targetId: reply, quote: "", replacement: "Option B, revised.", summary: "Revise", sources: [reply] })).blip.id;
      await inStores(proposal);
      const review = await h.inPane(A, (store, _, pid) => store.reviewProposal(pid, "reject").then((r) => r.status ?? r.error), proposal);
      assert.ok(review && review !== "failed", `review: ${review}`);

      const wave = await until(async () => {
        const w = await h.serverWave(page);
        return w.blips[root] && w.blips[reply] && w.blips[decision] && w.blips[proposal]?.proposal?.reviewedBy && w;
      }, { message: "everything saved" });
      assert.equal(wave.blips[root].by, "Ada Lovelace");
      assert.equal(wave.blips[reply].by, "Grace Hopper");
      assert.equal(wave.blips[decision].by, "Grace Hopper");
      assert.equal(wave.blips[decision].decision.recordedBy, "Grace Hopper");
      assert.equal(wave.blips[proposal].proposal.reviewedBy, "Ada Lovelace");
      const participants = wave.meta.participants.map((p) => p.name).sort();
      assert.deepEqual(participants, ["Ada Lovelace", "Grace Hopper"], "participants are the accounts");
      assert.equal(await h.inPane(B, (store, _, id) => store.getState().blips[id]?.by, root), "Ada Lovelace", "B's copy is attributed to Ada");
      const { events } = await h.inPane(A, (store) => store.getChanges(0, 200));
      const bys = new Set(events.filter((e) => e.by !== "agent" && e.by !== "Agent").map((e) => e.by));
      assert.ok(bys.has("Ada Lovelace") && bys.has("Grace Hopper"), "events by both accounts: " + JSON.stringify([...bys]));
      assert.ok([...bys].every((by) => by === "Ada Lovelace" || by === "Grace Hopper"), "no Guest events: " + JSON.stringify([...bys]));
    });
  });

  test("1. interleaved typing in one blip (with latency) converges to the same text everywhere", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames: { A, B } }) => {
      const id = await h.createBlip(page, { text: "Start." });
      await h.waitCard(page, [A, B], id);
      await page.evaluate(() => window.harness.setLatency(150));
      await h.openEditor(A, id);
      await h.openEditor(B, id);
      const aWords = [], bWords = [];
      for (let i = 0; i < 8; i++) {
        aWords.push(`alpha${i}`);
        bWords.push(`bravo${i}`);
        await h.typeInto(A, id, ` alpha${i}`, { delay: 10, at: "keep" });
        await h.typeInto(B, id, ` bravo${i}`, { delay: 10, at: "keep" });
      }
      await page.screenshot({ path: `${SHOTS}/01-interleaved.png` });
      await h.closeEditor(A);
      await h.closeEditor(B);
      await h.waitSaved(A, id);
      await h.waitSaved(B, id);
      await page.evaluate(() => window.harness.setLatency(0));
      const serverText = await until(async () => {
        const [s, a, b] = await Promise.all([h.serverText(page, id), h.readText(A, id), h.readText(B, id)]);
        return s === a && s === b ? s : null;
      }, { timeout: 10_000, message: "A, B and the server agree" });
      assert.ok(serverText.startsWith("Start."), serverText);
      assert.deepEqual(missingInOrder(serverText, aWords), [], "every word Alice typed, in order");
      assert.deepEqual(missingInOrder(serverText, bWords), [], "every word Bob typed, in order");
      assert.equal(serverText.length, "Start.".length + [...aWords, ...bWords].reduce((n, w) => n + w.length + 1, 0), "nothing duplicated");
      assert.equal(await h.readBody(A, id), await h.readBody(B, id), "read views agree");
    });
  });

  test("2. Bob's caret is visible in Alice's editor and stays on the same character while Alice types above it", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames: { A, B } }) => {
      const text = "Line one\nLine two\ntarget line";
      const id = await h.createBlip(page, { text });
      await h.waitCard(page, [A, B], id);
      const edA = await h.openEditor(A, id);
      const edB = await h.openEditor(B, id);
      await edB.focus();
      await edB.press("Control+Home");
      await edB.press("ArrowDown");
      await edB.press("ArrowDown");
      const want = text.indexOf("target");
      assert.equal(await edB.evaluate((el) => el.selectionStart), want, "Bob's caret sits before 'target'");
      const bobId = await h.clientId(B);
      const caret = h.own(A, id, "remoteCaret").first();
      await caret.waitFor({ timeout: 5000 });
      const y0 = (await caret.boundingBox()).y;
      const edBox = await edA.boundingBox();
      assert.ok(y0 >= edBox.y && y0 <= edBox.y + edBox.height, "caret drawn inside Alice's editor");
      const head0 = await until(async () => (await page.evaluate(() => window.harness.subscribers())).find((s) => s.clientId === bobId)?.head,
        { message: "Bob's presence carries a head position" });
      assert.equal(await page.evaluate(({ id, head }) => window.harness.absoluteIndex(id, head), { id, head: head0 }), want);
      await page.screenshot({ path: `${SHOTS}/02-caret-before.png` });

      await edA.focus();
      await edA.press("Control+Home");
      const inserted = "Inserted first line\n";
      await edA.pressSequentially(inserted, { delay: 10 });
      await h.waitSaved(A, id);
      const newText = inserted + text;
      await h.waitForText(B, id, newText.slice(0, 30));
      const newWant = newText.indexOf("target");
      await until(async () => (await edB.evaluate((el) => el.selectionStart)) === newWant, { message: "Bob's own caret restored on 'target'" });
      await until(async () => {
        const head = (await page.evaluate(() => window.harness.subscribers())).find((s) => s.clientId === bobId)?.head;
        return head && (await page.evaluate(({ id, head }) => window.harness.absoluteIndex(id, head), { id, head })) === newWant;
      }, { message: "Bob's shared caret resolves to 'target' after the insert" });
      const y1 = await until(async () => { const b = await caret.boundingBox(); return b && b.y > y0 + 6 ? b.y : null; },
        { message: "Alice's copy of Bob's caret moved down with the text" });
      assert.ok(y1 - y0 < 80, `moved by about one line (${y1 - y0}px)`);
      await page.screenshot({ path: `${SHOTS}/02-caret-after.png` });
    });
  });

  test("3. a reply after paragraph 2 stays after paragraph 2 when the parent's first paragraph is edited", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames: { A, B } }) => {
      const text = "Para one is here.\n\nPara two is here.\n\nPara three is here.";
      const parent = await h.createBlip(page, { text });
      await h.waitCard(page, [A, B], parent);
      const parentCard = h.card(B, parent);
      await parentCard.hover();
      const gutter = h.own(B, parent, "paraReplyButton");
      await until(async () => (await gutter.count()) >= 3, { message: "one Reply-after-paragraph button per paragraph" });
      await gutter.nth(1).click();
      const composer = B.locator(SEL.blipEditor).first();
      await composer.waitFor({ timeout: 5000 });
      await composer.pressSequentially("Reply to two", { delay: 10 });
      const reply = await until(async () => Object.values((await h.serverWave(page)).blips)
        .find((b) => b.parentId === parent && b.anchor?.type === "para"), { timeout: 10_000, message: "the reply exists from the first keystroke" });
      await composer.press("Control+Enter");
      await until(async () => (await h.serverText(page, reply.id)) === "Reply to two", { message: "reply text saved" });
      const at = (t) => page.evaluate(({ id, pos }) => window.harness.absoluteIndex(id, pos), { id: parent, pos: reply.anchor.pos });
      assert.equal(await at(), text.indexOf("Para two"), "anchor at the start of paragraph 2");
      await h.waitCard(page, [A, B], reply.id);

      await h.typeInto(A, parent, "Edited: ", { at: "start", delay: 10 });
      await h.closeEditor(A);
      await h.waitSaved(A, parent);
      const edited = "Edited: " + text;
      await h.waitForText(B, parent, "Edited: Para one");
      assert.equal(await at(), edited.indexOf("Para two"), "anchor followed paragraph 2");

      // Rendered position in Bob's pane: after paragraph 2, before paragraph 3.
      await until(async () => (await h.readBody(B, parent)).startsWith("Edited:"), { message: "Bob's read view updated" });
      const paras = h.own(B, parent, "blocks"); // the parent's own paragraphs, not the reply's
      await until(async () => (await paras.count()) >= 3, { message: "three paragraphs rendered" });
      const p2 = await paras.nth(1).boundingBox();
      const p3 = await paras.nth(2).boundingBox();
      const r = await h.card(B, reply.id).boundingBox();
      assert.ok(r && p2 && p3, "boxes available");
      assert.ok(r.y >= p2.y + p2.height - 2, `reply (${r.y}) below paragraph 2 (${p2.y + p2.height})`);
      assert.ok(r.y <= p3.y + 2, `reply (${r.y}) above paragraph 3 (${p3.y})`);
      await page.screenshot({ path: `${SHOTS}/03-paragraph-reply.png` });
    });
  });

  test("3b. phone layout: card actions and paragraph replies are styled buttons at least 44 px tall; a nested paragraph's hover shows only its own reply button", async () => {
    await withHarness({ panes: 1, names: ["Alice"], viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, async ({ page, frames: { A } }) => {
      const id = await h.createBlip(page, { text: "First paragraph.\n\nSecond paragraph." });
      await h.waitCard(page, [A], id);
      const controls = await h.card(A, id).evaluate((card) => [...card.querySelectorAll(":scope > .blip-actions > button, :scope > .blip-actions > .blip-menu-wrap > .more-btn, :scope > .blip-body .para-reply-btn")].map((b) => {
        const r = b.getBoundingClientRect();
        return { cls: b.className, width: r.width, height: r.height, frameWidth: window.innerWidth };
      }));
      assert.ok(controls.length >= 4, `card controls found: ${JSON.stringify(controls)}`);
      assert.ok(controls[0].frameWidth < 720, `phone layout (frame ${controls[0].frameWidth} px wide)`);
      for (const c of controls) {
        assert.ok(c.height >= 44, `${c.cls}: ${c.width}x${c.height} is at least 44 px tall`);
        if (!/para-reply-btn/.test(c.cls)) assert.match(c.cls, /(^|\s)btn(\s|$)/, `${c.cls} carries .btn`);
      }
      const more = controls.find((c) => /more-btn/.test(c.cls));
      assert.ok(more && more.width >= 44, `the More button is at least 44 px wide: ${JSON.stringify(more)}`);
      await h.openEditor(A, id);
      const done = await A.locator(SEL.doneButton).first().boundingBox();
      assert.ok(done && done.height >= 44, `Done is at least 44 px tall (${done?.height})`);
      await h.closeEditor(A);
      await page.screenshot({ path: `${SHOTS}/03b-phone.png` });
    });
    await withHarness({ panes: 1, names: ["Alice"] }, async ({ page, frames: { A } }) => {
      const parent = await h.createBlip(page, { text: "Parent one.\n\nParent two." });
      await h.waitCard(page, [A], parent);
      // A reply anchored to the parent's first paragraph renders inside that paragraph.
      await h.own(A, parent, "blocks").first().hover();
      await h.own(A, parent, "paraReplyButton").first().click();
      const composer = A.locator(`${SEL.blipEditor}[data-composer]`).first();
      await composer.waitFor({ timeout: 5000 });
      await composer.pressSequentially("Nested one.\n\nNested two.");
      await h.closeEditor(A);
      const reply = await until(async () => Object.values((await h.serverWave(page)).blips).find((b) => b.parentId === parent && b.anchor?.type === "para"),
        { timeout: 10_000, message: "the paragraph reply exists" });
      await h.waitForText(A, reply.id, "Nested one.\n\nNested two.");
      const shown = () => A.locator("body").evaluate(() => [...document.querySelectorAll(".para-reply-btn")]
        .filter((b) => getComputedStyle(b).opacity !== "0").map((b) => `${b.closest(".wave-blip")?.getAttribute("data-bid")}:${b.getAttribute("aria-label")}`));
      await h.own(A, reply.id, "blocks").first().hover();
      await until(async () => (await shown()).length > 0, { message: "hovering the nested paragraph shows a reply button" });
      assert.deepEqual(await shown(), [`${reply.id}:Reply to paragraph 1`], "only the hovered paragraph's own button shows, not the parent paragraph's");
      await h.own(A, parent, "blocks").first().hover();
      await until(async () => JSON.stringify(await shown()) === JSON.stringify([`${parent}:Reply to paragraph 1`]), { message: "hovering the parent paragraph shows its button" });
    });
  });

  test("4. stale-stub restart mid-typing: the pane reloads itself, acknowledged text is intact, unsaved text is offered back", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames: { A, B } }) => {
      const id = await h.createBlip(page, { text: "Base." });
      await h.waitCard(page, [A, B], id);
      await page.evaluate(() => window.harness.setLatency(300));
      const words = Array.from({ length: 14 }, (_, i) => `w${i + 1}x`);
      await h.openEditor(A, id);
      for (const w of words.slice(0, 10)) await h.typeInto(A, id, ` ${w}`, { delay: 15, at: "keep" });
      const acked = await h.serverText(page, id);
      await page.evaluate(() => window.harness.restart({ staleStub: true }));
      // Typed while the stub is dead: these pushes can only be pending.
      for (const w of words.slice(10)) await h.typeInto(A, id, ` ${w}`, { delay: 15, at: "keep" }).catch(() => {});
      await until(() => page.evaluate(() => window.harness.paneLoads("A") >= 2), { timeout: 25_000, message: "pane A reloaded itself" });
      await h.waitLive(A);
      await h.expectAccountName(A, "Alice");
      assert.ok(await page.evaluate(() => window.harness.staleRejections) > 0, "stale stubs were exercised");
      await page.evaluate(() => window.harness.setLatency(0));
      const afterReload = await h.serverText(page, id);
      assert.ok(afterReload.startsWith(acked), `acknowledged text intact: ${JSON.stringify(acked)} is a prefix of ${JSON.stringify(afterReload)}`);
      await page.screenshot({ path: `${SHOTS}/04-after-reload.png` });

      const offer = A.getByText(/Re-insert unsaved text/);
      const complete = () => h.serverText(page, id).then((t) => missingInOrder(t, words).length === 0);
      if (!(await complete())) {
        await offer.first().waitFor({ timeout: 10_000 });
        await offer.first().click();
        await until(complete, { timeout: 10_000, message: "the unsaved words are back on the server" });
      }
      const final = await h.serverText(page, id);
      assert.deepEqual(missingInOrder(final, words), [], "no typed word was lost");
      assert.deepEqual(repeated(final, ["Base.", ...words]), [], `no text repeated by Re-insert: ${JSON.stringify(final)}`);
      assert.equal(final, ["Base.", ...words].join(" "), "the blip reads exactly as typed");
      await sleep(500); // a late push must not repeat anything either
      assert.equal(await h.serverText(page, id), final, "stable after Re-insert");
      await h.waitForText(B, id, final, { timeout: 10_000 });
    });
  });

  test("4b. a manual frame reload mid-typing: acknowledged text is intact, unsaved text is offered back (platform T4)", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames: { A, B } }) => {
      const id = await h.createBlip(page, { text: "Base." });
      await h.waitCard(page, [A, B], id);
      const words = Array.from({ length: 6 }, (_, i) => `m${i + 1}x`);
      await h.openEditor(A, id);
      for (const w of words.slice(0, 3)) await h.typeInto(A, id, ` ${w}`, { delay: 15, at: "keep" });
      await h.waitSaved(A, id);
      const acked = await h.serverText(page, id);
      // Slow calls, so the last words cannot be acknowledged before the reload.
      await page.evaluate(() => window.harness.setLatency(1000));
      for (const w of words.slice(3)) await h.typeInto(A, id, ` ${w}`, { delay: 0, at: "keep" });
      await page.evaluate(() => window.harness.reloadPane("A"));
      await until(() => page.evaluate(() => window.harness.paneLoads("A") >= 2), { message: "A reloaded" });
      await page.evaluate(() => window.harness.setLatency(0));
      await h.waitLive(A);
      await h.expectAccountName(A, "Alice");
      assert.ok((await h.serverText(page, id)).startsWith(acked), "acknowledged text intact");
      const complete = () => h.serverText(page, id).then((t) => missingInOrder(t, words).length === 0);
      if (!(await complete())) {
        const offer = A.getByText(/Re-insert unsaved text/);
        await offer.first().waitFor({ timeout: 10_000 });
        await offer.first().click();
        await until(complete, { timeout: 10_000, message: "the unsaved words are back on the server" });
      } else {
        console.log("# 4b every push was acknowledged before the reload; the Re-insert path was not exercised");
      }
      await sleep(1500); // pushes that were still in flight at the reload have landed by now
      const final = await h.serverText(page, id);
      assert.deepEqual(repeated(final, ["Base.", ...words]), [], `no text repeated by Re-insert: ${JSON.stringify(final)}`);
      assert.equal(final, ["Base.", ...words].join(" "), "the blip reads exactly as typed");
      await h.waitForText(B, id, final, { timeout: 10_000 });
    });
  });

  test("5. History mode replays the blip in order; the scrubber at its end equals the live text", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames: { A, B } }) => {
      const id = await h.createBlip(page, { text: "v1." });
      await h.waitCard(page, [A, B], id);
      for (const chunk of [" v2.", " v3.", " v4."]) {
        await h.typeInto(A, id, chunk, { delay: 10 });
        await h.closeEditor(A);
        await h.waitSaved(A, id);
        await sleep(100);
      }
      const live = "v1. v2. v3. v4.";
      await h.waitForText(B, id, live);
      const liveBody = await h.readBody(B, id);

      await B.locator(SEL.historyToggle).click();
      await B.locator(SEL.historyBanner).waitFor({ timeout: 5000 });
      assert.match(await B.locator(SEL.historyBanner).innerText(), /Viewing history/);
      const scrubber = B.locator(SEL.historyScrubber);
      await scrubber.waitFor({ timeout: 5000 });
      await scrubber.focus();
      await scrubber.press("End");
      await until(async () => (await h.readBody(B, id)).trim() === liveBody.trim(), { message: "scrubber end = live text" });
      assert.equal(await h.card(B, id).locator(SEL.editButton).count(), 0, "editing off in History mode");
      // Stepping back never makes the text longer, every point shows a prefix of the live text
      // (the chunks were appended), and the start is older than the end. Before the blip's create
      // the card is not shown (counts as ""). From its create step on it shows at least the text it
      // was created with: the create and the seeded text are one commit, so History never shows
      // this blip as "(empty)".
      const changes = await h.rpc(page, "getChanges", { afterSeq: 0, limit: 1000 });
      const createSeq = changes.events.find((e) => e.kind === "blip.create" && e.blipId === id)?.seq;
      assert.ok(createSeq, "the blip's create event is retained");
      const replayed = async () => {
        if (!(await h.card(B, id).count())) return "";
        assert.equal(await h.own(B, id, "body").locator(":scope > .blip-empty").count(), 0, "a blip created with text is never shown empty");
        return (await h.readBody(B, id)).trim();
      };
      let prev = (await replayed()).length;
      let sawCreateStep = false;
      // At least 12 steps (as before), and on until the create step has been seen.
      for (let i = 0; i < 12 || (i < 80 && !sawCreateStep); i++) {
        await scrubber.press("ArrowLeft");
        await sleep(120);
        const at = Number(await scrubber.inputValue());
        if (at === createSeq) {
          await until(async () => (await replayed()) === "v1.", { message: `the create step (seq ${at}) shows the seeded text "v1."` });
          sawCreateStep = true;
        }
        const text = await replayed();
        assert.ok(text.length <= prev, `step ${i}: ${text.length} <= ${prev}`);
        assert.ok(liveBody.trim().startsWith(text), `step ${i}: ${JSON.stringify(text)} is a prefix of the live text`);
        if (at >= createSeq) assert.ok(text.startsWith("v1."), `step ${i} (seq ${at}, created at ${createSeq}): ${JSON.stringify(text)} shows the seeded text`);
        prev = text.length;
      }
      assert.ok(sawCreateStep, `the scrubber passed the create step (seq ${createSeq})`);
      await scrubber.press("Home");
      await until(async () => (await replayed()) !== liveBody.trim(), { message: "the earliest point differs from live" });
      await page.screenshot({ path: `${SHOTS}/05-history.png` });
      await scrubber.press("End");
      await until(async () => (await h.readBody(B, id)).trim() === liveBody.trim(), { message: "end again equals live" });
      await scrubber.press("Escape");
      // Escape returns to live: the banner is hidden (it stays in the DOM), the toggle unpressed.
      await B.locator(SEL.historyBanner).waitFor({ state: "hidden", timeout: 5000 });
      assert.equal(await B.locator(SEL.historyToggle).getAttribute("aria-pressed"), "false", "back to live");
      assert.equal(await h.readText(B, id), live);
    });
  });

  test("6. a killed pane's caret and editing chip vanish within 15 s", async () => {
    await withHarness({ panes: 3, names: ["Alice", "Bob", "Carol"] }, async ({ page, frames: { A, B, C } }) => {
      const id = await h.createBlip(page, { text: "Shared text." });
      await h.waitCard(page, [A, B, C], id);
      await h.typeInto(C, id, " carol", { delay: 10 });
      const chip = h.own(A, id, "editingChip").filter({ hasText: "Carol" });
      await chip.first().waitFor({ timeout: 5000 });
      await h.openEditor(A, id);
      const caret = h.own(A, id, "remoteCaret");
      await caret.first().waitFor({ timeout: 5000 });
      await h.openPanel(A, "people");
      await h.peerNamed(A, "Carol").waitFor({ timeout: 5000 });
      await page.screenshot({ path: `${SHOTS}/06-before-kill.png` });
      const killedAt = Date.now();
      await page.evaluate(() => window.harness.killPane("C"));
      await caret.first().waitFor({ state: "detached", timeout: 15_000 });
      await chip.first().waitFor({ state: "detached", timeout: Math.max(1, 15_000 - (Date.now() - killedAt)) });
      const took = Date.now() - killedAt;
      await h.peerNamed(A, "Carol").waitFor({ state: "detached", timeout: Math.max(1, 15_000 - took) });
      console.log(`# 6 caret and chip gone ${took} ms after the kill`);
      assert.equal((await h.serverText(page, id)), "Shared text. carol", "Carol's committed text stays");
      assert.equal(await B.locator(SEL.editingChip).filter({ hasText: "Carol" }).count(), 0);
    });
  });

  test("7. a 15,000-character blip stays responsive and each push is small", async () => {
    await withHarness({ names: ["Alice", "Bob"], seed: { blips: 1, chars: 15_000 } }, async ({ page, frames: { A, B } }) => {
      const [id] = Object.keys((await h.serverWave(page)).blips);
      await h.waitCard(page, [A, B], id);
      const before = await h.serverText(page, id);
      assert.ok(before.length >= 14_900, `seeded ${before.length} chars`);
      await until(async () => (await h.readBody(B, id)).length > 10_000, { timeout: 10_000, message: "Bob renders the long blip" });
      const ed = await h.openEditor(A, id);
      await ed.focus();
      await ed.press("Control+End");
      await page.evaluate(() => window.harness.clearCallLog());
      const typed = " The end of a long story is still typed one key at a time";
      const t0 = Date.now();
      await ed.pressSequentially(typed, { delay: 25 });
      const typingMs = Date.now() - t0;
      await h.closeEditor(A);
      await h.waitSaved(A, id);
      const pushes = await page.evaluate(() => window.harness.callLog({ method: "pushText" }));
      const bytes = pushes.map((p) => p.bytes);
      console.log(`# 7 typed ${typed.length} chars in ${typingMs} ms; ${pushes.length} pushes, bytes max ${Math.max(...bytes)} sum ${bytes.reduce((a, b) => a + b, 0)}`);
      assert.ok(pushes.length >= 1, "at least one push");
      assert.ok(Math.max(...bytes) < 2048, `each push far below the document (max ${Math.max(...bytes)} bytes on wire)`);
      assert.ok(bytes.reduce((a, b) => a + b, 0) < 8192, "all pushes together far below the document");
      assert.ok(typingMs < typed.length * 25 + 4000, `typing did not stall (${typingMs} ms)`);
      const after = await h.serverText(page, id);
      assert.equal(after, before + typed);
      await h.waitForText(B, id, typed.slice(-20), { timeout: 10_000 });
      await page.screenshot({ path: `${SHOTS}/07-long-blip.png` });
    });
  });

  test("10. Ask agent (fake model): an agent blip with valid sources; a stale proposal cannot be accepted; a double Accept applies once", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames: { A, B } }) => {
      const root = await h.createBlip(page, { text: "Which onboarding approach?\n\nOption A: white-glove." });
      const optionB = (await h.rpc(page, "reply", { parentId: root, text: "Option B: self-serve." })).blip.id;
      await h.waitCard(page, [A, B], optionB);

      // Summarise through the UI.
      await A.locator(SEL.askAgentButton).click();
      await A.locator(SEL.askAgentItem("summarise")).click();
      await h.openPanel(A, "agent");
      const run = await until(async () => {
        const wave = await h.serverWave(page);
        return wave.runs.find((r) => r.state === "done" || r.state === "failed") ?? null;
      }, { timeout: 15_000, message: "the run finished" });
      assert.equal(run.state, "done", run.error ?? "");
      await A.locator(SEL.runCard(run.id)).waitFor({ timeout: 5000 });
      assert.equal(await A.locator(SEL.runCard(run.id)).getAttribute("data-state"), "done");
      const wave = await h.serverWave(page);
      const agentBlip = wave.blips[run.resultBlipId];
      assert.equal(agentBlip?.kind, "agent");
      const known = new Set(Object.keys(wave.blips));
      assert.ok(run.scope.blipIds.length >= 1);
      // Asked from the header with no thread focused, the scope is the whole Wave, so the agent
      // blip is a new root (README: "at the end of the scoped thread, or a new root"), not part
      // of the root thread. The model-facing Markdown of the result's own thread carries it.
      const md = await h.rpc(page, "getWaveMarkdown", { threadId: run.resultBlipId });
      assert.ok(md.includes(`[${run.resultBlipId}] agent`), `the agent blip is labelled in getWaveMarkdown: ${md.slice(0, 400)}`);
      assert.match(md, /Evidence/);
      const agentText = await h.serverText(page, run.resultBlipId);
      assert.match(agentText, /Evidence/);
      const cited = agentText.match(/b_[0-9a-f]{12}/g) ?? [];
      assert.ok(cited.length >= 1 && cited.every((c) => known.has(c)), `sources are known blips: ${cited}`);
      await h.waitCard(page, [A, B], run.resultBlipId);
      assert.equal(await h.card(B, run.resultBlipId).getAttribute("data-kind"), "agent");
      assert.equal(await page.evaluate(() => window.harness.model.calls.length), 1);
      await page.screenshot({ path: `${SHOTS}/10-agent-blip.png` });

      // A proposal against a blip that is edited afterwards.
      const p1 = (await h.rpc(page, "propose", {
        targetId: root, quote: "", replacement: "Which approach?\n\nOption A: white-glove, revised.", summary: "Tighten the question", sources: [root, optionB],
      })).blip;
      assert.ok(p1?.id, "proposal created");
      await h.waitCard(page, [A, B], p1.id);
      await h.card(B, p1.id).locator(SEL.proposalAccept).waitFor({ timeout: 5000 });
      await h.typeInto(A, root, " (edited)", { delay: 10 });
      await h.closeEditor(A);
      await h.waitSaved(A, root);
      const staleCard = h.card(B, p1.id);
      await until(async () => /based on an older version/i.test(await staleCard.innerText()), { timeout: 10_000, message: "Bob's proposal card says it is based on an older version" });
      const accept = staleCard.locator(SEL.proposalAccept);
      const acceptUsable = (await accept.count()) > 0 && await accept.first().isEnabled();
      assert.equal(acceptUsable, false, "Accept is not offered for a proposal based on an older version");
      await staleCard.getByText(/Regenerate/).first().waitFor({ timeout: 5000 });
      assert.ok(await staleCard.locator(SEL.proposalReject).count(), "Reject still offered");
      await page.screenshot({ path: `${SHOTS}/10-stale-proposal.png` });

      // A double Accept from two panes applies once.
      const p2 = (await h.rpc(page, "propose", {
        targetId: optionB, quote: "", replacement: "Option B: self-serve, revised.", summary: "Revise option B", sources: [optionB],
      })).blip;
      // A proposal is a reply to its target; option B is itself a reply, so the proposal sits one
      // level deeper and is collapsed under "1 more reply" (deeper levels collapse by design).
      // Expand it in both panes, as a reviewer would, and wait for the card.
      for (const f of [A, B]) {
        await until(async () => (await h.card(f, p2.id).count()) > 0 || (await h.own(f, optionB, "expandButton").count()) > 0,
          { timeout: 10_000, message: "the proposal or its collapsed-thread button shows" });
        if (!(await h.card(f, p2.id).count())) await h.own(f, optionB, "expandButton").click();
      }
      await h.waitCard(page, [A, B], p2.id);
      await h.card(B, p2.id).locator(SEL.proposalAccept).waitFor({ timeout: 5000 });
      await page.evaluate(() => window.harness.setLatency(200));
      const results = await Promise.all([A, B].map((f) => h.inPane(f, (store, _, pid) => store.reviewProposal(pid, "accept").then((r) => r.status ?? r.error), p2.id)));
      await page.evaluate(() => window.harness.setLatency(0));
      assert.equal(results.filter((s) => s === "applied").length, 1, `exactly one applied: ${results}`);
      assert.ok(results.includes("conflict") || results.includes("stale"), `the other one was refused: ${results}`);
      assert.equal(await h.serverText(page, optionB), "Option B: self-serve, revised.", "applied once");
      const final = await h.serverWave(page);
      assert.equal(final.blips[p2.id].proposal.state, "accepted");
      await h.waitForText(A, optionB, "revised.");
      await h.waitForText(B, optionB, "revised.");
    });
  });

  test("11. three panes typing for 20 s: RPC calls per second under 45; remote text visible within 1 s", async () => {
    await withHarness({ panes: 3, names: ["Alice", "Bob", "Carol"] }, async ({ page, frames }) => {
      const { A, B, C } = frames;
      const id = await h.createBlip(page, { text: "Shared:" });
      await h.waitCard(page, [A, B, C], id);
      const eds = { A: await h.openEditor(A, id), B: await h.openEditor(B, id), C: await h.openEditor(C, id) };
      for (const ed of Object.values(eds)) { await ed.focus(); await ed.press("Control+End"); }
      await page.evaluate(() => window.harness.clearCallLog());
      const t0 = Date.now();
      const start = await page.evaluate(() => window.harness.now());
      const probes = [];
      const tokens = { A: [], B: [], C: [] };
      let i = 0;
      while (Date.now() - t0 < 20_000) {
        for (const [k, ed] of Object.entries(eds)) {
          const word = ` ${k.toLowerCase()}${i}`;
          tokens[k].push(word.trim());
          await ed.pressSequentially(word, { delay: 30 });
        }
        if (i % 6 === 5) {
          const token = `zq${i}q`;
          tokens.A.push(token);
          const sent = Date.now();
          await eds.A.pressSequentially(` ${token}`, { delay: 30 });
          await until(async () => (await eds.B.inputValue()).includes(token), { timeout: 5000, interval: 20, message: `probe ${token} visible in B` });
          probes.push(Date.now() - sent);
        }
        i++;
      }
      const elapsed = (Date.now() - t0) / 1000;
      const calls = await page.evaluate((since) => window.harness.callLog({ since }), start);
      const byMethod = {};
      for (const c of calls) byMethod[c.method] = (byMethod[c.method] ?? 0) + 1;
      const rate = calls.length / elapsed;
      console.log(`# 11 ${calls.length} calls in ${elapsed.toFixed(1)} s = ${rate.toFixed(1)}/s ${JSON.stringify(byMethod)}; probes ${JSON.stringify(h.stats(probes))} ms`);
      assert.ok(rate < 45, `calls per second ${rate.toFixed(1)} < 45`);
      assert.ok(probes.length >= 2 && Math.max(...probes) < 1000, `remote text visible within 1 s (${probes})`);
      for (const f of [A, B, C]) await h.closeEditor(f);
      for (const f of [A, B, C]) await h.waitSaved(f, id);
      const text = await until(async () => {
        const [s, a, b, c] = await Promise.all([h.serverText(page, id), h.readText(A, id), h.readText(B, id), h.readText(C, id)]);
        return s === a && s === b && s === c ? s : null;
      }, { timeout: 15_000, message: "everyone converges" });
      for (const [k, list] of Object.entries(tokens)) assert.deepEqual(missingInOrder(text, list), [], `${k}'s words in order`);
      await page.screenshot({ path: `${SHOTS}/11-three-typists.png` });
    });
  });

  test("14. Markdown export of decisions contains the decision, rationale, dissent, next steps and source ids", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames: { A, B } }) => {
      const root = await h.createBlip(page, { text: "Which onboarding approach?" });
      const evidence = (await h.rpc(page, "reply", { parentId: root, text: "Self-serve is cheaper per customer." })).blip.id;
      await h.waitCard(page, [A, B], evidence);
      const decision = (await h.rpc(page, "recordDecision", {
        threadId: root, text: "We choose option B (self-serve).", rationale: `Lower cost per customer; see ${evidence}.`,
        dissent: "Harry prefers white-glove for the first three customers.", nextSteps: "Alice drafts the onboarding checklist by Friday.",
        by: "Alice",
      })).blip;
      assert.equal(decision?.kind, "decision");
      assert.equal(decision.locked, true);
      await h.waitCard(page, [A, B], decision.id);
      assert.equal(await h.card(B, decision.id).locator(SEL.editButton).count(), 0, "a decision has no Edit");
      await h.openPanel(A, "decisions");
      await A.locator(".decisions, .panel").filter({ hasText: "We choose option B" }).first().waitFor({ timeout: 5000 }).catch(() => {});
      const md = await h.rpc(page, "exportMarkdown", { decisions: true });
      assert.equal(typeof md, "string");
      for (const s of ["We choose option B (self-serve).", "Lower cost per customer", "Harry prefers white-glove", "Alice drafts the onboarding checklist", evidence, root]) {
        assert.ok(md.includes(s), `decision export contains ${JSON.stringify(s)}`);
      }
      assert.match(md, /unverified|Alice/, "records who recorded it");
      const viaStore = await h.inPane(A, (store) => store.exportMarkdown({ decisions: true }));
      assert.equal(viaStore, md, "the store's export is the server's");
      const whole = await h.rpc(page, "exportMarkdown", {});
      assert.ok(whole.includes("We choose option B") && whole.includes("Which onboarding approach?"), "the whole-Wave export has the thread and the decision");
      assert.ok(await A.locator(SEL.exportButton).count(), "Export control present");
      await page.screenshot({ path: `${SHOTS}/14-decision.png` });
    });
  });

  test("15. a restart mid-run leaves the run unknown with Retry; nothing respawns; Retry runs it again", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames: { A, B } }) => {
      await h.createBlip(page, { text: "Something to summarise." });
      const runId = await page.evaluate(() => window.harness.restartMidRun({ delayMs: 3000 }));
      await h.waitLive(A);
      await h.waitLive(B);
      await h.openPanel(A, "agent");
      const cardA = A.locator(SEL.runCard(runId));
      await until(async () => (await cardA.count()) && (await cardA.getAttribute("data-state")) === "unknown",
        { timeout: 15_000, message: "the run card shows unknown after the restart" });
      await cardA.locator(SEL.runRetry).waitFor({ timeout: 5000 });
      assert.match(await cardA.innerText(), /restarted/i, "the card explains the restart");
      const run = (await page.evaluate((id) => window.harness.getRun(id), runId)).run;
      assert.equal(run.state, "unknown");
      assert.equal(run.resultBlipId, undefined);
      await page.screenshot({ path: `${SHOTS}/15-unknown-run.png` });
      // Nothing respawns: the model was called once, and the old call's result never lands.
      await sleep(4500);
      assert.equal(await page.evaluate(() => window.harness.model.calls.length), 1, "no automatic respawn");
      const wave = await h.serverWave(page);
      assert.equal(wave.runs.length, 1, "no second run");
      assert.equal((await blipsOfKind(page, "agent")).length, 0, "the aborted instance's result was not committed");
      assert.equal(wave.runs[0].state, "unknown");

      await cardA.locator(SEL.runRetry).click();
      const retried = await until(async () => (await h.serverWave(page)).runs.find((r) => r.id !== runId) ?? null, { timeout: 10_000, message: "Retry created a new run" });
      assert.equal(await page.evaluate(() => window.harness.model.calls.length), 2);
      const done = await until(async () => { const r = (await page.evaluate((id) => window.harness.getRun(id), retried.id)).run; return r.state === "done" ? r : null; },
        { timeout: 15_000, message: "the retried run finishes" });
      await h.waitCard(page, [A, B], done.resultBlipId);
      assert.equal((await h.serverWave(page)).runs.find((r) => r.id === runId).state, "unknown", "the original stays unknown");
    }, { ignore: [/Durable Object reset/] });
  });

  test("restart (no dispose): panes resync through the heartbeat without reloading; typing continues", async () => {
    await withHarness({ names: ["Alice", "Bob"], query: "&downtime=800" }, async ({ page, frames: { A, B } }) => {
      const id = await h.createBlip(page, { text: "Before." });
      await h.waitCard(page, [A, B], id);
      await page.evaluate(() => window.harness.restart({ dispose: false }));
      await h.typeInto(A, id, " during", { delay: 10 });
      await h.closeEditor(A);
      await h.waitLive(A);
      await h.waitLive(B);
      await h.waitSaved(A, id, 20_000);
      await h.waitForText(B, id, "Before. during", { timeout: 15_000 });
      await h.typeInto(B, id, " after", { delay: 10 });
      await h.closeEditor(B);
      await h.waitForText(A, id, "Before. during after", { timeout: 10_000 });
      assert.equal(await page.evaluate(() => window.harness.subscribers().length), 2);
      assert.deepEqual(await page.evaluate(() => [window.harness.paneLoads("A"), window.harness.paneLoads("B")]), [1, 1], "no reload needed");
    }, { ignore: [/Durable Object reset/] });
  });

  test("no model: capabilities.model is false and Ask agent explains where to add one", async () => {
    await withHarness({ names: ["Alice"], panes: 1, model: "none" }, async ({ page, frames: { A } }) => {
      const state = await h.paneState(A);
      assert.equal(state.capabilities.model, false);
      const res = await h.rpc(page, "askAgent", { op: "summarise" });
      assert.equal(res.error, "no_model");
      await A.locator(SEL.askAgentButton).click();
      await until(async () => /Connections|model/i.test(await A.locator("body").innerText()), { message: "the menu says where to add a model" });
      await page.screenshot({ path: `${SHOTS}/no-model.png` });
    });
  });
});
