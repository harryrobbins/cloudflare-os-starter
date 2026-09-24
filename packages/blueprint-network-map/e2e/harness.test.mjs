// Harness e2e for sync, collaboration and recovery (node --test). The gadget runs in sandboxed
// frames under the platform CSP; the parent page runs the real core, changesets and hub.
//
//   node --test --test-concurrency=1 e2e/harness.test.mjs
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appState, problems, reacquire, settled, startHarness, until } from "./helpers.mjs";

let h;
before(async () => { h = await startHarness({ port: 8801 }); });
after(async () => { await h?.close(); });

/** Applies ops through the pane's store (the same path the UI uses). */
const apply = (frame, ops, extra) => frame.evaluate(([o, x]) => globalThis.networkMap.store.apply(o, x), [ops, extra]);
const hex = (n) => n.toString(16).padStart(12, "0");

describe("loading", () => {
  it("opens the demo under the platform CSP with no errors", async () => {
    const { page, frames } = await h.open();
    const s = await appState(frames[0]);
    assert.equal(s.nodes, 16);
    assert.equal(s.edges, 22);
    assert.equal(s.connection, "live");
    const text = await frames[0].evaluate(() => document.body.innerText);
    assert.match(text, /This is a demo map/);
    assert.deepEqual(await problems(page), { violations: [], errors: [] });
  });

  it("falls back to the list when WebGL is unavailable, and still saves", async () => {
    const { page } = await h.open({ fresh: true });
    await page.goto(`${h.url}?panes=1&nowebgl=1`);
    await page.waitForFunction(() => window.harness?.ready);
    const frame = await reacquire(page, 0);
    await frame.waitForFunction(() => globalThis.networkMap.app.mode === "list");
    await apply(frame, [{ op: "create", object: { id: "e_" + hex(0xa1), label: "Still works" } }]);
    await settled(frame);
    const stored = await page.evaluate(async () => (await window.harness.map.findElements({ text: "Still works" })).length);
    assert.equal(stored, 1);
    const text = await frame.evaluate(() => document.body.innerText);
    assert.match(text, /shown as a list/);
  });
});

describe("collaboration", () => {
  it("propagates edits and presence between panes", async () => {
    const { frames } = await h.open({ panes: 2 });
    const [a, b] = frames;
    await apply(a, [{ op: "create", object: { id: "e_" + hex(0xb1), label: "From A" } }]);
    await until(b, (s) => s.objects.some((o) => o.label === "From A"));
    await a.evaluate(() => globalThis.networkMap.app.select(["e_" + (0xb1).toString(16).padStart(12, "0")]));
    const seen = await until(b, (s) => s.peers.some((p) => p.selection?.length === 1));
    assert.equal(seen.peers[0].name, "Ada Lovelace");
  });

  it("rebases concurrent edits: different fields both apply; the same field keeps theirs and offers mine", async () => {
    const { page, frames } = await h.open({ panes: 2, latency: 120 });
    const [a, b] = frames;
    const id = "e_000000000001"; // demo "Local farms"
    // Both edit from the same version before either request lands.
    await Promise.all([
      a.evaluate((x) => globalThis.networkMap.store.apply([{ op: "update", id: x, patch: { description: "A's description", label: "Farms (A)" } }]), id),
      b.evaluate((x) => globalThis.networkMap.store.apply([{ op: "update", id: x, patch: { label: "Farms (B)", tags: ["b"] } }]), id),
    ]);
    await settled(a); await settled(b);
    const stored = await page.evaluate((x) => window.harness.map.getMap().then((m) => m.objects.find((o) => o.id === x)), id);
    assert.equal(stored.description, "A's description");
    assert.deepEqual(stored.tags, ["b"]);
    assert.ok(["Farms (A)", "Farms (B)"].includes(stored.label));
    // The loser saw a conflict notice with "Use mine".
    const loser = stored.label === "Farms (A)" ? b : a;
    await loser.waitForSelector(".toast >> text=Use mine", { timeout: 5000 });
    await loser.click(".toast >> text=Use mine");
    await settled(loser);
    const after = await page.evaluate((x) => window.harness.map.getMap().then((m) => m.objects.find((o) => o.id === x)), id);
    assert.notEqual(after.label, stored.label);
  });

  it("quick add creates elements and connections, reusing names", async () => {
    const { frames } = await h.open();
    const [a] = frames;
    await a.fill(".nm-quickadd input", "Local farms -> Alpha, Beta; Alpha <-> Beta; Beta -[feeds]-> Gamma");
    await a.press(".nm-quickadd input", "Enter");
    await settled(a);
    const s = await appState(a);
    const byLabel = new Map(s.objects.filter((o) => o.id[0] === "e").map((o) => [o.label, o]));
    for (const l of ["Alpha", "Beta", "Gamma"]) assert.ok(byLabel.has(l), l);
    assert.equal(s.objects.filter((o) => o.label === "Local farms").length, 1);
    const feeds = s.objects.find((o) => o.id[0] === "c" && o.label === "feeds");
    assert.equal(feeds.from, byLabel.get("Beta").id);
    assert.ok(s.objects.some((o) => o.id[0] === "c" && o.direction === "mutual"));
  });

  it("deletes with cascade from the keyboard and undoes it", async () => {
    const { page, frames } = await h.open();
    const [a] = frames;
    await a.evaluate(() => globalThis.networkMap.app.select(["e_000000000001"]));
    await a.focus(".nm-canvas");
    await page.keyboard.press("Delete");
    await settled(a);
    let s = await appState(a);
    assert.equal(s.objects.filter((o) => o.id[0] === "c").length, 22 - 6);
    assert.equal(s.objects.filter((o) => o.id[0] === "l").length, 0);
    await page.keyboard.press("Control+z");
    s = await until(a, (x) => x.objects.filter((o) => o.id[0] === "c").length === 22);
    assert.equal(s.objects.filter((o) => o.id[0] === "l").length, 2);
  });

  it("commits a layout that the other pane receives", async () => {
    const { page, frames } = await h.open({ panes: 2 });
    const [a, b] = frames;
    await a.evaluate(() => globalThis.networkMap.app.runLayout("grid"));
    await settled(a);
    const pos = (f) => f.evaluate(() => { const m = globalThis.networkMap.store.positions.get("shared"); return [...m].map(([id, p]) => [id, p.x, p.y]).sort(); });
    const pa = await pos(a);
    const pb = await until(b, () => true).then(() => pos(b));
    assert.deepEqual(pb, pa);
    assert.deepEqual(await problems(page), { violations: [], errors: [] });
  });
});

describe("recovery", () => {
  it("reloads itself after a facet restart when nothing is unsaved", async () => {
    const { page } = await h.open();
    await page.evaluate(() => window.harness.restartFacet());
    // The next heartbeat or call fails; with nothing pending the frame reloads and reconnects.
    const frame = await (async () => {
      for (let i = 0; i < 60; i++) {
        const gen = await page.evaluate(() => document.querySelector('#panes iframe[data-pane="0"]').dataset.generation);
        const handshakes = await page.evaluate(() => window.harness.handshakes);
        if (handshakes > 1) return reacquire(page, 0);
        void gen;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error("no reload");
    })();
    await settled(frame);
    await apply(frame, [{ op: "create", object: { id: "e_" + hex(0xc1), label: "After restart" } }]);
    await settled(frame);
    assert.equal(await page.evaluate(async () => (await window.harness.map.findElements({ text: "After restart" })).length), 1);
  });

  it("holds unsaved changes on the recovery screen instead of reloading", async () => {
    const { page, frames } = await h.open();
    const [a] = frames;
    await page.evaluate(() => window.harness.restartFacet());
    await apply(a, [{ op: "create", object: { id: "e_" + hex(0xd1), label: "Unsaved" } }]);
    await a.waitForSelector("text=Connection lost", { timeout: 30000 });
    const text = await a.evaluate(() => document.body.innerText);
    assert.match(text, /1 unsaved change/);
    const data = await a.evaluate(() => globalThis.networkMap.store.getRecoveryData());
    assert.equal(data.ops[0].object.label, "Unsaved");
  });
});
