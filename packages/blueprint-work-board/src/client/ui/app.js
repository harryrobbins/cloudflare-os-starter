// @ts-check
// The Work Board app: wires the store (Records truth + pending overlay) to the shell, the
// layouts (board, list), the detail panel, the filter bar, pickers, palette and shortcuts.
//
// One verb grammar: every action is in ACTIONS with a label and shortcut; the palette lists
// them, the shortcut sheet documents them, menus and keys call the same code.

import { h, reconcile, relativeTime, setChildren } from "./dom.js";
import { icon, stateIcon } from "./icons.js";
import { CSS } from "./styles.js";
import { createLayers, createLive } from "./overlay.js";
import { createBoardView } from "./board.js";
import { createListView, LIST_COLUMNS } from "./list.js";
import { createDetail } from "./detail.js";
import { createFilterBar } from "./filterbar.js";
import { createPickers } from "./pickers.js";
import { openPicker } from "./picker.js";
import { openPalette } from "./palette.js";
import { openCreate } from "./create.js";
import { openSettings } from "./settings.js";
import { createStatusCentre, createToasts } from "./status.js";
import { SHORTCUTS, keyLabel, matchShortcut, isTyping } from "./keys.js";
import { itemStateIcon } from "./card.js";
import { createStore } from "../store/store.js";
import { SINGLE_LANE, movePatch, project } from "../board/projection.js";
import { registerLayout, layoutDef } from "../views/registry.js";
import { BINDING_NAME } from "../../shared/records.js";
import { itemByKey, projectItem } from "../../shared/model/index.js";
import { NONE, groupableFields, property } from "../../shared/model/properties.js";
import { PRIORITIES, localDay } from "../../shared/model/work.js";
import { rankAt } from "../../shared/rank.js";
import { DEFAULT_SORT, compare, compile, format, fromChips, mentionsArchived, parse, suggest } from "../../shared/wql/index.js";
import { fuzzyScore } from "./fuzzy.js";
import { createInsightsView } from "../views/insights.js";
import { createProposalsTray } from "./proposals.js";
import { openSuggestions } from "./suggest.js";
import { openReportEditor } from "./reports.js";
import { applyProposal, changeState, outcomeOf } from "../store/apply.js";
import { describe as describeWql } from "../../shared/wql/index.js";
import { listDatasets } from "../../shared/datasets/index.js";

registerLayout({ id: "board", label: "Board", icon: "board", create: (deps) => createBoardView(deps) });
registerLayout({ id: "list", label: "List", icon: "list", create: (deps) => createListView(deps) });
registerLayout({ id: "insights", label: "Insights", icon: "chart", create: (deps) => /** @type {any} */ (createInsightsView(deps)) });
const LAYOUT_IDS = ["board", "list", "insights"];
const LAYOUT_LABELS = { board: "Board", list: "List", insights: "Insights" };

const BOARD_SORT = [{ field: "rank", dir: /** @type {const} */ ("asc") }, { field: "priority", dir: /** @type {const} */ ("asc") }, { field: "key", dir: /** @type {const} */ ("desc") }];
const PROPS = ["key", "priority", "assignee", "labels", "estimate", "due", "progress", "blocked", "comments"];
const LIST_DEFAULT = ["key", "title", "state", "priority", "assignee", "labels", "estimate", "due", "updated"];

/**
 * @typedef {import("../../shared/model/index.js").ItemView} ItemView
 * @typedef {{ id: string|null, name: string, query: string, layout: string, columnsBy: string, swimlanesBy: string|null,
 *   sort: { field: string, dir: "asc"|"desc" }[],
 *   display: { density: string, properties: string[], showSubIssues: boolean, showArchived: boolean, hideEmptyLanes: boolean, hideEmptyColumns: boolean|null, listColumns: string[] } }} ViewCfg
 */

/** A blank item for computing default property values. */
function blankItem() { return { id: "", labels: [], assignee: null, priority: 0, project: null, cycle: null, parent: null, ext: {}, state: "", category: "open" }; }

/** @param {ViewCfg} v */
function toDoc(v) { return { id: v.id, name: v.name, query: v.query, layout: v.layout, columnsBy: v.columnsBy, swimlanesBy: v.swimlanesBy, sort: v.sort, display: v.display }; }

/** A read-only, select-on-focus text field. @param {string} label @param {string} value */
function keyField(label, value) {
  const input = /** @type {HTMLInputElement} */ (h("input", { type: "text", readonly: true, value, "aria-label": label, class: "key-field" }));
  input.addEventListener("focus", () => input.select());
  return h("label", { class: "field" }, h("span", null, label), input);
}

/** @returns {ViewCfg} */
export function defaultView() {
  return { id: null, name: "All items", query: "", layout: "board", columnsBy: "state", swimlanesBy: null, sort: [],
    display: { density: "comfortable", properties: [...PROPS], showSubIssues: true, showArchived: false, hideEmptyLanes: false, hideEmptyColumns: null, listColumns: [...LIST_DEFAULT] } };
}

/** Built-in views: always there, not stored. */
const BUILTIN = [
  { id: "builtin:all", name: "All items", query: "" },
  { id: "builtin:mine", name: "My issues", query: "assignee:me", swimlanesBy: null },
  { id: "builtin:cycle", name: "Current cycle", query: "cycle:current", swimlanesBy: "assignee" },
  { id: "builtin:triage", name: "Triage", query: "kind:triage,backlog", layout: "list" },
];

/** @param {ViewCfg} v */
const viewSig = (v) => JSON.stringify([v.query, v.layout, v.columnsBy, v.swimlanesBy, v.sort, v.display]);

/**
 * @param {{
 *   gadget: any, root: HTMLElement, viewer?: { id: string, displayName?: string, role?: string } | null,
 *   timers?: { visibleMs?: number, hiddenMs?: number, outcomeMs?: number, historyMs?: number },
 *   doc?: Document, randomUUID?: () => string, now?: () => number, persist?: any,
 * }} appOptions
 */
export function createBoardApp(appOptions) {
  const doc = appOptions.doc ?? document;
  const win = doc.defaultView ?? window;
  const now = appOptions.now ?? (() => Date.now());
  const mac = /Mac|iPhone|iPad/.test(win.navigator?.platform ?? "");
  const store = createStore({ gadget: appOptions.gadget, viewer: appOptions.viewer ?? null, timers: appOptions.timers, doc, randomUUID: appOptions.randomUUID, now, persist: appOptions.persist });

  const style = doc.createElement("style");
  style.textContent = CSS;
  doc.head.append(style);

  // ---------------------------------------------------------------------------------------------
  // Shell

  const app = h("div", { class: "wb-app" });
  setChildren(appOptions.root, app);
  const live = createLive(app);
  const layers = createLayers(app);
  const toasts = createToasts();
  const skip = h("a", { href: "#wb-main", class: "skip-link", onclick: (/** @type {Event} */ e) => { e.preventDefault(); focusLayout(); } }, "Skip to the board");
  const topbar = h("header", { class: "topbar" });
  const banners = h("div", { class: "banners" });
  const toolbar = h("div", { class: "toolbar", role: "search", "aria-label": "Filter and view" });
  const layoutHost = h("div", { class: "layout-host" });
  const statePanel = h("div", { class: "state-host" });
  const bulkBar = h("div", { class: "bulk-bar", role: "toolbar", "aria-label": "Selected items", hidden: true });
  // Narrow screens show one column at a time with this switcher (swipe or tap to change).
  const narrowBar = h("div", { class: "narrow-bar", role: "group", "aria-label": "Column", hidden: true });
  const main = h("main", { id: "wb-main", class: "main", tabindex: "-1", "aria-label": "Work items" }, statePanel, narrowBar, layoutHost);
  const status = createStatusCentre({ controller: {
    changes: () => store.changes, now,
    retry: (c) => { const r = store.retry(c); if (!r.ok) toast(r.error ?? "Could not retry."); else live.announce(`Sent again: ${c.label}.`); },
    dismiss: (c) => store.dismiss(c),
    undo: (c) => undo(c),
    open: (c) => { const id = c.resultId ?? c.itemId; const item = id ? store.index().items.get(id) : null; if (item) openDetail(item, { focus: true }); },
  } });

  // ---------------------------------------------------------------------------------------------
  // UI state

  let view = defaultView();
  /** @type {ViewCfg} */ let savedView = defaultView();
  /** @type {Set<string>} */ let selection = new Set();
  /** @type {string|null} */ let anchorId = null;
  /** @type {string|null} */ let hoverId = null;
  /** @type {import("./board.js").FocusPos|null} */ let boardFocus = null;
  /** @type {{ row: string, col: number }|null} */ let listFocus = null;
  /** @type {Set<string>} */ const justSettled = new Set();
  /** @type {Set<string>} */ const collapsedCols = new Set();
  /** @type {Map<number, string>} */ const lastStatus = new Map();
  let initialViewApplied = false;
  let peeking = false;

  const filter = createFilterBar({ doc, controller: {
    ctx: () => ctx(), planning: () => store.planning,
    apply: (query) => { view = { ...view, query }; schedule(); live.announce(`${computeItems().items.length} items`); },
    announce: (t) => live.announce(t),
    addFilter: (anchor) => addFilter(anchor),
    editChip: (chip, anchor) => editChip(chip, anchor),
  } });

  /** @type {Map<string, any>} */
  const layouts = new Map();
  function layout(id = view.layout) {
    let inst = layouts.get(id);
    if (!inst) {
      const def = layoutDef(id) ?? layoutDef("board");
      inst = /** @type {any} */ (def).create({ doc, onAction: (/** @type {string} */ type, /** @type {any} */ payload) => onLayoutAction(id, type, payload) });
      layouts.set(id, inst);
    }
    return inst;
  }

  const pickers = createPickers({
    layers, index: () => store.index(), today: () => today(), me: store.me,
    apply: (items, patchFor, label) => applyPatch(items, patchFor, label),
    move: (item, target) => moveVia(item, target),
    view: () => ({ columnsBy: view.columnsBy, swimlanesBy: view.swimlanesBy, manualOrder: manualOrder() }),
    laneOf: (item) => laneOf(item),
    ctx: () => ({ index: store.index(), today: today(), viewer: store.me }),
  });

  const detail = createDetail({ doc, controller: {
    index: () => store.index(), today: () => today(), now, canWrite: () => store.canWrite(), me: store.me,
    history: (id) => store.replica.history.get(id) ?? [],
    historyComplete: () => store.replica.backfill.done,
    pendingFor: (id) => store.pendingFor(id),
    changesFor: (id) => store.changes.filter((c) => c.itemId === id),
    pick: (prop, items, anchor) => pickers.pick(prop, items, anchor),
    update: (item, patch, label) => report(store.updateItem(item, patch, { label }), label, item),
    createSub: (parent, title) => {
      /** @type {Record<string, unknown>} */
      const fields = { title, parent: parent.id, state: defaultCreateState() };
      if (parent.project) fields.project = parent.project;
      if (parent.cycle) fields.cycle = parent.cycle;
      const r = store.createItem(fields, { label: `Create sub-issue “${title.trim()}” of ${parent.key}` });
      return r.ok ? { ok: true } : r;
    },
    relate: (item, anchor) => relate(item, anchor),
    unrelate: (rel, item) => {
      const other = store.index().items.get(rel.from === item.id ? rel.to : rel.from);
      const r = store.entity("work.relation.update", { id: rel.id, active: false }, { label: `Remove relation between ${item.key} and ${other?.key ?? "item"}`, revision: rel.revision, itemId: rel.id });
      report(r, "Remove relation", null);
    },
    comment: (item, body) => {
      const r = store.entity("work.comment.create", { item: item.id, body }, { label: `Comment on ${item.key}` });
      return r.ok ? { ok: true } : r;
    },
    editComment: (cm, body) => {
      const r = store.entity("work.comment.update", { id: cm.id, body }, { label: "Edit comment", revision: cm.revision, itemId: cm.id });
      return r.ok ? { ok: true } : r;
    },
    open: (item) => openDetail(item, { focus: true }),
    showKey: (item, anchor) => showKey(item, anchor),
    close: () => closeDetail(),
    retry: (c) => { const r = store.retry(c); if (!r.ok) toast(r.error ?? "Could not retry."); },
    announce: (t) => live.announce(t),
    canSuggest: () => store.jev && store.canWrite() && store.planning,
    suggest: (item) => suggestWithJev([item]),
  } });

  const tray = createProposalsTray({ layers, controller: {
    proposals: () => store.proposals, recent: () => store.recentProposals, now, canWrite: () => store.canWrite(), signedIn: () => Boolean(store.viewer?.id),
    state: (p, ch) => changeState(store, ch, liveChange(p.id, ch.n)),
    apply: (p, ns) => applyFromTray(p, ns),
    refresh: async (p) => { await store.refreshProposal(p.id); },
    withdraw: async (p) => { await store.withdrawProposal(p.id); },
    history: () => store.call("listProposals", { status: "all" }),
    openItem: (key) => { const it = itemByKey(store.index(), key); if (it) { tray.close(); openDetail(it, { focus: true }); } },
    announce: (t, o) => live.announce(t, o),
  } });

  const body = h("div", { class: "body" }, main, detail.el);
  app.append(skip, topbar, banners, toolbar, body, bulkBar, status.el, toasts.el);
  toolbar.append(filter.el, h("div", { class: "view-controls" }));

  // ---------------------------------------------------------------------------------------------
  // Derived data

  const today = () => localDay(new Date(now()));
  const ctx = () => ({ index: store.index(), viewer: store.me, now: now(), today: today() });

  /** @type {{ key: string, items: ItemView[], total: number }|null} */
  let itemsCache = null;
  function effectiveSort() {
    const { ast } = parse(filter.applied || view.query);
    if (ast.sort.length) return ast.sort;
    if (view.sort.length) return view.sort;
    return view.layout === "board" ? BOARD_SORT : DEFAULT_SORT;
  }
  function manualOrder() { const s = effectiveSort(); return view.layout === "board" && s[0]?.field === "rank"; }
  function computeItems() {
    const index = store.index();
    const c = ctx();
    const sort = effectiveSort();
    const key = `${store.replica.version}|${index.keyPrefix}|${view.query}|${JSON.stringify(sort)}|${view.display.showArchived}|${c.today}|${Math.floor(c.now / 60_000)}`;
    if (itemsCache?.key === key) return itemsCache;
    const { ast } = parse(view.query);
    const pred = compile(ast, c);
    const archived = view.display.showArchived || mentionsArchived(ast.where);
    const items = index.itemList.filter((i) => (archived || !i.archived) && pred(i)).toSorted(compare(sort, c));
    itemsCache = { key, items, total: index.itemList.filter((i) => archived || !i.archived).length };
    return itemsCache;
  }
  /** @type {{ key: string, projection: import("../board/projection.js").Projection }|null} */
  let projCache = null;
  function computeProjection() {
    const { items, key } = computeItems();
    const c = ctx();
    const chSig = store.changes.map((x) => `${x.id}:${x.status}:${x.settledAt ? 1 : 0}`).join(",");
    const hideEmptyColumns = view.display.hideEmptyColumns ?? Boolean(view.query.trim());
    const pkey = `${key}|${chSig}|${view.columnsBy}|${view.swimlanesBy}|${view.display.hideEmptyLanes}|${hideEmptyColumns}|${view.display.showSubIssues}`;
    if (projCache?.key === pkey) return projCache.projection;
    const { ast } = parse(view.query);
    const pred = compile(ast, c);
    const projection = project({
      index: c.index, items, columnsBy: view.columnsBy, swimlanesBy: view.swimlanesBy, ctx: { index: c.index, today: c.today, viewer: c.viewer },
      changes: store.changes, matches: pred, compare: compare(effectiveSort(), c),
      hideEmptyLanes: view.display.hideEmptyLanes, hideEmptyColumns, showSubIssues: view.display.showSubIssues,
    });
    projCache = { key: pkey, projection };
    return projection;
  }
  /** @param {ItemView} item */
  function laneOf(item) {
    if (!view.swimlanesBy) return null;
    const p = property(view.swimlanesBy);
    if (boardFocus && boardFocus.key.startsWith(item.id)) return boardFocus.lane;
    return p ? p.keysOf(item, { index: store.index(), today: today(), viewer: store.me })[0] : null;
  }

  // ---------------------------------------------------------------------------------------------
  // Rendering

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; render(new Set(["data", "changes"])); });
  }

  store.subscribe((topics) => render(topics));

  /** @param {Set<string>} topics */
  function render(topics) {
    renderTopbar();
    renderBanners();
    if (store.phase !== "ready") {
      statePanel.hidden = false;
      layoutHost.hidden = true;
      renderStatePanel();
      toolbar.hidden = store.phase !== "loading";
      status.render();
      return;
    }
    const first = !initialViewApplied;
    if (first) applyInitialView();
    statePanel.hidden = true;
    layoutHost.hidden = false;
    toolbar.hidden = false;
    if (topics.has("changes")) { announceChangeTransitions(); trackProposalOutcomes(); }
    if (tray.open && (topics.has("proposals") || topics.has("changes") || topics.has("data"))) tray.render();
    renderViewControls();
    renderLayout();
    renderBulkBar();
    if (first) { try { performance.mark("wb:first-render"); performance.measure("wb:snapshot-to-render", "wb:snapshot", "wb:first-render"); } catch { /* no performance API */ } }
    if (detail.itemId && (topics.has("data") || topics.has("changes") || topics.has("history"))) {
      if (!store.index().items.has(detail.itemId)) closeDetail();
      else detail.render();
    }
    status.render();
    refreshUndoToasts();
  }

  function renderTopbar() {
    const index = store.phase === "ready" ? store.index() : null;
    const label = store.connection?.label ?? "Work board";
    const sync = store.sync;
    const liveState = store.phase !== "ready" ? "" : sync.offline ? "offline" : sync.error ? "retrying" : "live";
    const liveText = liveState === "offline" ? "Offline" : liveState === "retrying" ? "Reconnecting…" : liveState === "live" ? `Up to date` : "";
    setChildren(topbar, 
      h("div", { class: "brand" },
        h("span", { class: "brand-mark", "aria-hidden": "true" }, icon("board")),
        h("div", { class: "brand-text" }, h("h1", null, label), h("span", { class: "sub" }, index ? `Work board · ${index.itemList.filter((i) => !i.archived).length.toLocaleString()} items${store.canWrite() ? "" : " · read only"}` : "Work board"))),
      h("span", { class: "grow" }),
      liveState ? h("span", { class: `live ${liveState}`, title: sync.lastSync ? `Last checked ${relativeTime(sync.lastSync, now())}` : "" }, h("span", { class: "dot", "aria-hidden": "true" }), liveText) : null,
      store.phase === "ready" ? h("button", { type: "button", class: "btn palette-btn", "aria-label": "Search or run a command", onclick: () => runAction("palette"), "aria-keyshortcuts": mac ? "Meta+K" : "Control+K" },
        icon("search", { size: 14 }), h("span", { class: "palette-label" }, "Search or run a command"), h("kbd", { "aria-hidden": "true" }, keyLabel("Mod+k", mac))) : null,
      store.phase === "ready" ? proposalsButton() : null,
      store.phase === "ready" ? h("button", { type: "button", class: "icon-btn", "aria-label": "Keyboard shortcuts", title: "Keyboard shortcuts (?)", onclick: () => runAction("help") }, icon("keyboard")) : null,
      store.phase === "ready" ? h("button", { type: "button", class: "icon-btn", "aria-label": "Board settings", title: "Board settings", onclick: () => runAction("settings") }, icon("settings")) : null,
      store.phase === "ready" && store.canWrite() ? h("button", { type: "button", class: "btn primary new-btn", onclick: () => runAction("create"), title: "New item (C)", "aria-keyshortcuts": "C" }, icon("plus", { size: 14 }), h("span", null, "New item")) : null,
    );
  }

  function proposalsButton() {
    const n = store.proposals.length;
    const changes = store.proposals.reduce((sum, p) => sum + p.changes.filter((/** @type {any} */ ch) => !ch.outcome && !ch.noop).length, 0);
    return h("button", { type: "button", class: `btn proposals-btn${n ? " has" : ""}`, "aria-haspopup": "dialog", title: "Proposals from the agent and Jev (G then P)",
      "aria-label": n ? `Proposals: ${n} waiting, ${changes} ${changes === 1 ? "change" : "changes"}` : "Proposals: none waiting", onclick: () => runAction("proposals") },
      icon("inbox", { size: 14 }), h("span", { class: "proposals-label" }, "Proposals"), n ? h("span", { class: "badge", "aria-hidden": "true" }, String(n)) : null);
  }

  function renderBanners() {
    const out = [];
    const sync = store.sync;
    if (store.phase === "ready" && sync.offline) {
      const secs = sync.retryAt ? Math.max(1, Math.round((sync.retryAt - now()) / 1000)) : 0;
      out.push(h("div", { class: "banner warn", role: "status" }, icon("offline"), h("span", null, `Can't reach the Records service. You're seeing what was last loaded${secs ? `; retrying in ${secs} s` : ""}. ${sync.error}`),
        h("button", { type: "button", class: "btn sm", onclick: () => { void store.refresh(); } }, "Retry now")));
    }
    if (store.phase === "ready" && !store.planning) {
      out.push(h("div", { class: "banner info" }, h("span", null, "This datastore has the basic work model: Open, Active and Done. Priorities, assignees, labels, cycles and more appear after the Records planning upgrade.")));
    }
    if (store.phase === "ready" && store.connection?.access === "write" && !store.viewer?.id) {
      out.push(h("div", { class: "banner info" }, "Sign in to the Workshop to change items; you can browse everything."));
    }
    setChildren(banners, ...out);
  }

  function renderStatePanel() {
    const phase = store.phase;
    if (phase === "loading") {
      setChildren(statePanel, h("div", { class: "skeleton", role: "status", "aria-label": "Loading the board" },
        ...[5, 3, 4, 2].map((n) => h("div", { class: "sk-col", "aria-hidden": "true" }, h("div", { class: "sk-head" }), ...Array.from({ length: n }, () => h("div", { class: "sk-card" }))))));
      return;
    }
    const panel = h("div", { class: "state-panel", role: phase === "error" ? "alert" : null });
    if (phase === "not_connected") panel.append(h("h2", null, "Connect a work datastore"), h("ol", null,
      h("li", null, "Open this gadget's Connections tab."),
      h("li", null, `Add a Records datastore with the work module, named ${BINDING_NAME}.`),
      h("li", null, "Choose “Read and request changes” to edit items, or “Read only” to browse.")));
    else if (phase === "wrong_module") panel.append(h("h2", null, "This board needs a work v1 datastore"),
      h("p", null, `The connected datastore uses ${store.description?.module_id ?? "another module"} v${store.description?.api_major ?? "?"}. Connect a work datastore instead.`));
    else if (phase === "forbidden") panel.append(h("h2", null, "You don't have access to this datastore"), h("p", null, store.phaseMessage || "The Records service refused this connection."));
    else if (phase === "too_large") panel.append(h("h2", null, "This datastore is too large for a board"),
      h("p", null, "The board loads a complete snapshot of at most 5,000 records, and this datastore has more. Use a Records Explorer or the Records API instead."));
    else panel.append(h("h2", null, "The board could not load"), h("p", null, store.phaseMessage || "The Records service could not be reached."),
      h("button", { type: "button", class: "btn primary", onclick: () => { void store.refresh(); } }, "Try again"));
    setChildren(statePanel, panel);
  }

  function renderViewControls() {
    const host = /** @type {HTMLElement} */ (toolbar.querySelector(".view-controls"));
    const dirty = viewSig(view) !== viewSig(savedView);
    const layoutsList = LAYOUT_IDS;
    const triageView = /\bkind:(?:triage|[a-z,]*triage)/.test(view.query) || view.id === "builtin:triage";
    setChildren(host, 
      h("button", { type: "button", class: "icon-btn narrow-only filter-toggle", "aria-label": "Filter", "aria-expanded": String(app.classList.contains("filter-open")), title: "Filter (/)", onclick: () => { const open = app.classList.toggle("filter-open"); renderViewControls(); if (open) filter.focus(); } }, icon("filter")),
      h("button", { type: "button", class: `btn view-switch${dirty ? " dirty" : ""}`, "aria-haspopup": "dialog", onclick: (/** @type {Event} */ e) => viewsMenu(/** @type {HTMLElement} */ (e.currentTarget)) },
        icon("eye", { size: 14 }), h("span", { class: "view-name" }, view.name), dirty ? h("span", { class: "dirty-dot", title: "Unsaved changes" }, h("span", { class: "sr-only" }, ", unsaved changes")) : null, icon("chevronDown", { size: 12 })),
      h("div", { class: "segmented", role: "group", "aria-label": "Layout" }, layoutsList.map((id) => h("button", {
        type: "button", class: "seg", "aria-pressed": String(view.layout === id), "aria-label": /** @type {any} */ (LAYOUT_LABELS)[id], title: id === "insights" ? "Insights: reports and charts (G then I)" : `${/** @type {any} */ (LAYOUT_LABELS)[id]} (${keyLabel("Mod+b", mac)} switches board and list)`, onclick: () => setLayout(id),
      }, icon(id === "board" ? "board" : id === "list" ? "list" : "chart", { size: 14 }), h("span", { class: "seg-label" }, /** @type {any} */ (LAYOUT_LABELS)[id])))),
      view.layout !== "insights" ? h("button", { type: "button", class: "btn", "aria-haspopup": "dialog", onclick: (/** @type {Event} */ e) => displayMenu(/** @type {HTMLElement} */ (e.currentTarget)) }, icon("lanes", { size: 14 }), "Display") : null,
      triageView && store.jev && store.canWrite() && store.planning && view.layout !== "insights" ? h("button", { type: "button", class: "btn", "aria-haspopup": "dialog", title: "Ask Jev to suggest priority, state, labels and duplicates for the items in triage", onclick: () => runAction("triageJev") }, icon("sparkle", { size: 14 }), "Triage with Jev") : null,
      dirty && view.id && store.canWrite() ? h("button", { type: "button", class: "btn", onclick: () => runAction("saveView") }, icon("save", { size: 14 }), "Save view") : null,
      dirty ? h("button", { type: "button", class: "btn ghost", onclick: () => runAction("resetView") }, "Reset") : null,
    );
  }

  function renderLayout() {
    const id = view.layout === "list" ? "list" : view.layout === "insights" ? "insights" : "board";
    const inst = layout(id);
    if (id === "insights") {
      if (layoutHost.firstElementChild !== inst.el) setChildren(layoutHost, inst.el);
      const { items, total } = computeItems();
      filter.setCount({ shown: items.length, total });
      narrowBar.hidden = true;
      layoutHost.dataset.empty = "";
      layoutHost.querySelector(":scope > .empty-overlay")?.remove();
      ensureInsights();
      inst.update(insightsModel());
      return;
    }
    if (layoutHost.firstElementChild !== inst.el) setChildren(layoutHost, inst.el);
    const hadFocus = layoutHost.contains(doc.activeElement);
    const { items, total } = computeItems();
    filter.setCount({ shown: items.length, total });
    const index = store.index();
    const empty = !index.itemList.length ? (store.canWrite() ? "Nothing here yet. Press C to create the first item." : "Nothing here yet.")
      : "No items";
    layoutHost.dataset.empty = items.length ? "" : index.itemList.length ? "filtered" : "none";
    narrowBar.hidden = true;
    if (id === "board") {
      const full = computeProjection();
      fixBoardFocus(full);
      const projection = narrowed(full);
      const flipBefore = captureRects();
      inst.update({
        projection, focus: boardFocus, collapsedCols, collapsedLanes: new Set(store.prefs.collapsedLanes ?? []),
        canWrite: store.canWrite(), manualOrder: manualOrder(), today: today(), emptyText: empty,
        label: `Board: ${items.length} ${items.length === 1 ? "item" : "items"} in ${projection.columns.length} columns${projection.swimlanesBy ? ` and ${projection.lanes.length} lanes by ${property(projection.swimlanesBy)?.label.toLowerCase()}` : ""}`,
        env: { index, today: today(), density: view.display.density, props: new Set(view.display.properties), columnsBy: view.columnsBy, selected: selection, canWrite: store.canWrite(), lanesBy: view.swimlanesBy },
      });
      playFlip(flipBefore);
      markSettled();
    } else {
      fixListFocus();
      inst.update({
        items, index, today: today(), now: now(), groupBy: view.columnsBy === "state" || property(view.columnsBy)?.column ? view.columnsBy : null,
        columns: view.display.listColumns.length ? view.display.listColumns : LIST_DEFAULT, sort: effectiveSort(),
        collapsed: new Set(store.prefs.collapsedLanes ?? []), focus: listFocus, selected: selection,
        pendingFor: (/** @type {string} */ i) => store.pendingFor(i), label: `List: ${items.length} items`,
        ctx: { index, today: today(), viewer: store.me }, canWrite: store.canWrite(),
      });
    }
    renderEmptyOverlay(items.length, index.itemList.length);
    if (hadFocus && (!layoutHost.contains(doc.activeElement) || doc.activeElement === doc.body)) inst.focusCurrent({ scroll: false });
  }

  /** Narrow screens (and 400 % zoom) show one column at a time. */
  function isNarrow() { return (win.innerWidth || 1024) < 640; }
  /** @type {string|null} */
  let narrowCol = null;
  /** @param {import("../board/projection.js").Projection} full */
  function narrowed(full) {
    if (!isNarrow() || !full.columns.length) return full;
    const keys = full.columns.map((c) => c.group.key);
    if (!narrowCol || !keys.includes(narrowCol)) {
      narrowCol = boardFocus && keys.includes(boardFocus.col) ? boardFocus.col : (full.columns.find((c) => c.count > 0) ?? full.columns[0]).group.key;
    }
    if (boardFocus && boardFocus.col !== narrowCol) {
      const lane = full.lanes.find((l) => l.cells.get(/** @type {string} */ (narrowCol))?.some((e) => e.kind === "card")) ?? full.lanes[0];
      const first = lane?.cells.get(/** @type {string} */ (narrowCol))?.find((e) => e.kind === "card");
      boardFocus = lane ? { key: first ? first.key : `empty:${lane.key}::${narrowCol}`, lane: lane.key, col: /** @type {string} */ (narrowCol) } : boardFocus;
    }
    renderNarrowBar(full);
    return { ...full, columns: full.columns.filter((c) => c.group.key === narrowCol) };
  }
  /** @param {import("../board/projection.js").Projection} full */
  function renderNarrowBar(full) {
    narrowBar.hidden = false;
    const was = narrowBar.dataset.active;
    // Keyed: tabs keep their identity (and focus) across renders.
    reconcile(narrowBar, full.columns, {
      key: (c) => c.group.key,
      create: (c) => h("button", { type: "button", class: "narrow-tab", "data-col": c.group.key, onclick: () => showColumn(c.group.key) }),
      update: (node, c) => {
        node.setAttribute("aria-pressed", String(c.group.key === narrowCol));
        const sig = `${c.group.label}|${c.count}|${c.group.color ?? ""}`;
        const el = /** @type {HTMLElement} */ (node);
        if (el.dataset.sig === sig) return;
        el.dataset.sig = sig;
        setChildren(el, c.group.stateKind ? stateIcon(c.group.stateKind, c.group.color ?? "#888") : null, h("span", null, c.group.label), h("span", { class: "narrow-count" }, String(c.count)));
      },
    });
    if (was !== narrowCol) {
      narrowBar.dataset.active = narrowCol ?? "";
      /** @type {HTMLElement|null} */ (narrowBar.querySelector('[aria-pressed="true"]'))?.scrollIntoView?.({ inline: "center", block: "nearest" });
    }
  }
  /** @param {string} col @param {{ focus?: boolean }} [opts] */
  function showColumn(col, opts = {}) {
    narrowCol = col;
    const p = computeProjection();
    const c = p.columns.find((x) => x.group.key === col);
    boardFocus = null;
    render(new Set());
    live.announce(`${c?.group.label ?? col}: ${c?.count ?? 0} ${c?.count === 1 ? "item" : "items"}.`);
    if (opts.focus) layout("board").focusCurrent();
  }
  /** @param {number} delta */
  function stepColumn(delta) {
    const cols = computeProjection().columns.map((c) => c.group.key);
    const i = cols.indexOf(narrowCol ?? "");
    const next = cols[Math.max(0, Math.min(cols.length - 1, i + delta))];
    if (next && next !== narrowCol) { showColumn(next, { focus: true }); return true; }
    return false;
  }
  // Swipe between columns on touch screens.
  /** @type {{ x: number, y: number }|null} */
  let swipe = null;
  layoutHost.addEventListener("pointerdown", (e) => { swipe = isNarrow() && view.layout === "board" && e.pointerType === "touch" ? { x: e.clientX, y: e.clientY } : null; });
  layoutHost.addEventListener("pointerup", (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 60 && Math.abs(dy) < 40) stepColumn(dx < 0 ? 1 : -1);
  });

  /** "Share": the key and title as selectable text (the sandbox has no clipboard API). @param {ItemView} item @param {HTMLElement|{ x: number, y: number }} anchor */
  function showKey(item, anchor) {
    layers.openPopover({ anchor, label: `Share ${item.key}`, className: "showkey", content: (close) => {
      return h("div", { class: "showkey-inner" },
        h("h2", { class: "pop-title" }, `Share ${item.key}`),
        keyField("Key", item.key), keyField("Key and title", `${item.key} ${item.title}`),
        h("p", { class: "hint" }, "Select and copy (Ctrl/⌘+C). Anyone on this board opens it with Ctrl/⌘+K and the key."),
        h("div", { class: "row end" }, h("button", { type: "button", class: "btn", onclick: () => close("done") }, "Done")));
    }, initialFocus: () => /** @type {HTMLElement|null} */ (layers.top?.querySelector(".key-field") ?? null) });
  }

  /** @param {number} shown @param {number} all */
  function renderEmptyOverlay(shown, all) {
    let overlay = /** @type {HTMLElement|null} */ (layoutHost.querySelector(":scope > .empty-overlay"));
    if (shown || !all) { overlay?.remove(); return; }
    if (!overlay) { overlay = h("div", { class: "empty-overlay", role: "status" }); layoutHost.append(overlay); }
    setChildren(overlay, h("p", null, h("strong", null, "No items match this filter."), " "),
      h("button", { type: "button", class: "btn sm", onclick: () => { filter.setQuery("", true); } }, "Clear the filter"));
  }

  // FLIP: cards that moved glide to their new place (skipped with reduced motion).
  function reducedMotion() { return win.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false; }
  function captureRects() {
    if (reducedMotion() || view.layout !== "board") return null;
    const cards = /** @type {HTMLElement[]} */ ([...layoutHost.querySelectorAll("article.card[data-key]")]);
    if (cards.length > 160) return null;
    return new Map(cards.map((c) => [/** @type {string} */ (c.dataset.key), c.getBoundingClientRect()]));
  }
  /** @param {Map<string, DOMRect>|null} before */
  function playFlip(before) {
    if (!before) return;
    for (const c of /** @type {NodeListOf<HTMLElement>} */ (layoutHost.querySelectorAll("article.card[data-key]"))) {
      const prev = before.get(/** @type {string} */ (c.dataset.key));
      if (!prev) continue;
      const next = c.getBoundingClientRect();
      const dx = prev.left - next.left, dy = prev.top - next.top;
      if (Math.abs(dx) + Math.abs(dy) < 2 || !c.animate) continue;
      c.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 260, easing: "cubic-bezier(.2,.9,.3,1.15)" });
    }
  }
  function markSettled() {
    for (const id of justSettled) {
      for (const c of layoutHost.querySelectorAll(`article.card[data-id="${id}"]`)) {
        c.classList.remove("just-settled");
        void (/** @type {HTMLElement} */ (c)).offsetWidth;
        c.classList.add("just-settled");
        if (store.index().items.get(id)?.category === "done") c.classList.add("just-done");
      }
    }
    justSettled.clear();
  }

  /** Keeps the roving focus on the same item after data changes (it may have moved cells). @param {import("../board/projection.js").Projection} projection */
  function fixBoardFocus(projection) {
    if (!boardFocus) {
      for (const lane of projection.lanes) {
        for (const c of projection.columns) {
          const first = lane.cells.get(c.group.key)?.find((e) => e.kind === "card");
          if (first) { boardFocus = { key: first.key, lane: lane.key, col: c.group.key }; return; }
        }
      }
      const lane = projection.lanes[0], col = projection.columns[0]?.group.key;
      if (lane && col !== undefined) boardFocus = { key: `empty:${lane.key}::${col}`, lane: lane.key, col };
      return;
    }
    const f = boardFocus;
    if (f.key.startsWith("empty:")) {
      const lane = projection.lanes.find((l) => l.key === f.lane);
      const first = lane?.cells.get(f.col)?.find((e) => e.kind === "card");
      if (lane && first) boardFocus = { key: first.key, lane: f.lane, col: f.col };
      return;
    }
    for (const lane of projection.lanes) for (const [col, cell] of lane.cells) {
      if (cell.some((e) => e.kind === "card" && e.key === f.key)) { boardFocus = { key: f.key, lane: lane.key, col }; return; }
    }
    // The item left the board (filtered out, archived): stay in the same cell.
    const lane = projection.lanes.find((l) => l.key === f.lane) ?? projection.lanes[0];
    const cell = lane?.cells.get(f.col) ?? [];
    const first = cell.find((e) => e.kind === "card");
    boardFocus = lane ? { key: first ? first.key : `empty:${lane.key}::${f.col}`, lane: lane.key, col: f.col } : null;
  }
  function fixListFocus() {
    const { items } = computeItems();
    if (!listFocus) { if (items[0]) listFocus = { row: items[0].id, col: 1 }; return; }
    const id = listFocus.row.split("@")[0];
    if (!listFocus.row.startsWith("g:") && !items.some((i) => i.id === id)) listFocus = items[0] ? { row: items[0].id, col: listFocus.col } : null;
  }

  function renderBulkBar() {
    const index = store.index();
    const items = [...selection].map((id) => index.items.get(id)).filter(/** @returns {x is ItemView} */ (x) => Boolean(x));
    if (items.length !== selection.size) selection = new Set(items.map((i) => i.id));
    bulkBar.hidden = !items.length || !store.canWrite();
    if (bulkBar.hidden) { app.classList.remove("has-bulk"); return; }
    app.classList.add("has-bulk");
    const btn = (/** @type {string} */ prop, /** @type {string} */ label, /** @type {string} */ key) => h("button", { type: "button", class: "btn sm", "aria-haspopup": "dialog", title: `${label} (${key.toUpperCase()})`, onclick: (/** @type {Event} */ e) => pickers.pick(prop, items, /** @type {HTMLElement} */ (e.currentTarget)) }, label);
    setChildren(bulkBar, 
      h("span", { class: "bulk-count", role: "status" }, `${items.length} selected`),
      btn("state", "State", "s"), ...(index.planning ? [btn("assignee", "Assign", "a"), btn("priority", "Priority", "p"), btn("labels", "Labels", "l"), btn("estimate", "Estimate", "e"), btn("due", "Due", "d"), btn("cycle", "Cycle", "")] : []),
      store.jev && index.planning ? h("button", { type: "button", class: "btn sm", "aria-haspopup": "dialog", title: "Ask Jev for triage suggestions for the selected items", onclick: () => runAction("triageJev") }, icon("sparkle", { size: 13 }), "Triage with Jev") : null,
      h("button", { type: "button", class: "btn ghost sm", onclick: () => clearSelection() }, "Clear", h("kbd", { "aria-hidden": "true" }, "Esc")));
  }

  // ---------------------------------------------------------------------------------------------
  // Announcements for change outcomes (4.1.3), undo toasts, settle animation

  /** @type {{ change: import("../store/store.js").Change, toast: ReturnType<typeof toasts.show> }[]} */
  const undoToasts = [];
  function announceChangeTransitions() {
    for (const c of store.changes) {
      const prev = lastStatus.get(c.id);
      if (prev === c.status && !(c.status === "applied" && c.settledAt && prev === "applied" && !lastStatus.has(-c.id))) continue;
      lastStatus.set(c.id, c.status);
      if (c.status === "pending" && prev !== "pending") live.announce(`Awaiting approval: ${c.label}.`);
      else if (c.status === "applied" && c.settledAt && !lastStatus.has(-c.id)) {
        lastStatus.set(-c.id, "settled");
        live.announce(`Saved: ${c.label}.`);
        const id = c.resultId ?? c.itemId;
        if (id) justSettled.add(id);
      } else if (c.status === "conflict" || c.status === "rejected") {
        if (prev !== c.status) live.announce(`Not saved: ${c.label}. ${c.message}`, { assertive: true });
      }
    }
  }
  function refreshUndoToasts() { for (const t of undoToasts) t.toast.refresh(); }

  /** @param {string} text @param {any} [opts] */
  function toast(text, opts) { return toasts.show(text, opts); }

  /**
   * Feedback for a write attempt.
   * @param {{ ok: true, change: import("../store/store.js").Change|null } | { ok: false, error: string }} r
   * @param {string} label @param {ItemView|null} item
   */
  function report(r, label, item) {
    if (!r.ok) { live.announce(`Not sent: ${r.error}`, { assertive: true }); toast(r.error, { tone: "bad" }); return r; }
    if (!r.change) { live.announce("Nothing to change."); return r; }
    const change = r.change;
    live.announce(`Sent: ${label}.`);
    if (item && change.undo) {
      const t = toast(label, { action: { label: "Undo", run: () => undo(change), disabled: () => change.status !== "applied" } });
      undoToasts.push({ change, toast: t });
      if (undoToasts.length > 5) undoToasts.shift();
    }
    return r;
  }

  /** @param {import("../store/store.js").Change} change */
  function undo(change) {
    if (change.status !== "applied") { live.announce("That change is still awaiting approval; you can undo it once it is saved."); return; }
    const r = store.undo(change);
    if (!r.ok) { toast(r.error ?? "Could not undo.", { tone: "bad" }); live.announce(r.error ?? "Could not undo."); return; }
    live.announce(`Undo sent: ${change.label}.`);
  }

  // ---------------------------------------------------------------------------------------------
  // Writes from the UI

  /** @param {ItemView[]} items @param {(item: ItemView) => Record<string, unknown>|null} patchFor @param {string} label */
  function applyPatch(items, patchFor, label) {
    if (!items.length) return;
    if (items.length === 1) {
      const patch = patchFor(items[0]);
      if (!patch) return;
      report(store.updateItem(items[0], patch, { label }), label, items[0]);
      return;
    }
    const { results } = store.bulkUpdate(items, patchFor, label);
    const sent = results.filter((r) => r.ok && r.change).length;
    const failed = results.filter((r) => !r.ok);
    const unchanged = results.filter((r) => r.ok && !r.change).length;
    const text = `${label}: ${sent} sent${unchanged ? `, ${unchanged} already set` : ""}${failed.length ? `, ${failed.length} not sent (${failed.slice(0, 3).map((f) => `${f.item.key}: ${f.error}`).join("; ")})` : ""}.`;
    live.announce(text, { assertive: failed.length > 0 });
    toast(text, { tone: failed.length ? "bad" : "" });
  }

  /** Moves from the board (drag, keyboard move mode) or the Move menu. */
  function onMove(/** @type {{ item: ItemView, fromLane: string, toLane: string, toCol: string, ordered: ItemView[], index: number, pointer?: boolean }} */ m) {
    const rank = manualOrder() ? rankAt(m.ordered, m.index) : null;
    const c = { index: store.index(), today: today(), viewer: store.me };
    const r = movePatch({ ctx: c, columnsBy: view.columnsBy, swimlanesBy: view.swimlanesBy }, m.item, { toCol: m.toCol, toLane: m.toLane, fromLane: m.fromLane, rank });
    if ("error" in r) { live.announce(r.error ?? "That move is not possible.", { assertive: true }); toast(r.error ?? "That move is not possible.", { tone: "bad" }); return; }
    if (!Object.keys(r.patch).length) { live.announce("Already there."); return; }
    const label = describeMove(m.item, r.patch, m.toCol, m.toLane);
    report(store.updateItem(m.item, r.patch, { label }), label, m.item);
    boardFocus = { key: m.item.id, lane: m.toLane, col: m.toCol };
  }

  /** @param {ItemView} item @param {{ col?: string, lane?: string, position?: "top"|"bottom" }} target */
  function moveVia(item, target) {
    const projection = computeProjection();
    const colProp = property(view.columnsBy);
    const c = { index: store.index(), today: today(), viewer: store.me };
    const fromCol = colProp?.keysOf(item, c)[0] ?? NONE;
    const fromLane = laneOf(item) ?? SINGLE_LANE;
    const toCol = target.col ?? fromCol;
    const toLane = target.lane ?? fromLane;
    const lane = projection.lanes.find((l) => l.key === toLane) ?? projection.lanes[0];
    const ordered = (lane?.cells.get(toCol) ?? []).filter((e) => e.kind === "card" && e.item.id !== item.id).map((e) => e.item);
    const index = target.position === "bottom" ? ordered.length : 0;
    onMove({ item, fromLane, toLane: lane?.key ?? SINGLE_LANE, toCol, ordered, index });
  }

  /** @param {ItemView} item @param {Record<string, unknown>} patch @param {string} toCol @param {string} toLane */
  function describeMove(item, patch, toCol, toLane) {
    const index = store.index();
    const parts = [];
    const colProp = property(view.columnsBy), laneProp = view.swimlanesBy ? property(view.swimlanesBy) : null;
    const groupLabel = (/** @type {any} */ p, /** @type {string} */ key) => p?.groups({ index, today: today(), viewer: store.me }, index.itemList).find((/** @type {any} */ g) => g.key === key)?.label ?? key;
    if (Object.keys(patch).some((k) => k !== "rank" && (colProp?.field === "state" ? k === "state" || k === "status" : true)) && colProp && colProp.keysOf(item, { index, today: today(), viewer: store.me })[0] !== toCol) parts.push(`to ${groupLabel(colProp, toCol)}`);
    if (laneProp && toLane !== SINGLE_LANE && laneOf(item) !== toLane) parts.push(`${laneProp.label.toLowerCase()} ${groupLabel(laneProp, toLane)}`);
    if (!parts.length && "rank" in patch) parts.push("to a new position");
    return `Move ${item.key} ${parts.join(", ")}`;
  }

  /** New items land at the top of their cell when the board is in manual order (as in Linear). @param {Record<string, unknown>} fields */
  function withTopRank(fields) {
    if (!store.planning || !manualOrder() || fields.rank) return fields;
    const index = store.index();
    const c = { index, today: today(), viewer: store.me };
    const ghost = projectItem(index, null, fields);
    const col = property(view.columnsBy)?.keysOf(ghost, c)[0] ?? NONE;
    const lane = view.swimlanesBy ? property(view.swimlanesBy)?.keysOf(ghost, c)[0] ?? NONE : SINGLE_LANE;
    const cell = computeProjection().lanes.find((l) => l.key === lane)?.cells.get(col) ?? [];
    return { ...fields, rank: rankAt(cell.filter((e) => e.kind === "card").map((e) => e.item), 0) };
  }

  function defaultCreateState() {
    const index = store.index();
    const s = index.states.find((x) => x.kind === "unstarted") ?? index.states.find((x) => x.category === "open") ?? index.states[0];
    return s?.key;
  }

  /** Smart defaults for a new item: the cell it was created in and unambiguous filter values. @param {{ col?: string, lane?: string }} [at] */
  function createDefaults(at = {}) {
    const index = store.index();
    const c = { index, today: today(), viewer: store.me };
    /** @type {Record<string, unknown>} */
    const fields = {};
    const describe = [];
    if (index.planning) {
      const { ast } = parse(view.query);
      const where = ast.where;
      const terms = !where ? [] : where.type === "and" ? where.children : [where];
      for (const t of terms) {
        if (t.type !== "term" || t.op !== "eq" || t.values.length !== 1) continue;
        const v = t.values[0];
        if (t.field === "assignee" && v.toLowerCase() === "me" && store.me) fields.assignee = store.me;
        else if (t.field === "priority") { const p = PRIORITIES.find((x) => x.key === v.toLowerCase() || String(x.value) === v); if (p) fields.priority = p.value; }
        else if (t.field === "label") { const l = index.labels.find((x) => x.key.toLowerCase() === v.toLowerCase() || x.name.toLowerCase() === v.toLowerCase()); fields.labels = [l?.key ?? v]; }
        else if (t.field === "project") { const p = index.projects.find((x) => x.name.toLowerCase() === v.toLowerCase()); if (p) fields.project = p.id; }
        else if (t.field === "cycle") {
          const cy = v.toLowerCase() === "current" ? index.cycles.find((x) => x.start && x.end && x.start <= c.today && c.today <= x.end) : index.cycles.find((x) => x.name.toLowerCase() === v.toLowerCase());
          if (cy) fields.cycle = cy.id;
        } else if (t.field === "state") { const s = index.states.find((x) => x.name.toLowerCase() === v.toLowerCase() || x.key === v); if (s) fields.state = s.key; }
      }
    }
    const colProp = property(view.columnsBy);
    if (at.col && colProp?.settable) { Object.assign(fields, colProp.patch(/** @type {any} */ ({ ...blankItem(), state: "", category: "" }), NONE, at.col, c) ?? {}); describe.push(colProp.groups(c, []).find((g) => g.key === at.col)?.label ?? ""); }
    const laneProp = view.swimlanesBy ? property(view.swimlanesBy) : null;
    if (at.lane && at.lane !== SINGLE_LANE && at.lane !== NONE && laneProp?.settable) {
      Object.assign(fields, laneProp.patch(/** @type {any} */ (blankItem()), NONE, at.lane, c) ?? {});
      describe.push(laneProp.groups(c, index.itemList).find((g) => g.key === at.lane)?.label ?? "");
    }
    if (!index.planning && fields.status === undefined && at.col) fields.status = at.col;
    if (index.planning && !fields.state && !fields.status) fields.state = defaultCreateState();
    return { fields, context: describe.filter(Boolean).join(" · ") };
  }

  // ---------------------------------------------------------------------------------------------
  // Layout actions

  /** @param {string} layoutId @param {string} type @param {any} payload */
  function onLayoutAction(layoutId, type, payload) {
    switch (type) {
      case "focus":
        boardFocus = { key: payload.key, lane: payload.lane, col: payload.col };
        render(new Set());
        if (!payload.silent) layout("board").focusCurrent();
        if (peeking && !payload.silent) { const e = layout("board").focusedEntry(); if (e) detail.show(e.entry.item.id); }
        break;
      case "focusRow":
        listFocus = { row: payload.row, col: payload.col };
        render(new Set());
        if (!payload.silent) layout("list").focusCurrent();
        if (peeking && !payload.silent) { const it = layout("list").focusedItem(); if (it) detail.show(it.id); }
        break;
      case "open": openDetail(payload.item, { focus: false }); break;
      case "select": select(payload.item, { toggle: payload.toggle, range: payload.range }); break;
      case "menu": pickers.pick("move", [payload.item], payload.anchor); break;
      case "move": onMove(payload); break;
      case "create": runAction("create", { col: payload.col, lane: payload.lane }); break;
      case "toggleColumn": if (collapsedCols.has(payload)) collapsedCols.delete(payload); else collapsedCols.add(payload); schedule(); break;
      case "toggleLane": case "toggleGroup": {
        const key = type === "toggleGroup" ? `list:${payload}` : payload;
        const set = new Set(store.prefs.collapsedLanes ?? []);
        if (set.has(key)) set.delete(key); else set.add(key);
        store.setPrefs({ collapsedLanes: [...set] });
        break;
      }
      case "sort": {
        const cur = effectiveSort()[0];
        const dir = cur?.field === payload && cur.dir === "asc" ? "desc" : "asc";
        const { ast } = parse(view.query);
        if (ast.sort.length) { const q = format({ ...ast, sort: [] }); view = { ...view, query: q }; filter.setQuery(q); }
        view = { ...view, sort: [{ field: payload, dir }] };
        live.announce(`Sorted by ${payload}, ${dir === "asc" ? "ascending" : "descending"}.`);
        schedule();
        break;
      }
      case "insights:menu": reportMenu(payload.report, payload.anchor); break;
      case "insights:open": { const it = itemByKey(store.index(), payload); if (it) openDetail(it, { focus: true }); else toast(`${payload} is not on the board.`); break; }
      case "insights:params": insightParams.set(payload.id, { ...insightParams.get(payload.id), ...payload.params }); live.announce("Updating the report."); schedule(); break;
      case "insights:new": editReport(null); break;
      case "insights:hidden": hiddenReports(payload); break;
      case "hover": hoverId = payload; break;
      case "announce": live.announce(payload); break;
      case "hint": live.announce(payload); toast(payload); break;
    }
    void layoutId;
  }

  /** @param {ItemView} item @param {{ toggle?: boolean, range?: boolean }} opts */
  function select(item, opts) {
    if (opts.range && anchorId) {
      const ids = visualOrder();
      const i = ids.indexOf(anchorId), j = ids.indexOf(item.id);
      if (i >= 0 && j >= 0) for (const id of ids.slice(Math.min(i, j), Math.max(i, j) + 1)) selection.add(id);
    } else if (selection.has(item.id)) selection.delete(item.id);
    else selection.add(item.id);
    anchorId = item.id;
    selection = new Set(selection);
    live.announce(`${selection.size} selected.`);
    schedule();
  }
  function clearSelection() { if (!selection.size) return false; selection = new Set(); live.announce("Selection cleared."); schedule(); return true; }
  function visualOrder() {
    if (view.layout === "list") return computeItems().items.map((i) => i.id);
    const p = computeProjection();
    const out = [];
    for (const lane of p.lanes) for (const c of p.columns) for (const e of lane.cells.get(c.group.key) ?? []) if (e.kind === "card") out.push(e.item.id);
    return [...new Set(out)];
  }

  /** The items a verb acts on: the selection, else the focused item, else the hovered one. */
  function targets() {
    const index = store.index();
    if (selection.size) return [...selection].map((id) => index.items.get(id)).filter(/** @returns {x is ItemView} */ (x) => Boolean(x));
    const f = focusedItem();
    if (f) return [f];
    if (detail.itemId && index.items.get(detail.itemId)) return [/** @type {ItemView} */ (index.items.get(detail.itemId))];
    const hv = hoverId ? index.items.get(hoverId) : null;
    return hv ? [hv] : [];
  }
  function focusedItem() {
    const active = doc.activeElement;
    if (view.layout === "insights") return null;
    if (view.layout === "list") return layoutHost.contains(active) ? layout("list").focusedItem() : null;
    return layoutHost.contains(active) ? layout("board").focusedEntry()?.entry.item ?? null : null;
  }
  /** Where to anchor a picker for the current targets. */
  function anchorFor() {
    const active = /** @type {HTMLElement|null} */ (doc.activeElement);
    if (active && active !== doc.body && app.contains(active)) return active;
    const r = layoutHost.getBoundingClientRect();
    return { x: r.left + 40, y: r.top + 40 };
  }

  /** @param {ItemView} item @param {{ focus: boolean }} opts */
  function openDetail(item, opts) {
    peeking = !opts.focus;
    detail.show(item.id, { focus: opts.focus });
    app.classList.add("has-detail");
    if (!opts.focus) { /* peek: keep focus where it is */ }
  }
  function closeDetail() {
    if (!detail.itemId) return false;
    const id = detail.itemId;
    detail.show(null);
    peeking = false;
    app.classList.remove("has-detail");
    // Return focus to the item on the board or list.
    if (view.layout === "board") { if (boardFocus?.key.startsWith(id) || !boardFocus) { const pos = findBoardPos(id); if (pos) boardFocus = pos; } render(new Set()); layout("board").focusCurrent(); }
    else { listFocus = { row: id, col: listFocus?.col ?? 1 }; render(new Set()); layout("list").focusCurrent(); }
    return true;
  }
  /** @param {string} id */
  function findBoardPos(id) {
    const p = computeProjection();
    for (const lane of p.lanes) for (const [col, cell] of lane.cells) for (const e of cell) if (e.kind === "card" && e.item.id === id) return { key: e.key, lane: lane.key, col };
    return null;
  }
  function focusLayout() {
    const inst = layout();
    if (!inst.focusCurrent()) { inst.navigate("down"); }
  }

  // ---------------------------------------------------------------------------------------------
  // Views, display, filters

  /** @param {string} id */
  function setLayout(id) {
    if (view.layout === id) return;
    const current = focusedItem() ?? (detail.itemId ? store.index().items.get(detail.itemId) : null);
    view = { ...view, layout: id };
    itemsCache = null;
    if (current) { if (id === "list") listFocus = { row: current.id, col: 1 }; else if (id === "board") boardFocus = findBoardPos(current.id) ?? boardFocus; }
    render(new Set(["data"]));
    live.announce(id === "insights" ? `Insights: ${(store.reports ?? []).filter((r) => !r.hidden).length || "loading"} reports${view.query ? ", filtered" : ""}.` : `${id === "board" ? "Board" : "List"} layout.`);
    if (current) layout().focusCurrent();
  }

  /** @param {any} v */
  function loadView(v) {
    const base = defaultView();
    view = { ...base, ...v, display: { ...base.display, ...v.display }, sort: v.sort ?? [] };
    savedView = structuredClone(view);
    filter.setQuery(view.query);
    itemsCache = null;
    projCache = null;
    selection = new Set();
    store.setPrefs({ lastViewId: v.id && !String(v.id).startsWith("builtin:") ? v.id : null });
    render(new Set(["data"]));
    live.announce(`View ${view.name}: ${computeItems().items.length} items.`);
  }
  function applyInitialView() {
    initialViewApplied = true;
    const last = store.prefs.lastViewId ? store.views.find((v) => v.id === store.prefs.lastViewId) : null;
    if (last) loadView(last);
    else filter.setQuery(view.query);
  }

  /** @param {HTMLElement} anchor */
  function viewsMenu(anchor) {
    const dirty = viewSig(view) !== viewSig(savedView);
    /** @type {import("./picker.js").PickerOption[]} */
    const options = [
      ...(store.planning ? BUILTIN : BUILTIN.slice(0, 1)).map((b) => ({ value: b.id, label: b.name, section: "Built in", detail: b.query, selected: view.id === b.id || (!view.id && b.id === "builtin:all" && view.name === "All items") })),
      ...store.views.map((v) => ({ value: v.id, label: v.name, section: "Saved views (shared)", detail: v.query, selected: view.id === v.id })),
    ];
    if (store.canWrite()) {
      if (dirty && view.id && !view.id.startsWith("builtin:")) options.push({ value: "act:save", label: `Save changes to “${view.name}”`, section: "Actions", icon: () => icon("save", { size: 14 }) });
      options.push({ value: "act:saveas", label: "Save as a new view…", section: "Actions", icon: () => icon("plus", { size: 14 }) });
      if (view.id && !view.id.startsWith("builtin:")) {
        options.push({ value: "act:rename", label: `Rename “${view.name}”…`, section: "Actions" }, { value: "act:delete", label: `Delete “${view.name}”`, section: "Actions" });
      }
    }
    if (dirty) options.push({ value: "act:reset", label: "Discard unsaved changes", section: "Actions" });
    openPicker({ layers, anchor, title: "Views", options, placeholder: "Find a view…", onPick: ([v]) => {
      if (v === "act:save") runAction("saveView");
      else if (v === "act:saveas") runAction("saveViewAs");
      else if (v === "act:rename") saveViewDialog(true);
      else if (v === "act:delete") void deleteCurrentView();
      else if (v === "act:reset") runAction("resetView");
      else {
        const b = BUILTIN.find((x) => x.id === v);
        if (b) loadView({ ...defaultView(), ...b });
        else { const s = store.views.find((x) => x.id === v); if (s) loadView(s); }
      }
    } });
  }

  async function saveCurrentView() {
    if (!view.id || view.id.startsWith("builtin:")) return saveViewDialog(false);
    try {
      const saved = await store.saveView(toDoc(view));
      savedView = structuredClone({ ...view, id: saved.id });
      live.announce(`Saved view ${view.name}.`);
      toast(`Saved view “${view.name}”.`);
      schedule();
    } catch (err) { toast(String(/** @type {any} */ (err)?.message ?? err).replace(/^[a-z_]+:\s*/, ""), { tone: "bad" }); }
  }

  /** @param {boolean} rename */
  function saveViewDialog(rename) {
    const input = /** @type {HTMLInputElement} */ (h("input", { type: "text", id: "wb-view-name", maxlength: "80", value: rename ? view.name : view.id ? `${view.name} (copy)` : "" }));
    const error = h("p", { class: "field-error", role: "alert" });
    const save = async () => {
      const name = input.value.trim();
      if (!name) { error.textContent = "Give the view a name."; input.focus(); return; }
      const id = rename && view.id ? view.id : `${name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "view"}-${Math.random().toString(36).slice(2, 7)}`;
      try {
        const saved = await store.saveView(toDoc({ ...view, id, name }));
        view = { ...view, id: saved.id, name: saved.name };
        savedView = structuredClone(view);
        store.setPrefs({ lastViewId: saved.id });
        dlg.close("saved");
        live.announce(`Saved view ${name}. Everyone using this board can open it.`);
        toast(`Saved view “${name}”.`);
        schedule();
      } catch (err) { error.textContent = String(/** @type {any} */ (err)?.message ?? err).replace(/^[a-z_]+:\s*/, ""); }
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } });
    const dlg = layers.openDialog({ title: rename ? "Rename view" : "Save view", size: "sm", description: "Saved views are shared with everyone using this board: query, layout, grouping, swimlanes, sort and display options.",
      content: (close) => [h("div", { class: "field" }, h("label", { for: "wb-view-name" }, "Name"), input, error),
        h("p", { class: "hint" }, `Query: ${view.query || "(all items)"}`),
        h("div", { class: "row end" }, h("button", { type: "button", class: "btn", onclick: () => close("cancel") }, "Cancel"), h("button", { type: "button", class: "btn primary", onclick: save }, "Save view"))],
      initialFocus: () => input });
  }
  async function deleteCurrentView() {
    if (!view.id) return;
    const name = view.name;
    try { await store.deleteView(view.id); loadView({ ...defaultView() }); toast(`Deleted view “${name}”.`); live.announce(`Deleted view ${name}.`); }
    catch (err) { toast(String(/** @type {any} */ (err)?.message ?? err).replace(/^[a-z_]+:\s*/, ""), { tone: "bad" }); }
  }

  /** @param {HTMLElement} anchor */
  function displayMenu(anchor) {
    const index = store.index();
    const fields = groupableFields(index);
    /** @param {string} label @param {string} value @param {{ value: string, label: string }[]} opts @param {(v: string) => void} onChange */
    const selectField = (label, value, opts, onChange) => {
      const id = `wb-disp-${label.replace(/\W+/g, "")}`;
      const s = /** @type {HTMLSelectElement} */ (h("select", { id }, opts.map((o) => h("option", { value: o.value, selected: o.value === value }, o.label))));
      s.addEventListener("change", () => { onChange(s.value); schedule(); });
      return h("div", { class: "field inline" }, h("label", { for: id }, label), s);
    };
    /** @param {string} label @param {boolean} checked @param {(v: boolean) => void} onChange */
    const check = (label, checked, onChange) => {
      const box = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked }));
      box.addEventListener("change", () => { onChange(box.checked); schedule(); });
      return h("label", { class: "check-label" }, box, label);
    };
    const setDisplay = (/** @type {Partial<ViewCfg["display"]>} */ d) => { view = { ...view, display: { ...view.display, ...d } }; };
    const sortOpts = [{ value: "manual", label: "Manual (drag to reorder)" }, { value: "priority", label: "Priority" }, { value: "-updated", label: "Recently updated" }, { value: "-created", label: "Newest" }, { value: "due", label: "Due date" }, { value: "estimate", label: "Estimate" }, { value: "key", label: "Key" }, { value: "title", label: "Title" }];
    const curSort = view.sort.length ? `${view.sort[0].dir === "desc" ? "-" : ""}${view.sort[0].field}` : view.layout === "board" ? "manual" : "priority";
    layers.openPopover({ anchor, label: "Display options", className: "display-menu", content: () => h("div", { class: "display-inner" },
      h("h2", { class: "pop-title" }, "Display"),
      selectField(view.layout === "list" ? "Group by" : "Columns", view.columnsBy, fields.filter((f) => f.column).map((f) => ({ value: f.field, label: f.label })), (v) => { view = { ...view, columnsBy: v }; collapsedCols.clear(); }),
      view.layout === "board" ? selectField("Swimlanes", view.swimlanesBy ?? "", [{ value: "", label: "None" }, ...fields.filter((f) => f.field !== view.columnsBy).map((f) => ({ value: f.field, label: f.label }))], (v) => { view = { ...view, swimlanesBy: v || null }; }) : null,
      selectField("Order", curSort, sortOpts, (v) => { view = { ...view, sort: v === "manual" ? [{ field: "rank", dir: "asc" }] : [{ field: v.replace(/^-/, ""), dir: v.startsWith("-") ? "desc" : "asc" }] }; }),
      selectField("Density", view.display.density, [{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }], (v) => setDisplay({ density: v })),
      h("fieldset", { class: "props-fieldset" }, h("legend", null, view.layout === "list" ? "Columns" : "Card properties"),
        h("div", { class: "check-grid" }, (view.layout === "list" ? Object.values(LIST_COLUMNS).filter((c) => c.id !== "title").map((c) => check(c.label, view.display.listColumns.includes(c.id), (on) => setDisplay({ listColumns: on ? [...view.display.listColumns, c.id].toSorted((a, b) => Object.keys(LIST_COLUMNS).indexOf(a) - Object.keys(LIST_COLUMNS).indexOf(b)) : view.display.listColumns.filter((x) => x !== c.id) })))
          : PROPS.map((p) => check(p === "progress" ? "Sub-issue progress" : p === "blocked" ? "Blocked badge" : p[0].toUpperCase() + p.slice(1), view.display.properties.includes(p), (on) => setDisplay({ properties: on ? [...view.display.properties, p] : view.display.properties.filter((x) => x !== p) })))))),
      check("Show sub-issues", view.display.showSubIssues, (v) => setDisplay({ showSubIssues: v })),
      check("Show archived items", view.display.showArchived, (v) => setDisplay({ showArchived: v })),
      view.layout === "board" ? check("Hide empty lanes", view.display.hideEmptyLanes, (v) => setDisplay({ hideEmptyLanes: v })) : null,
      view.layout === "board" ? selectField("Empty columns", String(view.display.hideEmptyColumns), [{ value: "null", label: "Hide while filtering" }, { value: "true", label: "Always hide" }, { value: "false", label: "Always show" }], (v) => setDisplay({ hideEmptyColumns: v === "null" ? null : v === "true" })) : null,
      view.layout === "board" && view.swimlanesBy ? h("div", { class: "row" },
        h("button", { type: "button", class: "btn sm", onclick: () => runAction("collapseLanes") }, "Collapse all lanes"),
        h("button", { type: "button", class: "btn sm", onclick: () => runAction("expandLanes") }, "Expand all lanes")) : null) });
  }

  /** @param {string} field @returns {import("./picker.js").PickerOption[]} */
  function valueOptions(field) {
    const text = `${field}:`;
    const s = suggest(text, text.length, ctx());
    return s.items.filter((x) => x.kind === "value").map((x) => ({ value: x.insert.replace(/,$/, "").trim(), label: x.label, detail: x.detail }));
  }
  /** @param {HTMLElement} anchor */
  function addFilter(anchor) {
    const fields = store.planning
      ? [["assignee", "Assignee"], ["state", "State"], ["priority", "Priority"], ["label", "Label"], ["project", "Project"], ["cycle", "Cycle"], ["due", "Due date"], ["estimate", "Estimate"], ["created_by", "Creator"], ["is", "Is…"], ["has", "Has…"]]
      : [["state", "State"], ["created_by", "Creator"]];
    openPicker({ layers, anchor, title: "Add a filter", options: fields.map(([value, label]) => ({ value, label })), placeholder: "Filter by…", onPick: ([f]) => {
      queueMicrotask(() => openPicker({ layers, anchor, title: `Filter by ${f}`, multi: f !== "is" && f !== "has", options: valueOptions(f), placeholder: "Choose values…", onPick: (values) => {
        if (!values.length) return;
        const { ast } = parse(filter.applied);
        const where = ast.where;
        const clause = f === "is" || f === "has" ? values.map((v) => `${f}:${v}`).join(" ") : `${f}:${values.join(",")}`;
        const base = format({ ...ast, sort: [] });
        const next = format(parse(`${where ? `${where.type === "or" ? `(${base})` : base} ` : ""}${clause}${ast.sort.length ? ` sort:${ast.sort.map((s) => `${s.dir === "desc" ? "-" : ""}${s.field}`).join(",")}` : ""}`).ast);
        filter.setQuery(next, true);
        live.announce(`Filter added: ${clause}.`);
      } }));
    } });
  }
  /** @param {{ chip: any, index: number, chips: any[], rest: any[], sort: any[] }} ch @param {HTMLElement} anchor */
  function editChip(ch, anchor) {
    const { chip } = ch;
    const options = [
      ...valueOptions(chip.field).map((o) => ({ ...o, selected: chip.values.map((/** @type {string} */ v) => v.toLowerCase()).includes(o.value.toLowerCase()) })),
      { value: "__negate__", label: chip.negated ? "Match these (remove “not”)" : "Exclude these (not)", section: "Options" },
    ];
    for (const v of chip.values) if (!options.some((o) => o.value.toLowerCase() === v.toLowerCase())) options.unshift({ value: v, label: v, selected: true, detail: "" });
    openPicker({ layers, anchor, title: `Filter: ${chip.field}`, multi: chip.op === "eq" && chip.field !== "is" && chip.field !== "has", options, onPick: (values) => {
      let negated = chip.negated;
      if (values.includes("__negate__")) negated = !negated;
      const vals = values.filter((v) => v !== "__negate__");
      const chips = ch.chips.map((c, i) => (i === ch.index ? { ...c, values: vals.length ? vals : c.values, negated } : c)).filter((c) => c.values.length);
      filter.setQuery(format(fromChips(chips, ch.rest, ch.sort)), true);
    } });
  }

  /** @param {ItemView} item @param {HTMLElement} anchor */
  function relate(item, anchor) {
    const kinds = [["blocks", "Blocks…"], ["blocked", "Is blocked by…"], ["relates", "Relates to…"], ["duplicates", "Duplicates…"]];
    openPicker({ layers, anchor, title: `Relate ${item.key}`, options: kinds.map(([value, label]) => ({ value, label })), onPick: ([kind]) => {
      const index = store.index();
      const options = index.itemList.filter((i) => i.id !== item.id && !i.archived).toSorted((a, b) => (b.number ?? 0) - (a.number ?? 0)).slice(0, 500).map((i) => ({ value: i.id, label: `${i.key} ${i.title}`, keywords: i.key, icon: () => itemStateIcon(i, index, { size: 13 }) }));
      queueMicrotask(() => openPicker({ layers, anchor, title: `${kinds.find((k) => k[0] === kind)?.[1]}`, options, placeholder: "Search by key or title…", onPick: ([other]) => {
        const o = index.items.get(other);
        const input = kind === "blocked" ? { from: other, to: item.id, kind: "blocks" } : { from: item.id, to: other, kind };
        const verb = kind === "blocked" ? "is blocked by" : kind === "duplicates" ? "duplicates" : kind;
        report(store.entity("work.relation.create", input, { label: `${item.key} ${verb} ${o?.key}` }), `${item.key} ${verb} ${o?.key}`, null);
      } }));
    } });
  }

  // ---------------------------------------------------------------------------------------------
  // Insights: reports data (one batched RPC per screen), report documents

  /** @type {Map<string, Record<string, unknown>>} */
  const insightParams = new Map();
  const insights = { key: "", version: -1, loading: false, again: false, results: /** @type {Record<string, any>|null} */ (null), error: "", at: /** @type {number|null} */ (null), fetchedAt: 0, historyComplete: true, reportsLoading: false, timer: /** @type {ReturnType<typeof setTimeout>|null} */ (null) };
  const INSIGHTS_REFRESH_MS = 5_000;

  function visibleReports() { return (store.reports ?? []).filter((r) => !r.hidden); }
  function insightRequests() {
    return visibleReports().map((r) => ({ id: r.id, dataset: r.dataset, params: { ...r.params, ...insightParams.get(r.id) }, query: r.query ?? "" }));
  }
  /** Fetches report data when the filter, reports or parameters change, and at most every 5 s as data changes. @param {boolean} [force] */
  function ensureInsights(force = false) {
    if (store.reports === null) {
      if (!insights.reportsLoading) {
        insights.reportsLoading = true;
        store.loadReports().catch((err) => { insights.error = `Reports could not load: ${String(err?.message ?? err).replace(/^[a-z_]+:\s*/, "")}`; })
          .finally(() => { insights.reportsLoading = false; if (view.layout === "insights") renderLayout(); });
      }
      return;
    }
    const key = JSON.stringify([view.query, insightRequests(), store.me]);
    const version = store.replica.version;
    const sinceFetch = Date.now() - insights.fetchedAt;
    const changedData = version !== insights.version;
    if (!force && key === insights.key && (!changedData || sinceFetch < INSIGHTS_REFRESH_MS)) {
      if (changedData && !insights.timer) insights.timer = setTimeout(() => { insights.timer = null; if (view.layout === "insights") ensureInsights(); }, INSIGHTS_REFRESH_MS - sinceFetch + 50);
      return;
    }
    if (insights.loading) { insights.again = true; return; }
    insights.loading = true;
    insights.key = key;
    insights.version = version;
    store.call("insights", { query: view.query, reports: insightRequests(), viewer: store.me })
      .then((r) => { insights.results = r.results; insights.at = Date.parse(r.at) || now(); insights.historyComplete = r.history?.complete !== false; insights.error = ""; })
      .catch((err) => { insights.error = `Reports could not load: ${String(err?.message ?? err).replace(/^[a-z_]+:\s*/, "")}`; live.announce(insights.error, { assertive: true }); })
      .finally(() => {
        insights.loading = false;
        insights.fetchedAt = Date.now();
        if (insights.again) { insights.again = false; ensureInsights(); }
        if (view.layout === "insights" && store.phase === "ready") renderLayout();
      });
  }
  function insightsModel() {
    const index = store.index();
    const c = ctx();
    const utc = new Date(now()).toISOString().slice(0, 10);
    const { ast } = parse(view.query);
    return {
      reports: visibleReports(), hiddenCount: (store.reports ?? []).filter((r) => r.hidden).length,
      results: insights.results, loading: insights.loading || store.reports === null, error: insights.error, at: insights.at, now: now(),
      historyComplete: insights.historyComplete, filter: view.query, filterDescription: view.query ? describeWql(ast, c) : "",
      canWrite: store.canWrite(),
      cycles: index.cycles.filter((cy) => cy.start && cy.end).map((cy) => ({ name: cy.name, current: /** @type {string} */ (cy.start) <= utc && utc <= /** @type {string} */ (cy.end) })),
      params: (/** @type {string} */ id) => insightParams.get(id) ?? {},
    };
  }
  /** @param {any} rep @param {HTMLElement} anchor */
  function reportMenu(rep, anchor) {
    const w = store.canWrite();
    /** @type {import("./picker.js").PickerOption[]} */
    const options = [
      ...(w ? [{ value: "edit", label: "Edit report…", detail: "Title, filter, parameters and spec" }, { value: "duplicate", label: "Duplicate" }] : []),
      { value: "spec", label: w ? "View or edit spec…" : "View spec" },
      ...(w && rep.customised ? [{ value: "reset", label: "Reset to the built-in version" }] : []),
      ...(w ? [{ value: "delete", label: rep.builtin ? "Hide this report" : "Delete this report…" }] : []),
    ];
    openPicker({ layers, anchor, title: rep.title, options, placeholder: "Choose an action…", onPick: ([v]) => {
      if (v === "edit" || v === "spec") editReport(rep);
      else if (v === "duplicate") void reportOp(() => store.saveReport({ title: `${rep.title} (copy)`, description: rep.description ?? "", dataset: rep.dataset, params: rep.params, query: rep.query, spec: rep.spec }), `Duplicated “${rep.title}”.`);
      else if (v === "reset") void reportOp(() => store.restoreReport(rep.id), `Reset “${rep.title}”.`);
      else if (v === "delete") {
        if (rep.builtin) void reportOp(() => store.deleteReport(rep.id), `Hid “${rep.title}”. Bring it back from Hidden.`);
        else confirmDelete(rep);
      }
    } });
  }
  /** @param {() => Promise<any>} fn @param {string} done */
  async function reportOp(fn, done) {
    try { await fn(); live.announce(done); toast(done); insights.key = ""; renderLayout(); }
    catch (err) { const m = String(/** @type {any} */ (err)?.message ?? err).replace(/^[a-z_]+:\s*/, ""); toast(m, { tone: "bad" }); live.announce(m, { assertive: true }); }
  }
  /** @param {any} rep */
  function confirmDelete(rep) {
    layers.openDialog({ title: `Delete “${rep.title}”?`, size: "sm", description: "The report is removed for everyone using this board. The data it charts is not affected.",
      content: (close) => [h("div", { class: "row end" }, h("button", { type: "button", class: "btn", onclick: () => close("cancel") }, "Cancel"),
        h("button", { type: "button", class: "btn primary danger", onclick: () => { close("ok"); void reportOp(() => store.deleteReport(rep.id), `Deleted “${rep.title}”.`); } }, "Delete report"))] });
  }
  /** @param {any|null} rep */
  function editReport(rep) {
    openReportEditor({ layers, report: rep, datasets: listDatasets(), canWrite: store.canWrite(), announce: (t) => live.announce(t),
      validate: (d) => store.call("validateReport", d),
      save: async (d) => { const saved = await store.saveReport(d); live.announce(`Saved report “${saved.title}”.`); toast(`Saved report “${saved.title}”.`); insights.key = ""; renderLayout(); } });
  }
  /** @param {HTMLElement} anchor */
  function hiddenReports(anchor) {
    const hidden = (store.reports ?? []).filter((r) => r.hidden);
    openPicker({ layers, anchor, title: "Hidden reports", options: hidden.map((r) => ({ value: r.id, label: `Show “${r.title}” again` })), onPick: ([id]) => {
      const r = hidden.find((x) => x.id === id);
      if (r) void reportOp(() => store.restoreReport(r.id), `“${r.title}” is back.`);
    } });
  }

  // ---------------------------------------------------------------------------------------------
  // Proposals: applying through the normal write path, and recording outcomes

  /** Store changes sent from proposals this session: "proposalId:n" → change. @type {Map<string, import("../store/store.js").Change>} */
  const proposalLive = new Map();
  /** @type {Map<string, string>} last recorded status per "proposalId:n" */
  const proposalRecorded = new Map();
  /** @param {string} pid @param {number} n */
  function liveChange(pid, n) { return proposalLive.get(`${pid}:${n}`) ?? null; }

  /** @param {any} p @param {number[]} ns */
  async function applyFromTray(p, ns) {
    const { results, outcomes } = applyProposal(store, p, ns);
    for (const r of results) if (r.change) { proposalLive.set(`${p.id}:${r.n}`, r.change); proposalRecorded.set(`${p.id}:${r.n}`, "sent"); }
    const sent = results.filter((r) => r.ok && r.change).length;
    const failed = results.filter((r) => !r.ok);
    const text = `${p.title}: ${sent} ${sent === 1 ? "change" : "changes"} sent${failed.length ? `; ${failed.length} not sent (${failed.slice(0, 2).map((f) => f.error).join("; ")})` : ""}.`;
    live.announce(text, { assertive: failed.length > 0 });
    toast(text, { tone: failed.length ? "bad" : "" });
    try { await store.recordProposalOutcome(p.id, outcomes); } catch (err) { console.warn("Could not record the proposal outcome:", String(/** @type {any} */ (err)?.message ?? err)); }
  }

  /** Records outcomes as sent changes are approved, saved or refused (batched per proposal). */
  let outcomeTimer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);
  function trackProposalOutcomes() {
    if (outcomeTimer || !proposalLive.size) return;
    outcomeTimer = setTimeout(() => {
      outcomeTimer = null;
      /** @type {Map<string, any[]>} */
      const byProposal = new Map();
      for (const [key, ch] of proposalLive) {
        const o = outcomeOf(ch);
        if (proposalRecorded.get(key) === o.status) continue;
        proposalRecorded.set(key, o.status);
        const [pid, n] = [key.slice(0, key.lastIndexOf(":")), Number(key.slice(key.lastIndexOf(":") + 1))];
        byProposal.set(pid, [...(byProposal.get(pid) ?? []), { n, ...o }]);
        if (o.status === "applied" || o.status === "conflict" || o.status === "rejected") proposalLive.delete(key);
      }
      for (const [pid, list] of byProposal) store.recordProposalOutcome(pid, list).catch(() => {});
    }, 400);
  }

  /** Jev triage suggestions for items, applied (or saved) as a proposal. @param {ItemView[]} items */
  function suggestWithJev(items) {
    if (!items.length) return;
    const keys = items.map((i) => i.key);
    const title = items.length === 1 ? `Jev suggestions for ${keys[0]}` : `Jev triage: ${items.length} items`;
    const by = { kind: "jev", name: store.viewer?.displayName ?? store.viewer?.id ?? "you" };
    openSuggestions({ layers, title, count: items.length, announce: (t, o) => live.announce(t, o),
      triage: () => store.call("triage", keys),
      apply: async (changes, meta) => {
        const p = await store.propose(changes, { title: `Jev triage: ${meta.keys.join(", ")}`, reason: "Suggested by Jev and applied from the board.", by });
        await applyFromTray(p, p.changes.map((/** @type {any} */ c) => c.n));
      },
      save: async (changes, meta) => {
        const p = await store.propose(changes, { title: `Jev triage: ${meta.keys.join(", ")}`, reason: "Suggested by Jev; review and apply in Proposals.", by });
        live.announce(`Saved to Proposals: ${p.title}.`);
        toast(`Saved to Proposals: ${p.changes.length} ${p.changes.length === 1 ? "change" : "changes"}.`, { action: { label: "Open", run: () => tray.show(p.id) } });
      },
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Actions (the verb grammar)

  /** @type {Record<string, { label: string, group: string, when?: () => boolean, run: (arg?: any) => void }>} */
  const ACTIONS = {
    palette: { label: "Command palette", group: "General", run: () => openPaletteNow() },
    create: { label: "Create item", group: "General", when: () => store.canWrite(), run: (at) => {
      const f = at ?? (view.layout === "board" && boardFocus ? { col: boardFocus.col, lane: boardFocus.lane } : {});
      const { fields, context } = createDefaults(f);
      openCreate({
        layers, index: () => store.index(), me: store.me, today: () => today(), defaults: fields, context,
        summarize: (prop, fs) => pickers.summarize(prop, fs), choose: (prop, fs, anchor, done) => pickers.chooseForDraft(prop, fs, anchor, done),
        submit: (fs) => { const r = store.createItem(withTopRank(fs)); if (r.ok) live.announce(`Sent: ${r.change.label}.`); return r.ok ? { ok: true } : r; },
        draft: store.prefs.draft ?? null, saveDraft: (d) => store.setPrefs({ draft: d }), announce: (t) => live.announce(t),
      });
    } },
    filter: { label: "Filter (WQL)", group: "General", run: () => { app.classList.add("filter-open"); filter.focus(); } },
    showKey: { label: "Share: show the key", group: "Item", when: () => targets().length === 1, run: () => { const [t] = targets(); if (t) showKey(t, anchorFor()); } },
    help: { label: "Keyboard shortcuts", group: "General", run: () => shortcutSheet() },
    settings: { label: "Board settings", group: "General", run: () => openSettings({ layers, store, today: () => today(), announce: (t) => live.announce(t) }) },
    toggleLayout: { label: "Switch board / list", group: "View", run: () => setLayout(view.layout === "board" ? "list" : "board") },
    layoutBoard: { label: "Board layout", group: "View", run: () => setLayout("board") },
    layoutList: { label: "List layout", group: "View", run: () => setLayout("list") },
    layoutInsights: { label: "Insights (reports)", group: "View", run: () => setLayout("insights") },
    proposals: { label: "Proposals from the agent and Jev", group: "General", run: () => { tray.show(); void store.loadProposals(); } },
    triageJev: { label: "Triage with Jev", group: "Item", when: () => store.jev && store.canWrite() && store.planning, run: () => {
      const picked = selection.size ? targets() : computeItems().items.filter((i) => i.kind === "triage");
      if (!picked.length) { live.announce("Nothing to triage: select items or open the Triage view."); toast("Select items, or open the Triage view, to triage with Jev."); return; }
      suggestWithJev(picked.slice(0, 20));
      if (picked.length > 20) toast(`Jev looks at 20 items at a time; the first 20 of ${picked.length} are in this batch.`);
    } },
    suggest: { label: "Suggest with Jev (triage this item)", group: "Item", when: () => store.jev && store.canWrite() && store.planning && targets().length === 1, run: () => suggestWithJev(targets()) },
    newReport: { label: "New report…", group: "View", when: () => store.canWrite(), run: () => { setLayout("insights"); editReport(null); } },
    saveView: { label: "Save view", group: "View", when: () => store.canWrite(), run: () => { void saveCurrentView(); } },
    saveViewAs: { label: "Save as a new view…", group: "View", when: () => store.canWrite(), run: () => saveViewDialog(false) },
    resetView: { label: "Discard unsaved view changes", group: "View", run: () => loadView(savedView) },
    collapseLanes: { label: "Collapse all lanes", group: "View", when: () => Boolean(view.swimlanesBy), run: () => { const keys = computeProjection().lanes.map((l) => l.key); store.setPrefs({ collapsedLanes: [...new Set([...(store.prefs.collapsedLanes ?? []), ...keys])] }); live.announce("All lanes collapsed."); } },
    expandLanes: { label: "Expand all lanes", group: "View", when: () => Boolean(view.swimlanesBy), run: () => { store.setPrefs({ collapsedLanes: (store.prefs.collapsedLanes ?? []).filter((/** @type {string} */ k) => k.startsWith("list:")) }); live.announce("All lanes expanded."); } },
    refresh: { label: "Check for changes now", group: "General", run: () => { void store.refresh().then(() => live.announce("Up to date.")); } },
    toggleShortcuts: { label: "Turn single-key shortcuts on or off", group: "General", run: () => { const on = store.prefs.shortcuts === false; store.setPrefs({ shortcuts: on }); live.announce(`Single-key shortcuts ${on ? "on" : "off"}.`); } },
    open: { label: "Open item", group: "Item", when: () => targets().length === 1, run: () => { const [t] = targets(); if (t) openDetail(t, { focus: true }); } },
    peek: { label: "Peek (toggle details)", group: "Item", when: () => targets().length >= 1, run: () => { const [t] = targets(); if (!t) return; if (detail.itemId === t.id) closeDetail(); else { openDetail(t, { focus: false }); live.announce(`Peeking at ${t.key}: ${t.title}.`); } } },
    select: { label: "Select / deselect", group: "Item", when: () => Boolean(focusedItem()), run: () => { const f = focusedItem(); if (f) select(f, { toggle: true }); } },
    selectAll: { label: "Select all shown", group: "Item", when: () => store.canWrite(), run: () => { selection = new Set(computeItems().items.map((i) => i.id)); live.announce(`${selection.size} selected.`); schedule(); } },
    clearSelection: { label: "Clear selection", group: "Item", when: () => selection.size > 0, run: () => clearSelection() },
    state: { label: "Set state…", group: "Item", when: () => store.canWrite() && targets().length > 0, run: () => pickers.pick("state", targets(), anchorFor()) },
    assign: { label: "Assign…", group: "Item", when: () => store.canWrite() && store.planning && targets().length > 0, run: () => pickers.pick("assignee", targets(), anchorFor()) },
    assignMe: { label: "Assign to me", group: "Item", when: () => store.canWrite() && store.planning && Boolean(store.me) && targets().length > 0, run: () => applyPatch(targets(), () => ({ assignee: store.me }), `Assign ${targets().length === 1 ? targets()[0].key : `${targets().length} items`} to you`) },
    priority: { label: "Set priority…", group: "Item", when: () => store.canWrite() && store.planning && targets().length > 0, run: () => pickers.pick("priority", targets(), anchorFor()) },
    labels: { label: "Labels…", group: "Item", when: () => store.canWrite() && store.planning && targets().length > 0, run: () => pickers.pick("labels", targets(), anchorFor()) },
    estimate: { label: "Estimate…", group: "Item", when: () => store.canWrite() && store.planning && targets().length > 0, run: () => pickers.pick("estimate", targets(), anchorFor()) },
    due: { label: "Due date…", group: "Item", when: () => store.canWrite() && store.planning && targets().length > 0, run: () => pickers.pick("due", targets(), anchorFor()) },
    project: { label: "Project…", group: "Item", when: () => store.canWrite() && store.planning && targets().length > 0, run: () => pickers.pick("project", targets(), anchorFor()) },
    cycle: { label: "Cycle…", group: "Item", when: () => store.canWrite() && store.planning && targets().length > 0, run: () => pickers.pick("cycle", targets(), anchorFor()) },
    parent: { label: "Set parent…", group: "Item", when: () => store.canWrite() && store.planning && targets().length > 0, run: () => pickers.pick("parent", targets(), anchorFor()) },
    move: { label: "Move to…", group: "Item", when: () => store.canWrite() && targets().length === 1, run: () => pickers.pick("move", targets(), anchorFor()) },
    moveMode: { label: "Move with the keyboard", group: "Item", when: () => store.canWrite() && view.layout === "board", run: () => { if (!layout("board").startMove()) live.announce("Focus a card on the board first."); } },
    archive: { label: "Archive / restore", group: "Item", when: () => store.canWrite() && store.planning && targets().length > 0, run: () => { const t = targets(); const to = !t.every((i) => i.archived); applyPatch(t, () => ({ archived: to }), `${to ? "Archive" : "Restore"} ${t.length === 1 ? t[0].key : `${t.length} items`}`); } },
    undo: { label: "Undo your last change", group: "General", run: () => {
      const last = [...store.changes].toReversed().find((c) => c.undo && !c.undoOf && c.status !== "conflict" && c.status !== "rejected");
      if (!last) { live.announce("Nothing to undo."); return; }
      undo(last);
    } },
  };

  /** @param {string} id @param {any} [arg] */
  function runAction(id, arg) {
    const a = ACTIONS[id];
    if (!a) return false;
    if (a.when && !a.when()) { live.announce(id === "create" || !store.canWrite() ? "Read-only: you can't change items here." : "Choose an item first (focus a card or select some)."); return false; }
    a.run(arg);
    return true;
  }

  function openPaletteNow() {
    const t = targets();
    const context = t.length === 1 ? t[0].key : t.length > 1 ? `${t.length} selected` : "";
    openPalette({
      layers, mac, context,
      entries: () => {
        const list = Object.entries(ACTIONS).filter(([, a]) => !a.when || a.when()).map(([id, a]) => ({
          id: `a:${id}`, label: a.label, group: a.group === "Item" && context ? `Actions for ${context}` : a.group,
          keys: SHORTCUTS.find((s) => s.id === id)?.keys.slice(0, 1), run: () => runAction(id),
        }));
        const views = [...BUILTIN.slice(0, store.planning ? BUILTIN.length : 1), ...store.views].map((v) => ({ id: `v:${v.id}`, label: `View: ${v.name}`, group: "Views", keywords: v.query ?? "",
          run: () => { const b = BUILTIN.find((x) => x.id === v.id); loadView(b ? { ...defaultView(), ...b } : v); } }));
        return [...list.toSorted((a, b) => (a.group.startsWith("Actions") ? -1 : b.group.startsWith("Actions") ? 1 : 0)), ...views];
      },
      items: (q) => {
        const index = store.index();
        const exact = itemByKey(index, q.trim());
        const scored = [];
        const words = q.toLowerCase().split(/\s+/).filter(Boolean);
        for (const i of index.itemList) {
          if (exact && i.id === exact.id) continue;
          // Items match on whole words (every typed word appears); commands keep the fuzzy match.
          const hay = `${i.key} ${i.title}`.toLowerCase();
          if (!words.every((w) => hay.includes(w))) continue;
          scored.push({ i, s: fuzzyScore(q, hay) ?? 0 });
        }
        scored.sort((a, b) => b.s - a.s);
        return [...(exact ? [exact] : []), ...scored.slice(0, 20).map((x) => x.i)].map((i) => ({
          id: `i:${i.id}`, label: `${i.key} ${i.title}`, group: "Items", detail: index.stateByKey.get(i.state)?.name,
          icon: () => itemStateIcon(i, index, { size: 13 }), run: () => { openDetail(i, { focus: true }); const pos = findBoardPos(i.id); if (pos) boardFocus = pos; },
        }));
      },
    });
  }

  function shortcutSheet() {
    const box = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", id: "wb-sc-toggle", checked: store.prefs.shortcuts !== false }));
    box.addEventListener("change", () => { store.setPrefs({ shortcuts: box.checked }); live.announce(`Single-key shortcuts ${box.checked ? "on" : "off"}.`); });
    const groups = [...new Set(SHORTCUTS.map((s) => s.group))];
    layers.openDialog({ title: "Keyboard shortcuts", size: "lg", className: "shortcuts",
      content: () => [h("label", { class: "check-label", for: "wb-sc-toggle" }, box, "Single-key shortcuts (letters, / and ?)"),
        h("p", { class: "hint" }, "They never fire while you type. Arrow keys, Enter, Space, Escape and Ctrl/⌘ shortcuts always work. Every action is also in the command palette."),
        h("div", { class: "sc-grid" }, groups.map((g) => h("section", null, h("h3", null, g), h("dl", null, SHORTCUTS.filter((s) => s.group === g).flatMap((s) => [
          h("dt", null, (s.display ?? s.keys).map((k) => h("kbd", null, keyLabel(k, mac)))), h("dd", null, s.label)])))))] });
  }

  // ---------------------------------------------------------------------------------------------
  // Keyboard

  const NAV = new Set(["up", "down", "left", "right", "first", "last", "pageUp", "pageDown"]);
  let chord = false;
  /** @param {KeyboardEvent} e */
  function onKeydown(e) {
    if (e.defaultPrevented) return;
    const inDialog = layers.open;
    const id = matchShortcut(e, { singleKeys: store.prefs.shortcuts !== false });
    if (id === "palette") { e.preventDefault(); if (!inDialog) runAction("palette"); return; }
    if (inDialog || store.phase !== "ready") return;
    const target = /** @type {HTMLElement|null} */ (e.target);
    const inLayout = Boolean(target && layoutHost.contains(target));
    const inDetail = Boolean(target && detail.el.contains(target));
    const board = layout("board");
    // Two-key chords: G then B (board) or L (list).
    if (!isTyping(target) && !e.ctrlKey && !e.metaKey && !e.altKey && store.prefs.shortcuts !== false && !board.moving) {
      const k = e.key.toLowerCase();
      if (chord && (k === "b" || k === "l" || k === "i")) { e.preventDefault(); chord = false; setLayout(k === "b" ? "board" : k === "l" ? "list" : "insights"); return; }
      if (chord && k === "p") { e.preventDefault(); chord = false; runAction("proposals"); return; }
      chord = false;
      if (k === "g") { e.preventDefault(); chord = true; setTimeout(() => { chord = false; }, 1200); return; }
    }
    // Move mode owns the keyboard until Enter or Escape.
    if (view.layout === "board" && board.moving) {
      const dirs = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
      if (e.key in dirs) { e.preventDefault(); board.navigate(/** @type {any} */ (dirs)[e.key]); return; }
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); board.commitMove(); return; }
      if (e.key === "Escape") { e.preventDefault(); board.cancelMove(); return; }
      if (e.key !== "Tab") { e.preventDefault(); return; }
    }
    if (!id) return;
    if (id === "close") {
      if (isTyping(target)) return;
      if (clearSelection()) { e.preventDefault(); return; }
      if (detail.itemId && !detail.editing) { e.preventDefault(); closeDetail(); return; }
      return;
    }
    const onBody = !target || target === doc.body || target === app || target === main;
    if (view.layout === "insights" && (NAV.has(id) || id === "open" || id === "peek" || id === "moveMode")) {
      const onCard = Boolean(target?.closest(".report-card h3")) || target === layout("insights").el;
      if (!onCard || id === "open" || id === "peek" || id === "moveMode") return;
      e.preventDefault();
      layout("insights").navigate(id);
      return;
    }
    if (NAV.has(id) || id === "open" || id === "peek" || id === "moveMode") {
      if (!(inLayout || onBody || (inDetail && peeking && !isTyping(target)))) return;
      if (target && target.closest("button, a, input, select, [role=tab]") && !target.closest(".card, .lg-td, .cell-empty") && (id === "open" || id === "peek")) return;
      e.preventDefault();
      if (id === "moveMode") { runAction("moveMode"); return; }
      if (id === "open") { runAction("open"); return; }
      if (id === "peek") { runAction("peek"); return; }
      const inst = layout();
      if (view.layout === "board" && isNarrow() && (id === "left" || id === "right")) { stepColumn(id === "left" ? -1 : 1); return; }
      // Until focus is on a card (or list cell), the first key press lands on the current one;
      // after that keys move.
      const onItem = Boolean(target?.closest("article.card, li.cell-empty, .lg-td, .lg-grouphead button"));
      if (!onItem && inst.focusCurrent()) return;
      inst.navigate(id);
      return;
    }
    if (inDetail && ["state", "assign", "assignMe", "priority", "labels", "estimate", "due", "move", "select"].includes(id) && isTyping(target)) return;
    e.preventDefault();
    runAction(id);
  }
  doc.addEventListener("keydown", onKeydown);

  // Relative times and the offline countdown refresh themselves.
  const ticker = setInterval(() => { if (store.phase === "ready") { renderTopbar(); renderBanners(); if (detail.itemId && !detail.editing) detail.render(); if (view.layout === "list") renderLayout(); status.render(); } }, 30_000);

  render(new Set(["phase"]));

  return {
    ready: store.ready.then(() => { render(new Set(["data", "changes", "views"])); }),
    store,
    get view() { return view; },
    get selection() { return selection; },
    get boardFocus() { return boardFocus; },
    runAction, loadView, setLayout, openDetail, closeDetail, render: () => render(new Set(["data", "changes"])),
    /** Test and e2e hooks. */
    layout, live, pickers, filter, detail, tray, refreshInsights: () => ensureInsights(true),
    get insights() { return insights; },
    destroy() {
      clearInterval(ticker);
      if (insights.timer) clearTimeout(insights.timer);
      if (outcomeTimer) clearTimeout(outcomeTimer);
      layouts.get("insights")?.destroy?.();
      doc.removeEventListener("keydown", onKeydown);
      store.destroy();
    },
  };
}
