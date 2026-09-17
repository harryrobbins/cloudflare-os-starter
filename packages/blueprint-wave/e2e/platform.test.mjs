// Multi-browser end-to-end tests of the Wave against a REAL local Cloudflare OS Workshop
// (docs/plans/wave-blueprint-implementation-1.md section 5.6, T0 to T15). See ./README.md.
//
//   e2e/start-local-platform.sh                                   # once; prints PGID + URL
//   pnpm --filter blueprint-wave pack:gadget                      # from the repo root
//   node --test --test-concurrency=1 e2e/platform.test.mjs        # from packages/blueprint-wave
//   e2e/stop-local-platform.sh
//
// Env: CFOS_URL (default http://localhost:8787); PLATFORM_SHOTS (screenshots, exports and
// timings.json; default ${TMPDIR:-/tmp}/wave-platform-shots); CFOS_LOG (platform log, as for
// start-local-platform.sh). Uploads formats/wave.gadget as is. Users: alice (owner), bob (use-role
// share link), carol (a third use-role context in T6 and T11).
//
// OPENROUTER_API_KEY (required): the Wave declares a Model binding with Qwen suggested, so setup
// adds that model to alice's account (the key goes into the Workshop's Add AI Model dialog, not a
// file) and creates the Wave from the prefilled blueprint page. The local platform has no chat
// agent: T9 (Workshop chat) is run as the same RPC calls the chat would make, through the owner's
// store. T10 and T15 still skip (recorded in timings.json) if `capabilities.model` is false.

import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as p from "./platform-helpers.mjs";
import * as h from "./harness-helpers.mjs";
import * as w from "./platform-wave-helpers.mjs";
import * as m from "./platform-model-helpers.mjs";

const { SEL, inPane, until, sleep } = h;
const BASE = (process.env.CFOS_URL || p.DEFAULT_BASE_URL).replace(/\/$/, "");
const SHOTS = process.env.PLATFORM_SHOTS || join(tmpdir(), "wave-platform-shots");
const PASSWORD = "correct-horse-battery-staple";
const FORM_BLOCKED = /Blocked form submission/;
const GADGET_TAB = /^(Wave|App)$/;

/** @type {Record<string, any>} */
const timings = {};
/** @type {string[]} */
const notes = [];
const log = (/** @type {string} */ s) => console.log(`# [${new Date().toISOString().slice(11, 23)}] ${s}`);

/** @type {import("playwright").Browser} */
let browser;
/** @type {string} */
let workspaceUrl;
/** @type {string} */
let shareUrl;
/** @typedef {Awaited<ReturnType<typeof openUser>>} User */
/** @type {User} */
let alice;
/** @type {User} */
let bob;
/** @type {User|null} */
let carol = null;
/** Users opened during a test through openSharedUser; evidence() closes them afterwards. @type {User[]} */
const extraUsers = [];
/** @type {{meName: string, viewerName: string, namePrompts: number}} */
let aliceIdentity;
/** @type {{meName: string, viewerName: string, namePrompts: number}} */
let bobIdentity;
/** Display names of the local accounts (what `gadgetViewer.displayName` carries). */
const ALICE = w.accountDisplayName("alice");
const BOB = w.accountDisplayName("bob");
const CAROL = w.accountDisplayName("carol");
let templatePicked = false;
let hasModel = false;
let logStart = 0;
/** Owner-page `server: ` console lines seen by every alice page of the run. */
/** @type {string[]} */
const serverConsole = [];

/**
 * A signed-in user in their own browser context (1920x1000), with console capture.
 * @param {string} username
 */
async function openUser(username) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  /** @type {string[]} */ const consoleErrors = [];
  /** @type {string[]} */ const frameErrors = [];
  /** @type {string[]} */ const gadgetConsole = [];
  page.on("console", (m) => {
    const text = m.text();
    const where = m.location()?.url ?? "";
    const inGadget = !where.startsWith(BASE);
    if (text.startsWith("server: ")) {
      serverConsole.push(`${new Date().toISOString().slice(11, 23)} [${username}] ${text}`);
      return;
    }
    if (m.type() === "error") (inGadget ? frameErrors : consoleErrors).push(`${text} @ ${where}`);
    if (inGadget) gadgetConsole.push(`${m.type()}: ${text}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  await p.signUpOrIn(page, BASE, username, PASSWORD);
  return { username, context, page, frame: p.gadgetFrame(page), consoleErrors, frameErrors, gadgetConsole };
}

/**
 * Opens the Wave at `url` for `user`. Nobody is asked for a name: returns what it shows.
 * @param {User} user @param {string} url
 */
async function openWave(user, url) {
  await user.page.goto(url);
  await w.waitLive(user.frame);
  const identity = await w.waveIdentity(user.frame);
  await w.recordConnection(user.frame);
  return identity;
}

const users = () => /** @type {User[]} */ ([alice, bob, carol].filter(Boolean));

/** @param {string} name */
async function shot(name) {
  await Promise.all(users().map((u) =>
    u.page.screenshot({ path: join(SHOTS, `${name}-${u.username}.png`) }).catch(() => {})));
}

/**
 * Runs a test body; on failure saves screenshots and the recent frame and server console lines.
 * @param {string} name @param {() => Promise<void>} fn
 */
async function evidence(name, fn) {
  const serverFrom = serverConsole.length;
  const t0 = Date.now();
  try {
    await fn();
    timings[`${name}_total_ms`] = Date.now() - t0;
  } catch (err) {
    await shot(`FAIL-${name}`);
    const dump = {
      error: String(/** @type {any} */ (err)?.stack ?? err),
      frameConsole: Object.fromEntries(users().map((u) => [u.username, u.gadgetConsole.slice(-40)])),
      frameErrors: Object.fromEntries(users().map((u) => [u.username, u.frameErrors.slice(-20)])),
      serverConsole: serverConsole.slice(serverFrom).slice(-60),
      platformLog: await w.logLinesSince(logStart, /error|Error|warn|crash|disposed/).then((l) => l.slice(-40)),
    };
    await writeFile(join(SHOTS, `FAIL-${name}.json`), JSON.stringify(dump, null, 2)).catch(() => {});
    timings[`${name}_failed`] = String(/** @type {any} */ (err)?.message ?? err).slice(0, 400);
    throw err;
  } finally {
    // Extra users (carol) never outlive their test, pass or fail: a context left open keeps a
    // peer in everyone's presence and skews the next test (T12 checks the peer list).
    const open = extraUsers.splice(0);
    carol = null;
    await Promise.all(open.map((u) => Promise.race([u.context.close(), sleep(5000)]).catch(() => {})));
  }
}

/** Every token of `wanted` appears in `text`, in order; returns the missing ones. */
function missingInOrder(text, wanted) {
  let from = 0;
  const missing = [];
  for (const t of wanted) {
    const i = text.indexOf(t, from);
    if (i === -1) missing.push(t);
    else from = i + t.length;
  }
  return missing;
}

/**
 * Before each test: both main users live under their account names, no editor open.
 */
async function settle() {
  for (const [u, name] of /** @type {[User, string][]} */ ([[alice, ALICE], [bob, BOB]])) {
    await w.ensureLive(u.frame, name);
    await h.closeEditor(u.frame, { via: "api" }).catch(() => h.closeEditor(u.frame));
    // A test that failed in History mode must not leave the next one looking at an old version.
    await h.backToLive(u.frame);
  }
}

/**
 * Alice creates a root blip with `text`; waits until both main frames show it. Returns the id.
 * @param {string} text
 */
async function sharedRoot(text) {
  const id = await w.createInFrame(alice.frame, { parentId: null, text });
  for (const u of [alice, bob]) await h.card(u.frame, id).waitFor({ timeout: 15_000 });
  return id;
}

/**
 * A new user opens the use-role share link.
 * @param {string} username
 */
async function openSharedUser(username) {
  const u = await openUser(username);
  extraUsers.push(u); // closed by evidence() when the test ends
  const identity = await openWave(u, shareUrl);
  return { u, identity };
}

/** The first run in a frame's state to reach one of `states`. */
function waitRun(frame, runId, states, timeout = 120_000) {
  return until(() => inPane(frame, (store, _, a) => {
    const r = store.getState().runs[a.runId];
    return r && a.states.includes(r.state) ? r : null;
  }, { runId, states }), { timeout, interval: 200, message: `run ${runId} in ${states}` });
}

before(async () => {
  await mkdir(SHOTS, { recursive: true });
  logStart = await w.logOffset();
  browser = await p.launch();
  log(`archive ${w.SHIPPED_ARCHIVE}`);

  alice = await openUser("alice");
  // The Wave declares a Model binding with Qwen suggested, so creating needs that model on the
  // account; locally it calls OpenRouter directly with OPENROUTER_API_KEY.
  timings.setup_model = await m.addOpenRouterModel(alice.page, BASE, process.env.OPENROUTER_API_KEY ?? "");
  const blueprintId = await p.uploadGadget(alice.page, BASE, w.SHIPPED_ARCHIVE);
  const t0 = Date.now();
  ({ workspaceUrl } = await m.createWithSuggestedModel(alice.page, BASE, blueprintId));
  await alice.page.screenshot({ path: join(SHOTS, "setup-created.png") });
  log(`workspace ${workspaceUrl}`);
  await w.waitLive(alice.frame);
  timings.setup_create_to_alice_live_ms = Date.now() - t0;
  aliceIdentity = await w.waveIdentity(alice.frame);
  await w.recordConnection(alice.frame);
  templatePicked = await w.pickTemplateIfOffered(alice.frame, "decision", 10_000);
  hasModel = !!(await w.capabilities(alice.frame))?.model;
  timings.setup_capabilities_model = hasModel;
  log(`template picked: ${templatePicked}; model available: ${hasModel}`);

  shareUrl = await p.createUseShareLink(alice.page);
  bob = await openUser("bob");
  bobIdentity = await openWave(bob, shareUrl);
  await h.openPanel(alice.frame, "people");
  await h.peerNamed(alice.frame, BOB).waitFor({ timeout: 15_000 });
  await h.openPanel(bob.frame, "people");
  await h.peerNamed(bob.frame, ALICE).waitFor({ timeout: 15_000 });
  log("alice and bob are live on the Wave");
});

const PROBLEM = new RegExp(`${w.STUB_WARNING.source}|${w.RUNTIME_CRASH.source}`);
/** Platform-log offset when the current test (or setup) started. */
let testLogStart = 0;
/** Stub warnings / runtime crashes in the platform log, attributed to the test they appeared in. */
/** @type {Record<string, string[]>} */
const logProblemsByTest = {};
timings.logProblemsByTest = logProblemsByTest;

beforeEach(async () => {
  const setup = (await w.logLinesSince(logStart, PROBLEM)).map((l) => l.slice(0, 80));
  if (!("setup" in logProblemsByTest)) logProblemsByTest.setup = setup;
  testLogStart = await w.logOffset();
});

afterEach(async (t) => {
  const lines = await w.logLinesSince(testLogStart, PROBLEM);
  if (lines.length) logProblemsByTest[t.name.split(".")[0]] = lines.map((l) => l.slice(0, 80));
  const crash = await w.logLinesSince(logStart, w.RUNTIME_CRASH);
  if (crash.length && !notes.some((n) => n.startsWith("RUNTIME CRASH"))) notes.push(`RUNTIME CRASH in platform log after ${t.name}`);
});

after(async () => {
  timings.notes = notes;
  timings.consoleErrors = Object.fromEntries(users().map((u) => [u.username, { page: u.consoleErrors.slice(-30), frame: u.frameErrors.slice(-30) }]));
  timings.serverConsoleTail = serverConsole.slice(-40);
  timings.platformLogProblems = await w.logLinesSince(logStart, PROBLEM);
  await writeFile(join(SHOTS, "timings.json"), JSON.stringify(timings, null, 2)).catch(() => {});
  await writeFile(join(SHOTS, "server-console.log"), serverConsole.join("\n")).catch(() => {});
  console.log("TIMINGS " + JSON.stringify(timings, null, 2));
  await browser?.close();
});

describe("wave on the local platform", { concurrency: false }, () => {
  test("T0. the shipped client boots; nobody is asked for a name, each runs under their account name; templates; no errors", () => evidence("T0", async () => {
    assert.equal(aliceIdentity.namePrompts, 0, "alice (owner) saw no name dialog");
    assert.equal(bobIdentity.namePrompts, 0, "bob (use-role share link) saw no name dialog");
    assert.deepEqual([aliceIdentity.meName, aliceIdentity.viewerName], [ALICE, ALICE], "alice runs under her account display name");
    assert.deepEqual([bobIdentity.meName, bobIdentity.viewerName], [BOB, BOB], "bob runs under his account display name");
    assert.ok(templatePicked, "the template picker was offered on first open");
    for (const u of [alice, bob]) {
      assert.equal(await u.frame.locator("form").count(), 0, "no <form> in the client");
      assert.equal(await u.frame.locator('.wave-blip[data-kind="brief"]').count(), 1, `${u.username}: the template's brief is pinned`);
      assert.ok((await u.frame.locator(SEL.anyBlip).count()) >= 2, `${u.username}: starter threads rendered`);
      assert.deepEqual([...u.consoleErrors, ...u.frameErrors].filter((e) => FORM_BLOCKED.test(e)), [], `${u.username}: no blocked form submissions`);
      assert.deepEqual(u.frameErrors, [], `${u.username}: no console errors in the gadget frame`);
    }
    const state = await w.settledState(alice.frame);
    assert.equal(state.meta.template, "decision");
    timings.T0_page_console_errors = { alice: alice.consoleErrors.slice(), bob: bob.consoleErrors.slice() };
    await shot("t0-joined");
  }));

  test("T1. alice and bob type interleaved words in one blip at the same time; both end with identical text", () => evidence("T1", async () => {
    await settle();
    const id = await sharedRoot("Start.");
    const aWords = Array.from({ length: 10 }, (_, i) => `alpha${i}`);
    const bWords = Array.from({ length: 10 }, (_, i) => `bravo${i}`);
    await h.openEditor(alice.frame, id);
    await h.openEditor(bob.frame, id);
    const t0 = Date.now();
    // Two real browsers: the typing really overlaps.
    await Promise.all([
      (async () => { for (const wd of aWords) await h.typeInto(alice.frame, id, ` ${wd}`, { delay: 20, at: "keep" }); })(),
      (async () => { for (const wd of bWords) await h.typeInto(bob.frame, id, ` ${wd}`, { delay: 20, at: "keep" }); })(),
    ]);
    await shot("t1-typing");
    await h.closeEditor(alice.frame);
    await h.closeEditor(bob.frame);
    await h.waitSaved(alice.frame, id, 20_000);
    await h.waitSaved(bob.frame, id, 20_000);
    const text = await until(async () => {
      const [a, b] = await Promise.all([h.readText(alice.frame, id), h.readText(bob.frame, id)]);
      return a === b ? a : null;
    }, { timeout: 15_000, interval: 100, message: "alice and bob agree" });
    timings.T1_converged_ms = Date.now() - t0;
    assert.ok(text.startsWith("Start."));
    assert.deepEqual(missingInOrder(text, aWords), [], "every word alice typed, in order");
    assert.deepEqual(missingInOrder(text, bWords), [], "every word bob typed, in order");
    assert.equal(text.length, "Start.".length + [...aWords, ...bWords].reduce((n, x) => n + x.length + 1, 0), "nothing duplicated or lost");
    // Server truth: a fresh subscription (bob's frame reloaded) reads the stored text.
    await w.reloadFrame(bob.frame);
    await w.ensureLive(bob.frame, BOB);
    assert.equal(await h.readText(bob.frame, id), text, "the server has the same text");
  }));

  test("T2. bob's caret is visible in alice's editor and stays on the right character while alice types above it", () => evidence("T2", async () => {
    await settle();
    const text = "Line one\nLine two\ntarget line";
    const id = await sharedRoot(text);
    const edA = await h.openEditor(alice.frame, id);
    const edB = await h.openEditor(bob.frame, id);
    await edB.focus();
    await edB.press("Control+Home");
    await edB.press("ArrowDown");
    await edB.press("ArrowDown");
    const want = text.indexOf("target");
    assert.equal(await edB.evaluate((el) => el.selectionStart), want, "bob's caret sits before 'target'");
    const caret = h.own(alice.frame, id, "remoteCaret").first();
    const t0 = Date.now();
    await caret.waitFor({ timeout: 10_000 });
    timings.T2_caret_seen_ms = Date.now() - t0;
    const y0 = (await caret.boundingBox()).y;
    const edBox = await edA.boundingBox();
    assert.ok(y0 >= edBox.y && y0 <= edBox.y + edBox.height, "caret drawn inside alice's editor");
    await shot("t2-caret-before");
    await edA.focus();
    await edA.press("Control+Home");
    const inserted = "Inserted first line\n";
    await edA.pressSequentially(inserted, { delay: 15 });
    await h.waitSaved(alice.frame, id, 20_000);
    const newText = inserted + text;
    await h.waitForText(bob.frame, id, "Inserted first line", { timeout: 10_000 });
    const newWant = newText.indexOf("target");
    await until(async () => (await edB.evaluate((el) => el.selectionStart)) === newWant, { timeout: 5000, message: "bob's own caret restored on 'target'" });
    const y1 = await until(async () => { const b = await caret.boundingBox(); return b && b.y > y0 + 6 ? b.y : null; },
      { timeout: 10_000, message: "alice's copy of bob's caret moved down with the text" });
    assert.ok(y1 - y0 < 80, `moved by about one line (${y1 - y0}px)`);
    timings.T2_caret_shift_px = y1 - y0;
    await shot("t2-caret-after");
    await h.closeEditor(alice.frame);
    await h.closeEditor(bob.frame);
  }));

  test("T3. alice replies after paragraph 2; bob sees it at the same paragraph after paragraph 1 is edited", () => evidence("T3", async () => {
    await settle();
    const text = "Para one is here.\n\nPara two is here.\n\nPara three is here.";
    const parent = await sharedRoot(text);
    const parentCard = h.card(alice.frame, parent);
    await parentCard.hover();
    const gutter = h.own(alice.frame, parent, "paraReplyButton");
    await until(async () => (await gutter.count()) >= 3, { message: "one Reply-after-paragraph button per paragraph" });
    await gutter.nth(1).click();
    const composer = alice.frame.locator(SEL.blipEditor).first();
    await composer.waitFor({ timeout: 5000 });
    await composer.pressSequentially("Reply to two", { delay: 15 });
    const reply = await until(() => inPane(alice.frame, (store, _, pid) =>
      Object.values(store.getState().blips).find((b) => b.parentId === pid && b.anchor?.type === "para") ?? null, parent),
      { timeout: 10_000, message: "the reply exists from the first keystroke" });
    await composer.press("Control+Enter");
    await h.waitSaved(alice.frame, reply.id, 20_000);
    await h.card(bob.frame, reply.id).waitFor({ timeout: 15_000 });
    await h.waitForText(bob.frame, reply.id, "Reply to two", { timeout: 10_000 });

    await bob.frame.locator("body").evaluate(() => {});
    await h.typeInto(bob.frame, parent, "Edited: ", { at: "start", delay: 15 });
    await h.closeEditor(bob.frame);
    await h.waitSaved(bob.frame, parent, 20_000);
    await h.waitForText(alice.frame, parent, "Edited: Para one", { timeout: 10_000 });
    for (const u of [alice, bob]) {
      await until(async () => (await h.readBody(u.frame, parent)).startsWith("Edited:"), { message: `${u.username}'s read view updated` });
      const paras = h.own(u.frame, parent, "blocks"); // the parent's own paragraphs, not the reply's
      await until(async () => (await paras.count()) >= 3, { message: "three paragraphs rendered" });
      const p2 = await paras.nth(1).boundingBox();
      const p3 = await paras.nth(2).boundingBox();
      const r = await h.card(u.frame, reply.id).boundingBox();
      assert.ok(r && p2 && p3, "boxes available");
      assert.ok(r.y >= p2.y + p2.height - 2, `${u.username}: reply (${r.y}) below paragraph 2 (${p2.y + p2.height})`);
      assert.ok(r.y <= p3.y + 2, `${u.username}: reply (${r.y}) above paragraph 3 (${p3.y})`);
    }
    const stored = await w.frameBlip(bob.frame, reply.id);
    assert.equal(stored.anchor.type, "para");
    await shot("t3-paragraph-reply");
  }));

  test("T4. alice reloads her frame mid-typing; acknowledged text is intact; pending text is offered back", () => evidence("T4", async () => {
    await settle();
    const id = await sharedRoot("Base.");
    const words = Array.from({ length: 14 }, (_, i) => `w${i + 1}x`);
    await h.openEditor(alice.frame, id);
    for (const wd of words.slice(0, 10)) await h.typeInto(alice.frame, id, ` ${wd}`, { delay: 15, at: "keep" });
    await h.waitSaved(alice.frame, id, 20_000);
    const acked = await h.readText(bob.frame, id);
    // The last words are typed and the frame reloaded at once, before they can be acknowledged.
    for (const wd of words.slice(10)) await h.typeInto(alice.frame, id, ` ${wd}`, { delay: 0, at: "keep" });
    const t0 = Date.now();
    await w.reloadFrame(alice.frame);
    await w.ensureLive(alice.frame, ALICE);
    timings.T4_reload_to_live_ms = Date.now() - t0;
    const afterReload = await h.readText(alice.frame, id);
    assert.ok(afterReload.startsWith(acked), `acknowledged text intact: ${JSON.stringify(acked)} is a prefix of ${JSON.stringify(afterReload)}`);
    await shot("t4-after-reload");
    const offer = alice.frame.getByText(/Re-insert unsaved text/);
    const complete = () => h.readText(alice.frame, id).then((t) => missingInOrder(t, words).length === 0);
    if (!(await complete())) {
      await offer.first().waitFor({ timeout: 10_000 });
      timings.T4_reinsert_offered = true;
      await offer.first().click();
      await until(complete, { timeout: 15_000, message: "the unsaved words are back" });
    } else {
      timings.T4_reinsert_offered = "not needed (everything was acknowledged before the reload)";
      notes.push("T4: every push was acknowledged before the reload; the Re-insert path was not exercised");
    }
    await h.waitSaved(alice.frame, id, 20_000);
    const final = await h.readText(alice.frame, id);
    assert.deepEqual(missingInOrder(final, words), [], "no typed word was lost");
    await h.waitForText(bob.frame, id, final, { timeout: 15_000 });
  }));

  test("T5. History replays a session in order; the scrubber's final state equals the live text", () => evidence("T5", async () => {
    await settle();
    const id = await sharedRoot("v1.");
    for (const chunk of [" v2.", " v3.", " v4."]) {
      await h.typeInto(alice.frame, id, chunk, { delay: 15 });
      await h.closeEditor(alice.frame);
      await h.waitSaved(alice.frame, id, 20_000);
      await sleep(150);
    }
    const live = "v1. v2. v3. v4.";
    await h.waitForText(bob.frame, id, live, { timeout: 10_000 });
    const liveBody = await h.readBody(bob.frame, id);
    await bob.frame.locator(SEL.historyToggle).click();
    await bob.frame.locator(SEL.historyBanner).waitFor({ timeout: 10_000 });
    const scrubber = bob.frame.locator(SEL.historyScrubber);
    await scrubber.waitFor({ timeout: 10_000 });
    await scrubber.focus();
    await scrubber.press("End");
    const t0 = Date.now();
    await until(async () => (await h.readBody(bob.frame, id)).trim() === liveBody.trim(), { timeout: 15_000, message: "scrubber end = live text" });
    timings.T5_end_equals_live_ms = Date.now() - t0;
    assert.equal(await h.card(bob.frame, id).locator(SEL.editButton).count(), 0, "editing off in History mode");
    // Before the blip's create its card is not shown (counts as ""). From its create step on it
    // shows at least the text it was created with: the create and the seeded text are one commit,
    // so History never shows this blip as "(empty)". Every point is a prefix of live.
    const changes = await h.inPane(bob.frame, (store, _, a) => store.getChanges(a, 1000), 0);
    const createSeq = changes.events.find((e) => e.kind === "blip.create" && e.blipId === id)?.seq;
    assert.ok(createSeq, "the blip's create event is retained");
    const replayed = async () => {
      if (!(await h.card(bob.frame, id).count())) return "";
      assert.equal(await h.own(bob.frame, id, "body").locator(":scope > .blip-empty").count(), 0, "a blip created with text is never shown empty");
      return (await h.readBody(bob.frame, id)).trim();
    };
    let prev = (await replayed()).length;
    let sawCreateStep = false;
    // At least 12 steps (as before), and on until the create step has been seen.
    for (let i = 0; i < 12 || (i < 80 && !sawCreateStep); i++) {
      await scrubber.press("ArrowLeft");
      await sleep(200);
      const at = Number(await scrubber.inputValue());
      if (at === createSeq) {
        await until(async () => (await replayed()) === "v1.", { timeout: 15_000, message: `the create step (seq ${at}) shows the seeded text "v1."` });
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
    await until(async () => (await replayed()) !== liveBody.trim(), { timeout: 15_000, message: "the earliest point differs from live" });
    await shot("t5-history");
    await scrubber.press("End");
    await until(async () => (await h.readBody(bob.frame, id)).trim() === liveBody.trim(), { timeout: 15_000, message: "end again equals live" });
    await scrubber.press("Escape");
    // Escape returns to live: the banner is hidden (it stays in the DOM), the toggle unpressed.
    await bob.frame.locator(SEL.historyBanner).waitFor({ state: "hidden", timeout: 5000 });
    assert.equal(await bob.frame.locator(SEL.historyToggle).getAttribute("aria-pressed"), "false", "back to live");
    assert.equal(await h.readText(bob.frame, id), live);
  }));

  test("T6. carol's tab dies while editing (crash, then context close): her caret and editing chip vanish within 15 s", () => evidence("T6", async () => {
    await settle();
    const id = await sharedRoot("Shared text.");
    for (const how of /** @type {const} */ (["crash", "close"])) {
      const opened = await openSharedUser("carol");
      assert.deepEqual([opened.identity.meName, opened.identity.viewerName, opened.identity.namePrompts], [CAROL, CAROL, 0], "carol opens under her account name, no dialog");
      carol = opened.u;
      await h.card(carol.frame, id).waitFor({ timeout: 15_000 });
      await h.openPanel(alice.frame, "people");
      await h.peerNamed(alice.frame, CAROL).waitFor({ timeout: 15_000 });
      await h.typeInto(carol.frame, id, ` carol-${how}`, { delay: 15 });
      await h.waitSaved(carol.frame, id, 20_000);
      const chip = h.own(alice.frame, id, "editingChip").filter({ hasText: CAROL });
      await chip.first().waitFor({ timeout: 10_000 });
      await h.openEditor(alice.frame, id);
      const caret = h.own(alice.frame, id, "remoteCaret");
      await caret.first().waitFor({ timeout: 10_000 });
      await shot(`t6-${how}-editing`);
      const killedAt = Date.now();
      const c = /** @type {User} */ (carol);
      if (how === "crash") {
        const cdp = await c.context.newCDPSession(c.page);
        cdp.send("Page.crash").catch(() => {}); // never answers
        await c.page.waitForEvent("crash", { timeout: 5000 }).catch(() => notes.push("T6: no crash event seen"));
      } else {
        await c.context.close();
      }
      carol = null;
      await caret.first().waitFor({ state: "detached", timeout: 15_000 });
      timings[`T6_${how}_caret_gone_ms`] = Date.now() - killedAt;
      await chip.first().waitFor({ state: "detached", timeout: Math.max(1, 15_000 - (Date.now() - killedAt)) });
      timings[`T6_${how}_chip_gone_ms`] = Date.now() - killedAt;
      await h.peerNamed(alice.frame, CAROL).waitFor({ state: "detached", timeout: Math.max(1, 15_000 - (Date.now() - killedAt)) });
      timings[`T6_${how}_peer_gone_ms`] = Date.now() - killedAt;
      await h.closeEditor(alice.frame);
      assert.ok((await h.readText(alice.frame, id)).includes(`carol-${how}`), "carol's committed text stays");
      if (how === "crash") await Promise.race([c.context.close(), sleep(5000)]);
    }
  }));

  test("T7. a 15,000-character blip stays responsive; each push is small (bytes, not the document)", () => evidence("T7", async () => {
    await settle();
    const big = Array.from({ length: 300 }, (_, i) => `Sentence ${i + 1} of a very long blip that the editor must handle without sending it whole.`).join(i => "").slice(0, 15_000);
    const id = await sharedRoot(big);
    await until(async () => (await h.readBody(bob.frame, id)).length > 10_000, { timeout: 30_000, message: "bob renders the long blip" });
    const before = await h.readText(alice.frame, id);
    const seq0 = (await w.settledState(alice.frame)).seq;
    const ed = await h.openEditor(alice.frame, id);
    await ed.focus();
    await ed.press("Control+End");
    const typed = " The end of a long story is still typed one key at a time";
    const t0 = Date.now();
    await ed.pressSequentially(typed, { delay: 25 });
    const typingMs = Date.now() - t0;
    await h.closeEditor(alice.frame);
    await h.waitSaved(alice.frame, id, 30_000);
    const pushes = (await w.textEventsSince(alice.frame, seq0)).filter((e) => e.blipId === id);
    const bytes = pushes.map((e) => e.bytes ?? 0);
    timings.T7 = { chars: before.length, typingMs, pushes: pushes.length, maxPushBytes: Math.max(...bytes), sumPushBytes: bytes.reduce((a, b) => a + b, 0) };
    log(`T7 ${JSON.stringify(timings.T7)}`);
    assert.ok(pushes.length >= 1, "text events recorded");
    assert.ok(Math.max(...bytes) < 2048, `each push far below the document (max ${Math.max(...bytes)} bytes)`);
    assert.ok(typingMs < typed.length * 25 + 5000, `typing did not stall (${typingMs} ms)`);
    assert.equal(await h.readText(alice.frame, id), before + typed);
    await h.waitForText(bob.frame, id, typed.slice(-20), { timeout: 15_000 });
    await shot("t7-long-blip");
  }));

  test("T8. alice edits server.js in the Code tab; bob's frame recovers and both keep syncing", () => evidence("T8", async () => {
    await settle();
    const id = await sharedRoot("Before the code edit.");
    const r = await w.editServerJsAndWatch({ owner: alice, other: bob, log, shots: SHOTS });
    timings.T8 = { bobPageSamples: r.samples, bobConnectionLogBeforeReload: r.connectionLogBeforeReload, bobFrameReloadedByMs: r.reloadedAtMs, bobLiveAgainByMs: r.recoveredAtMs, bobGadgetConsole: r.gadgetConsole };
    log(`T8: bob reloaded by ${r.reloadedAtMs} ms, live again by ${r.recoveredAtMs} ms after the edit`);
    await bob.page.screenshot({ path: join(SHOTS, "t8-bob-after-edit.png") });
    assert.ok(r.recoveredAtMs !== null, "bob's Wave did not recover within 45 s; see timings.T8");
    assert.equal(r.sawDialog, false, "bob was never asked for a name");
    await w.ensureLive(bob.frame, BOB);
    await w.recordConnection(bob.frame);

    await alice.page.getByRole("button", { name: GADGET_TAB }).click();
    if (await w.ensureLive(alice.frame, ALICE)) {
      notes.push("T8: alice's (owner) iframe was rebuilt after switching back from Code (account name kept, no dialog)");
    }
    // Sync both ways through the editors.
    let t0 = Date.now();
    await h.typeInto(alice.frame, id, " alice-after", { delay: 15 });
    await h.closeEditor(alice.frame);
    await h.waitForText(bob.frame, id, "alice-after", { timeout: 15_000 });
    timings.T8_alice_to_bob_ms = Date.now() - t0;
    t0 = Date.now();
    await h.typeInto(bob.frame, id, " bob-after", { delay: 15 });
    await h.closeEditor(bob.frame);
    await h.waitForText(alice.frame, id, "bob-after", { timeout: 15_000 });
    timings.T8_bob_to_alice_ms = Date.now() - t0;
    await h.openPanel(alice.frame, "people");
    await h.peerNamed(alice.frame, BOB).waitFor({ timeout: 15_000 });
    await shot("t8-after-restart");
    if (!(await w.probeVisibleInServerJs(alice.page))) notes.push("T8: probe line not found in the visible part of server.js");
    await alice.page.getByRole("button", { name: GADGET_TAB }).click();
    await w.ensureLive(alice.frame, ALICE);
  }));

  test("T9. the chat's calls (getWaveMarkdown, reply) create a summary reply that bob sees live", () => evidence("T9", async () => {
    // The local platform has no chat agent. This is exactly what "summarise this wave as a reply"
    // makes the agent run through env.Wave: read the Markdown, write a reply citing blip ids.
    // The manual step (Workshop chat on a deployed instance) is in README.md.
    await settle();
    const root = await sharedRoot("Which onboarding approach?\n\nOption A: white-glove.");
    const md = await inPane(alice.frame, (store) => store.getWaveMarkdown({}));
    assert.equal(typeof md, "string");
    assert.ok(md.includes(root), "the Markdown heads each blip with its id");
    const cited = [...new Set(md.match(/b_[0-9a-f]{12}/g) ?? [])];
    const text = `Summary of the wave so far:\n\n- The open question is the onboarding approach (${root}).\n- ${cited.length} blips read; sources: ${cited.slice(0, 3).join(", ")}.`;
    const t0 = Date.now();
    const res = await inPane(alice.frame, (store, _, a) => store.reply(a), { parentId: root, text });
    assert.ok(res?.blip?.id, "reply created: " + JSON.stringify(res).slice(0, 200));
    await h.card(bob.frame, res.blip.id).waitFor({ timeout: 15_000 });
    timings.T9_reply_to_bob_ms = Date.now() - t0;
    await h.waitForText(bob.frame, res.blip.id, "Summary of the wave so far", { timeout: 10_000 });
    const body = await h.readBody(bob.frame, res.blip.id);
    assert.ok(body.includes("Summary of the wave so far"), "rendered for bob");
    // The live view renders a blip id as a <button class="bliplink" data-bid> that scrolls to the
    // blip (an <a href="#id"> only in exports); one per cited id.
    const links = h.card(bob.frame, res.blip.id).locator(".bliplink");
    assert.ok((await links.count()) >= 1, "blip ids in the text render as links");
    assert.equal(await links.first().getAttribute("data-bid"), root, "the first link goes to the cited root");
    notes.push("T9: run as direct RPC through alice's store (no chat agent on the local platform); the Workshop chat step is manual");
    await shot("t9-chat-reply");
  }));

  test("T10. Ask agent with a configured model: agent blip with valid sources; stale proposal refuses Accept; double Accept applies once", () => evidence("T10", async () => {
    await settle();
    if (!hasModel) {
      timings.T10 = "skipped: no model";
      notes.push("T10 skipped: capabilities.model is false (add a Model in Connections and rerun)");
      const res = await inPane(alice.frame, (store) => store.askAgent({ op: "summarise" }).then((r) => r.error ?? r));
      assert.equal(res, "no_model", "askAgent answers no_model without a binding");
      await alice.frame.locator(SEL.askAgentButton).click();
      await until(async () => /Connections/i.test(await alice.frame.locator("body").innerText()), { message: "the menu says where to add a model" });
      await alice.frame.locator("body").press("Escape");
      return;
    }
    const root = await sharedRoot("Which onboarding approach?\n\nOption A: white-glove.");
    const optionB = await w.createInFrame(alice.frame, { parentId: root, text: "Option B: self-serve." });
    await h.card(bob.frame, optionB).waitFor({ timeout: 15_000 });
    const t0 = Date.now();
    const started = await inPane(alice.frame, (store, _, a) => store.askAgent(a), { op: "summarise", blipIds: [root] });
    assert.ok(started?.run?.id, "run started: " + JSON.stringify(started).slice(0, 200));
    const run = await waitRun(alice.frame, started.run.id, ["done", "failed", "cancelled", "unknown"]);
    timings.T10_summarise_ms = Date.now() - t0;
    assert.equal(run.state, "done", run.error ?? "");
    const state = await w.settledState(alice.frame);
    const agentBlip = state.blips[run.resultBlipId];
    assert.equal(agentBlip?.kind, "agent");
    const known = new Set(Object.keys(state.blips));
    const agentText = await h.readText(alice.frame, run.resultBlipId);
    const cited = agentText.match(/b_[0-9a-f]{12}/g) ?? [];
    assert.ok(cited.length >= 1 && cited.every((c) => known.has(c)), `sources are known blips: ${cited}`);
    await h.card(bob.frame, run.resultBlipId).waitFor({ timeout: 15_000 });
    await shot("t10-agent-blip");

    // A proposal (refresh_brief) against the brief, which alice then edits.
    const brief = Object.values(state.blips).find((b) => b.kind === "brief" && !b.deleted);
    assert.ok(brief, "the template's brief exists");
    const started2 = await inPane(alice.frame, (store) => store.askAgent({ op: "refresh_brief" }));
    const run2 = await waitRun(alice.frame, started2.run.id, ["done", "failed", "cancelled", "unknown"]);
    assert.equal(run2.state, "done", run2.error ?? "");
    const p1 = run2.resultBlipId;
    assert.equal((await w.frameBlip(alice.frame, p1))?.kind, "proposal");
    await h.card(bob.frame, p1).locator(SEL.proposalAccept).waitFor({ timeout: 15_000 });
    await h.typeInto(alice.frame, brief.id, " (edited)", { delay: 15 });
    await h.closeEditor(alice.frame);
    await h.waitSaved(alice.frame, brief.id, 20_000);
    const staleCard = h.card(bob.frame, p1);
    await until(async () => /based on an older version/i.test(await staleCard.innerText()), { timeout: 15_000, message: "bob's proposal card says it is based on an older version" });
    const accept = staleCard.locator(SEL.proposalAccept);
    assert.equal((await accept.count()) > 0 && await accept.first().isEnabled(), false, "Accept is not offered");
    await staleCard.getByText(/Regenerate/).first().waitFor({ timeout: 5000 });
    await shot("t10-stale-proposal");

    // A fresh proposal, accepted from both browsers at once: one applied.
    const started3 = await inPane(alice.frame, (store) => store.askAgent({ op: "refresh_brief" }));
    const run3 = await waitRun(alice.frame, started3.run.id, ["done", "failed", "cancelled", "unknown"]);
    assert.equal(run3.state, "done", run3.error ?? "");
    const p2 = run3.resultBlipId;
    await h.card(bob.frame, p2).locator(SEL.proposalAccept).waitFor({ timeout: 15_000 });
    // The proposal replaces the passage it quotes, not the whole brief (the heading and anything
    // outside the quote stay). The quote is current, so it occurs in the brief exactly once.
    const before = await h.readText(alice.frame, brief.id);
    const quote = (await w.frameBlip(alice.frame, p2)).proposal.quote;
    assert.equal(before.split(quote).length - 1, 1, "the proposal quotes one passage of the current brief");
    const results = await Promise.all([alice, bob].map((u) => inPane(u.frame, (store, _, pid) => store.reviewProposal(pid, "accept").then((r) => r.status ?? r.error), p2)));
    timings.T10_double_accept = results;
    assert.equal(results.filter((s) => s === "applied").length, 1, `exactly one applied: ${results}`);
    const final = await w.settledState(alice.frame);
    assert.equal(final.blips[p2].proposal.state, "accepted");
    const replacement = final.blips[p2].proposal.replacement;
    assert.equal(final.blips[p2].proposal.quote, quote);
    const expected = before.replace(quote, () => replacement);
    try {
      for (const u of [alice, bob]) {
        await until(async () => (await h.readText(u.frame, brief.id)) === expected, { timeout: 15_000, message: `${u.username}'s brief has the quote replaced, once` });
      }
    } catch (err) {
      timings.T10_brief_diag = {
        quote: final.blips[p2].proposal.quote, replacement,
        bob: await h.readText(bob.frame, brief.id), alice: await h.readText(alice.frame, brief.id),
        server: (await w.settledState(alice.frame)).blips[brief.id],
      };
      throw err;
    }
  }));

  test("T11. three typists for 30 s: pushes a second under budget, remote text visible within one second, no lag growth", () => evidence("T11", async () => {
    await settle();
    const opened = await openSharedUser("carol");
    assert.deepEqual([opened.identity.meName, opened.identity.viewerName, opened.identity.namePrompts], [CAROL, CAROL, 0], "carol opens under her account name, no dialog");
    carol = opened.u;
    const id = await sharedRoot("Shared:");
    await h.card(carol.frame, id).waitFor({ timeout: 15_000 });
    const typists = { alice, bob, carol };
    const eds = {};
    for (const [k, u] of Object.entries(typists)) {
      eds[k] = await h.openEditor(u.frame, id);
      await eds[k].focus();
      await eds[k].press("Control+End");
    }
    const seq0 = (await w.settledState(alice.frame)).seq;
    const t0 = Date.now();
    const tokens = { alice: [], bob: [], carol: [] };
    const probes = [];
    let stop = false;
    // Alice's typist and the prober share alice's textarea: whole words take turns through this
    // lock, or their keystrokes interleave and no probe token ever exists in the text.
    let aliceTurn = Promise.resolve();
    const aliceTypes = (word) => (aliceTurn = aliceTurn.then(() => eds.alice.pressSequentially(word, { delay: 60 })));
    const typist = async (k) => {
      let i = 0;
      while (!stop) {
        const word = ` ${k[0]}${i++}`;
        tokens[k].push(word.trim());
        await (k === "alice" ? aliceTypes(word) : eds[k].pressSequentially(word, { delay: 60 }));
      }
    };
    const prober = async () => {
      let k = 0;
      while (Date.now() - t0 < 30_000) {
        await sleep(3000);
        const token = `zq${k++}q`;
        const sent = Date.now();
        tokens.alice.push(token); // in queue order, which is typing order
        await aliceTypes(` ${token}`);
        const at = Date.now();
        try {
          await until(async () => (await eds.bob.inputValue()).includes(token), { timeout: 10_000, interval: 20, message: `probe ${token} visible for bob` });
        } catch (err) {
          stop = true;
          timings.T11_probe_diag = {
            token, aliceHasToken: (await eds.alice.inputValue()).includes(token), bobTail: (await eds.bob.inputValue()).slice(-200), aliceTail: (await eds.alice.inputValue()).slice(-200),
            bobStore: await inPane(bob.frame, (store, _, a) => JSON.stringify(store.getState().text?.[a] ?? store.getState().blips?.[a]?.textState ?? null).slice(0, 400), id),
            aliceStore: await inPane(alice.frame, (store, _, a) => JSON.stringify(store.getState().text?.[a] ?? store.getState().blips?.[a]?.textState ?? null).slice(0, 400), id),
            bobConn: await inPane(bob.frame, (store) => store.getState().connection),
          };
          throw err;
        }
        probes.push({ ms: Date.now() - at, sinceStart: sent - t0 });
      }
      stop = true;
    };
    await Promise.all([typist("alice"), typist("bob"), typist("carol"), prober()]);
    const elapsed = (Date.now() - t0) / 1000;
    for (const u of Object.values(typists)) await h.closeEditor(u.frame);
    for (const u of Object.values(typists)) await h.waitSaved(u.frame, id, 30_000);
    const events = (await w.textEventsSince(alice.frame, seq0)).filter((e) => e.blipId === id);
    const first = probes.filter((x) => x.sinceStart < 10_000).map((x) => x.ms);
    const last = probes.filter((x) => x.sinceStart > 20_000).map((x) => x.ms);
    timings.T11 = { durationS: elapsed, pushes: events.length, pushesPerSecond: Math.round((events.length / elapsed) * 10) / 10, probes: h.stats(probes.map((x) => x.ms)), probesFirst: h.stats(first), probesLast: h.stats(last) };
    log(`T11 ${JSON.stringify(timings.T11)}`);
    assert.ok(timings.T11.pushesPerSecond < 30, `text pushes per second ${timings.T11.pushesPerSecond} leave room for presence in the 45/s budget`);
    assert.ok(probes.length >= 3 && Math.max(...probes.map((x) => x.ms)) <= 1000, `remote text visible within 1 s (${probes.map((x) => x.ms)})`);
    assert.ok((last.length ? h.stats(last).p50 : 0) <= (first.length ? h.stats(first).p50 : 0) + 300, "no queue build-up over the run");
    const text = await until(async () => {
      const [a, b, c] = await Promise.all(Object.values(typists).map((u) => h.readText(u.frame, id)));
      return a === b && b === c ? a : null;
    }, { timeout: 30_000, interval: 200, message: "everyone converges" });
    for (const [k, list] of Object.entries(tokens)) assert.deepEqual(missingInOrder(text, list), [], `${k}'s words in order`);
    await shot("t11-three-typists");
    await Promise.race([carol.context.close(), sleep(5000)]);
    carol = null;
  }));

  test("T12. stub disposal: 10 frame reloads + a reopened context, then server churn: no warnings, no crash, sane peers", () => evidence("T12", async () => {
    await settle();
    const serverFrom = serverConsole.length;
    const logFrom = await w.logOffset();
    const reloadMs = [];
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      await w.reloadFrame(bob.frame);
      await w.ensureLive(bob.frame, BOB);
      reloadMs.push(Date.now() - t0);
    }
    timings.T12_bob_frame_reload_ms = h.stats(reloadMs);
    await Promise.race([bob.context.close(), sleep(5000)]);
    bob = await openUser("bob");
    await openWave(bob, workspaceUrl);

    const t1 = Date.now();
    await until(async () => {
      const peers = await w.peerList(alice.frame);
      return peers.length === 1 && peers[0].name === BOB;
    }, { timeout: 30_000, interval: 250, message: "alice sees exactly one peer (bob)" }).catch(async (e) => {
      throw new Error(`${e.message}; peers: ${JSON.stringify(await w.peerList(alice.frame))}`);
    });
    timings.T12_alice_peers_settled_ms = Date.now() - t1;
    assert.deepEqual((await w.peerList(bob.frame)).map((x) => x.name), [ALICE]);

    // Server allocation pressure: create and soft-delete 100 bulky blips, three rounds.
    const t2 = Date.now();
    for (let round = 0; round < 3; round++) {
      const ids = await inPane(alice.frame, (store, _, r) => Array.from({ length: 100 }, (_, i) =>
        store.createBlip({ parentId: null, text: `churn ${r}/${i} ` + "x".repeat(3000) })), round);
      await w.settledState(alice.frame, 60_000);
      await inPane(alice.frame, (store, _, list) => { for (const id of list) store.deleteBlip(id); }, ids);
      await w.settledState(alice.frame, 60_000);
    }
    timings.T12_churn_ms = Date.now() - t2;
    await sleep(5000);

    const id = await sharedRoot("Still alive after churn.");
    await h.typeInto(bob.frame, id, " and syncing", { delay: 15 });
    await h.closeEditor(bob.frame);
    await h.waitForText(alice.frame, id, "and syncing", { timeout: 15_000 });

    const bad = serverConsole.slice(serverFrom).filter((l) => w.STUB_WARNING.test(l) || w.RUNTIME_CRASH.test(l));
    const badLog = await w.logLinesSince(logFrom, PROBLEM);
    timings.T12_problems = { serverConsole: bad, platformLog: badLog };
    assert.deepEqual(bad, [], "owner console: no stub warnings or runtime crash");
    assert.deepEqual(badLog, [], "platform log: no stub warnings or runtime crash");
    assert.deepEqual(await w.logLinesSince(logStart, w.RUNTIME_CRASH), [], "no runtime crash during the whole run");
  }));

  test("T13. bob (use role) has no Share or Code tab, and can edit, reply and review", () => evidence("T13", async () => {
    await settle();
    assert.equal(await alice.page.getByRole("button", { name: "Share workspace" }).count(), 1);
    assert.equal(await alice.page.getByRole("button", { name: "Code", exact: true }).count(), 1);
    assert.equal(await bob.page.getByRole("button", { name: "Share workspace" }).count(), 0);
    assert.equal(await bob.page.getByRole("button", { name: "Code", exact: true }).count(), 0);
    assert.equal(await bob.page.locator(".monaco-editor").count(), 0);
    assert.equal(await bob.page.getByRole("button", { name: "Export Gadget" }).count(), 1);
    await bob.page.screenshot({ path: join(SHOTS, "t13-bob-use-view.png") });

    // Edit.
    const root = await sharedRoot("Bob will edit this.");
    let t0 = Date.now();
    await h.typeInto(bob.frame, root, " Edited by Bob.", { delay: 15 });
    await h.closeEditor(bob.frame);
    await h.waitForText(alice.frame, root, "Edited by Bob.", { timeout: 15_000 });
    timings.T13_bob_edit_to_alice_ms = Date.now() - t0;
    // Reply, by keyboard: R on the focused card opens the composer at the end of the thread.
    await h.card(bob.frame, root).focus();
    await h.card(bob.frame, root).press("r");
    const composer = bob.frame.locator(SEL.blipEditor).first();
    await composer.waitFor({ timeout: 5000 });
    await composer.pressSequentially("Reply from Bob", { delay: 15 });
    const reply = await until(() => inPane(bob.frame, (store, _, pid) =>
      Object.values(store.getState().blips).find((b) => b.parentId === pid && !b.deleted) ?? null, root), { timeout: 10_000, message: "bob's reply exists" });
    await composer.press("Control+Enter");
    t0 = Date.now();
    await h.card(alice.frame, reply.id).waitFor({ timeout: 15_000 });
    await h.waitForText(alice.frame, reply.id, "Reply from Bob", { timeout: 15_000 });
    timings.T13_bob_reply_to_alice_ms = Date.now() - t0;
    assert.equal((await w.frameBlip(alice.frame, reply.id))?.by, BOB, "bob's reply is attributed to his account name");
    assert.equal((await w.frameBlip(alice.frame, root))?.by, ALICE, "alice's root is attributed to her account name");
    // Review: a proposal left in review (from T10, when a model exists) is rejected by bob;
    // otherwise bob records a decision, the other review-type write a use-role user makes.
    const state = await w.settledState(bob.frame);
    const pending = Object.values(state.blips).find((b) => b.kind === "proposal" && b.proposal?.state === "review" && !b.deleted);
    if (pending) {
      await h.card(bob.frame, pending.id).locator(SEL.proposalReject).click();
      await until(async () => (await w.frameBlip(alice.frame, pending.id))?.proposal?.state === "rejected", { timeout: 15_000, message: "alice sees the rejection" });
      assert.equal((await w.frameBlip(alice.frame, pending.id))?.proposal?.reviewedBy, BOB, "the rejection is attributed to bob's account name");
      timings.T13_review = "rejected a pending proposal";
    } else {
      const d = await inPane(bob.frame, (store, _, a) => store.recordDecision(a), { threadId: root, text: "Bob's decision", rationale: "Recorded from the use-role view." });
      assert.ok(d?.blip?.id, "decision recorded: " + JSON.stringify(d).slice(0, 200));
      await h.card(alice.frame, d.blip.id).waitFor({ timeout: 15_000 });
      assert.equal(await h.card(alice.frame, d.blip.id).getAttribute("data-kind"), "decision");
      assert.equal((await w.frameBlip(alice.frame, d.blip.id))?.decision?.recordedBy, BOB, "bob's decision is attributed to his account name");
      timings.T13_review = "recorded a decision (no proposal to review without a model)";
    }
    await shot("t13-bob-edited");
  }));

  test("T14. Markdown export of decisions contains the decision, rationale, dissent, next steps and source ids; platform exports work", () => evidence("T14", async () => {
    await settle();
    const root = await sharedRoot("Which onboarding approach? (export)");
    const evidenceId = await w.createInFrame(alice.frame, { parentId: root, text: "Self-serve is cheaper per customer." });
    const d = await inPane(alice.frame, (store, _, a) => store.recordDecision(a), {
      threadId: root, text: "We choose option B (self-serve).", rationale: `Lower cost per customer; see ${evidenceId}.`,
      dissent: "Harry prefers white-glove for the first three customers.", nextSteps: "Alice drafts the onboarding checklist by Friday.",
    });
    assert.ok(d?.blip?.id, "decision recorded");
    await h.card(bob.frame, d.blip.id).waitFor({ timeout: 15_000 });
    assert.equal((await w.frameBlip(bob.frame, d.blip.id))?.decision?.recordedBy, ALICE, "alice's decision is attributed to her account name");
    const md = await inPane(alice.frame, (store) => store.exportMarkdown({ decisions: true }));
    for (const s of ["We choose option B (self-serve).", "Lower cost per customer", "Harry prefers white-glove", "Alice drafts the onboarding checklist", evidenceId, root]) {
      assert.ok(md.includes(s), `decision export contains ${JSON.stringify(s)}`);
    }
    await writeFile(join(SHOTS, "t14-decisions.md"), md);

    await alice.page.bringToFront();
    const formats = await p.listExportFormats(alice.page);
    timings.T14_formats = formats;
    assert.ok(formats.some((f) => /^HTML$/.test(f)) && formats.some((f) => /^PDF$/.test(f)), `HTML and PDF offered: ${formats}`);
    const mdLabel = formats.find((f) => /markdown/i.test(f));
    if (mdLabel) {
      let t0 = Date.now();
      const file = await p.downloadExport(alice.page, new RegExp(`^${h.escapeRe(mdLabel)}$`));
      timings.T14_markdown = { filename: file.filename, bytes: file.bytes.length, ms: Date.now() - t0 };
      await writeFile(join(SHOTS, "t14-export.md"), file.bytes);
      assert.ok(file.text.includes("We choose option B"), "the platform's Markdown export has the decision");
    } else {
      notes.push("T14: no Markdown format in the export menu (server-mode markdown not offered)");
    }
    let t0 = Date.now();
    const html = await p.downloadExport(alice.page, /^HTML$/);
    timings.T14_html = { filename: html.filename, bytes: html.bytes.length, ms: Date.now() - t0 };
    await writeFile(join(SHOTS, "t14-export.html"), html.bytes);
    assert.ok(html.text.includes("We choose option B"), "HTML export renders the decision");
    t0 = Date.now();
    const pdf = await p.downloadExport(alice.page, /^PDF$/);
    timings.T14_pdf = { filename: pdf.filename, bytes: pdf.bytes.length, ms: Date.now() - t0 };
    await writeFile(join(SHOTS, "t14-export.pdf"), pdf.bytes);
    assert.equal(pdf.bytes.subarray(0, 5).toString("latin1"), "%PDF-", "PDF export is a PDF");
    assert.ok(pdf.bytes.length > 1000, `PDF has content (${pdf.bytes.length} bytes)`);
    await w.waitLive(alice.frame, 10_000);
  }));

  test("T15. a restart during a model call leaves the run unknown with Retry; nothing respawns", () => evidence("T15", async () => {
    await settle();
    if (!hasModel) {
      timings.T15 = "skipped: no model";
      notes.push("T15 skipped: capabilities.model is false");
      return;
    }
    await sharedRoot("Something long enough to summarise during a restart.");
    const started = await inPane(alice.frame, (store) => store.askAgent({ op: "summarise" }));
    assert.ok(started?.run?.id, "run started");
    const runId = started.run.id;
    await waitRun(alice.frame, runId, ["running", "done", "failed"], 30_000);
    const r = await w.editServerJsAndWatch({ owner: alice, other: bob, log, shots: SHOTS });
    timings.T15 = { bobLiveAgainByMs: r.recoveredAtMs, bobFrameReloadedByMs: r.reloadedAtMs };
    await alice.page.getByRole("button", { name: GADGET_TAB }).click();
    await w.ensureLive(alice.frame, ALICE);
    await w.ensureLive(bob.frame, BOB);
    const run = await waitRun(bob.frame, runId, ["unknown", "done", "failed"], 60_000);
    if (run.state !== "unknown") {
      notes.push(`T15: the model call finished (${run.state}) before the restart took effect; the unknown path was not exercised`);
      timings.T15.outcome = run.state;
      return;
    }
    await h.openPanel(bob.frame, "agent");
    const card = bob.frame.locator(SEL.runCard(runId));
    await card.waitFor({ timeout: 10_000 });
    assert.equal(await card.getAttribute("data-state"), "unknown");
    await card.locator(SEL.runRetry).waitFor({ timeout: 5000 });
    assert.match(await card.innerText(), /restarted/i);
    await sleep(5000);
    const runs = Object.values((await w.settledState(alice.frame)).runs);
    assert.equal(runs.filter((x) => x.state === "running" || x.state === "queued").length, 0, "nothing respawned");
    assert.equal(runs.find((x) => x.id === runId).state, "unknown");
    await shot("t15-unknown-run");
  }));
});
