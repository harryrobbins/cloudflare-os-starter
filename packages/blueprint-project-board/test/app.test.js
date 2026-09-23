// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBoardApp } from "../src/client/ui/app.js";
import { FakeRecords, fakeGadget, recordsError } from "./fake-records.js";

let app;
afterEach(() => { app?.destroy(); app = null; vi.useRealTimers(); });

const memoryPrefs = (initial = {}) => { let v = initial; return { load: () => v, save: (p) => { v = p; } }; };

async function mount(records, opts = {}) {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const gadget = fakeGadget(records, opts);
  app = createBoardApp({ gadget, root, prefs: memoryPrefs() });
  await app.ready;
  return { root, gadget };
}

const text = (root) => root.textContent.replace(/\s+/g, " ");
const column = (root, key) => root.querySelector(`.pb-column[data-state="${key}"]`);
const cardKeys = (root, key) => [...column(root, key).querySelectorAll(".pb-card .key")].map((e) => e.textContent);
const button = (root, label) => [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === label);

describe("project board UI", () => {
  it("renders workflow columns with issues", async () => {
    const { root } = await mount(new FakeRecords());
    expect([...root.querySelectorAll(".pb-column h2 span:first-child")].map((e) => e.textContent)).toEqual(["To do", "In progress", "Done"]);
    expect(cardKeys(root, "todo")).toEqual(["ENG-1", "ENG-2"]);
    expect(cardKeys(root, "doing")).toEqual(["ENG-3"]);
  });

  it("explains a missing connection", async () => {
    const { root } = await mount(null);
    expect(text(root)).toContain("Connect a Projects datastore");
    expect(text(root)).toContain("RECORDS");
  });

  it("explains forbidden access", async () => {
    const records = new FakeRecords();
    records.readError = recordsError("forbidden", "not a member");
    const { root } = await mount(records);
    expect(text(root)).toContain("You don't have access to this datastore");
  });

  it("explains an unavailable service and recovers on retry", async () => {
    const records = new FakeRecords();
    records.readError = recordsError("unavailable", "database unreachable");
    const { root } = await mount(records);
    expect(text(root)).toContain("The Records service is unavailable");
    records.readError = null;
    button(root, "Try again").click();
    await vi.waitFor(() => expect(cardKeys(root, "todo")).toEqual(["ENG-1", "ENG-2"]));
  });

  it("is read-only for an archived datastore", async () => {
    const { root } = await mount(new FakeRecords({ lifecycle: "archived" }));
    expect(text(root)).toContain("This datastore is archived");
    expect(button(root, "New issue").disabled).toBe(true);
    expect(root.querySelector(".pb-card").getAttribute("draggable")).toBeNull();
  });

  it("offers only allowed moves and moves a card only once applied", async () => {
    const records = new FakeRecords();
    const { root } = await mount(records);
    root.querySelector('[data-issue-id="iss-3"] button.open').click();
    const moves = [...root.querySelectorAll(".transitions button")].map((b) => b.textContent);
    expect(moves).toEqual(["Move to To do", "Move to Done"]);
    button(root, "Move to Done").click();
    await vi.waitFor(() => expect(cardKeys(root, "done")).toEqual(["ENG-3"]));
    expect(root.querySelector('.write[data-status="applied"]').textContent).toContain("Saved");
  });

  it("shows pending approval and keeps the card where it is", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const records = new FakeRecords({ writeMode: "pending" });
    const { root } = await mount(records);
    await app.transition(app.state.issues.get("iss-1"), "doing");
    const write = root.querySelector('.write[data-status="pending"]');
    expect(write.textContent).toContain("Pending approval");
    expect(write.textContent).toContain("action #101");
    expect(write.textContent).not.toContain("Saved");
    expect(cardKeys(root, "todo")).toContain("ENG-1");
    expect(root.querySelector('[data-issue-id="iss-1"] .chip').textContent).toBe("Awaiting approval");
    records.approve(101);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(cardKeys(root, "doing")).toContain("ENG-1"));
  });

  it("shows a conflict, reloads the issue and compares versions", async () => {
    const records = new FakeRecords();
    const { root } = await mount(records);
    root.querySelector('[data-issue-id="iss-1"] button.open').click();
    const title = root.querySelector('.pb-detail [name="title"]');
    title.value = "My title";
    records.touch("iss-1", { title: "Bob's title" });
    await app.saveEdit();
    const box = root.querySelector(".conflict-box");
    expect(box.textContent).toContain("Your change was not saved");
    expect(records.issues.get("iss-1").title).toBe("Bob's title");
    box.querySelector("button.reload-issue").click();
    await vi.waitFor(() => expect(root.querySelector(".conflict-box table")).not.toBeNull());
    const cells = [...root.querySelectorAll(".conflict-box td")].map((td) => td.textContent);
    expect(cells).toEqual(["title", "My title", "Bob's title"]);
    expect(root.querySelector('.pb-detail [name="title"]').value).toBe("My title");
    // Deciding again applies on top of the reloaded revision.
    const entry = await app.saveEdit();
    expect(entry.status).toBe("applied");
    expect(records.issues.get("iss-1").title).toBe("My title");
  });

  it("marks a lost reply as unconfirmed and resolves it with Check again", async () => {
    const records = new FakeRecords();
    const { root } = await mount(records);
    records.loseNextReply = true;
    await app.createIssue({ title: "Lost reply" });
    expect(root.querySelector('.write[data-status="unknown"]').textContent).toContain("may or may not have been saved");
    button(root, "Check again").click();
    await vi.waitFor(() => expect(root.querySelector('.write[data-status="applied"]')).not.toBeNull());
    expect([...records.issues.values()].filter((i) => i.title === "Lost reply")).toHaveLength(1);
    await vi.waitFor(() => expect(cardKeys(root, "todo")).toContain("ENG-4"));
  });

  it("creates issues and comments through the dialog and panel", async () => {
    const records = new FakeRecords();
    const { root } = await mount(records);
    button(root, "New issue").click();
    root.querySelector('.dialog [name="title"]').value = "From dialog";
    root.querySelector('.dialog [name="priority"]').value = "urgent";
    button(root, "Create issue").click();
    await vi.waitFor(() => expect(cardKeys(root, "todo")[0]).toBe("ENG-4"));
    expect(records.writeCalls()[0].input).toEqual({ projectId: "prj-1", title: "From dialog", priority: "urgent" });
    root.querySelector('[data-issue-id="iss-4"] button.open').click();
    root.querySelector('[name="comment"]').value = "Looks good";
    button(root, "Add comment").click();
    await vi.waitFor(() => expect(root.querySelector(".comments").textContent).toContain("Looks good"));
  });

  it("hides write controls the binding was not granted", async () => {
    const { root } = await mount(new FakeRecords({ scopes: ["projects.read", "issues.read"] }));
    expect(button(root, "New issue").disabled).toBe(true);
    expect(text(root)).toContain("cannot create issues, edit issues, move issues, comment");
    root.querySelector('[data-issue-id="iss-1"] button.open').click();
    expect(root.querySelector('.pb-detail [name="title"]').disabled).toBe(true);
    expect(root.querySelector('[name="comment"]')).toBeNull();
  });

  it("refetches only newer revisions from change notifications", async () => {
    const records = new FakeRecords();
    await mount(records);
    records.calls.length = 0;
    await app.applyChanges([{ entityType: "issue", entityId: "iss-1", revision: 1 }]);
    expect(records.calls.filter((c) => c.name === "getIssue")).toHaveLength(0);
    records.touch("iss-1", { title: "Changed elsewhere" });
    await app.applyChanges([{ entityType: "issue", entityId: "iss-1", revision: 2 }, { entityType: "issue", entityId: "iss-1", revision: 2 }]);
    expect(records.calls.filter((c) => c.name === "getIssue")).toHaveLength(1);
    expect(app.state.issues.get("iss-1").title).toBe("Changed elsewhere");
  });
});
