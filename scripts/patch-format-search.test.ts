import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { parseArchive } from "../packages/blueprint-kanban/scripts/archive.mjs";
import {
  FORMATS, FORMATS_DIR, MARKER, PATCH_VERSION, PatchError, UPSTREAM_DIR, patchPair, patchServer,
  patchedRevision,
} from "./patch-format-search.mjs";

const NAMES = Object.keys(FORMATS) as string[];
const scratch = await mkdtemp(join(tmpdir(), "patch-format-search-"));
after(() => rm(scratch, { recursive: true, force: true }));

function showAtSubmoduleHead(file: string) {
  return execFileSync("git",
    ["-C", "cloudflare-os", "show", `HEAD:packages/workshop-backend/format-blueprints/${file}`],
    { maxBuffer: 64 * 1024 * 1024 });
}

/** The pristine upstream pair as committed at the submodule's HEAD, not the working tree. */
function upstreamAtHead(name: string) {
  const show = showAtSubmoduleHead;
  return { archive: new Uint8Array(show(`${name}.gadget`)), sidecar: show(`${name}.json`).toString("utf8") };
}

async function committedPair(name: string) {
  return {
    archive: new Uint8Array(await readFile(join(FORMATS_DIR, `${name}.gadget`))),
    sidecar: await readFile(join(FORMATS_DIR, `${name}.json`), "utf8"),
  };
}

test("formats/ holds exactly what patching upstream's pairs produces", async () => {
  for (const name of NAMES) {
    const archive = new Uint8Array(await readFile(join(UPSTREAM_DIR, `${name}.gadget`)));
    const sidecar = await readFile(join(UPSTREAM_DIR, `${name}.json`), "utf8");
    const result = patchPair(name, archive, sidecar);
    const committed = await committedPair(name);
    assert.equal(result.alreadyPatched, false, name);
    assert.ok(Buffer.from(result.archive).equals(Buffer.from(committed.archive)),
      `formats/${name}.gadget is stale; run node scripts/patch-format-search.mjs`);
    assert.equal(result.sidecar, committed.sidecar, `formats/${name}.json is stale`);
    assert.equal(JSON.parse(committed.sidecar).revision, patchedRevision(JSON.parse(sidecar).revision));
  }
});

test("each patched archive decodes, keeps its files, and its server.js parses", async () => {
  for (const name of NAMES) {
    const { archive, sidecar } = await committedPair(name);
    const { metadata, files } = parseArchive(archive);
    const upstream = parseArchive(new Uint8Array(await readFile(join(UPSTREAM_DIR, `${name}.gadget`))));
    assert.deepEqual(Object.keys(files).toSorted(), Object.keys(upstream.files).toSorted(), name);
    assert.equal(files["client.js"], upstream.files["client.js"], `${name}: client.js untouched`);
    assert.equal(files["README.md"], upstream.files["README.md"], `${name}: README.md untouched`);
    assert.equal(metadata.version, JSON.parse(sidecar).revision, `${name}: archive version = revision`);
    assert.deepEqual(metadata.bindings, {}, `${name}: no binding declared (SEARCH is wired, not required)`);
    assert.ok(files["server.js"].includes(`// ${MARKER} v${PATCH_VERSION}`), name);
    assert.ok(files["server.js"].startsWith(upstream.files["server.js"].split("\n")[0]), name);

    const file = join(scratch, `${name}.server.mjs`);
    await writeFile(file, files["server.js"]);
    const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(check.status, 0, `${name}: node --check failed\n${check.stderr}`);
  }
});

test("a fresh upstream pair from the submodule's HEAD patches cleanly, and patching is idempotent", () => {
  for (const name of NAMES) {
    const upstream = upstreamAtHead(name);
    const once = patchPair(name, upstream.archive, upstream.sidecar);
    assert.equal(once.alreadyPatched, false);
    const again = patchPair(name, upstream.archive, upstream.sidecar);
    assert.ok(Buffer.from(once.archive).equals(Buffer.from(again.archive)), `${name}: deterministic`);
    const twice = patchPair(name, once.archive, once.sidecar);
    assert.equal(twice.alreadyPatched, true, name);
    assert.ok(Buffer.from(twice.archive).equals(Buffer.from(once.archive)), `${name}: no-op when patched`);
    assert.equal(twice.sidecar, once.sidecar);

    const server = parseArchive(upstream.archive).files["server.js"];
    const patched = patchServer(name, server);
    assert.equal(patchServer(name, patched), patched);
    assert.equal(patched.split(`// ${MARKER}`).length - 1, 3, `${name}: two hooks and the runtime header`);
  }
});

test("every push is guarded by typeof env.SEARCH and never reaches the save path", async () => {
  for (const name of NAMES) {
    const { files } = parseArchive((await committedPair(name)).archive);
    const server: string = files["server.js"];
    const injected = server.slice(server.indexOf(`// ${MARKER} v`));
    // The only call into SEARCH sits after the guard, inside the try of the flush.
    assert.equal(injected.split("env.SEARCH.put(").length - 1, 1);
    assert.ok(!server.includes("SEARCH.remove"), "no format has a delete path");
    const flush = injected.slice(injected.indexOf("async function __cfosSearchFlush"));
    assert.ok(flush.indexOf('typeof env.SEARCH === "undefined"') < flush.indexOf("env.SEARCH.put("));
    assert.ok(flush.indexOf("try {") < flush.indexOf("env.SEARCH.put("));
    // Hooks only schedule; they never await.
    for (const line of server.split("\n").filter((l) => l.includes(`// ${MARKER}`) && l.includes("__cfosSearchSchedule"))) {
      assert.ok(!line.includes("await"), line);
    }
  }
});

test("refuses loudly when an upstream anchor moved, and on another patch version", async () => {
  const { files } = parseArchive(new Uint8Array(await readFile(join(UPSTREAM_DIR, "workspace-slides.gadget"))));
  const server: string = files["server.js"];
  assert.throws(() => patchServer("workspace-slides", server.replace("  async #broadcast(deck) {\n", "  async #send(deck) {\n")),
    (err: Error) => err instanceof PatchError && /#broadcast\(deck\).*found 0 times/.test(err.message));
  assert.throws(() => patchServer("workspace-slides", server + "\n  async subscribe(cb) {\n"),
    (err: Error) => err instanceof PatchError && /found 2 times/.test(err.message));
  assert.throws(() => patchServer("workspace-slides", server.replace("function initialDeck() {", "function starterDeck() {")),
    (err: Error) => err instanceof PatchError && /upstream server\.js changed/.test(err.message));
  const older = patchServer("workspace-slides", server).replace(`${MARKER} v${PATCH_VERSION}`, `${MARKER} v0`);
  assert.throws(() => patchServer("workspace-slides", older), /v0, not v1/);
  assert.throws(() => patchServer("workspace-wave", server), /not a format/);
});

// ---------------------------------------------------------------------------
// Running the patched server.js against a fake runtime
// ---------------------------------------------------------------------------

const FAKE_RUNTIME = `class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
class WorkerEntrypoint {}`;

async function loadGadget(name: string) {
  const { files } = parseArchive((await committedPair(name)).archive);
  const source = (files["server.js"] as string).replace(
    'import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";', FAKE_RUNTIME);
  assert.ok(!source.includes("cloudflare:workers"), `${name}: runtime import replaced`);
  const file = join(scratch, `${name}.run.${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(file, source);
  return (await import(pathToFileURL(file).href)).Gadget;
}

function fakeCtx() {
  const data = new Map<string, unknown>();
  return {
    data,
    storage: {
      async get(key: string) { return data.has(key) ? structuredClone(data.get(key)) : undefined; },
      async put(key: string, value: unknown) { data.set(key, structuredClone(value)); },
      async delete(key: string) { return data.delete(key); },
    },
  };
}

const subscriber = {
  dup() { return { onRpcBroken() {}, async presence() {}, async operation() {}, deckChanged() {} }; },
};

async function settle(t: TestContext, ms = 3000) {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(ms);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

function searchRecorder() {
  const puts: Array<Record<string, unknown>> = [];
  return { puts, SEARCH: { async put(doc: Record<string, unknown>) { puts.push(doc); } } };
}

test("Docs: pushes debounced plain text; unbound and failing SEARCH never break a save", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const Gadget = await loadGadget("workspace-docs");

  const unbound = new Gadget(fakeCtx(), {});
  const saved = await unbound.setDocument({ title: "Plan", blocks: [{ id: "a", html: "<p>x</p>" }] });
  assert.equal(saved.revision, 1);
  await settle(t);
  assert.equal(unbound.__cfosSearch, undefined, "unbound instance schedules nothing");

  const warn = t.mock.method(console, "warn", () => {});
  const failing = new Gadget(fakeCtx(), { SEARCH: { put() { throw new Error("boom"); } } });
  assert.equal((await failing.setDocument({ title: "Plan", blocks: [{ id: "a", html: "<p>x</p>" }] })).revision, 1);
  await settle(t);
  assert.equal(warn.mock.callCount(), 1);
  assert.equal((await failing.applyOperation({ upserts: [{ id: "b", html: "<p>y</p>" }] })).status, "applied");

  const { puts, SEARCH } = searchRecorder();
  const ctx = fakeCtx();
  const gadget = new Gadget(ctx, { SEARCH });
  await gadget.initializeBlocks({ blocks: [], title: "Untitled document" });
  await settle(t);
  assert.equal(puts.length, 0, "a blank new document is not indexed");

  await gadget.setDocument({
    title: "Quarterly plan",
    blocks: [{ id: "h", html: "<h1>Goals</h1>" }, { id: "p", html: "<p>Revenue &amp; costs<br>next&nbsp;year</p>" }],
  });
  await gadget.applyOperation({ upserts: [{ id: "q", html: "<ul><li>One</li><li>Two</li></ul>" }] });
  await settle(t);
  assert.equal(puts.length, 1, "two quick edits, one push");
  assert.match(String(puts[0].externalId), /^doc:[0-9a-f-]{36}$/);
  assert.equal(ctx.data.get("cfos-search:externalId"), puts[0].externalId);
  assert.deepEqual({ ...puts[0], externalId: undefined, updatedAt: undefined }, {
    externalId: undefined, updatedAt: undefined, kind: "doc", title: "Quarterly plan",
    body: "Goals\n\nRevenue & costs\nnext year\n\nOne\nTwo",
  });

  // Reopening an unchanged document does not push again; an edit reuses the same id.
  await gadget.subscribe(subscriber, {});
  await settle(t);
  assert.equal(puts.length, 1);
  await gadget.setDocument({ title: "Quarterly plan v2", blocks: [] });
  await settle(t);
  assert.equal(puts.length, 2);
  assert.equal(puts[1].externalId, puts[0].externalId);
  assert.equal(puts[1].body, "", "cleared content re-pushes empty once indexed");

  // An instance edited before SEARCH was wired is indexed the next time it is opened: wiring a
  // binding restarts the facet with a new env over the same storage.
  const storage = fakeCtx();
  await new Gadget(storage, {}).setDocument({ title: "Older notes", blocks: [{ id: "a", html: "<p>kept</p>" }] });
  await settle(t);
  await new Gadget(storage, { SEARCH }).subscribe(subscriber, {});
  await settle(t);
  assert.equal(puts.length, 3);
  assert.equal(puts[2].title, "Older notes");
  assert.equal(puts[2].body, "kept");
});

test("Docs: a continuous edit is pushed within the max wait", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const Gadget = await loadGadget("workspace-docs");
  const { puts, SEARCH } = searchRecorder();
  const gadget = new Gadget(fakeCtx(), { SEARCH });
  for (let i = 0; i < 20; i++) {
    await gadget.setDocument({ title: "Live", blocks: [{ id: "a", html: `<p>edit ${i}</p>` }] });
    await settle(t, 2000);
  }
  assert.ok(puts.length >= 1, "pushed during a 40 s burst of edits 2 s apart");
});

test("Sheets: a readable cell dump, formulas skipped", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const Gadget = await loadGadget("workspace-sheets");
  const { puts, SEARCH } = searchRecorder();
  const gadget = new Gadget(fakeCtx(), { SEARCH });
  const doc = await gadget.subscribe(subscriber, {});
  await settle(t);
  assert.equal(puts.length, 0, "an empty new sheet is not indexed");
  const sheetId = doc.sheetOrder[0];
  const result = await gadget.applyOperation({
    structure: { title: "Budget", sheetOrder: doc.sheetOrder, sheets: doc.sheets },
    cellOps: [
      { sheetId, ref: "B1", value: "Total" }, { sheetId, ref: "A1", value: "Item" },
      { sheetId, ref: "A2", value: "Widgets" }, { sheetId, ref: "B2", value: "=SUM(1,2)" },
      { sheetId, ref: "AA10", value: "far  away" },
    ],
  });
  assert.equal(result.status, "applied");
  await settle(t);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].kind, "sheet");
  assert.equal(puts[0].title, "Budget");
  assert.equal(puts[0].body, "## Sheet1\nItem | Total\nWidgets\nfar away");

  const unbound = new Gadget(fakeCtx(), {});
  const d = await unbound.getDocument();
  assert.equal((await unbound.applyOperation({ cellOps: [{ sheetId: d.sheetOrder[0], ref: "A1", value: "x" }] })).status, "applied");
  await settle(t);
  assert.equal(unbound.__cfosSearch, undefined);
});

test("Slides: slide titles and text, the untouched starter deck skipped", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const Gadget = await loadGadget("workspace-slides");
  const { puts, SEARCH } = searchRecorder();
  const gadget = new Gadget(fakeCtx(), { SEARCH });
  const deck = await gadget.getDeck();
  await gadget.subscribe(subscriber);
  await settle(t);
  assert.equal(puts.length, 0, "the starter deck is not indexed");

  const cover = deck.slides[0];
  const title = cover.blocks.find((b: { type: string }) => b.type === "title");
  await gadget.updateBlock(cover.id, title.id, { props: { text: "Launch <b>plan</b>" } });
  await gadget.addBlock(deck.slides[1].id, { type: "card", props: { eyebrow: "01", title: "Risks", body: "Supply\nchain" } });
  await settle(t);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].kind, "slides");
  assert.equal(puts[0].title, "Launch plan");
  const body = String(puts[0].body);
  assert.ok(body.startsWith("Slide 1: Launch plan\nPress E to edit."), body);
  assert.ok(body.includes("Slide 2: One canvas gives you everything"), body);
  assert.ok(body.includes("01\nRisks\nSupply\nchain"), body);
  assert.ok(!body.includes("<svg"), "svg markup is not indexed");
  assert.ok(!body.includes("Workspace\n"), "logo wordmarks are not indexed");

  await gadget.undo();
  await settle(t);
  assert.equal(puts.length, 2, "undo is a change too");

  const warn = t.mock.method(console, "warn", () => {});
  const failing = new Gadget(fakeCtx(), { SEARCH: { put: async () => { throw new Error("down"); } } });
  const d2 = await failing.getDeck();
  await failing.removeSlide(d2.slides[0].id);
  assert.equal((await failing.getDeck()).slides.length, d2.slides.length - 1);
  await settle(t);
  assert.equal(warn.mock.callCount(), 1);
});
