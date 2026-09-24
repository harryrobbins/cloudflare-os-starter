// @ts-check
// The app shell: top bar, left rail (views, search, legend, focus), the stage (map canvas or
// list), the right panel (Profile, Design, Data, Activity) and the quick-add bar. It owns the
// wiring between the store (src/client/sync/store.js), the model (../model/map-model.js) and the
// renderer (../render/sigma-renderer.js), canvas gestures, keyboard navigation, presence, layout
// jobs and the demo banner. Panels are separate modules built on the App API below.
//
// App API (what panels may use):
//   app.store               the sync store (objects, positions, meta, peers, history, changesets)
//   app.model               the current MapModel (index, view, layout, decor, nodes, edges)
//   app.view / app.viewId   the view being shown
//   app.selection           Set of selected ids (elements, connections, loops)
//   app.select(ids, {center, add, announce})
//   app.setView(id)  app.setPanel(name)  app.setMode("map"|"list")
//   app.apply(ops, extra)   queue ops (optimistic); ids come from app.newId(kind)
//   app.on(event, fn)       "model" | "selection" | "view" | "panel" | "mode" -> unsubscribe fn
//   app.toast(message)  app.announce(message)
//   app.runLayout(kind)     "force" | "circle" | "grid"
//   app.centerOn(id)  app.focusCanvas()
//   app.by                  the viewer's display name

import { h, clear, icon, inlineEditable, avatar, textOn } from "./dom.js";
import { showToast, openMenu, modal } from "./dialogs.js";
import { statusText } from "../sync/connection.js";
import { computeModel, orderedViews } from "../model/map-model.js";
import { createRenderer } from "../render/sigma-renderer.js";
import { runForceLayout, circleLayout, gridLayout } from "../layout/index.js";
import { parseQuickAdd } from "../../shared/quickadd.js";
import { SHARED_LAYOUT, describeSelector, neighbourhood } from "../../shared/rules.js";
import { normalizeLabel, PALETTE, DEFAULT_VIEW_NAME, DEFAULT_TITLE } from "../../shared/protocol.js";
import { mountProfile } from "./profile.js";
import { mountDesign } from "./design.js";
import { mountData } from "./data.js";
import { mountActivity } from "./activity.js";
import { mountList } from "./list.js";

const PANELS = /** @type {const} */ ([["profile", "Profile"], ["design", "Design"], ["data", "Data"], ["activity", "Activity"]]);
const MOVE_CHUNK = 2000;

/**
 * @param {HTMLElement} root
 * @param {ReturnType<typeof import("../sync/store.js").createStore>} store
 */
export function mountApp(root, store) {
  /** @type {Map<string, Set<(detail: any) => void>>} */
  const handlers = new Map();
  /** @param {string} name @param {any} [detail] */
  const emit = (name, detail) => { for (const fn of [...(handlers.get(name) ?? [])]) { try { fn(detail); } catch (e) { console.error(e); } } };

  const live = h("div", { class: "sr-only", role: "status", "aria-live": "polite" });
  /** @param {string} message */
  const announce = (message) => { live.textContent = ""; setTimeout(() => { live.textContent = message; }, 30); };

  /** @type {any} */
  const app = {
    store,
    /** @type {any} */ model: null,
    /** @type {string|null} */ viewId: null,
    get view() { return app.model?.view ?? null; },
    get layoutKey() { return app.model?.layout ?? SHARED_LAYOUT; },
    /** @type {Set<string>} */ selection: new Set(),
    mode: "map",
    panel: "profile",
    by: store.viewer.name,
    /** @param {string} name @param {(detail: any) => void} fn */
    on(name, fn) {
      let set = handlers.get(name);
      if (!set) handlers.set(name, (set = new Set()));
      set.add(fn);
      return () => set?.delete(fn);
    },
    toast: (/** @type {string} */ m) => showToast(m),
    announce,
    newId: (/** @type {string} */ kind) => store.newId(({ element: "e", connection: "c", loop: "l", view: "v", type: "t", field: "f" })[kind] ?? kind),
    /** @param {any[]} ops @param {any} [extra] */
    apply: (ops, extra) => store.apply(ops, extra),
    select,
    setView,
    setPanel,
    setMode,
    runLayout,
    centerOn,
    focusCanvas: () => canvasHost.focus(),
    openPanelTab: setPanel,
    openPanel: () => openPanel(),
  };

  // --- Layout ---------------------------------------------------------------------------------

  const title = inlineEditable({
    className: "nm-title", label: "Map title", maxLength: 200,
    getValue: () => store.meta?.title ?? DEFAULT_TITLE,
    onSave: (value) => store.apply([], { structure: { title: value } }),
  });
  const connChip = h("span", { class: "conn", role: "status", dataset: { state: "connecting" } }, h("span", { class: "conn-dot" }), h("span", { class: "conn-text" }, "Connecting…"));
  const peersEl = h("span", { class: "peers", "aria-label": "People here" });
  const viewPicker = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "View", onchange: () => setView(viewPicker.value) }));
  const modeMap = h("button", { type: "button", class: "btn small", "aria-pressed": "true", onclick: () => setMode("map") }, "Map");
  const modeList = h("button", { type: "button", class: "btn small", "aria-pressed": "false", onclick: () => setMode("list") }, "List");
  const undoBtn = h("button", { type: "button", class: "btn icon-only", title: "Undo (Ctrl+Z)", "aria-label": "Undo", onclick: () => store.undo() }, icon("undo"));
  const redoBtn = h("button", { type: "button", class: "btn icon-only", title: "Redo (Ctrl+Shift+Z)", "aria-label": "Redo", onclick: () => store.redo() }, icon("redo"));
  const layoutBtn = h("button", {
    type: "button", class: "btn small", "aria-haspopup": "menu",
    onclick: () => openMenu(layoutBtn, [
      { label: "Force layout", onSelect: () => runLayout("force") },
      { label: "Circle", onSelect: () => runLayout("circle") },
      { label: "Grid", onSelect: () => runLayout("grid") },
      { label: "Unpin all", onSelect: () => unpinAll() },
    ], { label: "Layout" }),
  }, icon("layout"), "Layout");
  const exportBtn = h("button", { type: "button", class: "btn small", onclick: () => exportImage() }, icon("image"), "Image");
  const railToggle = h("button", { type: "button", class: "btn icon-only", title: "Views and legend", "aria-label": "Show views and legend", "aria-pressed": "true", onclick: () => toggleRail() }, icon("sidebar"));
  const panelToggle = h("button", { type: "button", class: "btn icon-only", title: "Details panel", "aria-label": "Show details panel", "aria-pressed": "true", onclick: () => togglePanel() }, icon("panel"));
  const helpBtn = h("button", { type: "button", class: "btn icon-only", title: "Help", "aria-label": "Help and shortcuts", onclick: () => showHelp() }, icon("help"));
  const topbar = h("header", { class: "nm-topbar" },
    railToggle, title.el, connChip, h("span", { class: "sep" }),
    h("label", { class: "sr-only", for: "nm-view" }, "View"), viewPicker,
    h("span", { class: "inline", role: "group", "aria-label": "Mode" }, modeMap, modeList),
    layoutBtn, undoBtn, redoBtn, h("span", { class: "spacer" }), peersEl, exportBtn, helpBtn, panelToggle);
  viewPicker.id = "nm-view";

  // Left rail.
  const viewList = h("div", { class: "view-list", role: "list" });
  const searchInput = /** @type {HTMLInputElement} */ (h("input", { type: "search", placeholder: "Find an element…", "aria-label": "Find an element", oninput: () => runSearch() }));
  const searchResults = h("div", { class: "search-results", role: "list" });
  const legendEl = h("div", { class: "legend" });
  const focusEl = h("div", { class: "inline" });
  const rail = h("aside", { class: "nm-rail", "aria-label": "Views and legend" },
    h("div", { class: "nm-scroll" },
      h("section", { class: "nm-section" }, h("h3", null, icon("search", 14), "Find"), searchInput, searchResults),
      h("section", { class: "nm-section" }, h("h3", null, "Views"), viewList,
        h("button", { type: "button", class: "btn small outline", onclick: () => newView() }, icon("plus", 14), "New view")),
      h("section", { class: "nm-section" }, h("h3", null, icon("focus", 14), "Focus"), focusEl),
      h("section", { class: "nm-section" }, h("h3", null, "Legend"), legendEl)));

  // Stage.
  const canvasHost = h("div", { class: "nm-canvas", tabindex: "0", role: "application", "aria-label": "Network map canvas. Arrow keys move between elements, Enter adds a connected element, Delete removes the selection." });
  const listHost = h("div", { class: "nm-list-host", hidden: true });
  const overlay = h("div", { class: "nm-overlay", "aria-hidden": "true" });
  const zoom = h("div", { class: "stage-float stage-zoom", role: "group", "aria-label": "Zoom" },
    h("button", { type: "button", class: "btn icon-only", "aria-label": "Zoom in", onclick: () => renderer.zoomIn() }, icon("plus")),
    h("button", { type: "button", class: "btn icon-only", "aria-label": "Zoom out", onclick: () => renderer.zoomOut() }, icon("minus")),
    h("button", { type: "button", class: "btn icon-only", "aria-label": "Fit the map", onclick: () => renderer.fit() }, icon("fit")));
  const stageStatus = h("div", { class: "stage-float stage-status", "aria-live": "off" });
  const layoutProgress = h("div", { class: "stage-float layout-progress", hidden: true, role: "status" });
  const demoBanner = h("div", { class: "stage-float demo-banner", hidden: true },
    h("span", null, "This is a demo map to explore."),
    h("button", { type: "button", class: "btn small primary", onclick: () => startBlank() }, "Start blank"),
    h("button", { type: "button", class: "btn small outline", onclick: () => { demoDismissed = true; renderDemo(); } }, "Keep it"));
  const emptyHint = h("div", { class: "stage-float empty-hint", hidden: true },
    h("strong", null, "An empty map"),
    h("span", { class: "muted" }, "Double-click the canvas to add an element, type “A -> B” in the bar below, or import a spreadsheet."),
    h("button", { type: "button", class: "btn small outline", onclick: () => { setPanel("data"); openPanel(); } }, icon("upload", 14), "Import…"));
  const stage = h("main", { class: "nm-stage" }, canvasHost, listHost, overlay, zoom, stageStatus, layoutProgress, demoBanner, emptyHint);

  // Right panel.
  const tabs = h("div", { class: "nm-tabs", role: "tablist", "aria-label": "Details" });
  const tabBody = h("div", { class: "nm-tab-body", role: "tabpanel" });
  /** @type {Record<string, HTMLElement>} */
  const tabButtons = {};
  for (const [id, label] of PANELS) {
    tabButtons[id] = h("button", { type: "button", class: "btn small", role: "tab", id: `nm-tab-${id}`, "aria-selected": String(id === app.panel), onclick: () => setPanel(id) }, label);
    tabs.appendChild(tabButtons[id]);
  }
  const panel = h("aside", { class: "nm-panel", "aria-label": "Details" }, tabs, tabBody);

  // Quick add.
  const quickInput = /** @type {HTMLInputElement} */ (h("input", { type: "text", placeholder: "Add: Farms -> Market, Shops", "aria-label": "Quick add elements and connections", onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === "Enter") { e.preventDefault(); quickAdd(); } } }));
  const quick = h("footer", { class: "nm-quickadd" }, quickInput,
    h("button", { type: "button", class: "btn small outline", onclick: () => quickAdd() }, "Add"),
    h("span", { class: "hint" }, "A -> B · A <-> B · A -- B · A -> B, C"));

  const shell = h("div", { class: "nm-app" }, topbar, rail, stage, panel, quick, live);
  clear(root).appendChild(shell);

  // --- Renderer ---------------------------------------------------------------------------------

  /** @type {Map<string, {x: number, y: number}>} transient positions of our own drag */
  let dragPreview = new Map();
  /** Set when WebGL is unavailable or lost: the map shows as a list, which keeps every edit. */
  let graphicsError = /** @type {string|null} */ (null);
  const rendererHandlers = {
    onClickNode: (id, e) => select([id], { add: e?.original?.shiftKey || e?.original?.ctrlKey || e?.original?.metaKey }),
    onClickEdge: (id, e) => select([id], { add: e?.original?.shiftKey }),
    onClickStage: () => { if (app.selection.size) select([]); },
    onDoubleClickStage: (p) => addElementAt(p),
    onDoubleClickNode: (id) => { select([id]); setPanel("profile"); openPanel(); emit("editLabel", id); },
    onDragStart: () => !layoutJob,
    onDrag: (id, p) => {
      dragPreview.set(id, p);
      store.setPresence({ drag: [{ id, x: p.x, y: p.y }] });
    },
    onDragEnd: (id, p) => {
      dragPreview.delete(id);
      store.setPresence({ drag: [] });
      store.apply([{ op: "move", layout: app.layoutKey, items: [{ id, x: Math.round(p.x), y: Math.round(p.y), pin: true }] }]);
    },
    onConnectEnd: (from, to, p) => {
      if (to) connect(from, to);
      else {
        const id = addElementAt(p, { connectFrom: from });
        if (id) announce("Added a connected element");
      }
    },
    onPointer: (/** @type {any} */ p) => store.setPresence({ cursor: p }),
    onCamera: () => { positionOverlay(); store.setPresence({ camera: renderer.getCamera() }); },
  };
  /** @type {ReturnType<typeof createRenderer>} */
  let renderer;
  try {
    renderer = createRenderer(canvasHost, /** @type {any} */ (rendererHandlers));
  } catch (e) {
    graphicsError = String(/** @type {any} */ (e)?.message ?? e);
    renderer = nullRenderer();
  }
  canvasHost.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    graphicsFailed("The graphics context was lost");
  }, true);
  app.renderer = renderer;

  /** @param {string} why */
  function graphicsFailed(why) {
    if (graphicsError && renderer.isNull) return;
    graphicsError = why;
    try { renderer.destroy(); } catch { /* already gone */ }
    renderer = nullRenderer();
    app.renderer = renderer;
    setMode("list");
    modeMap.setAttribute("aria-disabled", "true");
    modeMap.title = "The map canvas needs WebGL, which is unavailable here";
    showToast(`The map canvas is unavailable (${why}), so the map is shown as a list. Editing and saving still work.`, { timeout: 0 });
  }

  // --- Model and render ------------------------------------------------------------------------

  let modelQueued = false;
  let firstRender = true;
  function scheduleModel() {
    if (modelQueued) return;
    modelQueued = true;
    requestAnimationFrame(() => {
      modelQueued = false;
      rebuildModel();
    });
  }
  /** Milliseconds spent in each stage of the last rebuild (read by e2e/bench.mjs). */
  app.perf = { model: 0, sync: 0, rail: 0, panels: 0 };
  function rebuildModel() {
    if (!store.meta) return;
    let t = performance.now();
    const lap = (/** @type {"model"|"sync"|"rail"|"panels"} */ k) => { const n = performance.now(); app.perf[k] = n - t; t = n; };
    const model = computeModel(store, app.viewId);
    app.model = model;
    if (!app.viewId && model.view) app.viewId = model.view.id;
    // Keep our own drag where the pointer is while it lasts.
    for (const [id, p] of dragPreview) { const n = model.nodes.get(id); if (n) { n.x = p.x; n.y = p.y; } }
    lap("model");
    renderer.sync(model.nodes, model.edges);
    lap("sync");
    // Drop selected ids that no longer exist.
    const gone = [...app.selection].filter((id) => !store.objects.has(id));
    if (gone.length) { for (const id of gone) app.selection.delete(id); emit("selection"); }
    renderer.setSelection(app.selection);
    renderRail();
    renderStatus();
    renderDemo();
    if (firstRender && model.nodes.size) { firstRender = false; renderer.fit(); }
    lap("rail");
    emit("model");
    lap("panels");
  }

  // --- Store changes ----------------------------------------------------------------------------

  store.subscribe((change) => {
    switch (change.type) {
      case "snapshot":
      case "objects":
      case "positions":
        scheduleModel();
        break;
      case "meta":
        title.refresh();
        scheduleModel();
        break;
      case "status":
        renderConnection();
        break;
      case "presence":
        renderPeers();
        break;
      case "conflict":
        conflictToast(change);
        break;
      case "error":
        showToast(change.message);
        break;
    }
  });

  function renderConnection() {
    const s = statusText(/** @type {any} */ (store.status));
    connChip.dataset.state = store.status.connection;
    connChip.classList.toggle("conn-warn", s.warn);
    /** @type {HTMLElement} */ (connChip.querySelector(".conn-text")).textContent = s.label;
    connChip.title = s.detail;
    connChip.setAttribute("aria-label", s.detail);
  }

  /** @param {any} c */
  function conflictToast(c) {
    const fieldName = String(c.field).startsWith("fields.") ? (store.objects.get(String(c.field).slice(7))?.name ?? "a field") : c.field;
    const toast = showToast(`Someone else changed ${fieldName} of “${c.name ?? "an item"}” at the same time. Theirs was kept.`, { timeout: 15000 });
    const mine = c.mine;
    if (toast && typeof toast.appendChild === "function") {
      toast.insertBefore(h("button", {
        type: "button", class: "btn small",
        onclick: () => {
          const cur = store.objects.get(c.id);
          if (!cur) return;
          const patch = String(c.field).startsWith("fields.") ? { fields: { [String(c.field).slice(7)]: mine } } : { [c.field]: mine };
          store.apply([{ op: "update", id: c.id, baseVersion: cur.version, patch }]);
          toast.remove();
        },
      }, "Use mine"), toast.lastChild);
    }
  }

  // --- Presence ---------------------------------------------------------------------------------

  /** @type {string|null} */
  let following = null;
  /** Follows a peer's camera and view (null stops). @param {string|null} clientId */
  function follow(clientId) {
    following = clientId && store.peers.has(clientId) ? clientId : null;
    store.setPresence({ following });
    renderPeers();
  }
  app.follow = follow;
  Object.defineProperty(app, "following", { get: () => following, enumerable: true });
  function renderPeers() {
    clear(peersEl);
    const peers = [...store.peers.values()];
    const peerSel = new Set();
    for (const p of peers) {
      for (const id of p.selection ?? []) peerSel.add(id);
      const b = h("button", {
        type: "button", class: "btn icon-only", title: following === p.clientId ? `Following ${p.name}; click to stop` : `Follow ${p.name}`,
        "aria-pressed": String(following === p.clientId), "aria-label": `${p.name}${following === p.clientId ? " (following)" : ""}`,
        onclick: () => follow(following === p.clientId ? null : p.clientId),
      }, avatar(p.name, p.color));
      peersEl.appendChild(b);
      if (following === p.clientId && p.camera) renderer.setCamera(p.camera, true);
      if (following === p.clientId && p.viewId && p.viewId !== app.viewId) setView(p.viewId);
    }
    renderer.setPeerSelection(peerSel);
    // Peers' drags, transiently.
    const drags = peers.flatMap((p) => p.drag ?? []);
    if (drags.length) { renderer.setPositions(drags.map((d) => [d.id, d])); renderer.refresh(); }
    positionOverlay();
  }

  function positionOverlay() {
    clear(overlay);
    if (app.mode !== "map") return;
    for (const p of store.peers.values()) {
      if (!p.cursor || (p.viewId && p.viewId !== app.viewId)) continue;
      const v = renderer.graphToViewport(p.cursor);
      const color = p.color ?? "#e1632e";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", "16"); svg.setAttribute("height", "16"); svg.setAttribute("viewBox", "0 0 16 16");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M1 1l5 14 2-6 6-2z"); path.setAttribute("fill", color); path.setAttribute("stroke", "#fff");
      svg.appendChild(path);
      overlay.appendChild(h("div", { class: "peer-cursor", style: { left: `${v.x}px`, top: `${v.y}px` } }, svg,
        h("span", { class: "name", style: { background: color, color: textOn(color) } }, p.name)));
    }
  }

  // --- Selection --------------------------------------------------------------------------------

  /**
   * @param {Iterable<string>} ids @param {{add?: boolean, center?: boolean, announce?: boolean}} [opts]
   */
  function select(ids, opts = {}) {
    const list = [...ids].filter((id) => store.objects.has(id));
    if (opts.add) for (const id of list) { if (app.selection.has(id)) app.selection.delete(id); else app.selection.add(id); }
    else app.selection = new Set(list);
    renderer.setSelection(app.selection);
    store.setPresence({ selection: [...app.selection].slice(0, 200) });
    if (opts.center && list.length === 1) centerOn(list[0]);
    if (opts.announce !== false && app.selection.size === 1) {
      const [only] = app.selection;
      announce(describe(only));
    } else if (opts.announce !== false && app.selection.size > 1) announce(`${app.selection.size} selected`);
    emit("selection");
  }

  /** @param {string} id */
  function describe(id) {
    const o = store.objects.get(id);
    if (!o) return "";
    if (o.id[0] === "e") {
      const t = o.typeId ? store.objects.get(o.typeId)?.name : "untyped";
      const d = app.model?.index.degrees.get(id)?.degree ?? 0;
      const hidden = app.model && !app.model.nodes.has(id) ? ", hidden in this view" : "";
      return `${o.label}, ${t}, ${d} connection${d === 1 ? "" : "s"}${hidden}`;
    }
    if (o.id[0] === "c") {
      const a = store.objects.get(o.from)?.label ?? "?", b = store.objects.get(o.to)?.label ?? "?";
      return `Connection from ${a} to ${b}${o.label ? `, ${o.label}` : ""}`;
    }
    return o.label ?? o.name ?? "";
  }

  /** @param {string} id */
  function centerOn(id) {
    if (app.mode !== "map") return;
    renderer.focusNode(id);
  }

  // --- Views ------------------------------------------------------------------------------------

  /** @param {string} id */
  function setView(id) {
    if (!store.objects.has(id) || id === app.viewId) return;
    app.viewId = id;
    viewPicker.value = id;
    store.setPresence({ viewId: id });
    rebuildModel();
    emit("view");
  }

  function newView() {
    const id = app.newId("view");
    const base = app.view;
    const n = orderedViews(app.model?.views ?? new Map()).length + 1;
    store.apply([{ op: "create", object: { id, name: `View ${n}`, rules: base ? structuredClone(base.rules) : [], layout: { kind: "force", own: false }, order: n } }]);
    requestAnimationFrame(() => { setView(id); setPanel("design"); openPanel(); });
  }

  function renderRail() {
    const model = app.model;
    if (!model) return;
    const views = orderedViews(model.views);
    // View picker and list.
    clear(viewPicker);
    for (const v of views) viewPicker.appendChild(h("option", { value: v.id }, v.name + (v.id === store.meta?.defaultViewId ? " (default)" : "")));
    viewPicker.value = model.view?.id ?? "";
    clear(viewList);
    for (const v of views) {
      viewList.appendChild(h("button", {
        type: "button", class: "btn small", role: "listitem", "aria-current": String(v.id === model.view?.id), "aria-pressed": String(v.id === model.view?.id),
        onclick: () => setView(v.id),
      }, v.name, v.id === store.meta?.defaultViewId ? h("span", { class: "muted" }, " ★") : null));
    }
    // Focus controls.
    clear(focusEl);
    const focus = model.view?.focus;
    if (focus) {
      focusEl.appendChild(h("span", { class: "muted" }, `${focus.roots.length} root${focus.roots.length === 1 ? "" : "s"}, ${focus.depth} step${focus.depth === 1 ? "" : "s"}`));
      focusEl.appendChild(h("button", { type: "button", class: "btn small outline", onclick: () => setFocus(null) }, "Clear focus"));
    } else {
      const roots = [...app.selection].filter((id) => id[0] === "e");
      focusEl.appendChild(h("button", {
        type: "button", class: "btn small outline", disabled: !roots.length,
        title: roots.length ? "Show only what is near the selection" : "Select elements first",
        onclick: () => setFocus({ roots, depth: 1, direction: "both" }),
      }, "Focus on selection"));
    }
    // Legend.
    clear(legendEl);
    if (!model.decor.legend.length) legendEl.appendChild(h("span", { class: "muted" }, "Types and rules appear here."));
    for (const entry of model.decor.legend.slice(0, 60)) {
      const swatch = h("span", { class: "swatch-dot", style: { background: entry.color ?? "transparent", borderRadius: entry.shape && entry.shape !== "circle" ? "2px" : "50%" } });
      legendEl.appendChild(h("button", {
        type: "button", class: "btn small", disabled: !entry.selector,
        title: entry.selector ? `Select ${describeSelector(entry.selector, model.index)}` : entry.label,
        onclick: () => selectMatching(entry.selector),
      }, swatch, entry.label));
    }
  }

  /** @param {any} selector */
  async function selectMatching(selector) {
    if (!selector || !app.model) return;
    const { compileSelector } = await import("../../shared/rules.js");
    const test = compileSelector(selector, app.model.index);
    const pool = selector.target === "element" ? app.model.index.elements : app.model.index.connections;
    const ids = [...pool.values()].filter(test).map((o) => o.id);
    select(ids);
  }

  /** @param {any} focus */
  function setFocus(focus) {
    const v = app.view;
    if (!v) return;
    store.apply([{ op: "update", id: v.id, baseVersion: v.version, patch: { focus } }]);
  }

  function runSearch() {
    clear(searchResults);
    const q = normalizeLabel(searchInput.value);
    if (!q || !app.model) return;
    let n = 0;
    for (const e of app.model.index.elements.values()) {
      if (!normalizeLabel(e.label).includes(q) && !(e.aliases ?? []).some((/** @type {string} */ a) => normalizeLabel(a).includes(q))) continue;
      searchResults.appendChild(h("button", { type: "button", class: "btn small", role: "listitem", onclick: () => { select([e.id], { center: true }); setPanel("profile"); } }, e.label));
      if (++n >= 50) break;
    }
    if (!n) searchResults.appendChild(h("span", { class: "muted" }, "No matches"));
  }

  function renderStatus() {
    const m = app.model;
    if (!m) return;
    const hidden = m.index.elements.size - m.nodes.size;
    stageStatus.textContent = `${m.nodes.size} elements · ${m.edges.size} connections${hidden ? ` · ${hidden} hidden by this view` : ""}`;
    emptyHint.hidden = m.index.elements.size > 0 || app.mode !== "map";
    stageStatus.hidden = app.mode !== "map";
  }

  // --- Panels -----------------------------------------------------------------------------------

  /** @type {{destroy?: () => void}|null} */
  let mounted = null;
  /** @param {string} name */
  function setPanel(name) {
    if (!PANELS.some(([id]) => id === name)) return;
    const changed = name !== app.panel || !mounted;
    app.panel = name;
    for (const [id] of PANELS) tabButtons[id].setAttribute("aria-selected", String(id === name));
    tabBody.setAttribute("aria-labelledby", `nm-tab-${name}`);
    if (changed) {
      try { mounted?.destroy?.(); } catch (e) { console.error(e); }
      clear(tabBody);
      const mount = { profile: mountProfile, design: mountDesign, data: mountData, activity: mountActivity }[/** @type {"profile"} */ (name)];
      mounted = mount(tabBody, app);
    }
    emit("panel");
  }
  // On narrow screens the rail and the panel are sheets over the canvas: closed at first, and
  // opening one closes the other.
  const narrow = window.matchMedia?.("(max-width: 760px)");
  function syncToggles() {
    railToggle.setAttribute("aria-pressed", String(!shell.classList.contains("rail-closed")));
    panelToggle.setAttribute("aria-pressed", String(!shell.classList.contains("panel-closed")));
  }
  function openPanel() {
    shell.classList.remove("panel-closed");
    if (narrow?.matches) shell.classList.add("rail-closed");
    syncToggles();
  }
  function togglePanel() {
    if (shell.classList.contains("panel-closed")) openPanel();
    else { shell.classList.add("panel-closed"); syncToggles(); }
  }
  function toggleRail() {
    const opening = shell.classList.contains("rail-closed");
    shell.classList.toggle("rail-closed");
    if (opening && narrow?.matches) shell.classList.add("panel-closed");
    syncToggles();
  }
  const applyNarrow = () => {
    if (narrow?.matches) shell.classList.add("rail-closed", "panel-closed");
    else shell.classList.remove("rail-closed", "panel-closed");
    syncToggles();
  };
  narrow?.addEventListener?.("change", applyNarrow);

  /** @type {{destroy?: () => void}|null} */
  let listMounted = null;
  /** @param {"map"|"list"} mode */
  function setMode(mode) {
    if (mode === "map" && graphicsError) { showToast("The map canvas is unavailable here; the list shows everything."); return; }
    app.mode = mode;
    modeMap.setAttribute("aria-pressed", String(mode === "map"));
    modeList.setAttribute("aria-pressed", String(mode === "list"));
    listHost.hidden = mode !== "list";
    canvasHost.hidden = mode !== "map";
    zoom.hidden = mode !== "map";
    if (mode === "list" && !listMounted) listMounted = mountList(listHost, app);
    if (mode === "map") { renderer.refresh(); positionOverlay(); }
    renderStatus();
    renderDemo();
    emit("mode");
  }

  // --- Editing ----------------------------------------------------------------------------------

  /**
   * Adds an element at a graph position and puts its label in edit mode.
   * @param {{x: number, y: number}} p @param {{connectFrom?: string, label?: string}} [opts]
   */
  function addElementAt(p, opts = {}) {
    const id = app.newId("element");
    const typeId = defaultTypeFor("element");
    /** @type {any[]} */
    const ops = [
      { op: "create", object: { id, label: opts.label ?? "New element", ...(typeId ? { typeId } : {}) } },
      { op: "move", layout: app.layoutKey, items: [{ id, x: Math.round(p.x), y: Math.round(p.y), pin: true }] },
    ];
    if (opts.connectFrom) ops.push({ op: "create", object: { id: app.newId("connection"), from: opts.connectFrom, to: id, direction: "directed" } });
    store.apply(ops);
    requestAnimationFrame(() => {
      select([id]);
      setPanel("profile");
      openPanel();
      emit("editLabel", id);
    });
    return id;
  }

  /** @param {"element"|"connection"} kind */
  function defaultTypeFor(kind) {
    // The type of the selected element, when adding next to it; else untyped.
    const [first] = app.selection;
    const o = first ? store.objects.get(first) : null;
    return kind === "element" && o?.id[0] === "e" ? o.typeId ?? null : null;
  }

  /** @param {string} from @param {string} to */
  function connect(from, to) {
    const id = app.newId("connection");
    store.apply([{ op: "create", object: { id, from, to, direction: "directed" } }]);
    requestAnimationFrame(() => select([id]));
    announce(`Connected ${store.objects.get(from)?.label ?? ""} to ${store.objects.get(to)?.label ?? ""}`);
  }

  function deleteSelection() {
    const ids = [...app.selection].filter((id) => store.objects.has(id));
    if (!ids.length) return;
    // Loops, then connections, then elements: the server cascades anyway.
    ids.sort((a, b) => "lcevtf".indexOf(a[0]) - "lcevtf".indexOf(b[0]));
    const elementIds = new Set(ids.filter((id) => id[0] === "e"));
    const ops = ids
      .filter((id) => !(id[0] === "c" && (elementIds.has(store.objects.get(id)?.from) || elementIds.has(store.objects.get(id)?.to))))
      .filter((id) => "lce".includes(id[0]))
      .map((id) => ({ op: "delete", id, baseVersion: store.objects.get(id).version }));
    if (!ops.length) return;
    for (let i = 0; i < ops.length; i += 1000) store.apply(ops.slice(i, i + 1000));
    select([]);
    announce(`Deleted ${ops.length} item${ops.length === 1 ? "" : "s"}`);
  }

  function quickAdd() {
    const { elements, connections, problems } = parseQuickAdd(quickInput.value);
    if (problems.length) showToast(problems[0]);
    if (!elements.length) return;
    /** @type {Map<string, string>} normalised label -> element id */
    const ids = new Map();
    /** @type {any[]} */
    const ops = [];
    const created = [];
    for (const label of elements) {
      const key = normalizeLabel(label);
      const matches = [...store.objects.values()].filter((o) => o.id[0] === "e" && (normalizeLabel(o.label) === key || (o.aliases ?? []).some((/** @type {string} */ a) => normalizeLabel(a) === key)));
      if (matches.length === 1) { ids.set(key, matches[0].id); continue; }
      const id = app.newId("element");
      ids.set(key, id);
      created.push(id);
      ops.push({ op: "create", object: { id, label } });
    }
    for (const c of connections) {
      const from = ids.get(normalizeLabel(c.from)), to = ids.get(normalizeLabel(c.to));
      if (!from || !to) continue;
      ops.push({ op: "create", object: { id: app.newId("connection"), from, to, direction: c.direction, ...(c.label ? { label: c.label } : {}) } });
    }
    store.apply(ops);
    quickInput.value = "";
    announce(`Added ${created.length} element${created.length === 1 ? "" : "s"} and ${connections.length} connection${connections.length === 1 ? "" : "s"}`);
    requestAnimationFrame(() => select(created.length ? created : [], { announce: false }));
  }

  // --- Layout jobs -------------------------------------------------------------------------------

  /** @type {{stop: () => void}|null} */
  let layoutJob = null;
  /** @param {"force"|"circle"|"grid"} kind */
  function runLayout(kind) {
    const model = app.model;
    if (!model || layoutJob) return;
    const layout = model.layout;
    const ids = [...model.nodes.keys()];
    if (!ids.length) return;
    const pos = store.positions.get(layout) ?? new Map();
    // Base versions now: a node moved, pinned or deleted meanwhile is skipped on commit.
    const bases = new Map(ids.map((id) => [id, pos.get(id)?.v ?? 0]));
    if (kind !== "force") {
      const order = [...ids].sort((a, b) => {
        const ea = model.index.elements.get(a), eb = model.index.elements.get(b);
        return String(ea?.typeId ?? "").localeCompare(String(eb?.typeId ?? "")) || String(ea?.label).localeCompare(String(eb?.label));
      });
      const placed = kind === "circle" ? circleLayout(order) : gridLayout(order);
      commitPositions(layout, placed, bases, { unpin: true });
      requestAnimationFrame(() => renderer.fit());
      return;
    }
    const index = new Map(ids.map((id, i) => [id, i]));
    const x = new Float64Array(ids.length), y = new Float64Array(ids.length), pinned = new Uint8Array(ids.length);
    ids.forEach((id, i) => { const n = /** @type {any} */ (model.nodes.get(id)); x[i] = n.x; y[i] = n.y; pinned[i] = pos.get(id)?.pin ? 1 : 0; });
    const edges = [...model.edges.values()].filter((e) => e.from !== e.to);
    const from = new Uint32Array(edges.length), to = new Uint32Array(edges.length);
    edges.forEach((e, i) => { from[i] = /** @type {number} */ (index.get(e.from)); to[i] = /** @type {number} */ (index.get(e.to)); });
    const stopBtn = h("button", { type: "button", class: "btn small outline", onclick: () => layoutJob?.stop() }, icon("stop", 14), "Stop and keep");
    const label = h("span", null, "Laying out…");
    clear(layoutProgress).append(label, stopBtn);
    layoutProgress.hidden = false;
    announce("Running the force layout");
    let finished = false;
    layoutJob = runForceLayout({
      x, y, pinned, from, to,
      onTick: (xs, ys, progress) => {
        label.textContent = `Laying out… ${Math.round(progress * 100)}%`;
        renderer.setPositions(ids.map((id, i) => [id, { x: xs[i], y: ys[i] }]));
        renderer.refresh();
      },
      onDone: (result) => {
        if (finished) return;
        finished = true;
        layoutJob = null;
        layoutProgress.hidden = true;
        if (result.error) { showToast(result.error); scheduleModel(); return; }
        const placed = new Map(ids.map((id, i) => [id, { x: x[i], y: y[i] }]));
        for (const [id] of placed) if (pinned[index.get(id) ?? 0]) placed.delete(id);
        commitPositions(layout, placed, bases, { unpin: false });
        announce("Layout finished");
      },
    });
  }

  /**
   * Commits positions in chunks, fenced by the versions seen when the job started.
   * @param {string} layout @param {Map<string, {x: number, y: number}>} placed @param {Map<string, number>} bases
   * @param {{unpin: boolean}} opts
   */
  function commitPositions(layout, placed, bases, { unpin }) {
    const items = [...placed].map(([id, p]) => ({ id, x: Math.round(p.x), y: Math.round(p.y), base: bases.get(id) ?? 0, ...(unpin ? { pin: false } : {}) }));
    for (let i = 0; i < items.length; i += MOVE_CHUNK) store.apply([{ op: "move", layout, items: items.slice(i, i + MOVE_CHUNK) }]);
  }

  function unpinAll() {
    const layout = app.layoutKey;
    const pos = store.positions.get(layout);
    if (!pos) return;
    const items = [...pos].filter(([, p]) => p.pin).map(([id, p]) => ({ id, x: p.x, y: p.y, pin: false }));
    for (let i = 0; i < items.length; i += MOVE_CHUNK) store.apply([{ op: "move", layout, items: items.slice(i, i + MOVE_CHUNK) }]);
    announce(`Unpinned ${items.length} element${items.length === 1 ? "" : "s"}`);
  }

  // --- Demo and blank start ------------------------------------------------------------------------

  let demoDismissed = false;
  function renderDemo() {
    demoBanner.hidden = !(store.meta?.demo && !demoDismissed) || app.mode !== "map";
  }

  async function startBlank() {
    const ok = await confirmDialog("Start blank?", "This deletes the demo elements, connections, loops, views, types and fields. You can undo it from the Activity tab.", "Delete the demo");
    if (!ok) return;
    const all = [...store.objects.values()];
    const del = (/** @type {string} */ k) => all.filter((o) => o.id[0] === k).map((o) => ({ op: "delete", id: o.id, baseVersion: o.version }));
    const defaultView = store.objects.get(store.meta?.defaultViewId);
    store.apply([...del("l"), ...del("e")]);
    store.apply([...del("v").filter((op) => op.id !== defaultView?.id), ...del("t"), ...del("f"),
      ...(defaultView ? [{ op: "update", id: defaultView.id, baseVersion: defaultView.version, patch: { name: DEFAULT_VIEW_NAME, rules: [], filter: null, showcase: null, focus: null } }] : [])],
    { structure: { title: DEFAULT_TITLE } });
    demoDismissed = true;
    renderDemo();
    select([]);
  }

  /** @param {string} heading @param {string} body @param {string} action */
  function confirmDialog(heading, body, action) {
    return /** @type {Promise<boolean>} */ (modal((close) => h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": heading },
      h("h2", null, heading), h("p", null, body),
      h("div", { class: "modal-actions" },
        h("button", { type: "button", class: "btn outline", onclick: () => close(false) }, "Cancel"),
        h("button", { type: "button", class: "btn primary", "data-autofocus": true, onclick: () => close(true) }, action))), false));
  }

  // --- Export image and help -------------------------------------------------------------------------

  function exportImage() {
    if (app.mode !== "map") setMode("map");
    const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    const url = renderer.exportPng(dark ? "#171a21" : "#fbfbfa");
    if (!url) { showToast("Could not capture the canvas"); return; }
    const name = `${(store.meta?.title || "map").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60) || "map"}.png`;
    modal((close) => h("div", { class: "modal wide", role: "dialog", "aria-modal": "true", "aria-label": "Map image" },
      h("h2", null, "Map image"),
      h("p", null, "This is the visible part of the map. Right-click the image to copy or save it; the Download button may be blocked inside the gadget frame. For data (backup, Kumu JSON, CSV, GraphML), use the gadget's Export menu."),
      h("img", { src: url, alt: `Image of the map ${store.meta?.title ?? ""}`, style: { maxWidth: "100%", border: "1px solid var(--border)", borderRadius: "8px" } }),
      h("div", { class: "modal-actions" },
        h("a", { class: "btn outline", href: url, download: name }, icon("download", 14), "Download"),
        h("button", { type: "button", class: "btn primary", "data-autofocus": true, onclick: () => close(null) }, "Close"))), null);
  }

  function showHelp() {
    const rows = [
      ["Double-click canvas", "Add an element"], ["Double-click element", "Rename it"], ["Shift+drag from an element", "Draw a connection"],
      ["Drag an element", "Move and pin it"], ["Enter", "Add an element connected to the selection"], ["Arrow keys", "Move to the nearest element"],
      ["[ and ]", "Step through the selection's neighbours"], ["Delete", "Delete the selection"], ["Ctrl+Z / Ctrl+Shift+Z", "Undo / redo your changes"],
      ["/", "Find an element"], ["Escape", "Clear the selection"],
    ];
    modal((close) => h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": "Help" },
      h("h2", null, "Network map help"),
      h("table", { class: "grid-table" }, h("tbody", null, rows.map(([k, v]) => h("tr", null, h("td", null, h("strong", null, k)), h("td", null, v))))),
      h("p", null, "Quick add: type “Farms -> Market, Shops” in the bar at the bottom. Use -> for a direction, <-> for mutual and -- for undirected; add a label with -[label]->."),
      h("div", { class: "modal-actions" }, h("button", { type: "button", class: "btn primary", "data-autofocus": true, onclick: () => close(null) }, "Close"))), null);
  }

  // --- Keyboard ---------------------------------------------------------------------------------------

  /** @type {string|null} */
  let neighbourCursor = null;
  canvasHost.addEventListener("keydown", (e) => {
    const [first] = app.selection;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) store.redo(); else store.undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); store.redo(); return; }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelection(); return; }
    if (e.key === "Escape") { select([]); return; }
    if (e.key === "/") { e.preventDefault(); searchInput.focus(); return; }
    if (e.key === "Enter" && first?.[0] === "e") {
      e.preventDefault();
      const n = app.model?.nodes.get(first);
      addElementAt({ x: (n?.x ?? 0) + 80, y: (n?.y ?? 0) + 40 }, { connectFrom: first });
      return;
    }
    if (e.key.startsWith("Arrow")) { e.preventDefault(); moveFocus(e.key); return; }
    if ((e.key === "[" || e.key === "]") && first?.[0] === "e") { e.preventDefault(); stepNeighbour(first, e.key === "]" ? 1 : -1); }
  });
  document.addEventListener("keydown", (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    if (t === canvasHost || canvasHost.contains(t)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) store.redo(); else store.undo(); }
  });

  /** @param {string} key */
  function moveFocus(key) {
    const m = app.model;
    if (!m || !m.nodes.size) return;
    const [first] = app.selection;
    const cur = first ? m.nodes.get(first) : null;
    if (!cur) { const id = m.nodes.keys().next().value; if (id) select([id], { center: true }); return; }
    const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[key] ?? [0, 0];
    let best = null, bestScore = Infinity;
    for (const [id, n] of m.nodes) {
      if (id === first) continue;
      const dx = n.x - cur.x, dy = n.y - cur.y;
      const along = dx * dir[0] + dy * dir[1];
      if (along <= 0) continue;
      const across = Math.abs(dx * dir[1] - dy * dir[0]);
      const score = along + across * 2;
      if (score < bestScore) { bestScore = score; best = id; }
    }
    if (best) select([best], { center: true });
  }

  /** @param {string} id @param {number} step */
  function stepNeighbour(id, step) {
    const m = app.model;
    if (!m) return;
    const around = neighbourhood(m.index, [id], 1, "both");
    around.delete(id);
    const list = [...around].filter((x) => m.nodes.has(x)).sort((a, b) => String(m.index.elements.get(a)?.label).localeCompare(String(m.index.elements.get(b)?.label)));
    if (!list.length) { announce("No neighbours"); return; }
    const at = neighbourCursor ? list.indexOf(neighbourCursor) : -1;
    const next = list[(at + step + list.length) % list.length];
    neighbourCursor = next;
    select([next], { center: true });
  }

  // --- Start ----------------------------------------------------------------------------------------

  renderConnection();
  applyNarrow();
  setPanel("profile");
  if (graphicsError) { const why = graphicsError; graphicsError = null; graphicsFailed(why); }
  window.addEventListener("resize", () => positionOverlay());
  return app;
}

/** A renderer that draws nothing, for when WebGL is unavailable. */
function nullRenderer() {
  const noop = () => {};
  return /** @type {any} */ ({
    isNull: true, graph: null, sigma: null, sync: noop, setPositions: noop, refresh: noop, setSelection: noop, setPeerSelection: noop,
    getCamera: () => ({ x: 0.5, y: 0.5, ratio: 1, angle: 0 }), setCamera: noop, fit: noop, zoomIn: noop, zoomOut: noop, focusNode: noop,
    viewportToGraph: (/** @type {any} */ p) => p, graphToViewport: (/** @type {any} */ p) => p, nodeAt: () => null, exportPng: () => null, destroy: noop,
  });
}

export { PALETTE };
