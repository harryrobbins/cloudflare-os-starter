import { describe, expect, it, vi } from "vitest";
import { FakeRecords } from "./fake-records.js";

// documents.js validates view queries with WQL; skip cleanly while that module is absent.
const wqlReady = await import("../src/shared/wql/index.js").then((m) => typeof m.parse === "function", () => false);
const { createDocuments, memoryStorage, normalisePrefs, registerLayout, DOC_LIMITS } = wqlReady ? await import("../src/server/documents.js") : /** @type {any} */ ({});
const { createGadgetApi, RPC_METHODS } = wqlReady ? await import("../src/server/api.js") : /** @type {any} */ ({});

const ADA = "cloudflare-os:ada@example.com";
const view = (extra = {}) => ({ id: "mine", name: "My issues", query: "assignee:me", ...extra });

describe.skipIf(!wqlReady)("server documents: views", () => {
  const docs = () => { let t = Date.parse("2026-09-26T10:00:00Z"); return createDocuments(memoryStorage(), { now: () => (t += 1000) }); };

  it("saves, normalises, lists and deletes views", async () => {
    const d = docs();
    const saved = await d.saveView({ ...view(), name: "  My issues  ", extra: "dropped" }, { actor: ADA });
    expect(saved).toMatchObject({
      id: "mine", name: "My issues", query: "assignee:me", layout: "board", columnsBy: "state", swimlanesBy: null, sort: [], shared: true,
      created_by: ADA, updated_by: ADA, version: 1,
      display: { density: "comfortable", showSubIssues: true, showArchived: false, hideEmptyLanes: false },
    });
    expect(saved.extra).toBeUndefined();
    await d.saveView(view({ id: "b", name: "Bugs", query: "label:bug", layout: "list", swimlanesBy: "assignee", sort: [{ field: "priority" }, { field: "updated", dir: "desc" }] }));
    const list = await d.listViews();
    expect(list.map((v) => v.id)).toEqual(["mine", "b"]);
    expect(list[1].sort).toEqual([{ field: "priority", dir: "asc" }, { field: "updated", dir: "desc" }]);
    const again = await d.saveView(view({ name: "Renamed" }), { actor: "cloudflare-os:bob@example.com" });
    expect(again).toMatchObject({ version: 2, created_by: ADA, updated_by: "cloudflare-os:bob@example.com", created_at: saved.created_at });
    expect(await d.deleteView("mine")).toEqual({ deleted: "mine" });
    await expect(d.deleteView("mine")).rejects.toThrow(/^not_found/);
    await expect(d.deleteView("../x")).rejects.toThrow(/^invalid_request/);
  });

  it.each([
    ["no id", { id: undefined }], ["bad id", { id: "Has Space" }], ["long id", { id: "x".repeat(65) }], ["empty name", { name: "  " }],
    ["long name", { name: "n".repeat(81) }], ["name not text", { name: 5 }], ["unknown layout", { layout: "gantt" }],
    ["bad columnsBy", { columnsBy: "DROP TABLE" }], ["bad swimlanesBy", { swimlanesBy: "a b" }], ["too many sorts", { sort: Array(6).fill({ field: "priority" }) }],
    ["bad sort field", { sort: [{ field: "" }] }], ["long query", { query: "a".repeat(2001) }], ["query error", { query: "prority:high" }],
    ["unbalanced query", { query: "(label:bug" }], ["not an object", null],
  ])("refuses a view with %s", async (_, extra) => {
    const input = extra === null ? "nope" : view(extra);
    await expect(docs().saveView(input)).rejects.toThrow(/^invalid_request/);
  });

  it("accepts ext fields, registered layouts and clears empty swimlanes", async () => {
    registerLayout("insights");
    const v = await docs().saveView(view({ layout: "insights", columnsBy: "ext.customer", swimlanesBy: "" }));
    expect(v).toMatchObject({ layout: "insights", columnsBy: "ext.customer", swimlanesBy: null });
  });

  it("refuses stale overwrites and too many or too large views", async () => {
    const d = docs();
    const first = await d.saveView(view());
    await d.saveView(view({ name: "Other edit" }));
    await expect(d.saveView(view({ name: "Mine" }), { expectedVersion: first.version })).rejects.toThrow(/^conflict/);
    const storage = memoryStorage();
    for (let i = 0; i < DOC_LIMITS.views; i++) storage.map.set(`view:v${i}`, { id: `v${i}`, name: "x" });
    await expect(createDocuments(storage).saveView(view({ id: "one-more" }))).rejects.toThrow(/at most/);
    const huge = { properties: [], listColumns: Array.from({ length: 24 }, (_, i) => `ext.${"f".repeat(60)}${i}`) };
    const ok = await docs().saveView(view({ display: huge }));
    expect(ok.display.listColumns).toHaveLength(24);
  });

  it("filters display properties to known card properties without repeats", async () => {
    const v = await docs().saveView(view({ display: { density: "compact", properties: ["priority", "Not A Field!", "priority", 7], showArchived: true } }));
    expect(v.display).toMatchObject({ density: "compact", properties: ["priority"], showArchived: true });
  });
});

describe.skipIf(!wqlReady)("server documents: prefs and settings", () => {
  it("normalises and versions per-viewer prefs", async () => {
    const d = createDocuments(memoryStorage());
    expect(await d.getPrefs("ada@example.com")).toMatchObject({ shortcuts: true, lastViewId: null, version: 0 });
    const saved = await d.savePrefs("ada@example.com", { shortcuts: false, lastViewId: "mine", collapsedColumns: ["done", "done", 3], junk: 1 });
    expect(saved).toEqual({ shortcuts: false, lastViewId: "mine", draft: null, collapsedColumns: ["done"], collapsedLanes: [], reduceMotion: false, version: 1 });
    expect((await d.savePrefs("ada@example.com", {})).version).toBe(2);
    expect(await d.getPrefs("grace@example.com")).toMatchObject({ version: 0 });
    await expect(d.getPrefs("")).rejects.toThrow(/^invalid_request/);
    await expect(d.savePrefs(undefined, {})).rejects.toThrow(/^invalid_request/);
    expect(() => normalisePrefs({ draft: { text: "x".repeat(5000) } })).toThrow(/too large/);
    expect(normalisePrefs({ lastViewId: "Bad Id" }).lastViewId).toBeNull();
  });

  it("validates the key prefix", async () => {
    const d = createDocuments(memoryStorage());
    expect(await d.getSettings()).toEqual({ keyPrefix: null, version: 0 });
    expect(await d.saveSettings({ keyPrefix: "WEB" }, { actor: ADA })).toMatchObject({ keyPrefix: "WEB", version: 1, updated_by: ADA });
    for (const bad of ["w", "web", "1AB", "TOOLONGPREFIX", "A-B"]) await expect(d.saveSettings({ keyPrefix: bad })).rejects.toThrow(/^invalid_request/);
    expect((await d.saveSettings({ keyPrefix: "" })).keyPrefix).toBeNull();
  });
});

describe.skipIf(!wqlReady)("createGadgetApi over FakeRecords", () => {
  it("exposes every RPC method and passes Records calls through", async () => {
    const fake = new FakeRecords();
    fake.run("work.create", { title: "Hello" }, { actor: ADA });
    const session = fake.session();
    const api = createGadgetApi({ getEnv: () => ({ RECORDS: session }), storage: memoryStorage() });
    for (const name of RPC_METHODS) expect(typeof api[name]).toBe("function");
    const setup = await api.getSetup();
    expect(setup).toMatchObject({ connected: true, connection: { label: "Team work", access: "write" }, description: { module_id: "work" }, error: null });
    const snap = await api.snapshot(1000);
    expect(snap.records.filter((r) => r.entity === "work_item")).toHaveLength(1);
    expect((await api.changes(0, 1)).changes.length).toBe(fake.journal.length);
  });

  it("passes command arguments through by identity", async () => {
    const command = vi.fn(async () => ({ status: "pending", actionId: 1 }));
    const api = createGadgetApi({ getEnv: () => ({ RECORDS: { command } }), storage: memoryStorage() });
    const input = { title: "t" }, options = { viewerAssertion: "a", idempotencyKey: "k" };
    await api.command("work.create", input, options);
    expect(command.mock.calls[0][1]).toBe(input);
    expect(command.mock.calls[0][2]).toBe(options);
  });

  it("reports not connected without throwing", async () => {
    const api = createGadgetApi({ getEnv: () => ({}), storage: memoryStorage() });
    expect(await api.getSetup()).toMatchObject({ connected: false });
  });

  it("stores views and prefs through the API", async () => {
    const api = createGadgetApi({ getEnv: () => ({}), storage: memoryStorage() });
    await api.saveView(view(), { actor: ADA });
    expect((await api.listViews()).map((v) => v.name)).toEqual(["My issues"]);
    await api.savePrefs("ada@example.com", { shortcuts: false });
    expect((await api.getPrefs("ada@example.com")).shortcuts).toBe(false);
  });
});
