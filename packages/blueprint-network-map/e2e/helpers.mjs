// Shared helpers for the harness e2e suites (node --test). Each suite starts its own harness server
// on its own port, so suites can run in parallel.
//
//   const h = await startHarness({ port: 8801 });        // builds dist unless opts.build === false
//   const { page, frames } = await h.open({ panes: 2 }); // frames[i] is pane i's gadget frame
//   ... await h.close();

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { buildGadget } from "../scripts/build.mjs";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @param {{port: number, build?: boolean, dist?: string}} opts
 */
export async function startHarness({ port, build = true, dist = "dist" }) {
  if (build) await buildGadget(join(pkg, dist));
  const server = spawn(process.execPath, [join(pkg, "harness/serve.mjs"), "--port", String(port), "--dist", join(pkg, dist)], { cwd: pkg, stdio: ["ignore", "pipe", "pipe"] });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("harness did not start")), 15000);
    server.stdout.on("data", (d) => {
      const m = /HARNESS_URL (\S+)/.exec(String(d));
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    server.on("exit", (code) => reject(new Error(`harness exited ${code}`)));
  });
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
  /** @type {any[]} */
  const pages = [];
  return {
    url, browser,
    /**
     * Opens the harness with query options and waits until every pane's app has loaded its map.
     * @param {{panes?: number, latency?: number, blank?: boolean, viewport?: {width: number, height: number}, fresh?: boolean}} [o]
     */
    async open(o = {}) {
      const context = await browser.newContext({ viewport: o.viewport ?? { width: 1400, height: 900 } });
      const page = await context.newPage();
      pages.push(page);
      page.errors = [];
      page.on("pageerror", (e) => page.errors.push(e.message));
      page.on("console", (m) => { if (m.type() === "error") page.errors.push(m.text()); });
      const q = new URLSearchParams({ panes: String(o.panes ?? 1), ...(o.latency ? { latency: String(o.latency) } : {}), ...(o.blank ? { blank: "1" } : {}) });
      await page.goto(`${url}?${q}`);
      await page.waitForFunction(() => window.harness?.ready, null, { timeout: 20000 });
      if (o.fresh !== false) {
        // A fresh map for every test: clear storage and reload.
        await page.evaluate(() => window.harness.resetStorage());
        await page.goto(`${url}?${q}`);
        await page.waitForFunction(() => window.harness?.ready, null, { timeout: 20000 });
      }
      const frames = await paneFrames(page, o.panes ?? 1);
      for (const f of frames) await waitForApp(f);
      return { page, frames };
    },
    async close() {
      for (const p of pages) await p.context().close().catch(() => {});
      await browser.close();
      server.kill("SIGTERM");
    },
  };
}

/** The gadget frames of a harness page, in pane order. @param {any} page @param {number} n */
export async function paneFrames(page, n) {
  const frames = [];
  for (let i = 0; i < n; i++) {
    const handle = await page.waitForSelector(`#panes iframe[data-pane="${i}"]`);
    frames.push(await handle.contentFrame());
  }
  return frames;
}

/** Waits until the app in `frame` has a model (snapshot loaded and rendered). @param {any} frame */
export async function waitForApp(frame) {
  await frame.waitForFunction(() => globalThis.networkMap?.app?.model && globalThis.networkMap.store.status.connection !== "connecting", null, { timeout: 20000 });
}

/** Re-acquires a pane's frame after it reloaded. @param {any} page @param {number} i */
export async function reacquire(page, i) {
  const handle = await page.waitForSelector(`#panes iframe[data-pane="${i}"]`);
  const frame = await handle.contentFrame();
  await waitForApp(frame);
  return frame;
}

/** Everything the app knows, as plain data. @param {any} frame */
export function appState(frame) {
  return frame.evaluate(() => {
    const { store, app } = globalThis.networkMap;
    return {
      connection: store.status.connection, pending: store.status.pendingCount, revision: store.revision,
      objects: [...store.objects.values()], selection: [...app.selection], viewId: app.viewId,
      nodes: app.model ? app.model.nodes.size : 0, edges: app.model ? app.model.edges.size : 0,
      peers: [...store.peers.values()].map((p) => ({ name: p.name, selection: p.selection })),
    };
  });
}

/** Waits until the pane has nothing pending. @param {any} frame */
export async function settled(frame) {
  await frame.waitForFunction(() => {
    const s = globalThis.networkMap.store.status;
    return s.pendingCount === 0 && s.connection === "live";
  }, null, { timeout: 15000 });
}

/** Waits until `fn(state)` holds in the pane. @param {any} frame @param {(s: any) => boolean} fn @param {number} [timeout] */
export async function until(frame, fn, timeout = 10000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await appState(frame);
    if (fn(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("condition not met; last state: " + JSON.stringify({ ...last, objects: last?.objects?.length }).slice(0, 500));
}

/** CSP violations and page errors so far. @param {any} page */
export async function problems(page) {
  const violations = await page.evaluate(() => window.harness.violations);
  const logs = await page.evaluate(() => window.harness.logs.filter((l) => l.level === "error"));
  return { violations, errors: [...(page.errors ?? []), ...logs.map((l) => l.message.join(" "))] };
}
