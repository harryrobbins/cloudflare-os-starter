import assert from "node:assert/strict";
import test, { after } from "node:test";
import { executeCode, gadgetListing, workshopPrompt } from "./blueprint-evals/agent.mjs";
import { loadGadget, MemoryStorage, requireFromBlueprints } from "./blueprint-evals/node-gadget.mjs";
import { runEval } from "./blueprint-evals/run.mjs";

// A counter gadget: the smallest thing with a server, a client that subscribes with an
// RpcTarget, and an adapt block.
const files: Record<string, string> = {
  "server.js": [
    `import { DurableObject } from "cloudflare:workers";`,
    `import { clamp } from "./server.lib.js";`,
    `export class Gadget extends DurableObject {`,
    `  #listeners = [];`,
    `  describeGadget() { return { gadget: "counter", operations: [{ name: "add" }] }; }`,
    `  async get() { return (await this.ctx.storage.get("n")) ?? 0; }`,
    `  async add(by) { const n = clamp((await this.get()) + by); await this.ctx.storage.put("n", n); for (const l of this.#listeners) l.update(n); return n; }`,
    `  async subscribe(listener) { this.#listeners.push(listener); return this.get(); }`,
    `}`,
  ].join("\n"),
  "server.lib.js": `export const clamp = (n) => Math.max(0, Math.min(1000, n));\n`,
  "client.lib.js": `var gadgetLib = { mount(root, adapt) { for (const a of adapt.actions) { const b = document.createElement("button"); b.textContent = a.label; b.onclick = () => a.run(); root.append(b); } } };\n`,
  "client.js": [
    `const adapt = {`,
    `  actions: [],`,
    `};`,
    `const out = document.createElement("output");`,
    `document.body.append(out);`,
    `class Listener extends RpcTarget { update(n) { out.textContent = String(n); } }`,
    `out.textContent = String(await gadget.subscribe(new Listener()));`,
    `gadgetLib.mount(document.body, adapt);`,
  ].join("\n"),
};
const format = { files, info: { binding: "Counter", title: "Counter", noun: "Counter" } };

let browserInstance: any = null;
const browser = async () => (browserInstance ??= await requireFromBlueprints("playwright").chromium.launch({ headless: true }));
after(async () => { await browserInstance?.close(); });

test("MemoryStorage rolls a failed transaction back", async () => {
  const s = new MemoryStorage();
  await s.put("a", 1);
  await assert.rejects(s.transaction(async (t: MemoryStorage) => { await t.put("a", 2); throw new Error("no"); }));
  assert.equal(await s.get("a"), 1);
  await s.put({ b: 2, c: 3 });
  assert.deepEqual([...(await s.list({ prefix: "b" })).keys()], ["b"]);
});

test("loadGadget runs server.js and its library in Node", async () => {
  const { gadget, dispose } = await loadGadget(files);
  try {
    assert.equal(await gadget.add(5), 5);
    assert.equal(await gadget.add(5000), 1000);
  } finally { await dispose(); }
});

test("executeCode accepts a module or a bare body and returns console output", async () => {
  const env = { X: { hi: () => "hello" } };
  assert.match((await executeCode(`export default async function(self, env) { console.log(env.X.hi()); }`, env)).output, /hello/);
  assert.match((await executeCode(`return env.X.hi();`, env)).output, /Return value: "hello"/);
  assert.equal((await executeCode(`throw new Error("boom")`, env)).ok, false);
});

test("the Workshop prompt sections the runner quotes still exist", async () => {
  const { guidance, tools } = await workshopPrompt();
  assert.match(guidance, /## Using or adapting an existing Gadget/);
  assert.match(guidance, /client\.lib\.js/);
  assert.ok(tools.executeCode.length > 100 && tools.editFile.length > 20);
  assert.match(gadgetListing({ ...format.info, files }), /env\.Counter/);
});

test("a use eval's reference runs against the gadget and is checked", async () => {
  const ev = {
    id: "add-seven", kind: "use", prompt: "Add 7.",
    reference: { code: `await env.Counter.add(7);` },
    async check(t: any) { const n = await t.gadget.get(); return n === 7 ? [] : [`expected 7, got ${n}`]; },
  };
  const r = await runEval({ ev, format, llm: null, browser });
  assert.deepEqual(r.problems, []);
});

test("an adapt eval's reference edits client.js and is checked in the real client", async () => {
  const ev = {
    id: "plus-ten-button", kind: "adapt", prompt: "Add a +10 button.",
    reference: { edits: [{ file: "client.js", find: "  actions: [],", replace: `  actions: [{ id: "ten", label: "+10", run: () => gadget.add(10) }],` }] },
    async check(t: any) {
      const page = await t.client();
      await page.getByRole("button", { name: "+10" }).click();
      await page.locator("output").filter({ hasText: "10" }).waitFor({ timeout: 5000 });
      return (await t.gadget.get()) === 10 ? [] : ["the server did not reach 10"];
    },
  };
  const r = await runEval({ ev, format, llm: null, browser });
  assert.deepEqual(r.problems, []);
});

test("an eval that edits a library fails", async () => {
  const ev = {
    id: "bad", kind: "adapt", prompt: "",
    reference: { edits: [{ file: "client.lib.js", find: "var gadgetLib", replace: "var gadgetLib2 = 1; var gadgetLib" }] },
    async check() { return []; },
  };
  const r = await runEval({ ev, format, llm: null, browser });
  assert.match(r.problems.join(), /edited a prebuilt library: client\.lib\.js/);
});
