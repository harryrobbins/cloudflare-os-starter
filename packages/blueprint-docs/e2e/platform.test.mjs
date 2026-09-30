// Docs with Drawings against a REAL local Cloudflare OS Workshop: the packed format in the real
// sandboxed gadget iframe, over Cap'n Web RPC, with two accounts.
//
//   ../blueprint-whiteboard/e2e/start-local-platform.sh           # once; prints PGID + URL
//   pnpm --filter blueprint-docs pack:gadget                        # from the repo root
//   node --test --test-concurrency=1 e2e/platform.test.mjs          # from packages/blueprint-docs
//   ../blueprint-whiteboard/e2e/stop-local-platform.sh
//
// Env: CFOS_URL (default http://localhost:8787); PLATFORM_SHOTS (default /tmp/docs-platform-shots).

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "../../blueprint-whiteboard/e2e/platform-helpers.mjs";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARCHIVE = join(PKG, "../../formats/docs-drawings.gadget");
const BASE = (process.env.CFOS_URL || p.DEFAULT_BASE_URL).replace(/\/$/, "");
const SHOTS = process.env.PLATFORM_SHOTS || "/tmp/docs-platform-shots";
const PASSWORD = "correct-horse-battery-staple";

/** @type {import("playwright").Browser} */
let browser;
const problems = [];

async function openUser(name) {
  const { context, page } = await p.newUserPage(browser);
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error" && /Blocked form submission|does not implement|drawing|Uncaught/i.test(text)) {
      problems.push(`${name}: ${text}`);
    }
  });
  page.on("pageerror", (err) => problems.push(`${name} pageerror: ${err.message}`));
  await p.signUpOrIn(page, BASE, name, PASSWORD);
  return { context, page, frame: () => p.gadgetFrame(page) };
}

const svgOf = async (img) => {
  const src = await img.getAttribute("src");
  assert.match(src, /^data:image\/svg\+xml;base64,/);
  return Buffer.from(src.split(",")[1], "base64").toString("utf8");
};

async function eventually(fn, timeout = 20_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw last ?? new Error("timed out");
}

before(async () => {
  await mkdir(SHOTS, { recursive: true });
  browser = await p.launch();
});

after(async () => {
  await browser?.close();
});

describe("Docs with Drawings on the local platform", () => {
  test("insert, draw, share, co-edit and export", { timeout: 300_000 }, async () => {
    const alice = await openUser("alice");
    const blueprintId = await p.uploadGadget(alice.page, BASE, ARCHIVE);
    const workspaceUrl = await p.createGadgetFromBlueprint(alice.page, BASE, blueprintId);
    const a = alice.frame();
    await a.locator(".doc-page").waitFor({ timeout: 60_000 });
    await a.locator(".status").filter({ hasText: "Saved" }).waitFor({ timeout: 30_000 });
    await a.locator(".doc-page").click();
    await a.locator(".doc-page").pressSequentially("Architecture notes");

    // Insert a drawing: the whiteboard editor opens over the document, live.
    await a.locator('button[title="Insert drawing"]').click();
    await a.locator('.wb-app .conn[data-state="live"]').waitFor({ timeout: 30_000 });
    await a.locator(".wb-toolbar .add-btn").click();
    await a.locator(".menu .add-sticky").click();
    await a.locator(".wb-obj").first().waitFor();
    await alice.page.screenshot({ path: join(SHOTS, "01-alice-drawing.png") });
    await a.locator(".doc-drawing-back").click();
    const aliceImg = a.locator("figure.doc-drawing img.doc-drawing-img");
    await aliceImg.waitFor({ timeout: 30_000 });
    await eventually(async () => /data-type="sticky"/.test(await svgOf(aliceImg)));
    await alice.page.screenshot({ path: join(SHOTS, "02-alice-document.png") });

    // Bob joins through a use-role share link and sees the drawing in the document.
    const shareUrl = await p.createUseShareLink(alice.page);
    const bob = await openUser("bob");
    await bob.page.goto(shareUrl);
    const b = bob.frame();
    const bobImg = b.locator("figure.doc-drawing img.doc-drawing-img");
    await bobImg.waitFor({ timeout: 60_000 });
    assert.match(await svgOf(bobImg), /data-type="sticky"/);
    await b.locator(".doc-page").filter({ hasText: "Architecture notes" }).waitFor();

    // Both open the drawing; a note Alice adds appears in Bob's editor.
    await a.locator("figure.doc-drawing .doc-drawing-open").click();
    await b.locator("figure.doc-drawing .doc-drawing-open").click();
    for (const f of [a, b]) await f.locator('.wb-app .conn[data-state="live"]').waitFor({ timeout: 30_000 });
    await a.locator(".wb-toolbar .add-btn").click();
    await a.locator(".menu .add-sticky").click();
    await b.locator(".wb-obj").nth(1).waitFor({ timeout: 20_000 });
    await bob.page.screenshot({ path: join(SHOTS, "03-bob-co-editing.png") });
    for (const f of [a, b]) await f.locator(".doc-drawing-back").click();
    await eventually(async () => ((await svgOf(bobImg)).match(/data-type="sticky"/g) ?? []).length === 2);

    // Markdown export carries the drawing as an SVG image.
    await alice.page.goto(workspaceUrl);
    await p.gadgetFrame(alice.page).locator("figure.doc-drawing img.doc-drawing-img").waitFor({ timeout: 60_000 });
    const { text: markdown } = await p.downloadExport(alice.page, /^Markdown$/);
    assert.match(markdown, /Architecture notes/);
    assert.match(markdown, /!\[Untitled drawing\]\(data:image\/svg\+xml;base64,/);

    assert.deepEqual(problems, []);
    await alice.context.close();
    await bob.context.close();
  });
});
