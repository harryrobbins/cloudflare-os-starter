// Ad-hoc visual pass over the harness: a populated board in light and dark, the card panel,
// a column menu and the colour dialog. Not a test; writes screenshots only.
//   node scripts/build.mjs && node e2e/harness-smoke.mjs [screenshot-dir]
import { mkdir } from "node:fs/promises";
import * as h from "./harness-helpers.mjs";

const shots = process.argv[2] || "/tmp/harness-shots";
await mkdir(shots, { recursive: true });
const server = await h.startHarnessServer({ port: 8791 });
const browser = await h.launch();

/** Seeds a realistic board through the core directly. */
async function seed(page) {
  await page.evaluate(async () => {
    const b = await window.harness.getBoard();
    const [backlog, todo, doing, done] = b.columnOrder;
    const label = (name) => Object.values(b.labels).find((l) => l.name === name).id;
    const hex = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
    const card = (columnId, title, extra = {}) => ({ op: "upsert", cardId: "c_" + hex(), columnId, baseVersion: 0, card: { title, ...extra } });
    const today = new Date();
    const iso = (d) => new Date(today.getTime() + d * 86400000).toISOString().slice(0, 10);
    await window.harness.apply({
      by: "Seeder", structure: { title: "Q4 onboarding" }, cardOps: [
        card(backlog, "Write welcome email template", { labels: [label("Chore")], assignee: "Priya Shah" }),
        card(backlog, "Research payroll providers", { description: "Compare three options", due: iso(9) }),
        card(backlog, "Laptop imaging script fails on M3 machines", { labels: [label("Bug"), label("Urgent")], assignee: "Sam" }),
        card(todo, "Order hardware for new starters", { assignee: "Sam", due: iso(-2), checklist: [{ text: "Laptops", done: true }, { text: "Monitors", done: false }, { text: "Docks", done: false }] }),
        card(todo, "Buddy programme sign-up form", { labels: [label("Feature")] }),
        card(doing, "Update the handbook", { assignee: "Priya Shah", checklist: [{ text: "Leave policy", done: true }, { text: "Expenses", done: true }] }),
        card(done, "Create Slack channels", { labels: [label("Chore")] }),
      ],
    });
  });
}

try {
  for (const scheme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 1800, height: 900 }, colorScheme: scheme });
    const page = await context.newPage();
    await page.goto(h.harnessUrl(server.url, { panes: 2, names: ["Alice Adams", "Bob Brown"] }));
    const A = h.pane(page, "A");
    const B = h.pane(page, "B");
    await h.waitLive(A);
    await h.waitLive(B);
    if (scheme === "light") {
      await A.locator(".me-btn").click();
      await A.locator(".color-dialog").waitFor();
      await page.screenshot({ path: `${shots}/smoke-${scheme}-color-dialog.png` });
      await A.locator(".color-dialog").press("Escape");
      await A.locator(".color-dialog").waitFor({ state: "detached" });
    }
    await seed(page);
    await h.card(B, "Update the handbook").waitFor();
    await h.card(B, "Order hardware for new starters").click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/smoke-${scheme}-board.png` });
    await h.card(A, "Order hardware for new starters").click();
    await A.locator(".panel .comment-input").fill("Monitors are back-ordered until next week.");
    await A.locator(".panel .comment-form .comment-send").click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${shots}/smoke-${scheme}-panel.png` });
    await A.locator(".panel").press("Escape");
    await h.column(A, "To do").locator(".col-menu-btn").click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${shots}/smoke-${scheme}-menu.png`, clip: { x: 0, y: 0, width: 900, height: 450 } });
    await context.close();
  }
} finally {
  await browser.close();
  server.stop();
}
