// Multi-browser end-to-end tests of the whiteboard against a REAL local Cloudflare OS Workshop
// (docs/plans/whiteboard-blueprint.md "Tests (two-browser session)"). See ./README.md section 4.
//
//   e2e/start-local-platform.sh                                   # once; prints PGID + URL
//   pnpm --filter blueprint-whiteboard pack:gadget                # from the repo root
//   node --test --test-concurrency=1 e2e/platform.test.mjs        # from packages/blueprint-whiteboard
//   e2e/stop-local-platform.sh
//
// Env: CFOS_URL (default http://localhost:8787); PLATFORM_SHOTS (screenshots, exports and
// timings.json; default ${TMPDIR:-/tmp}/whiteboard-platform-shots); CFOS_LOG (platform log, as
// for start-local-platform.sh). Uploads formats/whiteboard.gadget as is. Users: alice (owner), bob
// (use-role share link), carol (a third use-role context in T6). T8 of the plan (agent chat) needs
// a model and is not run; this suite's T8 is the use-role chrome check.

import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as p from "./platform-helpers.mjs";
import * as h from "./harness-helpers.mjs";
import * as w from "./platform-whiteboard-helpers.mjs";

const { SEL, inPane, until } = h;
const BASE = (process.env.CFOS_URL || p.DEFAULT_BASE_URL).replace(/\/$/, "");
const SHOTS = process.env.PLATFORM_SHOTS || join(tmpdir(), "whiteboard-platform-shots");
const PASSWORD = "correct-horse-battery-staple";
const FORM_BLOCKED = /Blocked form submission/;
const GADGET_TAB = /^(Whiteboard|App)$/;

/** @type {Record<string, any>} */
const timings = {};
/** @type {string[]} */
const notes = [];
const log = (/** @type {string} */ s) => console.log(`# [${new Date().toISOString().slice(11, 23)}] ${s}`);
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** @type {import("playwright").Browser} */
let browser;
/** @type {string} */
let workspaceUrl;
/** @typedef {Awaited<ReturnType<typeof openUser>>} User */
/** @type {User} */
let alice;
/** @type {User} */
let bob;
/** @type {User|null} */
let carol = null;
/** @type {{meName: string, namePrompts: number}} */
let aliceIdentity;
/** @type {{meName: string, namePrompts: number}} */
let bobIdentity;
/** Display names of the local accounts (what `gadgetViewer.displayName` carries). */
const ALICE = w.accountDisplayName("alice");
const BOB = w.accountDisplayName("bob");
const CAROL = w.accountDisplayName("carol");
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
 * Opens the whiteboard at `url` for `user`. Nobody is asked for a name: returns what it shows.
 * @param {User} user @param {string} url
 */
async function openBoard(user, url) {
  await user.page.goto(url);
  await w.waitLive(user.frame);
  const identity = await w.boardIdentity(user.frame);
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
  }
}

/** Time until `fn` is truthy, polling every 20 ms. */
async function timeUntil(/** @type {() => Promise<unknown>} */ fn, /** @type {number} */ timeout, /** @type {string} */ message) {
  const t0 = Date.now();
  await until(fn, { timeout, interval: 20, message });
  return Date.now() - t0;
}

/** @param {number[]} xs */
function stats(xs) {
  if (!xs.length) return { n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (/** @type {number} */ f) => Math.round(s[Math.min(s.length - 1, Math.floor(s.length * f))] * 10) / 10;
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: Math.round(s[s.length - 1] * 10) / 10 };
}

/** @param {User} u */
async function toSelectTool(u) {
  await inPane(u.frame, (_, canvas) => { canvas.setTool("select"); canvas.setSelection([]); canvas.follow(null); });
}

/**
 * Before each test: both main users live, Select tool, camera at the world origin, empty board.
 */
async function resetBoard() {
  for (const [u, name] of /** @type {[User, string][]} */ ([[alice, ALICE], [bob, BOB]])) {
    await w.ensureLive(u.frame, name);
    await toSelectTool(u);
    await h.setCamera(u.frame, { x: 0, y: 0, zoom: 1 });
  }
  const ids = await inPane(alice.frame, (store) => Object.keys(store.getState().board.objects));
  if (ids.length) {
    for (let i = 0; i < ids.length; i += 400) {
      await inPane(alice.frame, (store, _, chunk) => store.deleteObjects(chunk), ids.slice(i, i + 400));
    }
  }
  for (const u of [alice, bob]) {
    await until(async () => (await w.settledBoard(u.frame)) && (await u.frame.locator(SEL.anyObject).count()) === 0,
      { timeout: 30_000, interval: 100, message: `${u.username}'s board is empty` });
  }
  await sleep(150);
}

/**
 * Alice creates objects; waits until both main frames draw them and alice has no pending ops.
 * @param {any[]} objects
 */
async function createShared(objects) {
  const ids = await w.createInFrame(alice.frame, objects);
  for (const u of [alice, bob]) {
    for (const id of ids) await u.frame.locator(SEL.object(id)).waitFor({ timeout: 10_000 });
  }
  await w.settledBoard(alice.frame);
  return ids;
}

/**
 * Alice creates a use-role share link and a new user opens it.
 * @param {string} username
 */
async function openSharedUser(username) {
  await alice.page.bringToFront();
  const shareUrl = await p.createUseShareLink(alice.page);
  const u = await openUser(username);
  const identity = await openBoard(u, shareUrl);
  return { u, identity };
}

before(async () => {
  await mkdir(SHOTS, { recursive: true });
  logStart = await w.logOffset();
  browser = await p.launch();
  log(`archive ${w.SHIPPED_ARCHIVE}`);

  alice = await openUser("alice");
  const blueprintId = await p.uploadGadget(alice.page, BASE, w.SHIPPED_ARCHIVE);
  const t0 = Date.now();
  workspaceUrl = await p.createGadgetFromBlueprint(alice.page, BASE, blueprintId);
  log(`workspace ${workspaceUrl}`);
  await w.waitLive(alice.frame);
  timings.setup_create_to_alice_live_ms = Date.now() - t0;
  aliceIdentity = await w.boardIdentity(alice.frame);
  await w.recordConnection(alice.frame);

  const shareUrl = await p.createUseShareLink(alice.page);
  bob = await openUser("bob");
  bobIdentity = await openBoard(bob, shareUrl);
  await alice.frame.locator(SEL.peerNamed(BOB)).waitFor({ timeout: 15_000 });
  await bob.frame.locator(SEL.peerNamed(ALICE)).waitFor({ timeout: 15_000 });
  log("alice and bob are live on the whiteboard");
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
  timings.platformLogProblems = await w.logLinesSince(logStart, new RegExp(`${w.STUB_WARNING.source}|${w.RUNTIME_CRASH.source}`));
  await writeFile(join(SHOTS, "timings.json"), JSON.stringify(timings, null, 2)).catch(() => {});
  await writeFile(join(SHOTS, "server-console.log"), serverConsole.join("\n")).catch(() => {});
  console.log("TIMINGS " + JSON.stringify(timings, null, 2));
  await browser?.close();
});

describe("whiteboard on the local platform", { concurrency: false }, () => {
  test("0a. the shipped client boots; nobody is asked for a name, each sees their account name; no errors", () => evidence("0a", async () => {
    assert.equal(aliceIdentity.namePrompts, 0, "alice (owner) saw no name dialog");
    assert.equal(bobIdentity.namePrompts, 0, "bob (use-role share link) saw no name dialog");
    assert.equal(aliceIdentity.meName, ALICE, "alice's me button shows her account display name");
    assert.equal(bobIdentity.meName, BOB, "bob's me button shows his account display name");
    for (const u of [alice, bob]) {
      assert.equal(await u.frame.locator("form").count(), 0, "no <form> in the client");
      assert.equal(await u.frame.locator(SEL.toolbar).count(), 1, "toolbar rendered");
      assert.deepEqual([...u.consoleErrors, ...u.frameErrors].filter((e) => FORM_BLOCKED.test(e)), [], `${u.username}: no blocked form submissions`);
      assert.deepEqual(u.frameErrors, [], `${u.username}: no console errors in the gadget frame`);
    }
    timings["0a_page_console_errors"] = { alice: alice.consoleErrors.slice(), bob: bob.consoleErrors.slice() };
    await shot("0a-joined");
  }));

  test("T1. ghost drag: bob sees alice's ghost move before release, then the committed position", () => evidence("T1", async () => {
    await resetBoard();
    const [id] = await createShared([{ type: "sticky", x: 300, y: 250, text: "Drag me" }]);
    const before = await w.frameObject(alice.frame, id);
    assert.equal(before.createdBy, ALICE, "created through alice's store: attributed to her account name");
    const start = await h.objectCenter(alice.frame, id);
    /** @type {number[]} */
    const ghostXs = [];
    const t0 = Date.now();
    await h.dragBy(alice.page, start, 240, 60, {
      steps: 24, stepDelay: 25,
      hold: async () => {
        const ghost = bob.frame.locator(SEL.ghost(id)).first();
        await ghost.waitFor({ timeout: 5000 });
        timings.T1_ghost_seen_after_drag_start_ms = Date.now() - t0;
        ghostXs.push(/** @type {any} */ (await ghost.boundingBox()).x);
        await alice.page.mouse.move(start.x + 280, start.y + 80, { steps: 4 });
        const t1 = Date.now();
        await until(async () => {
          const b = await bob.frame.locator(SEL.ghost(id)).first().boundingBox();
          return b && b.x > ghostXs[0] + 20 && ghostXs.push(b.x);
        }, { timeout: 5000, interval: 20, message: "ghost moves in bob's frame" });
        timings.T1_ghost_follows_move_ms = Date.now() - t1;
        assert.equal((await w.frameObject(bob.frame, id)).x, before.x, "no commit before release");
        await shot("t1-ghost");
      },
    });
    const released = Date.now();
    const committed = await until(async () => {
      const o = await w.frameObject(bob.frame, id);
      return o && o.x !== before.x && o;
    }, { timeout: 10_000, interval: 20, message: "bob has the committed position" });
    timings.T1_release_to_bob_commit_ms = Date.now() - released;
    assert.ok(Math.abs(committed.x - (before.x + 280)) <= 2, `x moved by the drag: ${committed.x}`);
    assert.ok(Math.abs(committed.y - (before.y + 80)) <= 2, `y moved by the drag: ${committed.y}`);
    await bob.frame.locator(SEL.anyGhost).waitFor({ state: "detached", timeout: 5000 });
    timings.T1_release_to_ghost_gone_ms = Date.now() - released;
    const server = (await w.settledBoard(alice.frame)).objects[id];
    assert.deepEqual([server.x, server.y], [committed.x, committed.y], "alice (settled) agrees");
  }));

  test("T2. live stroke: bob sees alice's pen stroke grow, then a committed pen object", () => evidence("T2", async () => {
    await resetBoard();
    await alice.frame.locator(SEL.tool("pen")).click();
    const from = await w.framePoint(alice.page, 400, 300);
    /** @type {number[]} */
    const lengths = [];
    await alice.page.mouse.move(from.x, from.y);
    await alice.page.mouse.down();
    const t0 = Date.now();
    for (let i = 1; i <= 15; i++) {
      await alice.page.mouse.move(from.x + i * 12, from.y + Math.sin(i / 2) * 30);
      await sleep(20);
    }
    const stroke = bob.frame.locator(SEL.remoteStroke).first();
    await stroke.waitFor({ timeout: 5000 });
    timings.T2_live_stroke_seen_ms = Date.now() - t0;
    lengths.push((/** @type {string} */ (await stroke.getAttribute("d"))).length);
    for (let i = 16; i <= 40; i++) {
      await alice.page.mouse.move(from.x + i * 12, from.y + Math.sin(i / 2) * 30);
      await sleep(20);
    }
    await until(async () => {
      const d = await bob.frame.locator(SEL.remoteStroke).first().getAttribute("d");
      return d && d.length > lengths[0] && lengths.push(d.length);
    }, { timeout: 5000, interval: 20, message: "bob's live stroke grows" });
    const pensBefore = await inPane(bob.frame, (store) => Object.values(store.getState().board.objects).filter((o) => o.type === "pen").length);
    assert.equal(pensBefore, 0, "nothing committed while drawing");
    await shot("t2-live-stroke");
    await alice.page.mouse.up();
    const released = Date.now();
    const pen = await until(() => inPane(bob.frame, (store) => Object.values(store.getState().board.objects).find((o) => o.type === "pen")),
      { timeout: 10_000, interval: 20, message: "bob has the pen object" });
    timings.T2_release_to_bob_pen_ms = Date.now() - released;
    timings.T2_stroke_d_lengths = lengths;
    assert.ok(pen.points.length >= 8, `pen has points: ${pen.points.length / 2}`);
    await bob.frame.locator(SEL.object(pen.id)).waitFor({ timeout: 5000 });
    await bob.frame.locator(SEL.remoteStroke).waitFor({ state: "detached", timeout: 5000 });
    await toSelectTool(alice);
  }));

  test("T3. concurrent nudges of the same sticky: both deltas land on the server and in both frames", () => evidence("T3", async () => {
    await resetBoard();
    // (a) real pointer drags in both browsers at the same time.
    const [id] = await createShared([{ type: "sticky", x: 300, y: 250, text: "Shared" }]);
    await w.settledBoard(bob.frame);
    const before = await w.frameObject(alice.frame, id);
    const a = await h.objectCenter(alice.frame, id);
    const b = await h.objectCenter(bob.frame, id);
    const t0 = Date.now();
    await Promise.all([
      h.dragBy(alice.page, a, 100, 0, { steps: 8, stepDelay: 15 }),
      h.dragBy(bob.page, b, 60, 0, { steps: 8, stepDelay: 15 }),
    ]);
    const want = before.x + 160;
    /** @type {Record<string, any>} */
    const seen = {};
    try {
      for (const u of [alice, bob]) {
        await until(async () => {
          const board = await w.settledBoard(u.frame);
          seen[u.username] = { x: board.objects[id]?.x, y: board.objects[id]?.y };
          return board.objects[id]?.x === want;
        }, { timeout: 10_000, interval: 100, message: `${u.username} x = ${want}` });
      }
    } finally {
      timings.T3_pointer = { before: { x: before.x, y: before.y }, want, seen, converged_ms: Date.now() - t0 };
    }
    assert.equal((await w.frameObject(bob.frame, id)).y, before.y);

    // (b) store.updateObjects in both frames, started in the same tick (same baseVersion).
    const cur = await w.frameObject(alice.frame, id);
    const t1 = Date.now();
    await Promise.all([
      inPane(alice.frame, (store, _, oid) => { const o = store.getState().board.objects[oid]; store.updateObjects([{ id: oid, patch: { x: o.x + 40, y: o.y + 10 } }]); }, id),
      inPane(bob.frame, (store, _, oid) => { const o = store.getState().board.objects[oid]; store.updateObjects([{ id: oid, patch: { x: o.x + 25, y: o.y - 30 } }]); }, id),
    ]);
    const want2 = { x: cur.x + 65, y: cur.y - 20 };
    /** @type {Record<string, any>} */
    const seen2 = {};
    try {
      for (const u of [alice, bob]) {
        await until(async () => {
          const o = (await w.settledBoard(u.frame)).objects[id];
          seen2[u.username] = { x: o?.x, y: o?.y, version: o?.version };
          return o?.x === want2.x && o?.y === want2.y;
        }, { timeout: 10_000, interval: 100, message: `${u.username} at ${JSON.stringify(want2)}` });
      }
    } finally {
      timings.T3_store = { before: { x: cur.x, y: cur.y, version: cur.version }, want: want2, seen: seen2, converged_ms: Date.now() - t1 };
    }
    // Server truth: a fresh subscription (bob's frame reloaded) reads the stored object.
    await bob.frame.locator("body").evaluate(() => { /** @type {any} */ (window).__e2eMarker = 1; location.reload(); }).catch(() => {});
    await until(() => bob.frame.locator("body").evaluate(() => /** @type {any} */ (window).__e2eMarker === undefined).catch(() => false),
      { timeout: 15_000, message: "bob's frame reloaded" });
    await w.ensureLive(bob.frame, BOB);
    const fresh = (await w.settledBoard(bob.frame)).objects[id];
    assert.deepEqual({ x: fresh.x, y: fresh.y }, want2, "server has both nudges");
  }));

  test("T4. deleting a sticky with a connector: bob sees both vanish", () => evidence("T4", async () => {
    await resetBoard();
    const [s1, s2] = await createShared([
      { type: "sticky", x: 300, y: 250, text: "From" },
      { type: "sticky", x: 700, y: 250, text: "To" },
    ]);
    const [c] = await createShared([{ type: "connector", from: s1, to: s2 }]);
    const at = await h.objectCenter(alice.frame, s1);
    await alice.page.mouse.click(at.x, at.y);
    await until(async () => (await inPane(alice.frame, (_, canvas) => canvas.getSelection())).includes(s1), { message: "s1 selected" });
    const t0 = Date.now();
    await alice.page.keyboard.press("Delete");
    await bob.frame.locator(SEL.object(s1)).waitFor({ state: "detached", timeout: 5000 });
    await bob.frame.locator(SEL.object(c)).waitFor({ state: "detached", timeout: 5000 });
    timings.T4_delete_to_bob_ms = Date.now() - t0;
    await bob.frame.locator(SEL.object(s2)).waitFor();
    assert.deepEqual(Object.keys((await w.settledBoard(alice.frame)).objects), [s2]);
    assert.deepEqual(Object.keys((await w.settledBoard(bob.frame)).objects), [s2]);
  }));

  test("T5. follow: bob follows alice and tracks her pans; bob panning stops it", () => evidence("T5", async () => {
    await resetBoard();
    await createShared([{ type: "sticky", x: 300, y: 250, text: "Landmark" }]);
    const aId = await h.clientId(alice.frame);
    await bob.frame.locator(SEL.peer(aId)).click();
    await bob.frame.locator(SEL.followChip).waitFor({ timeout: 5000 });
    assert.match(await bob.frame.locator(SEL.followChip).innerText(), new RegExp(`Following\\s+${ALICE}`));

    const center = (/** @type {any} */ vp) => ({ x: vp.x + vp.w / 2, y: vp.y + vp.h / 2 });
    await alice.frame.locator(SEL.tool("hand")).click();
    const t0 = Date.now();
    await h.dragBy(alice.page, await w.framePoint(alice.page, 600, 500), -300, -200, { steps: 10, stepDelay: 10 });
    const vpA = center(await inPane(alice.frame, (_, canvas) => canvas.getViewport()));
    await until(async () => {
      const vpB = center(await inPane(bob.frame, (_, canvas) => canvas.getViewport()));
      return Math.abs(vpB.x - vpA.x) < 5 && Math.abs(vpB.y - vpA.y) < 5;
    }, { timeout: 5000, interval: 20, message: "bob's viewport tracks alice's" });
    timings.T5_follow_converged_ms = Date.now() - t0;
    await shot("t5-follow");

    await bob.frame.locator(SEL.tool("hand")).click();
    await h.dragBy(bob.page, await w.framePoint(bob.page, 600, 500), 150, 0, { steps: 6 });
    await bob.frame.locator(SEL.followChip).waitFor({ state: "hidden", timeout: 5000 });
    assert.equal(await inPane(bob.frame, (_, canvas) => canvas.getFollowing()), null);
    const vpB1 = await inPane(bob.frame, (_, canvas) => canvas.getViewport());
    await h.dragBy(alice.page, await w.framePoint(alice.page, 600, 500), 250, 250, { steps: 6 });
    await sleep(800);
    assert.deepEqual(await inPane(bob.frame, (_, canvas) => canvas.getViewport()), vpB1, "bob no longer moves with alice");
  }));

  test("T6. carol's tab dies mid-drag (crash, then context close): alice's ghost goes within 15 s", () => evidence("T6", async () => {
    await resetBoard();
    const opened = await openSharedUser("carol");
    carol = opened.u;
    assert.deepEqual(opened.identity, { meName: CAROL, namePrompts: 0 }, "carol opens under her account name, no dialog");
    await h.setCamera(carol.frame, { x: 0, y: 0, zoom: 1 });
    const [id] = await createShared([{ type: "sticky", x: 300, y: 250, text: "Orphan" }]);
    await carol.frame.locator(SEL.object(id)).waitFor({ timeout: 10_000 });
    await alice.frame.locator(SEL.peerNamed(CAROL)).waitFor({ timeout: 10_000 });
    const before = await w.frameObject(alice.frame, id);

    for (const how of /** @type {const} */ (["crash", "close"])) {
      if (how === "close") {
        carol = await openUser("carol");
        await openBoard(carol, workspaceUrl);
        await h.setCamera(carol.frame, { x: 0, y: 0, zoom: 1 });
        await carol.frame.locator(SEL.object(id)).waitFor({ timeout: 10_000 });
        await alice.frame.locator(SEL.peerNamed(CAROL)).waitFor({ timeout: 10_000 });
        await sleep(200);
      }
      const c = /** @type {User} */ (carol);
      const start = await h.objectCenter(c.frame, id);
      await h.dragBy(c.page, start, 200, 100, { steps: 10, stepDelay: 20, release: false });
      await alice.frame.locator(SEL.ghost(id)).first().waitFor({ timeout: 5000 });
      await shot(`t6-${how}-ghost`);
      const killedAt = Date.now();
      if (how === "crash") {
        const cdp = await c.context.newCDPSession(c.page);
        cdp.send("Page.crash").catch(() => {}); // never answers
        await c.page.waitForEvent("crash", { timeout: 5000 }).catch(() => notes.push("T6: no crash event seen"));
      } else {
        await c.context.close();
      }
      carol = null;
      await alice.frame.locator(SEL.anyGhost).waitFor({ state: "detached", timeout: 15_000 });
      const took = Date.now() - killedAt;
      timings[`T6_${how}_ghost_gone_ms`] = took;
      await alice.frame.locator(SEL.peerNamed(CAROL)).waitFor({ state: "detached", timeout: Math.max(1, 15_000 - took) });
      timings[`T6_${how}_peer_gone_ms`] = Date.now() - killedAt;
      const o = (await w.settledBoard(alice.frame)).objects[id];
      assert.deepEqual([o.x, o.y], [before.x, before.y], "object stays at its committed position");
      const ob = await w.frameObject(bob.frame, id);
      assert.deepEqual([ob.x, ob.y], [before.x, before.y]);
      if (how === "crash") await Promise.race([c.context.close(), sleep(5000)]);
    }
  }));

  test("T7. 500 objects: bob pans smoothly; a remote single update re-renders only that object", () => evidence("T7", async () => {
    await resetBoard();
    const types = ["sticky", "rect", "ellipse", "text"];
    const t0 = Date.now();
    for (let batch = 0; batch < 5; batch++) {
      const objs = Array.from({ length: 100 }, (_, i) => {
        const n = batch * 100 + i;
        return { type: types[n % 4], x: (n % 25) * 240, y: Math.floor(n / 25) * 240, w: 200, h: 200, text: `Seed ${n}` };
      });
      await w.createInFrame(alice.frame, objs);
    }
    const aliceBoard = await w.settledBoard(alice.frame, 60_000);
    timings.T7_seed_alice_settled_ms = Date.now() - t0;
    assert.equal(Object.keys(aliceBoard.objects).length, 500);
    await until(async () => (await bob.frame.locator(SEL.anyObject).count()) >= 500, { timeout: 60_000, interval: 200, message: "bob draws 500" });
    timings.T7_seed_bob_rendered_ms = Date.now() - t0;

    await inPane(bob.frame, (_, canvas) => canvas.zoomToFit());
    await sleep(800);
    const readStats = () => bob.frame.locator("body").evaluate(() => ({ .../** @type {any} */ (window).__wbRenderStats ?? {} }));
    const p0 = await readStats();
    await bob.frame.locator("body").evaluate(() => {
      const win = /** @type {any} */ (window);
      win.__frames = []; win.__stopFrames = false;
      let last = performance.now();
      const tick = (/** @type {number} */ t) => { win.__frames.push(t - last); last = t; if (win.__frames.length < 600 && !win.__stopFrames) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    await bob.frame.locator(SEL.tool("hand")).click();
    await h.dragBy(bob.page, await w.framePoint(bob.page, 900, 500), -400, -250, { steps: 40, stepDelay: 8 });
    await h.dragBy(bob.page, await w.framePoint(bob.page, 500, 250), 400, 250, { steps: 40, stepDelay: 8 });
    const frameMs = await bob.frame.locator("body").evaluate(() => { const win = /** @type {any} */ (window); win.__stopFrames = true; return win.__frames.slice(1); });
    const p1 = await readStats();
    timings.T7_bob_pan_frames = stats(frameMs);
    timings.T7_bob_pan_render_stats_delta = { objectRenders: p1.objectRenders - p0.objectRenders, fullRenders: p1.fullRenders - p0.fullRenders };
    log(`T7 pan frames ${JSON.stringify(timings.T7_bob_pan_frames)} stats ${JSON.stringify(timings.T7_bob_pan_render_stats_delta)}`);
    await shot("t7-500");

    const target = Object.values(aliceBoard.objects).find((o) => o.type === "sticky");
    const s0 = await readStats();
    assert.ok(typeof s0.objectRenders === "number" && typeof s0.fullRenders === "number", "render stats exposed: " + JSON.stringify(s0));
    const t1 = Date.now();
    await inPane(alice.frame, (store, _, t) => store.updateObjects([{ id: t.id, patch: { x: t.x + 30 } }]), { id: target.id, x: target.x });
    await until(async () => (await w.frameObject(bob.frame, target.id))?.x === target.x + 30, { timeout: 10_000, interval: 20, message: "bob has the update" });
    timings.T7_remote_update_to_bob_ms = Date.now() - t1;
    await sleep(400);
    const s1 = await readStats();
    const delta = { objectRenders: s1.objectRenders - s0.objectRenders, fullRenders: s1.fullRenders - s0.fullRenders };
    timings.T7_remote_update_render_stats_delta = delta;
    assert.ok(delta.objectRenders >= 1 && delta.objectRenders <= 5, `objectRenders +${delta.objectRenders}`);
    assert.equal(delta.fullRenders, 0, "no full re-render for a remote single update");
    assert.ok(timings.T7_bob_pan_frames.p50 <= 50, `pan frame p50 ${timings.T7_bob_pan_frames.p50} ms`);
    await toSelectTool(bob);
  }));

  test("T8. bob (use role) has the whiteboard but no Share, Code tab or code editor; editing still works", () => evidence("T8", async () => {
    await resetBoard();
    assert.equal(await alice.page.getByRole("button", { name: "Share workspace" }).count(), 1);
    assert.equal(await alice.page.getByRole("button", { name: "Code", exact: true }).count(), 1);
    assert.equal(await bob.page.getByRole("button", { name: "Share workspace" }).count(), 0);
    assert.equal(await bob.page.getByRole("button", { name: "Code", exact: true }).count(), 0);
    assert.equal(await bob.page.locator(".monaco-editor").count(), 0);
    assert.equal(await bob.page.getByRole("button", { name: "Export Gadget" }).count(), 1);
    await bob.page.screenshot({ path: join(SHOTS, "t8-bob-use-view.png") });

    // Bob creates and types through the UI; alice sees it.
    await bob.frame.locator(SEL.addButton).click();
    await bob.frame.locator(SEL.addItem("sticky")).click();
    await bob.page.keyboard.type("From Bob");
    await bob.page.keyboard.press("Escape");
    const t0 = Date.now();
    const sticky = await until(() => inPane(alice.frame, (store) => Object.values(store.getState().board.objects).find((o) => o.type === "sticky" && o.text === "From Bob")),
      { timeout: 10_000, interval: 50, message: "alice has bob's sticky text" });
    timings.T8_bob_sticky_to_alice_ms = Date.now() - t0;
    await alice.frame.locator(SEL.object(sticky.id)).filter({ hasText: "From Bob" }).waitFor({ timeout: 5000 });
    // And bob moves it with the pointer.
    await h.setCamera(bob.frame);
    await sleep(150);
    const at = await h.objectCenter(bob.frame, sticky.id);
    await h.dragBy(bob.page, at, 80, 40, { steps: 8 });
    await until(async () => (await w.frameObject(alice.frame, sticky.id))?.x === sticky.x + 80, { timeout: 10_000, message: "alice sees bob's move" });
  }));

  test("T9. exports: server SVG parses as XML with the object ids; HTML has an <svg>; PDF downloads", () => evidence("T9", async () => {
    await resetBoard();
    const ids = await createShared([
      { type: "frame", x: 0, y: 0, w: 900, h: 500, text: "Plan & <scope>" },
      { type: "sticky", x: 40, y: 60, text: "Quotes \" and <tags>" },
      { type: "rect", x: 300, y: 60, text: "Box" },
      { type: "ellipse", x: 560, y: 60 },
      { type: "text", x: 40, y: 320, text: "Label" },
      { type: "pen", x: 300, y: 300, w: 200, h: 100, points: [0, 0, 0.5, 1, 1, 0] },
    ]);
    const [c] = await createShared([{ type: "connector", from: ids[1], to: ids[2] }]);
    const all = [...ids, c];
    await alice.page.bringToFront();
    const formats = await p.listExportFormats(alice.page);
    timings.T9_formats = formats;
    assert.deepEqual(formats, ["SVG image", "HTML", "PDF"]);

    let t0 = Date.now();
    const svg = await p.downloadExport(alice.page, /^SVG image$/);
    timings.T9_svg = { filename: svg.filename, bytes: svg.bytes.length, ms: Date.now() - t0 };
    await writeFile(join(SHOTS, "t9-export.svg"), svg.bytes);
    const parsed = await alice.page.evaluate((text) => {
      const doc = new DOMParser().parseFromString(text, "image/svg+xml");
      return {
        error: doc.getElementsByTagName("parsererror").length > 0,
        root: doc.documentElement.localName,
        ids: [...doc.querySelectorAll("[data-id]")].map((el) => el.getAttribute("data-id")),
      };
    }, svg.text);
    assert.equal(parsed.error, false, "SVG parses as XML");
    assert.equal(parsed.root, "svg");
    for (const id of all) assert.ok(parsed.ids.includes(id), `SVG export contains ${id}`);

    t0 = Date.now();
    const html = await p.downloadExport(alice.page, /^HTML$/);
    timings.T9_html = { filename: html.filename, bytes: html.bytes.length, ms: Date.now() - t0 };
    await writeFile(join(SHOTS, "t9-export.html"), html.bytes);
    assert.match(html.text, /<svg/, "HTML export contains an <svg>");

    t0 = Date.now();
    const pdf = await p.downloadExport(alice.page, /^PDF$/);
    timings.T9_pdf = { filename: pdf.filename, bytes: pdf.bytes.length, ms: Date.now() - t0 };
    await writeFile(join(SHOTS, "t9-export.pdf"), pdf.bytes);
    assert.equal(pdf.bytes.subarray(0, 5).toString("latin1"), "%PDF-", "PDF export is a PDF");
    assert.ok(pdf.bytes.length > 1000, `PDF has content (${pdf.bytes.length} bytes)`);
    // Alice's whiteboard is unaffected by the export dialogs.
    await w.waitLive(alice.frame, 10_000);
  }));

  test("T10. alice edits server.js in the Code tab; bob's frame recovers and both keep syncing", () => evidence("T10", async () => {
    await resetBoard();
    await bob.frame.locator("body").evaluate(() => { /** @type {any} */ (window).__e2eMarker = "before-edit"; });
    const connBefore = (await w.connectionLog(bob.frame)).length;

    await alice.page.bringToFront();
    await alice.page.getByRole("button", { name: "Code", exact: true }).click();
    await alice.page.getByRole("button", { name: "server.js", exact: true }).click();
    await alice.page.getByText("Editing server.js").waitFor({ timeout: 15_000 });
    const editor = alice.page.locator(".monaco-editor").first();
    await editor.waitFor();
    await editor.locator(".view-lines").click();
    await alice.page.keyboard.press("Control+End");
    // One Monaco insert -> one code-version bump -> one facet restart.
    const probe = `\n// e2e restart probe ${Date.now()}\n`;
    const editedAt = Date.now();
    await alice.page.keyboard.insertText(probe);
    log(`inserted ${JSON.stringify(probe)} into server.js`);
    await alice.page.screenshot({ path: join(SHOTS, "t10-code-edit-alice.png") });

    /** @type {any[]} */
    const samples = [];
    let lastKey = "";
    /** @type {any[]} */
    let connLogBeforeReload = [];
    /** @type {number|null} */ let reloadedAtMs = null;
    /** @type {number|null} */ let recoveredAtMs = null;
    let sawDialog = false;
    /** @type {{ms: number, marker: any}|null} */
    let stable = null;
    const sampleUntil = Date.now() + 45_000;
    while (Date.now() < sampleUntil) {
      const iframes = await bob.page.locator('iframe[title="Gadget UI"]').count();
      const read = (/** @type {() => any} */ fn) => bob.frame.locator("body").evaluate(fn, null, { timeout: 500 }).catch(() => "?");
      const conn = iframes ? await bob.frame.locator(SEL.conn).getAttribute("data-state", { timeout: 300 }).catch(() => "none") : "no-iframe";
      const marker = iframes ? await read(() => /** @type {any} */ (window).__e2eMarker ?? null) : null;
      const overlay = iframes ? await read(() => document.getElementById("wb-connection-overlay")?.textContent ?? null) : null;
      const dialog = iframes ? await bob.frame.locator(SEL.namePrompt).count().catch(() => -1) : -1;
      if (dialog > 0) sawDialog = true;
      if (marker === "before-edit") connLogBeforeReload = await w.connectionLog(bob.frame).catch(() => connLogBeforeReload);
      const key = JSON.stringify([iframes, conn, marker, overlay, dialog]);
      if (key !== lastKey) { samples.push({ ms: Date.now() - editedAt, iframes, conn, marker, overlay, dialog }); lastKey = key; }
      if (marker === null && reloadedAtMs === null) reloadedAtMs = Date.now() - editedAt;
      // Recovered: live again after a self-reload (marker gone), or after resubscribing in place
      // (the in-frame log left "live" and its latest entry is "live" again), and still so 3 s later
      // with the same marker (a reload that is merely late would clear it).
      const entries = connLogBeforeReload.slice(connBefore);
      const inPlace = marker === "before-edit" && entries.some((e) => e.state !== "live") && entries.at(-1)?.state === "live";
      const ok = conn === "live" && overlay === null && dialog === 0 && (marker === null || inPlace);
      if (ok) {
        stable ??= { ms: Date.now() - editedAt, marker };
        if (stable.marker !== marker) stable = { ms: Date.now() - editedAt, marker };
        if (Date.now() - editedAt - stable.ms >= 3000) { recoveredAtMs = stable.ms; break; }
      } else {
        stable = null;
      }
      await sleep(150);
    }
    timings.T10 = {
      bobPageSamples: samples,
      bobConnectionLogBeforeReload: connLogBeforeReload.slice(connBefore).map((e) => ({ state: e.state, ms: e.at - editedAt })),
      bobFrameReloadedByMs: reloadedAtMs,
      bobLiveAgainByMs: recoveredAtMs,
      bobGadgetConsole: bob.gadgetConsole.slice(-20),
    };
    log(`T10: bob reloaded by ${reloadedAtMs} ms, live again by ${recoveredAtMs} ms after the edit`);
    await bob.page.screenshot({ path: join(SHOTS, "t10-bob-after-edit.png") });
    assert.ok(recoveredAtMs !== null, "bob's whiteboard did not recover within 45 s; see timings.T10");
    assert.equal(sawDialog, false, "bob was never asked for a name");
    assert.equal(await bob.frame.locator(SEL.meName).textContent(), BOB, "bob keeps his account name");
    await w.recordConnection(bob.frame);

    await alice.page.getByRole("button", { name: GADGET_TAB }).click();
    if (await w.ensureLive(alice.frame, ALICE)) {
      notes.push("T10: alice's (owner) iframe was rebuilt after switching back from Code (account name kept, no dialog)");
    }
    await h.setCamera(alice.frame);
    await h.setCamera(bob.frame);

    // Sync both ways, through the UI's own paths (canvas.addAtCenter).
    let t0 = Date.now();
    const fromAlice = await inPane(alice.frame, (_, canvas) => { const id = canvas.addAtCenter("rect"); canvas.setSelection([]); return id; });
    await bob.frame.locator(SEL.object(fromAlice)).waitFor({ timeout: 15_000 });
    timings.T10_alice_to_bob_ms = Date.now() - t0;
    t0 = Date.now();
    const fromBob = await inPane(bob.frame, (_, canvas) => { const id = canvas.addAtCenter("ellipse"); canvas.setSelection([]); return id; });
    await alice.frame.locator(SEL.object(fromBob)).waitFor({ timeout: 15_000 });
    timings.T10_bob_to_alice_ms = Date.now() - t0;
    // Attribution is the creating account's display name, as both browsers see it.
    for (const u of [alice, bob]) {
      const settled = await w.settledBoard(u.frame);
      assert.equal(settled.objects[fromAlice]?.createdBy, ALICE, `${u.username}: alice's rect is attributed to her account`);
      assert.equal(settled.objects[fromBob]?.createdBy, BOB, `${u.username}: bob's ellipse is attributed to his account`);
    }
    await alice.frame.locator(SEL.peerNamed(BOB)).waitFor({ timeout: 15_000 });
    await bob.frame.locator(SEL.peerNamed(ALICE)).waitFor({ timeout: 15_000 });
    await shot("t10-after-restart");

    // The edit persisted in the workspace code.
    await alice.page.getByRole("button", { name: "Code", exact: true }).click();
    await alice.page.getByRole("button", { name: "server.js", exact: true }).click();
    await alice.page.getByText("Editing server.js").waitFor({ timeout: 15_000 });
    await alice.page.locator(".monaco-editor .view-lines").first().click();
    await alice.page.keyboard.press("Control+End");
    await until(async () => (await alice.page.locator(".monaco-editor .view-lines").innerText()).replace(/ /g, " ").includes("e2e restart probe"),
      { timeout: 15_000, message: "probe comment visible in server.js" }).catch(() => notes.push("T10: probe line not found in the visible part of server.js"));
    await alice.page.getByRole("button", { name: GADGET_TAB }).click();
    await w.ensureLive(alice.frame, ALICE);
  }));

  test("T11. presence rate: alice moves the pointer at ~60 Hz for 5 s; bob's copy stays fresh and converges", () => evidence("T11", async () => {
    await resetBoard();
    await alice.page.bringToFront();
    const aId = await h.clientId(alice.frame);
    await w.instrumentPresenceSender(alice.frame);
    await w.instrumentPresenceReceiver(bob.frame, aId);
    const size = await w.frameSize(alice.page);
    const cx = size.x + Math.min(700, size.width / 2), cy = size.y + Math.min(450, size.height / 2);
    await alice.page.mouse.move(cx, cy);
    const t0 = Date.now();
    let moves = 0;
    while (Date.now() - t0 < 5000) {
      const t = (Date.now() - t0) / 1000;
      // A Lissajous path: positions rarely repeat, so each cursor value identifies its send time.
      await alice.page.mouse.move(Math.round(cx + 300 * Math.sin(t * 2.1)), Math.round(cy + 200 * Math.sin(t * 3.3 + 0.5)));
      moves++;
      const next = t0 + moves * (1000 / 60);
      const wait = next - Date.now();
      if (wait > 0) await sleep(wait);
    }
    const stoppedAt = Date.now();
    await sleep(1500);
    /** @type {{x: number, y: number, at: number}[]} */
    const sent = await alice.frame.locator("body").evaluate(() => /** @type {any} */ (window).__sentCursors);
    /** @type {{x: number, y: number, at: number}[]} */
    const recv = await bob.frame.locator("body").evaluate(() => /** @type {any} */ (window).__recvCursors);
    const lags = [];
    const lagsFirst = [], lagsLast = [];
    let unmatched = 0;
    for (const r of recv) {
      let match = null;
      for (let i = sent.length - 1; i >= 0; i--) {
        if (sent[i].at <= r.at && sent[i].x === r.x && sent[i].y === r.y) { match = sent[i]; break; }
      }
      if (!match) { unmatched++; continue; }
      const lag = r.at - match.at;
      lags.push(lag);
      if (match.at - t0 < 1000) lagsFirst.push(lag);
      if (match.at - t0 > 4000 && match.at <= stoppedAt) lagsLast.push(lag);
    }
    assert.ok(sent.length > 100, `alice's canvas saw pointer moves (${sent.length})`);
    const last = sent[sent.length - 1];
    const lastRecvMatch = recv.find((r) => r.x === last.x && r.y === last.y && r.at >= last.at);
    const convergeMs = lastRecvMatch ? lastRecvMatch.at - stoppedAt : null;
    timings.T11 = {
      pointerMoves: moves, durationMs: stoppedAt - t0, setPresenceCalls: sent.length, bobPresenceChanges: recv.length,
      bobReceiveHz: Math.round((recv.filter((r) => r.at <= stoppedAt).length / ((stoppedAt - t0) / 1000)) * 10) / 10,
      lag: stats(lags), lagFirstSecond: stats(lagsFirst), lagLastSecond: stats(lagsLast), unmatched, convergeAfterStopMs: convergeMs,
    };
    log(`T11 ${JSON.stringify(timings.T11)}`);
    assert.ok(recv.length > 20, `bob received cursor updates (${recv.length})`);
    assert.ok(timings.T11.lag.p95 <= 300, `bob's cursor lag p95 ${timings.T11.lag.p95} ms <= 300`);
    assert.ok(convergeMs !== null && convergeMs <= 1000, `bob converged to alice's last cursor ${convergeMs} ms after she stopped`);
    assert.ok((timings.T11.lagLastSecond.p50 ?? 0) <= (timings.T11.lagFirstSecond.p50 ?? 0) + 150, "no queue build-up (lag does not grow over the run)");
  }));

  test("T12. stub disposal: 10 frame reloads + a reopened context, then server churn: no warnings, no crash, sane peers", () => evidence("T12", async () => {
    await resetBoard();
    const serverFrom = serverConsole.length;
    const logFrom = await w.logOffset();
    const reloadMs = [];
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      await bob.frame.locator("body").evaluate(() => { /** @type {any} */ (window).__e2eMarker = 1; location.reload(); }).catch(() => {});
      await until(() => bob.frame.locator("body").evaluate(() => /** @type {any} */ (window).__e2eMarker === undefined).catch(() => false),
        { timeout: 15_000, message: `bob's frame reloaded (${i + 1})` });
      await w.ensureLive(bob.frame, BOB);
      reloadMs.push(Date.now() - t0);
    }
    timings.T12_bob_frame_reload_ms = stats(reloadMs);
    await Promise.race([bob.context.close(), sleep(5000)]);
    bob = await openUser("bob");
    await openBoard(bob, workspaceUrl);
    await h.setCamera(bob.frame);

    // Stale subscriptions are gone: alice sees only bob, bob sees only alice.
    const t1 = Date.now();
    await until(async () => {
      const peers = await w.peerList(alice.frame);
      return peers.length === 1 && peers[0].name === BOB;
    }, { timeout: 30_000, interval: 250, message: "alice sees exactly one peer (bob)" }).catch(async (e) => {
      throw new Error(`${e.message}; peers: ${JSON.stringify(await w.peerList(alice.frame))}`);
    });
    timings.T12_alice_peers_settled_ms = Date.now() - t1;
    assert.equal(await alice.frame.locator(".people .peer").count(), 1, "one avatar in alice's people list");
    const bobPeers = await w.peerList(bob.frame);
    assert.deepEqual(bobPeers.map((x) => x.name), [ALICE]);

    // Server allocation pressure: create and delete 200 bulky objects, three rounds.
    const t2 = Date.now();
    for (let round = 0; round < 3; round++) {
      const objs = Array.from({ length: 200 }, (_, i) => ({ type: "sticky", x: (i % 20) * 220, y: Math.floor(i / 20) * 220, text: `churn ${round}/${i} ` + "x".repeat(3000) }));
      const ids = await w.createInFrame(alice.frame, objs);
      await w.settledBoard(alice.frame, 60_000);
      await inPane(alice.frame, (store, _, chunk) => store.deleteObjects(chunk), ids);
      await w.settledBoard(alice.frame, 60_000);
    }
    timings.T12_churn_ms = Date.now() - t2;
    await sleep(5000);

    // Still alive and syncing.
    const id = await inPane(alice.frame, (_, canvas) => { const i = canvas.addAtCenter("rect"); canvas.setSelection([]); return i; });
    await bob.frame.locator(SEL.object(id)).waitFor({ timeout: 15_000 });

    const bad = serverConsole.slice(serverFrom).filter((l) => w.STUB_WARNING.test(l) || w.RUNTIME_CRASH.test(l));
    const badLog = await w.logLinesSince(logFrom, new RegExp(`${w.STUB_WARNING.source}|${w.RUNTIME_CRASH.source}`));
    timings.T12_server_console_lines = serverConsole.length - serverFrom;
    timings.T12_problems = { serverConsole: bad, platformLog: badLog };
    assert.deepEqual(bad, [], "owner console: no stub warnings or runtime crash");
    assert.deepEqual(badLog, [], "platform log: no stub warnings or runtime crash");
    assert.deepEqual(await w.logLinesSince(logStart, w.RUNTIME_CRASH), [], "no runtime crash during the whole run");
  }));
});
