// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createPeople, memoryStorage } from "../../src/server/documents.js";
import { axe, button, key, mount, settle, text, unmountAll, until } from "./helpers.js";

afterEach(() => {
  unmountAll();
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1024 });
});

const A = "cloudflare-os:ada@example.com";
const G = "cloudflare-os:grace@example.com";
/** @param {import("../fake-records.js").FakeRecords} fake */
const basic = (fake) => {
  for (const [k, n] of [["bug", "Bug"], ["ui", "UI"], ["performance", "Performance"], ["security", "Security"], ["docs", "Docs"], ["design", "Design"]]) fake.run("work.label.create", { key: k, name: n, color: "#5e6ad2" }, { actor: A });
  fake.run("work.create", { title: "Plan the launch", state: "todo", priority: 1, labels: ["bug", "ui", "performance", "security", "docs", "design"], assignee: G }, { actor: A });
  fake.run("work.create", { title: "Build the site", state: "in_progress", priority: 3, estimate: 3 }, { actor: G });
  fake.run("work.create", { title: "Ship it", state: "done", assignee: A }, { actor: A });
};
async function withGrace() {
  const storage = memoryStorage();
  await createPeople(storage).rememberViewer({ id: "grace@example.com", displayName: "Grace Hopper" });
  return storage;
}
/** @param {Element} root @param {string} col */
const card = (root, col) => /** @type {HTMLElement} */ (root.querySelector(`ul.cell[data-col="${col}"] article.card`));

describe("people names", () => {
  it("shows colleagues by name everywhere, with the account in the tooltip", async () => {
    const { root, storage } = await mount({ records: basic, storage: await withGrace() });
    const c = card(root, "todo");
    expect(c.getAttribute("aria-label")).toContain("Assigned to Grace Hopper");
    expect(c.querySelector(".avatar")?.getAttribute("title")).toBe("Grace Hopper (grace@example.com)");
    // The signed-in viewer told the board their name.
    await until(() => storage.map.get("people")?.people[A]?.name === "Ada Lovelace");
  });

  it("renames an actor for everyone from Settings → People", async () => {
    const { root, app } = await mount({ records: basic, storage: await withGrace() });
    app.runAction("settings");
    await settle();
    /** @type {HTMLElement} */ (root.querySelector("#wb-tab-people")).click();
    await settle();
    const input = /** @type {HTMLInputElement} */ (root.querySelector(`input[aria-label="Name shown for ${G}"]`));
    input.value = "Admiral Hopper";
    key(input, "Enter");
    await until(() => card(root, "todo")?.getAttribute("aria-label")?.includes("Assigned to Admiral Hopper"));
    expect(await axe(root)).toEqual([]);
  });
});

describe("cards", () => {
  it("shows priority as an icon only, with the name in the accessible label", async () => {
    const { root } = await mount({ records: basic });
    const prio = card(root, "todo").querySelector(".chip.prio");
    expect(prio?.textContent).toBe("");
    expect(prio?.getAttribute("title")).toBe("Priority: Urgent");
    expect(card(root, "todo").getAttribute("aria-label")).toContain("Priority Urgent");
  });

  it("never clips label chips: whole chips, then +N naming the rest", async () => {
    const { root } = await mount({ records: basic });
    const labels = [...card(root, "todo").querySelectorAll(".chip.label")].map((c) => c.textContent);
    const more = card(root, "todo").querySelector(".chip.more");
    expect(more).not.toBeNull();
    const hidden = Number(more?.textContent?.slice(1));
    expect(labels.length + hidden).toBe(6);
    expect(more?.getAttribute("aria-label")).toMatch(new RegExp(`^${hidden} more labels: `));
  });
});

describe("fit and density", () => {
  it("hides empty columns while filtering, unless the view says otherwise", async () => {
    const { root, app } = await mount({ records: basic });
    expect(root.querySelectorAll(".col-head")).toHaveLength(7);
    app.loadView({ ...app.view, id: null, name: "Mine", query: "assignee:me" });
    await settle();
    expect([...root.querySelectorAll(".col-head .col-name")].map((e) => e.textContent)).toEqual(["Done"]);
    app.loadView({ ...app.view, display: { ...app.view.display, hideEmptyColumns: false } });
    await settle();
    expect(root.querySelectorAll(".col-head")).toHaveLength(7);
  });

  it("offers + in an empty lane cell to create there", async () => {
    const { root, app } = await mount({ records: basic });
    app.loadView({ ...app.view, id: null, name: "Lanes", swimlanesBy: "priority" });
    await settle();
    const add = /** @type {HTMLButtonElement} */ (root.querySelector('section.lane[data-lane="1"] ul.cell[data-col="backlog"] .cell-add'));
    expect(add.getAttribute("aria-label")).toBe("New item in Backlog, Urgent");
    add.click();
    await settle();
    expect(text(/** @type {Element} */ (root.querySelector(".dialog-title")))).toBe("New item in Backlog · Urgent");
  });

  it("shows one column at a time on narrow screens, switched by tabs or arrows", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 375 });
    const { root, app } = await mount({ records: basic });
    const bar = /** @type {HTMLElement} */ (root.querySelector(".narrow-bar"));
    expect(bar.hidden).toBe(false);
    expect(root.querySelectorAll(".col-head")).toHaveLength(1);
    const pressed = () => bar.querySelector('[aria-pressed="true"]')?.textContent;
    expect(pressed()).toBe("Todo1");
    key(document.body, "ArrowDown");
    await settle();
    key(/** @type {HTMLElement} */ (document.activeElement), "ArrowRight");
    await settle();
    expect(pressed()).toBe("In Progress1");
    /** @type {HTMLElement} */ ([...bar.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Done"))).click();
    await settle();
    expect(root.querySelector(".col-head .col-name")?.textContent).toBe("Done");
    void app;
  });
});

describe("detail header, share, chords, palette", () => {
  it("puts the key, title and state/priority/assignee pills at the top", async () => {
    const { root, app } = await mount({ records: basic, storage: await withGrace() });
    app.openDetail(app.store.index().byNumber.get(1), { focus: true });
    await settle();
    const head = /** @type {HTMLElement} */ (root.querySelector(".detail-head"));
    expect(text(head.querySelector(".detail-key") ?? head)).toBe("TW-1");
    expect(/** @type {HTMLTextAreaElement} */ (head.querySelector(".title-edit")).value).toBe("Plan the launch");
    expect([...head.querySelectorAll(".pill")].map((p) => text(p))).toEqual(["Todo", "Urgent", "GHGrace Hopper"]);
    expect(await axe(root)).toEqual([]);
  });

  it("shows the key as selectable text instead of copying", async () => {
    const { root, app } = await mount({ records: basic });
    app.openDetail(app.store.index().byNumber.get(2), { focus: true });
    await settle();
    button(root, "Share…")?.click();
    await settle();
    const fields = [...root.querySelectorAll(".key-field")].map((f) => /** @type {HTMLInputElement} */ (f).value);
    expect(fields).toEqual(["TW-2", "TW-2 Build the site"]);
    expect(/** @type {HTMLInputElement} */ (root.querySelector(".key-field")).readOnly).toBe(true);
  });

  it("switches layouts with G then L and G then B", async () => {
    const { app } = await mount({ records: basic });
    key(document.body, "g");
    key(document.body, "l");
    await settle();
    expect(app.view.layout).toBe("list");
    key(document.body, "g");
    key(document.body, "b");
    await settle();
    expect(app.view.layout).toBe("board");
  });

  it("shows tips in an empty palette", async () => {
    const { root } = await mount({ records: basic });
    key(document.body, "k", { ctrlKey: true });
    await settle();
    expect(text(/** @type {Element} */ (root.querySelector(".palette .picker-empty")))).toMatch(/^Tips: type a key/);
  });
});
