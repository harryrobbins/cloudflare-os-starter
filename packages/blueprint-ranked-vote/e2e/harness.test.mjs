// End-to-end over the harness: three viewers (Alice, Bob, Cara), each running the real built
// client against the real rules. Run `node scripts/build.mjs` first.
//
//   node --test e2e/harness.test.mjs        (SHOTS=<dir> also saves screenshots)
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
/** @type {import("node:child_process").ChildProcess} */
let server;
/** @type {import("playwright").Browser} */
let browser;
/** @type {import("playwright").Page} */
let page;
let url = "";

before(async () => {
  server = spawn(process.execPath, [join(pkg, "harness/serve.mjs"), "--port", "8830"], { detached: true, stdio: ["ignore", "pipe", "inherit"] });
  url = await new Promise((resolve, reject) => {
    server.stdout?.on("data", (d) => { const m = /HARNESS_URL (\S+)/.exec(String(d)); if (m) resolve(m[1]); });
    server.on("exit", () => reject(new Error("harness server exited")));
  });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
  await page.goto(url);
});

after(async () => {
  await browser?.close();
  if (server?.pid) try { process.kill(-server.pid); } catch { /* gone */ }
});

const pane = (/** @type {number} */ i) => page.frameLocator(`iframe[data-pane="${i}"]`);
const frame = (/** @type {number} */ i) => /** @type {import("playwright").Frame} */ (page.frames().find((f) => f.url().includes(`pane=${i}`)));
const [A, B, C] = [0, 1, 2];
const order = async (/** @type {number} */ i) => pane(i).locator(".ranking .opt-title").allTextContents();
const shot = async (/** @type {string} */ name) => { if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `${name}.png`) }); };

test("propose, add fields, rank privately, reveal and count", async () => {
  const a = pane(A);
  await a.getByRole("button", { name: "What should we call it?" }).click();
  await a.getByLabel("Question").fill("What should we call the company?");
  await a.getByLabel("Question").press("Enter");
  await pane(C).getByRole("heading", { name: "What should we call the company?" }).waitFor();

  await a.getByLabel("New field name").fill("Proposed URL");
  await a.getByLabel("New field type").selectOption("url");
  await a.getByLabel("New field name").press("Enter");
  await a.getByLabel("New field name").fill("Companies House check");
  await a.getByLabel("New field name").press("Enter");
  await pane(B).locator(".fields-list li", { hasText: "Companies House check" }).waitFor();

  for (const [who, name, desc] of [[A, "Hoarse", "Rough or husky in the voice"], [B, "Lumen", ""], [C, "Tessel", ""]]) {
    const p = pane(/** @type {number} */ (who));
    await p.getByLabel("New option", { exact: true }).fill(/** @type {string} */ (name));
    if (desc) await p.getByLabel("Description of the new option").fill(/** @type {string} */ (desc));
    await p.getByRole("button", { name: "Add", exact: true }).first().click();
  }
  for (const i of [A, B, C]) await pane(i).locator(".ranking .opt").nth(2).waitFor();
  const dup = pane(B);
  await dup.getByLabel("New option", { exact: true }).fill("hoarse");
  await dup.getByRole("button", { name: "Add", exact: true }).first().click();
  await dup.locator(".toast", { hasText: "already on the list" }).waitFor();

  // Bob fills in a field on Alice's option; Cara sees it.
  await pane(B).locator(".opt-title", { hasText: "Hoarse" }).click();
  const urlField = pane(B).getByLabel("Proposed URL");
  await urlField.fill("hoarse.co.uk");
  await urlField.press("Enter");
  await pane(C).locator(".opt", { hasText: "Hoarse" }).locator(".fact", { hasText: "hoarse.co.uk" }).waitFor();

  // Everyone starts from their own shuffle; nobody has a ballot yet.
  assert.equal(await pane(A).locator(".voters li").count(), 0);

  // Alice drags her last option to the top with the pointer.
  const start = await order(A);
  const last = pane(A).locator(".ranking .opt").nth(2).locator(".handle");
  const first = pane(A).locator(".ranking .opt").nth(0);
  const from = await last.boundingBox();
  const to = await first.boundingBox();
  assert.ok(from && to);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) await page.mouse.move(from.x + from.width / 2, from.y + (to.y + 5 - from.y) * k / 10);
  await page.mouse.up();
  await pane(B).locator(".voters li", { hasText: "Alice" }).waitFor();
  assert.deepEqual(await order(A), [start[2], start[0], start[1]]);

  // Bob uses the keyboard: focus Tessel's handle and press Home.
  await pane(B).locator(".opt", { hasText: "Tessel" }).locator(".handle").focus();
  await page.keyboard.press("Home");
  await pane(A).locator(".voters li", { hasText: "Bob" }).waitFor();
  assert.equal((await order(B))[0], "Tessel");

  // Nobody else's ballot reaches a viewer.
  const aliceView = await frame(A).evaluate(() => JSON.stringify(/** @type {any} */ (window).rankedVote.app.view));
  assert.equal((aliceView.match(/"ranking"/g) ?? []).length, 1);

  // Cara ranks Hoarse top with the buttons.
  const cara = pane(C);
  if ((await order(C))[0] === "Hoarse") await cara.getByRole("button", { name: "Move Hoarse down" }).click();
  while ((await order(C))[0] !== "Hoarse") await cara.getByRole("button", { name: "Move Hoarse up" }).click();
  await pane(A).locator(".voters li", { hasText: "Cara" }).waitFor();

  await pane(A).getByRole("button", { name: "Reveal", exact: true }).click();
  await pane(B).getByRole("button", { name: "Reveal", exact: true }).click();
  await pane(A).getByText("You're ready. Waiting on Cara.").waitFor();
  await shot("waiting");
  // A late option resets everyone's Reveal and is marked new.
  await cara.getByLabel("New option", { exact: true }).fill("Quill");
  await cara.getByRole("button", { name: "Add", exact: true }).first().click();
  await pane(A).locator(".opt.is-new", { hasText: "Quill" }).waitFor();
  await pane(A).getByText("added at the bottom of your list").waitFor();
  assert.equal(await pane(A).getByRole("button", { name: "Reveal", exact: true }).isEnabled(), true);

  for (const i of [A, B, C]) await pane(i).getByRole("button", { name: "Reveal", exact: true }).click();
  for (const i of [A, B, C]) await pane(i).locator(".results .winner .name").waitFor();
  const winner = await pane(B).locator(".results .winner .name").textContent();
  assert.ok(["Hoarse", "Lumen", "Tessel", "Quill"].includes(winner ?? ""), winner ?? "");
  assert.equal(await pane(C).locator(".results table.rounds tbody tr").count(), 4);
  await shot("results");

  await pane(B).getByRole("button", { name: "Reopen voting" }).click();
  await pane(A).getByRole("button", { name: "Reveal", exact: true }).waitFor();
  await pane(A).getByText("voting has reopened").waitFor();
});

test("recovers after a server restart leaves the stubs dead", async () => {
  await page.getByRole("button", { name: /Restart server/ }).click();
  // Each pane notices on its next call or heartbeat and reloads itself.
  await pane(A).getByLabel("New option", { exact: true }).fill("After restart");
  await pane(A).getByRole("button", { name: "Add", exact: true }).first().click();
  await pane(A).getByLabel("New option", { exact: true }).fill("After restart");
  await pane(A).getByRole("button", { name: "Add", exact: true }).first().click();
  await page.waitForTimeout(1500);
  await pane(A).getByRole("heading", { name: "What should we call the company?" }).waitFor({ timeout: 20_000 });
  await pane(A).getByLabel("New option", { exact: true }).fill("After restart");
  await pane(A).getByRole("button", { name: "Add", exact: true }).first().click();
  await pane(B).locator(".opt-title", { hasText: "After restart" }).waitFor({ timeout: 30_000 });
});
