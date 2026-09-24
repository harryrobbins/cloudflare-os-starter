// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBoardApp } from "../src/client/ui/app.js";
import { FakeRecords, fakeGadget, recordsError } from "./fake-records.js";

let app;
afterEach(() => { app?.destroy(); app = null; });

const memoryPrefs = (initial = {}) => { let v = initial; return { load: () => v, save: (p) => { v = p; } }; };

/** A beforeunload target the test can fire. */
function unloadTarget() {
  const listeners = new Set();
  return {
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn),
    fire() { const e = { preventDefault: vi.fn(), returnValue: undefined }; for (const fn of listeners) fn(e); return e; },
  };
}

async function mount(records, opts = {}) {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const gadget = fakeGadget(records, opts);
  const unload = unloadTarget();
  app = createBoardApp({
    gadget, root, prefs: memoryPrefs(), viewer: { id: "alice@example.com", displayName: "Alice" }, unloadTarget: unload,
    syncOptions: { pushDelayMs: 0, approvalCheckIntervalMs: 20, retryBaseMs: 5, retryMaxMs: 20 },
    pokeOptions: { liveTickMs: 10, pollMs: 10_000 },
  });
  await app.ready;
  return { root, gadget, unload };
}

/** A promise the test resolves by hand. */
function gate() {
  let open;
  const promise = new Promise((r) => { open = r; });
  return { promise, open };
}

const text = (root) => root.textContent.replace(/\s+/g, " ");
const column = (root, key) => root.querySelector(`.pb-column[data-state="${key}"]`);
const cardKeys = (root, key) => [...column(root, key).querySelectorAll(".pb-card .key")].map((e) => e.textContent);
const card = (root, id) => root.querySelector(`.pb-card[data-issue-id="${id}"]`);
const button = (root, label) => [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
const change = (root, status) => root.querySelector(`.write[data-status="${status}"]`);

describe("project board UI", () => {
  it("renders workflow columns with issues from the first pull", async () => {
    const { root } = await mount(new FakeRecords());
    expect([...root.querySelectorAll(".pb-column h2 span:first-child")].map((e) => e.textContent)).toEqual(["Backlog", "To do", "In progress", "Done"]);
    expect(cardKeys(root, "backlog")).toEqual(["ENG-1", "ENG-2"]);
    expect(cardKeys(root, "todo")).toEqual(["ENG-3"]);
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

  it("explains a refused first pull", async () => {
    const records = new FakeRecords();
    records.syncPull = async () => { throw recordsError("payload_too_large", "This datastore has more data than sync supports; use the paged API."); };
    const { root } = await mount(records);
    expect(text(root)).toContain("This datastore is too large for the board");
  });

  it("explains an unavailable service and recovers on retry", async () => {
    const records = new FakeRecords();
    records.readError = recordsError("unavailable", "database unreachable");
    const { root } = await mount(records);
    expect(text(root)).toContain("The Records service is unavailable");
    records.readError = null;
    button(root, "Try again").click();
    await vi.waitFor(() => expect(cardKeys(root, "backlog")).toEqual(["ENG-1", "ENG-2"]));
  });

  it("is read-only for an archived datastore", async () => {
    const { root } = await mount(new FakeRecords({ lifecycle: "archived" }));
    expect(text(root)).toContain("This datastore is archived");
    expect(button(root, "New issue").disabled).toBe(true);
    expect(card(root, "iss-1").getAttribute("draggable")).toBeNull();
  });

  it("shows a created issue at once with a placeholder key, then the server's key", async () => {
    const records = new FakeRecords();
    const { root, unload } = await mount(records);
    const held = gate();
    records.pushGate = held.promise;
    button(root, "New issue").click();
    root.querySelector('.dialog [name="title"]').value = "From dialog";
    root.querySelector('.dialog [name="priority"]').value = "urgent";
    button(root, "Create issue").click();

    // Optimistic: the card is there before the Records service has answered.
    expect(cardKeys(root, "backlog")[0]).toBe("ENG-?");
    const provisional = root.querySelector(".pb-card.provisional");
    expect(provisional.textContent).toContain("From dialog");
    expect(provisional.querySelector(".chip").textContent).toBe("Saving…");
    expect(change(root, "saving").textContent).toContain("New issue: From dialog");
    await vi.waitFor(() => expect(text(root)).toContain("1 unsynced change"));
    // Closing the page now would lose it, so the page asks first.
    expect(unload.fire().preventDefault).toHaveBeenCalled();

    held.open();
    await vi.waitFor(() => expect(cardKeys(root, "backlog")[0]).toBe("ENG-4"));
    expect(root.querySelector(".pb-card.provisional")).toBeNull();
    expect(change(root, "applied").textContent).toContain("Saved");
    expect(text(root)).not.toContain("unsynced change");
    expect(unload.fire().preventDefault).not.toHaveBeenCalled();
    const created = records.server.values("issue/").find((i) => i.title === "From dialog");
    expect(created).toMatchObject({ key: "ENG-4", priority: "urgent", createdBy: { displayName: "Alice" } });
    // The id chosen in the browser is the one the server kept.
    expect(card(root, created.id)).not.toBeNull();
  });

  it("asks the host for one assertion per mutation, over the exact sync intent", async () => {
    const records = new FakeRecords();
    const { gadget } = await mount(records);
    app.transition(app.issueById("iss-1"), "todo");
    await vi.waitFor(() => expect(records.issue("iss-1").state).toBe("todo"));
    const [push] = records.pushCalls();
    expect(push.request.mutations).toEqual([expect.objectContaining({ id: 1, name: "projects.transitionIssue", args: { issueId: "iss-1", expectedRevision: 1, toState: "todo" } })]);
    expect(gadget.assertions).toHaveLength(1);
    expect(gadget.assertions[0].binding).toBe("RECORDS");
    expect(push.options).toHaveLength(1);
  });

  it("moves a card at once and keeps it there once saved", async () => {
    const records = new FakeRecords();
    const { root } = await mount(records);
    const held = gate();
    records.pushGate = held.promise;
    card(root, "iss-3").querySelector("button.open").click();
    const moves = [...root.querySelectorAll(".transitions button")].map((b) => b.textContent);
    expect(moves).toEqual(["Move to Backlog", "Move to In progress"]);
    button(root, "Move to In progress").click();
    expect(cardKeys(root, "in_progress")).toEqual(["ENG-3"]);
    held.open();
    await vi.waitFor(() => expect(change(root, "applied")).not.toBeNull());
    expect(cardKeys(root, "in_progress")).toEqual(["ENG-3"]);
    expect(records.issue("iss-3").state).toBe("in_progress");
  });

  it("replaces a conflicting guess with the server's version and shows both", async () => {
    const records = new FakeRecords();
    const { root } = await mount(records);
    card(root, "iss-1").querySelector("button.open").click();
    root.querySelector('.pb-detail [name="title"]').value = "My title";
    records.touch("iss-1", { title: "Bob's title" }); // not pulled yet: the board still shows revision 1
    const held = gate();
    records.pushGate = held.promise;
    app.saveEdit();
    expect(card(root, "iss-1").querySelector(".title").textContent).toBe("My title"); // the guess
    held.open();

    await vi.waitFor(() => expect(root.querySelector(".conflict-box table")).not.toBeNull());
    expect(root.querySelector(".conflict-box").textContent).toContain("Your change was not saved");
    await vi.waitFor(() => expect(card(root, "iss-1").querySelector(".title").textContent).toBe("Bob's title"));
    expect(change(root, "conflict").textContent).toContain("someone else changed this issue first");
    const cells = [...root.querySelectorAll(".conflict-box td")].map((td) => td.textContent);
    expect(cells).toEqual(["title", "My title", "Bob's title"]);
    // The form was rebased onto Bob's version and still holds yours.
    await vi.waitFor(() => expect(root.querySelector(".conflict-box").textContent).toContain("Save again to apply it"));
    expect(root.querySelector('.pb-detail [name="title"]').value).toBe("My title");

    app.saveEdit();
    await vi.waitFor(() => expect(records.issue("iss-1").title).toBe("My title"));
    expect(records.issue("iss-1").revision).toBe(3);
  });

  it("shows a move awaiting approval, then the approved result", async () => {
    const records = new FakeRecords({ approvals: true });
    const { root } = await mount(records);
    app.transition(app.issueById("iss-1"), "todo");
    expect(cardKeys(root, "todo")).toContain("ENG-1"); // optimistic

    await vi.waitFor(() => expect(change(root, "pending")).not.toBeNull());
    const pending = change(root, "pending");
    expect(pending.textContent).toContain("Pending approval");
    expect(pending.textContent).toContain("action #1");
    expect(pending.textContent).not.toContain("Saved");
    // Not saved yet: the card shows where the server has it, marked as awaiting.
    expect(cardKeys(root, "backlog")).toContain("ENG-1");
    expect(card(root, "iss-1").querySelector(".chip").textContent).toBe("Awaiting approval");

    records.server.approve(1);
    await vi.waitFor(() => expect(cardKeys(root, "todo")).toContain("ENG-1"));
    await vi.waitFor(() => expect(change(root, "applied")).not.toBeNull());
    expect(change(root, "pending")).toBeNull();
  });

  it("reports a declined approval", async () => {
    const records = new FakeRecords({ approvals: true });
    const { root } = await mount(records);
    app.transition(app.issueById("iss-1"), "todo");
    await vi.waitFor(() => expect(change(root, "pending")).not.toBeNull());
    records.server.reject(1, "Not this sprint.");
    await vi.waitFor(() => expect(change(root, "rejected")).not.toBeNull());
    expect(change(root, "rejected").textContent).toContain("Not saved: Not this sprint.");
    expect(cardKeys(root, "backlog")).toContain("ENG-1");
  });

  it("shows a refusal and drops the guess", async () => {
    const records = new FakeRecords({ scopes: ["projects.read", "issues.read", "issues.transition"] });
    const { root } = await mount(records);
    // The UI hides create for this binding; a change the server refuses still shows why.
    app.state.caps.create = true;
    app.createIssue({ title: "Not allowed" });
    expect(cardKeys(root, "backlog")).toContain("ENG-?");
    await vi.waitFor(() => expect(change(root, "rejected")).not.toBeNull());
    expect(change(root, "rejected").textContent).toContain("may not change this through this connection");
    expect(root.querySelector(".pb-card.provisional")).toBeNull();
  });

  it("stops and says so when changes cannot be confirmed as the viewer's", async () => {
    const records = new FakeRecords();
    const { root } = await mount(records, { assertion: () => null });
    app.transition(app.issueById("iss-1"), "todo");
    await vi.waitFor(() => expect(text(root)).toContain("1 change is not being sent"));
    expect(text(root)).toContain("Only signed-in viewers can change records");
    expect(records.pushCalls()).toHaveLength(0);
  });

  it("adds comments at once and marks them until saved", async () => {
    const records = new FakeRecords();
    const { root } = await mount(records);
    card(root, "iss-1").querySelector("button.open").click();
    const held = gate();
    records.pushGate = held.promise;
    root.querySelector('[name="comment"]').value = "Looks good";
    button(root, "Add comment").click();
    const item = root.querySelector(".comments li");
    expect(item.textContent).toContain("Looks good");
    expect(item.className).toBe("sending");
    held.open();
    await vi.waitFor(() => expect(root.querySelector(".comments li").className).toBe(""));
    expect(records.comments()).toEqual([expect.objectContaining({ body: "Looks good", issueId: "iss-1" })]);
  });

  it("hides write controls the binding was not granted", async () => {
    const { root } = await mount(new FakeRecords({ scopes: ["projects.read", "issues.read"] }));
    expect(button(root, "New issue").disabled).toBe(true);
    expect(text(root)).toContain("cannot create issues, edit issues, move issues, comment");
    card(root, "iss-1").querySelector("button.open").click();
    expect(root.querySelector('.pb-detail [name="title"]').disabled).toBe(true);
    expect(root.querySelector('[name="comment"]')).toBeNull();
  });

  it("pulls by seq when a poke arrives once live updates are on", async () => {
    const records = new FakeRecords();
    const { root, gadget } = await mount(records);
    button(root, "Turn on live updates").click();
    await vi.waitFor(() => expect(records.hooks).toHaveLength(1));
    expect(records.hooks[0].options).toEqual({ deliver: "pokes" });
    const cookie = app.client.cookie;
    records.touch("iss-2", { title: "Changed elsewhere" });
    expect(gadget.pokes.summary()).toMatchObject({ live: "active", head: records.server.seq });
    await vi.waitFor(() => expect(card(root, "iss-2").querySelector(".title").textContent).toBe("Changed elsewhere"));
    expect(text(root)).toContain("Live updates on");
    // A delta pull from the cookie, not a reload.
    const pulls = records.calls.filter((c) => c.name === "syncPull");
    expect(pulls.at(-1).arg.cookie).toBe(cookie);
  });
});
