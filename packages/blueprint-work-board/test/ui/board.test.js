// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { axe, button, key, mount, row, settle, text, titles, unmountAll, until } from "./helpers.js";

afterEach(() => unmountAll());

/** @param {import("../fake-records.js").FakeRecords} fake */
const basic = (fake) => {
  fake.run("work.create", { title: "Plan the launch", state: "todo", priority: 2, labels: ["bug"], assignee: "cloudflare-os:ada@example.com" }, { actor: "cloudflare-os:ada@example.com" });
  fake.run("work.create", { title: "Build the site", state: "in_progress", estimate: 3 }, { actor: "cloudflare-os:grace@example.com" });
  fake.run("work.create", { title: "Ship it", state: "done" }, { actor: "cloudflare-os:ada@example.com" });
};

describe("board layout", () => {
  it("renders the seven default workflow states as columns with counts, and cards with keys", async () => {
    const { root } = await mount({ records: basic });
    const heads = [...root.querySelectorAll(".col-head .col-name")].map((e) => e.textContent);
    expect(heads).toEqual(["Triage", "Backlog", "Todo", "In Progress", "In Review", "Done", "Canceled"]);
    expect(titles(root, "todo")).toEqual(["Plan the launch"]);
    expect(titles(root, "in_progress")).toEqual(["Build the site"]);
    const card = root.querySelector('ul.cell[data-col="todo"] article.card');
    expect(card?.getAttribute("aria-label")).toMatch(/^TW-1: Plan the launch\. State Todo\. Assigned to Ada Lovelace\. Priority High/);
    expect(text(root.querySelector('.col-head[data-col="todo"]'))).toContain("1");
    expect(root.querySelectorAll("h1")).toHaveLength(1);
  });

  it("shows only Open/Active/Done on a v1-only datastore and still creates items", async () => {
    const { root, fake, app } = await mount({ planning: false, records: (f) => f.run("work.create", { title: "Old item", status: "active" }, { actor: "cloudflare-os:ada@example.com" }) });
    expect([...root.querySelectorAll(".col-head .col-name")].map((e) => e.textContent)).toEqual(["Open", "Active", "Done"]);
    expect(titles(root, "active")).toEqual(["Old item"]);
    expect(text(root)).toContain("basic work model");
    const r = app.store.createItem({ title: "New v1 item", status: "open" });
    expect(r.ok).toBe(true);
    await until(() => titles(root, "open").includes("New v1 item"));
    const created = [...fake.rows.values()].find((x) => x.data.title === "New v1 item");
    expect(Object.keys(created.data).sort()).toEqual(["description", "extensions", "status", "title"].sort());
    expect(app.store.createItem({ title: "x", priority: 1 })).toMatchObject({ ok: false });
  });

  it("puts a card into every label lane, marking copies, and counts lanes", async () => {
    const { root, app } = await mount({ records: (f) => {
      f.run("work.create", { title: "Two labels", state: "todo", labels: ["bug", "ui"] }, { actor: "cloudflare-os:ada@example.com" });
      f.run("work.create", { title: "No labels", state: "todo" }, { actor: "cloudflare-os:ada@example.com" });
    } });
    app.loadView({ ...app.view, id: null, name: "By label", swimlanesBy: "label" });
    await settle();
    const lanes = [...root.querySelectorAll("section.lane")].map((l) => l.getAttribute("data-lane"));
    expect(lanes).toEqual(["bug", "ui", "__none__"]);
    const copies = root.querySelectorAll("article.card.mirror");
    expect(copies).toHaveLength(1);
    expect(copies[0].getAttribute("aria-label")).toContain("Also shown in another lane");
    expect(text(root.querySelector('section.lane[data-lane="__none__"] .lane-head'))).toContain("No labels");
  });

  it("has no serious accessibility violations on the board, list and detail", async () => {
    const { root, app } = await mount({ seed: 40 });
    expect(await axe(root)).toEqual([]);
    app.setLayout("list");
    await settle();
    expect(await axe(root)).toEqual([]);
    const item = app.store.index().itemList.find((i) => (app.store.index().children.get(i.id)?.length ?? 0) > 0);
    app.openDetail(item, { focus: true });
    await settle();
    expect(await axe(root)).toEqual([]);
  });
});

describe("keyboard", () => {
  it("roves focus across cards and columns with arrows and j/k, keeping one tab stop", async () => {
    const { root } = await mount({ records: basic });
    const scroller = root.querySelector(".board-scroll");
    key(document.body, "ArrowDown");
    await settle();
    let active = /** @type {HTMLElement} */ (document.activeElement);
    expect(active.matches("article.card")).toBe(true);
    expect(active.getAttribute("aria-label")).toMatch(/^TW-1:/);
    expect(root.querySelectorAll('article.card[tabindex="0"]')).toHaveLength(1);
    key(active, "ArrowRight");
    await settle();
    active = /** @type {HTMLElement} */ (document.activeElement);
    expect(active.getAttribute("aria-label")).toMatch(/^TW-2: Build the site/);
    key(active, "ArrowRight");
    await settle();
    active = /** @type {HTMLElement} */ (document.activeElement);
    expect(active.matches("li.cell-empty")).toBe(true);
    expect(active.getAttribute("aria-label")).toContain("No items in In Review");
    key(active, "ArrowLeft");
    key(document.activeElement ?? document.body, "ArrowLeft");
    await settle();
    expect(/** @type {HTMLElement} */ (document.activeElement).getAttribute("aria-label")).toMatch(/^TW-1:/);
    key(document.activeElement ?? document.body, "Home");
    await settle();
    expect(document.activeElement?.getAttribute("aria-label")).toContain("No items in Triage");
    expect(root.querySelectorAll('[tabindex="0"]').length).toBeLessThanOrEqual(2);
    void scroller;
  });

  it("opens with Enter, peeks with Space and closes with Escape returning focus", async () => {
    const { root } = await mount({ records: basic });
    key(document.body, "j");
    await settle();
    const card = /** @type {HTMLElement} */ (document.activeElement);
    key(card, " ");
    await settle();
    expect(root.querySelector("aside.detail")?.hidden).toBe(false);
    expect(document.activeElement).toBe(card);
    key(card, " ");
    await settle();
    expect(root.querySelector("aside.detail")?.hidden).toBe(true);
    key(card, "Enter");
    await settle();
    expect(root.querySelector("aside.detail")?.contains(document.activeElement)).toBe(true);
    key(/** @type {HTMLElement} */ (document.activeElement), "Escape");
    await settle();
    expect(root.querySelector("aside.detail")?.hidden).toBe(true);
    expect(/** @type {HTMLElement} */ (document.activeElement).getAttribute("aria-label")).toMatch(/^TW-1:/);
  });

  it("moves a card with Shift+arrows, announcing the target, and commits with Enter", async () => {
    const { root, fake, app } = await mount({ records: basic, approval: "manual" });
    key(document.body, "j");
    await settle();
    const card = /** @type {HTMLElement} */ (document.activeElement);
    key(card, "ArrowRight", { shiftKey: true });
    await settle(40);
    expect(app.live.polite.textContent).toMatch(/Moving TW-1 to Todo/);
    key(document.activeElement ?? document.body, "ArrowRight");
    await settle(40);
    expect(app.live.polite.textContent).toMatch(/To TW-1 to In Progress/);
    expect(root.querySelector(".drop-target")).not.toBeNull();
    key(document.activeElement ?? document.body, "Enter");
    await until(() => fake.pendingActions().length === 1);
    const action = fake.pendingActions()[0];
    expect(action.input).toMatchObject({ id: row(fake, 1).id, state: "in_progress" });
    // Committed state is unchanged until approval; a ghost shows where the card will land.
    expect(titles(root, "todo")).toEqual(["Plan the launch"]);
    await until(() => root.querySelector('ul.cell[data-col="in_progress"] article.card.ghost'));
    fake.approveAll();
    await app.store.pull();
    await until(() => titles(root, "in_progress").includes("Plan the launch"));
    expect(root.querySelector("article.card.ghost")).toBeNull();
  });

  it("respects the single-key shortcut preference (2.1.4) but keeps arrows and Ctrl+K", async () => {
    const { root, app } = await mount({ records: basic });
    app.store.setPrefs({ shortcuts: false });
    key(document.body, "c");
    await settle();
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    key(document.body, "ArrowDown");
    await settle();
    expect(document.activeElement?.matches("article.card")).toBe(true);
    key(document.body, "k", { ctrlKey: true });
    await settle();
    expect(root.querySelector('.dialog.palette')).not.toBeNull();
  });

  it("never fires single keys while typing in the filter", async () => {
    const { root, app } = await mount({ records: basic });
    const input = /** @type {HTMLInputElement} */ (root.querySelector("#wb-wql"));
    input.focus();
    key(input, "c");
    await settle();
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    void app;
  });
});
