// Multi-user end-to-end tests against the local harness: the real built client (dist/client.js)
// in side-by-side iframes, over the real whiteboard core (src/core) in the parent page.
//
//   node scripts/build.mjs && node --test e2e/harness.test.mjs
//
// Screenshots go to $HARNESS_SHOTS (default: /tmp/harness-shots). Numbered tests follow the
// "Tests" list in docs/plans/whiteboard-blueprint.md.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import * as h from "./harness-helpers.mjs";

const { SEL } = h;
const SHOTS = process.env.HARNESS_SHOTS || "/tmp/harness-shots";

/** @type {Awaited<ReturnType<typeof h.startHarnessServer>>} */
let server;
/** @type {import("playwright").Browser} */
let browser;

before(async () => {
  await mkdir(SHOTS, { recursive: true });
  server = await h.startHarnessServer({ port: Number(process.env.HARNESS_PORT || 8790) });
  browser = await h.launch();
});

after(async () => {
  await browser?.close();
  server?.stop();
});

/**
 * Opens a fresh harness (fresh in-page server) and closes it after `fn`.
 * @param {Parameters<typeof h.openHarness>[2]} opts
 * @param {(ctx: Awaited<ReturnType<typeof h.openHarness>>) => Promise<void>} fn
 */
async function withHarness(opts, fn) {
  const ctx = await h.openHarness(browser, server.url, opts);
  try {
    await fn(ctx);
    assert.deepEqual(ctx.errors.filter((e) => !/favicon/.test(e)), [], "no console errors");
  } catch (err) {
    await ctx.page.screenshot({ path: `${SHOTS}/failure-${Date.now()}.png` }).catch(() => {});
    if (ctx.errors.length) console.log("# console errors:", ctx.errors.slice(0, 10));
    throw err;
  } finally {
    await ctx.context.close();
  }
}

/** @param {import("playwright").FrameLocator} frame @param {string} id */
function paneObject(frame, id) {
  return h.inPane(frame, (store, _, oid) => store.getState().board.objects[oid] ?? null, id);
}

/** Both panes at the same known camera. */
async function alignCameras(frames) {
  for (const f of Object.values(frames)) await h.setCamera(f, { x: 0, y: 0, zoom: 1 });
}

/** Waits until every pane (and optionally the server) has `id`, and returns the server copy. */
async function waitObject(page, frames, id) {
  for (const f of Object.values(frames)) await f.locator(SEL.object(id)).waitFor({ timeout: 5000 });
  return (await h.serverBoard(page)).objects[id];
}

describe("whiteboard harness", { concurrency: false }, () => {
  test("1. ghost drag: B sees a ghost move before release, then the committed position", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames }) => {
      const { A, B } = frames;
      await alignCameras(frames);
      const [id] = await h.createObjects(page, [{ type: "sticky", x: 300, y: 250, text: "Drag me" }]);
      const before = await waitObject(page, frames, id);
      const start = await h.objectCenter(A, id);
      /** @type {number[]} */
      const ghostXs = [];
      await h.dragBy(page, start, 240, 60, {
        steps: 24, stepDelay: 25,
        hold: async () => {
          const ghost = B.locator(SEL.ghost(id)).first();
          await ghost.waitFor({ timeout: 3000 });
          ghostXs.push((await ghost.boundingBox()).x);
          await page.mouse.move(start.x + 280, start.y + 80, { steps: 4 });
          await h.until(async () => {
            const b = await B.locator(SEL.ghost(id)).first().boundingBox();
            return b && b.x > ghostXs[0] + 20 && ghostXs.push(b.x);
          }, { timeout: 3000, message: "ghost moves in B" });
          // Nothing committed yet.
          assert.equal((await h.serverBoard(page)).objects[id].x, before.x, "no commit before release");
          await page.screenshot({ path: `${SHOTS}/01-ghost.png` });
        },
      });
      const after = await h.until(async () => {
        const o = (await h.serverBoard(page)).objects[id];
        return o.x !== before.x && o;
      }, { message: "commit after release" });
      assert.ok(Math.abs(after.x - (before.x + 280)) <= 2, `x moved by the drag: ${after.x}`);
      assert.ok(Math.abs(after.y - (before.y + 80)) <= 2, `y moved by the drag: ${after.y}`);
      await h.until(async () => (await paneObject(B, id))?.x === after.x, { message: "B has the committed x" });
      await B.locator(SEL.anyGhost).waitFor({ state: "detached", timeout: 3000 });
      const boxB = await B.locator(SEL.object(id)).boundingBox();
      const boxA = await A.locator(SEL.object(id)).boundingBox();
      const paneB = await page.locator('iframe[data-pane="B"]').boundingBox();
      const paneA = await page.locator('iframe[data-pane="A"]').boundingBox();
      assert.ok(Math.abs((boxB.x - paneB.x) - (boxA.x - paneA.x)) < 3, "B draws it where A does");
    });
  });

  test("2. live stroke: B sees the pen stroke grow before release, then a committed pen object", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames }) => {
      const { A, B } = frames;
      await alignCameras(frames);
      await A.locator(SEL.tool("pen")).click();
      const from = await h.panePoint(page, "A", 400, 300);
      /** @type {number[]} */
      const lengths = [];
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (let i = 1; i <= 15; i++) {
        await page.mouse.move(from.x + i * 12, from.y + Math.sin(i / 2) * 30);
        await page.waitForTimeout(20);
      }
      const stroke = B.locator(SEL.remoteStroke).first();
      await stroke.waitFor({ timeout: 3000 });
      lengths.push((await stroke.getAttribute("d")).length);
      for (let i = 16; i <= 40; i++) {
        await page.mouse.move(from.x + i * 12, from.y + Math.sin(i / 2) * 30);
        await page.waitForTimeout(20);
      }
      await h.until(async () => {
        const d = await B.locator(SEL.remoteStroke).first().getAttribute("d");
        return d && d.length > lengths[0] && lengths.push(d.length);
      }, { timeout: 3000, message: "B's live stroke grows" });
      assert.equal(Object.keys((await h.serverBoard(page)).objects).length, 0, "nothing committed while drawing");
      await page.screenshot({ path: `${SHOTS}/02-live-stroke.png` });
      await page.mouse.up();
      const pen = await h.until(async () => Object.values((await h.serverBoard(page)).objects).find((o) => o.type === "pen"),
        { message: "pen committed" });
      assert.ok(pen.points.length >= 4);
      await B.locator(SEL.object(pen.id)).waitFor({ timeout: 3000 });
      await B.locator(SEL.remoteStroke).waitFor({ state: "detached", timeout: 3000 });
    });
  });

  test("3. concurrent moves of the same sticky (with latency): both deltas are applied", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames }) => {
      const { A, B } = frames;
      await alignCameras(frames);
      const [id] = await h.createObjects(page, [{ type: "sticky", x: 300, y: 250, text: "Shared" }]);
      const before = await waitObject(page, frames, id);
      const a = await h.objectCenter(A, id);
      const b = await h.objectCenter(B, id);
      await page.evaluate(() => window.harness.setLatency(400));
      await h.dragBy(page, a, 100, 0, { steps: 6 });
      await h.dragBy(page, b, 60, 0, { steps: 6 });
      await page.evaluate(() => window.harness.setLatency(0));
      const want = before.x + 160;
      await h.until(async () => (await h.serverBoard(page)).objects[id].x === want,
        { timeout: 10_000, message: `server x = ${want}` }).catch(async (e) => {
        throw new Error(e.message + " server: " + JSON.stringify((await h.serverBoard(page)).objects[id]));
      });
      for (const f of [A, B]) {
        await h.until(async () => (await paneObject(f, id))?.x === want, { timeout: 5000, message: "pane x converges" });
      }
      assert.equal((await h.serverBoard(page)).objects[id].y, before.y);
    });
  });

  test("4. deleting a sticky with a connector: B sees both vanish", async () => {
    await withHarness({}, async ({ page, frames }) => {
      const { A, B } = frames;
      await alignCameras(frames);
      const [s1, s2] = await h.createObjects(page, [
        { type: "sticky", x: 300, y: 250, text: "From" },
        { type: "sticky", x: 700, y: 250, text: "To" },
      ]);
      const [c] = await h.createObjects(page, [{ type: "connector", from: s1, to: s2 }]);
      for (const id of [s1, s2, c]) await waitObject(page, frames, id);
      await page.mouse.click(...Object.values(await h.objectCenter(A, s1)).slice(0, 2));
      await h.until(async () => (await h.inPane(A, (_, canvas) => canvas.getSelection())).includes(s1), { message: "selected" });
      await page.keyboard.press("Delete");
      await B.locator(SEL.object(s1)).waitFor({ state: "detached", timeout: 3000 });
      await B.locator(SEL.object(c)).waitFor({ state: "detached", timeout: 3000 });
      await B.locator(SEL.object(s2)).waitFor();
      assert.deepEqual(Object.keys((await h.serverBoard(page)).objects), [s2]);
    });
  });

  test("5. follow: B follows A, tracks A's pans, and stops when B pans", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames }) => {
      const { A, B } = frames;
      await alignCameras(frames);
      await h.createObjects(page, [{ type: "sticky", x: 300, y: 250, text: "Landmark" }]);
      const aId = await h.clientId(A);
      await B.locator(SEL.peer(aId)).click();
      await B.locator(SEL.followChip).waitFor({ timeout: 3000 });
      assert.match(await B.locator(SEL.followChip).innerText(), /Following\s+Alice/);

      // A pans with the hand tool.
      await A.locator(SEL.tool("hand")).click();
      await h.dragBy(page, await h.panePoint(page, "A", 600, 500), -300, -200, { steps: 10 });
      const vpA = await h.inPane(A, (_, canvas) => canvas.getViewport());
      await h.until(async () => {
        const vpB = await h.inPane(B, (_, canvas) => canvas.getViewport());
        return Math.abs((vpB.x + vpB.w / 2) - (vpA.x + vpA.w / 2)) < 5 && Math.abs((vpB.y + vpB.h / 2) - (vpA.y + vpA.h / 2)) < 5;
      }, { timeout: 5000, message: "B's viewport tracks A's" });
      await page.screenshot({ path: `${SHOTS}/05-follow.png` });

      // B pans: following stops.
      await B.locator(SEL.tool("hand")).click();
      await h.dragBy(page, await h.panePoint(page, "B", 600, 500), 150, 0, { steps: 6 });
      await B.locator(SEL.followChip).waitFor({ state: "hidden", timeout: 3000 });
      assert.equal(await h.inPane(B, (_, canvas) => canvas.getFollowing()), null);
      const vpB1 = await h.inPane(B, (_, canvas) => canvas.getViewport());
      await h.dragBy(page, await h.panePoint(page, "A", 600, 500), 250, 250, { steps: 6 });
      await page.waitForTimeout(500);
      const vpB2 = await h.inPane(B, (_, canvas) => canvas.getViewport());
      assert.deepEqual(vpB2, vpB1, "B no longer moves with A");
    });
  });

  test("6. a tab killed mid-drag: B's ghost disappears within 15 s; the object stays committed", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames }) => {
      const { A, B } = frames;
      await alignCameras(frames);
      const [id] = await h.createObjects(page, [{ type: "sticky", x: 300, y: 250, text: "Orphan" }]);
      const before = await waitObject(page, frames, id);
      const start = await h.objectCenter(A, id);
      await h.dragBy(page, start, 200, 100, {
        steps: 10, stepDelay: 20, release: false,
      });
      await B.locator(SEL.ghost(id)).first().waitFor({ timeout: 3000 });
      const killedAt = Date.now();
      await page.evaluate(() => window.harness.killPane("A"));
      await page.mouse.up();
      await B.locator(SEL.anyGhost).waitFor({ state: "detached", timeout: 15_000 });
      const took = Date.now() - killedAt;
      assert.ok(took < 15_000, `ghost gone after ${took} ms`);
      const o = (await h.serverBoard(page)).objects[id];
      assert.deepEqual([o.x, o.y], [before.x, before.y]);
      const inB = await paneObject(B, id);
      assert.deepEqual([inB.x, inB.y], [before.x, before.y]);
      await B.locator(SEL.peerNamed("Alice")).waitFor({ state: "detached", timeout: 15_000 - took });
      console.log(`# 6 ghost removed ${took} ms after the kill`);
    });
  });

  test("7. 500 objects: panning frame timings; a remote upsert re-renders only that object", async () => {
    await withHarness({ query: "&seed=500" }, async ({ page, frames }) => {
      const { A, B } = frames;
      const board = await h.serverBoard(page);
      const ids = Object.keys(board.objects);
      assert.ok(ids.length >= 500, `seeded ${ids.length}`);
      for (const f of [A, B]) {
        await h.until(async () => (await f.locator(SEL.anyObject).count()) >= 500, { timeout: 15_000, message: "500 rendered" });
      }
      await h.inPane(A, (_, canvas) => canvas.zoomToFit());

      // Pan in A with the hand tool while sampling animation frames.
      await h.inPane(A, () => {
        const w = /** @type {any} */ (window);
        w.__frames = [];
        let last = performance.now();
        const tick = (t) => { w.__frames.push(t - last); last = t; if (w.__frames.length < 400 && !w.__stopFrames) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      });
      await A.locator(SEL.tool("hand")).click();
      await h.dragBy(page, await h.panePoint(page, "A", 700, 450), -400, -250, { steps: 40, stepDelay: 8 });
      await h.dragBy(page, await h.panePoint(page, "A", 300, 200), 400, 250, { steps: 40, stepDelay: 8 });
      const frameMs = await h.inPane(A, () => { const w = /** @type {any} */ (window); w.__stopFrames = true; return w.__frames.slice(1); });
      const sorted = [...frameMs].sort((x, y) => x - y);
      const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
      console.log(`# 7 pan frames: n=${sorted.length} p50=${pct(0.5).toFixed(1)}ms p95=${pct(0.95).toFixed(1)}ms max=${sorted[sorted.length - 1].toFixed(1)}ms`);

      // A remote single-object update in B.
      const target = Object.values(board.objects).find((o) => o.type === "sticky");
      const readStats = () => B.locator("body").evaluate(() => ({ ...(/** @type {any} */ (window).__wbRenderStats ?? {}) }));
      const s0 = await readStats();
      assert.ok(typeof s0.objectRenders === "number" && typeof s0.fullRenders === "number", "render stats exposed: " + JSON.stringify(s0));
      await page.evaluate(({ id, version, x }) => window.harness.apply({
        by: "Agent", senderId: "e2e-agent", objectOps: [{ op: "update", id, baseVersion: version, patch: { x: x + 30 } }],
      }), target);
      await h.until(async () => (await paneObject(B, target.id))?.x === target.x + 30, { message: "B has the update" });
      await page.waitForTimeout(300);
      const s1 = await readStats();
      const objectRenders = s1.objectRenders - s0.objectRenders;
      const fullRenders = s1.fullRenders - s0.fullRenders;
      console.log(`# 7 remote upsert: objectRenders +${objectRenders}, fullRenders +${fullRenders}`);
      assert.ok(objectRenders >= 1 && objectRenders <= 5, `objectRenders +${objectRenders}`);
      assert.equal(fullRenders, 0);
      await page.screenshot({ path: `${SHOTS}/07-500.png` });
    });
  });

  test("9. exportSvg parses as XML with every object, and an export pane renders an <svg>", async () => {
    await withHarness({ panes: 1 }, async ({ page, frames: { A } }) => {
      const ids = await h.createObjects(page, [
        { type: "frame", x: 0, y: 0, w: 900, h: 500, text: "Plan & <scope>" },
        { type: "sticky", x: 40, y: 60, text: "Quotes \" and <tags>" },
        { type: "rect", x: 300, y: 60, text: "Box" },
        { type: "ellipse", x: 560, y: 60 },
        { type: "text", x: 40, y: 320, text: "Label" },
        { type: "pen", x: 300, y: 300, w: 200, h: 100, points: [0, 0, 0.5, 1, 1, 0] },
      ]);
      const [c] = await h.createObjects(page, [{ type: "connector", from: ids[1], to: ids[2] }]);
      const all = [...ids, c];
      const svg = await page.evaluate(() => window.harness.rpc("exportSvg", {}));
      assert.equal(typeof svg, "string");
      const parsed = await page.evaluate((text) => {
        const doc = new DOMParser().parseFromString(text, "image/svg+xml");
        return {
          error: doc.getElementsByTagName("parsererror").length > 0,
          root: doc.documentElement.localName,
          ids: [...doc.querySelectorAll("[data-id]")].map((el) => el.getAttribute("data-id")),
        };
      }, svg);
      assert.equal(parsed.error, false, "parses as XML");
      assert.equal(parsed.root, "svg");
      for (const id of all) assert.ok(parsed.ids.includes(id), `export contains ${id}`);

      const paneId = await page.evaluate(() => window.harness.addPane({ exportFormat: "html" }));
      const E = h.pane(page, paneId);
      await E.locator("svg.wb-export-board").waitFor({ timeout: 10_000 });
      assert.equal(await E.locator("svg.wb-export-board [data-id]").count(), all.length);
      assert.equal(await E.locator("button, input, textarea, select").count(), 0, "no chrome in export");
      await A.locator(SEL.object(ids[1])).waitFor();
      await page.screenshot({ path: `${SHOTS}/09-export.png` });
    });
  });

  test("account names: no name prompt anywhere, a reloaded or new pane keeps its account name, colour change via the me button", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames: { A, B } }) => {
      // openHarness already checked both panes show their account names without a dialog.
      await page.evaluate(() => window.harness.reloadPane("B"));
      await h.until(() => page.evaluate(() => window.harness.paneLoads("B") >= 2), { message: "B reloaded" });
      await h.waitLive(B);
      await h.expectAccountName(B, "Bob");
      await A.locator(SEL.peerNamed("Bob")).waitFor({ timeout: 5000 });
      await B.locator(SEL.peerNamed("Alice")).waitFor({ timeout: 5000 });
      assert.equal(await A.locator("form").count(), 0);
      assert.equal(await B.locator("form").count(), 0);

      // A pane added later starts under its own account name ("User C"), also without a dialog.
      const paneId = await page.evaluate(() => window.harness.addPane());
      const C = h.pane(page, paneId);
      await h.waitLive(C);
      await h.expectAccountName(C, `User ${paneId}`);
      await A.locator(SEL.peerNamed(`User ${paneId}`)).waitFor({ timeout: 5000 });

      // The me button opens a colour-only dialog: no name field; the name stays the account's.
      await A.locator(".me-btn").click();
      const dialog = A.locator(SEL.colorDialog);
      await dialog.waitFor();
      assert.equal(await dialog.locator("input, textarea, [contenteditable]").count(), 0, "no name field in the colour dialog");
      assert.equal(await A.locator(SEL.namePrompt).count(), 0);
      assert.equal(await dialog.locator(".color-dialog-name").innerText(), "Alice");
      const before = await h.inPane(A, (store) => store.getState().viewer.color);
      const other = dialog.locator('.swatch[aria-checked="false"]').first();
      await other.click();
      await dialog.locator(".save-btn").click();
      await dialog.waitFor({ state: "detached" });
      const after = await h.until(async () => {
        const c = await h.inPane(A, (store) => store.getState().viewer.color);
        return c !== before && c;
      }, { message: "A's colour changed" });
      await h.expectAccountName(A, "Alice");
      await h.until(() => h.inPane(B, (store, _, color) =>
        [...store.getState().peers.values()].some((p) => p.name === "Alice" && p.color === color), after),
      { message: "B sees Alice with her new colour" });
    });
  });

  test("attribution: objects and history entries carry the creating pane's account name", async () => {
    await withHarness({ names: ["Ada Lovelace", "Grace Hopper"] }, async ({ page, frames: { A, B } }) => {
      const fromA = await h.inPane(A, (_, canvas) => { const id = canvas.addAtCenter("rect"); canvas.setSelection([]); return id; });
      const fromB = await h.inPane(B, (_, canvas) => { const id = canvas.addAtCenter("ellipse"); canvas.setSelection([]); return id; });
      const board = await h.until(async () => {
        const b = await h.serverBoard(page);
        return b.objects[fromA] && b.objects[fromB] && b;
      }, { message: "both objects saved" });
      assert.equal(board.objects[fromA].createdBy, "Ada Lovelace");
      assert.equal(board.objects[fromB].createdBy, "Grace Hopper");
      await B.locator(SEL.object(fromA)).waitFor({ timeout: 3000 });
      assert.equal((await paneObject(B, fromA)).createdBy, "Ada Lovelace", "B's copy is attributed to Ada");
      const history = await page.evaluate(() => window.harness.getHistory(10));
      const bys = history.map((e) => e.by);
      assert.ok(bys.includes("Ada Lovelace"), "a history entry by Ada: " + JSON.stringify(bys));
      assert.ok(bys.includes("Grace Hopper"), "a history entry by Grace: " + JSON.stringify(bys));
      assert.ok(bys.every((by) => by === "Ada Lovelace" || by === "Grace Hopper"), "no Guest/Anonymous entries: " + JSON.stringify(bys));
    });
  });

  for (const dispose of [false, true]) {
    test(`restart ${dispose ? "+ dispose" : "(no dispose)"}: panes resync (known: false), no lost edit, no reload`, async () => {
      await withHarness({ query: "&downtime=800" }, async ({ page, frames }) => {
        const { A, B } = frames;
        await alignCameras(frames);
        const [first] = await h.createObjects(page, [{ type: "sticky", x: 300, y: 250, text: "Before" }]);
        await waitObject(page, frames, first);
        await page.evaluate((d) => window.harness.restart({ dispose: d }), dispose);
        // An edit made while the server is down.
        const during = await h.inPane(B, (_, canvas) => canvas.addAtCenter("rect"));
        await page.keyboard.press("Escape").catch(() => {});
        await A.locator(SEL.object(during)).waitFor({ timeout: 15_000 });
        await h.waitLive(A);
        await h.waitLive(B);
        const later = await h.inPane(A, (_, canvas) => canvas.addAtCenter("ellipse"));
        await B.locator(SEL.object(later)).waitFor({ timeout: 10_000 });
        const board = await h.serverBoard(page);
        assert.deepEqual(Object.keys(board.objects).sort(), [first, during, later].sort());
        assert.equal(await page.evaluate(() => window.harness.subscribers().length), 2);
        assert.deepEqual(await page.evaluate(() => [window.harness.paneLoads("A"), window.harness.paneLoads("B")]), [1, 1]);
      });
    });
  }

  test("restart with stale stubs (platform behaviour): panes reload themselves and keep their account names", async () => {
    await withHarness({ names: ["Alice Adams", "Bob Brown"] }, async ({ page, frames }) => {
      const { A, B } = frames;
      const [first] = await h.createObjects(page, [{ type: "sticky", x: 300, y: 250, text: "Before stale" }]);
      await waitObject(page, frames, first);
      const started = Date.now();
      await page.evaluate(() => window.harness.restart({ staleStub: true }));
      await h.until(() => page.evaluate(() => window.harness.paneLoads("A") >= 2 && window.harness.paneLoads("B") >= 2),
        { timeout: 25_000, message: "both panes reloaded" });
      await h.waitLive(A);
      await h.waitLive(B);
      assert.ok(await page.evaluate(() => window.harness.staleRejections) > 0, "stale stubs were exercised");
      await h.expectAccountName(A, "Alice Adams");
      await h.expectAccountName(B, "Bob Brown");
      await A.locator(SEL.peerNamed("Bob Brown")).waitFor({ timeout: 5000 });
      await B.locator(SEL.peerNamed("Alice Adams")).waitFor({ timeout: 5000 });
      await B.locator(SEL.object(first)).waitFor();
      const after = await h.inPane(B, (_, canvas) => canvas.addAtCenter("rect"));
      await A.locator(SEL.object(after)).waitFor({ timeout: 5000 });
      assert.deepEqual(await page.evaluate(() => [window.harness.paneLoads("A"), window.harness.paneLoads("B")]), [2, 2],
        "exactly one self-reload per pane");
      console.log(`# stale-stub recovery took ${Date.now() - started} ms`);
    });
  });

  test("stale stub with an unsaved edit: recovery screen instead of a reload, with count and data download", async () => {
    await withHarness({}, async ({ page, frames }) => {
      const { B } = frames;
      const [first] = await h.createObjects(page, [{ type: "sticky", x: 300, y: 250, text: "Before stale" }]);
      await waitObject(page, frames, first);
      await page.evaluate(() => window.harness.restart({ staleStub: true }));
      // An edit B makes on its now-dead stub: never acknowledged.
      await h.inPane(B, (store, _c, id) => store.updateObjects([{ id, patch: { text: "Unsaved" } }]), first);
      const screen = B.locator('#wb-connection-overlay[data-state="recovery"]');
      await screen.waitFor({ timeout: 25_000 });
      assert.equal(await screen.getAttribute("data-count"), "1");
      assert.match(await screen.locator("#wb-recovery-count").textContent(), /1 unsaved change has not been saved/);
      assert.equal(await B.locator(SEL.conn).getAttribute("data-state"), "recovery-required");
      assert.equal(await screen.getByRole("alertdialog").count(), 1);
      // It holds: no self-reload while the change is unacknowledged.
      await page.waitForTimeout(3000);
      assert.equal(await page.evaluate(() => window.harness.paneLoads("B")), 1);
      // The data-only copy is offered as text (downloads may be blocked by the platform sandbox).
      await screen.getByRole("button", { name: "Show as text" }).click();
      const data = JSON.parse(await screen.locator("textarea").inputValue());
      assert.equal(data.format, "whiteboard-recovery");
      assert.deepEqual(data.pending.map((p) => [p.kind, p.id, p.patch?.text]), [["update", first, "Unsaved"]]);
      assert.equal(data.board.objects[first].text, "Before stale");
      assert.ok(!(await page.evaluate(() => [...document.querySelectorAll("iframe")].map((f) => f.contentWindow?.name ?? "").join("")))
        .includes("Unsaved"), "the recovery payload never goes into window.name");
      await screen.getByRole("button", { name: "Reload and lose them" }).click();
      await h.until(() => page.evaluate(() => window.harness.paneLoads("B") >= 2), { timeout: 10_000, message: "B reloaded on request" });
      await h.waitLive(B);
    });
  });

  test("text editing round trip: A types into a new sticky, B sees the text", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames }) => {
      const { A, B } = frames;
      await A.locator(SEL.addButton).click();
      await A.locator(SEL.addItem("sticky")).click();
      await page.keyboard.type("Hello from A");
      await page.keyboard.press("Escape");
      const sticky = await h.until(async () => Object.values((await h.serverBoard(page)).objects)
        .find((o) => o.type === "sticky" && o.text === "Hello from A"), { message: "text committed" });
      await B.locator(SEL.object(sticky.id)).filter({ hasText: "Hello from A" }).waitFor({ timeout: 3000 });
      // Edit again through the style bar's Edit text button.
      await h.inPane(A, (_, canvas, id) => canvas.setSelection([id]), sticky.id);
      await A.locator(".wb-stylebar .edit-text-btn").click();
      await page.keyboard.press("End");
      await page.keyboard.type(" and more");
      await page.keyboard.press("Escape");
      // (Wrapped lines are separate <tspan>s, so check the text B holds rather than a substring.)
      await h.until(async () => (await paneObject(B, sticky.id))?.text === "Hello from A and more", { timeout: 3000, message: "B has the edited text" });
      await B.locator(SEL.object(sticky.id)).filter({ hasText: "more" }).waitFor({ timeout: 3000 });
      await page.screenshot({ path: `${SHOTS}/text-edit.png` });
    });
  });

  test("undo and redo buttons", async () => {
    await withHarness({}, async ({ page, frames: { A, B } }) => {
      await A.locator(SEL.addButton).click();
      await A.locator(SEL.addItem("rect")).click();
      const rect = await h.until(async () => Object.values((await h.serverBoard(page)).objects)[0], { message: "created" });
      await B.locator(SEL.object(rect.id)).waitFor();
      assert.equal(await A.locator(SEL.undo).getAttribute("aria-disabled"), "false");
      await A.locator(SEL.undo).click();
      await B.locator(SEL.object(rect.id)).waitFor({ state: "detached", timeout: 3000 });
      await h.until(async () => Object.keys((await h.serverBoard(page)).objects).length === 0, { message: "undone on the server" });
      await A.locator(SEL.redo).click();
      await B.locator(SEL.object(rect.id)).waitFor({ timeout: 3000 });
      await h.until(async () => Object.keys((await h.serverBoard(page)).objects).length === 1, { message: "redone on the server" });
    });
  });

  test("keyboard only: create through the Add menu, move with the Move buttons and arrow keys, find in the Objects list", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames: { A, B } }) => {
      await A.locator(SEL.addButton).focus();
      await page.keyboard.press("Enter");
      await A.locator(SEL.addItem("sticky")).waitFor();
      assert.ok(await A.locator(SEL.addItem("sticky")).evaluate((el) => el === document.activeElement), "menu takes focus");
      await page.keyboard.press("Enter");
      await page.keyboard.type("Keyboard note");
      await page.keyboard.press("Escape");
      const note = await h.until(async () => Object.values((await h.serverBoard(page)).objects).find((o) => o.text === "Keyboard note"),
        { message: "created by keyboard" });
      await B.locator(SEL.object(note.id)).waitFor();

      // Move buttons in the style bar.
      await A.locator(".wb-stylebar .move-right").waitFor({ timeout: 3000 });
      await A.locator(".wb-stylebar .move-right").focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      await A.locator(".wb-stylebar .move-down").focus();
      await page.keyboard.press("Space");
      await h.until(async () => {
        const o = (await h.serverBoard(page)).objects[note.id];
        return o.x === note.x + 20 && o.y === note.y + 10;
      }, { message: "moved by buttons" });
      assert.ok(await A.locator(".wb-stylebar .move-down").evaluate((el) => el === document.activeElement), "focus stays on Move down");
      await h.until(async () => /Moved/.test(await h.liveText(A)), { message: "move announced" });

      // Arrow keys on the focused canvas.
      await h.inPane(A, (_, canvas) => canvas.element.focus());
      await page.keyboard.press("Shift+ArrowLeft");
      await h.until(async () => (await h.serverBoard(page)).objects[note.id].x === note.x + 10, { message: "moved by arrow key" });

      // Objects list: Shift+O, filter, Select.
      await h.inPane(A, (_, canvas) => canvas.setSelection([]));
      await page.keyboard.press("Shift+O");
      const panel = A.locator(SEL.outlinePanel);
      await panel.waitFor({ timeout: 3000 });
      await page.keyboard.type("keyboard");
      await panel.locator(`.outline-item[data-id="${note.id}"] .outline-select`).focus();
      await page.keyboard.press("Enter");
      await panel.waitFor({ state: "detached" });
      assert.deepEqual(await h.inPane(A, (_, canvas) => canvas.getSelection()), [note.id]);
      assert.ok(await A.locator(".wb-stylebar").evaluate((el) => el.contains(document.activeElement)), "focus lands in the style bar");
    });
  });

  test("style bar: one colour click recolours every selected object in one change", async () => {
    await withHarness({}, async ({ page, frames }) => {
      const { A, B } = frames;
      await alignCameras(frames);
      const ids = await h.createObjects(page, [
        { type: "sticky", x: 300, y: 250 }, { type: "sticky", x: 550, y: 250 }, { type: "rect", x: 800, y: 250 },
      ]);
      for (const id of ids) await waitObject(page, frames, id);
      const revision = (await h.serverBoard(page)).revision;
      await h.inPane(A, (_, canvas, sel) => canvas.setSelection(sel), ids);
      await A.locator(".wb-stylebar .style-fill").click();
      await A.locator('.swatch-pop [data-color="#ffadad"]').click();
      await h.until(async () => {
        const b = await h.serverBoard(page);
        return ids.every((id) => b.objects[id].style.fill === "#ffadad") && b;
      }, { message: "all recoloured" });
      assert.equal((await h.serverBoard(page)).revision, revision + 1, "one request");
      await h.until(async () => (await paneObject(B, ids[2])).style.fill === "#ffadad", { message: "B sees it" });
    });
  });

  test("phone width (400 px): bottom tool bar, bottom-sheet style bar, no minimap", async () => {
    await withHarness({ panes: 1, viewport: { width: 400, height: 800 } }, async ({ page, frames: { A } }) => {
      const frameBox = await page.locator('iframe[data-pane="A"]').boundingBox();
      const tb = await A.locator(SEL.toolbar).boundingBox();
      assert.ok(tb.y + tb.height >= frameBox.y + frameBox.height - 2, "tool bar at the bottom");
      assert.ok(tb.width >= frameBox.width - 2, "tool bar spans the width");
      assert.equal(await A.locator(SEL.minimap).isVisible(), false, "minimap hidden");
      await A.locator(SEL.addButton).click();
      await A.locator(SEL.addItem("rect")).click();
      const sb = A.locator(SEL.styleBar);
      await sb.waitFor({ timeout: 3000 });
      const sbBox = await sb.boundingBox();
      assert.ok(sbBox.y + sbBox.height <= tb.y + 1, "style bar sits above the tool bar");
      assert.ok(sbBox.x <= frameBox.x + 1 && sbBox.width >= frameBox.width - 2, "style bar is a full-width sheet");
      // Every tool is reachable (scrollable) and the top chrome does not overflow.
      const top = await A.locator(".wb-topbar").boundingBox();
      const right = await A.locator(".wb-topright").boundingBox();
      assert.ok(top.x + top.width <= right.x + 1, "top-left and top-right chrome do not overlap");
      await page.screenshot({ path: `${SHOTS}/phone.png` });
    });
  });

  test("remote changes are announced in the live region", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames: { A, B } }) => {
      await A.locator(SEL.addButton).click();
      await A.locator(SEL.addItem("rect")).click();
      await h.until(async () => /Alice/.test(await h.liveText(B)), { timeout: 5000, message: "B hears about Alice's change" });
      assert.ok(!/Alice/.test(await h.liveText(A)), "own changes are not announced as remote");
    });
  });

  test("context menu, activity undo and minimap", async () => {
    await withHarness({ names: ["Alice", "Bob"], colorScheme: "dark" }, async ({ page, frames }) => {
      const { A, B } = frames;
      await alignCameras(frames);
      const [id] = await h.createObjects(page, [{ type: "sticky", x: 300, y: 250, text: "Menu me" }]);
      await waitObject(page, frames, id);

      // Minimap draws the object and the viewport; a click moves the camera.
      const inked = () => A.locator(`${SEL.minimap} canvas`).evaluate((c) => {
        const d = /** @type {HTMLCanvasElement} */ (c).getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let grey = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && Math.abs(d[i] - 0xc3) < 6 && Math.abs(d[i + 2] - 0xd0) < 6) grey++;
        return grey;
      });
      await h.until(async () => (await inked()) > 0, { message: "minimap shows the object" });
      await page.screenshot({ path: `${SHOTS}/menu-dark.png` });
      const cam0 = await h.inPane(A, (_, canvas) => canvas.getCamera());
      const mm = await A.locator(SEL.minimap).boundingBox();
      await page.mouse.click(mm.x + 8, mm.y + 8);
      await h.until(async () => (await h.inPane(A, (_, canvas) => canvas.getCamera())).x !== cam0.x, { message: "minimap click moves the camera" });
      await h.setCamera(A);
      await h.inPane(A, (_, canvas) => canvas.setSelection([]));

      // Right-click on the sticky opens the actions menu; Delete removes it everywhere. (The camera
      // change is drawn on the next animation frame, so wait for the sticky to settle first.)
      const pa = await page.locator('iframe[data-pane="A"]').boundingBox();
      const c = await h.until(async () => {
        const at = await h.objectCenter(A, id);
        return Math.abs(at.box.x - pa.x - 300) < 3 && at;
      }, { message: "sticky back at the origin camera" });
      await page.mouse.click(c.x, c.y, { button: "right" });
      await A.locator(".menu .ctx-delete").waitFor({ timeout: 3000 });
      await page.screenshot({ path: `${SHOTS}/context-menu.png` });
      await A.locator(".menu .ctx-delete").click();
      await B.locator(SEL.object(id)).waitFor({ state: "detached", timeout: 3000 });

      // The Activity panel lists it and can undo it.
      await A.locator(".activity-toggle").click();
      const item = A.locator(".activity .activity-item").first();
      await item.waitFor({ timeout: 3000 });
      await item.locator(".undo-history-btn").click();
      await B.locator(SEL.object(id)).waitFor({ timeout: 3000 });
      await page.keyboard.press("Escape");
      await A.locator(".activity").waitFor({ state: "detached" });
    });
  });

  test("keyboard resize and rotate: Alt+Arrow, comma and period, and the style bar's Size group", async () => {
    await withHarness({ panes: 1 }, async ({ page, frames: { A } }) => {
      const [id] = await h.createObjects(page, [{ type: "sticky", x: 300, y: 250, w: 200, h: 200, text: "Size me" }]);
      await A.locator(SEL.object(id)).waitFor();
      await h.inPane(A, (_, canvas, oid) => { canvas.setSelection([oid]); canvas.element.focus(); }, id);
      const server = async () => (await h.serverBoard(page)).objects[id];
      const rev0 = (await h.serverBoard(page)).revision;

      await page.keyboard.press("Alt+Shift+ArrowRight");
      await h.until(async () => (await server()).w === 210, { message: "Alt+Shift+Right widens by 10" });
      assert.equal((await h.serverBoard(page)).revision, rev0 + 1, "one change per key press");
      const o1 = await server();
      assert.deepEqual([o1.x, o1.y, o1.h], [300, 250, 200], "top-left corner and height kept");
      await page.keyboard.press("Alt+ArrowDown");
      await h.until(async () => (await server()).h === 201, { message: "Alt+Down makes it taller by 1" });
      await h.until(async () => /Height 201/.test(await h.liveText(A)), { message: "resize announced" });

      await page.keyboard.press(".");
      await h.until(async () => (await server()).rot === 15, { message: ". rotates clockwise" });
      await page.keyboard.press(",");
      await page.keyboard.press(",");
      await h.until(async () => (await server()).rot === 345, { message: ", rotates back" });
      await h.until(async () => /Rotation 345 degrees/.test(await h.liveText(A)), { message: "rotation announced" });

      // The style bar: steppers, a typed width (Enter, no form) and rotate buttons.
      const bar = A.locator(SEL.styleBar);
      await bar.locator(".size-w-inc").focus();
      await page.keyboard.press("Enter");
      await h.until(async () => (await server()).w === 220, { message: "Wider button" });
      await h.until(async () => /Width 220/.test(await h.liveText(A)), { message: "width announced" });
      assert.ok(await bar.locator(".size-w-inc").evaluate((el) => el === document.activeElement), "focus stays on the stepper");
      await bar.locator(".size-w").fill("320");
      await page.keyboard.press("Enter");
      await h.until(async () => (await server()).w === 320, { message: "typed width applied" });
      await bar.locator(".size-h").fill("150");
      await page.keyboard.press("Enter");
      await h.until(async () => (await server()).h === 150, { message: "typed height applied" });
      await bar.locator(".rotate-cw").click();
      await h.until(async () => (await server()).rot === 0, { message: "Rotate right button" });
      // Escape in the style bar returns to the canvas.
      await bar.locator(".rotate-cw").focus();
      await page.keyboard.press("Escape");
      assert.match(await h.focusedClass(A), /wb-canvas/);
      assert.deepEqual(await h.inPane(A, (_, canvas) => canvas.getSelection()), [id], "selection kept");
    });
  });

  test("connect without dragging: two selected objects, Connect in the style bar and the context menu", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames: { A, B } }) => {
      const [s1, s2, s3] = await h.createObjects(page, [
        { type: "sticky", x: 300, y: 250, text: "One" },
        { type: "sticky", x: 700, y: 250, text: "Two" },
        { type: "rect", x: 300, y: 600, text: "Three" },
      ]);
      await A.locator(SEL.object(s3)).waitFor();
      await h.inPane(A, (_, canvas, ids) => canvas.setSelection(ids), [s2]);
      assert.equal(await A.locator(SEL.connectButton).count(), 0, "no Connect for one object");
      // Selection order is kept: s2 first, then s1.
      await h.inPane(A, (_, canvas, ids) => canvas.setSelection(ids), [s2, s1]);
      await A.locator(SEL.connectButton).focus();
      await page.keyboard.press("Enter");
      const conn = await h.until(async () => Object.values((await h.serverBoard(page)).objects).find((o) => o.type === "connector"),
        { message: "connector created" });
      assert.deepEqual([conn.from, conn.to], [s2, s1]);
      await B.locator(SEL.object(conn.id)).waitFor({ timeout: 3000 });
      assert.deepEqual(await h.inPane(A, (_, canvas) => canvas.getSelection()), [conn.id], "the new connector is selected");
      assert.ok(await A.locator(SEL.styleBar).evaluate((el) => el.contains(document.activeElement)), "focus stays in the style bar");
      await h.until(async () => /Connected/.test(await h.liveText(A)), { message: "connection announced" });

      // The context menu (keyboard) offers Connect too.
      await h.inPane(A, (_, canvas, ids) => { canvas.setSelection(ids); canvas.element.focus(); }, [s1, s3]);
      await page.keyboard.press("Shift+F10");
      await A.locator(SEL.menuItem("connect")).waitFor({ timeout: 3000 });
      await A.locator(SEL.menuItem("connect")).focus();
      await page.keyboard.press("Enter");
      await h.until(async () => Object.values((await h.serverBoard(page)).objects)
        .some((o) => o.type === "connector" && o.from === s1 && o.to === s3), { message: "second connector from the menu" });
    });
  });

  for (const key of ["ContextMenu", "Shift+F10"]) {
    test(`${key} opens the menu for the current selection, beside it, never the object at the view centre`, async () => {
      await withHarness({ panes: 1, viewport: { width: 1300, height: 820 } }, async ({ page, frames: { A } }) => {
        const [centre, other] = await h.createObjects(page, [
          { type: "rect", x: -100, y: -60, w: 200, h: 120, text: "Centre" },
          { type: "sticky", x: 150, y: 120, w: 160, h: 120, text: "Other" },
        ]);
        await A.locator(SEL.object(other)).waitFor();
        await h.inPane(A, (_, canvas) => {
          const vp = canvas.getViewport();
          canvas.setCamera({ x: -vp.w / 2, y: -vp.h / 2, zoom: 1 }, false);
        });
        await h.inPane(A, (_, canvas, oid) => { canvas.setSelection([oid]); canvas.element.focus(); }, other);
        await page.waitForTimeout(100);
        await page.keyboard.press(key);
        const menu = A.locator(SEL.menu);
        await menu.waitFor({ timeout: 3000 });
        assert.deepEqual(await h.inPane(A, (_, canvas) => canvas.getSelection()), [other], "selection unchanged");
        assert.equal(await menu.count(), 1, "one menu");
        const m = await h.pageRect(A, SEL.menu);
        const o = await h.pageRect(A, SEL.object(other));
        const overlaps = m.left < o.right && m.right > o.left && m.top < o.bottom && m.bottom > o.top;
        assert.ok(!overlaps, `menu ${JSON.stringify(m)} beside the selection ${JSON.stringify(o)}`);
        assert.match(await h.focusedClass(A), /btn/, "menu has focus");
        await A.locator(SEL.menuItem("delete")).focus();
        await page.keyboard.press("Enter");
        await h.until(async () => !(await h.serverBoard(page)).objects[other], { message: "the selected object is deleted" });
        assert.ok((await h.serverBoard(page)).objects[centre], "the object at the centre is untouched");
        assert.match(await h.focusedClass(A), /wb-canvas/, "focus back on the canvas");
      });
    });
  }

  test("touch long-press: the menu opens clear of the finger and lifting it activates nothing", async () => {
    await withHarness({ panes: 1, viewport: { width: 414, height: 860 }, hasTouch: true, isMobile: true }, async ({ page, frames: { A } }) => {
      const [id] = await h.createObjects(page, [{ type: "sticky", x: 0, y: 0, w: 200, h: 200, text: "Hold me" }]);
      await A.locator(SEL.object(id)).waitFor();
      // Near the bottom right, where a menu under the finger used to open.
      await h.inPane(A, (_, canvas) => canvas.setCamera({ x: -150, y: -480, zoom: 1 }, false));
      await page.waitForTimeout(150);
      const { box } = await h.objectCenter(A, id);
      const at = { x: box.x + 60, y: box.y + 50 };
      const press = await h.touchPress(page, at, { ms: 800, hold: true });
      const menu = A.locator(SEL.menu);
      await menu.waitFor({ timeout: 3000 });
      const m = await h.pageRect(A, SEL.menu);
      const clear = at.x < m.left - 20 || at.x > m.right + 20 || at.y < m.top - 20 || at.y > m.bottom + 20;
      assert.ok(clear, `menu ${JSON.stringify(m)} keeps clear of the finger at ${JSON.stringify(at)}`);
      await page.screenshot({ path: `${SHOTS}/longpress-menu.png` });
      await press.release();
      await page.waitForTimeout(400);
      const count = async () => Object.keys((await h.serverBoard(page)).objects).length;
      assert.equal(await count(), 1, "lifting the finger ran nothing");
      assert.equal(await menu.count(), 1, "the menu stays open");
      assert.ok(await A.locator(SEL.menuItem("duplicate")).evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.height >= 44;
      }), "menu items are at least 44px tall on phones");
      // A new tap on an item does run it.
      const dup = await A.locator(SEL.menuItem("duplicate")).boundingBox();
      await h.touchPress(page, { x: dup.x + dup.width / 2, y: dup.y + dup.height / 2 });
      await h.until(async () => (await count()) === 2, { message: "a fresh tap duplicates" });
    });
  });

  test("arrow keys pan the view with nothing selected; nudges are announced", async () => {
    await withHarness({ panes: 1 }, async ({ page, frames: { A } }) => {
      const [id] = await h.createObjects(page, [{ type: "sticky", x: 300, y: 250, text: "Nudge" }]);
      await A.locator(SEL.object(id)).waitFor();
      await h.setCamera(A, { x: 0, y: 0, zoom: 2 });
      await h.inPane(A, (_, canvas) => { canvas.setSelection([]); canvas.element.focus(); });
      await page.keyboard.press("ArrowRight");
      await h.until(async () => (await h.inPane(A, (_, canvas) => canvas.getCamera())).x === 20, { message: "ArrowRight pans right by 40 px" });
      await page.keyboard.press("Shift+ArrowDown");
      await h.until(async () => (await h.inPane(A, (_, canvas) => canvas.getCamera())).y === 100, { message: "Shift+ArrowDown pans down by 200 px" });
      assert.equal((await h.serverBoard(page)).objects[id].x, 300, "nothing moved");

      await h.inPane(A, (_, canvas, oid) => canvas.setSelection([oid]), id);
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await h.until(async () => (await h.serverBoard(page)).objects[id].x === 302, { message: "nudged" });
      await h.until(async () => /Moved right/.test(await h.liveText(A)), { message: "nudge announced" });
      const cam = await h.inPane(A, (_, canvas) => canvas.getCamera());
      assert.deepEqual([cam.x, cam.y], [20, 100], "a nudge does not pan");
    });
  });

  test("low zoom: dragging a small selected object moves it instead of resizing it", async () => {
    await withHarness({ panes: 1, viewport: { width: 1300, height: 820 } }, async ({ page, frames: { A } }) => {
      const [id] = await h.createObjects(page, [{ type: "rect", x: 2000, y: 2000, w: 200, h: 120 }]);
      await A.locator(SEL.object(id)).waitFor();
      for (const zoom of [0.12, 0.08]) {
        const before = (await h.serverBoard(page)).objects[id];
        await h.inPane(A, (_, canvas, a) => {
          const vp = canvas.getViewport(), cam = canvas.getCamera();
          const w = vp.w * cam.zoom, hh = vp.h * cam.zoom;
          canvas.setCamera({ x: a.cx - w / 2 / a.zoom, y: a.cy - hh / 2 / a.zoom, zoom: a.zoom }, false);
        }, { zoom, cx: before.x + before.w / 2, cy: before.y + before.h / 2 });
        await h.inPane(A, (_, canvas, oid) => canvas.setSelection([oid]), id);
        await page.waitForTimeout(150);
        const { x, y } = await h.objectCenter(A, id);
        await h.dragBy(page, { x, y }, 40, 24, { steps: 8 });
        const after = await h.until(async () => {
          const o = (await h.serverBoard(page)).objects[id];
          return o.version !== before.version && o;
        }, { message: `committed at zoom ${zoom}` });
        assert.deepEqual([after.w, after.h], [before.w, before.h], `zoom ${zoom}: size unchanged`);
        assert.ok(Math.abs(after.x - before.x - 40 / zoom) < 2 / zoom, `zoom ${zoom}: moved by the drag (${before.x} -> ${after.x})`);
      }
    });
  });

  test("focus: on the canvas on load and after deleting from the style bar; roving toolbar keys", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames: { A, B } }) => {
      // No dialog to join through: a pane's focus lands on the canvas as soon as it mounts.
      await h.until(async () => /wb-canvas/.test(await h.focusedClass(B)), { timeout: 3000, message: "B: focus on the canvas on load" });
      await page.evaluate(() => window.harness.reloadPane("A"));
      await h.until(() => page.evaluate(() => window.harness.paneLoads("A") >= 2), { message: "A reloaded" });
      await h.waitLive(A);
      await h.expectAccountName(A, "Alice");
      await h.until(async () => /wb-canvas/.test(await h.focusedClass(A)), { timeout: 3000, message: "A: focus on the canvas after a reload" });

      const [id] = await h.createObjects(page, [{ type: "sticky", x: 300, y: 250, text: "Delete me" }]);
      await A.locator(SEL.object(id)).waitFor();
      await h.inPane(A, (_, canvas, oid) => canvas.setSelection([oid]), id);
      await A.locator(".wb-stylebar .delete-btn").focus();
      await page.keyboard.press("Enter");
      await B.locator(SEL.object(id)).waitFor({ state: "detached", timeout: 3000 });
      assert.match(await h.focusedClass(A), /wb-canvas/, "focus on the canvas after Delete");

      // The tool bar is one Tab stop; arrow keys move between its buttons.
      const tools = A.locator(SEL.toolbar);
      assert.equal(await tools.locator('button[tabindex="0"]').count(), 1, "one Tab stop");
      await tools.locator('[data-tool="select"]').focus();
      await page.keyboard.press("ArrowDown");
      assert.equal(await tools.locator('[data-tool="hand"]').evaluate((el) => el === document.activeElement), true, "ArrowDown moves to Hand");
      await page.keyboard.press("End");
      assert.match(await h.focusedClass(A), /activity-toggle/, "End moves to the last button");
      assert.equal(await tools.locator('button[tabindex="0"]').count(), 1, "still one Tab stop");
    });
  });

  test("code block: add from the Add menu, type code, choose Python, highlighted for both panes and in the export", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames: { A, B } }) => {
      await A.locator(SEL.addButton).click();
      await A.locator(SEL.addItem("code")).click();
      await A.locator("textarea.wb-editor-code").waitFor({ timeout: 3000 });
      await page.keyboard.type("def greet(name):\nreturn f\"hi {name}\"  # say hi");
      await page.keyboard.press("Escape");
      const block = await h.until(async () => Object.values((await h.serverBoard(page)).objects).find((o) => o.type === "code" && o.text.includes("greet")),
        { message: "code committed" });
      assert.equal(block.language, "plain");
      assert.ok(block.h > 80 && block.h < 120, `height fitted to two lines (${block.h})`);
      // Choose Python in the style bar's searchable language list.
      await A.locator(".wb-stylebar .code-language-btn").click();
      await A.locator(".object-picker .picker-filter").waitFor();
      await page.keyboard.type("pyth");
      await page.keyboard.press("Enter");
      await h.until(async () => (await h.serverBoard(page)).objects[block.id].language === "python", { message: "language saved" });
      const keyword = "#cf222e";
      for (const f of [A, B]) {
        await f.locator(`${SEL.object(block.id)} text.wb-code-text tspan[fill="${keyword}"]`, { hasText: "def" }).first().waitFor({ timeout: 3000 });
      }
      assert.match(await A.locator(`${SEL.object(block.id)} .wb-code-head`).first().textContent(), /Python/);
      // The canvas and the server's SVG export draw the same tokens with the same colours.
      const tokens = (root) => [...root.querySelectorAll("text.wb-code-text > tspan > tspan")].map((t) => [t.getAttribute("fill"), t.textContent]);
      const ui = await B.locator(SEL.object(block.id)).evaluate((el, src) => (0, eval)(src)(el), tokens.toString());
      const exported = await page.evaluate(async ({ id, src }) => {
        const svg = await window.harness.rpc("exportSvg", {});
        const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
        return (0, eval)(src)(doc.querySelector(`[data-id="${id}"]`));
      }, { id: block.id, src: tokens.toString() });
      assert.ok(ui.length > 5, "tokens rendered");
      assert.deepEqual(ui, exported);
      await page.screenshot({ path: `${SHOTS}/code-block.png` });
    });
  });

  test("code block, keyboard only: K, Tab and Shift+Tab indent, Enter keeps the indent, dark theme, Copy code; the peer sees it", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames: { A, B } }) => {
      await h.inPane(A, (_, canvas) => canvas.element.focus());
      await page.keyboard.press("k");
      await A.locator("textarea.wb-editor-code").waitFor({ timeout: 3000 });
      assert.match(await h.focusedClass(A), /wb-editor-code/, "the code editor has focus");
      await page.keyboard.type("if (ok) {");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Tab");
      await page.keyboard.type("run();");
      await page.keyboard.press("Enter"); // keeps the two-space indent
      await page.keyboard.type("x();");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.type("}");
      await page.keyboard.press("Control+Enter");
      const want = "if (ok) {\n  run();\n  x();\n}";
      const block = await h.until(async () => Object.values((await h.serverBoard(page)).objects).find((o) => o.type === "code" && o.text === want),
        { message: "indented code committed" });
      await h.until(async () => /wb-canvas/.test(await h.focusedClass(A)), { message: "focus back on the canvas" });
      // Style bar by keyboard: Tab from the canvas, then the Dark theme toggle.
      await A.locator(".wb-stylebar .code-theme-btn").focus();
      await page.keyboard.press("Enter");
      await h.until(async () => (await h.serverBoard(page)).objects[block.id].theme === "dark", { message: "dark theme" });
      await B.locator(`${SEL.object(block.id)} rect[fill="#0d1117"]`).waitFor({ timeout: 3000 });
      await B.locator(SEL.object(block.id)).filter({ hasText: "run();" }).waitFor({ timeout: 3000 });
      // Copy code: through a copy command (the frame cannot use navigator.clipboard).
      await A.locator("body").evaluate(() => {
        const orig = DataTransfer.prototype.setData;
        DataTransfer.prototype.setData = function (type, value) { window.__copied = [type, value]; return orig.call(this, type, value); };
      });
      await A.locator(".wb-stylebar .code-copy-btn").focus();
      await page.keyboard.press("Enter");
      const copied = await A.locator("body").evaluate(() => window.__copied ?? null);
      if (copied) assert.deepEqual(copied, ["text/plain", want]);
      else assert.equal(await A.locator(".wb-code-copy-dialog textarea").inputValue(), want, "fallback dialog shows the code");
    });
  });

  test("code block: agent addCode, pasting a fenced block, and language guessing on paste into an empty block", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames: { A, B } }) => {
      const { block } = await page.evaluate(() => window.harness.rpc("addCode", { by: "Agent", code: "SELECT id FROM users;", title: "q.sql" }));
      assert.equal(block.language, "sql");
      await B.locator(`${SEL.object(block.id)} .wb-code-head`, { hasText: "q.sql" }).first().waitFor({ timeout: 3000 });
      // A fenced Markdown block pasted onto the board becomes one Rust code block.
      await A.locator("body").evaluate(() => {
        const dt = new DataTransfer();
        dt.setData("text/plain", "```rust\nfn main() {\n    println!(\"hi\");\n}\n```");
        document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      const rust = await h.until(async () => Object.values((await h.serverBoard(page)).objects).find((o) => o.type === "code" && o.language === "rust"),
        { message: "fenced paste created a code block" });
      assert.equal(rust.text, "fn main() {\n    println!(\"hi\");\n}");
      await B.locator(SEL.object(rust.id)).waitFor({ timeout: 3000 });
      // Paste into a new empty block: the language is guessed.
      await h.inPane(A, (_, canvas) => { canvas.setSelection([]); canvas.element.focus(); });
      await page.keyboard.press("k");
      const editor = A.locator("textarea.wb-editor-code");
      await editor.waitFor({ timeout: 3000 });
      await editor.evaluate((ta) => {
        const dt = new DataTransfer();
        dt.setData("text/plain", "import os\n\ndef main():\n    print(os.getcwd())\n");
        ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await h.until(async () => Object.values((await h.serverBoard(page)).objects).some((o) => o.type === "code" && o.language === "python"),
        { message: "language guessed from the paste" });
      await h.until(async () => (await A.locator(".wb-stylebar .code-language-btn").getAttribute("aria-label")) === "Language: Python",
        { message: "the style bar shows the guessed language" });
      await page.keyboard.press("Escape");
    });
  });

  test("emoji picker: ARIA tabs, search, Enter adds a text object, skin tone, and the tab is remembered", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames: { A, B } }) => {
      await h.inPane(A, (_, canvas) => canvas.element.focus());
      await page.keyboard.press("i");
      const picker = A.locator(".icon-picker");
      await picker.waitFor({ timeout: 3000 });
      const tabs = picker.locator('[role="tablist"] [role="tab"]');
      assert.equal(await tabs.count(), 2);
      assert.equal(await tabs.nth(0).getAttribute("aria-selected"), "true", "icons first in a fresh session");
      assert.equal(await tabs.nth(1).getAttribute("tabindex"), "-1", "one Tab stop for the tabs");
      assert.ok(await picker.locator(".icon-search").evaluate((el) => el === document.activeElement), "search focused on open");
      // Shift+Tab reaches the selected tab; the arrow key moves to (and shows) the other one.
      await page.keyboard.press("Shift+Tab");
      assert.equal(await h.focusedClass(A), "picker-tab");
      await page.keyboard.press("ArrowRight");
      assert.equal(await tabs.nth(1).getAttribute("aria-selected"), "true");
      assert.equal(await tabs.nth(0).getAttribute("aria-selected"), "false");
      assert.ok(await tabs.nth(1).evaluate((el) => el === document.activeElement), "focus follows the arrow key");
      const panel = picker.locator("#wb-picker-panel-unicode");
      assert.equal(await panel.getAttribute("role"), "tabpanel");
      assert.equal(await panel.getAttribute("aria-labelledby"), "wb-picker-tab-unicode");
      assert.equal(await tabs.nth(1).getAttribute("aria-controls"), "wb-picker-panel-unicode");
      assert.ok(await panel.isVisible() && !(await picker.locator("#wb-picker-panel-icons").isVisible()), "only the selected panel shows");
      await page.keyboard.press("Home");
      assert.equal(await tabs.nth(0).getAttribute("aria-selected"), "true", "Home goes to the first tab");
      await page.keyboard.press("End");
      assert.equal(await tabs.nth(1).getAttribute("aria-selected"), "true", "End goes to the last tab");

      // Search and add with Enter: a text object sized for the emoji, in the middle of the view.
      await panel.locator(".char-search").focus();
      await page.keyboard.type("grinning face");
      assert.equal(await panel.locator(".char-pick").first().getAttribute("aria-label"), "Grinning face emoji");
      await page.keyboard.press("Enter");
      const grin = await h.until(async () => Object.values((await h.serverBoard(page)).objects).find((o) => o.text === "\u{1F600}"),
        { message: "emoji added" });
      assert.equal(grin.type, "text");
      assert.equal(grin.style.fontSize, 64);
      assert.equal(grin.style.align, "center");
      assert.ok(grin.w >= 64 && grin.w <= 100 && grin.h === 80, `box fitted to the glyph (${grin.w} x ${grin.h})`);
      await B.locator(SEL.object(grin.id)).waitFor({ timeout: 3000 });
      await h.until(async () => /Added grinning face/.test(await h.liveText(A)), { message: "insert announced" });

      // A skin tone applies to emoji that take one; arrow keys move in the results grid.
      await panel.locator(".skin-tone").selectOption("3");
      await panel.locator(".char-search").fill("thumbs up");
      await panel.locator(".char-search").press("ArrowDown");
      assert.equal(await h.focusedClass(A), "btn char-pick");
      await page.keyboard.press("Enter");
      await h.until(async () => Object.values((await h.serverBoard(page)).objects).some((o) => o.text === "\u{1F44D}\u{1F3FD}"),
        { message: "toned emoji added" });

      // Closing and reopening keeps the tab and the tone for the session.
      await page.keyboard.press("Escape");
      await picker.waitFor({ state: "detached" });
      await h.inPane(A, (_, canvas) => canvas.element.focus());
      await page.keyboard.press("i");
      await picker.waitFor();
      assert.equal(await tabs.nth(1).getAttribute("aria-selected"), "true", "reopens on Emoji & symbols");
      assert.equal(await panel.locator(".skin-tone").inputValue(), "3");
      assert.ok(await panel.locator(".char-search").evaluate((el) => el === document.activeElement));
      // Recently used comes first.
      assert.equal(await panel.locator(".char-grid h3").first().textContent(), "Recently used");
      await page.screenshot({ path: `${SHOTS}/emoji-picker.png` });
    });
  });

  test("emoji picker inserts into an active text edit at the caret (keyboard and click)", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames: { A, B } }) => {
      await A.locator(SEL.addButton).click();
      await A.locator(SEL.addItem("sticky")).click();
      await page.keyboard.type("Hello world");
      for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
      // Ctrl+. while typing opens Emoji & symbols without ending the edit.
      await page.keyboard.press("Control+.");
      const picker = A.locator(".icon-picker");
      await picker.waitFor({ timeout: 3000 });
      const panel = picker.locator("#wb-picker-panel-unicode");
      assert.ok(await panel.locator(".char-search").evaluate((el) => el === document.activeElement), "search focused");
      assert.equal(await A.locator("textarea.wb-editor").count(), 1, "the edit stays open");
      await page.keyboard.type("rocket");
      await page.keyboard.press("Enter");
      await h.until(async () => (await A.locator("textarea.wb-editor").inputValue()) === "Hello\u{1F680} world", { message: "inserted at the caret" });
      assert.equal(Object.values((await h.serverBoard(page)).objects).filter((o) => o.type === "text").length, 0, "no text object");
      // A symbol from a symbol group, by its Unicode name, goes in after it.
      await panel.locator(".char-search").fill("");
      await panel.locator(".char-filter").selectOption("symbol:arrows");
      await panel.locator(".char-search").fill("rightwards double arrow");
      await page.keyboard.press("Enter");
      await h.until(async () => (await A.locator("textarea.wb-editor").inputValue()) === "Hello\u{1F680}\u21D2 world", { message: "second insert after the first" });
      // Escape closes the picker and returns to typing; Escape again saves.
      await page.keyboard.press("Escape");
      await picker.waitFor({ state: "detached" });
      assert.ok(await A.locator("textarea.wb-editor").evaluate((el) => el === document.activeElement), "back in the editor");
      await page.keyboard.type("!");
      await page.keyboard.press("Escape");
      const sticky = await h.until(async () => Object.values((await h.serverBoard(page)).objects).find((o) => o.type === "sticky" && o.text.startsWith("Hello")),
        { message: "committed" });
      assert.equal(sticky.text, "Hello\u{1F680}\u21D2! world");
      await h.until(async () => (await paneObject(B, sticky.id))?.text === sticky.text, { message: "B has the text" });

      // With the picker already open, clicking a result while typing keeps the caret and the edit.
      await h.inPane(A, (_, canvas) => canvas.element.focus());
      await page.keyboard.press("i");
      await picker.waitFor();
      await panel.locator(".char-search").fill("red heart");
      await h.inPane(A, (_, canvas, id) => canvas.editText(id), sticky.id);
      await A.locator("textarea.wb-editor").waitFor();
      await page.keyboard.press("End");
      await panel.locator(".char-pick").first().click();
      await h.until(async () => (await A.locator("textarea.wb-editor").inputValue()).endsWith("world\u2764\uFE0F"), { message: "clicked emoji at the caret" });
      assert.ok(await A.locator("textarea.wb-editor").evaluate((el) => el === document.activeElement), "a click goes back to typing");
      // Clicking the canvas ends the edit as usual.
      const empty = await h.panePoint(page, "A", 200, 200);
      await page.mouse.click(empty.x, empty.y);
      await h.until(async () => (await h.serverBoard(page)).objects[sticky.id].text.endsWith("\u2764\uFE0F"), { message: "saved" });
      await page.screenshot({ path: `${SHOTS}/emoji-caret.png` });
    });
  });

  test("code block with emoji: Ctrl+. inserts at the code editor's caret, emoji in code render and export", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames: { A, B } }) => {
      await h.inPane(A, (_, canvas) => canvas.element.focus());
      await page.keyboard.press("k");
      const editor = A.locator("textarea.wb-editor-code");
      await editor.waitFor({ timeout: 3000 });
      await page.keyboard.type("print('hi')");
      for (let i = 0; i < 2; i++) await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("Control+.");
      const picker = A.locator(".icon-picker");
      await picker.waitFor({ timeout: 3000 });
      assert.equal(await editor.count(), 1, "the code edit stays open");
      await page.keyboard.type("rocket");
      await page.keyboard.press("Enter");
      await h.until(async () => (await editor.inputValue()) === "print('hi\u{1F680}')", { message: "inserted at the caret" });
      await page.keyboard.press("Escape");
      await picker.waitFor({ state: "detached" });
      assert.ok(await editor.evaluate((el) => el === document.activeElement), "back in the code editor");
      await page.keyboard.press("Escape");
      const block = await h.until(async () => Object.values((await h.serverBoard(page)).objects).find((o) => o.type === "code" && o.text.includes("\u{1F680}")),
        { message: "committed with the emoji" });
      assert.equal(block.text, "print('hi\u{1F680}')");
      // Emoji typed or pasted into code are kept, drawn by both panes and exported.
      const { block: other } = await page.evaluate(() => window.harness.rpc("addCode", { code: "# 🎉 done ✅\nx = '👩🏽‍💻'", language: "python" }));
      for (const f of [A, B]) {
        await f.locator(SEL.object(block.id)).filter({ hasText: "\u{1F680}" }).waitFor({ timeout: 3000 });
        await f.locator(SEL.object(other.id)).filter({ hasText: "👩🏽‍💻" }).waitFor({ timeout: 3000 });
      }
      const svg = await page.evaluate(() => window.harness.rpc("exportSvg", {}));
      assert.ok(svg.includes("👩🏽‍💻") && svg.includes("\u{1F680}"), "export keeps the emoji");
    });
  });
});

// Connector routes (src/shared/connectors.js, src/client/ui/canvas/route-edit.js): curves, route
// handles and their ghosts, keyboard route editing, reset, and elbows around obstacles.
describe("connector routes", { concurrency: false }, () => {
  /** Page-coordinate centre of an element in a pane. @param {import("playwright").Locator} loc */
  async function centreOf(loc) {
    const b = await loc.boundingBox();
    if (!b) throw new Error("not visible");
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }

  test("curved connector: drawn as an SVG cubic in both panes and the export, selectable on the curve", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames }) => {
      const { A, B } = frames;
      await alignCameras(frames);
      const [s1, s2] = await h.createObjects(page, [
        { type: "rect", x: 200, y: 200, w: 160, h: 100, text: "One" },
        { type: "rect", x: 700, y: 420, w: 160, h: 100, text: "Two" },
      ]);
      const [c] = await h.createObjects(page, [{ type: "connector", from: s1, to: s2, routing: "curved" }]);
      await waitObject(page, frames, c);
      for (const f of [A, B]) {
        const d = await f.locator(`${SEL.object(c)} path[data-hit]`).getAttribute("d");
        assert.match(d, /^M[\d.-]+ [\d.-]+C/, "a cubic path");
      }
      // Click on the curve at half its length (not on the straight chord).
      const at = await A.locator(`${SEL.object(c)} path[data-hit]`).evaluate((p) => {
        const path = /** @type {SVGPathElement} */ (p);
        const q = path.getPointAtLength(path.getTotalLength() / 2);
        const m = path.getScreenCTM();
        return { x: q.x * m.a + q.y * m.c + m.e, y: q.x * m.b + q.y * m.d + m.f };
      });
      const pane = await page.locator('iframe[data-pane="A"]').boundingBox();
      await page.mouse.click(pane.x + at.x, pane.y + at.y);
      await h.until(async () => (await h.inPane(A, (_, canvas) => canvas.getSelection()))[0] === c, { message: "curve selected" });
      await A.locator(".wb-route-handle[data-kind='curve']").waitFor({ timeout: 3000 });
      await A.locator(`${SEL.styleBar} [data-routing="curved"][aria-pressed="true"]`).waitFor();
      const svg = await page.evaluate(() => window.harness.rpc("exportSvg"));
      assert.match(svg, new RegExp(`data-id="${c}"[^>]*><path d="M[\\d.-]+ [\\d.-]+C`), "the export draws the same curve");
      await page.screenshot({ path: `${SHOTS}/routes-curved.png` });
    });
  });

  test("dragging an elbow's middle segment: B sees the ghost route, then the committed edit", async () => {
    await withHarness({ names: ["Alice", "Bob"] }, async ({ page, frames }) => {
      const { A, B } = frames;
      await alignCameras(frames);
      const [s1, s2] = await h.createObjects(page, [
        { type: "rect", x: 200, y: 200, w: 160, h: 100 },
        { type: "rect", x: 800, y: 450, w: 160, h: 100 },
      ]);
      const [c] = await h.createObjects(page, [{ type: "connector", from: s1, to: s2, routing: "elbow", fromSide: "right", toSide: "left" }]);
      await waitObject(page, frames, c);
      await h.inPane(A, (_, canvas, id) => canvas.setSelection([id]), c);
      const handle = A.locator(".wb-route-handle[data-kind='segment'][data-axis='x']").first();
      await handle.waitFor({ timeout: 3000 });
      const from = await centreOf(handle);
      await h.dragBy(page, from, 90, 40, {
        steps: 12, stepDelay: 25,
        hold: async () => {
          await B.locator(SEL.ghost(c)).first().waitFor({ timeout: 3000 });
          assert.equal((await h.serverBoard(page)).objects[c].segments, undefined, "no commit before release");
          await page.screenshot({ path: `${SHOTS}/routes-ghost.png` });
        },
      });
      const after = await h.until(async () => (await h.serverBoard(page)).objects[c].segments?.length && (await h.serverBoard(page)).objects[c],
        { message: "segments committed" });
      assert.equal(after.segments.length, 1);
      assert.ok(Math.abs(after.segments[0] - 90) <= 8, `moved about 90 across itself: ${after.segments}`);
      assert.deepEqual([after.fromSide, after.toSide], ["right", "left"]);
      await B.locator(SEL.anyGhost).waitFor({ state: "detached", timeout: 3000 });
      await h.until(async () => JSON.stringify((await paneObject(B, c))?.segments) === JSON.stringify(after.segments), { message: "B has the edit" });
      // One change, one undo.
      await A.locator(SEL.undo).click();
      await h.until(async () => !(await h.serverBoard(page)).objects[c].segments?.length, { message: "undone" });
    });
  });

  test("keyboard route editing: E, Tab, arrow keys, Delete resets and Escape finishes, with announcements", async () => {
    await withHarness({ panes: 1 }, async ({ page, frames: { A } }) => {
      await h.setCamera(A);
      const [s1, s2] = await h.createObjects(page, [
        { type: "rect", x: 200, y: 200, w: 160, h: 100 },
        { type: "rect", x: 800, y: 450, w: 160, h: 100 },
      ]);
      const [c] = await h.createObjects(page, [{ type: "connector", from: s1, to: s2, routing: "elbow", fromSide: "right", toSide: "left" }]);
      await A.locator(SEL.object(c)).waitFor();
      await h.inPane(A, (_, canvas, id) => { canvas.setSelection([id]); canvas.element.focus(); }, c);
      await page.keyboard.press("e");
      await h.until(async () => /Editing the route/.test(await h.liveText(A)), { message: "route editing announced" });
      // Tab to the vertical (x) segment.
      for (let i = 0; i < 4; i++) {
        const { index } = await h.inPane(A, (_, canvas) => canvas.getRouteEdit());
        const active = A.locator(`.wb-route-handle-active[data-route="${index}"]`);
        await active.waitFor({ timeout: 3000 });
        if (await active.getAttribute("data-axis") === "x") break;
        await page.keyboard.press("Tab");
      }
      assert.equal(await A.locator(".wb-route-handle-active").getAttribute("data-axis"), "x");
      assert.match(await h.focusedClass(A), /wb-canvas/, "Tab stays on the canvas while editing a route");
      await page.keyboard.press("Shift+ArrowRight");
      await page.keyboard.press("ArrowRight");
      const moved = await h.until(async () => (await h.serverBoard(page)).objects[c].segments?.[0] === 11 && (await h.serverBoard(page)).objects[c],
        { message: "segment moved by 11" });
      assert.deepEqual(moved.segments, [11]);
      await page.keyboard.press("Delete");
      await h.until(async () => {
        const o = (await h.serverBoard(page)).objects[c];
        return o && !o.segments?.length && o.fromSide === "auto" && o.toSide === "auto";
      }, { message: "route reset (the connector is not deleted)" });
      await page.keyboard.press("Escape");
      assert.equal(await h.inPane(A, (_, canvas) => canvas.getRouteEdit()), null);
      assert.deepEqual(await h.inPane(A, (_, canvas) => canvas.getSelection()), [c], "still selected");
      // The help lists the route keys.
      await page.keyboard.press("?");
      await A.locator(SEL.helpDialog).waitFor();
      assert.match(await A.locator(SEL.helpDialog).innerText(), /Editing a route/i);
    });
  });

  test("reset route from the style bar; Curved from the style bar; Edit route button", async () => {
    await withHarness({ panes: 1 }, async ({ page, frames: { A } }) => {
      await h.setCamera(A);
      const [s1, s2] = await h.createObjects(page, [
        { type: "rect", x: 200, y: 200, w: 160, h: 100 },
        { type: "rect", x: 800, y: 450, w: 160, h: 100 },
      ]);
      const [c] = await h.createObjects(page, [{ type: "connector", from: s1, to: s2, routing: "elbow", segments: [60], fromSide: "right", toSide: "left" }]);
      await A.locator(SEL.object(c)).waitFor();
      await h.inPane(A, (_, canvas, id) => canvas.setSelection([id]), c);
      const reset = A.locator(`${SEL.styleBar} .route-reset-btn`);
      await reset.waitFor();
      assert.equal(await reset.getAttribute("aria-label"), "Reset route");
      await reset.click();
      await h.until(async () => {
        const o = (await h.serverBoard(page)).objects[c];
        return !o.segments?.length && o.fromSide === "auto";
      }, { message: "route reset" });
      await A.locator(`${SEL.styleBar} .route-reset-btn`).waitFor({ state: "detached" });
      await A.locator(`${SEL.styleBar} [data-routing="curved"]`).click();
      await h.until(async () => (await h.serverBoard(page)).objects[c].routing === "curved", { message: "curved" });
      await A.locator(`${SEL.styleBar} .route-edit-btn`).click();
      assert.deepEqual(await h.inPane(A, (_, canvas) => canvas.getRouteEdit()), { id: c, index: 0 });
      assert.match(await h.focusedClass(A), /wb-canvas/, "focus moves to the canvas");
      await page.keyboard.press("Shift+ArrowUp");
      await h.until(async () => (await h.serverBoard(page)).objects[c].curve, { message: "curve handle moved from the keyboard" });
    });
  });

  test("an automatic elbow routes around an object in the way, in the pane and the export alike", async () => {
    await withHarness({ panes: 1 }, async ({ page, frames: { A } }) => {
      await h.setCamera(A);
      const [s1, s2, block] = await h.createObjects(page, [
        { type: "rect", x: 100, y: 300, w: 120, h: 100 },
        { type: "rect", x: 800, y: 300, w: 120, h: 100 },
        { type: "sticky", x: 420, y: 260, w: 180, h: 180, text: "In the way" },
      ]);
      const [c] = await h.createObjects(page, [{ type: "connector", from: s1, to: s2, routing: "elbow" }]);
      await A.locator(SEL.object(c)).waitFor();
      const d = await A.locator(`${SEL.object(c)} path[data-hit]`).getAttribute("d");
      const pts = [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
      assert.ok(pts.length > 2, "bends");
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        assert.ok(a.x === b.x || a.y === b.y, "orthogonal");
        const crosses = Math.max(Math.min(a.x, b.x), 420) < Math.min(Math.max(a.x, b.x), 600) &&
          Math.max(Math.min(a.y, b.y), 260) < Math.min(Math.max(a.y, b.y), 440);
        assert.ok(!crosses, `segment ${JSON.stringify([a, b])} avoids the sticky`);
      }
      const svg = await page.evaluate(() => window.harness.rpc("exportSvg"));
      assert.ok(svg.includes(`d="${d}"`), "the export routes the same way");
      // Move the sticky out of the way: the connector straightens (it is re-routed, not the sticky's connector).
      const o = (await h.serverBoard(page)).objects[block];
      await page.evaluate(({ id, v }) => window.harness.apply({ by: "Agent", objectOps: [{ op: "update", id, baseVersion: v, patch: { y: 1200 } }] }), { id: block, v: o.version });
      await h.until(async () => {
        const d2 = await A.locator(`${SEL.object(c)} path[data-hit]`).getAttribute("d");
        return [...d2.matchAll(/[ML]/g)].length <= 4;
      }, { message: "straight again once the sticky moved away" });
      await page.screenshot({ path: `${SHOTS}/routes-obstacle.png` });
    });
  });
});
