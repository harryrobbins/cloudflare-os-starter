// Two-browser end-to-end tests of the kanban Board against a REAL local Cloudflare OS Workshop
// (docs/plans/kanban-blueprint.md "Tests (two-browser session)"). See ./README.md section 4.
//
//   e2e/start-local-platform.sh                                   # once; prints PGID + URL
//   pnpm --filter blueprint-kanban pack:gadget                    # from the repo root
//   node --test --test-concurrency=1 e2e/platform.test.mjs        # from packages/blueprint-kanban
//   e2e/stop-local-platform.sh
//
// Env: CFOS_URL (default http://localhost:8787); PLATFORM_SHOTS (screenshot dir, default
// ${TMPDIR:-/tmp}/kanban-platform-shots). Uploads the shipped formats/board.gadget as is.
// Timings are printed and written to $PLATFORM_SHOTS/timings.json. T7 (agent chat) needs a model
// and is not run locally.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as p from "./platform-helpers.mjs";
import * as h from "./harness-helpers.mjs";
import * as k from "./platform-kanban-helpers.mjs";

const BASE = (process.env.CFOS_URL || p.DEFAULT_BASE_URL).replace(/\/$/, "");
const SHOTS = process.env.PLATFORM_SHOTS || join(tmpdir(), "kanban-platform-shots");
const PASSWORD = "correct-horse-battery-staple";
const COLUMNS = ["Backlog", "To do", "In progress", "Done"];
const FORM_BLOCKED = /Blocked form submission/;

/** @type {Record<string, unknown>} */
const timings = {};
/** @type {string[]} */
const notes = [];
const log = (/** @type {string} */ s) => console.log(`[${new Date().toISOString().slice(11, 23)}] ${s}`);

/** @type {import("playwright").Browser} */
let browser;
/** @type {string} */
let workspaceUrl;
/** @type {Awaited<ReturnType<typeof openUser>>} */
let alice;
/** @type {Awaited<ReturnType<typeof openUser>>} */
let bob;
/** @type {{meName: string, namePrompts: number}} */
let aliceIdentity;
/** @type {{meName: string, namePrompts: number}} */
let bobIdentity;
/** Display names of the two local accounts (what `gadgetViewer.displayName` carries). */
const ALICE = k.accountDisplayName("alice");
const BOB = k.accountDisplayName("bob");

/**
 * A signed-in user in their own browser context, with console capture.
 * @param {string} username
 */
async function openUser(username) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  /** @type {string[]} */
  const consoleErrors = [];
  /** @type {string[]} */
  const gadgetConsole = [];
  page.on("console", (m) => {
    const text = m.text();
    if (m.type() === "error") consoleErrors.push(text);
    const where = m.location()?.url ?? "";
    if (where.startsWith("data:") || /client\.js/.test(where)) gadgetConsole.push(`${m.type()}: ${text}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  await p.signUpOrIn(page, BASE, username, PASSWORD);
  return { username, context, page, frame: p.gadgetFrame(page), consoleErrors, gadgetConsole };
}

/**
 * Opens the board at `url` for `user`. Nobody is asked for a name: returns what the board shows.
 * @param {Awaited<ReturnType<typeof openUser>>} user
 * @param {string} url
 */
async function openBoard(user, url) {
  await user.page.goto(url);
  await h.waitLive(user.frame);
  const identity = await k.boardIdentity(user.frame);
  await k.recordConnection(user.frame);
  return identity;
}

/** @param {string} name */
async function shot(name) {
  await Promise.all([alice, bob].filter(Boolean).map((u) =>
    u.page.screenshot({ path: join(SHOTS, `${name}-${u.username}.png`) }).catch(() => {})));
}

/** @param {import("playwright").FrameLocator} f */
async function boardState(f) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const c of COLUMNS) out[c] = await h.titles(f, c);
  return out;
}

/** Time until `fn` is truthy, polling every 20 ms. */
async function timeUntil(/** @type {() => Promise<unknown>} */ fn, /** @type {number} */ timeout, /** @type {string} */ message) {
  const t0 = Date.now();
  await h.until(fn, { timeout, interval: 20, message });
  return Date.now() - t0;
}

/** @param {string} text */
function parseCsv(text) {
  /** @type {string[][]} */
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\r" && text[i + 1] === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

before(async () => {
  await mkdir(SHOTS, { recursive: true });
  browser = await p.launch();
  log(`archive ${k.SHIPPED_ARCHIVE}`);

  alice = await openUser("alice");
  const blueprintId = await p.uploadGadget(alice.page, BASE, k.SHIPPED_ARCHIVE);
  workspaceUrl = await p.createGadgetFromBlueprint(alice.page, BASE, blueprintId);
  log(`workspace ${workspaceUrl}`);
  await h.waitLive(alice.frame);
  aliceIdentity = await k.boardIdentity(alice.frame);
  await k.recordConnection(alice.frame);

  const shareUrl = await p.createUseShareLink(alice.page);
  bob = await openUser("bob");
  bobIdentity = await openBoard(bob, shareUrl);
  await alice.frame.locator(`.avatars .avatar[title="${BOB}"]`).waitFor({ timeout: 15_000 });
  await bob.frame.locator(`.avatars .avatar[title="${ALICE}"]`).waitFor({ timeout: 15_000 });
  log("alice and bob are live on the board");
});

after(async () => {
  timings.notes = notes;
  timings.consoleErrors = { alice: alice?.consoleErrors, bob: bob?.consoleErrors };
  await writeFile(join(SHOTS, "timings.json"), JSON.stringify(timings, null, 2)).catch(() => {});
  console.log("TIMINGS " + JSON.stringify(timings, null, 2));
  await browser?.close();
});

describe("kanban board on the local platform", { concurrency: false }, () => {
  test("0a. the shipped formats/board.gadget client boots in the platform iframe", async () => {
    const user = await openUser("alice");
    try {
      const id = await p.uploadGadget(user.page, BASE, k.SHIPPED_ARCHIVE);
      await p.createGadgetFromBlueprint(user.page, BASE, id);
      const outcome = await Promise.race([
        user.frame.locator(".conn").first().waitFor({ timeout: 30_000 }).then(() => "ui"),
        h.until(async () => user.consoleErrors.find((e) => /Class extends value|gadget/.test(e)), { timeout: 30_000, message: "client error" }),
      ]);
      await user.page.screenshot({ path: join(SHOTS, "0a-shipped-archive.png") });
      assert.equal(outcome, "ui", `shipped client failed to start: ${outcome}`);
      await h.waitLive(user.frame);
      const identity = await k.boardIdentity(user.frame);
      assert.equal(identity.namePrompts, 0, "no name dialog");
      assert.equal(identity.meName, ALICE, "the board shows the account's display name");
    } finally {
      await user.context.close();
    }
  });

  test("0b. nobody is asked for a name: each board shows the signed-in account's display name", () => {
    assert.equal(aliceIdentity.namePrompts, 0, "alice (owner) saw no name dialog");
    assert.equal(bobIdentity.namePrompts, 0, "bob (use-role share link) saw no name dialog");
    assert.equal(aliceIdentity.meName, ALICE, "alice's me button shows her account display name");
    assert.equal(bobIdentity.meName, BOB, "bob's me button shows his account display name");
    for (const u of [alice, bob]) {
      assert.deepEqual(u.consoleErrors.filter((e) => FORM_BLOCKED.test(e)), [], `${u.username}: no blocked form submissions`);
    }
  });

  test("T1. alice creates a card; bob sees it within 3 s", async () => {
    const t0 = Date.now();
    await h.addCard(alice.frame, "Backlog", "T1 card");
    await h.card(bob.frame, "T1 card").waitFor({ timeout: 3000 });
    timings.T1_create_to_bob_ms = Date.now() - t0;
    await alice.frame.locator(".composer-input").press("Escape");
    await shot("t1");
    // And the other way round.
    const t1 = Date.now();
    await h.addCard(bob.frame, "To do", "T1 bob card");
    await h.card(alice.frame, "T1 bob card").waitFor({ timeout: 3000 });
    timings.T1_bob_create_to_alice_ms = Date.now() - t1;
    await bob.frame.locator(".composer-input").press("Escape");
  });

  test("T5. bob (use role) has the board but no code editor, Code tab or Share button", async () => {
    // Sanity: alice (owner) has them.
    assert.equal(await alice.page.getByRole("button", { name: "Share workspace" }).count(), 1);
    assert.equal(await alice.page.getByRole("button", { name: "Code", exact: true }).count(), 1);
    assert.equal(await bob.page.getByRole("button", { name: "Share workspace" }).count(), 0);
    assert.equal(await bob.page.getByRole("button", { name: "Code", exact: true }).count(), 0);
    assert.equal(await bob.page.locator(".monaco-editor").count(), 0);
    assert.equal(await bob.page.getByRole("button", { name: "Export Gadget" }).count(), 1);
    await bob.page.screenshot({ path: join(SHOTS, "t5-bob-use-view.png") });
  });

  test("T2. alice and bob drag different cards at the same time; both land in both browsers", async () => {
    await h.addCard(alice.frame, "Backlog", "Drag A");
    await h.addCard(alice.frame, "Backlog", "Drag B");
    await alice.frame.locator(".composer-input").press("Escape");
    await h.card(bob.frame, "Drag B").waitFor({ timeout: 3000 });
    const toA = await h.endOf(h.column(alice.frame, "In progress"));
    const toB = await h.endOf(h.column(bob.frame, "Done"));
    const t0 = Date.now();
    await Promise.all([
      h.dragTo(alice.page, h.card(alice.frame, "Drag A"), toA),
      h.dragTo(bob.page, h.card(bob.frame, "Drag B"), toB),
    ]);
    const expected = { "In progress": "Drag A", Done: "Drag B" };
    for (const f of [alice.frame, bob.frame]) {
      for (const [col, want] of Object.entries(expected)) {
        await h.until(async () => (await h.titles(f, col)).join() === want, { timeout: 5000, message: `${col} = ${want}` });
      }
      assert.ok(!(await h.titles(f, "Backlog")).some((t) => t.startsWith("Drag")));
    }
    timings.T2_converged_ms = Date.now() - t0;
    assert.deepEqual(await boardState(alice.frame), await boardState(bob.frame));
    await shot("t2");
  });

  test("T3. both edit the same title; the second saver gets the conflict banner and resolves it", async () => {
    await h.addCard(alice.frame, "Backlog", "Conflict");
    await alice.frame.locator(".composer-input").press("Escape");
    await h.card(bob.frame, "Conflict").waitFor({ timeout: 3000 });
    await h.card(alice.frame, "Conflict").click();
    await h.card(bob.frame, "Conflict").click();
    const titleA = alice.frame.locator(".panel .panel-title");
    const titleB = bob.frame.locator(".panel .panel-title");
    const bannerA = alice.frame.locator(".panel .conflict-banner");
    const bannerB = bob.frame.locator(".panel .conflict-banner");

    let resolved = false;
    for (let attempt = 1; attempt <= 6 && !resolved; attempt++) {
      const vA = `Alice title ${attempt}`;
      const vB = `Bob title ${attempt}`;
      await Promise.all([titleA.fill(vA), titleB.fill(vB)]);
      await Promise.all([titleA.press("Enter"), titleB.press("Enter")]);
      const who = await Promise.race([
        bannerA.waitFor({ timeout: 4000 }).then(() => "alice"),
        bannerB.waitFor({ timeout: 4000 }).then(() => "bob"),
      ]).catch(() => null);
      if (!who) {
        // No overlap this time (last writer won); wait for convergence and race again.
        await h.until(async () => (await titleA.inputValue()) === (await titleB.inputValue()), { timeout: 5000, message: "titles converge" });
        notes.push(`T3 attempt ${attempt}: no conflict (writes did not overlap)`);
        continue;
      }
      const [banner, theirs, mineTitle, otherTitle] = who === "bob" ? [bannerB, vA, titleB, titleA] : [bannerA, vB, titleA, titleB];
      const text = await banner.innerText();
      timings.T3_conflict = { attempt, secondSaver: who, banner: text.replace(/\s+/g, " ").slice(0, 160) };
      assert.match(text, /Someone else changed this card/);
      assert.ok(text.includes(theirs), `banner shows the other user's value "${theirs}"`);
      await shot("t3-conflict");
      await banner.locator(".use-theirs").click();
      await banner.waitFor({ state: "detached" });
      await h.until(async () => (await mineTitle.inputValue()) === theirs && (await otherTitle.inputValue()) === theirs,
        { timeout: 5000, message: "both panels show the kept value" });
      await h.card(alice.frame, theirs).waitFor({ timeout: 3000 });
      await h.card(bob.frame, theirs).waitFor({ timeout: 3000 });
      resolved = true;
    }
    await alice.frame.locator(".panel").press("Escape");
    await bob.frame.locator(".panel").press("Escape");
    assert.ok(resolved, "no conflict banner in 6 simultaneous-save attempts");
  });

  test("T8. export: CSV has a header and one row per card; HTML is a static board with the titles", async () => {
    const state = await boardState(alice.frame);
    const cards = Object.entries(state).flatMap(([col, ts]) => ts.map((t) => ({ col, t })));
    const formats = await p.listExportFormats(alice.page);
    timings.T8_formats = formats;
    const csvLabel = formats.find((f) => /^CSV/.test(f));
    assert.ok(csvLabel, "a CSV format is offered");
    const csv = await p.downloadExport(alice.page, csvLabel);
    const rows = parseCsv(csv.text);
    assert.deepEqual(rows[0], ["Column", "Title", "Description", "Labels", "Assignee", "Due", "Checklist done",
      "Checklist total", "Created", "Updated", "Created by", "Card id"]);
    assert.equal(rows.length - 1, cards.length, "one row per card");
    for (const r of rows.slice(1)) {
      assert.equal(r.length, 12);
      assert.match(r[11], /^c_[0-9a-f]{8}$/);
      assert.ok(cards.some((c) => c.col === r[0] && c.t === r[1]), `row ${r[0]}/${r[1]} matches the board`);
      assert.ok(!Number.isNaN(Date.parse(r[8])));
    }
    // Order within each column matches the board.
    for (const col of COLUMNS) assert.deepEqual(rows.slice(1).filter((r) => r[0] === col).map((r) => r[1]), state[col]);
    // Attribution is the creating account's display name (T1: one card each).
    const createdBy = Object.fromEntries(rows.slice(1).map((r) => [r[1], r[10]]));
    assert.equal(createdBy["T1 card"], ALICE, "alice's card is attributed to her account name");
    assert.equal(createdBy["T1 bob card"], BOB, "bob's card is attributed to his account name");
    timings.T8_csv = { filename: csv.filename, rows: rows.length - 1 };

    const html = await p.downloadExport(alice.page, "HTML");
    timings.T8_html = { filename: html.filename, bytes: html.text.length };
    await writeFile(join(SHOTS, "t8-export.html"), html.text);
    await writeFile(join(SHOTS, "t8-export.csv"), csv.text);
    for (const { t } of cards) assert.ok(html.text.includes(t), `HTML export contains "${t}"`);
    for (const col of COLUMNS) assert.ok(html.text.includes(col), `HTML export contains column ${col}`);
    assert.ok(!/<button\b|<textarea\b/i.test(html.text.replace(/<script[\s\S]*?<\/script>/gi, "")), "no controls in the static board");
  });

  test("T6. alice edits server.js in the code editor; bob's board reloads itself and keeps syncing", async () => {
    // A marker in bob's iframe document: gone once the frame has reloaded itself.
    await bob.frame.locator("body").evaluate(() => { /** @type {any} */ (window).__e2eMarker = "before-edit"; });
    const connBefore = (await k.connectionLog(bob.frame)).length;

    await alice.page.getByRole("button", { name: "Code", exact: true }).click();
    await alice.page.getByRole("button", { name: "server.js", exact: true }).click();
    await alice.page.getByText("Editing server.js").waitFor({ timeout: 15_000 });
    const editor = alice.page.locator(".monaco-editor").first();
    await editor.waitFor();
    await editor.locator(".view-lines").click();
    await alice.page.keyboard.press("Control+End");
    // One edit (a single Monaco insert -> one Yjs update -> one code-version bump). Typing key by
    // key would restart the facet once per keystroke.
    const probe = `\n// e2e restart probe ${Date.now()}\n`;
    const editedAt = Date.now();
    await alice.page.keyboard.insertText(probe);
    log(`inserted ${JSON.stringify(probe)} into server.js`);
    await alice.page.screenshot({ path: join(SHOTS, "t6-code-edit-alice.png") });

    // Sample bob's page until his (self-reloaded) board is live again: iframe present, connection
    // state, marker (null after a reload), name prompts (must stay 0), overlay.
    /** @type {any[]} */
    const samples = [];
    let lastKey = "";
    let connLogBeforeReload = [];
    let reloadedAtMs = null;
    let recoveredAtMs = null;
    const sampleUntil = Date.now() + 45_000;
    while (Date.now() < sampleUntil) {
      const iframes = await bob.page.locator('iframe[title="Gadget UI"]').count();
      const read = (/** @type {() => any} */ fn) => bob.frame.locator("body").evaluate(fn, null, { timeout: 500 }).catch(() => "?");
      const conn = iframes ? await bob.frame.locator(".conn").getAttribute("data-state", { timeout: 300 }).catch(() => "none") : "no-iframe";
      const marker = iframes ? await read(() => /** @type {any} */ (window).__e2eMarker ?? null) : null;
      const overlay = iframes ? await read(() => document.getElementById("kanban-connection-overlay")?.textContent ?? null) : null;
      const dialog = iframes ? await bob.frame.locator(h.NAME_PROMPT).count().catch(() => -1) : -1;
      if (marker === "before-edit") {
        connLogBeforeReload = await k.connectionLog(bob.frame).catch(() => connLogBeforeReload);
      }
      const key = JSON.stringify([iframes, conn, marker, overlay, dialog]);
      if (key !== lastKey) { samples.push({ ms: Date.now() - editedAt, iframes, conn, marker, overlay, dialog }); lastKey = key; }
      if (marker === null && reloadedAtMs === null) reloadedAtMs = Date.now() - editedAt;
      if (marker === null && conn === "live") { recoveredAtMs = Date.now() - editedAt; break; }
      await new Promise((r) => setTimeout(r, 150));
    }
    timings.T6 = {
      bobPageSamples: samples,
      bobConnectionLogBeforeReload: connLogBeforeReload.slice(connBefore).map((e) => ({ state: e.state, ms: e.at - editedAt })),
      bobIframeReloadedByMs: reloadedAtMs,
      bobLiveAgainByMs: recoveredAtMs,
      bobGadgetConsole: bob.gadgetConsole.slice(-20),
    };
    log(`T6: bob reloaded by ${reloadedAtMs} ms, live again by ${recoveredAtMs} ms after the edit`);
    await bob.page.screenshot({ path: join(SHOTS, "t6-bob-after-edit.png") });
    assert.ok(recoveredAtMs !== null, "bob's board did not reload itself and go live again within 45 s; see timings.T6");
    assert.ok(!samples.some((x) => x.dialog > 0), "bob was never asked for a name during the self-reload");
    assert.equal(await bob.frame.locator(".me-btn .me-name").innerText(), BOB, "bob keeps his account name across the self-reload");
    await k.recordConnection(bob.frame);

    // Alice returns to the board (her iframe may be rebuilt by the platform).
    await alice.page.getByRole("button", { name: "Board", exact: true }).click();
    if (await k.ensureLive(alice.frame, ALICE)) {
      notes.push("T6: alice's (owner) iframe was rebuilt after switching back from Code (account name kept, no dialog)");
    }

    const t0 = Date.now();
    await h.addCard(alice.frame, "Done", "After restart A");
    await alice.frame.locator(".composer-input").press("Escape");
    await h.card(bob.frame, "After restart A").waitFor({ timeout: 10_000 });
    timings.T6_alice_card_to_bob_ms = Date.now() - t0;
    const t1 = Date.now();
    await h.addCard(bob.frame, "Done", "After restart B");
    await bob.frame.locator(".composer-input").press("Escape");
    await h.card(alice.frame, "After restart B").waitFor({ timeout: 10_000 });
    timings.T6_bob_card_to_alice_ms = Date.now() - t1;

    assert.deepEqual(await boardState(alice.frame), await boardState(bob.frame));
    await shot("t6-after-restart");

    // The edit persisted in the workspace code.
    await alice.page.getByRole("button", { name: "Code", exact: true }).click();
    await alice.page.getByRole("button", { name: "server.js", exact: true }).click();
    await alice.page.getByText("Editing server.js").waitFor({ timeout: 15_000 });
    await alice.page.locator(".monaco-editor .view-lines").first().click();
    await alice.page.keyboard.press("Control+End");
    await h.until(async () => (await alice.page.locator(".monaco-editor .view-lines").innerText()).replace(/\u00a0/g, " ").includes("e2e restart probe"),
      { timeout: 15_000, message: "probe comment visible in server.js" }).catch(() => notes.push("T6: probe line not found in the visible part of server.js"));
    await alice.page.getByRole("button", { name: "Board", exact: true }).click();
    await k.ensureLive(alice.frame, ALICE);
    // Bob's account name is still what alice sees.
    await alice.frame.locator(`.avatars .avatar[title="${BOB}"]`).waitFor({ timeout: 15_000 });
  });

  test("reload: bob reloads and the board state is intact", async () => {
    const before = await boardState(alice.frame);
    await bob.page.reload();
    // A full page reload makes a new iframe (window.name starts empty); the name still comes from
    // the account, with no dialog.
    await k.ensureLive(bob.frame, BOB);
    await h.until(async () => JSON.stringify(await boardState(bob.frame)) === JSON.stringify(before),
      { timeout: 10_000, message: "bob's reloaded board equals alice's" });
  });

  test("bulk: alice creates 30 cards quickly; bob converges to exactly 30, no duplicates", async () => {
    const col = h.column(alice.frame, "To do");
    await col.locator(".add-card-btn").click();
    const composer = alice.frame.locator(".composer-input");
    const t0 = Date.now();
    for (let i = 1; i <= 30; i++) {
      await composer.fill(`Bulk ${String(i).padStart(2, "0")}`);
      await composer.press("Enter");
    }
    await composer.press("Escape");
    const bulk = async (/** @type {import("playwright").FrameLocator} */ f) =>
      (await f.locator(".board .card .card-title").allInnerTexts()).filter((t) => /^Bulk \d\d$/.test(t));
    timings.bulk_bob_converged_ms = await timeUntil(async () => (await bulk(bob.frame)).length >= 30, 30_000, "bob sees 30 bulk cards");
    await new Promise((r) => setTimeout(r, 2000)); // let any duplicate echoes arrive
    for (const f of [alice.frame, bob.frame]) {
      const ts = await bulk(f);
      assert.equal(ts.length, 30);
      assert.equal(new Set(ts).size, 30, "no duplicates");
    }
    const want = Array.from({ length: 30 }, (_, i) => `Bulk ${String(i + 1).padStart(2, "0")}`);
    assert.deepEqual((await h.titles(bob.frame, "To do")).filter((t) => t.startsWith("Bulk")), want, "order preserved");
    assert.deepEqual(await boardState(alice.frame), await boardState(bob.frame));
    await shot("bulk");
  });

  test("T4. alice's open card shows a ring for bob; it and her avatar go when her browser dies", async () => {
    const ringed = h.card(bob.frame, "T1 card").and(bob.frame.locator(".peer-open"));
    const avatar = bob.frame.locator(`.avatars .avatar[title="${ALICE}"]`);

    // (a) renderer crash: no pagehide, no leavePresence.
    await h.card(alice.frame, "T1 card").click();
    timings.T4_ring_appeared_ms = await timeUntil(() => ringed.count(), 3000, "ring on bob");
    assert.equal(await ringed.locator(`.peer-badges .avatar[title="${ALICE}"]`).count(), 1);
    await shot("t4-ring");
    const cdp = await alice.context.newCDPSession(alice.page);
    let t0 = Date.now();
    // Page.crash never answers (the renderer is gone), so don't await it.
    cdp.send("Page.crash").catch(() => {});
    await alice.page.waitForEvent("crash", { timeout: 5000 }).catch(() => notes.push("T4: no crash event seen"));
    await ringed.waitFor({ state: "detached", timeout: 15_000 });
    timings.T4_crash_ring_gone_ms = Date.now() - t0;
    await avatar.waitFor({ state: "detached", timeout: Math.max(1, 15_000 - (Date.now() - t0)) });
    timings.T4_crash_avatar_gone_ms = Date.now() - t0;
    await Promise.race([alice.context.close(), new Promise((r) => setTimeout(r, 5000))]);

    // (b) context.close() without closing the panel or leaving the board.
    alice = await openUser("alice");
    const reopened = await openBoard(alice, workspaceUrl);
    assert.deepEqual(reopened, { meName: ALICE, namePrompts: 0 }, "alice reopens under her account name, no dialog");
    await avatar.waitFor({ timeout: 10_000 });
    await h.card(alice.frame, "T1 card").click();
    await ringed.waitFor({ timeout: 3000 });
    t0 = Date.now();
    await alice.context.close();
    await ringed.waitFor({ state: "detached", timeout: 15_000 });
    timings.T4_close_ring_gone_ms = Date.now() - t0;
    await avatar.waitFor({ state: "detached", timeout: Math.max(1, 15_000 - (Date.now() - t0)) });
    timings.T4_close_avatar_gone_ms = Date.now() - t0;
    await bob.page.screenshot({ path: join(SHOTS, "t4-after-close-bob.png") });
    // @ts-ignore alice is gone; keep after() from screenshotting a closed page.
    alice = null;
  });
});
