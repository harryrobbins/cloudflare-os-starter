// Development helper: build, open the harness, take screenshots of the main screens and print
// any errors. Not part of the test suite.
//
//   node e2e/shots.mjs [--seed 300] [--dark] [--width 1440] [--height 900] [--name base] [--v1]

import { startHarness, screenshot, problems, appState } from "./helpers.mjs";

const arg = (/** @type {string} */ name, /** @type {string} */ dflt) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? dflt : process.argv[i + 1]; };
const flag = (/** @type {string} */ name) => process.argv.includes(`--${name}`);
const h = await startHarness({ port: Number(arg("port", "8798")) });
try {
  const width = Number(arg("width", "1440")), height = Number(arg("height", "900"));
  const { page, frame, errors } = await h.open({ seed: Number(arg("seed", "300")), colorScheme: flag("dark") ? "dark" : "light", viewport: { width, height }, v1: flag("v1") });
  const name = arg("name", `dev-${width}${flag("dark") ? "-dark" : ""}`);
  console.log("board:", await screenshot(page, `${name}-board`));
  const steps = arg("steps", "");
  if (steps.includes("lanes")) {
    await frame.evaluate(() => { const a = globalThis.workBoard.app; a.loadView({ ...a.view, id: null, name: "Lanes", swimlanesBy: "assignee" }); });
    await page.waitForTimeout(200);
    console.log("lanes:", await screenshot(page, `${name}-lanes`));
  }
  if (steps.includes("list")) {
    await frame.evaluate(() => globalThis.workBoard.app.setLayout("list"));
    await page.waitForTimeout(200);
    console.log("list:", await screenshot(page, `${name}-list`));
  }
  if (steps.includes("detail")) {
    await frame.evaluate(() => { const s = globalThis.workBoard.store; const it = s.index().itemList.find((i) => (s.index().children.get(i.id)?.length ?? 0) > 2); globalThis.workBoard.app.openDetail(it, { focus: true }); });
    await page.waitForTimeout(300);
    console.log("detail:", await screenshot(page, `${name}-detail`));
  }
  console.log(JSON.stringify(await appState(frame)).slice(0, 400));
  console.log(JSON.stringify(await problems(page, errors), null, 1).slice(0, 3000));
} finally {
  await h.close();
}
