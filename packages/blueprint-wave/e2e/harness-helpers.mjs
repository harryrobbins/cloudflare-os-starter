// Helpers for driving the local multi-user Wave harness (harness/) with Playwright.
// Plain ESM; resolves `playwright` from this package's devDependencies. The selectors (SEL) come
// from src/client/ui/ui-contract.js, the one place both UI streams and both e2e suites share;
// the platform suite runs the same client inside the real gadget iframe.

import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { SEL } from "../src/client/ui/ui-contract.js";

export { SEL, KEYS } from "../src/client/ui/ui-contract.js";

export const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SHOTS = process.env.HARNESS_SHOTS || "/tmp/wave-harness-shots";

/**
 * The harness page runs src/core/wave.js as browser modules, and the core imports the bare
 * "yjs"; harness/index.html maps it to dist/yjs.js. scripts/build.mjs writes that bundle; this
 * writes it too (with esbuild, a devDependency) when it is missing or older than the installed
 * yjs, so the suite never depends on build order.
 */
export async function ensureYjsBundle() {
  const out = join(PKG, "dist/yjs.js");
  const have = await stat(out).catch(() => null);
  const pkgJson = await stat(join(PKG, "node_modules/yjs/package.json")).catch(() => null);
  if (have && (!pkgJson || have.mtimeMs >= pkgJson.mtimeMs)) return out;
  const { build } = await import("esbuild");
  await mkdir(join(PKG, "dist"), { recursive: true });
  await build({
    stdin: { contents: 'export * from "yjs";', resolveDir: PKG, loader: "js" },
    bundle: true, format: "esm", platform: "browser", target: "es2022", minify: false, legalComments: "none",
    outfile: out, logLevel: "warning",
    banner: { js: "// Yjs bundled for the harness page (harness/index.html import map). Generated." },
  });
  return out;
}

/**
 * Starts harness/serve.mjs in its own process group. Resolves with {url, stop}.
 * @param {{port?: number}} [opts]
 */
export async function startHarnessServer({ port = Number(process.env.HARNESS_PORT || 8790) } = {}) {
  await ensureYjsBundle();
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
 * Opens the harness and waits until every pane is live under its account name. `names` become the
 * panes' account display names (the harness injects them as `gadgetViewer`, via `?names=`); nobody
 * types a name. On a fresh Wave the client
 * shows the template picker; `template` (default "blank") is picked in the first pane, and the
 * picker must then leave every pane. `seed` creates blips before the panes load (no picker).
 * @param {import("playwright").Browser} browser
 * @param {string} url
 * @param {{panes?: number, viewport?: {width: number, height: number}, query?: string, names?: string[],
 *   template?: string|null, seed?: {blips: number, chars?: number}|null, model?: string|null,
 *   hasTouch?: boolean, isMobile?: boolean, colorScheme?: "light"|"dark", reducedMotion?: "reduce"|"no-preference"}} [opts]
 */
export async function openHarness(browser, url, {
  panes = 2, viewport = { width: 1800, height: 900 }, query = "", names, template = "blank", seed = null, model = null,
  hasTouch = false, isMobile = false, colorScheme = "light", reducedMotion = "no-preference",
} = {}) {
  const context = await browser.newContext({ viewport, hasTouch, isMobile, colorScheme, reducedMotion });
  const page = await context.newPage();
  /** @type {string[]} */
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  let q = `?panes=${panes}`;
  if (names?.length) q += `&names=${encodeURIComponent(names.join(","))}`;
  if (seed) q += `&seed=${seed.blips}&chars=${seed.chars ?? 120}`;
  if (model) q += `&model=${model}`;
  await page.goto(`${url}${q}${query}`);
  await page.waitForFunction(() => window.harness?.ready === true, null, { timeout: 30_000 });
  const ids = await page.evaluate(() => window.harness.panes());
  /** @type {Record<string, import("playwright").FrameLocator>} */
  const frames = {};
  for (const id of ids) frames[id] = pane(page, id);
  for (const [i, id] of ids.entries()) {
    await waitLive(frames[id]);
    await expectAccountName(frames[id], names?.[i] || `User ${id}`);
  }
  if (template && !seed) {
    await pickTemplate(frames[ids[0]], template);
    for (const id of ids) await frames[id].locator(".template-btn").first().waitFor({ state: "hidden", timeout: 10_000 });
  }
  return { context, page, frames, errors, ids };
}

/**
 * @param {import("playwright").Page} page
 * @param {string} id
 */
export function pane(page, id) {
  return page.frameLocator(`iframe[data-pane="${id}"]`);
}

/**
 * Asserts the pane runs under `name` (the signed-in account's display name): the store's viewer
 * and the me button carry it, and nothing asked for a name.
 * @param {import("playwright").FrameLocator} frame
 * @param {string} name
 */
export async function expectAccountName(frame, name) {
  const me = frame.locator(SEL.meName);
  // Attached, not visible: the name is screen-reader text next to the avatar.
  await me.waitFor({ state: "attached", timeout: 10_000 });
  await until(async () => (await me.textContent()) === name, { timeout: 5000, message: `me-btn shows "${name}"` });
  const viewerName = await inPane(frame, (store) => store.getState().viewer.name);
  if (viewerName !== name) throw new Error(`store viewer is "${viewerName}", expected the account name "${name}"`);
  const prompts = await frame.locator(SEL.namePrompt).count();
  if (prompts) throw new Error(`pane asked for a name (${prompts} name prompt element(s))`);
}

/**
 * Waits until the pane's connection chip says live. Attached, not visible: the phone layout
 * (panes narrower than 720 px, e.g. three panes side by side) hides the chip by design
 * (styles.js), and its data-state is the connection state either way.
 * @param {import("playwright").FrameLocator} frame
 */
export async function waitLive(frame, timeout = 15_000) {
  await frame.locator(SEL.live).waitFor({ state: "attached", timeout });
}

/**
 * Picks a template on a fresh Wave (the picker shows after joining when the Wave is empty).
 * @param {import("playwright").FrameLocator} frame
 * @param {string} id  blank | decision | design_review | retrospective | incident_review
 */
export async function pickTemplate(frame, id) {
  const btn = frame.locator(SEL.templateButton(id));
  await btn.waitFor({ timeout: 10_000 });
  await btn.click();
  await btn.waitFor({ state: "hidden", timeout: 10_000 });
}

/**
 * Runs `fn(store, app, arg)` inside a pane (window.waveStore / window.waveApp, set by the client).
 * @template T
 * @param {import("playwright").FrameLocator} frame
 * @param {(store: any, app: any, arg: any) => T} fn
 * @param {any} [arg]
 * @returns {Promise<T>}
 */
export function inPane(frame, fn, arg) {
  // Evaluated over CDP, so the pane's CSP (no unsafe-eval) does not apply to it.
  // A string is evaluated as an expression (a function-valued one would be returned, not called).
  const src = `(${fn.toString()})(window.waveStore, window.waveApp, ${JSON.stringify(arg ?? null)})`;
  return frame.locator("body").evaluate(/** @type {any} */ (src));
}

/** The conversation controller of a pane (mountApp returns {app, conversation}; either may be exposed). */
const CONVERSATION = `(app && (app.conversation || (app.app && app.app.conversation)))`;

/**
 * Calls a ConversationController method (ui-contract.js) in a pane.
 * @param {import("playwright").FrameLocator} frame
 * @param {string} method
 * @param {any[]} [args]
 */
export function conversation(frame, method, args = []) {
  const src = `((store, app) => { const c = ${CONVERSATION}; if (!c) throw new Error("window.waveApp has no conversation"); return c[${JSON.stringify(method)}](...${JSON.stringify(args)}); })(window.waveStore, window.waveApp)`;
  return frame.locator("body").evaluate(/** @type {any} */ (src));
}

/** @param {import("playwright").FrameLocator} frame */
export function clientId(frame) {
  return inPane(frame, (store) => store.getState().viewer.clientId);
}

/** @param {import("playwright").FrameLocator} frame */
export function paneState(frame) {
  return inPane(frame, (store) => {
    const s = store.getState();
    return {
      seq: s.seq, connection: s.connection, pending: s.pending, saving: s.saving, lastError: s.lastError,
      capabilities: s.capabilities, blips: s.blips, meta: s.meta, runs: s.runs, text: s.text,
      peers: [...s.peers.values()], viewer: s.viewer,
    };
  });
}

/** A blip card in a pane. @param {import("playwright").FrameLocator} frame @param {string} id */
export function card(frame, id) {
  return frame.locator(SEL.blip(id));
}

/**
 * Selectors for a card's OWN parts, relative to the card (`:scope`). Reply cards render inside
 * their parent's card (paragraph replies inside its .blip-body, the rest after its action bar),
 * so an unscoped `card.locator(SEL.editButton).first()` can hit a reply's button or editor.
 * Card layout (src/client/ui/blip.js): .blip-head, then .blip-body (read view: one .blip-para per
 * block, each holding the block element, a .para-reply-btn and a .para-replies slot) or .blip-edit
 * (the editor), then .para-replies-tail, .blip-actions, .blip-replies.
 */
export const OWN = Object.freeze({
  body: `:scope > ${SEL.blipBody}`,
  /** the rendered blocks (paragraphs, headings, lists...) of the read view, in order */
  blocks: `:scope > ${SEL.blipBody} > .blip-para > :first-child`,
  editor: `:scope > .blip-edit ${SEL.blipEditor}`,
  remoteCaret: `:scope > .blip-edit ${SEL.remoteCaret}`,
  editingChip: `:scope > .blip-head ${SEL.editingChip}`,
  editButton: `:scope > .blip-actions > ${SEL.editButton}`,
  replyButton: `:scope > .blip-actions > ${SEL.replyButton}`,
  paraReplyButton: `:scope > ${SEL.blipBody} > .blip-para > ${SEL.paraReplyButton}`,
  /** "N more replies": replies below the first reply level are collapsed (plan 3.3) */
  expandButton: ":scope > .blip-more > .expand-btn",
});

/**
 * One of a card's own parts (OWN), never a nested reply's.
 * @param {import("playwright").FrameLocator} frame @param {string} id @param {keyof typeof OWN} part
 */
export function own(frame, id, part) {
  return card(frame, id).locator(OWN[part]);
}

/** The editor (textarea) open on a blip. @param {import("playwright").FrameLocator} frame @param {string} id */
export function editor(frame, id) {
  return own(frame, id, "editor").first();
}

/**
 * Enters edit mode on a blip through the card's Edit button (keyboard path: focus the card and
 * press E) and waits for its textarea.
 * @param {import("playwright").FrameLocator} frame
 * @param {string} id
 * @param {{via?: "button"|"key"|"api"}} [opts]
 */
export async function openEditor(frame, id, { via = "button" } = {}) {
  const ed = editor(frame, id);
  if (await ed.count()) return ed;
  if (via === "api") {
    await conversation(frame, "openEditor", [id]);
  } else if (via === "key") {
    await card(frame, id).focus();
    await card(frame, id).press("e");
  } else {
    // Card actions may show on hover or focus only (never hover-only on phones).
    await card(frame, id).hover().catch(() => {});
    await own(frame, id, "editButton").click();
  }
  await ed.waitFor({ timeout: 5000 });
  return ed;
}

/**
 * "Done": returns any open editor or composer to the read view (Escape, or the controller).
 * @param {import("playwright").FrameLocator} frame
 * @param {{via?: "escape"|"ctrl-enter"|"api"|"button"}} [opts]
 */
export async function closeEditor(frame, { via = "escape" } = {}) {
  const open = frame.locator(SEL.blipEditor);
  if (!(await open.count())) return;
  if (via === "api") await conversation(frame, "closeEditor");
  else if (via === "button") await frame.locator(SEL.doneButton).first().click();
  else await open.first().press(via === "ctrl-enter" ? "Control+Enter" : "Escape");
  await open.first().waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
}

/**
 * Types `text` into a blip with the real keyboard: opens the editor if needed, moves the caret to
 * the end (or the start) and presses the keys one by one.
 * @param {import("playwright").FrameLocator} frame
 * @param {string} id
 * @param {string} text
 * @param {{delay?: number, at?: "end"|"start"|"keep"}} [opts]
 */
export async function typeInto(frame, id, text, { delay = 0, at = "end" } = {}) {
  const ed = await openEditor(frame, id);
  await ed.focus();
  if (at === "end") await ed.press("Control+End");
  else if (at === "start") await ed.press("Control+Home");
  await ed.pressSequentially(text, { delay });
  return ed;
}

/**
 * The rendered read view of a blip: the innerText of its own .blip-body, without the reply cards
 * nested in it (paragraph replies) and without the paragraph gutter buttons (which only exist when
 * the blip is writable, so History mode would otherwise read differently from live).
 * @param {import("playwright").FrameLocator} frame
 * @param {string} id
 */
export async function readBody(frame, id) {
  const body = own(frame, id, "body").first();
  const text = await body.evaluate((el) => {
    /** @type {string[]} */
    const parts = [];
    for (const child of el.children) {
      if (child.matches(".para-replies")) continue;
      if (child.matches(".blip-para")) {
        for (const k of child.children) if (!k.matches(".para-reply-btn, .para-replies")) parts.push(/** @type {HTMLElement} */ (k).innerText);
      } else {
        parts.push(/** @type {HTMLElement} */ (child).innerText);
      }
    }
    return parts.join("\n\n");
  });
  return text.replace(/\r/g, "");
}

/**
 * The blip's text as the pane's store holds it (opens and closes a text handle).
 * @param {import("playwright").FrameLocator} frame
 * @param {string} id
 */
export function readText(frame, id) {
  return inPane(frame, async (store, _, bid) => {
    const h = await store.openBlip(bid);
    try { return h.text.toString(); } finally { h.close(); }
  }, id);
}

/** The blip's text as the harness' server holds it. @param {import("playwright").Page} page @param {string} id */
export function serverText(page, id) {
  return page.evaluate((bid) => window.harness.text(bid), id);
}

/**
 * Waits until a pane's copy of the blip text satisfies `want` (a string: includes; a RegExp: test;
 * a function: truthy). Resolves with the text.
 * @param {import("playwright").FrameLocator} frame
 * @param {string} id
 * @param {string|RegExp|((text: string) => boolean)} want
 * @param {{timeout?: number, interval?: number}} [opts]
 */
export function waitForText(frame, id, want, { timeout = 5000, interval = 50 } = {}) {
  const ok = typeof want === "string" ? (/** @type {string} */ t) => t.includes(want)
    : want instanceof RegExp ? (/** @type {string} */ t) => want.test(t) : want;
  return until(async () => { const t = await readText(frame, id); return ok(t) ? t : null; },
    { timeout, interval, message: `text of ${id} to match ${String(want).slice(0, 60)}` });
}

/**
 * Waits until every local change to the blip is acknowledged ("Saved").
 * @param {import("playwright").FrameLocator} frame
 * @param {string} id
 */
export function waitSaved(frame, id, timeout = 10_000) {
  return until(() => inPane(frame, (store, _, bid) => {
    const s = store.getState();
    const t = s.text[bid];
    return s.pending === 0 && (!t || t.saving === "saved");
  }, id), { timeout, interval: 50, message: `${id} saved` });
}

/** A random blip id ("b_" + 12 hex). */
export function newBlipId() {
  return "b_" + [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A request id unique to this process. */
let requestCounter = 0;
export function newRequestId(prefix = "e2e") {
  return `${prefix}-${process.pid.toString(36)}-${Date.now().toString(36)}-${(requestCounter++).toString(36)}`;
}

/**
 * Creates a blip through the fake server's RPC (as the chat agent would) and returns its id.
 * @param {import("playwright").Page} page
 * @param {{text?: string, parentId?: string|null, kind?: "note"|"brief", anchor?: any, by?: string, order?: string}} [blip]
 */
export async function createBlip(page, { text = "", parentId = null, kind = "note", anchor, by = "Agent", order } = {}) {
  const blipId = newBlipId();
  const op = { op: "create", blipId, parentId, kind, text };
  if (anchor) op.anchor = anchor;
  if (order) op.order = order;
  const result = await page.evaluate((req) => window.harness.rpc("applyOperation", req),
    { by, senderId: "e2e-agent", requestId: newRequestId(), blipOps: [op] });
  if (result?.errors?.length) throw new Error("create failed: " + JSON.stringify(result.errors));
  if (result?.error) throw new Error("create failed: " + JSON.stringify(result));
  return blipId;
}

/**
 * Any RPC through the harness, with a fresh requestId and senderId filled in for writes.
 * @param {import("playwright").Page} page
 * @param {string} method
 * @param {any} [args]
 */
export function rpc(page, method, args = {}) {
  const withIds = args && typeof args === "object" && !("requestId" in args)
    ? { senderId: "e2e-agent", by: "Agent", requestId: newRequestId(), ...args } : args;
  return page.evaluate(({ m, a }) => window.harness.rpc(m, a), { m: method, a: withIds });
}

/** The server's snapshot. @param {import("playwright").Page} page */
export function serverWave(page) {
  return page.evaluate(() => window.harness.getWave());
}

/**
 * Waits until every listed pane shows the card, and resolves with the server's blip record.
 * @param {import("playwright").Page} page
 * @param {Record<string, import("playwright").FrameLocator>|import("playwright").FrameLocator[]} frames
 * @param {string} id
 */
export async function waitCard(page, frames, id) {
  for (const f of Object.values(frames)) await card(f, id).waitFor({ timeout: 10_000 });
  return (await serverWave(page)).blips[id];
}

/**
 * A peer's entry in the People panel by display name (the panel tab may need opening first).
 * @param {import("playwright").FrameLocator} frame
 * @param {string} name
 */
export function peerNamed(frame, name) {
  return frame.locator(".people .peer").filter({ hasText: name });
}

/**
 * Opens a panel tab and resolves with the panel's root locator (.panel-tab[data-tab]).
 * @param {import("playwright").FrameLocator} frame
 * @param {"decisions"|"agent"|"people"|"history"} tab
 */
export async function openPanel(frame, tab) {
  const btn = frame.locator(SEL.panelTab(tab));
  if (await btn.count()) await btn.first().click();
  return btn;
}

/**
 * Leaves History mode if the pane is in it (window.waveApp.history), and waits for the banner to
 * hide. A no-op when live.
 * @param {import("playwright").FrameLocator} frame
 */
export async function backToLive(frame) {
  const wasActive = await inPane(frame, (_store, app) => {
    const history = app && (app.history || (app.app && app.app.history));
    if (!history?.isActive?.()) return false;
    history.exit();
    return true;
  });
  if (wasActive) await frame.locator(SEL.historyBanner).waitFor({ state: "hidden", timeout: 5000 });
  return wasActive;
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
    if (Date.now() > end) throw new Error(`Timed out waiting for ${message}; last: ${last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

export const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

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

/**
 * Class name of the focused element in a pane ("" for <body>).
 * @param {import("playwright").FrameLocator} frame
 */
export function focusedClass(frame) {
  return frame.locator("body").evaluate(() => {
    const el = document.activeElement;
    return !el || el === document.body ? "" : String(el.getAttribute("class") ?? el.tagName);
  });
}

/**
 * Client rect of the first element matching `selector` in a pane, in page coordinates.
 * @param {import("playwright").FrameLocator} frame
 * @param {string} selector
 */
export async function pageRect(frame, selector) {
  const box = await frame.locator(selector).first().boundingBox();
  if (!box) throw new Error(`${selector} not visible`);
  return { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height };
}

/**
 * Saves a full-page screenshot as <SHOTS>/<name>.png (directory created on demand).
 * @param {import("playwright").Page} page
 * @param {string} name
 */
export async function screenshot(page, name) {
  await mkdir(SHOTS, { recursive: true });
  const path = join(SHOTS, `${name}.png`);
  await page.screenshot({ path }).catch(() => {});
  return path;
}

/**
 * Percentiles of a sample, for timings.
 * @param {number[]} xs
 */
export function stats(xs) {
  if (!xs.length) return { n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (/** @type {number} */ f) => Math.round(s[Math.min(s.length - 1, Math.floor(s.length * f))] * 10) / 10;
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: Math.round(s[s.length - 1] * 10) / 10 };
}
