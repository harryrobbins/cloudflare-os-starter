// Wave-specific helpers for the real local platform (see ./README.md, platform.test.mjs).
// Selectors and in-frame evaluation are shared with the harness suite (harness-helpers.mjs): the
// client is the same, it only runs inside the platform's sandboxed `iframe[title="Gadget UI"]`,
// where `window.waveStore` / `window.waveApp` live.

import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PKG, SEL, inPane, until, sleep } from "./harness-helpers.mjs";

export const REPO = join(PKG, "../..");
/** WAVE_ARCHIVE overrides it, e.g. for a trial pack that must not bump the committed revision. */
export const SHIPPED_ARCHIVE = process.env.WAVE_ARCHIVE || join(REPO, "formats/wave.gadget");
/** Server log written by start-local-platform.sh (same default and override). */
export const PLATFORM_LOG = process.env.CFOS_LOG || join(process.env.TMPDIR || tmpdir(), "cfos-local-platform.log");

/** Server-side problems that must never appear (see the platform spike report, S5). */
export const STUB_WARNING = /RPC (stub|result) was not disposed properly/;
export const RUNTIME_CRASH = /The Workers runtime crashed unexpectedly/;

/**
 * The display name a local Workshop account gets from password sign-up: the username exactly as
 * typed (SignupPage calls `createAccount(username, username, ...)`; only the id is normalized).
 * `GadgetClient.getViewer()` returns it as `displayName`, injected into the iframe as `gadgetViewer`.
 * @param {string} username
 */
export function accountDisplayName(username) {
  return username;
}

/**
 * Waits for the Wave in the platform iframe and reports what it shows instead of joining: the
 * name on the me button, the store's viewer name, and how many name-prompt elements exist (must
 * be 0: nobody is asked for a name; the signed-in account's display name is used).
 * @param {import("playwright").FrameLocator} frame
 * @param {{timeout?: number, settleMs?: number}} [opts]
 */
export async function waveIdentity(frame, { timeout = 60_000, settleMs = 500 } = {}) {
  const me = frame.locator(SEL.meName);
  await me.waitFor({ state: "attached", timeout });
  // Give a (wrongly) delayed name dialog a moment to show up before counting.
  if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
  return {
    meName: (await me.textContent()) ?? "",
    viewerName: await inPane(frame, (store) => store.getState().viewer.name),
    namePrompts: await frame.locator(SEL.namePrompt).count(),
  };
}

/**
 * Waits until the connection chip says live. Attached, not visible: the phone layout (a frame
 * narrower than 720 px) hides the chip by design; its data-state is the state either way.
 * @param {import("playwright").FrameLocator} frame
 */
export async function waitLive(frame, timeout = 60_000) {
  await frame.locator(SEL.live).waitFor({ state: "attached", timeout });
}

/**
 * Picks a template when the picker is showing (a fresh Wave); resolves with whether it was.
 * @param {import("playwright").FrameLocator} frame
 * @param {string} id
 */
export async function pickTemplateIfOffered(frame, id, timeout = 5000) {
  const btn = frame.locator(SEL.templateButton(id));
  const offered = await btn.waitFor({ timeout }).then(() => true, () => false);
  if (!offered) return false;
  await btn.click();
  await frame.locator(".template-btn").first().waitFor({ state: "hidden", timeout: 30_000 });
  return true;
}

/**
 * Records `.conn[data-state]` transitions inside the gadget iframe into `window.__connLog`.
 * @param {import("playwright").FrameLocator} frame
 */
export async function recordConnection(frame) {
  await frame.locator("body").evaluate(() => {
    const w = /** @type {any} */ (window);
    if (w.__connLog) return;
    w.__connLog = [];
    let last = "";
    const check = () => {
      const s = document.querySelector(".conn")?.getAttribute("data-state") ?? "none";
      if (s !== last) { w.__connLog.push({ state: s, at: Date.now() }); last = s; }
    };
    check();
    new MutationObserver(check).observe(document.body, { subtree: true, attributes: true, childList: true, attributeFilter: ["data-state"] });
  });
}

/** @param {import("playwright").FrameLocator} frame */
export function connectionLog(frame) {
  return frame.locator("body").evaluate(() => /** @type {any} */ (window).__connLog ?? []);
}

/**
 * After something may have rebuilt the gadget iframe: waits for a live Wave running under `name`
 * (the account display name) with no name prompt. Returns whether the iframe was rebuilt (the
 * connection recorder installed by recordConnection() was gone).
 * @param {import("playwright").FrameLocator} frame
 * @param {string} name
 */
export async function ensureLive(frame, name) {
  await waitLive(frame);
  const rebuilt = await frame.locator("body").evaluate(() => !(/** @type {any} */ (window).__connLog));
  const { meName, viewerName, namePrompts } = await waveIdentity(frame, { settleMs: rebuilt ? 500 : 0 });
  if (namePrompts) throw new Error(`the Wave asked for a name (${namePrompts} name prompt element(s))`);
  if (meName !== name || viewerName !== name) throw new Error(`the Wave runs as "${viewerName}" (me button "${meName}"), expected the account name "${name}"`);
  await recordConnection(frame);
  return rebuilt;
}

/**
 * The frame's state once nothing is pending (the store's optimistic view then equals the
 * server's): live, no pending structure request, every open blip saved.
 * @param {import("playwright").FrameLocator} frame
 */
export async function settledState(frame, timeout = 15_000) {
  return until(() => inPane(frame, (store) => {
    const s = store.getState();
    const textsSaved = Object.values(s.text).every((t) => t.saving === "saved" && !t.resyncing);
    return s.pending === 0 && s.connection === "live" && textsSaved
      ? { seq: s.seq, blips: s.blips, meta: s.meta, runs: s.runs, capabilities: s.capabilities, viewer: s.viewer }
      : null;
  }), { timeout, interval: 100, message: "store settled (pending 0, live, saved)" });
}

/** @param {import("playwright").FrameLocator} frame @param {string} id */
export function frameBlip(frame, id) {
  return inPane(frame, (store, _, bid) => store.getState().blips[bid] ?? null, id);
}

/** @param {import("playwright").FrameLocator} frame */
export function peerList(frame) {
  return inPane(frame, (store) => [...store.getState().peers.values()].map((p) => ({ clientId: p.clientId, name: p.name, blipId: p.blipId, editing: p.editing })));
}

/** @param {import("playwright").FrameLocator} frame */
export function capabilities(frame) {
  return inPane(frame, (store) => store.getState().capabilities);
}

/**
 * Creates a blip through the frame's store (optimistic) and waits for the server's copy in that
 * frame. Returns the id.
 * @param {import("playwright").FrameLocator} frame
 * @param {{parentId?: string|null, text?: string, kind?: "note"|"brief", anchor?: any}} [args]
 */
export async function createInFrame(frame, { parentId = null, text = "", kind = "note", anchor } = {}) {
  const id = await inPane(frame, (store, _, a) => store.createBlip(a), { parentId, text, kind, ...(anchor ? { anchor } : {}) });
  await settledState(frame);
  return id;
}

/**
 * Text events (pushes) recorded on the server after `afterSeq`, through the frame's store.
 * @param {import("playwright").FrameLocator} frame
 * @param {number} afterSeq
 */
export async function textEventsSince(frame, afterSeq) {
  const all = [];
  let from = afterSeq;
  for (let i = 0; i < 20; i++) {
    const r = await inPane(frame, (store, _, a) => store.getChanges(a, 1000), from);
    if (!r?.events?.length) break;
    all.push(...r.events);
    from = r.events[r.events.length - 1].seq;
    if (r.events.length < 1000) break;
  }
  return all.filter((e) => e.kind === "text");
}

/**
 * Page-coordinate point inside the gadget iframe, relative to its top-left.
 * @param {import("playwright").Page} page
 * @param {number} x
 * @param {number} y
 */
export async function framePoint(page, x, y) {
  const box = await page.locator('iframe[title="Gadget UI"]').boundingBox();
  if (!box) throw new Error("gadget iframe not visible");
  return { x: box.x + x, y: box.y + y };
}

/** Size of the gadget iframe. @param {import("playwright").Page} page */
export async function frameSize(page) {
  const box = await page.locator('iframe[title="Gadget UI"]').boundingBox();
  if (!box) throw new Error("gadget iframe not visible");
  return box;
}

/** Current byte length of the platform log (0 when absent), to scan only what a test adds. */
export async function logOffset() {
  return stat(PLATFORM_LOG).then((s) => s.size, () => 0);
}

/**
 * Lines of the platform log written since `offset` that match `re`.
 * @param {number} offset
 * @param {RegExp} re
 */
export async function logLinesSince(offset, re) {
  const text = await readFile(PLATFORM_LOG).then((b) => b.subarray(offset).toString("utf8"), () => "");
  return text.split("\n").filter((l) => re.test(l));
}

/**
 * Reloads a gadget frame from inside (location.reload()) and waits until the new document is up.
 * @param {import("playwright").FrameLocator} frame
 */
export async function reloadFrame(frame) {
  await frame.locator("body").evaluate(() => { /** @type {any} */ (window).__e2eMarker = 1; location.reload(); }).catch(() => {});
  await until(() => frame.locator("body").evaluate(() => /** @type {any} */ (window).__e2eMarker === undefined).catch(() => false),
    { timeout: 15_000, message: "gadget frame reloaded" });
}

/**
 * The owner inserts one comment at the end of server.js in Monaco (one code-version bump, one
 * facet restart) and the other user's frame is sampled until it is live again for 3 s, either
 * after a self-reload (the marker set here is gone) or an in-place resubscribe. Resolves with
 * the samples and timings; the caller asserts. The owner is left on the Code tab.
 * @param {{owner: {page: import("playwright").Page, frame: import("playwright").FrameLocator},
 *   other: {page: import("playwright").Page, frame: import("playwright").FrameLocator, gadgetConsole: string[]},
 *   log: (s: string) => void, shots: string}} args
 */
export async function editServerJsAndWatch({ owner, other, log, shots }) {
  await other.frame.locator("body").evaluate(() => { /** @type {any} */ (window).__e2eMarker = "before-edit"; });
  const connBefore = (await connectionLog(other.frame)).length;

  await owner.page.bringToFront();
  await owner.page.getByRole("button", { name: "Code", exact: true }).click();
  await owner.page.getByRole("button", { name: "server.js", exact: true }).click();
  await owner.page.getByText("Editing server.js").waitFor({ timeout: 15_000 });
  const editor = owner.page.locator(".monaco-editor").first();
  await editor.waitFor();
  await editor.locator(".view-lines").click();
  await owner.page.keyboard.press("Control+End");
  const probe = `\n// e2e restart probe ${Date.now()}\n`;
  const editedAt = Date.now();
  await owner.page.keyboard.insertText(probe);
  log(`inserted ${JSON.stringify(probe)} into server.js`);
  await owner.page.screenshot({ path: join(shots, "t8-code-edit-owner.png") });

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
    const iframes = await other.page.locator('iframe[title="Gadget UI"]').count();
    const read = (/** @type {() => any} */ fn) => other.frame.locator("body").evaluate(fn, null, { timeout: 500 }).catch(() => "?");
    const conn = iframes ? await other.frame.locator(SEL.conn).getAttribute("data-state", { timeout: 300 }).catch(() => "none") : "no-iframe";
    const marker = iframes ? await read(() => /** @type {any} */ (window).__e2eMarker ?? null) : null;
    const overlay = iframes ? await read(() => document.querySelector('[data-state="reloading"], [data-state="failed"]')?.textContent ?? null) : null;
    const dialog = iframes ? await other.frame.locator(SEL.namePrompt).count().catch(() => -1) : -1;
    if (dialog > 0) sawDialog = true;
    if (marker === "before-edit") connLogBeforeReload = await connectionLog(other.frame).catch(() => connLogBeforeReload);
    const key = JSON.stringify([iframes, conn, marker, overlay, dialog]);
    if (key !== lastKey) { samples.push({ ms: Date.now() - editedAt, iframes, conn, marker, overlay, dialog }); lastKey = key; }
    if (marker === null && reloadedAtMs === null) reloadedAtMs = Date.now() - editedAt;
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
  return {
    probe, editedAt, sawDialog, reloadedAtMs, recoveredAtMs,
    samples,
    connectionLogBeforeReload: connLogBeforeReload.slice(connBefore).map((e) => ({ state: e.state, ms: e.at - editedAt })),
    gadgetConsole: other.gadgetConsole.slice(-20),
  };
}

/**
 * Checks that the probe comment persisted in server.js (the owner is on the Code tab).
 * @param {import("playwright").Page} page
 */
export async function probeVisibleInServerJs(page) {
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await page.getByRole("button", { name: "server.js", exact: true }).click();
  await page.getByText("Editing server.js").waitFor({ timeout: 15_000 });
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+End");
  return until(async () => (await page.locator(".monaco-editor .view-lines").innerText()).replace(/ /g, " ").includes("e2e restart probe"),
    { timeout: 15_000, message: "probe comment visible in server.js" }).then(() => true, () => false);
}
