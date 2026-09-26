// @ts-check
// The Insights layout: a responsive grid of report cards next to Board and List. Each card has a
// title, a Vega chart, a one-sentence summary (the chart's text alternative), a "Data" toggle with
// an accessible table of the plotted rows, and a menu (edit, duplicate, view spec, delete). The
// view's filter applies to every report. Data comes from the gadget server in one batched call
// (`insights()`); the app owns fetching and hands this view a model.

import { h, reconcile, relativeTime, setChildren } from "../ui/dom.js";
import { icon } from "../ui/icons.js";
import { currentTheme, focusableNodes, renderChart } from "../ui/chart.js";

const CHART_HEIGHT = 220;
const TABLE_ROWS = 200;

/**
 * How each built-in report's data table reads: plain columns, or a pivot (rows × series).
 * @type {Record<string, { columns?: [string, string][], pivot?: { row: string, rowLabel: string, col: string, value: string }, graph?: boolean }>}
 */
const TABLES = {
  cfd: { pivot: { row: "day", rowLabel: "Day", col: "kind_label", value: "count" } },
  "cycle-time": { columns: [["key", "Item"], ["title", "Title"], ["days", "Days"], ["completed_day", "Completed"], ["assignee", "Assignee"], ["rolling_avg", "Rolling average"]] },
  burndown: { columns: [["day", "Day"], ["scope", "Scope"], ["completed", "Completed"], ["remaining", "Remaining"], ["ideal", "Ideal"]] },
  burnup: { columns: [["day", "Day"], ["scope", "Scope"], ["completed", "Completed"]] },
  throughput: { columns: [["week", "Week of"], ["completed", "Items"], ["points", "Points"], ["partial", "Week in progress"]] },
  "created-resolved": { columns: [["day", "Day"], ["created", "Created"], ["resolved", "Resolved"], ["created_total", "Created (total)"], ["resolved_total", "Resolved (total)"]] },
  workload: { pivot: { row: "assignee", rowLabel: "Person", col: "kind_label", value: "count" } },
  dependencies: { graph: true },
};

/**
 * @typedef {{ id: string, title: string, description?: string, dataset: string, params: Record<string, unknown>, query: string,
 *   spec: Record<string, any>, builtin?: boolean, customised?: boolean, hidden?: boolean, controls?: string[] }} Report
 * @typedef {{ rows: Record<string, any>[], summary: string, params: Record<string, unknown>, total: number, error: string|null }} Result
 * @typedef {{
 *   reports: Report[], hiddenCount: number, results: Record<string, Result>|null, loading: boolean, error: string,
 *   at: number|null, now: number, historyComplete: boolean, filter: string, filterDescription: string, canWrite: boolean,
 *   cycles: { name: string, current: boolean }[], params: (id: string) => Record<string, unknown>,
 * }} InsightsModel
 */

/** @param {Report} r @param {Result} result */
function isEmpty(r, result) {
  if (!result.rows.length) return true;
  if (r.dataset === "dependencies") return !result.rows.some((x) => x.type === "edge");
  if (["daily_state_counts", "throughput", "created_vs_resolved"].includes(r.dataset)) {
    return !result.rows.some((x) => (x.count ?? x.completed ?? (x.created || x.resolved)) > 0);
  }
  return false;
}

/**
 * @param {{ doc: Document, onAction: (type: string, payload?: any) => void }} deps
 */
export function createInsightsView({ doc, onAction }) {
  const win = doc.defaultView ?? window;
  const head = h("div", { class: "insights-head" });
  const grid = h("div", { class: "insights-grid" });
  const el = h("div", { class: "insights-scroll", tabindex: "-1", "aria-label": "Insights: reports" }, head, grid);
  /** @type {Map<string, { sig: string, destroy: (() => void)|null, width: number, pending: boolean }>} */
  const charts = new Map();
  /** @type {Set<string>} */
  const openTables = new Set();
  /** @type {InsightsModel|null} */
  let model = null;
  let theme = currentTheme(win);
  /** @type {string|null} */
  let focusId = null;

  const media = win.matchMedia?.("(prefers-color-scheme: dark)");
  media?.addEventListener?.("change", () => { theme = currentTheme(win); for (const c of charts.values()) c.sig = ""; if (model) update(model); });
  /** @type {ResizeObserver|null} */
  const resize = typeof win.ResizeObserver === "function" ? new win.ResizeObserver((entries) => {
    let changed = false;
    for (const e of entries) {
      const id = /** @type {HTMLElement} */ (e.target).dataset.report ?? "";
      const c = charts.get(id);
      if (c && Math.abs(c.width - e.contentRect.width) > 24) { c.sig = ""; changed = true; }
    }
    if (changed && model) update(model);
  }) : null;

  /** @param {InsightsModel} m */
  function update(m) {
    model = m;
    renderHead(m);
    reconcile(grid, m.reports, {
      key: (r) => r.id,
      create: (r) => card(r),
      update: (node, r) => fill(/** @type {HTMLElement} */ (node), r, m),
    });
    for (const id of charts.keys()) if (!m.reports.some((r) => r.id === id)) { charts.get(id)?.destroy?.(); charts.delete(id); }
  }

  /** @param {InsightsModel} m */
  function renderHead(m) {
    const count = `${m.reports.length} ${m.reports.length === 1 ? "report" : "reports"}`;
    const status = m.error ? h("span", { class: "insights-error", role: "alert" }, icon("warning", { size: 14 }), ` ${m.error}`)
      : m.loading && !m.results ? h("span", { class: "muted" }, "Reading the journal…")
        : m.at ? h("span", { class: "muted" }, `Updated ${relativeTime(m.at, m.now)}${m.loading ? " · refreshing…" : ""}`) : null;
    setChildren(head,
      h("div", { class: "insights-title" }, h("h2", null, "Insights"),
        h("p", { class: "muted" }, count, m.filter ? h("span", null, " · ", h("span", { class: "filter-note" }, m.filterDescription)) : " · all items", " · days in UTC")),
      h("span", { class: "grow" }),
      status,
      !m.historyComplete ? h("span", { class: "muted" }, "History is partial: the journal is longer than the board reads.") : null,
      m.hiddenCount ? h("button", { type: "button", class: "btn sm", onclick: (/** @type {Event} */ e) => onAction("insights:hidden", e.currentTarget) }, `Hidden (${m.hiddenCount})`) : null,
      m.canWrite ? h("button", { type: "button", class: "btn sm", onclick: () => onAction("insights:new") }, icon("plus", { size: 14 }), "New report") : null);
  }

  /** @param {Report} r */
  function card(r) {
    const tid = `rep-${r.id}-t`;
    const section = h("section", { class: "report-card", "aria-labelledby": tid, "data-report": r.id });
    section.addEventListener("focusin", () => { focusId = r.id; });
    resize?.observe(section);
    return section;
  }

  /** @param {HTMLElement} section @param {Report} r @param {InsightsModel} m */
  function fill(section, r, m) {
    const result = m.results?.[r.id] ?? null;
    const params = { ...r.params, ...m.params(r.id) };
    const sig = JSON.stringify([r.title, r.description, r.spec, r.customised, result?.summary, result?.error, result?.total, params, m.loading && !m.results, m.canWrite, m.cycles, openTables.has(r.id), theme]);
    const chartSig = JSON.stringify([result ? m.at : null, result?.params, r.spec, theme]);
    const structure = section.dataset.sig !== sig;
    if (structure) {
      section.dataset.sig = sig;
      build(section, r, m, result, params);
    }
    const state = charts.get(r.id) ?? { sig: "", destroy: null, width: 0, pending: false };
    charts.set(r.id, state);
    if (structure || state.sig !== chartSig) void draw(section, r, result, chartSig, state);
  }

  /** @param {HTMLElement} section @param {Report} r @param {InsightsModel} m @param {Result|null} result @param {Record<string, unknown>} params */
  function build(section, r, m, result, params) {
    const tid = `rep-${r.id}-t`, sid = `rep-${r.id}-s`, did = `rep-${r.id}-d`;
    const had = section.contains(doc.activeElement) ? /** @type {HTMLElement} */ (doc.activeElement).dataset.focusKey ?? null : null;
    const controls = [];
    if (r.controls?.includes("cycle") && m.cycles.length) {
      const id = `rep-${r.id}-cycle`;
      const current = String(result?.params?.cycle ?? params.cycle ?? "");
      const select = /** @type {HTMLSelectElement} */ (h("select", { id, class: "report-select", "data-focus-key": "cycle" },
        m.cycles.map((c) => h("option", { value: c.name, selected: c.name === current }, c.current ? `${c.name} (current)` : c.name))));
      select.addEventListener("change", () => onAction("insights:params", { id: r.id, params: { cycle: select.value } }));
      controls.push(h("label", { class: "sr-only", for: id }, `Cycle for ${r.title}`), select);
    }
    const graph = TABLES[r.id]?.graph === true && r.dataset === "dependencies";
    const empty = result && !result.error && isEmpty(r, result);
    const chartBox = h("div", {
      class: `report-chart${graph ? " graph" : ""}`, "data-chart": r.id,
      role: graph && !empty ? "group" : "img",
      "aria-label": graph && !empty ? `${r.title}: ${result?.summary ?? ""} Use the arrow keys to move between items and Enter to open one.` : `${r.title} chart. ${result?.summary ?? "Loading."}`,
    });
    const tableOpen = openTables.has(r.id);
    setChildren(section,
      h("header", { class: "report-head" },
        h("div", { class: "report-titles" },
          h("h3", { id: tid, class: "report-title" }, r.title, r.customised ? h("span", { class: "tag" }, "edited") : null, r.builtin === false ? h("span", { class: "tag" }, "custom") : null),
          r.description ? h("p", { class: "report-desc" }, r.description) : null),
        h("div", { class: "report-controls" }, ...controls,
          h("button", { type: "button", class: "icon-btn", "data-focus-key": "menu", "aria-haspopup": "dialog", "aria-label": `Actions for ${r.title}`, title: "Edit, duplicate, view spec, delete",
            onclick: (/** @type {Event} */ e) => onAction("insights:menu", { report: r, anchor: e.currentTarget }) }, icon("more", { size: 16 })))),
      h("figure", { class: "report-figure", "aria-labelledby": tid, "aria-describedby": sid },
        result?.error ? h("p", { class: "report-empty bad", role: "alert" }, result.error.replace(/^[a-z_]+:\s*/, ""))
          : empty ? h("p", { class: "report-empty" }, icon("info", { size: 16 }), h("span", null, result?.summary || "Nothing to show."))
            : chartBox,
        h("figcaption", { id: sid, class: "report-summary" }, result ? (result.error ? "" : result.summary) : h("span", { class: "sk-line", "aria-hidden": "true" }), result ? null : h("span", { class: "sr-only" }, "Loading"))),
      h("div", { class: "report-foot" },
        h("button", { type: "button", class: "btn ghost sm", "data-focus-key": "data", "aria-expanded": String(tableOpen), "aria-controls": did, disabled: !result || Boolean(result.error),
          onclick: () => { if (openTables.has(r.id)) openTables.delete(r.id); else openTables.add(r.id); if (model) update(model); focusKey(r.id, "data"); } },
          icon(tableOpen ? "chevronDown" : "chevronRight", { size: 14 }), tableOpen ? "Hide data" : "Data"),
        result && !result.error ? h("span", { class: "muted" }, `${result.total.toLocaleString("en")} ${result.total === 1 ? "row" : "rows"}`) : null),
      h("div", { id: did, class: "report-data", hidden: !tableOpen }, tableOpen && result ? table(r, result) : null));
    if (had) focusKey(r.id, had);
  }

  /** @param {string} id @param {string} key */
  function focusKey(id, key) {
    const target = /** @type {HTMLElement|null} */ (grid.querySelector(`[data-report="${id}"] [data-focus-key="${key}"]`));
    target?.focus();
  }

  /**
   * @param {HTMLElement} section @param {Report} r @param {Result|null} result @param {string} sig
   * @param {{ sig: string, destroy: (() => void)|null, width: number, pending: boolean }} state
   */
  async function draw(section, r, result, sig, state) {
    const box = /** @type {HTMLElement|null} */ (section.querySelector(".report-chart"));
    state.destroy?.();
    state.destroy = null;
    if (!box) { state.sig = sig; return; }
    if (!result) { setChildren(box, h("div", { class: "sk-chart", "aria-hidden": "true" })); return; }
    const width = Math.max(240, Math.floor(box.getBoundingClientRect().width || section.getBoundingClientRect().width - 32 || 480));
    state.sig = sig;
    state.width = section.getBoundingClientRect().width;
    // Vega marks its own container as a graphics document; render into an inner element so the
    // box keeps the chart's accessible role and name (the summary).
    const canvas = h("div", { class: "chart-canvas" });
    box.replaceChildren(canvas);
    try {
      const { destroy } = await renderChart(canvas, {
        spec: r.spec, dataset: r.dataset, rows: result.rows, width, height: CHART_HEIGHT, theme, tooltipHost: section,
        onClick: (d) => { if (typeof d?.key === "string" && r.dataset === "dependencies") onAction("insights:open", d.key); },
      });
      if (state.sig !== sig) { destroy(); return; }
      state.destroy = destroy;
      for (const a of ["role", "aria-roledescription", "aria-label", "tabindex"]) canvas.removeAttribute(a);
      if (r.dataset === "dependencies") {
        focusableNodes(box, {
          label: (d) => `${d.key}: ${d.title}. ${d.state}${d.assignee ? `, ${d.assignee}` : ""}.${d.blocked ? ` Blocked${d.depth > 1 ? ` (chain ${d.depth} deep)` : ""}.` : ""}${d.blocking ? ` Blocks ${d.blocking} ${d.blocking === 1 ? "item" : "items"}.` : ""}${d.context ? " Outside the filter." : ""} Press Enter to open.`,
          open: (d) => onAction("insights:open", d.key),
        });
      }
    } catch (err) {
      setChildren(box, h("p", { class: "report-empty bad" }, `This chart could not be drawn: ${String(/** @type {any} */ (err)?.message ?? err).slice(0, 200)}. The data table still works.`));
      box.setAttribute("role", "group");
    }
  }

  /** @param {Report} r @param {Result} result */
  function table(r, result) {
    const spec = TABLES[r.builtin !== false ? r.id : ""] ?? null;
    const caption = h("caption", { class: "sr-only" }, `${r.title}: data`);
    if (spec?.graph) {
      const nodes = result.rows.filter((x) => x.type === "node");
      const edges = result.rows.filter((x) => x.type === "edge");
      const blockers = (/** @type {string} */ key) => edges.filter((e) => e.target === key).map((e) => e.source).join(", ") || "—";
      const blocks = (/** @type {string} */ key) => edges.filter((e) => e.source === key).map((e) => e.target).join(", ") || "—";
      return tableOf(caption, ["Item", "Title", "State", "Blocked by", "Blocks"],
        nodes.slice(0, TABLE_ROWS).map((n) => [itemButton(n.key), n.title, n.state, blockers(n.key), blocks(n.key)]), nodes.length);
    }
    if (spec?.pivot) {
      const { row, rowLabel, col, value } = spec.pivot;
      const cols = [...new Set(result.rows.map((x) => String(x[col])))];
      /** @type {Map<string, Record<string, any>>} */
      const byRow = new Map();
      for (const x of result.rows) {
        const k = String(x[row]);
        const rec = byRow.get(k) ?? {};
        rec[String(x[col])] = x[value];
        byRow.set(k, rec);
      }
      const rows = [...byRow].map(([k, rec]) => [k, ...cols.map((c) => rec[c] ?? 0)]);
      return tableOf(caption, [rowLabel, ...cols], rows.slice(0, TABLE_ROWS), rows.length);
    }
    const cols = spec?.columns ?? Object.keys(result.rows[0] ?? {}).slice(0, 8).map((k) => /** @type {[string, string]} */ ([k, k]));
    return tableOf(caption, cols.map((c) => c[1]), result.rows.slice(0, TABLE_ROWS).map((x) => cols.map(([k]) => (k === "key" && typeof x[k] === "string" ? itemButton(x[k]) : x[k]))), result.rows.length);
  }

  /** @param {string} key */
  function itemButton(key) {
    return h("button", { type: "button", class: "link", onclick: () => onAction("insights:open", key) }, key);
  }

  /** @param {HTMLElement} caption @param {string[]} headers @param {any[][]} rows @param {number} total */
  function tableOf(caption, headers, rows, total) {
    const numeric = headers.map((_, i) => rows.length > 0 && rows.every((r) => r[i] === null || r[i] === undefined || typeof r[i] === "number"));
    return h("div", { class: "report-table-wrap", tabindex: "0", role: "region", "aria-label": caption.textContent ?? "Data" },
      h("table", { class: "report-table" }, caption,
        h("thead", null, h("tr", null, headers.map((t, i) => h("th", { scope: "col", class: numeric[i] ? "num" : "" }, t)))),
        h("tbody", null, rows.map((r) => h("tr", null, r.map((v, i) => (i === 0 ? h("th", { scope: "row", class: numeric[i] ? "num" : "" }, cell(v)) : h("td", { class: numeric[i] ? "num" : "" }, cell(v)))))))),
      total > rows.length ? h("p", { class: "hint" }, `Showing ${rows.length} of ${total.toLocaleString("en")} rows. The agent can read them all with dataset().`) : null);
  }

  /** @param {unknown} v */
  function cell(v) {
    if (v instanceof win.Node) return v;
    if (v === null || v === undefined || v === "") return "—";
    if (typeof v === "boolean") return v ? "Yes" : "No";
    if (typeof v === "number") return v.toLocaleString("en");
    return String(v);
  }

  return {
    el,
    update,
    /** Arrow keys move between report cards. @param {string} dir */
    navigate(dir) {
      const cards = /** @type {HTMLElement[]} */ ([...grid.querySelectorAll(".report-card")]);
      if (!cards.length) return false;
      const i = Math.max(0, cards.findIndex((c) => c.dataset.report === focusId));
      const next = dir === "down" || dir === "right" || dir === "pageDown" ? Math.min(cards.length - 1, i + 1) : dir === "up" || dir === "left" || dir === "pageUp" ? Math.max(0, i - 1) : dir === "first" ? 0 : dir === "last" ? cards.length - 1 : i;
      const target = /** @type {HTMLElement|null} */ (cards[next].querySelector("h3"));
      if (target) { target.setAttribute("tabindex", "-1"); target.focus(); focusId = cards[next].dataset.report ?? null; }
      return true;
    },
    focusCurrent() {
      const current = (focusId && grid.querySelector(`[data-report="${focusId}"]`)) || grid.querySelector(".report-card");
      const target = /** @type {HTMLElement|null} */ (current?.querySelector("h3") ?? null);
      if (!target) { el.focus(); return true; }
      target.setAttribute("tabindex", "-1");
      target.focus();
      return true;
    },
    destroy() { for (const c of charts.values()) c.destroy?.(); charts.clear(); resize?.disconnect(); },
  };
}
