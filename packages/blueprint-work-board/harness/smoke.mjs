// Harness smoke check (not part of the test suite): builds the client, starts serve.mjs in its own
// process group, opens the harness with 300 seeded items, checks the pane renders them under the
// platform CSP, runs one manual-approval create through the pane's UI when the build offers a
// "New item" button, checks window.harness, then stops everything.
//
//   node harness/smoke.mjs [--port 8796] [--no-build]   (--no-build: use the dist/ already built)

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { buildGadget } from "../scripts/build.mjs";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const argPort = process.argv.indexOf("--port");
const port = argPort !== -1 ? Number(process.argv[argPort + 1]) : 8796;

if (!process.argv.includes("--no-build")) await buildGadget();
const server = spawn(process.execPath, [join(pkg, "harness/serve.mjs"), "--port", String(port)], { cwd: pkg, detached: true, stdio: ["ignore", "pipe", "pipe"] });
const stop = () => { try { process.kill(-/** @type {number} */ (server.pid), "SIGTERM"); } catch { /* gone */ } };
let failed = false;
const check = (/** @type {boolean} */ ok, /** @type {string} */ what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed = true; };

try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("harness did not start")), 15_000);
    server.stdout.on("data", (d) => { const m = /HARNESS_URL (\S+)/.exec(String(d)); if (m) { clearTimeout(timer); resolve(m[1]); } });
    server.on("exit", (code) => reject(new Error(`harness exited ${code}`)));
  });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    /** @type {string[]} */
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    const t0 = Date.now();
    await page.goto(`${url}?seed=300&approval=manual`);
    await page.waitForFunction(() => window.harness?.ready, null, { timeout: 20_000 });
    const seedMs = await page.evaluate(() => window.harness.seedMs);
    console.log(`seed 300 in the browser: ${seedMs} ms; harness ready after ${Date.now() - t0} ms`);
    const frame = await (await page.waitForSelector('#panes iframe[data-pane="0"]')).contentFrame();
    const firstTitle = await page.evaluate(() => [...window.harness.fake.rows.values()].find((r) => r.entity === "work_item" && r.data.state === "todo" && !r.data.archived)?.data.title);
    await frame.waitForFunction((t) => document.body.innerText.includes(t), firstTitle, { timeout: 20_000 });
    check(true, `pane shows seeded item "${firstTitle}"`);

    const newItem = frame.getByRole("button", { name: "New item" });
    if (await newItem.count()) {
      await newItem.click();
      await frame.locator("#wb-new-title").fill("Smoke test item");
      await frame.getByRole("button", { name: "Create item" }).click();
      await page.waitForFunction(() => window.harness.pending().length === 1, null, { timeout: 10_000 });
      const pending = await page.evaluate(() => window.harness.pending()[0]);
      check(pending.command === "work.create" && pending.actor === "cloudflare-os:ada@example.com", `pending create by ${pending.actor}`);
      await page.evaluate(() => window.harness.approveAll());
      await frame.waitForFunction(() => document.body.innerText.includes("Smoke test item"), null, { timeout: 15_000 });
      check(true, "approved create appears in the pane");
    } else {
      console.log("skip: this build has no \"New item\" button; approving an agent-free command through the fake instead");
    }
    const ext = await page.evaluate(() => window.harness.external());
    check(Boolean(ext?.id), "external edit applied");
    const setup = await page.evaluate(() => window.harness.rpc("getSetup"));
    check(setup.connected && setup.description.modules[0].entities.includes("workflow_state"), "rpc(getSetup) reports the planning model");
    const violations = await page.evaluate(() => window.harness.violations);
    check(violations.length === 0, `no CSP violations (${JSON.stringify(violations).slice(0, 200)})`);
    const paneErrors = await page.evaluate(() => window.harness.logs.filter((l) => l.level === "error"));
    check(errors.length === 0 && paneErrors.length === 0, `no errors (${JSON.stringify([...errors, ...paneErrors]).slice(0, 300)})`);
    await page.screenshot({ path: "/tmp/claude-1000/work-board-harness-smoke.png" }).catch(() => {});
  } finally {
    await browser.close();
  }
} finally {
  stop();
}
process.exit(failed ? 1 : 0);
