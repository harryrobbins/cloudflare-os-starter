// Kanban-specific helpers for the real local platform (see ./README.md, platform.test.mjs).
// Board selectors are shared with the harness suite (harness-helpers.mjs); the UI is identical,
// only it runs inside the platform's sandboxed `iframe[title="Gadget UI"]`.

import { join } from "node:path";
import { PKG, NAME_PROMPT } from "./harness-helpers.mjs";

export const REPO = join(PKG, "../..");
export const SHIPPED_ARCHIVE = join(REPO, "formats/board.gadget");

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
 * Waits for the board in the platform iframe and reports what it shows instead of joining: the
 * name on the me button, and how many name-prompt elements exist (must be 0: nobody is asked for a
 * name any more; the platform's signed-in account name is used).
 * @param {import("playwright").FrameLocator} frame
 * @param {{timeout?: number, settleMs?: number}} [opts]
 */
export async function boardIdentity(frame, { timeout = 60_000, settleMs = 500 } = {}) {
  const me = frame.locator(".me-btn .me-name");
  await me.waitFor({ state: "attached", timeout });
  // Give a (wrongly) delayed name dialog a moment to show up before counting.
  if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
  return { meName: (await me.textContent()) ?? "", namePrompts: await frame.locator(NAME_PROMPT).count() };
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
 * After something may have rebuilt the gadget iframe: waits for a live board showing `name` (the
 * account display name) and no name prompt. Returns whether the iframe was rebuilt (the
 * connection recorder installed by recordConnection() was gone).
 * @param {import("playwright").FrameLocator} frame
 * @param {string} name
 */
export async function ensureLive(frame, name) {
  const live = frame.locator('.conn[data-state="live"]');
  await live.waitFor({ timeout: 60_000 });
  const rebuilt = await frame.locator("body").evaluate(() => !(/** @type {any} */ (window).__connLog));
  const { meName, namePrompts } = await boardIdentity(frame, { settleMs: rebuilt ? 500 : 0 });
  if (namePrompts) throw new Error(`the board asked for a name (${namePrompts} name prompt element(s))`);
  if (meName !== name) throw new Error(`me button shows "${meName}", expected the account name "${name}"`);
  await recordConnection(frame);
  return rebuilt;
}
