// Phase 0 spike checks the T0-T15 suite does not cover, run in the REAL sandboxed gadget iframe of
// a local Cloudflare OS (plan section 5.1, items 2 and 3). Prints and writes spikes.json.
//
//   OPENROUTER_API_KEY=... WAVE_ARCHIVE=... node e2e/platform-spikes.mjs   # from packages/blueprint-wave
//
// Env as for platform.test.mjs (CFOS_URL, PLATFORM_SHOTS, WAVE_ARCHIVE, OPENROUTER_API_KEY).
// - paste: real Ctrl+V from the system clipboard into the blip textarea; the other viewer sees it
// - IME: a CDP composition (imeSetComposition, then insertText) while the other viewer types
// - phone: a touch, mobile-viewport context taps Edit, sets a selection and types over it
// - links: the iframe's sandbox flags, and what clicking a rendered Markdown link does

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as p from "./platform-helpers.mjs";
import * as h from "./harness-helpers.mjs";
import * as w from "./platform-wave-helpers.mjs";
import * as m from "./platform-model-helpers.mjs";

const BASE = (process.env.CFOS_URL || p.DEFAULT_BASE_URL).replace(/\/$/, "");
const SHOTS = process.env.PLATFORM_SHOTS || join(tmpdir(), "wave-platform-shots");
const PASSWORD = "correct-horse-battery-staple";
/** @type {Record<string, any>} */
const out = {};

await mkdir(SHOTS, { recursive: true });
const browser = await p.launch();

/** @param {string} username @param {object} [ctxOpts] */
async function openUser(username, ctxOpts = {}) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, ...ctxOpts });
  const page = await context.newPage();
  await p.signUpOrIn(page, BASE, username, PASSWORD);
  return { context, page, frame: p.gadgetFrame(page) };
}

async function step(name, fn) {
  if (process.env.SPIKES && !process.env.SPIKES.split(",").includes(name)) return;
  try {
    out[name] = await fn();
  } catch (err) {
    out[name] = { error: String(/** @type {any} */ (err)?.message ?? err).split("\n")[0] };
  }
  console.log(name, JSON.stringify(out[name]));
}

const owner = await openUser("spikeowner");
await m.addOpenRouterModel(owner.page, BASE, process.env.OPENROUTER_API_KEY ?? "");
const blueprintId = await p.uploadGadget(owner.page, BASE, w.SHIPPED_ARCHIVE);
const { workspaceUrl } = await m.createWithSuggestedModel(owner.page, BASE, blueprintId);
await w.waitLive(owner.frame);
await w.pickTemplateIfOffered(owner.frame, "blank", 5000).catch(() => false);
const shareUrl = await p.createUseShareLink(owner.page);
const peer = await openUser("spikepeer");
await peer.page.goto(shareUrl);
await w.waitLive(peer.frame);
out.workspaceUrl = workspaceUrl;

const root = async (text) => {
  const id = await w.createInFrame(owner.frame, { parentId: null, text });
  await h.card(peer.frame, id).waitFor({ timeout: 15_000 });
  return id;
};

await step("paste", async () => {
  await owner.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const pasted = "Pasted line one\nPasted **two** with ünïcödé and emoji 🎉";
  // The top page is a secure context; the sandboxed iframe's navigator.clipboard is blocked.
  await owner.page.evaluate((t) => navigator.clipboard.writeText(t), pasted);
  const id = await root("Before. ");
  const ed = await h.openEditor(owner.frame, id);
  await ed.focus();
  await ed.press("Control+End");
  await ed.press("Control+V");
  const t0 = Date.now();
  const local = await ed.inputValue();
  const remote = await h.waitForText(peer.frame, id, `Before. ${pasted}`, { timeout: 10_000 }).then(() => true, () => false);
  await owner.page.screenshot({ path: join(SHOTS, "spike-paste.png") });
  await h.closeEditor(owner.frame);
  return { localHasPaste: local.endsWith(pasted), peerSawIt: remote, peerMs: Date.now() - t0 };
});

await step("ime", async () => {
  const id = await root("Rabc");
  const edO = await h.openEditor(owner.frame, id);
  const edP = await h.openEditor(peer.frame, id);
  await edO.focus();
  await edO.press("Control+End");
  const cdp = await owner.context.newCDPSession(owner.page);
  // Compose over several steps while the peer types at the start of the text.
  await cdp.send("Input.imeSetComposition", { text: "k", selectionStart: 1, selectionEnd: 1 });
  await cdp.send("Input.imeSetComposition", { text: "かん", selectionStart: 2, selectionEnd: 2 });
  await edP.focus();
  await edP.press("Control+Home");
  await edP.pressSequentially("XY", { delay: 30 });
  await h.sleep(500);
  await cdp.send("Input.imeSetComposition", { text: "漢", selectionStart: 1, selectionEnd: 1 });
  await cdp.send("Input.insertText", { text: "漢" });
  const want = "XYRabc漢";
  const agreed = await h.until(async () => {
    const [a, b] = await Promise.all([h.readText(owner.frame, id), h.readText(peer.frame, id)]);
    return a === b ? a : null;
  }, { timeout: 10_000, interval: 100, message: "owner and peer agree" }).catch(() => null);
  const caret = await edO.evaluate((el) => /** @type {HTMLTextAreaElement} */ (el).selectionStart);
  await owner.page.screenshot({ path: join(SHOTS, "spike-ime.png") });
  await h.closeEditor(owner.frame);
  await h.closeEditor(peer.frame);
  return { final: agreed, expected: want, correct: agreed === want, ownerCaretAfterCommit: caret, caretAfterKanji: caret === want.length };
});

await step("phone", async () => {
  const phone = await openUser("spikephone", {
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  });
  await phone.page.goto(shareUrl);
  try {
    await w.waitLive(phone.frame, 30_000);
  } catch (err) {
    await phone.page.screenshot({ path: join(SHOTS, "spike-phone-not-live.png") });
    const frames = await phone.page.locator("iframe").evaluateAll((fs) => fs.map((f) => f.getAttribute("title")));
    await phone.context.close();
    return { notLive: String(err).split("\n")[0], iframes: frames, url: phone.page.url() };
  }
  const id = await root("select THIS word");
  const card = h.card(phone.frame, id);
  await card.waitFor({ timeout: 15_000 });
  await card.scrollIntoViewIfNeeded();
  const edit = card.locator(h.SEL.editButton).first();
  // Card actions must be reachable without hover on a touch screen.
  const editVisibleAfterTap = await edit.isVisible();
  const box = await edit.boundingBox().catch(() => null);
  await phone.page.screenshot({ path: join(SHOTS, "spike-phone-before-edit.png") });
  await edit.tap({ timeout: 10_000 });
  const ed = h.editor(phone.frame, id);
  await ed.waitFor({ timeout: 5000 });
  const focused = await ed.evaluate((el) => el === el.ownerDocument.activeElement);
  // Touch selection handles cannot be driven by CDP; set the selection as a long-press would.
  await ed.evaluate((el) => { const t = /** @type {HTMLTextAreaElement} */ (el); t.setSelectionRange(7, 11); t.dispatchEvent(new Event("select")); });
  await ed.pressSequentially("that", { delay: 40 });
  const peerSaw = await h.waitForText(owner.frame, id, "select that word", { timeout: 10_000 }).then(() => true, () => false);
  await phone.page.screenshot({ path: join(SHOTS, "spike-phone.png") });
  await h.closeEditor(phone.frame);
  await phone.context.close();
  return { editVisibleAfterTap, editTarget: box && { w: Math.round(box.width), h: Math.round(box.height) }, editorFocused: focused, ownerSawReplacement: peerSaw };
});

await step("links", async () => {
  const sandbox = await owner.page.locator('iframe[title="Gadget UI"]').first().getAttribute("sandbox");
  const id = await root("See [the docs](https://example.com/wave) and mailto:team@example.com.");
  const link = h.card(owner.frame, id).locator('a[href="https://example.com/wave"]');
  await link.waitFor({ timeout: 10_000 });
  const attrs = await link.evaluate((a) => ({ target: a.getAttribute("target"), rel: a.getAttribute("rel") }));
  const popup = owner.context.waitForEvent("page", { timeout: 5000 }).then((pg) => pg.url(), () => null);
  const consoleLines = [];
  owner.page.on("console", (msg) => consoleLines.push(msg.text()));
  await link.click();
  const opened = await popup;
  await h.sleep(500);
  return {
    sandbox, attrs, popupOpened: opened !== null, popupUrl: opened,
    topPageUrlUnchanged: owner.page.url() === workspaceUrl || owner.page.url().startsWith(workspaceUrl.split("#")[0]),
    blockedConsole: consoleLines.filter((l) => /block|sandbox|popup/i.test(l)).slice(0, 3),
  };
});

await writeFile(join(SHOTS, "spikes.json"), JSON.stringify(out, null, 2));
await browser.close();
