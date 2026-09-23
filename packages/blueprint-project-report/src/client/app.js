// @ts-check
// The read-only project report. It calls only read methods on the gadget server, which itself has
// no write path to Records.

import { h, option, relativeTime } from "./dom.js";
import { PRIORITIES, PRIORITY_LABELS, filterIssues, loadIssues, recentlyUpdated, summarise, toCsv } from "./report.js";
import { createSync } from "./sync.js";
import { errorCode, errorDetail } from "../shared/records.js";

/** @typedef {import("./report.js").Issue} Issue */

const CSS = `
:root {
  --bg: #f5f6f8; --surface: #fff; --surface-2: #eef0f4; --ink: #1c2230; --ink-2: #4a5263; --muted: #6b7385;
  --line: #d9dde5; --grid: #e6e9ef; --bar: #2f5bd3; --accent: #2f5bd3; --focus: #2f5bd3;
  --warn: #8a5a00; --warn-bg: #fff4d6; --bad: #b3261e; --bad-bg: #fde8e6; --info-bg: #e8eefc;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171d; --surface: #1d2129; --surface-2: #262b35; --ink: #e8ebf1; --ink-2: #c0c6d2; --muted: #9aa2b2;
    --line: #343a46; --grid: #2c313c; --bar: #7b9cff; --accent: #7b9cff; --focus: #9db5ff;
    --warn: #f0c060; --warn-bg: #3a2f14; --bad: #ff8a80; --bad-bg: #3d1d1b; --info-bg: #1e2a47;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
button, select { font: inherit; color: inherit; }
button { cursor: pointer; border: 1px solid var(--line); background: var(--surface); border-radius: 6px; padding: 5px 10px; }
button:hover { border-color: var(--accent); }
button.link { border: 0; background: none; color: var(--accent); padding: 0 2px; text-decoration: underline; }
select { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; max-width: 100%; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.pr-header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--surface); }
.pr-header h1 { font-size: 16px; margin: 0; }
.pr-header .datastore, .muted { color: var(--muted); font-size: 13px; }
.spacer { flex: 1; }
.pr-filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px 16px 0; }
.banner { margin: 8px 16px 0; padding: 8px 12px; border-radius: 8px; background: var(--info-bg); }
.banner.warn { background: var(--warn-bg); color: var(--warn); }
.banner.bad { background: var(--bad-bg); color: var(--bad); }
.pr-body { padding: 12px 16px 24px; display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
.tiles { grid-column: 1 / -1; display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
.tile, .card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; min-width: 0; }
.tile .label { color: var(--ink-2); font-size: 12px; }
.tile .value { font-size: 26px; font-weight: 650; font-variant-numeric: tabular-nums; }
.card h2 { font-size: 14px; margin: 0 0 8px; }
.card.wide { grid-column: 1 / -1; }
ul.bars { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
ul.bars li { display: grid; grid-template-columns: minmax(70px, 38%) 1fr 3ch; gap: 8px; align-items: center; font-size: 13px; }
ul.bars .bar-label { color: var(--ink-2); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
ul.bars .bar-track { height: 12px; background: var(--grid); border-radius: 4px; overflow: hidden; }
ul.bars .bar-fill { display: block; height: 100%; background: var(--bar); border-radius: 4px; }
ul.bars li:hover .bar-fill { opacity: .8; }
ul.bars .bar-value { font-variant-numeric: tabular-nums; text-align: right; }
details { margin-top: 6px; font-size: 12px; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--grid); overflow-wrap: anywhere; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.recent td:first-child { white-space: nowrap; color: var(--muted); }
.state-panel { max-width: 560px; margin: 48px auto; padding: 24px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; }
.state-panel h2 { margin-top: 0; font-size: 18px; }
@media (max-width: 520px) { .recent .hide-narrow { display: none; } }
`;

export const windowNameStore = {
  load() {
    try { const raw = window.name; return typeof raw === "string" && raw.startsWith("project-report:") ? JSON.parse(raw.slice(15)) : {}; } catch { return {}; }
  },
  /** @param {any} v */
  save(v) { try { window.name = "project-report:" + JSON.stringify(v); } catch { /* ignore */ } },
};

/**
 * One horizontal bar chart in plain HTML/CSS: a single series, so no legend. Each bar carries its
 * label and value as real text, a hover tooltip with its share, and the same numbers are in a table.
 * @param {string} title @param {{key: string, label: string, count: number}[]} rows
 */
export function barChart(title, rows) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  const total = rows.reduce((n, r) => n + r.count, 0);
  return h("section", { class: "card", "aria-label": title },
    h("h2", null, title),
    rows.length
      ? h("ul", { class: "bars", "aria-label": `${title}: ${rows.map((r) => `${r.label} ${r.count}`).join(", ")}` },
        rows.map((r) => h("li", { "data-key": r.key, title: `${r.label}: ${r.count} (${total ? Math.round((r.count / total) * 100) : 0}%)` },
          h("span", { class: "bar-label" }, r.label),
          h("span", { class: "bar-track", "aria-hidden": "true" },
            r.count ? h("span", { class: "bar-fill", style: `width: max(4px, ${((r.count / max) * 100).toFixed(1)}%)` }) : null),
          h("span", { class: "bar-value" }, String(r.count)))))
      : h("p", { class: "muted" }, "No issues."),
    rows.length ? h("details", null, h("summary", null, "Show as table"),
      h("table", null, h("thead", null, h("tr", null, h("th", null, "Group"), h("th", { class: "num" }, "Issues"))),
        h("tbody", null, rows.map((r) => h("tr", null, h("td", null, r.label), h("td", { class: "num" }, String(r.count))))))) : null);
}

/**
 * @param {{gadget: any, root: HTMLElement, prefs?: {load(): any, save(v: any): void},
 *   download?: (name: string, text: string) => void, autoStart?: boolean}} options
 */
export function createReportApp(options) {
  const { gadget, root } = options;
  const prefs = options.prefs ?? windowNameStore;
  const saved = prefs.load() ?? {};
  const state = {
    /** @type {"loading"|"not_connected"|"incompatible"|"forbidden"|"no_read"|"error"|"ready"} */
    phase: "loading",
    errorMessage: "",
    staleError: "",
    /** @type {any} */ setup: null,
    /** @type {any} */ binding: null,
    /** @type {any[]} */ projects: [],
    /** @type {any} */ workflow: null,
    /** @type {Issue[]} */ issues: [],
    truncated: false,
    view: { projectId: "", state: "", priority: "", assigneeId: "", ...saved.view },
    sync: { live: "off", lastRefresh: /** @type {number|null} */ (null), error: /** @type {string|null} */ (null) },
    notice: "",
  };

  const sync = createSync({
    gadget,
    onRefetchAll: () => load({ quiet: true }),
    // Any change can move every count, so a report simply re-reads.
    onChanges: () => load({ quiet: true }),
    onStatus: (s) => { state.sync = s; render(); },
    isHidden: () => document.hidden,
  });

  async function load({ quiet = false } = {}) {
    if (!quiet) { state.phase = "loading"; render(); }
    try {
      const setup = await gadget.getSetup();
      state.setup = setup;
      if (!setup.connected) { state.phase = "not_connected"; render(); return; }
      if (setup.error) throw new Error(setup.error);
      state.binding = setup.binding;
      if (setup.binding.moduleId !== setup.requirement.moduleId || setup.binding.apiMajor !== setup.requirement.apiMajor) {
        state.phase = "incompatible"; render(); return;
      }
      if (!["projects.read", "issues.read"].every((s) => setup.binding.scopes.includes(s))) { state.phase = "no_read"; render(); return; }
      const [projects, workflow, loaded] = await Promise.all([
        gadget.listProjects(), gadget.getWorkflow(), loadIssues((input) => gadget.listIssues(input)),
      ]);
      Object.assign(state, { projects, workflow, issues: loaded.items, truncated: loaded.truncated, phase: "ready", staleError: "" });
      if (state.view.projectId && !projects.some((/** @type {any} */ p) => p.id === state.view.projectId)) state.view.projectId = "";
      render();
    } catch (err) {
      const code = errorCode(err);
      const phase = code === "not_connected" ? "not_connected" : code === "forbidden" || code === "unauthenticated" ? "forbidden" : "error";
      if (state.phase === "ready" && phase === "error") state.staleError = errorDetail(err);
      else { state.phase = phase; state.errorMessage = errorDetail(err); }
      render();
    }
  }

  function currentIssues() { return filterIssues(state.issues, state.view); }

  function downloadCsv() {
    const csv = toCsv(currentIssues(), state.projects, state.workflow);
    const project = state.projects.find((p) => p.id === state.view.projectId);
    const name = `${(project?.key ?? state.binding?.datastore.name ?? "issues").replace(/[^\w.-]+/g, "-")}-issues.csv`;
    try {
      (options.download ?? browserDownload)(name, csv);
      state.notice = "";
    } catch {
      state.notice = "Your browser blocked the download. Use the gadget menu → Export → CSV (all issues) instead.";
    }
    render();
  }

  /** @param {Partial<typeof state.view>} patch */
  function setView(patch) {
    Object.assign(state.view, patch);
    prefs.save({ ...prefs.load(), view: state.view });
    render();
  }

  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);

  function render() {
    const focusedLabel = /** @type {HTMLElement|null} */ (document.activeElement)?.getAttribute?.("aria-label");
    const openTables = new Set([...root.querySelectorAll("details[open]")].map((d) => d.closest("section")?.getAttribute("aria-label")));
    root.replaceChildren(header(), ...banners(), ...(state.phase === "ready" ? [filters(), body()] : [statePanel()]));
    for (const d of root.querySelectorAll("details")) if (openTables.has(d.closest("section")?.getAttribute("aria-label"))) d.setAttribute("open", "");
    if (focusedLabel) /** @type {HTMLElement|null} */ ([...root.querySelectorAll("[aria-label]")].find((e) => e.getAttribute("aria-label") === focusedLabel) ?? null)?.focus();
  }

  function header() {
    const b = state.binding;
    const live = state.sync.live === "active" ? "Live updates on" : state.sync.live === "requested" ? "Live updates awaiting approval · refreshing every minute" : "Refreshing every minute";
    return h("header", { class: "pr-header" },
      h("h1", null, "Project report"),
      b ? h("span", { class: "datastore" }, `${b.datastore.name}${b.datastore.lifecycle === "archived" ? " (archived)" : ""} · read-only`) : null,
      h("span", { class: "spacer" }),
      state.phase === "ready" ? h("span", { class: "muted", role: "status" }, live + (state.sync.lastRefresh ? ` · updated ${relativeTime(new Date(state.sync.lastRefresh).toISOString())}` : "")) : null,
      state.phase === "ready" && state.sync.live === "off" ? h("button", { class: "link", onclick: async () => {
        try { await sync.requestLive(); } catch (err) { state.notice = `Live updates could not be requested: ${errorDetail(err)}`; render(); }
      } }, "Turn on live updates") : null,
      state.phase !== "loading" ? h("button", { "aria-label": "Refresh from the datastore", onclick: () => void sync.refreshNow().catch(() => {}) }, "Refresh") : null);
  }

  function banners() {
    const out = [];
    if (state.phase === "ready" && state.binding?.datastore.lifecycle === "archived") out.push(h("div", { class: "banner warn", role: "status" }, "This datastore is archived. Its figures no longer change."));
    if (state.staleError) out.push(h("div", { class: "banner bad", role: "alert" }, `The last refresh failed (${state.staleError}). Figures may be out of date.`));
    if (state.truncated) out.push(h("div", { class: "banner", role: "status" }, "This datastore has more than 2,000 issues. The report covers the 2,000 most recently updated."));
    if (state.notice) out.push(h("div", { class: "banner warn", role: "status" }, state.notice));
    return out;
  }

  function statePanel() {
    const retry = h("button", { onclick: () => void load() }, "Check again");
    switch (state.phase) {
      case "loading": return h("div", { class: "state-panel", role: "status" }, h("h2", null, "Loading the report…"));
      case "not_connected": return h("div", { class: "state-panel" }, h("h2", null, "Connect a Projects datastore"),
        h("p", null, "Open this gadget's Connections tab, connect a Records account, choose a Projects datastore and use the binding name RECORDS. The report only needs projects.read and issues.read."), retry);
      case "incompatible": return h("div", { class: "state-panel", role: "alert" }, h("h2", null, "This datastore does not fit this report"),
        h("p", null, `The report reads ${state.setup?.requirement.moduleId} API v${state.setup?.requirement.apiMajor}; the connection offers ${state.binding?.moduleId} API v${state.binding?.apiMajor}.`));
      case "forbidden": return h("div", { class: "state-panel", role: "alert" }, h("h2", null, "You don't have access to this datastore"),
        h("p", null, "Records checks your own membership of the datastore. Having this report shared with you does not grant access to its records. Ask a datastore owner or administrator to add you as a reader."), retry);
      case "no_read": return h("div", { class: "state-panel", role: "alert" }, h("h2", null, "This connection cannot read issues"),
        h("p", null, "Reconnect the datastore with projects.read and issues.read."));
      default: return h("div", { class: "state-panel", role: "alert" }, h("h2", null, "The Records service is unavailable"),
        h("p", null, state.errorMessage || "The report could not be loaded."), h("button", { onclick: () => void load() }, "Try again"));
    }
  }

  function filters() {
    const people = new Map();
    for (const i of state.issues) if (i.assignee) people.set(i.assignee.id, i.assignee.displayName);
    const sel = (/** @type {string} */ label, /** @type {keyof typeof state.view} */ key, /** @type {HTMLElement[]} */ opts) =>
      h("select", { "aria-label": label, onchange: (/** @type {Event} */ e) => setView({ [key]: /** @type {HTMLSelectElement} */ (e.target).value }) }, opts);
    const v = state.view;
    return h("div", { class: "pr-filters", role: "group", "aria-label": "Report filters" },
      sel("Project", "projectId", [option("", "All projects", !v.projectId), ...state.projects.map((p) => option(p.id, `${p.key} · ${p.name}`, v.projectId === p.id))]),
      sel("State", "state", [option("", "Any state", !v.state), ...[...state.workflow.states].toSorted((a, b) => a.position - b.position).map((s) => option(s.key, s.name, v.state === s.key))]),
      sel("Priority", "priority", [option("", "Any priority", !v.priority), ...PRIORITIES.map((p) => option(p, PRIORITY_LABELS[p], v.priority === p))]),
      sel("Assignee", "assigneeId", [option("", "Anyone", !v.assigneeId), option("none", "Unassigned", v.assigneeId === "none"),
        ...[...people.entries()].toSorted((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => option(id, name, v.assigneeId === id))]),
      h("span", { class: "spacer" }),
      h("button", { "aria-label": "Download CSV of the current view", onclick: downloadCsv }, "Download CSV"));
  }

  function body() {
    const issues = currentIssues();
    const s = summarise(issues, state.workflow);
    const stateName = new Map(state.workflow.states.map((/** @type {any} */ st) => [st.key, st.name]));
    const tile = (/** @type {string} */ label, /** @type {number} */ value) => h("div", { class: "tile" }, h("div", { class: "label" }, label), h("div", { class: "value" }, value.toLocaleString()));
    return h("main", { class: "pr-body" },
      h("div", { class: "tiles" }, tile("Issues", s.total), tile("Open", s.open), tile("Done", s.done), tile("Open and unassigned", s.unassignedOpen)),
      barChart("By state", s.byState),
      barChart("By priority", s.byPriority),
      barChart("By assignee", s.byAssignee),
      h("section", { class: "card wide", "aria-label": "Recently updated" },
        h("h2", null, "Recently updated"),
        issues.length ? h("table", { class: "recent" },
          h("thead", null, h("tr", null, h("th", null, "Key"), h("th", null, "Title"), h("th", null, "State"), h("th", { class: "hide-narrow" }, "Updated"))),
          h("tbody", null, recentlyUpdated(issues).map((i) => h("tr", null, h("td", null, i.key), h("td", null, i.title),
            h("td", null, stateName.get(i.state) ?? i.state),
            h("td", { class: "hide-narrow" }, `${relativeTime(i.updatedAt)} by ${i.updatedBy.displayName}`)))))
          : h("p", { class: "muted" }, "No issues match this view.")));
  }

  render();
  let ready = Promise.resolve();
  if (options.autoStart !== false) {
    ready = sync.start().catch(() => {});
    document.addEventListener("visibilitychange", () => { if (!document.hidden) void sync.wake(); });
  }
  return { state, ready, load, setView, downloadCsv, render, destroy() { sync.stop(); style.remove(); root.replaceChildren(); } };
}

/** @param {string} name @param {string} text */
function browserDownload(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
