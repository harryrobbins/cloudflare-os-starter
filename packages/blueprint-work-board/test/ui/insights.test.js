// @vitest-environment jsdom
// The Reports screen, the Proposals tray and Jev suggestions in the real app over the real gadget
// server (jsdom), with axe.
import { afterEach, describe, expect, it } from "vitest";
import { axe, mount, row, settle, text, unmountAll, until } from "./helpers.js";
import { createFakeJev } from "../fake-jev.js";

afterEach(() => unmountAll());
// jsdom has no canvas; Vega then measures text by estimate (as it would headless).
HTMLCanvasElement.prototype.getContext = /** @type {any} */ (() => null);

/** @param {any} api */
const agentProposes = (api) => api.propose([
  { command: "work.update", input: { id: "TW-12", priority: "urgent" }, reason: "Customer escalation" },
  { command: "work.update", input: { id: "TW-14", title: "Renamed by the agent" }, reason: "Clearer" },
  { command: "work.create", input: { title: "Write the migration guide", parent: "TW-12" }, reason: "Split out the docs" },
], { title: "Escalate TW-12", reason: "Acme is blocked." });

describe("Insights layout", () => {
  it("shows every built-in report with a chart, summary and data table, filtered by the view", async () => {
    const { app, root } = await mount({ seed: 120 });
    app.setLayout("insights");
    await until(() => root.querySelectorAll(".report-card").length === 8 && root.querySelectorAll(".report-chart svg").length >= 7, { timeout: 8000, message: "charts" });
    const titles = [...root.querySelectorAll(".report-title")].map((e) => e.firstChild?.textContent);
    expect(titles).toEqual(["Cumulative flow", "Cycle time", "Cycle burndown", "Cycle burnup", "Throughput", "Created vs resolved", "Workload by assignee", "Dependencies"]);
    const cfd = /** @type {HTMLElement} */ (root.querySelector('[data-report="cfd"]'));
    expect(text(cfd.querySelector("figcaption"))).toMatch(/^Over the last 30 days/);
    expect(cfd.querySelector(".report-chart")?.getAttribute("role")).toBe("img");
    expect(cfd.querySelector(".report-chart")?.getAttribute("aria-label")).toMatch(/^Cumulative flow chart\. Over the last/);
    // Data table.
    const toggle = /** @type {HTMLButtonElement} */ ([...cfd.querySelectorAll("button")].find((b) => text(b) === "Data"));
    toggle.click();
    await settle();
    const table = root.querySelector('[data-report="cfd"] table');
    expect(table?.querySelectorAll("thead th").length).toBe(7);
    expect(table?.querySelectorAll("tbody tr").length).toBe(30);
    expect(root.querySelector('[data-report="cfd"] [data-focus-key="data"]')?.getAttribute("aria-expanded")).toBe("true");
    expect(await axe(root)).toEqual([]);
    // The view's filter applies to every report.
    const before = app.insights.results["workload"].rows.length;
    app.loadView({ ...app.view, id: null, name: "Bugs", query: "label:bug", layout: "insights" });
    await until(() => app.insights.key.includes("label:bug") && !app.insights.loading, { timeout: 5000, message: "refetch" });
    expect(text(root.querySelector(".insights-title"))).toMatch(/labelled Bug/i);
    expect(app.insights.results["workload"].rows.length).toBeLessThanOrEqual(before);
  });

  it("changes a burndown's cycle, edits, duplicates, hides and restores reports", async () => {
    const { app, root, api } = await mount({ seed: 80 });
    app.setLayout("insights");
    await until(() => app.insights.results, { timeout: 5000 });
    const select = /** @type {HTMLSelectElement} */ (root.querySelector('[data-report="burndown"] select'));
    const other = [...select.options].find((o) => !o.selected && /Cycle 22/.test(o.value));
    select.value = /** @type {HTMLOptionElement} */ (other).value;
    select.dispatchEvent(new Event("change"));
    await until(() => app.insights.results?.burndown?.params?.cycle === "Cycle 22", { timeout: 5000, message: "cycle param" });
    expect(text(root.querySelector('[data-report="burndown"] figcaption'))).toMatch(/^Cycle 22 ended with/);
    // Hide a built-in through the store (the menu calls the same), then restore it.
    await app.store.deleteReport("throughput");
    app.render();
    await until(() => !root.querySelector('[data-report="throughput"]'));
    expect(root.querySelector(".insights-head")?.textContent).toMatch(/Hidden \(1\)/);
    await app.store.restoreReport("throughput");
    app.render();
    await until(() => root.querySelector('[data-report="throughput"]'));
    // A saved custom report shows up with its own data.
    await api.saveReport({ id: "bugs-by-person", title: "Bugs by person", dataset: "items", query: "label:bug", spec: { $schema: "https://vega.github.io/schema/vega-lite/v6.json", data: { name: "items" }, mark: "bar", encoding: { y: { field: "assignee", type: "nominal" }, x: { aggregate: "count" } } } });
    await app.store.loadReports();
    app.render();
    await until(() => root.querySelector('[data-report="bugs-by-person"] .report-chart svg'), { timeout: 5000, message: "custom chart" });
    expect(text(root.querySelector('[data-report="bugs-by-person"] .report-title'))).toMatch(/Bugs by person\s*custom/);
  });

  it("opens the report editor, validates on the server and refuses a url spec", async () => {
    const { app, root } = await mount({ seed: 20 });
    app.setLayout("insights");
    await until(() => app.insights.results, { timeout: 5000 });
    app.runAction("newReport");
    await settle();
    const dlg = /** @type {HTMLElement} */ (root.querySelector(".report-editor"));
    expect(dlg).toBeTruthy();
    const title = /** @type {HTMLInputElement} */ (dlg.querySelector('input[type="text"]'));
    title.value = "My chart";
    const spec = /** @type {HTMLTextAreaElement} */ (dlg.querySelector("textarea"));
    spec.value = JSON.stringify({ data: { url: "https://evil.example/x.json" }, mark: "bar" });
    /** @type {HTMLButtonElement} */ ([...dlg.querySelectorAll("button")].find((b) => text(b) === "Save report")).click();
    await until(() => /url/.test(dlg.querySelector(".report-errors")?.textContent ?? ""), { message: "validation errors" });
    expect(await axe(root)).toEqual([]);
  });

  it("the dependency graph's nodes are one tab stop with arrow keys and Enter opens the item", async () => {
    const { app, root } = await mount({ seed: 200 });
    app.setLayout("insights");
    await until(() => root.querySelectorAll('[data-report="dependencies"] .dep-node').length > 1, { timeout: 8000, message: "graph nodes" });
    const nodes = [...root.querySelectorAll('[data-report="dependencies"] .dep-node')];
    expect(nodes.filter((n) => n.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(nodes[0].getAttribute("role")).toBe("button");
    expect(nodes[0].getAttribute("aria-label")).toMatch(/^TW-\d+: .+ Press Enter to open\.$/);
    /** @type {any} */ (nodes[0]).focus();
    nodes[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(nodes[1].getAttribute("tabindex")).toBe("0");
    nodes[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(app.detail.itemId).toBeTruthy();
    expect(root.querySelector(".report-chart.graph")?.getAttribute("role")).toBe("group");
  });
});

describe("Proposals tray", () => {
  it("shows a badge, readable diffs, applies the chosen changes as the viewer and records the outcome", async () => {
    const { app, root, api, fake } = await mount({ seed: 40, approval: "manual" });
    const p = await agentProposes(api);
    await app.store.loadProposals();
    await settle();
    const btn = /** @type {HTMLButtonElement} */ (root.querySelector(".proposals-btn"));
    expect(btn.getAttribute("aria-label")).toBe("Proposals: 1 waiting, 3 changes");
    btn.click();
    await settle();
    const tray = /** @type {HTMLElement} */ (root.querySelector(".tray"));
    expect(tray.getAttribute("role")).toBe("dialog");
    expect(text(tray)).toMatch(/Escalate TW-12.*Proposed by Workshop agent.*Acme is blocked\./);
    expect(text(tray)).toMatch(/TW-12 priority .+ → Urgent/);
    expect(text(tray)).toMatch(/New sub-issue under TW-12: “Write the migration guide”/);
    expect(await axe(root)).toEqual([]);
    // Untick the rename, apply the rest.
    const boxes = /** @type {HTMLInputElement[]} */ ([...tray.querySelectorAll('input[type="checkbox"]')]);
    expect(boxes.every((b) => b.checked)).toBe(true);
    boxes[1].click();
    await settle();
    const apply = /** @type {HTMLButtonElement} */ ([...tray.querySelectorAll("button")].find((b) => text(b).startsWith("Apply")));
    expect(text(apply)).toBe("Apply 2 selected");
    apply.click();
    await until(() => fake.pendingActions().length === 2, { message: "two pending actions" });
    expect(fake.pendingActions().map((a) => [a.command, a.actor])).toEqual([["work.update", "cloudflare-os:ada@example.com"], ["work.create", "cloudflare-os:ada@example.com"]]);
    const stored = await until(async () => { const x = await api.getProposal(p.id); return x.status === "partial" && x; });
    expect(stored.applied_by).toMatchObject({ actor: "cloudflare-os:ada@example.com", name: "Ada Lovelace" });
    expect(stored.changes.map((c) => c.outcome?.status ?? null)).toEqual(["sent", null, "sent"]);
    await until(() => /Escalate TW-12: 2 changes sent/.test(text(/** @type {Element} */ (root.querySelector(".toasts")))), { message: "outcome toast" });
    // Approval lands: the outcome is recorded as applied.
    fake.approveAll();
    await app.store.pull();
    await until(async () => (await api.getProposal(p.id)).changes[0].outcome?.status === "applied", { timeout: 4000, message: "applied outcome" });
  });

  it("marks stale changes, refreshes them onto the current revision, and withdraws", async () => {
    const { app, root, api, fake } = await mount({ seed: 40 });
    const p = await agentProposes(api);
    const twelve = row(fake, 12);
    fake.run("work.update", { id: twelve.id, title: "Edited elsewhere" }, { actor: "cloudflare-os:linus@example.com", revision: twelve.revision });
    await app.store.pull();
    await app.store.loadProposals();
    app.runAction("proposals");
    await settle();
    const tray = /** @type {HTMLElement} */ (root.querySelector(".tray"));
    expect(text(tray)).toMatch(/Needs refresh/);
    expect(/** @type {HTMLInputElement} */ (tray.querySelector('input[type="checkbox"]')).disabled).toBe(true);
    /** @type {HTMLButtonElement} */ ([...tray.querySelectorAll("button")].find((b) => text(b) === "Refresh stale changes")).click();
    await until(() => !/Needs refresh/.test(text(tray)), { message: "refreshed" });
    expect((await api.getProposal(p.id)).changes[0].revision).toBe(row(fake, 12).revision);
    /** @type {HTMLButtonElement} */ ([...tray.querySelectorAll("button")].find((b) => text(b) === "Withdraw")).click();
    await until(async () => (await api.getProposal(p.id)).status === "withdrawn");
    await until(() => /No proposals waiting/.test(text(tray)));
    expect(tray.contains(document.activeElement)).toBe(true);
  });

  it("is read-only without write access", async () => {
    const { app, root, api } = await mount({ seed: 20, access: "read" });
    await agentProposes(api);
    await app.store.loadProposals();
    app.runAction("proposals");
    await settle();
    const tray = /** @type {HTMLElement} */ (root.querySelector(".tray"));
    expect(text(tray)).toMatch(/read-only for you/);
    expect([...tray.querySelectorAll("button")].some((b) => text(b).startsWith("Apply"))).toBe(false);
  });
});

describe("Jev suggestions", () => {
  it("Suggest in the details: confident ones pre-selected, confidence as text, applied as a Jev proposal", async () => {
    const jev = createFakeJev();
    const { app, root, api, fake } = await mount({ seed: 60, jevSession: jev });
    const item = app.store.index().itemList.find((i) => i.kind === "triage" && !i.archived);
    app.openDetail(item, { focus: true });
    await settle();
    const suggestBtn = /** @type {HTMLButtonElement} */ ([...root.querySelectorAll(".detail button")].find((b) => text(b) === "Suggest"));
    suggestBtn.click();
    await until(() => root.querySelector(".suggest-list input"), { message: "suggestions" });
    const dlg = /** @type {HTMLElement} */ (root.querySelector(".suggest"));
    const rows = [...dlg.querySelectorAll(".suggest-list li")];
    for (const r of rows) {
      const pct = Number(/(\d+)% likely/.exec(text(r))?.[1]);
      expect(pct).toBeGreaterThanOrEqual(50);
      expect(/** @type {HTMLInputElement} */ (r.querySelector("input")).checked).toBe(pct >= 90);
    }
    expect(await axe(root)).toEqual([]);
    const before = fake.journal.length;
    if (!dlg.querySelector(".suggest-list input:checked")) { /** @type {HTMLInputElement} */ (dlg.querySelector(".suggest-list input")).click(); await settle(); }
    /** @type {HTMLButtonElement} */ ([...dlg.querySelectorAll("button")].find((b) => text(b).startsWith("Apply"))).click();
    await until(async () => (await api.listProposals({ status: "all" })).length === 1, { message: "proposal stored" });
    const [p] = await api.listProposals({ status: "all" });
    expect(p.proposed_by).toMatchObject({ kind: "jev", name: "Ada Lovelace" });
    await until(() => fake.journal.length > before, { message: "applied" });
    expect(jev.calls).toHaveLength(1);
  });

  it("no Suggest button or Triage with Jev without the optional connection", async () => {
    const { app, root } = await mount({ seed: 30 });
    expect(app.store.jev).toBe(false);
    app.openDetail(app.store.index().itemList[0], { focus: true });
    await settle();
    expect([...root.querySelectorAll(".detail button")].some((b) => text(b) === "Suggest")).toBe(false);
    app.loadView({ ...app.view, id: "builtin:triage", name: "Triage", query: "kind:triage,backlog", layout: "list" });
    await settle();
    expect([...root.querySelectorAll("button")].some((b) => text(b) === "Triage with Jev")).toBe(false);
  });
});
