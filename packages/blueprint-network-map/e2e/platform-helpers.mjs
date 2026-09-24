// Playwright helpers for driving a local Cloudflare OS Workshop with the network map gadget (see
// ./README.md). The Workshop parts (sign-up, onboarding, upload, create, share, export) are copied
// from packages/blueprint-whiteboard/e2e/platform-helpers.mjs, whose README lists the verified
// selectors. The map parts reach `globalThis.networkMap = {store, app}` inside the gadget's
// sandboxed `iframe[title="Gadget UI"]`.
//
// Plain ESM; imports `playwright` (devDependency of this package, pinned to 1.61.0 so it uses the
// Chromium build already cached in ~/.cache/ms-playwright). Run with the Linux node from this
// package directory so the import resolves.
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

export const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = join(PKG, "../..");
export const ARCHIVE = join(REPO, "formats/network-map.gadget");
export const DEFAULT_BASE_URL = "http://localhost:8787";
/** Server log written by start-local-platform.sh (same default and override). */
export const PLATFORM_LOG = process.env.CFOS_LOG || join(process.env.TMPDIR || tmpdir(), "cfos-local-platform.log");
/** Server-side problems that must never appear. */
export const STUB_WARNING = /RPC (stub|result) was not disposed properly/;
export const RUNTIME_CRASH = /The Workers runtime crashed unexpectedly/;
export const PROBLEM = new RegExp(`${STUB_WARNING.source}|${RUNTIME_CRASH.source}`);

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** Headless Chromium with software WebGL (as the harness suites), so sigma renders the canvas. */
export function launch(opts = {}) {
  return chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"], ...opts });
}

/**
 * Records `securitypolicyviolation` events in every frame (including the gadget's srcdoc iframe)
 * into `window.__cspViolations`, from before any page script runs.
 * @param {import("playwright").BrowserContext} context
 */
export async function recordCspViolations(context) {
  await context.addInitScript(() => {
    const w = /** @type {any} */ (window);
    if (w.__cspViolations) return;
    w.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__cspViolations.push({ directive: e.violatedDirective, blocked: e.blockedURI, sample: e.sample, source: e.sourceFile, line: e.lineNumber });
    });
  });
}

// --- Workshop -----------------------------------------------------------------------------------

// Usernames must match /^[a-z0-9_-]+$/i (no emails); passwords need >= 8 chars.
export async function signUp(page, baseUrl, username, password) {
  await page.goto(`${baseUrl}/signup`);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  const outcome = await Promise.race([
    page.waitForFunction(() => !!localStorage.getItem("authToken"), null, { timeout: 30_000 }).then(() => "ok"),
    page.getByText("Username already exists").waitFor({ timeout: 30_000 }).then(() => "exists"),
  ]);
  if (outcome === "exists") throw new Error("Username already exists");
  await page.waitForURL((u) => new URL(u).pathname === "/", { timeout: 30_000 });
  await completeOnboarding(page);
}

/** Clicks through the "Let's set you up" wizard a new account gets. No-op if absent. */
export async function completeOnboarding(page) {
  const heading = page.getByRole("heading", { name: "Let's set you up" });
  try {
    await heading.waitFor({ timeout: 5_000 });
  } catch {
    return;
  }
  const finish = page.getByRole("button", { name: "Let's build" });
  for (let i = 0; i < 6 && !(await finish.isVisible()); i++) {
    await page.getByRole("button", { name: "Next", exact: true }).click();
  }
  await finish.click();
  await heading.waitFor({ state: "detached", timeout: 30_000 });
}

export async function signIn(page, baseUrl, username, password) {
  await page.goto(`${baseUrl}/`);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForFunction(() => !!localStorage.getItem("authToken"), null, { timeout: 30_000 });
  await completeOnboarding(page);
}

/** Sign up, falling back to sign-in when the username already exists (re-runs on a kept .wrangler). */
export async function signUpOrIn(page, baseUrl, username, password) {
  try {
    await signUp(page, baseUrl, username, password);
  } catch (err) {
    if (/** @type {any} */ (err).message === "Username already exists") await signIn(page, baseUrl, username, password);
    else throw err;
  }
}

/** Uploads a `.gadget` archive on /blueprints and returns the new blueprint's id. */
export async function uploadGadget(page, baseUrl, archivePath) {
  await page.goto(`${baseUrl}/blueprints`);
  await page.getByRole("heading", { name: "Blueprints", level: 1 }).waitFor();
  await page.waitForFunction(() => !document.querySelector(".animate-pulse"), null, { timeout: 30_000 });
  const before = new Set(await blueprintIds(page));
  await page.locator('input[type="file"][accept=".gadget"]').setInputFiles(archivePath);
  await page.getByText("Blueprint uploaded").first().waitFor({ timeout: 60_000 });
  let ids = [];
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    ids = (await blueprintIds(page)).filter((id) => !before.has(id));
    if (ids.length) return ids[0];
    await sleep(250);
  }
  throw new Error("uploaded blueprint did not appear in the list");
}

async function blueprintIds(page) {
  const hrefs = await page.locator('a[href^="/blueprint/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  return [...new Set(hrefs.map((h) => decodeURIComponent(h.slice("/blueprint/".length))))];
}

/**
 * Opens /blueprint/<id> and clicks "Create Gadget". With no declared bindings there is no setup
 * step: it goes straight to the new workspace. Returns the workspace URL.
 */
export async function createGadgetFromBlueprint(page, baseUrl, blueprintId) {
  await page.goto(`${baseUrl}/blueprint/${encodeURIComponent(blueprintId)}`);
  await page.getByRole("button", { name: "Create Gadget" }).click();
  await page.waitForURL(/\/workspace\/[^/?#]+/, { timeout: 60_000 });
  return page.url();
}

/** Header "Share workspace" -> use-role ("Gadget only") link; returns the one-time URL. */
export async function createUseShareLink(page) {
  await page.getByRole("button", { name: "Share workspace" }).click();
  await page.getByRole("button", { name: "Create a share link" }).click();
  const roleMenu = page.getByRole("button", { name: "Access granted by link" });
  await roleMenu.waitFor();
  if (!/Gadget only/.test(await roleMenu.innerText())) {
    await roleMenu.click();
    await page.getByRole("menuitem", { name: /^Gadget only/ }).click();
  }
  await page.getByRole("button", { name: "Create link" }).click();
  const card = page.getByText("Link ready").locator('xpath=ancestor::div[contains(@class,"share-fade-in")]');
  const url = (await card.locator("p.font-mono").innerText({ timeout: 30_000 })).trim();
  await page.keyboard.press("Escape");
  return url;
}

/** Opens the gadget pane's export dropdown (aria-label "Export Gadget"). */
export async function openExportMenu(page) {
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.mouse.move(1, 1);
  await page.locator("[data-base-ui-portal] .kumo-tooltip, [data-base-ui-portal] [data-instant]").first()
    .waitFor({ state: "detached", timeout: 3_000 }).catch(() => {});
  await page.getByRole("button", { name: "Export Gadget" }).click();
  const menu = page.getByRole("menu");
  await menu.waitFor();
  await page.getByRole("status", { name: "Loading export formats" }).waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
  return menu;
}

/** Labels of the export formats offered (the menu is closed again). */
export async function listExportFormats(page) {
  const menu = await openExportMenu(page);
  const labels = await menu.getByRole("menuitem").allInnerTexts();
  await page.keyboard.press("Escape");
  return labels.map((s) => s.trim());
}

/**
 * Clicks an export format and captures the file: {filename, text, bytes}. Pass an anchored RegExp
 * when one label could be a substring of another.
 * @param {import("playwright").Page} page @param {string|RegExp} label
 */
export async function downloadExport(page, label) {
  await page.evaluate(() => { try { delete (/** @type {any} */ (window)).showSaveFilePicker; } catch {} /** @type {any} */ (window).showSaveFilePicker = undefined; });
  const menu = await openExportMenu(page);
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    menu.getByRole("menuitem", { name: label }).click(),
  ]);
  const chunks = [];
  for await (const c of await download.createReadStream()) chunks.push(c);
  const bytes = Buffer.concat(chunks);
  return { filename: download.suggestedFilename(), text: bytes.toString("utf8"), bytes };
}

// --- The map inside the gadget iframe -----------------------------------------------------------

/**
 * The gadget iframe's current Frame once its map app has a model and the store is live. Survives
 * the frame reloading itself or the platform rebuilding the iframe (re-acquired each attempt).
 * @param {import("playwright").Page} page
 * @param {{timeout?: number, minNodes?: number}} [opts]
 */
export async function mapFrame(page, { timeout = 60_000, minNodes = 0 } = {}) {
  const deadline = Date.now() + timeout;
  let last = "no iframe";
  while (Date.now() < deadline) {
    const handle = await page.$('iframe[title="Gadget UI"]').catch(() => null);
    const frame = handle ? await handle.contentFrame().catch(() => null) : null;
    if (frame) {
      const ok = await frame.evaluate((min) => {
        const nm = /** @type {any} */ (globalThis).networkMap;
        if (!nm) return "no networkMap";
        if (!nm.app?.model) return "no model";
        if (nm.store.status.connection !== "live") return `connection ${nm.store.status.connection}`;
        if (nm.app.model.nodes.size < min) return `nodes ${nm.app.model.nodes.size}`;
        return true;
      }, minNodes).catch((e) => String(e?.message ?? e).slice(0, 80));
      if (ok === true) return frame;
      last = String(ok);
    }
    await sleep(100);
  }
  throw new Error(`map app not live in time (${last})`);
}

/** Everything the app knows, as plain data. @param {import("playwright").Frame} frame */
export function appState(frame) {
  return frame.evaluate(() => {
    const { store, app } = /** @type {any} */ (globalThis).networkMap;
    return {
      connection: store.status.connection, pending: store.status.pendingCount, revision: store.revision,
      viewer: { name: store.viewer.name, clientId: store.viewer.clientId },
      objects: [...store.objects.values()], selection: [...app.selection], mode: app.mode,
      nodes: app.model ? app.model.nodes.size : 0, edges: app.model ? app.model.edges.size : 0,
      peers: [...store.peers.values()].map((p) => ({ clientId: p.clientId, name: p.name, selection: p.selection ?? [] })),
    };
  });
}

/** One object from the frame's store (null if absent). @param {import("playwright").Frame} frame @param {string} id */
export function objectIn(frame, id) {
  return frame.evaluate((x) => /** @type {any} */ (globalThis).networkMap.store.objects.get(x) ?? null, id);
}

/** Applies ops through the frame's store (the path the UI uses). @param {import("playwright").Frame} frame @param {any[]} ops */
export function apply(frame, ops) {
  return frame.evaluate((o) => { /** @type {any} */ (globalThis).networkMap.store.apply(o); }, ops);
}

/** Waits until the frame's store has nothing pending and is live. @param {import("playwright").Frame} frame */
export async function settled(frame, timeout = 30_000) {
  await frame.waitForFunction(() => {
    const s = /** @type {any} */ (globalThis).networkMap.store.status;
    return s.pendingCount === 0 && s.connection === "live";
  }, null, { timeout, polling: 50 });
}

/**
 * Polls `fn` (re-acquiring the page's map frame each time) until it returns a truthy value.
 * @template T
 * @param {import("playwright").Page} page
 * @param {(frame: import("playwright").Frame) => Promise<T>} fn
 * @param {{timeout?: number, interval?: number, message?: string}} [opts]
 * @returns {Promise<T>}
 */
export async function eventually(page, fn, { timeout = 15_000, interval = 50, message = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const frame = await mapFrame(page, { timeout: Math.max(1000, deadline - Date.now()) });
      const v = await fn(frame);
      if (v) return v;
    } catch (e) { lastErr = e; }
    await sleep(interval);
  }
  throw new Error(`${message} not met in ${timeout} ms${lastErr ? ` (last error: ${/** @type {any} */ (lastErr).message})` : ""}`);
}

/** A map id: kind letter, underscore, 12 hex digits. @param {string} kind @param {number} n */
export const mapId = (kind, n) => `${kind}_${n.toString(16).padStart(12, "0")}`;

// --- Platform log -------------------------------------------------------------------------------

/** Current byte length of the platform log (0 when absent). */
export function logOffset() {
  return stat(PLATFORM_LOG).then((s) => s.size, () => 0);
}

/** Lines of the platform log written since `offset` that match `re`. @param {number} offset @param {RegExp} re */
export async function logLinesSince(offset, re) {
  const text = await readFile(PLATFORM_LOG).then((b) => b.subarray(offset).toString("utf8"), () => "");
  return text.split("\n").filter((l) => re.test(l));
}
