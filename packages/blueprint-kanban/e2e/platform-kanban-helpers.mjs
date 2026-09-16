// Kanban-specific helpers for the real local platform (see ./README.md, platform.test.mjs).
// Board selectors are shared with the harness suite (harness-helpers.mjs); the UI is identical,
// only it runs inside the platform's sandboxed `iframe[title="Gadget UI"]`.

import { join } from "node:path";
import { PKG } from "./harness-helpers.mjs";

export const REPO = join(PKG, "../..");
export const SHIPPED_ARCHIVE = join(REPO, "formats/board.gadget");

/**
 * Fills the board's name dialog and joins, through the "Join board" button or Enter in the name
 * field. The platform iframe's sandbox has no `allow-forms`, so this only works because the dialog
 * does not rely on form submission. Returns whether the dialog closed.
 * @param {import("playwright").FrameLocator} frame
 * @param {string} name
 * @param {{via?: "button"|"enter"}} [opts]
 */
export async function joinBoard(frame, name, { via = "button" } = {}) {
  const input = frame.locator(".name-dialog .name-input");
  await input.waitFor({ timeout: 60_000 });
  await input.fill(name);
  if (via === "enter") await input.press("Enter");
  else await frame.locator(".name-dialog .join-btn").click();
  const joined = await input.waitFor({ state: "detached", timeout: 5000 }).then(() => true, () => false);
  return { joined, via };
}

/**
 * Records `.conn[data-state]` transitions inside the gadget iframe into `window.__connLog`
 * ({state, at}) so a test can see the client go reconnecting -> live without reloading.
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
 * After something may have rebuilt the gadget iframe: waits for either the name dialog or a live
 * board, joins if the dialog is showing, and returns whether it had to join.
 * @param {import("playwright").FrameLocator} frame
 * @param {string} name
 */
export async function ensureJoined(frame, name) {
  const dialog = frame.locator(".name-dialog .name-input");
  const live = frame.locator('.conn[data-state="live"]');
  await dialog.or(live).first().waitFor({ timeout: 60_000 });
  // The dialog opens immediately while the board connects behind it; give a rebuilt iframe a
  // moment to show it before trusting "live".
  let joined = false;
  if (await dialog.waitFor({ timeout: 2000 }).then(() => true, () => false)) {
    const r = await joinBoard(frame, name);
    if (!r.joined) throw new Error("name dialog did not close after Join board");
    joined = true;
  }
  await live.waitFor({ timeout: 60_000 });
  await recordConnection(frame);
  return joined;
}
