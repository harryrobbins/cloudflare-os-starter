// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createBoardApp } from "../src/client/ui/app.js";
import { FakeWork } from "./fake-gadget.js";

let app;
afterEach(() => { app?.destroy(); app = null; });

async function mount(work, gadget = work.gadget()) {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  app = createBoardApp({ gadget, root, timers: { visibleMs: 10_000, hiddenMs: 10_000, outcomeMs: 10 } });
  await app.ready;
  return root;
}

const text = (root) => root.textContent.replace(/\s+/g, " ");
const titles = (root, status) => [...root.querySelectorAll(`.wb-column[data-status="${status}"] .title`)].map((e) => e.textContent);
const button = (root, label) => [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
const until = async (check) => { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 5)); } throw new Error("condition not met"); };

describe("work board UI", () => {
  it("renders columns from the snapshot", async () => {
    const root = await mount(new FakeWork({ items: [{ title: "Plan", status: "open" }, { title: "Build", status: "active" }, { title: "Ship", status: "done" }] }));
    expect([...root.querySelectorAll(".wb-column h2 span:first-child")].map((e) => e.textContent)).toEqual(["Open", "Active", "Done"]);
    expect(titles(root, "open")).toEqual(["Plan"]);
    expect(titles(root, "active")).toEqual(["Build"]);
    expect(titles(root, "done")).toEqual(["Ship"]);
  });

  it("creates an item: pending until approved, then appears after the pull", async () => {
    const work = new FakeWork();
    const root = await mount(work);
    button(root, "New item").click();
    const input = root.querySelector("#wb-new-title");
    input.value = "  Write docs  ";
    button(root, "Create item").click();
    await until(() => root.querySelector('.write[data-status="pending"]'));
    expect(text(root)).toContain("Awaiting approval in the Workshop (action #1)");
    expect(titles(root, "open")).toEqual([]);
    expect(work.actions.get(1).input).toEqual({ title: "Write docs", status: "open" });
    work.approve(1);
    await until(() => titles(root, "open").includes("Write docs"));
    expect(root.querySelector('.write[data-status="applied"]')).not.toBeNull();
  });

  it("moves a card only once the service saved the move, with the item's revision", async () => {
    const work = new FakeWork({ items: [{ title: "Plan", status: "open" }] });
    const root = await mount(work);
    const select = root.querySelector('.wb-card select');
    select.value = "active";
    select.dispatchEvent(new Event("change"));
    await until(() => work.actions.size === 1);
    const [row] = work.rows.values();
    expect(work.actions.get(1)).toMatchObject({ input: { id: row.id, status: "active" }, options: { revision: row.revision } });
    await until(() => text(root).includes("Awaiting approval (action #1)"));
    expect(titles(root, "open")).toEqual(["Plan"]);
    work.approve(1);
    await until(() => titles(root, "active").includes("Plan"));
  });

  it("reports a conflict when someone else changed the item first", async () => {
    const work = new FakeWork({ items: [{ title: "Plan", status: "open" }] });
    const root = await mount(work);
    const select = root.querySelector('.wb-card select');
    select.value = "done";
    select.dispatchEvent(new Event("change"));
    await until(() => work.actions.size === 1);
    const [row] = work.rows.values();
    work.external(row.id, { title: "Plan (renamed)" });
    work.approve(1);
    await until(() => root.querySelector('.write[data-status="conflict"]'));
    await until(() => titles(root, "open").includes("Plan (renamed)"));
  });

  it("re-snapshots after a permission epoch change", async () => {
    const work = new FakeWork({ items: [{ title: "Plan" }] });
    const root = await mount(work);
    work.epoch = 2;
    await app.pull();
    expect(work.calls.filter(([name]) => name === "snapshot")).toHaveLength(2);
    expect(titles(root, "open")).toEqual(["Plan"]);
  });

  it("hides editing on read-only connections and refuses other modules", async () => {
    let root = await mount(new FakeWork({ items: [{ title: "Plan" }], access: "read" }));
    expect(button(root, "New item")).toBeUndefined();
    expect(root.querySelector(".wb-card select")).toBeNull();
    app.destroy();
    root = await mount(new FakeWork({ module: "messaging" }));
    expect(text(root)).toContain("This board needs a work v1 datastore");
  });

  it("shows an explicit state for oversized datastores", async () => {
    const work = new FakeWork();
    const gadget = { ...work.gadget(), snapshot: async () => { throw new Error("too_large: The datastore holds more records than one snapshot allows."); } };
    const root = await mount(work, gadget);
    expect(text(root)).toContain("This datastore is too large for a board");
  });
});
