// Development helper: build, open the harness, screenshot the main screens and interactive
// states, and print any errors. Not part of the test suite.
//
//   node e2e/shots.mjs [--seed 300] [--dark] [--width 1440] [--height 900] [--name base] [--v1]
//                      [--steps lanes,list,detail,ui]

import { startHarness, screenshot, problems, appState } from "./helpers.mjs";

const arg = (/** @type {string} */ name, /** @type {string} */ dflt) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? dflt : process.argv[i + 1]; };
const flag = (/** @type {string} */ name) => process.argv.includes(`--${name}`);
const h = await startHarness({ port: Number(arg("port", "8798")) });
try {
  const width = Number(arg("width", "1440")), height = Number(arg("height", "900"));
  const steps = arg("steps", "");
  const { page, frame, errors } = await h.open({ seed: Number(arg("seed", "300")), colorScheme: flag("dark") ? "dark" : "light", viewport: { width, height }, v1: flag("v1"), approval: steps.includes("ui") ? "manual" : "auto" });
  const name = arg("name", `dev-${width}${flag("dark") ? "-dark" : ""}`);
  const shot = async (/** @type {string} */ what) => console.log(`${what}:`, await screenshot(page, `${name}-${what}`));
  const app = (/** @type {string} */ fn) => frame.evaluate(`(${fn})(globalThis.workBoard.app, globalThis.workBoard.store)`);
  await shot("board");
  if (steps.includes("lanes")) {
    await app("(a) => a.loadView({ ...a.view, id: null, name: 'Lanes', swimlanesBy: 'assignee', query: 'cycle:current' })");
    await shot("lanes");
    await app("(a) => a.loadView({ ...a.view, id: null, name: 'All items', swimlanesBy: null, query: '' })");
  }
  if (steps.includes("ui")) {
    await frame.locator(".board-scroll").focus();
    await page.keyboard.press("c");
    await page.keyboard.type("Polish the onboarding emails #design @me !high ^current");
    await shot("create");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("ArrowRight");
    await shot("move-mode");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    await shot("pending");
    await frame.locator(".status-btn").click();
    await shot("status");
    await frame.locator(".status-btn").click();
    await frame.locator(".board-scroll").focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("x");
    await page.keyboard.press("j");
    await page.keyboard.press("x");
    await page.keyboard.press("p");
    await page.waitForTimeout(100);
    await shot("bulk-priority");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.keyboard.press("m");
    await page.waitForTimeout(100);
    await shot("move-menu");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    await page.keyboard.type("assign");
    await shot("palette");
    await page.keyboard.press("Escape");
    await frame.locator(".board-scroll").focus();
    await page.keyboard.press("/");
    await page.keyboard.type("prority:high la");
    await page.waitForTimeout(300);
    await shot("filter-error");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await app("(a) => a.runAction('settings')");
    await frame.locator("#wb-tab-states").click();
    await shot("settings");
    await page.keyboard.press("Escape");
    await app("(a) => a.runAction('help')");
    await shot("shortcuts");
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.harness.approveAll());
    await app("(a, s) => s.pull()");
    await page.waitForTimeout(100);
    await shot("approved");
  }
  if (steps.includes("list")) {
    await app("(a) => a.setLayout('list')");
    await shot("list");
  }
  if (steps.includes("detail")) {
    await app("(a, s) => a.openDetail(s.index().itemList.find((i) => (s.index().children.get(i.id)?.length ?? 0) > 2 && i.description), { focus: true })");
    await page.waitForTimeout(300);
    await shot("detail");
    await frame.locator(".detail-scroll").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await shot("detail-activity");
  }
  console.log(JSON.stringify(await appState(frame)).slice(0, 300));
  console.log(JSON.stringify(await problems(page, errors), null, 1).slice(0, 3000));
} finally {
  await h.close();
}
