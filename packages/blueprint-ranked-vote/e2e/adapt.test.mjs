// The adapt block's extension points, in the harness: a fixture replaces client.js's `adapt` object
// (as an agent would edit it) and the real library must honour it. Run `node scripts/build.mjs` first.
//
//   node --test e2e/adapt.test.mjs
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");

const FIXTURE = `const adapt = {
  title: "Offsite vote",
  labels: { reveal: "Lock in", propose: "Suggest a venue", nonsense: "ignored" },
  layout: { main: ["results", "add", "ranking"], side: ["tally", "ready", "fields", "missing"] },
  panels: {
    tally: (app) => [h("h2", { text: "Tally" }), h("p", { class: "tally", text: \`\${app.view.options.length} options so far\` })],
  },
  showRoundTable: true,
  showRoundStory: false,
  styles: ".app { border-top: 7px solid rgb(1, 2, 3); }",
  actions: [
    { id: "add-ron", label: "Add RON", title: "Adds Re-open nominations", run: (app) => app.proposeOption("Re-open nominations") },
    { id: "hello", label: "Say hello", run: (app) => app.toast(\`Hello, \${app.me.name}\`) },
    { id: "broken", label: "No run function" },
  ],
  onReady(app) {
    window.readyCount = (window.readyCount ?? 0) + 1;
    window.readyQuestion = app.view.question;
  },
};`;

/** @type {import("node:child_process").ChildProcess} */
let server;
/** @type {import("playwright").Browser} */
let browser;
/** @type {import("playwright").Page} */
let page;
/** @type {string[]} */
const consoleErrors = [];

before(async () => {
  const client = await readFile(join(pkg, "dist/client.js"), "utf8");
  const start = client.indexOf("const adapt = {");
  const end = client.indexOf("\n};\n", start) + 3;
  assert.ok(start > 0 && end > start, "client.js has an adapt block");
  const adapted = client.slice(0, start) + FIXTURE + client.slice(end);

  server = spawn(process.execPath, [join(pkg, "harness/serve.mjs"), "--port", "8850"], { detached: true, stdio: ["ignore", "pipe", "inherit"] });
  const url = await new Promise((resolve, reject) => {
    server.stdout?.on("data", (d) => { const m = /HARNESS_URL (\S+)/.exec(String(d)); if (m) resolve(m[1]); });
    server.on("exit", () => reject(new Error("harness server exited")));
  });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.route("**/dist/client.js", (route) => route.fulfill({ body: adapted, contentType: "text/javascript" }));
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") consoleErrors.push(m.text()); });
  await page.goto(`${url}?names=Alice,Bob`);
});

after(async () => {
  await browser?.close();
  if (server?.pid) try { process.kill(-server.pid); } catch { /* gone */ }
});

const pane = (/** @type {number} */ i) => page.frameLocator(`iframe[data-pane="${i}"]`);
const frame = (/** @type {number} */ i) => /** @type {import("playwright").Frame} */ (page.frames().find((f) => f.url().includes(`pane=${i}`)));

test("actions appear in a toolbar, are keyboard-reachable and run with the app handle", async () => {
  const a = pane(0);
  const toolbar = a.getByRole("toolbar", { name: "Vote actions" });
  await toolbar.getByRole("button", { name: "Add RON" }).waitFor();
  assert.equal(await toolbar.getByRole("button").count(), 2, "the action without run() is skipped");
  assert.ok(consoleErrors.some((e) => /actions\[2\]/.test(e)), "the bad action is reported in the console");

  // Keyboard: the question button, then the first action, in tab order.
  await a.getByRole("button", { name: "What should we call it?" }).focus();
  await page.keyboard.press("Tab");
  assert.equal(await frame(0).evaluate(() => document.activeElement?.textContent), "Add RON");
  await page.keyboard.press("Enter");
  await pane(1).locator(".opt-title", { hasText: "Re-open nominations" }).waitFor();

  await toolbar.getByRole("button", { name: "Say hello" }).click();
  await a.locator(".toast", { hasText: "Hello, Alice" }).waitFor();
});

test("styles, labels, layout, panels and round display follow the adapt block", async () => {
  const a = pane(0);
  assert.equal(await frame(0).evaluate(() => getComputedStyle(/** @type {Element} */ (document.querySelector(".app"))).borderTopColor), "rgb(1, 2, 3)");
  assert.equal(await frame(0).evaluate(() => document.title), "Offsite vote");
  assert.equal(await a.getByPlaceholder("Suggest a venue").count(), 1);
  await a.locator(".tally", { hasText: "1 options so far" }).waitFor();
  assert.equal(await a.locator("aside h2").first().textContent(), "Tally");
  assert.equal(await a.locator("aside h2", { hasText: "Activity" }).count(), 0, "activity is left out of the layout");
  assert.ok(consoleErrors.some((e) => /no section called "missing"/.test(e)));

  await a.getByPlaceholder("Suggest a venue").fill("Brighton");
  await a.getByRole("button", { name: "Add", exact: true }).first().click();
  await a.locator(".tally", { hasText: "2 options so far" }).waitFor();
  for (const i of [0, 1]) await pane(i).getByRole("button", { name: "Lock in", exact: true }).click();
  await a.locator(".results .winner .name").waitFor();
  assert.equal(await a.locator(".results table.rounds").count(), 1);
  assert.equal(await a.locator(".results .narrative").count(), 0, "showRoundStory: false hides the story");
});

test("onReady fires once per page, after the first view", async () => {
  for (const i of [0, 1]) {
    assert.equal(await frame(i).evaluate(() => /** @type {any} */ (window).readyCount), 1);
    assert.equal(await frame(i).evaluate(() => /** @type {any} */ (window).readyQuestion), "What should we call it?");
  }
});
