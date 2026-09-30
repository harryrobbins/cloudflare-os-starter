// End-to-end tests against the local harness: the real built client (dist/client.js) in
// side-by-side iframes, over the real Docs server (src/server/index.js) in the parent page.
//
//   node scripts/build.mjs && node --test e2e/harness.test.mjs
//
// Screenshots go to $HARNESS_SHOTS (default: /tmp/docs-harness-shots).

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = process.env.HARNESS_SHOTS || "/tmp/docs-harness-shots";

/** @type {{url: string, stop: () => void}} */
let server;
/** @type {import("playwright").Browser} */
let browser;

function startServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(PKG, "harness/serve.mjs"), "--port", String(port)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const match = /HARNESS_URL (\S+)/.exec(out);
      if (match) resolve({ url: match[1], stop: () => child.kill() });
    });
    child.on("exit", (code) => reject(new Error(`harness server exited ${code}`)));
  });
}

before(async () => {
  await mkdir(SHOTS, { recursive: true });
  server = await startServer(Number(process.env.HARNESS_PORT || 8791));
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  server?.stop();
});

async function openHarness(query = "") {
  const page = await browser.newPage({ viewport: { width: 1800, height: 950 } });
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.goto(`${server.url}?names=Ann,Bob${query}`);
  const panes = [];
  for (const id of ["0", "1"]) {
    const frame = page.frameLocator(`iframe[data-pane="${id}"]`);
    await frame.locator(".doc-page").waitFor();
    await frame.locator(".status").filter({ hasText: "Saved" }).waitFor();
    panes.push({ id, frame, handle: () => page.frame({ url: new RegExp(`pane=${id}`) }) });
  }
  return { page, panes, errors };
}

/** Calls the Gadget in the harness page, as an agent's executeCode would through its stub. */
function serverCall(page, method, ...args) {
  return page.evaluate(([m, a]) => window.harness.server[m](...a), [method, args]);
}

const svgOf = async (img) => {
  const src = await img.getAttribute("src");
  assert.match(src, /^data:image\/svg\+xml;base64,/);
  return Buffer.from(src.split(",")[1], "base64").toString("utf8");
};

async function clientErrors(ctx) {
  const out = [];
  for (const p of ctx.panes) {
    const err = await p.handle()?.evaluate(() => window.clientError ?? null);
    if (err) out.push(`pane ${p.id}: ${err}`);
  }
  return [...ctx.errors, ...out];
}

describe("drawings in a document", () => {
  test("insert a drawing, draw in it, see it live elsewhere, close it cleanly", async () => {
    const ctx = await openHarness();
    const [ann, bob] = ctx.panes;
    await ann.frame.locator(".doc-page").click();
    await ann.frame.locator(".doc-page").pressSequentially("Our deploy pipeline");
    const bodyChildren = await ann.handle().evaluate(() => document.body.children.length);

    await ann.frame.locator('button[title="Insert drawing"]').click();
    await ann.frame.locator(".wb-app").waitFor();
    await ann.frame.locator('.conn[data-state="live"]').waitFor();
    assert.equal(await ann.frame.locator(".app").isVisible(), false, "the document is hidden while drawing");
    await ann.frame.locator(".doc-drawing-back").waitFor();
    await ctx.page.screenshot({ path: join(SHOTS, "01-editor-open.png") });

    // Bob sees the figure appear in his copy of the document.
    await bob.frame.locator("figure.doc-drawing").waitFor();
    const [drawing] = await serverCall(ctx.page, "listDrawings");
    assert.deepEqual(drawing.openBy, ["Ann"]);

    // Ann adds a sticky note through the whiteboard's own Add menu.
    await ann.frame.locator(".wb-toolbar .add-btn").click();
    await ann.frame.locator(".menu .add-sticky").click();
    await ann.frame.locator(".wb-obj").first().waitFor();

    // An agent adds content to the same drawing while Ann has it open.
    await serverCall(ctx.page, "drawing", drawing.id, "addStickies", { stickies: ["Deploy the router last"], by: "Assistant" });
    await ann.frame.locator(".wb-obj").nth(1).waitFor();

    // Bob's preview catches up with both changes.
    const bobImg = bob.frame.locator("figure.doc-drawing img.doc-drawing-img");
    await bobImg.waitFor();
    let svg = "";
    for (let i = 0; i < 50 && !svg.includes("Deploy the router"); i++) {
      svg = await svgOf(bobImg);
      if (!svg.includes("Deploy the router")) await ctx.page.waitForTimeout(200);
    }
    assert.match(svg, /Deploy the router/);

    // Back to the document: the whiteboard leaves no trace on the page.
    await ann.frame.locator(".doc-drawing-back").click();
    await ann.frame.locator(".app").waitFor({ state: "visible" });
    assert.equal(await ann.frame.locator(".wb-app").count(), 0);
    assert.equal(await ann.handle().evaluate(() => document.getElementById("wb-styles")), null);
    assert.equal(await ann.handle().evaluate(() => document.body.children.length), bodyChildren,
      "the editor host and every panel the whiteboard added to <body> are gone");
    assert.deepEqual((await serverCall(ctx.page, "listDrawings"))[0].openBy, []);
    await ann.frame.locator("figure.doc-drawing img.doc-drawing-img").waitFor();
    await ctx.page.screenshot({ path: join(SHOTS, "02-back-in-document.png") });

    // The document stores only the bare figure, never the preview or buttons.
    const doc = await serverCall(ctx.page, "getDocument");
    const figure = doc.blocks.find((b) => b.html.includes("doc-drawing"));
    assert.match(figure.html, new RegExp(`^<figure[^>]*data-drawing-id="${drawing.id}"[^>]*></figure>$`));
    assert.doesNotMatch(figure.html, /doc-drawing-ui|<img|button/);
    assert.ok(doc.blocks.some((b) => b.html.includes("Our deploy pipeline")));
    assert.deepEqual(await clientErrors(ctx), []);
    await ctx.page.close();
  });

  test("an agent inserts a drawing into an open document; two people co-edit it", async () => {
    const ctx = await openHarness();
    const [ann, bob] = ctx.panes;
    const created = await serverCall(ctx.page, "createDrawing", { title: "Architecture" });
    await serverCall(ctx.page, "drawing", created.id, "addStickies", { stickies: ["Router", "Workshop"] });
    for (const p of [ann, bob]) {
      await p.frame.locator(`figure[data-drawing-id="${created.id}"] .doc-drawing-title`).filter({ hasText: "Architecture" }).waitFor();
    }
    await ann.frame.locator(`figure[data-drawing-id="${created.id}"] .doc-drawing-open`).click();
    await bob.frame.locator(`figure[data-drawing-id="${created.id}"] .doc-drawing-open`).click();
    for (const p of [ann, bob]) {
      await p.frame.locator('.conn[data-state="live"]').waitFor();
      await p.frame.locator(".wb-obj").nth(1).waitFor();
    }
    const openBy = (await serverCall(ctx.page, "listDrawings"))[0].openBy.sort();
    assert.deepEqual(openBy, ["Ann", "Bob"]);
    // Ann adds a sticky; Bob's open editor shows it.
    await ann.frame.locator(".wb-toolbar .add-btn").click();
    await ann.frame.locator(".menu .add-sticky").click();
    await bob.frame.locator(".wb-obj").nth(2).waitFor();
    await ctx.page.screenshot({ path: join(SHOTS, "03-two-editors.png") });
    for (const p of [ann, bob]) await p.frame.locator(".doc-drawing-back").click();
    assert.deepEqual(await clientErrors(ctx), []);
    await ctx.page.close();
  });

  test("the HTML export shows each drawing's preview and no editing controls", async () => {
    const ctx = await openHarness();
    const created = await serverCall(ctx.page, "createDrawing", { title: "Exported" });
    await serverCall(ctx.page, "drawing", created.id, "addStickies", { stickies: ["In the export"] });
    await ctx.page.evaluate(() => window.harness.addExportPane("html"));
    const exported = ctx.page.frameLocator('iframe[data-pane="2"]');
    const img = exported.locator("figure.doc-drawing img.doc-drawing-img");
    await img.waitFor();
    assert.match(await svgOf(img), /In the export/);
    assert.equal(await exported.locator(".doc-drawing-open").count(), 0);
    await ctx.page.close();
  });
});
