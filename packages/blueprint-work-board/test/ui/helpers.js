// Mounting the real app in jsdom over the real gadget server (src/server/api.js) whose RECORDS
// binding is the FakeRecords datastore, with Ada signed in.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createBoardApp } from "../../src/client/ui/app.js";
import { createGadgetApi } from "../../src/server/api.js";
import { memoryStorage } from "../../src/server/documents.js";
import { FakeRecords } from "../fake-records.js";
import { seedWork } from "../../harness/seed.js";

export const NOW = Date.parse("2026-09-26T12:00:00Z");
export const ADA = { id: "ada@example.com", displayName: "Ada Lovelace", role: "build" };

/** @type {any[]} */
const mounted = [];

/**
 * @param {{ seed?: number, planning?: boolean, approval?: "auto"|"manual", access?: "read"|"write", viewer?: any,
 *   records?: (fake: FakeRecords) => void, storage?: any, jevSession?: any }} [o]
 */
export async function mount(o = {}) {
  const fake = new FakeRecords({ planning: o.planning ?? true, approval: o.approval ?? "auto", access: o.access ?? "write", now: () => NOW });
  if (o.seed) seedWork(fake, { items: o.seed, now: NOW });
  o.records?.(fake);
  const storage = o.storage ?? memoryStorage();
  const api = createGadgetApi({ getEnv: () => ({ RECORDS: fake.session(), ...(o.jevSession ? { JEV: o.jevSession } : {}) }), storage, now: () => NOW });
  const viewer = o.viewer === undefined ? ADA : o.viewer;
  const gadget = { ...api, $createViewerAssertion: async (binding, digest) => fake.createViewerAssertion(viewer?.id, binding, digest) };
  document.head.replaceChildren();
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  let uuid = 0;
  const app = createBoardApp({
    gadget, root, viewer, now: () => NOW, persist: null,
    randomUUID: () => `00000000-0000-4000-8000-${(0xabc000000000 + ++uuid).toString(16)}`,
    timers: { visibleMs: 60_000, hiddenMs: 60_000, outcomeMs: 5, historyMs: 5 },
  });
  mounted.push(app);
  await app.ready;
  await settle();
  return { app, fake, root, api, storage, store: app.store };
}

export function unmountAll() {
  for (const a of mounted.splice(0)) a.destroy();
  document.body.replaceChildren();
}

/** Lets microtasks and short timers run. */
export async function settle(ms = 0) {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, ms));
}

/** @param {() => any} check */
export async function until(check, { timeout = 2000, message = "condition" } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try { last = await check(); if (last) return last; } catch (e) { last = e; }
    if (Date.now() > end) throw new Error(`Timed out waiting for ${message}: ${last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** @param {Element} el @param {string} key @param {Record<string, any>} [extra] */
export function key(el, k, extra = {}) {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra }));
}

export const text = (/** @type {Element} */ el) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
/** @param {Element} root @param {string} name */
export const button = (root, name) => /** @type {HTMLButtonElement|undefined} */ ([...root.querySelectorAll("button")].find((b) => text(b) === name || b.getAttribute("aria-label") === name));
/** Card titles in a column (single-lane board). @param {Element} root @param {string} col */
export const titles = (root, col) => [...root.querySelectorAll(`ul.cell[data-col="${col}"] article.card:not(.ghost) .card-title`)].map((e) => e.textContent);

/** A work item by number from the fake. @param {FakeRecords} fake @param {number} n */
export const row = (fake, n) => [...fake.rows.values()].find((r) => r.entity === "work_item" && r.data.number === n);

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
/** Runs axe-core in jsdom; returns serious/critical violations (colour contrast needs layout, so it is left to the browser e2e). */
export async function axe(root = document.body) {
  if (!(/** @type {any} */ (window).axe)) window.eval(AXE);
  const result = await /** @type {any} */ (window).axe.run(root, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } }, resultTypes: ["violations"] });
  return result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => ({ id: v.id, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.html.slice(0, 160)) }));
}
