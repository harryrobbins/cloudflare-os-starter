// End-to-end over the harness: two players (Alice, Bob), each running the real built client
// against the real rules. Run `node scripts/build.mjs` first.
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
const errors = [];

before(async () => {
  server = spawn(process.execPath, [join(pkg, "harness/serve.mjs"), "--port", "8850"], { detached: true, stdio: ["ignore", "pipe", "inherit"] });
  const url = await new Promise((resolve, reject) => {
    server.stdout?.on("data", (d) => { const m = /HARNESS_URL (\S+)/.exec(String(d)); if (m) resolve(m[1]); });
    server.on("exit", () => reject(new Error("harness server exited")));
  });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1700, height: 950 } });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${url}?names=Alice,Bob`);
});

after(async () => {
  await browser?.close();
  if (server?.pid) try { process.kill(-server.pid); } catch { /* gone */ }
});

const pane = (/** @type {number} */ i) => page.frameLocator(`iframe[data-pane="${i}"]`);
const shot = async (/** @type {string} */ name) => { if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `${name}.png`) }); };
const [A, B] = [0, 1];

const GAME = `export const config = { title: "Test catch", mode: "bbc1", help: ["Press fire to score"] };
export default function game(a) {
  let score = 0, sent = false;
  return {
    update() {
      if (a.btnp("fire")) { score += 25; a.sfx("coin"); }
      if (score >= 50 && !sent) { sent = true; a.score.submit(score, "e2e"); }
    },
    draw(g) { g.cls(0); g.text("SCORE " + score, 8, 8, "yellow"); },
  };
}
`;

test("both players see the stocked shelf", async () => {
  for (const i of [A, B]) {
    for (const title of ["Invaders", "Rocks", "Blocks", "Bricks", "Number Gulper", "Teletext Tables", "Dark Room"]) {
      await pane(i).getByRole("heading", { name: title, exact: true }).waitFor();
    }
  }
  await shot("shelf");
});

test("make a game, see a syntax error with its line, fix, save, play and score", async () => {
  const a = pane(A);
  await a.getByLabel("New game name").fill("Test catch");
  await a.getByRole("button", { name: "Create and open code" }).click();
  const code = a.getByLabel("Code of Test catch");
  await code.waitFor();
  await a.locator(".log.ok").waitFor(); // the blank cartridge runs

  // A syntax error on line 3 is reported with a link to line 3.
  await code.fill(GAME.replace("let score = 0, sent = false;", "let score = = 0;"));
  await a.getByRole("button", { name: "▶ Run" }).click();
  await a.locator(".log.error").waitFor();
  assert.equal(await a.locator(".log.error button.link").textContent({ timeout: 3000 }), "line 3");

  // A runtime error names its line too.
  await code.fill(GAME.replace("g.cls(0);", "g.cls(0); nope();"));
  await a.getByRole("button", { name: "▶ Run" }).click();
  await a.locator(".log.error", { hasText: "nope" }).waitFor();
  assert.equal(await a.locator(".log.error button.link").textContent(), "line 9");

  await code.fill(GAME);
  await a.getByRole("button", { name: "▶ Run" }).click();
  await a.locator(".log.ok").waitFor();
  await a.getByRole("button", { name: "Save", exact: true }).click();
  await a.locator(".save-state", { hasText: "Saved, version 2" }).waitFor();

  // Bob plays Alice's game from the shelf and scores; the score reaches Alice's shelf live.
  const b = pane(B);
  await b.getByRole("button", { name: "Play Test catch" }).click();
  await b.locator("canvas.screen").click();
  await page.keyboard.press("Space");
  await page.waitForTimeout(100);
  await page.keyboard.press("Space");
  await b.locator("ol.scores li", { hasText: "Bob" }).waitFor();
  assert.match(await b.locator("ol.scores li").first().textContent() ?? "", /Bob\s*50/);
  await a.getByRole("button", { name: "← Games" }).click();
  await a.locator("[data-game] .best", { hasText: "Best: 50 by Bob" }).waitFor();
  await shot("scored");
});

test("a stale save is refused, not merged", async () => {
  const a = pane(A), b = pane(B);
  await b.locator(".toolbar").getByRole("button", { name: "Code" }).click(); // Bob opens the code from the play page
  const bCode = b.getByLabel("Code of Test catch");
  await bCode.waitFor();
  await a.getByRole("button", { name: "Edit the code of Test catch" }).click();
  const aCode = a.getByLabel("Code of Test catch");
  await aCode.waitFor();
  await aCode.fill(GAME.replace("+= 25", "+= 30"));
  await bCode.fill(GAME.replace("+= 25", "+= 5"));
  await a.getByRole("button", { name: "Save", exact: true }).click();
  await a.locator(".save-state", { hasText: "Saved, version 3" }).waitFor();
  await b.getByRole("button", { name: "Save", exact: true }).click();
  await b.locator(".toast.error", { hasText: "Alice saved this game" }).waitFor();
  await b.getByRole("button", { name: "Revert" }).click();
  await b.getByRole("button", { name: "Click again to revert" }).click();
  await b.locator(".save-state", { hasText: "version 3" }).waitFor();
  assert.match(await bCode.inputValue(), /\+= 30/);
  await a.getByRole("button", { name: "← Games" }).click();
  await b.getByRole("button", { name: "← Games" }).click();
});

test("compose: edit a tune, see errors, save, and the other player gets it", async () => {
  const a = pane(A), b = pane(B);
  await a.getByRole("button", { name: "Music" }).click();
  await a.getByRole("button", { name: "+ New tune" }).click();
  const title = a.getByLabel("Tune title");
  await title.waitFor();
  await title.fill("E2E ditty");
  const lead = a.getByLabel("Channel 1 notes (MML)");
  await lead.fill("o5 l8 c d e x");
  await a.locator(".mml-errors li", { hasText: 'unexpected "x"' }).waitFor();
  await lead.fill("o5 l8 c d e f ");
  // The piano writes at the cursor: G above middle C from octave 5 needs a "<".
  await lead.focus();
  await lead.press("End");
  await a.getByRole("button", { name: "G4" }).first().dispatchEvent("pointerdown");
  assert.equal(await lead.inputValue(), "o5 l8 c d e f < g8 ");
  await a.getByRole("button", { name: "Save", exact: true }).click();
  await a.locator(".save-state", { hasText: "Saved" }).waitFor();
  await b.getByRole("button", { name: "Music" }).click();
  await b.getByRole("button", { name: /E2E ditty/ }).click();
  assert.equal(await b.getByLabel("Channel 1 notes (MML)").inputValue(), "o5 l8 c d e f < g8 ");
  await shot("music");
});

test("controls: rebinding fire is per player", async () => {
  const a = pane(A), b = pane(B);
  await a.getByRole("button", { name: "Controls" }).click();
  await a.getByRole("radio", { name: /BBC/ }).check();
  await a.getByRole("button", { name: "Change the key for Fire / A" }).click();
  await page.keyboard.press("KeyM");
  await a.locator("table.keys tr", { hasText: "Fire / A" }).locator("td", { hasText: "M (yours)" }).waitFor();
  await b.getByRole("button", { name: "Controls" }).click();
  await b.locator("table.keys tr", { hasText: "Fire / A" }).locator("td", { hasText: "Space or Z" }).waitFor();
  // Alice's M now fires in a game.
  await a.getByRole("button", { name: "Games" }).click();
  await a.getByRole("button", { name: "Play Test catch" }).click();
  await a.locator("canvas.screen").click();
  await page.keyboard.press("KeyM");
  await page.waitForTimeout(80);
  await page.keyboard.press("KeyM");
  await page.waitForTimeout(80);
  await page.keyboard.press("KeyM");
  await a.locator("ol.scores li", { hasText: "Alice" }).waitFor();
  await a.getByRole("button", { name: "← Games" }).click();
});

test("every starter runs in the browser without errors", async () => {
  const a = pane(A);
  for (const title of ["Invaders", "Rocks", "Blocks", "Bricks", "Number Gulper", "Teletext Tables", "Dark Room"]) {
    await a.getByRole("button", { name: `Play ${title}` }).click();
    await a.locator("canvas.screen").click({ timeout: 5000 }).catch(async (e) => { console.log("DBG", title, await a.locator("main").innerText()); throw e; });
    await page.keyboard.press("Space");
    await page.keyboard.press("Enter");
    await page.keyboard.down("ArrowLeft");
    await page.waitForTimeout(400);
    await page.keyboard.up("ArrowLeft");
    assert.equal(await a.locator(".crash").count(), 0, `${title} crashed`);
    await shot(`play-${title}`);
    await a.getByRole("button", { name: "← Games" }).click();
  }
});

test("recovers after the server restarts", async () => {
  await page.getByRole("button", { name: /Restart server/ }).click();
  const a = pane(A);
  // The pane's stub is dead; it reloads itself and carries on.
  await page.waitForTimeout(2500);
  await a.getByRole("heading", { name: "Test catch", exact: true }).waitFor({ timeout: 30_000 });
  await a.getByRole("button", { name: "Play Test catch" }).click();
  await a.locator("ol.scores li", { hasText: "Bob" }).waitFor();
  assert.deepEqual(errors, []);
});
