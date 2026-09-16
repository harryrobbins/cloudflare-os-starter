// Helpers for driving the local multi-user whiteboard harness (harness/) with Playwright.
// Plain ESM; resolves `playwright` from this package's devDependencies. The selectors in SEL are
// shared with the platform e2e suite, which runs the same client inside the real gadget iframe.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

export const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Stable selectors inside a pane (the client's DOM). */
export const SEL = {
  nameInput: ".name-dialog .name-input",
  joinButton: ".name-dialog .join-btn",
  conn: ".conn",
  live: '.conn[data-state="live"]',
  /** wrapper <g> the canvas keeps per committed object */
  object: (/** @type {string} */ id) => `.wb-obj[data-oid="${id}"]`,
  anyObject: ".wb-obj",
  /** a peer's translucent ghost of an object they are dragging */
  ghost: (/** @type {string} */ id) => `.wb-ghost [data-id="${id}"]`,
  anyGhost: ".wb-ghost",
  cursor: ".wb-cursor",
  remoteStroke: ".wb-peer-stroke",
  tool: (/** @type {string} */ tool) => `.wb-toolbar [data-tool="${tool}"]`,
  addButton: ".wb-toolbar .add-btn",
  addItem: (/** @type {string} */ type) => `.menu .add-${type}`,
  undo: ".wb-history .undo-btn",
  redo: ".wb-history .redo-btn",
  styleBar: ".wb-stylebar",
  peer: (/** @type {string} */ clientId) => `.people .peer[data-client="${clientId}"]`,
  peerNamed: (/** @type {string} */ name) => `.people .peer[aria-label="Follow ${name}"], .people .peer[aria-label="Stop following ${name}"]`,
  followChip: ".follow-chip",
  outlinePanel: ".outline-panel",
  minimap: ".wb-minimap",
  toolbar: ".wb-toolbar",
  canvasHost: ".wb-canvas-host",
  liveRegion: ".live-region",
  toast: ".toast",
};

/**
 * Starts harness/serve.mjs in its own process group. Resolves with {url, stop}.
 * @param {{port?: number}} [opts]
 */
export function startHarnessServer({ port = 8790 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(PKG, "harness/serve.mjs"), "--port", String(port)], {
      cwd: PKG, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const stop = () => {
      try { process.kill(-/** @type {number} */ (child.pid), "SIGTERM"); } catch { /* gone */ }
    };
    const timer = setTimeout(() => { stop(); reject(new Error("harness server did not start: " + out)); }, 10_000);
    child.stdout.on("data", (d) => {
      out += d;
      const m = /HARNESS_URL (\S+)/.exec(out);
      if (m) { clearTimeout(timer); resolve({ url: m[1], stop, pid: child.pid }); }
    });
    child.stderr.on("data", (d) => { out += d; });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`harness server exited ${code}: ${out}`)); });
  });
}

export function launch(opts = {}) {
  return chromium.launch({ headless: true, ...opts });
}

/**
 * Opens the harness and waits until every board pane is live.
 * @param {import("playwright").Browser} browser
 * @param {string} url
 * @param {{panes?: number, viewport?: {width: number, height: number}, query?: string, names?: string[], hasTouch?: boolean, colorScheme?: "light"|"dark"}} [opts]
 */
export async function openHarness(browser, url, { panes = 2, viewport = { width: 1800, height: 900 }, query = "", names, hasTouch = false, colorScheme = "light" } = {}) {
  const context = await browser.newContext({ viewport, hasTouch, colorScheme });
  const page = await context.newPage();
  /** @type {string[]} */
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${url}?panes=${panes}${query}`);
  await page.waitForFunction(() => window.harness?.ready === true, null, { timeout: 30_000 });
  const ids = await page.evaluate(() => window.harness.panes());
  /** @type {Record<string, import("playwright").FrameLocator>} */
  const frames = {};
  for (const [i, id] of ids.entries()) {
    const frame = pane(page, id);
    await joinAs(frame, names?.[i] ?? `User ${id}`);
    frames[id] = frame;
  }
  for (const id of ids) await waitLive(frames[id]);
  return { context, page, frames, errors };
}

/**
 * @param {import("playwright").Page} page
 * @param {string} id
 */
export function pane(page, id) {
  return page.frameLocator(`iframe[data-pane="${id}"]`);
}

/**
 * Fills the name dialog and presses the Join button.
 * @param {import("playwright").FrameLocator} frame
 * @param {string} name
 */
export async function joinAs(frame, name) {
  const input = frame.locator(SEL.nameInput);
  await input.waitFor({ timeout: 10_000 });
  await input.fill(name);
  await frame.locator(SEL.joinButton).click();
  await input.waitFor({ state: "detached" });
}

/** @param {import("playwright").FrameLocator} frame */
export async function waitLive(frame) {
  await frame.locator(SEL.live).waitFor({ timeout: 15_000 });
}

/**
 * Runs `fn(store, canvas, arg)` inside a pane (window.whiteboardStore / window.whiteboardCanvas).
 * @template T
 * @param {import("playwright").FrameLocator} frame
 * @param {(store: any, canvas: any, arg: any) => T} fn
 * @param {any} [arg]
 * @returns {Promise<T>}
 */
export function inPane(frame, fn, arg) {
  // Evaluated over CDP, so the pane's CSP (no unsafe-eval) does not apply to it.
  // A string is evaluated as an expression (a function-valued one would be returned, not called).
  const src = `(${fn.toString()})(window.whiteboardStore, window.whiteboardCanvas, ${JSON.stringify(arg ?? null)})`;
  return frame.locator("body").evaluate(/** @type {any} */ (src));
}

/** @param {import("playwright").FrameLocator} frame */
export function clientId(frame) {
  return inPane(frame, (store) => store.getState().viewer.clientId);
}

/**
 * Puts a pane's camera at a known place (default: world origin at the top-left, 100%).
 * @param {import("playwright").FrameLocator} frame
 * @param {{x: number, y: number, zoom: number}} [camera]
 */
export function setCamera(frame, camera = { x: 0, y: 0, zoom: 1 }) {
  return inPane(frame, (_, canvas, cam) => canvas.setCamera(cam, false), camera);
}

/** A random object id ("o_" + 12 hex). */
export function newObjectId() {
  return "o_" + [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Creates objects through the fake server's RPC (as the chat agent would). Returns their ids.
 * @param {import("playwright").Page} page
 * @param {any[]} objects  create payloads; ids are filled in when absent
 */
export async function createObjects(page, objects) {
  const withIds = objects.map((o) => ({ id: newObjectId(), ...o }));
  const result = await page.evaluate((objs) => window.harness.apply({
    by: "Agent", senderId: "e2e-agent", objectOps: objs.map((object) => ({ op: "create", object })),
  }), withIds);
  if (result.errors?.length) throw new Error("create failed: " + JSON.stringify(result.errors));
  return withIds.map((o) => o.id);
}

/** @param {import("playwright").Page} page */
export function serverBoard(page) {
  return page.evaluate(() => window.harness.getBoard());
}

/**
 * Page-coordinate centre of an object in a pane.
 * @param {import("playwright").FrameLocator} frame
 * @param {string} id
 */
export async function objectCenter(frame, id) {
  const box = await frame.locator(SEL.object(id)).boundingBox();
  if (!box) throw new Error(`object ${id} not visible`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

/**
 * Pointer-drags from `from` by (dx, dy) in page pixels, in steps, with an optional pause per
 * step and an optional `hold` callback before release.
 * @param {import("playwright").Page} page
 * @param {{x: number, y: number}} from
 * @param {number} dx
 * @param {number} dy
 * @param {{steps?: number, stepDelay?: number, hold?: (at: {x: number, y: number}) => Promise<void>, release?: boolean}} [opts]
 */
export async function dragBy(page, from, dx, dy, { steps = 12, stepDelay = 0, hold, release = true } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + (dx * i) / steps, from.y + (dy * i) / steps);
    if (stepDelay) await page.waitForTimeout(stepDelay);
  }
  const to = { x: from.x + dx, y: from.y + dy };
  if (hold) await hold(to);
  if (release) await page.mouse.up();
  return to;
}

/**
 * Page-coordinate point inside a pane's iframe, relative to its top-left.
 * @param {import("playwright").Page} page
 * @param {string} paneId
 * @param {number} x
 * @param {number} y
 */
export async function panePoint(page, paneId, x, y) {
  const box = await page.locator(`iframe[data-pane="${paneId}"]`).boundingBox();
  if (!box) throw new Error("pane not visible");
  return { x: box.x + x, y: box.y + y };
}

/**
 * Polls `fn` until it returns a truthy value or times out.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{timeout?: number, interval?: number, message?: string}} [opts]
 * @returns {Promise<T>}
 */
export async function until(fn, { timeout = 5000, interval = 50, message = "condition" } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) { last = e; }
    if (Date.now() > end) throw new Error(`Timed out waiting for ${message}; last: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * Current text of the app's polite live region.
 * @param {import("playwright").FrameLocator} frame
 */
export function liveText(frame) {
  return frame.locator(SEL.liveRegion).evaluate((el) => el.textContent || "");
}

/** @param {string} s */
export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
