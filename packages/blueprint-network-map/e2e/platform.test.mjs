// Multi-browser end-to-end tests of the network map against a REAL local Cloudflare OS Workshop:
// the gadget runs as a Durable Object facet in workerd, the client in the Workshop's sandboxed
// `iframe[title="Gadget UI"]`. Mirrors packages/blueprint-whiteboard/e2e/platform.test.mjs.
// See ./README.md.
//
//   packages/blueprint-network-map/e2e/start-local-platform.sh     # repo root; prints PGID + URL
//   node scripts/build.mjs && node scripts/pack-gadget.mjs         # writes formats/network-map.gadget
//   node --test --test-concurrency=1 e2e/platform.test.mjs         # from packages/blueprint-network-map
//   packages/blueprint-network-map/e2e/stop-local-platform.sh      # always
//
// Env: CFOS_URL (default http://localhost:8787); PLATFORM_SHOTS (screenshots, exports and
// timings.json; default ${TMPDIR:-/tmp}/netmap-platform-shots); CFOS_LOG (platform log, as for the
// start script). Users: alice (owner) and bob (use-role share link), each in their own context.

import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as p from "./platform-helpers.mjs";

const BASE = (process.env.CFOS_URL || p.DEFAULT_BASE_URL).replace(/\/$/, "");
const SHOTS = process.env.PLATFORM_SHOTS || join(process.env.TMPDIR || tmpdir(), "netmap-platform-shots");
const PASSWORD = "correct-horse-battery-staple";
const FORM_BLOCKED = /Blocked form submission/;
const CSP_ERROR = /Content Security Policy|Refused to (load|execute|evaluate|connect|apply|create|frame)/i;
/** The workspace tab that shows the gadget UI (named after the format's output noun). */
const GADGET_TAB = /^(Map|Network Map|App|Preview)$/;
/** Display names of the local accounts: a password sign-up's display name is the username. */
const ALICE = "alice";
const BOB = "bob";
const EXPORT_FORMATS = ["Network map backup (JSON)", "Kumu JSON", "Elements (CSV)", "Connections (CSV)", "GraphML", "GEXF"];

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
let logStart = 0;
/** Owner-page `server: ` console lines (facet console output forwarded to the Workshop page). */
/** @type {string[]} */
const serverConsole = [];

/**
 * A signed-in user in their own browser context (1600x1000), with console capture.
 * @param {string} username
 */
async function openUser(username) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  await p.recordCspViolations(context);
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
  return { username, context, page, consoleErrors, frameErrors, gadgetConsole };
}

/** The user's live map frame. @param {User} u @param {{timeout?: number, minNodes?: number}} [o] */
const frameOf = (u, o) => p.mapFrame(u.page, o);

const users = () => /** @type {User[]} */ ([alice, bob].filter(Boolean));

/** @param {string} name */
async function shot(name) {
  await Promise.all(users().map((u) => u.page.screenshot({ path: join(SHOTS, `${name}-${u.username}.png`) }).catch(() => {})));
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
      pageErrors: Object.fromEntries(users().map((u) => [u.username, u.consoleErrors.slice(-20)])),
      serverConsole: serverConsole.slice(serverFrom).slice(-60),
      platformLog: await p.logLinesSince(logStart, /error|Error|warn|crash|disposed/).then((l) => l.slice(-40)),
    };
    await writeFile(join(SHOTS, `FAIL-${name}.json`), JSON.stringify(dump, null, 2)).catch(() => {});
    timings[`${name}_failed`] = String(/** @type {any} */ (err)?.message ?? err).slice(0, 400);
    throw err;
  }
}

/** CSP violations recorded in the user's current gadget frame (null if the recorder is missing). @param {User} u */
async function cspViolations(u) {
  const f = await frameOf(u);
  return f.evaluate(() => /** @type {any} */ (window).__cspViolations ?? null);
}

/** Reloads the gadget frame from inside (as the client's own recovery does) and waits for it. @param {User} u */
async function reloadGadgetFrame(u, minNodes = 0, timeout = 60_000) {
  const f = await frameOf(u);
  await f.evaluate(() => { /** @type {any} */ (window).__e2eMarker = 1; location.reload(); }).catch(() => {});
  const t0 = Date.now();
  const deadline = t0 + timeout;
  for (;;) {
    const fr = await frameOf(u, { timeout: Math.max(1000, deadline - Date.now()), minNodes });
    const fresh = await fr.evaluate(() => /** @type {any} */ (window).__e2eMarker === undefined).catch(() => false);
    if (fresh) return { frame: fr, ms: Date.now() - t0 };
    if (Date.now() > deadline) throw new Error("gadget frame did not reload");
    await sleep(50);
  }
}

before(async () => {
  await mkdir(SHOTS, { recursive: true });
  logStart = await p.logOffset();
  browser = await p.launch();
  log(`archive ${p.ARCHIVE}`);

  alice = await openUser("alice");
  const tUp = Date.now();
  const blueprintId = await p.uploadGadget(alice.page, BASE, p.ARCHIVE);
  timings.setup_upload_ms = Date.now() - tUp;
  const t0 = Date.now();
  workspaceUrl = await p.createGadgetFromBlueprint(alice.page, BASE, blueprintId);
  timings.setup_create_navigation_ms = Date.now() - t0;
  log(`workspace ${workspaceUrl}`);
  await frameOf(alice, { minNodes: 16 });
  timings.setup_create_to_alice_live_ms = Date.now() - t0;
  // Let a (wrongly) delayed name prompt or error show up before the P0 assertions.
  await sleep(800);
  await shot("p0-alice-created");
});

/** Platform-log offset when the current test started. */
let testLogStart = 0;
/** Stub warnings / runtime crashes in the platform log, attributed to the test they appeared in. */
/** @type {Record<string, string[]>} */
const logProblemsByTest = {};
timings.logProblemsByTest = logProblemsByTest;

beforeEach(async () => {
  if (!("setup" in logProblemsByTest)) logProblemsByTest.setup = (await p.logLinesSince(logStart, p.PROBLEM)).map((l) => l.slice(0, 120));
  testLogStart = await p.logOffset();
});

afterEach(async (t) => {
  const lines = await p.logLinesSince(testLogStart, p.PROBLEM);
  if (lines.length) logProblemsByTest[t.name.split(".")[0]] = lines.map((l) => l.slice(0, 120));
});

after(async () => {
  timings.notes = notes;
  timings.consoleErrors = Object.fromEntries(users().map((u) => [u.username, { page: u.consoleErrors.slice(-30), frame: u.frameErrors.slice(-30) }]));
  timings.serverConsoleTail = serverConsole.slice(-40);
  timings.platformLogProblems = await p.logLinesSince(logStart, p.PROBLEM);
  await writeFile(join(SHOTS, "timings.json"), JSON.stringify(timings, null, 2)).catch(() => {});
  await writeFile(join(SHOTS, "server-console.log"), serverConsole.join("\n")).catch(() => {});
  console.log("TIMINGS " + JSON.stringify(timings, null, 2));
  await browser?.close();
});

describe("network map on the local platform", { concurrency: false }, () => {
  test("P0. New goes straight through; the demo map boots under the account name; no forms, errors or CSP violations", () => evidence("P0", async () => {
    assert.match(workspaceUrl, /\/workspace\/[^/?#]+$/, "Create Gadget went straight to a workspace (no setup page)");
    const f = await frameOf(alice);
    const s = await p.appState(f);
    timings.P0_alice = { nodes: s.nodes, edges: s.edges, mode: s.mode, viewer: s.viewer.name };
    assert.equal(s.nodes, 16, "demo map: 16 elements");
    assert.equal(s.edges, 22, "demo map: 22 connections");
    assert.equal(s.connection, "live");
    assert.equal(s.viewer.name, ALICE, "the viewer name comes from gadgetViewer");
    assert.equal(await f.evaluate(() => typeof (/** @type {any} */ (globalThis)).gadgetViewer), "undefined", "gadgetViewer is a module-scope binding, not a global");
    assert.match(await f.evaluate(() => document.body.innerText), /This is a demo map/);
    assert.equal(await f.locator("form").count(), 0, "no <form> in the client");
    assert.equal(await f.locator('[role="dialog"], dialog[open]').count(), 0, "no dialog (name prompt) on boot");
    assert.equal(s.mode, "map", `rendered on the WebGL map canvas, not the list fallback (mode ${s.mode})`);
    const csp = await cspViolations(alice);
    timings.P0_csp_recorder = csp === null ? "missing in gadget frame" : "installed";
    if (csp === null) notes.push("P0: the securitypolicyviolation recorder did not reach the gadget frame; CSP checked through console errors only");
    else assert.deepEqual(csp, [], "no securitypolicyviolation events in the gadget frame");
    const all = [...alice.consoleErrors, ...alice.frameErrors];
    assert.deepEqual(all.filter((e) => FORM_BLOCKED.test(e)), [], "no blocked form submissions");
    assert.deepEqual(all.filter((e) => CSP_ERROR.test(e)), [], "no CSP errors in the console");
    assert.deepEqual(alice.frameErrors, [], "no console errors in the gadget frame");
    timings.P0_page_console_errors = alice.consoleErrors.slice();
  }));

  test("P1. alice's rename persists across a full reload; createdBy/updatedBy are her account name", () => evidence("P1", async () => {
    let f = await frameOf(alice);
    const target = p.mapId("e", 1); // demo "Local farms"
    const before = await p.objectIn(f, target);
    assert.ok(before, "demo element e_000000000001 exists");
    const created = p.mapId("e", 0xa11ce0001);
    await p.apply(f, [
      { op: "update", id: target, patch: { label: "Local farms (renamed by alice)" } },
      { op: "create", object: { id: created, label: "Alice's element" } },
    ]);
    await p.settled(f);
    const t0 = Date.now();
    await alice.page.reload();
    f = await frameOf(alice, { minNodes: 17 });
    timings.P1_full_reload_to_live_ms = Date.now() - t0;
    const renamed = await p.objectIn(f, target);
    const mine = await p.objectIn(f, created);
    assert.equal(renamed.label, "Local farms (renamed by alice)", "rename survived the reload");
    assert.equal(renamed.updatedBy, ALICE, "updatedBy is alice's account name");
    assert.equal(renamed.version, before.version + 1);
    assert.equal(mine?.label, "Alice's element");
    assert.equal(mine.createdBy, ALICE, "createdBy is alice's account name");
  }));

  test("P2. bob joins by a use-role share link: live edits both ways and presence", () => evidence("P2", async () => {
    await alice.page.bringToFront();
    const shareUrl = await p.createUseShareLink(alice.page);
    bob = await openUser("bob");
    const t0 = Date.now();
    await bob.page.goto(shareUrl);
    let fb = await frameOf(bob, { minNodes: 17 });
    timings.P2_bob_share_to_live_ms = Date.now() - t0;
    await sleep(500);
    const sb = await p.appState(fb);
    assert.equal(sb.viewer.name, BOB, "bob's viewer name is his account name");
    assert.equal(await fb.locator('[role="dialog"], dialog[open]').count(), 0, "bob is not prompted for anything");
    assert.equal(sb.objects.find((o) => o.id === p.mapId("e", 1))?.label, "Local farms (renamed by alice)", "bob loads alice's persisted rename");
    assert.equal(await bob.page.getByRole("button", { name: "Share workspace" }).count(), 0, "use role: no Share");
    assert.equal(await bob.page.getByRole("button", { name: "Code", exact: true }).count(), 0, "use role: no Code tab");

    // Alice edits live; bob sees it.
    const fa = await frameOf(alice);
    let t1 = Date.now();
    await p.apply(fa, [{ op: "update", id: p.mapId("e", 1), patch: { description: "Edited live by alice" } }]);
    await p.eventually(bob.page, async (f) => (await p.objectIn(f, p.mapId("e", 1)))?.description === "Edited live by alice", { message: "bob sees alice's live edit" });
    timings.P2_alice_edit_to_bob_ms = Date.now() - t1;

    // Bob creates; alice sees it, attributed to bob.
    const fromBob = p.mapId("e", 0xb0b000001);
    fb = await frameOf(bob);
    t1 = Date.now();
    await p.apply(fb, [{ op: "create", object: { id: fromBob, label: "Bob's element" } }]);
    const seen = await p.eventually(alice.page, (f) => p.objectIn(f, fromBob), { message: "alice sees bob's element" });
    timings.P2_bob_create_to_alice_ms = Date.now() - t1;
    assert.equal(seen.createdBy, BOB, "bob's element is attributed to his account");

    // Presence: alice selects an element; bob's store.peers carries it under alice's name.
    const aId = (await p.appState(fa)).viewer.clientId;
    t1 = Date.now();
    await fa.evaluate((id) => /** @type {any} */ (globalThis).networkMap.app.select([id]), fromBob);
    const peer = await p.eventually(bob.page, async (f) => (await p.appState(f)).peers.find((x) => x.clientId === aId && x.selection.includes(fromBob)), { message: "bob sees alice's selection" });
    timings.P2_alice_selection_to_bob_ms = Date.now() - t1;
    assert.equal(peer.name, ALICE);
    await (await frameOf(bob)).locator(`.peers button[aria-label="${ALICE}"]`).waitFor({ timeout: 10_000 });
    await (await frameOf(alice)).locator(`.peers button[aria-label="${BOB}"]`).waitFor({ timeout: 10_000 });
    await fa.evaluate(() => /** @type {any} */ (globalThis).networkMap.app.select([]));
    assert.deepEqual(bob.frameErrors, [], "no console errors in bob's gadget frame");
    const csp = await cspViolations(bob);
    if (csp !== null) assert.deepEqual(csp, [], "no CSP violations in bob's frame");
    await shot("p2-two-users");
  }));

  test("P3. import through the Data tab (Kumu sheets paste -> preview -> review -> accept); both browsers get it", () => evidence("P3", async () => {
    await alice.page.bringToFront();
    const f = await frameOf(alice);
    const elements = ["Label\tType\tTags", "Platform farm\tGrower\tfood", "Platform kitchen\tKitchen\tfood|meals", "Platform depot\tGrower\t"].join("\n");
    const connections = ["From\tTo\tType", "Platform farm\tPlatform kitchen\tSupplies", "Platform depot\tPlatform kitchen\tSupplies"].join("\n");
    await f.click("#nm-tab-data");
    await f.waitForSelector(".nm-data");
    await f.check('.nm-data input[type="radio"][value="kumu-sheets"]');
    await f.fill('textarea[id^="nm-data-elements-"]', elements);
    await f.fill('textarea[id^="nm-data-connections-"]', connections);
    await f.fill('input[id^="nm-data-source-"]', "Platform e2e");
    await f.click('.nm-data button:text-is("Preview")');
    await f.waitForSelector(".nm-data .preview .summary");
    const summary = await f.textContent(".nm-data .preview .summary");
    timings.P3_preview_summary = summary;
    assert.match(summary ?? "", /^3 elements · 2 connections/);
    const t0 = Date.now();
    await f.click('.nm-data button:text-is("Continue to review")');
    await f.waitForSelector('.nm-data .review [data-key="accept"]:not([disabled])', { timeout: 30_000 });
    timings.P3_stage_to_review_ms = Date.now() - t0;
    await shot("p3-review");
    const t1 = Date.now();
    await f.click('.nm-data [data-key="accept"]');
    await f.waitForSelector(".nm-data [data-outcome]", { timeout: 30_000 });
    const outcome = await f.getAttribute(".nm-data [data-outcome]", "data-outcome");
    timings.P3_accept_to_outcome_ms = Date.now() - t1;
    assert.equal(outcome, "applied");
    const check = async (/** @type {import("playwright").Frame} */ fr) => {
      const objs = (await p.appState(fr)).objects;
      const els = objs.filter((o) => o.id[0] === "e" && /^Platform (farm|kitchen|depot)$/.test(o.label));
      const ids = new Set(els.map((o) => o.id));
      const conns = objs.filter((o) => o.id[0] === "c" && ids.has(o.from) && ids.has(o.to));
      return els.length === 3 && conns.length === 2 ? { els, conns } : null;
    };
    const inAlice = await p.eventually(alice.page, check, { message: "alice has the imported objects" });
    const inBob = await p.eventually(bob.page, check, { timeout: 20_000, message: "bob has the imported objects" });
    timings.P3_accept_to_bob_ms = Date.now() - t1;
    for (const o of inAlice.els) assert.equal(o.provenance?.origin, "import");
    assert.deepEqual(inBob.els.map((o) => o.id).sort(), inAlice.els.map((o) => o.id).sort());
    await shot("p3-imported");
    await f.click("#nm-tab-profile").catch(() => {});
  }));

  test("P4. Export Gadget offers the six formats; backup and Kumu JSON parse with the elements; GraphML is XML", () => evidence("P4", async () => {
    await alice.page.bringToFront();
    const formats = await p.listExportFormats(alice.page);
    timings.P4_formats = formats;
    assert.deepEqual(formats, EXPORT_FORMATS);
    const fa = await frameOf(alice);
    const labels = (await p.appState(fa)).objects.filter((o) => o.id[0] === "e").map((o) => o.label);
    const expect = ["Local farms (renamed by alice)", "Alice's element", "Bob's element", "Platform farm"];

    let t0 = Date.now();
    const backup = await p.downloadExport(alice.page, /^Network map backup \(JSON\)$/);
    timings.P4_backup = { filename: backup.filename, bytes: backup.bytes.length, ms: Date.now() - t0 };
    await writeFile(join(SHOTS, "p4-backup.json"), backup.bytes);
    const b = JSON.parse(backup.text);
    const bLabels = JSON.stringify(b);
    for (const l of expect) assert.ok(bLabels.includes(JSON.stringify(l)), `backup contains ${l}`);
    const bObjects = Array.isArray(b.objects) ? b.objects : [];
    timings.P4_backup_keys = Object.keys(b);
    if (bObjects.length) assert.equal(bObjects.filter((o) => String(o.id).startsWith("e_")).length, labels.length, "backup has every element");

    t0 = Date.now();
    const kumu = await p.downloadExport(alice.page, /^Kumu JSON$/);
    timings.P4_kumu = { filename: kumu.filename, bytes: kumu.bytes.length, ms: Date.now() - t0 };
    await writeFile(join(SHOTS, "p4-kumu.json"), kumu.bytes);
    const k = JSON.parse(kumu.text);
    assert.ok(Array.isArray(k.elements) && Array.isArray(k.connections), "Kumu JSON has elements and connections");
    assert.equal(k.elements.length, labels.length, "Kumu JSON has every element");
    const kLabels = k.elements.map((e) => e.attributes?.label ?? e.label);
    for (const l of expect) assert.ok(kLabels.includes(l), `Kumu JSON contains ${l}`);

    t0 = Date.now();
    const graphml = await p.downloadExport(alice.page, /^GraphML$/);
    timings.P4_graphml = { filename: graphml.filename, bytes: graphml.bytes.length, ms: Date.now() - t0 };
    await writeFile(join(SHOTS, "p4-export.graphml"), graphml.bytes);
    const parsed = await alice.page.evaluate((text) => {
      const doc = new DOMParser().parseFromString(text, "application/xml");
      return { error: doc.getElementsByTagName("parsererror").length > 0, root: doc.documentElement.localName, nodes: doc.getElementsByTagName("node").length, edges: doc.getElementsByTagName("edge").length };
    }, graphml.text);
    timings.P4_graphml_parsed = parsed;
    assert.equal(parsed.error, false, "GraphML parses as XML");
    assert.equal(parsed.root, "graphml");
    assert.equal(parsed.nodes, labels.length, "GraphML has a node per element");
    await frameOf(alice, { timeout: 10_000 });
  }));

  test("P5. alice edits server.js in the Code tab; bob's frame recovers by itself and both keep syncing", () => evidence("P5", async () => {
    const fb0 = await frameOf(bob);
    await fb0.evaluate(() => { /** @type {any} */ (window).__e2eMarker = "before-edit"; });
    await alice.page.bringToFront();
    const tabs = await alice.page.getByRole("button").allInnerTexts();
    timings.P5_alice_buttons = tabs.map((t) => t.trim()).filter((t) => t && t.length < 30);
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
    await alice.page.screenshot({ path: join(SHOTS, "p5-code-edit-alice.png") });

    /** @type {any[]} */
    const samples = [];
    let lastKey = "";
    /** @type {number|null} */ let reloadedAtMs = null;
    /** @type {number|null} */ let recoveredAtMs = null;
    /** @type {number|null} */ let stableSince = null;
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
      const handle = await bob.page.$('iframe[title="Gadget UI"]').catch(() => null);
      const fr = handle ? await handle.contentFrame().catch(() => null) : null;
      const st = fr ? await fr.evaluate(() => {
        const w = /** @type {any} */ (window);
        const nm = w.networkMap;
        return {
          marker: w.__e2eMarker ?? null, conn: nm?.store.status.connection ?? "none", model: !!nm?.app?.model,
          overlay: document.getElementById("nm-connection-overlay")?.textContent ?? null,
          recovery: /Connection lost/.test(document.body.innerText),
        };
      }).catch(() => ({ marker: "?", conn: "?", model: false, overlay: null, recovery: false })) : { marker: "?", conn: "no-iframe", model: false, overlay: null, recovery: false };
      const key = JSON.stringify(st);
      if (key !== lastKey) { samples.push({ ms: Date.now() - editedAt, ...st }); lastKey = key; }
      if (st.marker === null && reloadedAtMs === null) reloadedAtMs = Date.now() - editedAt;
      const ok = st.marker === null && st.conn === "live" && st.model && st.overlay === null;
      if (ok) {
        stableSince ??= Date.now() - editedAt;
        if (Date.now() - editedAt - stableSince >= 3000) { recoveredAtMs = stableSince; break; }
      } else stableSince = null;
      await sleep(150);
    }
    timings.P5 = { bobSamples: samples, bobFrameReloadedByMs: reloadedAtMs, bobLiveAgainByMs: recoveredAtMs, bobGadgetConsole: bob.gadgetConsole.slice(-20) };
    log(`P5: bob reloaded by ${reloadedAtMs} ms, live again by ${recoveredAtMs} ms after the edit`);
    await bob.page.screenshot({ path: join(SHOTS, "p5-bob-after-edit.png") });
    // Back to the gadget tab for alice (the owner iframe may be rebuilt), also before a failure so
    // later tests find her map.
    const tab = alice.page.getByRole("button", { name: GADGET_TAB });
    if (await tab.count()) await tab.first().click();
    else notes.push(`P5: no gadget tab matching ${GADGET_TAB}; buttons: ${timings.P5_alice_buttons.join(", ")}`);
    assert.ok(recoveredAtMs !== null, "bob's map did not reload and recover within 60 s; see timings.P5");
    const fa = await frameOf(alice);
    const fb = await frameOf(bob);
    assert.equal((await p.appState(fb)).viewer.name, BOB, "bob keeps his account name");

    let t0 = Date.now();
    const fromAlice = p.mapId("e", 0xa11ce0005);
    await p.apply(fa, [{ op: "create", object: { id: fromAlice, label: "After restart (alice)" } }]);
    await p.eventually(bob.page, (f) => p.objectIn(f, fromAlice), { message: "bob sees alice's post-restart element" });
    timings.P5_alice_to_bob_ms = Date.now() - t0;
    t0 = Date.now();
    const fromBob = p.mapId("e", 0xb0b000005);
    await p.apply(fb, [{ op: "create", object: { id: fromBob, label: "After restart (bob)" } }]);
    await p.eventually(alice.page, (f) => p.objectIn(f, fromBob), { message: "alice sees bob's post-restart element" });
    timings.P5_bob_to_alice_ms = Date.now() - t0;
    for (const u of [alice, bob]) {
      const fr = await frameOf(u);
      await p.settled(fr);
      assert.equal((await p.objectIn(fr, fromAlice))?.createdBy, ALICE, `${u.username}: alice's element attributed to alice`);
      assert.equal((await p.objectIn(fr, fromBob))?.createdBy, BOB, `${u.username}: bob's element attributed to bob`);
    }
    await shot("p5-after-restart");
  }));

  test("P7. scale on a facet: alice writes 2,000 elements + 4,000 connections; bob reloads and loads the map (measurement)", () => evidence("P7", async () => {
    const N = 2000, M = 4000;
    const fa = await frameOf(alice);
    const before = await p.appState(fa);
    const baseNodes = before.nodes;
    const els = Array.from({ length: N }, (_, i) => ({ op: "create", object: { id: p.mapId("e", 0x700000000000 + i), label: `Scale element ${i} ${"x".repeat(20)}`, tags: [`g${i % 20}`] } }));
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const conns = Array.from({ length: M }, (_, i) => {
      const a = Math.floor(rnd() * rnd() * N), b = Math.floor(rnd() * N);
      return { op: "create", object: { id: p.mapId("c", 0x710000000000 + i), from: p.mapId("e", 0x700000000000 + a), to: p.mapId("e", 0x700000000000 + b), direction: i % 3 ? "directed" : "undirected", ...(i % 5 === 0 ? { label: `link ${i}` } : {}) } };
    });
    const ops = [...els, ...conns];
    /** @type {any} */ const r = { N, M, chunks: [] };
    const errorsBefore = alice.frameErrors.length + bob.frameErrors.length;
    const t0 = Date.now();
    for (let i = 0; i < ops.length; i += 2000) {
      const tc = Date.now();
      await p.apply(fa, ops.slice(i, i + 2000));
      await p.settled(fa, 120_000);
      r.chunks.push(Date.now() - tc);
    }
    r.fill_alice_settled_ms = Date.now() - t0;
    const sa = await p.appState(fa);
    r.alice = { nodes: sa.nodes, edges: sa.edges };
    assert.equal(sa.nodes, baseNodes + N, "alice has every element");
    const fb = await frameOf(bob);
    await fb.waitForFunction((n) => /** @type {any} */ (globalThis).networkMap.app.model.nodes.size >= n, baseNodes + N, { timeout: 120_000, polling: 100 });
    r.fill_to_bob_model_ms = Date.now() - t0;
    r.alice_heap_mb = await fa.evaluate(() => Math.round((/** @type {any} */ (performance).memory?.usedJSHeapSize ?? 0) / 1e5) / 10);
    await shot("p7-filled");

    // Bob reloads: time to model (subscribe + paged snapshot + model + render).
    const { frame: fb2, ms } = await reloadGadgetFrame(bob, baseNodes + N, 120_000);
    r.bob_reload_to_model_ms = ms;
    const sb = await p.appState(fb2);
    r.bob = { nodes: sb.nodes, edges: sb.edges, objects: sb.objects.length, mode: sb.mode };
    r.bob_heap_mb = await fb2.evaluate(() => Math.round((/** @type {any} */ (performance).memory?.usedJSHeapSize ?? 0) / 1e5) / 10);
    // The same snapshot bob's subscribe fetched, re-read through his store to count pages and bytes.
    r.snapshot = await fb2.evaluate(async () => {
      const { store } = /** @type {any} */ (globalThis).networkMap;
      const t = performance.now();
      const first = await store.call("openSnapshot");
      let pages = 1, objects = first.objects.length, bytes = JSON.stringify(first.objects).length + JSON.stringify(first.positions).length;
      let next = first.next;
      while (next !== null && next !== undefined) {
        const page = await store.call("snapshotPage", first.token, next);
        pages++; objects += page.objects.length; bytes += JSON.stringify(page.objects).length + JSON.stringify(page.positions).length;
        next = page.next;
        try { page[Symbol.dispose]?.(); } catch {}
      }
      try { first[Symbol.dispose]?.(); } catch {}
      return { pages, objects, jsonBytes: bytes, ms: Math.round(performance.now() - t) };
    });
    r.frame_errors_during = [...alice.frameErrors, ...bob.frameErrors].slice(errorsBefore);
    timings.P7 = r;
    log(`P7 ${JSON.stringify(r)}`);
    assert.equal(sb.nodes, baseNodes + N, "bob loads every element");
    await shot("p7-bob-reloaded");
  }));

  test("P6. the platform log shows no undisposed RPC stubs and no runtime crash during the suite", () => evidence("P6", async () => {
    // Still alive and syncing after everything above.
    const fa = await frameOf(alice);
    const last = p.mapId("e", 0xa11ce0006);
    await p.apply(fa, [{ op: "create", object: { id: last, label: "Last one" } }]);
    await p.eventually(bob.page, (f) => p.objectIn(f, last), { timeout: 30_000, message: "bob sees the last element" });
    const stub = await p.logLinesSince(logStart, p.STUB_WARNING);
    const crash = await p.logLinesSince(logStart, p.RUNTIME_CRASH);
    const bad = serverConsole.filter((l) => p.PROBLEM.test(l));
    timings.P6 = { stubWarnings: stub.map((l) => l.slice(0, 160)), crashes: crash.map((l) => l.slice(0, 160)), serverConsole: bad };
    assert.deepEqual(bad, [], "owner console: no stub warnings or runtime crash");
    assert.deepEqual(stub, [], "platform log: no 'RPC stub was not disposed properly'");
    assert.deepEqual(crash, [], "platform log: no 'Workers runtime crashed'");
  }));
});
