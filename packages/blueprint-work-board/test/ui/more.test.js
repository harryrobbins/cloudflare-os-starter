// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createBoardApp } from "../../src/client/ui/app.js";
import { createGadgetApi } from "../../src/server/api.js";
import { memoryStorage } from "../../src/server/documents.js";
import { FakeRecords } from "../fake-records.js";
import { ADA, NOW, axe, button, key, mount, row, settle, text, titles, unmountAll, until } from "./helpers.js";

afterEach(() => unmountAll());

const A = "cloudflare-os:ada@example.com";
/** @param {FakeRecords} fake */
const basic = (fake) => {
  fake.run("work.label.create", { key: "bug", name: "Bug", color: "#d92d20" }, { actor: A });
  fake.run("work.label.create", { key: "ui", name: "UI", color: "#5e6ad2" }, { actor: A });
  fake.run("work.create", { title: "Plan the launch", state: "todo", priority: 2, labels: ["bug"], assignee: A }, { actor: A });
  fake.run("work.create", { title: "Build the site", state: "in_progress", estimate: 3 }, { actor: "cloudflare-os:grace@example.com" });
  fake.run("work.create", { title: "Ship it", state: "done" }, { actor: A });
  fake.run("work.create", { title: "Write docs", state: "todo" }, { actor: A });
};
/** @param {Element} root @param {string} label */
const option = (root, label) => /** @type {HTMLElement|undefined} */ ([...root.querySelectorAll('[role="option"]')].find((o) => text(o).includes(label)));

describe("list layout", () => {
  it("is an ARIA grid with sortable headers and cell-level arrow navigation", async () => {
    const { root, app } = await mount({ records: basic });
    app.setLayout("list");
    await settle();
    const grid = /** @type {HTMLElement} */ (root.querySelector('[role="grid"]'));
    expect(grid.getAttribute("aria-label")).toBe("List: 4 items");
    expect([...grid.querySelectorAll('[role="columnheader"]')].map((c) => text(c))[0]).toBe("Key");
    const heads = () => [...grid.querySelectorAll('[role="columnheader"]')];
    expect(heads().find((c) => text(c).startsWith("Priority"))?.getAttribute("aria-sort")).toBe("ascending");
    /** @type {HTMLButtonElement} */ (heads().find((c) => text(c).startsWith("Priority"))?.querySelector("button"))?.click();
    await settle();
    expect(heads().find((c) => text(c).startsWith("Priority"))?.getAttribute("aria-sort")).toBe("descending");
    /** @type {HTMLButtonElement} */ (heads().find((c) => text(c).startsWith("Title"))?.querySelector("button"))?.click();
    await settle();
    expect(heads().find((c) => text(c).startsWith("Title"))?.getAttribute("aria-sort")).toBe("ascending");
    expect(heads().find((c) => text(c).startsWith("Priority"))?.getAttribute("aria-sort")).toBe("none");
    key(document.body, "ArrowDown");
    await settle();
    let cell = /** @type {HTMLElement} */ (document.activeElement);
    expect(cell.getAttribute("role")).toBe("gridcell");
    key(cell, "ArrowRight");
    await settle();
    cell = /** @type {HTMLElement} */ (document.activeElement);
    expect(cell.classList.contains("col-state")).toBe(true);
    key(cell, "Enter");
    await settle();
    expect(root.querySelector("aside.detail")?.hidden).toBe(false);
    expect(await axe(root)).toEqual([]);
  });
});

describe("focus and sync", () => {
  it("keeps focus on the same card element when someone else's change arrives", async () => {
    const { root, fake, app } = await mount({ records: basic });
    key(document.body, "j");
    await settle();
    const card = document.activeElement;
    expect(card?.getAttribute("aria-label")).toMatch(/^TW-1:/);
    const r = row(fake, 1);
    fake.run("work.update", { id: r.id, title: "Write the docs" }, { actor: "cloudflare-os:linus@example.com", revision: r.revision });
    await app.store.pull();
    await settle();
    expect(document.activeElement).toBe(card);
    expect(card?.getAttribute("aria-label")).toMatch(/^TW-1: Write the docs/);
    expect(titles(root, "todo")).toContain("Write the docs");
  });

  it("follows the focused card when its committed state moves it to another column", async () => {
    const { fake, app } = await mount({ records: basic });
    key(document.body, "j");
    await settle();
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^TW-1:/);
    const r = row(fake, 1);
    fake.run("work.update", { id: r.id, state: "in_review" }, { actor: "cloudflare-os:linus@example.com", revision: r.revision });
    await app.store.pull();
    await settle();
    expect(app.boardFocus).toMatchObject({ col: "in_review" });
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^TW-1: .*State In Review/);
  });

  it("re-snapshots after a permission epoch change and announces nothing alarming", async () => {
    const { fake, app, root } = await mount({ records: basic });
    fake.setEpoch(2);
    await app.store.pull();
    await settle();
    expect(app.store.sync.reset).toBe(1);
    expect(titles(root, "todo").length).toBe(2);
  });

  it("resumes following pending changes after the frame reloads (window.name)", async () => {
    const fake = new FakeRecords({ approval: "manual", now: () => NOW });
    basic(fake);
    let name = "";
    const persist = { get: () => name, set: (v) => { name = v; } };
    const make = async () => {
      const api = createGadgetApi({ getEnv: () => ({ RECORDS: fake.session() }), storage: memoryStorage(), now: () => NOW });
      const gadget = { ...api, $createViewerAssertion: async (b, d) => fake.createViewerAssertion(ADA.id, b, d) };
      const root = document.createElement("div");
      document.body.replaceChildren(root);
      const app = createBoardApp({ gadget, root, viewer: ADA, now: () => NOW, persist, timers: { visibleMs: 60_000, hiddenMs: 60_000, outcomeMs: 5, historyMs: 5 } });
      await app.ready;
      return app;
    };
    const first = await make();
    first.store.updateItem(first.store.index().byNumber.get(1), { priority: 1 }, { label: "Make TW-1 urgent" });
    await until(() => first.store.changes[0]?.status === "pending");
    expect(JSON.parse(name)["wb-pending"]).toHaveLength(1);
    first.destroy();
    const second = await make();
    expect(second.store.changes).toHaveLength(1);
    expect(second.store.changes[0]).toMatchObject({ status: "pending", label: "Make TW-1 urgent" });
    fake.approveAll();
    await until(() => second.store.changes[0]?.status === "applied");
    second.destroy();
  });
});

describe("menus and pickers", () => {
  it("moves a card with the Move menu (single pointer, no drag)", async () => {
    const { root, fake } = await mount({ records: basic });
    const card = /** @type {HTMLElement} */ (root.querySelector('ul.cell[data-col="done"] article.card'));
    /** @type {HTMLElement} */ (card.querySelector(".card-menu")).click();
    await settle();
    expect(text(root.querySelector(".picker-title"))).toBe("Move TW-3");
    option(root, "Canceled")?.click();
    await until(() => row(fake, 3).data.state === "canceled");
  });

  it("edits labels with a multi-select picker in one command, including a new label", async () => {
    const { root, fake, app } = await mount({ records: basic, approval: "manual" });
    app.openDetail(app.store.index().byNumber.get(1), { focus: true });
    await settle();
    const labels = [...root.querySelectorAll(".prop-value")].find((b) => text(b).includes("Bug"));
    /** @type {HTMLElement} */ (labels).click();
    await settle();
    const list = root.querySelector('[role="listbox"]');
    expect(list?.getAttribute("aria-multiselectable")).toBe("true");
    option(root, "UI")?.click();
    option(root, "Bug")?.click();
    const input = /** @type {HTMLInputElement} */ (root.querySelector(".picker-input"));
    input.value = "customer";
    input.dispatchEvent(new Event("input"));
    await settle();
    option(root, "Create label “customer”")?.click();
    key(input, "Escape");
    await until(() => fake.pendingActions().length === 1);
    expect(fake.pendingActions()[0].input.labels).toEqual(["ui", "customer"]);
  });

  it("sets a due date from typed text", async () => {
    const { root, fake, app } = await mount({ records: basic });
    app.openDetail(app.store.index().byNumber.get(2), { focus: true });
    await settle();
    const due = [...root.querySelectorAll(".prop-value")].find((b) => text(b).includes("No due date"));
    /** @type {HTMLElement} */ (due).click();
    await settle();
    const input = /** @type {HTMLInputElement} */ (root.querySelector(".picker-input"));
    input.value = "2026-10-30";
    input.dispatchEvent(new Event("input"));
    await settle();
    key(input, "Enter");
    await until(() => row(fake, 2).data.due_date === "2026-10-30");
  });
});

describe("board chrome", () => {
  it("collapses a column, shows WIP over the limit, and explains empty filtered results", async () => {
    const { root, fake, app } = await mount({ records: (f) => {
      basic(f);
      const s = [...f.rows.values()].find((r) => r.entity === "workflow_state" && r.data.key === "todo");
      f.run("work.state.update", { id: s.id, wip_limit: 1 }, { actor: A, revision: s.revision });
    } });
    const head = /** @type {HTMLElement} */ (root.querySelector('.col-head[data-col="todo"]'));
    expect(head.classList.contains("over-wip")).toBe(true);
    expect(text(head)).toContain("2 items, WIP limit 1, over the limit");
    button(root, "Collapse Todo")?.click();
    await settle();
    expect(root.querySelector('.col-head[data-col="todo"]')?.classList.contains("collapsed")).toBe(true);
    expect(root.querySelector('ul.cell[data-col="todo"]')?.getAttribute("aria-hidden")).toBe("true");
    app.loadView({ ...app.view, id: null, name: "Nothing", query: "title:zzz" });
    await settle();
    expect(text(root.querySelector(".empty-overlay"))).toContain("No items match this filter.");
    button(root, "Clear the filter")?.click();
    await settle();
    expect(app.view.query).toBe("");
    void fake;
  });

  it("shows friendly states for unconnected, wrong-module and oversized datastores", async () => {
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    const app = createBoardApp({ gadget: { getSetup: async () => ({ connected: false }) }, root, viewer: ADA, persist: null });
    await app.ready;
    expect(text(root)).toContain("Connect a work datastore");
    app.destroy();
    const fake = new FakeRecords({ now: () => NOW });
    const api = createGadgetApi({ getEnv: () => ({ RECORDS: fake.session() }), storage: memoryStorage() });
    const big = createBoardApp({ gadget: { ...api, snapshot: async () => { throw new Error("too_large: more than 5000"); } }, root, viewer: ADA, persist: null });
    await big.ready;
    expect(text(root)).toContain("This datastore is too large for a board");
    big.destroy();
  });
});
