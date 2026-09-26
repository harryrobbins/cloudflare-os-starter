// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { axe, button, key, mount, row, settle, text, titles, unmountAll, until } from "./helpers.js";

afterEach(() => unmountAll());

const ADA = "cloudflare-os:ada@example.com";
/** @param {import("../fake-records.js").FakeRecords} fake */
const basic = (fake) => {
  fake.run("work.label.create", { key: "bug", name: "Bug", color: "#d92d20" }, { actor: ADA });
  fake.run("work.create", { title: "Plan the launch", state: "todo", priority: 2, labels: ["bug"], assignee: ADA }, { actor: ADA });
  fake.run("work.create", { title: "Build the site", state: "in_progress", estimate: 3 }, { actor: "cloudflare-os:grace@example.com" });
  fake.run("work.create", { title: "Ship it", state: "done" }, { actor: ADA });
  fake.run("work.cycle.create", { starts_on: "2026-09-21", ends_on: "2026-10-04" }, { actor: ADA });
};

/** @param {Element} root @param {string} label */
const option = (root, label) => /** @type {HTMLElement|undefined} */ ([...root.querySelectorAll('[role="option"]')].find((o) => text(o).includes(label)));

describe("quick create", () => {
  it("creates from inline tokens with smart defaults and shows the pending card until approval", async () => {
    const { root, fake, app } = await mount({ records: basic, approval: "manual" });
    key(document.body, "c");
    await settle();
    const dialog = /** @type {HTMLElement} */ (root.querySelector('[role="dialog"]'));
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const title = /** @type {HTMLInputElement} */ (dialog.querySelector(".create-title"));
    expect(document.activeElement).toBe(title);
    title.value = "Fix the login #bug @me !urgent ^current";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(text(dialog.querySelector(".token-preview"))).toContain("Label Bug");
    key(title, "Enter");
    await until(() => fake.pendingActions().length === 1);
    const { input } = fake.pendingActions()[0];
    expect(input).toMatchObject({ title: "Fix the login", labels: ["bug"], assignee: ADA, priority: 1, state: "todo" });
    expect(input.cycle).toMatch(/^[0-9a-f-]{36}$/);
    expect(input.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    await until(() => root.querySelector('ul.cell[data-col="todo"] article.card.ghost'));
    expect(text(root.querySelector("article.card.ghost"))).toContain("Awaiting approval");
    fake.approveAll();
    await app.store.pull();
    await until(() => titles(root, "todo").includes("Fix the login"));
    expect(row(fake, 4).id).toBe(input.id);
  });

  it("inherits the lane and column it was created in", async () => {
    const { root, fake, app } = await mount({ records: basic });
    app.loadView({ ...app.view, id: null, name: "Lanes", swimlanesBy: "priority" });
    await settle();
    app.runAction("create", { col: "in_review", lane: "1" });
    await settle();
    const title = /** @type {HTMLInputElement} */ (root.querySelector(".create-title"));
    expect(text(root.querySelector(".dialog-title"))).toBe("New item in In Review · Urgent");
    title.value = "Hot fix";
    key(title, "Enter");
    await until(() => [...fake.rows.values()].some((r) => r.data.title === "Hot fix"));
    expect([...fake.rows.values()].find((r) => r.data.title === "Hot fix").data).toMatchObject({ state: "in_review", priority: 1 });
  });

  it("closes with Escape and returns focus to the invoker", async () => {
    const { root } = await mount({ records: basic });
    const invoker = /** @type {HTMLButtonElement} */ (button(root, "New item"));
    invoker.focus();
    invoker.click();
    await settle();
    const title = /** @type {HTMLInputElement} */ (root.querySelector(".create-title"));
    key(title, "Escape");
    await settle();
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(invoker);
  });

  it("validates before sending", async () => {
    const { root, fake } = await mount({ records: basic });
    key(document.body, "c");
    await settle();
    const title = /** @type {HTMLInputElement} */ (root.querySelector(".create-title"));
    key(title, "Enter");
    await settle();
    expect(text(root.querySelector('[role="dialog"] .field-error'))).toBe("Enter a title.");
    expect(fake.pendingActions()).toHaveLength(0);
  });
});

describe("filtering and views", () => {
  it("applies valid WQL, reports errors with suggestions, and keeps the last valid filter", async () => {
    const { root, app } = await mount({ records: basic });
    const input = /** @type {HTMLInputElement} */ (root.querySelector("#wb-wql"));
    input.focus();
    input.value = "prority:high";
    input.dispatchEvent(new Event("input"));
    key(input, "Enter");
    await settle();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(text(root.querySelector(".wql-status"))).toMatch(/Unknown field .prority.*at character 1/);
    const fix = button(root, "Use “priority”");
    expect(fix).toBeDefined();
    fix?.click();
    await settle();
    expect(app.view.query).toBe("priority:high");
    expect(titles(root, "todo")).toEqual(["Plan the launch"]);
    expect(titles(root, "in_progress")).toEqual([]);
    expect(text(root.querySelector(".wql-status"))).toMatch(/1 item of 3/);
    // Chips round-trip: removing the chip clears the query.
    button(root, "Remove filter priority:high")?.click();
    await settle();
    expect(app.view.query).toBe("");
  });

  it("offers autocomplete as a combobox", async () => {
    const { root } = await mount({ records: basic });
    const input = /** @type {HTMLInputElement} */ (root.querySelector("#wb-wql"));
    input.focus();
    input.value = "assig";
    input.setSelectionRange(5, 5);
    input.dispatchEvent(new Event("input"));
    await settle();
    expect(input.getAttribute("aria-expanded")).toBe("true");
    key(input, "ArrowDown");
    expect(input.getAttribute("aria-activedescendant")).toBe("wb-wql-suggest-0");
    key(input, "Enter");
    await settle();
    expect(input.value).toBe("assignee:");
  });

  it("toggles quick filters and saves a shared view with layout and swimlanes", async () => {
    const { root, app, storage } = await mount({ records: basic });
    button(root, "My issues")?.click();
    await settle();
    expect(app.view.query).toBe("assignee:me");
    expect(root.querySelector(".view-switch.dirty")).not.toBeNull();
    app.loadView({ ...app.view, swimlanesBy: "priority", name: app.view.name, id: null });
    app.runAction("saveViewAs");
    await settle();
    const name = /** @type {HTMLInputElement} */ (root.querySelector("#wb-view-name"));
    name.value = "Ada's work";
    key(name, "Enter");
    await until(() => [...storage.map.keys()].some((k) => k.startsWith("view:")));
    const saved = [...storage.map.values()].find((v) => v.name === "Ada's work");
    expect(saved).toMatchObject({ query: "assignee:me", swimlanesBy: "priority", layout: "board", shared: true, created_by: ADA });
    expect(app.view.id).toBe(saved.id);
  });
});

describe("detail panel", () => {
  it("edits the title and properties, each as one command, and shows activity with names", async () => {
    const { root, fake, app } = await mount({ records: basic });
    const item = app.store.index().byNumber.get(1);
    app.openDetail(item, { focus: true });
    await settle();
    const title = /** @type {HTMLTextAreaElement} */ (root.querySelector(".title-edit"));
    title.value = "Plan the big launch";
    title.dispatchEvent(new Event("input"));
    key(title, "Enter");
    await until(() => row(fake, 1).data.title === "Plan the big launch");
    await app.store.pull();
    await settle();
    // Priority via the picker.
    const prio = [...root.querySelectorAll(".prop-value")].find((b) => text(b).includes("High"));
    /** @type {HTMLElement} */ (prio).click();
    await settle();
    const urgent = option(root, "Urgent");
    urgent?.click();
    await until(() => row(fake, 1).data.priority === 1);
    await app.store.pull();
    await settle();
    expect(text(root.querySelector(".timeline"))).toMatch(/Ada Lovelace renamed it to “Plan the big launch”/);
    expect(text(root.querySelector(".timeline"))).toMatch(/Ada Lovelace set priority to Urgent/);
    expect(await axe(root)).toEqual([]);
  });

  it("renders Markdown safely and comments, relations and sub-issues go through commands", async () => {
    const { root, fake, app } = await mount({ records: (f) => {
      basic(f);
      f.run("work.update", { id: [...f.rows.values()].find((r) => r.data.number === 1).id, description: "Hello **there** <img src=x onerror=alert(1)> [x](javascript:alert(1))" }, { actor: ADA, revision: [...f.rows.values()].find((r) => r.data.number === 1).revision });
    } });
    const item = app.store.index().byNumber.get(1);
    app.openDetail(item, { focus: true });
    await settle();
    const md = /** @type {HTMLElement} */ (root.querySelector(".detail .markdown"));
    expect(md.querySelector("strong")?.textContent).toBe("there");
    expect(md.querySelector("img")).toBeNull();
    expect(md.querySelector("a")).toBeNull();
    expect(md.textContent).toContain("<img src=x onerror=alert(1)>");
    const sub = /** @type {HTMLInputElement} */ (root.querySelector(".inline-add"));
    sub.value = "Write the announcement";
    key(sub, "Enter");
    await until(() => [...fake.rows.values()].some((r) => r.data.title === "Write the announcement"));
    expect([...fake.rows.values()].find((r) => r.data.title === "Write the announcement").data.parent).toBe(item.id);
    const composer = /** @type {HTMLTextAreaElement} */ (root.querySelector(".detail .composer"));
    composer.value = "Looks good";
    key(composer, "Enter", { ctrlKey: true });
    await until(() => [...fake.rows.values()].some((r) => r.entity === "comment" && r.data.body === "Looks good"));
    await app.store.pull();
    await until(() => text(root.querySelector(".timeline")).includes("Looks good"));
  });
});

describe("bulk edit, undo and failures", () => {
  it("applies one command per selected item and reports partial failures", async () => {
    const { root, fake, app } = await mount({ records: basic, approval: "manual" });
    app.runAction("selectAll");
    await settle();
    expect(text(root.querySelector(".bulk-count"))).toBe("3 selected");
    const bulkPrio = button(root, "Priority");
    bulkPrio?.click();
    await settle();
    option(root, "Low")?.click();
    await until(() => fake.pendingActions().length === 3);
    expect(fake.pendingActions().every((a) => a.input.priority === 4)).toBe(true);
    // One is changed by someone else first: it conflicts; the rest save.
    const r2 = row(fake, 2);
    fake.run("work.update", { id: r2.id, title: "Build the site (v2)" }, { actor: "cloudflare-os:linus@example.com", revision: r2.revision });
    fake.approveAll();
    await until(() => app.store.changes.filter((c) => c.status !== "pending").length === 3);
    expect(app.store.changes.filter((c) => c.status === "conflict")).toHaveLength(1);
    status(root).click();
    await settle();
    expect(text(root.querySelector(".status-panel"))).toMatch(/2 saved · 1 not saved/);
    expect(text(root.querySelector(".status-panel"))).toMatch(/Someone changed this first/);
  });

  it("undoes your own last change with the inverse command", async () => {
    const { fake, app } = await mount({ records: basic });
    const item = app.store.index().byNumber.get(2);
    const r = app.store.updateItem(item, { priority: 1 }, { label: "Set priority" });
    expect(r.ok).toBe(true);
    await until(() => row(fake, 2).data.priority === 1);
    await app.store.pull();
    await until(() => app.store.changes.some((c) => c.status === "applied"));
    app.runAction("undo");
    await until(() => row(fake, 2).data.priority === undefined);
  });

  it("explains a rejected change and retries it", async () => {
    const { root, fake, app } = await mount({ records: basic, approval: "manual" });
    const item = app.store.index().byNumber.get(3);
    app.store.updateItem(item, { estimate: 5 }, { label: "Estimate TW-3" });
    await until(() => fake.pendingActions().length === 1);
    fake.reject(fake.pendingActions()[0].id);
    await until(() => app.store.changes[0]?.status === "rejected");
    await settle(20);
    expect(app.live.assertive.textContent).toMatch(/Not saved: Estimate TW-3\. The change was declined/);
    status(root).click();
    await settle();
    button(root, "Retry")?.click();
    await until(() => fake.pendingActions().length === 1);
  });
});

describe("settings, palette and read-only", () => {
  it("changes the key prefix and creates a workflow state", async () => {
    const { root, fake, app } = await mount({ records: basic });
    app.runAction("settings");
    await settle();
    const prefix = /** @type {HTMLInputElement} */ (root.querySelector("#wb-prefix"));
    prefix.value = "web";
    key(prefix, "Enter");
    await until(() => app.store.index().keyPrefix === "WEB");
    await settle();
    expect(root.querySelector('ul.cell[data-col="todo"] .card-key')?.textContent).toBe("WEB-1");
    const tab = /** @type {HTMLElement} */ (root.querySelector("#wb-tab-states"));
    tab.click();
    await settle();
    const name = /** @type {HTMLInputElement} */ (root.querySelector('input[aria-label="New state name"]'));
    name.value = "In QA";
    key(name, "Enter");
    await until(() => [...fake.rows.values()].some((r) => r.entity === "workflow_state" && r.data.key === "in_qa"));
    expect(await axe(root)).toEqual([]);
  });

  it("runs commands and finds items by key from the palette", async () => {
    const { root, app } = await mount({ records: basic });
    key(document.body, "k", { ctrlKey: true });
    await settle();
    const input = /** @type {HTMLInputElement} */ (root.querySelector(".palette-input"));
    input.value = "TW-2";
    input.dispatchEvent(new Event("input"));
    await settle();
    expect(text(root.querySelector(".palette-list"))).toContain("TW-2 Build the site");
    key(input, "Enter");
    await settle();
    expect(root.querySelector("aside.detail")?.hidden).toBe(false);
    expect(app.view.layout).toBe("board");
    key(document.body, "k", { ctrlKey: true });
    await settle();
    const again = /** @type {HTMLInputElement} */ (root.querySelector(".palette-input"));
    again.value = "list layout";
    again.dispatchEvent(new Event("input"));
    await settle();
    key(again, "Enter");
    await settle();
    expect(app.view.layout).toBe("list");
  });

  it("hides editing on read-only connections", async () => {
    const { root } = await mount({ records: basic, access: "read" });
    expect(button(root, "New item")).toBeUndefined();
    expect(root.querySelector(".card-menu")).toBeNull();
    key(document.body, "c");
    await settle();
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });
});

/** @param {Element} root */
function status(root) { return /** @type {HTMLButtonElement} */ (root.querySelector(".status-btn")); }
