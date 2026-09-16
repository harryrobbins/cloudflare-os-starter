// Whiteboard-specific helpers for the real local platform (see ./README.md, platform.test.mjs).
// Selectors and in-frame evaluation are shared with the harness suite (harness-helpers.mjs): the
// client is the same, it only runs inside the platform's sandboxed `iframe[title="Gadget UI"]`,
// where `window.whiteboardStore` / `window.whiteboardCanvas` live.

import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PKG, SEL, inPane, until } from "./harness-helpers.mjs";

export const REPO = join(PKG, "../..");
export const SHIPPED_ARCHIVE = join(REPO, "formats/whiteboard.gadget");
/** Server log written by start-local-platform.sh (same default and override). */
export const PLATFORM_LOG = process.env.CFOS_LOG || join(process.env.TMPDIR || tmpdir(), "cfos-local-platform.log");

/** Server-side problems that must never appear (see the platform spike report, S5). */
export const STUB_WARNING = /RPC (stub|result) was not disposed properly/;
export const RUNTIME_CRASH = /The Workers runtime crashed unexpectedly/;

/**
 * Fills the whiteboard's name dialog and joins through the Join button or Enter. The platform
 * iframe's sandbox has no `allow-forms`, so this only works because the dialog is not a form.
 * @param {import("playwright").FrameLocator} frame
 * @param {string} name
 * @param {{via?: "button"|"enter"}} [opts]
 */
export async function joinBoard(frame, name, { via = "button" } = {}) {
  const input = frame.locator(SEL.nameInput);
  await input.waitFor({ timeout: 60_000 });
  await input.fill(name);
  if (via === "enter") await input.press("Enter");
  else await frame.locator(SEL.joinButton).click();
  const joined = await input.waitFor({ state: "detached", timeout: 5000 }).then(() => true, () => false);
  return { joined, via };
}

/** @param {import("playwright").FrameLocator} frame */
export async function waitLive(frame, timeout = 60_000) {
  await frame.locator(SEL.live).waitFor({ timeout });
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
 * After something may have rebuilt the gadget iframe: joins if the name dialog shows, waits live.
 * Returns whether it had to join.
 * @param {import("playwright").FrameLocator} frame
 * @param {string} name
 */
export async function ensureJoined(frame, name) {
  const dialog = frame.locator(SEL.nameInput);
  const live = frame.locator(SEL.live);
  await dialog.or(live).first().waitFor({ timeout: 60_000 });
  let joined = false;
  if (await dialog.waitFor({ timeout: 2000 }).then(() => true, () => false)) {
    const r = await joinBoard(frame, name);
    if (!r.joined) throw new Error("name dialog did not close after Join");
    joined = true;
  }
  await live.waitFor({ timeout: 60_000 });
  await recordConnection(frame);
  return joined;
}

/**
 * The frame's board once nothing is pending (the store's optimistic view then equals the server's).
 * @param {import("playwright").FrameLocator} frame
 */
export async function settledBoard(frame, timeout = 15_000) {
  return until(() => inPane(frame, (store) => {
    const s = store.getState();
    return s.pending === 0 && s.connection === "live" ? s.board : null;
  }), { timeout, interval: 100, message: "store settled (pending 0, live)" });
}

/** @param {import("playwright").FrameLocator} frame @param {string} id */
export function frameObject(frame, id) {
  return inPane(frame, (store, _, oid) => store.getState().board.objects[oid] ?? null, id);
}

/** @param {import("playwright").FrameLocator} frame */
export function peerList(frame) {
  return inPane(frame, (store) => [...store.getState().peers.values()].map((p) => ({ clientId: p.clientId, name: p.name })));
}

/**
 * Creates objects through the frame's store (one optimistic change) and returns their ids.
 * @param {import("playwright").FrameLocator} frame
 * @param {any[]} objects
 */
export function createInFrame(frame, objects) {
  return inPane(frame, (store, _, objs) => store.createObjects(objs), objects);
}

/**
 * Page coordinates of a world point in a frame (camera applied, iframe offset added).
 * @param {import("playwright").Page} page
 * @param {import("playwright").FrameLocator} frame
 * @param {{x: number, y: number}} world
 */
export async function worldToPage(page, frame, world) {
  const iframe = await page.locator('iframe[title="Gadget UI"]').boundingBox();
  if (!iframe) throw new Error("gadget iframe not visible");
  const local = await inPane(frame, (_, canvas, w) => {
    const cam = canvas.getCamera();
    const r = canvas.element.getBoundingClientRect();
    return { x: r.left + (w.x - cam.x) * cam.zoom, y: r.top + (w.y - cam.y) * cam.zoom };
  }, world);
  return { x: iframe.x + local.x, y: iframe.y + local.y };
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
 * Instruments the sender's canvas: every pointermove over it is logged with its time and the world
 * cursor the canvas derives from it (same maths as canvas `sample()` + round2), so a receiver can
 * measure lag from "the sender's pointer was here" to "the peer's store has it". (The canvas holds
 * a spread copy of the store, so wrapping `whiteboardStore.setPresence` would not see its calls.)
 * @param {import("playwright").FrameLocator} frame
 */
export function instrumentPresenceSender(frame) {
  return inPane(frame, (_, canvas) => {
    const w = /** @type {any} */ (window);
    w.__sentCursors = [];
    if (w.__sentListener) return true;
    const r2 = (/** @type {number} */ v) => Math.round(v * 100) / 100;
    w.__sentListener = (/** @type {PointerEvent} */ e) => {
      const rect = canvas.element.getBoundingClientRect();
      const cam = canvas.getCamera();
      const x = r2((e.clientX - rect.left) / cam.zoom + cam.x), y = r2((e.clientY - rect.top) / cam.zoom + cam.y);
      if (w.__sentCursors.length < 20_000) w.__sentCursors.push({ x, y, at: Date.now() });
    };
    canvas.element.addEventListener("pointermove", w.__sentListener, true);
    return true;
  });
}

/**
 * Instruments the receiver's store: records each presence change of `clientId` with receipt time.
 * @param {import("playwright").FrameLocator} frame
 * @param {string} clientId
 */
export function instrumentPresenceReceiver(frame, clientId) {
  return inPane(frame, (store, _, id) => {
    const w = /** @type {any} */ (window);
    w.__recvCursors = [];
    w.__recvUnsub?.();
    w.__recvUnsub = store.subscribe((state, change) => {
      if (change.kind !== "presence" || !change.peers?.includes(id)) return;
      const c = state.peers.get(id)?.cursor;
      if (c) w.__recvCursors.push({ x: c.x, y: c.y, at: Date.now() });
    });
    return true;
  }, clientId);
}
