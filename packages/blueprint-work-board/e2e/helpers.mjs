// Helpers for the Work Board harness e2e (node --test + playwright). The harness server runs in its
// own process group and is stopped by `close()`.
//
//   const h = await startHarness({ port: 8797 });
//   const { page, frame } = await h.open({ seed: 300 });
//   ...; await h.close();

import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { buildGadget } from "../scripts/build.mjs";

export const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SHOTS = process.env.HARNESS_SHOTS || join(PKG, "e2e/screenshots");
const require = createRequire(join(PKG, "package.json"));

/** @param {{ port?: number, build?: boolean }} [opts] */
export async function startHarness({ port = Number(process.env.HARNESS_PORT || 8797), build = true } = {}) {
  if (build) await buildGadget();
  const server = spawn(process.execPath, [join(PKG, "harness/serve.mjs"), "--port", String(port)], { cwd: PKG, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const stop = () => { try { process.kill(-/** @type {number} */ (server.pid), "SIGTERM"); } catch { /* gone */ } };
  const url = await new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => { stop(); reject(new Error(`harness did not start: ${out}`)); }, 20_000);
    server.stdout.on("data", (d) => { out += d; const m = /HARNESS_URL (\S+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } });
    server.stderr.on("data", (d) => { out += d; });
    server.on("exit", (code) => { clearTimeout(timer); reject(new Error(`harness exited ${code}: ${out}`)); });
  });
  const browser = await chromium.launch({ headless: true });
  /** @type {import("playwright").BrowserContext[]} */
  const contexts = [];
  return {
    url, browser,
    /**
     * Opens the harness and waits for the board to be ready in pane 0.
     * @param {{ seed?: number, approval?: "auto"|"manual", v1?: boolean, access?: "read", latency?: number, panes?: number,
     *   viewport?: { width: number, height: number }, colorScheme?: "light"|"dark", reducedMotion?: "reduce"|"no-preference",
     *   now?: string, timestamps?: boolean, hasTouch?: boolean, extra?: string, waitReady?: boolean }} [o]
     */
    async open(o = {}) {
      const context = await browser.newContext({ viewport: o.viewport ?? { width: 1440, height: 900 }, colorScheme: o.colorScheme ?? "light", reducedMotion: o.reducedMotion ?? "reduce", hasTouch: o.hasTouch ?? false });
      contexts.push(context);
      const page = await context.newPage();
      /** @type {string[]} */
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
      const q = new URLSearchParams({ seed: String(o.seed ?? 300), approval: o.approval ?? "auto", now: o.now ?? "2026-09-26T12:00:00Z" });
      if (o.v1) q.set("v1", "1");
      if (o.access) q.set("access", o.access);
      if (o.latency) q.set("latency", String(o.latency));
      if (o.panes) q.set("panes", String(o.panes));
      if (o.timestamps) q.set("timestamps", "1");
      await page.goto(`${url}?${q}${o.extra ?? ""}`);
      await page.waitForFunction(() => window.harness?.ready, null, { timeout: 30_000 });
      const frame = await paneFrame(page, 0);
      if (o.waitReady !== false) await waitReady(frame);
      return { page, frame, errors, context };
    },
    async close() {
      for (const c of contexts) await c.close().catch(() => {});
      await browser.close().catch(() => {});
      stop();
    },
  };
}

/** @param {import("playwright").Page} page @param {number} i */
export async function paneFrame(page, i) {
  const handle = await page.waitForSelector(`#panes iframe[data-pane="${i}"]`);
  return /** @type {import("playwright").Frame} */ (await handle.contentFrame());
}

/** @param {import("playwright").Frame} frame */
export async function waitReady(frame, timeout = 20_000) {
  await frame.waitForFunction(() => globalThis.workBoard?.store?.phase === "ready" && document.querySelector(".layout-host:not([hidden])"), null, { timeout });
}

/** Everything interesting about the app state. @param {import("playwright").Frame} frame */
export function appState(frame) {
  return frame.evaluate(() => {
    const { app, store } = globalThis.workBoard;
    return {
      phase: store.phase, layout: app.view.layout, query: app.view.query, selection: [...app.selection],
      changes: store.changes.map((c) => ({ id: c.id, status: c.status, label: c.label, command: c.command, input: c.input, message: c.message })),
      items: store.index().itemList.length, focus: app.boardFocus, active: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.className ?? "",
      live: document.querySelector('[data-live="polite"]')?.textContent ?? "",
    };
  });
}

/** Polls until fn() is truthy. @template T @param {() => Promise<T>} fn */
export async function until(fn, { timeout = 10_000, interval = 50, message = "condition" } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    if (Date.now() > end) throw new Error(`Timed out waiting for ${message}; last: ${last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Runs axe-core in the frame; returns serious/critical violations. @param {import("playwright").Frame} frame */
export async function axe(frame, { include = null } = {}) {
  const source = await readFile(require.resolve("axe-core/axe.min.js"), "utf8");
  // The frame's CSP blocks inline script from outside; evaluate runs over CDP and is not blocked.
  await frame.evaluate(source);
  const results = await frame.evaluate(async (inc) => {
    // @ts-ignore injected
    const r = await globalThis.axe.run(inc ? { include: [[inc]] } : document, { resultTypes: ["violations"], rules: { "color-contrast": { enabled: true } } });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 5).map((n) => n.target.join(" ") + " :: " + (n.failureSummary ?? "").split("\n").slice(0, 3).join(" ")) }));
  }, include);
  return results.filter((v) => v.impact === "serious" || v.impact === "critical");
}

/** @param {import("playwright").Page} page @param {string} name */
export async function screenshot(page, name) {
  await mkdir(SHOTS, { recursive: true });
  const path = join(SHOTS, `${name}.png`);
  await page.screenshot({ path });
  return path;
}

/** Problems collected so far (page errors, pane console errors, CSP violations). @param {import("playwright").Page} page @param {string[]} errors */
export async function problems(page, errors) {
  const violations = await page.evaluate(() => window.harness.violations);
  const logs = await page.evaluate(() => window.harness.logs.filter((l) => l.level === "error").map((l) => l.message.join(" ")));
  return { violations, errors: [...errors, ...logs].filter((e) => !/favicon/.test(e)) };
}
