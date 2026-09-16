// Helpers for driving the local multi-user harness (harness/) with Playwright.
// Plain ESM; resolves `playwright` from this package's devDependencies.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

export const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

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
 * @param {{panes?: number, viewport?: {width: number, height: number}, query?: string, names?: string[], hasTouch?: boolean}} [opts]
 */
export async function openHarness(browser, url, { panes = 2, viewport = { width: 1800, height: 900 }, query = "", names, hasTouch = false } = {}) {
  const context = await browser.newContext({ viewport, hasTouch });
  const page = await context.newPage();
  /** @type {string[]} */
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${url}?panes=${panes}${query}`);
  const ids = await page.evaluate(() => window.harness.panes());
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
 * Fills the name dialog.
 * @param {import("playwright").FrameLocator} frame
 * @param {string} name
 */
export async function joinAs(frame, name) {
  const input = frame.locator(".name-dialog .name-input");
  await input.waitFor({ timeout: 10_000 });
  await input.fill(name);
  await frame.locator(".name-dialog .join-btn").click();
  await input.waitFor({ state: "detached" });
}

/** @param {import("playwright").FrameLocator} frame */
export async function waitLive(frame) {
  await frame.locator('.conn[data-state="live"]').waitFor({ timeout: 15_000 });
}

/**
 * @param {import("playwright").FrameLocator} frame
 * @param {string} columnName
 */
export function column(frame, columnName) {
  return frame.locator("section.column").filter({
    has: frame.locator(".column-name .inline-edit-display", { hasText: new RegExp(`^${escapeRe(columnName)}$`) }),
  });
}

/**
 * @param {import("playwright").FrameLocator} frame
 * @param {string} title
 */
export function card(frame, title) {
  return frame.locator(".board .card").filter({
    has: frame.locator(".card-title", { hasText: new RegExp(`^${escapeRe(title)}$`) }),
  });
}

/**
 * @param {import("playwright").FrameLocator} frame
 * @param {string} columnName
 * @param {string} title
 */
export async function addCard(frame, columnName, title) {
  const col = column(frame, columnName);
  const composer = col.locator(".composer-input");
  if (!(await composer.count())) await col.locator(".add-card-btn").click();
  await composer.fill(title);
  await composer.press("Enter");
  await card(frame, title).waitFor();
}

/**
 * Titles of the cards in a column, in order.
 * @param {import("playwright").FrameLocator} frame
 * @param {string} columnName
 */
export function titles(frame, columnName) {
  return column(frame, columnName).locator(".card .card-title").allInnerTexts();
}

/**
 * Column names in order.
 * @param {import("playwright").FrameLocator} frame
 */
export function columnNames(frame) {
  return frame.locator(".board section.column .column-name .inline-edit-display").allInnerTexts();
}

/**
 * Pointer-drags `source` so its centre lands at the given point (page coordinates), in steps.
 * @param {import("playwright").Page} page
 * @param {import("playwright").Locator} source
 * @param {{x: number, y: number}} to
 * @param {{steps?: number, hold?: () => Promise<void>}} [opts]
 */
export async function dragTo(page, source, to, { steps = 12, hold } = {}) {
  const box = await source.boundingBox();
  if (!box) throw new Error("drag source not visible");
  const from = { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 14) };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  }
  if (hold) await hold();
  await page.mouse.move(to.x, to.y);
  await page.mouse.up();
}

/**
 * Point just above the middle of `target` (so a card dropped there lands before it).
 * @param {import("playwright").Locator} target
 */
export async function topOf(target) {
  const b = await target.boundingBox();
  if (!b) throw new Error("target not visible");
  return { x: b.x + b.width / 2, y: b.y + Math.min(8, b.height / 4) };
}

/**
 * Point below the last card of a column (end of the list).
 * @param {import("playwright").Locator} col
 */
export async function endOf(col) {
  const b = await col.locator(".column-foot").boundingBox();
  if (!b) throw new Error("column foot not visible");
  return { x: b.x + b.width / 2, y: b.y - 2 };
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
 * Describes what has keyboard focus inside a pane: {cardTitle, className, columnName}.
 * @param {import("playwright").FrameLocator} frame
 */
export function focused(frame) {
  return frame.locator("body").evaluate(() => {
    const el = /** @type {HTMLElement|null} */ (document.activeElement);
    if (!el || el === document.body) return { cardTitle: null, className: "", columnName: null };
    const card = el.classList.contains("card") ? el : null;
    return {
      cardTitle: card?.querySelector(".card-title")?.textContent ?? null,
      className: el.className || "",
      columnName: el.closest(".column")?.querySelector(".column-name .inline-edit-display")?.textContent ?? null,
    };
  });
}

/**
 * Current text of the app's polite live region.
 * @param {import("playwright").FrameLocator} frame
 */
export function liveText(frame) {
  return frame.locator(".live-region").evaluate((el) => el.textContent || "");
}

/**
 * WCAG contrast ratio of two computed CSS colours ("rgb(r, g, b)" / "rgba(...)", opaque assumed).
 * @param {string} a
 * @param {string} b
 */
export function contrastRatio(a, b) {
  const lum = (/** @type {string} */ css) => {
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(css);
    if (!m) throw new Error("unparsable colour " + css);
    const [r, g, bl] = [m[1], m[2], m[3]].map((x) => Number(x) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** @param {string} s */
export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
