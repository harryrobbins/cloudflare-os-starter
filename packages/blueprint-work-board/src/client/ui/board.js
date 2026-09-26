// @ts-check
// The board layout: sticky column headers, optional swimlanes with sticky headers, cells of cards.
// Rendering is keyed (focus, scroll and DOM identity survive updates); cells with many cards are
// windowed (uniform card heights make that exact). Navigation is a roving tabindex driven by the
// projection, not the DOM, so it works across windowed cells. Every drag has two non-drag
// equivalents: the card's Move menu and keyboard move mode (Shift+arrows).

import { h, reconcile, setText, focus as focusEl, domId, setChildren } from "./dom.js";
import { icon, stateIcon, priorityIcon } from "./icons.js";
import { avatar, createCard, updateCard } from "./card.js";
import { SINGLE_LANE } from "../board/projection.js";

export const CARD_H = { comfortable: 104, compact: 80 };
export const GAP = 6;
const WINDOW_MIN = 100;
const OVERSCAN = 6;
/** Above this many cards on the board, every cell is windowed (lanes multiply cells). */
const BIG_BOARD = 300;
const INITIAL_WINDOW = 12;

/**
 * @typedef {import("../board/projection.js").Projection} Projection
 * @typedef {import("../board/projection.js").Entry} Entry
 * @typedef {import("../board/projection.js").Lane} Lane
 * @typedef {import("./card.js").CardEnv} CardEnv
 * @typedef {{ key: string, lane: string, col: string }} FocusPos
 * @typedef {{
 *   projection: Projection, env: CardEnv, focus: FocusPos|null, collapsedCols: Set<string>, collapsedLanes: Set<string>,
 *   canWrite: boolean, manualOrder: boolean, label: string, emptyText: string, today: string,
 * }} BoardModel
 * @typedef {(type: string, payload?: any) => void} OnAction
 */

/** @param {{ doc: Document, onAction: OnAction }} opts */
export function createBoardView({ doc, onAction }) {
  const grid = h("div", { class: "board-grid" });
  const headers = h("div", { class: "col-headers" });
  const lanesEl = h("div", { class: "lanes" });
  grid.append(headers, lanesEl);
  const scroller = h("div", { class: "board-scroll", role: "region", tabindex: "-1", "aria-describedby": "wb-board-help" }, grid);
  const help = h("p", { id: "wb-board-help", class: "sr-only" },
    "Arrow keys move between cards and columns. Enter opens, Space peeks, X selects, M opens the Move menu, Shift with arrows moves the card.");
  const el = h("div", { class: "board-view" }, help, scroller);

  /** @type {BoardModel|null} */
  let model = null;
  /** @type {Map<string, { start: number, end: number }>} */
  const windows = new Map();
  /** @type {null | { entry: Entry, fromLane: string, fromCol: string, toLane: string, toCol: string, index: number }} */
  let moving = null;
  let scrollRaf = 0;
  let bigBoard = false;

  // -------------------------------------------------------------------------------------------
  // Rendering

  /** @param {BoardModel} next */
  function update(next) {
    model = next;
    const { projection, collapsedCols } = next;
    const pitch = CARD_H[/** @type {"comfortable"|"compact"} */ (next.env.density)] ?? CARD_H.comfortable;
    grid.style.setProperty("--card-h", `${pitch}px`);
    grid.style.setProperty("--card-gap", `${GAP}px`);
    grid.style.gridTemplateColumns = "";
    const template = projection.columns.map((c) => (collapsedCols.has(c.group.key) ? "var(--col-collapsed)" : "var(--col-w)")).join(" ");
    grid.style.setProperty("--cols", template || "1fr");
    scroller.setAttribute("aria-label", next.label);
    grid.classList.toggle("has-lanes", Boolean(projection.swimlanesBy));

    reconcile(headers, projection.columns, {
      key: (c) => c.group.key,
      create: () => h("div", { class: "col-head" }),
      update: (node, c) => renderColumnHead(/** @type {HTMLElement} */ (node), c),
    });
    const lanes = projection.lanes;
    let total = 0;
    for (const l of lanes) for (const c of l.cells.values()) total += c.length;
    bigBoard = total > BIG_BOARD;
    reconcile(lanesEl, lanes, {
      key: (l) => l.key,
      create: (l) => {
        const section = h("section", { class: "lane" });
        if (l.group) section.append(h("div", { class: "lane-head" }));
        section.append(h("div", { class: "lane-cells" }));
        return section;
      },
      update: (node, l) => renderLane(/** @type {HTMLElement} */ (node), l),
    });
    if (!projection.total && !projection.lanes.some((l) => [...l.cells.values()].some((c) => c.length))) {
      scroller.dataset.empty = "true";
    } else delete scroller.dataset.empty;
    // Second pass: every windowed cell's height is already exact (spacers + cards), so one batch of
    // layout reads places all of them, then only the slices that changed are rendered.
    refreshWindows();
  }

  /** @param {HTMLElement} node @param {import("../board/projection.js").ColumnInfo} c */
  function renderColumnHead(node, c) {
    if (!model) return;
    const collapsed = model.collapsedCols.has(c.group.key);
    const id = `col-${domId(c.group.key)}`;
    const sig = [c.group.key, c.group.label, c.count, c.estimate, c.wip?.limit ?? "", c.wip?.over ? 1 : 0, collapsed ? 1 : 0, model.canWrite ? 1 : 0, c.group.color ?? ""].join("|");
    node.classList.toggle("collapsed", collapsed);
    node.classList.toggle("over-wip", Boolean(c.wip?.over));
    node.dataset.col = c.group.key;
    if (node.dataset.sig === sig) return;
    node.dataset.sig = sig;
    const count = c.wip ? `${c.count} / ${c.wip.limit}` : String(c.count);
    const countLabel = c.wip ? `${c.count} items, WIP limit ${c.wip.limit}${c.wip.over ? ", over the limit" : ""}` : `${c.count} ${c.count === 1 ? "item" : "items"}`;
    setChildren(node, 
      h("h2", { class: "col-title", id },
        h("span", { class: "col-icon", "aria-hidden": "true" }, groupIcon(c.group)),
        h("span", { class: "col-name" }, c.group.label),
        h("span", { class: "sr-only" }, `, ${countLabel}${c.estimate ? `, ${c.estimate} points` : ""}`)),
      h("span", { class: `col-count${c.wip?.over ? " over" : ""}`, "aria-hidden": "true", title: c.wip ? `WIP limit ${c.wip.limit}` : undefined }, count),
      c.estimate && !collapsed ? h("span", { class: "col-est", "aria-hidden": "true", title: "Estimate total" }, `${c.estimate} pts`) : null,
      h("span", { class: "grow" }),
      model.canWrite && !collapsed ? h("button", { type: "button", class: "icon-btn sm", "aria-label": `New item in ${c.group.label}`, title: "New item here (C)", onclick: () => onAction("create", { col: c.group.key, lane: firstLane() }) }, icon("plus")) : null,
      h("button", { type: "button", class: "icon-btn sm", "aria-expanded": String(!collapsed), "aria-label": `${collapsed ? "Expand" : "Collapse"} ${c.group.label}`, title: collapsed ? "Expand column" : "Collapse column", onclick: () => onAction("toggleColumn", c.group.key) }, icon(collapsed ? "expand" : "collapse")),
    );
  }

  function firstLane() { return model?.projection.lanes[0]?.key ?? SINGLE_LANE; }

  /** @param {import("../../shared/model/properties.js").Group} g */
  function groupIcon(g) {
    if (g.stateKind) return stateIcon(g.stateKind, g.color ?? "#8a8f98");
    if (g.priority !== undefined) return priorityIcon(g.priority);
    if (g.person) return model ? avatar(g.person, model.env.index, 18) : null;
    if (g.color) return h("span", { class: "dot lg", style: { background: g.color } });
    return null;
  }

  /** @param {HTMLElement} section @param {Lane} lane */
  function renderLane(section, lane) {
    if (!model) return;
    const m = model;
    const collapsed = lane.group ? m.collapsedLanes.has(lane.key) : false;
    section.dataset.lane = lane.key;
    const headId = `lane-${domId(lane.key)}`;
    if (lane.group) {
      section.setAttribute("aria-labelledby", headId);
      const head = /** @type {HTMLElement} */ (section.querySelector(".lane-head"));
      const sig = [lane.key, lane.group.label, lane.count, lane.estimate, collapsed ? 1 : 0].join("|");
      if (head.dataset.sig !== sig) {
        head.dataset.sig = sig;
        setChildren(head, h("div", { class: "lane-head-inner" },
          h("h2", { class: "lane-title", id: headId },
            h("button", { type: "button", class: "lane-toggle", "aria-expanded": String(!collapsed), onclick: () => onAction("toggleLane", lane.key) },
              h("span", { class: "chev", "aria-hidden": "true" }, icon(collapsed ? "chevronRight" : "chevronDown")),
              h("span", { class: "lane-icon", "aria-hidden": "true" }, groupIcon(lane.group)),
              h("span", { class: "lane-name" }, lane.group.label),
              h("span", { class: "lane-count" }, `${lane.count}`),
              h("span", { class: "sr-only" }, ` ${lane.count === 1 ? "item" : "items"}${lane.estimate ? `, ${lane.estimate} points` : ""}`),
              lane.estimate ? h("span", { class: "lane-est", "aria-hidden": "true" }, `${lane.estimate} pts`) : null))));
      }
    } else section.removeAttribute("aria-labelledby");
    section.classList.toggle("collapsed", collapsed);
    const cellsEl = /** @type {HTMLElement} */ (section.querySelector(".lane-cells"));
    cellsEl.hidden = collapsed;
    if (collapsed) return;
    reconcile(cellsEl, m.projection.columns, {
      key: (c) => c.group.key,
      create: () => h("ul", { class: "cell", role: "list" }),
      update: (node, c) => renderCell(/** @type {HTMLElement} */ (node), lane, c.group.key, c.group.label),
    });
  }

  /** @param {HTMLElement} ul @param {Lane} lane @param {string} col @param {string} colLabel */
  function renderCell(ul, lane, col, colLabel) {
    if (!model) return;
    const m = model;
    const entries = lane.cells.get(col) ?? [];
    const collapsed = m.collapsedCols.has(col);
    ul.dataset.col = col;
    ul.dataset.lane = lane.key;
    const count = entries.filter((e) => e.kind === "card").length;
    ul.setAttribute("aria-label", `${colLabel}${lane.group ? `, ${lane.group.label}` : ""}: ${count} ${count === 1 ? "item" : "items"}`);
    ul.classList.toggle("collapsed", collapsed);
    if (collapsed) {
      reconcile(ul, [], { key: () => "", create: () => h("li") });
      ul.setAttribute("aria-hidden", "true");
      return;
    }
    ul.removeAttribute("aria-hidden");
    const cellKey = `${lane.key}::${col}`;
    let slice = entries;
    let top = 0, bottom = 0;
    const pitch = pitchOf(m);
    if (bigBoard || entries.length > WINDOW_MIN) {
      const n = entries.length;
      // New cells of a big board start empty; refreshWindows() fills the visible ones right after.
      const prev = windows.get(cellKey) ?? { start: 0, end: bigBoard ? 0 : Math.min(n, INITIAL_WINDOW) };
      const w = { start: Math.min(prev.start, n), end: Math.min(Math.max(prev.end, prev.start), n) };
      windows.set(cellKey, w);
      slice = entries.slice(w.start, w.end);
      top = w.start * pitch;
      bottom = (n - w.end) * pitch;
      ul.classList.add("windowed");
    } else {
      windows.delete(cellKey);
      ul.classList.remove("windowed");
    }
    let topSpacer = /** @type {HTMLElement|null} */ (ul.querySelector(":scope > li.spacer.top"));
    let bottomSpacer = /** @type {HTMLElement|null} */ (ul.querySelector(":scope > li.spacer.bottom"));
    if (!topSpacer) { topSpacer = h("li", { class: "spacer top", "aria-hidden": "true" }); ul.prepend(topSpacer); }
    if (!bottomSpacer) { bottomSpacer = h("li", { class: "spacer bottom", "aria-hidden": "true" }); ul.append(bottomSpacer); }
    topSpacer.style.height = `${top}px`;
    bottomSpacer.style.height = `${bottom}px`;
    const focusKey = m.focus && m.focus.lane === lane.key && m.focus.col === col ? m.focus.key : null;
    /** @type {(Entry | { kind: "empty", key: string } | { kind: "drop", key: string })[]} */
    const rows = [...slice];
    if (!entries.length) rows.push({ kind: "empty", key: `empty:${cellKey}` });
    if (moving && moving.toLane === lane.key && moving.toCol === col) {
      const at = Math.max(0, Math.min(rows.length, moving.index - (entries.length > WINDOW_MIN ? /** @type {any} */ (windows.get(cellKey)).start : 0)));
      rows.splice(at, 0, { kind: "drop", key: "drop-target" });
    }
    reconcile(ul, rows, {
      after: topSpacer, before: bottomSpacer,
      key: (e) => e.key,
      create: (e) => {
        if (e.kind === "empty") {
          return h("li", { class: "cell-empty", tabindex: "-1", "data-empty": "1" },
            h("span", { class: "empty-text" }, m.emptyText));
        }
        if (e.kind === "drop") return h("li", { class: "drop-target", "aria-hidden": "true" }, h("div", { class: "drop-card" }, "Drop here"));
        const li = h("li", { class: "slot" });
        li.append(createCard(e.kind === "ghost"));
        return li;
      },
      update: (node, e) => {
        if (e.kind === "empty") {
          const li = /** @type {HTMLElement} */ (node);
          li.tabIndex = focusKey === e.key ? 0 : -1;
          li.dataset.key = e.key;
          li.setAttribute("aria-label", `No items in ${colLabel}${lane.group ? `, ${lane.group.label}` : ""}.${m.canWrite ? " Press C to create one here." : ""}`);
          return;
        }
        if (e.kind === "drop") return;
        const card = /** @type {HTMLElement} */ (node.firstElementChild);
        updateCard(card, e, m.env, { focused: e.key === focusKey });
        card.dataset.key = e.key;
        card.dataset.lane = lane.key;
        card.dataset.col = col;
        card.classList.toggle("moving", Boolean(moving && moving.entry.key === e.key));
      },
    });
  }

  /** @param {BoardModel} m */
  function pitchOf(m) { return (CARD_H[/** @type {"comfortable"|"compact"} */ (m.env.density)] ?? CARD_H.comfortable) + GAP; }

  /**
   * The visible slice of a cell from its position (cell coordinates, not DOM order).
   * @param {DOMRect} view @param {number} viewHeight @param {DOMRect} cell @param {number} n @param {number} pitch
   */
  function visibleRange(view, viewHeight, cell, n, pitch) {
    // jsdom has no layout: fall back to the first screenful.
    if (!cell.height && !cell.top) return { start: 0, end: Math.min(n, INITIAL_WINDOW) };
    const top = cell.top - view.top;
    const from = Math.max(0, -top), to = viewHeight - top;
    const start = Math.max(0, Math.min(n, Math.floor(from / pitch) - OVERSCAN));
    const end = Math.max(start, Math.min(n, Math.ceil(to / pitch) + OVERSCAN));
    return { start, end };
  }

  /** Reads every windowed cell's position in one layout, then re-renders only changed slices. */
  function refreshWindows() {
    if (!model || !windows.size) return;
    const m = model;
    const pitch = pitchOf(m);
    const view = scroller.getBoundingClientRect();
    const viewHeight = scroller.clientHeight || view.height || 800;
    /** @type {{ ul: HTMLElement, lane: Lane, col: string, label: string, key: string, rect: DOMRect }[]} */
    const cells = [];
    for (const ul of /** @type {HTMLElement[]} */ ([...lanesEl.querySelectorAll("ul.cell.windowed")])) {
      const lane = m.projection.lanes.find((l) => l.key === ul.dataset.lane);
      const col = m.projection.columns.find((c) => c.group.key === ul.dataset.col);
      if (!lane || !col) continue;
      cells.push({ ul, lane, col: col.group.key, label: col.group.label, key: `${lane.key}::${col.group.key}`, rect: ul.getBoundingClientRect() });
    }
    for (const c of cells) {
      const n = c.lane.cells.get(c.col)?.length ?? 0;
      const next = visibleRange(view, viewHeight, c.rect, n, pitch);
      const prev = windows.get(c.key);
      // Hysteresis: keep the current slice while it still covers the viewport.
      if (prev && prev.start <= next.start + OVERSCAN / 2 && prev.end >= next.end - OVERSCAN / 2 && prev.end - prev.start <= next.end - next.start + OVERSCAN * 3) continue;
      windows.set(c.key, next);
      renderCell(c.ul, c.lane, c.col, c.label);
    }
  }

  scroller.addEventListener("scroll", () => {
    if (scrollRaf || !windows.size) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; refreshWindows(); });
  }, { passive: true });

  // -------------------------------------------------------------------------------------------
  // Navigation (on the projection)

  /** Cells in visual order: lanes (expanded) × columns (expanded). */
  function cellGrid() {
    if (!model) return { lanes: [], cols: [] };
    const cols = model.projection.columns.filter((c) => !model?.collapsedCols.has(c.group.key)).map((c) => c.group.key);
    const lanes = model.projection.lanes.filter((l) => !l.group || !model?.collapsedLanes.has(l.key));
    return { lanes, cols };
  }

  /** @param {Lane} lane @param {string} col */
  function cards(lane, col) {
    return (lane.cells.get(col) ?? []).filter((e) => e.kind === "card");
  }

  /** @returns {{ li: number, ci: number, idx: number }|null} */
  function where() {
    if (!model?.focus) return null;
    const { lanes, cols } = cellGrid();
    const li = lanes.findIndex((l) => l.key === model?.focus?.lane);
    const ci = cols.indexOf(model.focus.col);
    if (li < 0 || ci < 0) return null;
    const idx = cards(lanes[li], cols[ci]).findIndex((e) => e.key === model?.focus?.key);
    return { li, ci, idx };
  }

  /** The position to use when nothing is focused yet: the first card anywhere. */
  function firstPos() {
    const { lanes, cols } = cellGrid();
    for (let li = 0; li < lanes.length; li++) for (let ci = 0; ci < cols.length; ci++) if (cards(lanes[li], cols[ci]).length) return { li, ci, idx: 0 };
    return lanes.length && cols.length ? { li: 0, ci: 0, idx: -1 } : null;
  }

  /** @param {number} li @param {number} ci @param {number} idx */
  function posKey(li, ci, idx) {
    const { lanes, cols } = cellGrid();
    const lane = lanes[li], col = cols[ci];
    if (!lane || col === undefined) return null;
    const list = cards(lane, col);
    if (!list.length) return { key: `empty:${lane.key}::${col}`, lane: lane.key, col };
    const e = list[Math.max(0, Math.min(list.length - 1, idx))];
    return { key: e.key, lane: lane.key, col };
  }

  /**
   * Moves focus. Returns true when handled.
   * @param {"up"|"down"|"left"|"right"|"first"|"last"|"pageUp"|"pageDown"|"home"|"end"} dir
   */
  function navigate(dir) {
    if (!model) return false;
    if (moving) return moveTarget(dir);
    const { lanes, cols } = cellGrid();
    let at = where();
    if (!at) {
      const first = firstPos();
      if (!first) return false;
      return go(first.li, first.ci, Math.max(0, first.idx));
    }
    let { li, ci, idx } = at;
    const len = (/** @type {number} */ l, /** @type {number} */ c) => cards(lanes[l], cols[c]).length;
    switch (dir) {
      case "down":
        if (idx < len(li, ci) - 1) return go(li, ci, idx + 1);
        if (li < lanes.length - 1) return go(li + 1, ci, 0);
        return true;
      case "up":
        if (idx > 0) return go(li, ci, idx - 1);
        if (li > 0) return go(li - 1, ci, Math.max(0, len(li - 1, ci) - 1));
        return true;
      case "right": if (ci < cols.length - 1) return go(li, ci + 1, idx); return true;
      case "left": if (ci > 0) return go(li, ci - 1, idx); return true;
      case "first": return go(li, 0, idx);
      case "last": return go(li, cols.length - 1, idx);
      case "home": return go(0, 0, 0);
      case "end": return go(lanes.length - 1, cols.length - 1, Number.MAX_SAFE_INTEGER);
      case "pageDown": return go(li, ci, Math.min(len(li, ci) - 1, idx + 10));
      case "pageUp": return go(li, ci, Math.max(0, idx - 10));
    }
    return false;
  }

  /** @param {number} li @param {number} ci @param {number} idx */
  function go(li, ci, idx) {
    const pos = posKey(li, ci, idx);
    if (!pos) return false;
    onAction("focus", pos);
    return true;
  }

  /** Focuses the DOM node for the model's focus, rendering windowed cells as needed. */
  function focusCurrent({ scroll = true } = {}) {
    if (!model?.focus) return false;
    const f = model.focus;
    const ul = /** @type {HTMLElement|null} */ (lanesEl.querySelector(`section.lane[data-lane="${cssq(f.lane)}"] ul.cell[data-col="${cssq(f.col)}"]`));
    if (!ul) return false;
    const find = () => /** @type {HTMLElement|null} */ (ul.querySelector(`[data-key="${cssq(f.key)}"]`));
    let target = find();
    if (!target && ul.classList.contains("windowed")) {
      const lane = model.projection.lanes.find((l) => l.key === f.lane);
      const entries = lane?.cells.get(f.col) ?? [];
      const i = entries.findIndex((e) => e.key === f.key);
      if (i >= 0 && lane) {
        const pitch = pitchOf(model);
        const cellTop = ul.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
        scroller.scrollTop = Math.max(0, cellTop + i * pitch - scroller.clientHeight / 3);
        windows.set(`${f.lane}::${f.col}`, { start: Math.max(0, i - OVERSCAN), end: Math.min(entries.length, i + OVERSCAN * 3) });
        renderCell(ul, lane, f.col, model.projection.columns.find((c) => c.group.key === f.col)?.group.label ?? f.col);
        target = find();
      }
    }
    if (target?.matches("li.slot")) target = /** @type {HTMLElement} */ (target.firstElementChild);
    if (!target) return false;
    target.tabIndex = 0;
    focusEl(target, { scroll });
    return true;
  }

  /** The focused entry, if it is a card. */
  function focusedEntry() {
    if (!model?.focus) return null;
    const lane = model.projection.lanes.find((l) => l.key === model?.focus?.lane);
    const e = lane?.cells.get(model.focus.col)?.find((x) => x.key === model?.focus?.key);
    return e && e.kind === "card" ? { entry: e, lane: model.focus.lane, col: model.focus.col } : null;
  }

  // -------------------------------------------------------------------------------------------
  // Keyboard move mode

  function startMove() {
    const f = focusedEntry();
    if (!f || !model?.canWrite) return false;
    const list = cards(/** @type {Lane} */ (model.projection.lanes.find((l) => l.key === f.lane)), f.col);
    moving = { entry: f.entry, fromLane: f.lane, fromCol: f.col, toLane: f.lane, toCol: f.col, index: list.findIndex((e) => e.key === f.entry.key) };
    announceMove(true);
    rerender();
    return true;
  }

  /** @param {string} dir */
  function moveTarget(dir) {
    if (!moving || !model) return false;
    const { lanes, cols } = cellGrid();
    let li = lanes.findIndex((l) => l.key === moving?.toLane);
    let ci = cols.indexOf(moving.toCol);
    let index = moving.index;
    const size = (/** @type {number} */ l, /** @type {number} */ c) => cards(lanes[l], cols[c]).filter((e) => e.key !== moving?.entry.key).length;
    if (dir === "left" && ci > 0) { ci--; index = model.manualOrder ? Math.min(index, size(li, ci)) : 0; }
    else if (dir === "right" && ci < cols.length - 1) { ci++; index = model.manualOrder ? Math.min(index, size(li, ci)) : 0; }
    else if (dir === "up") { if (model.manualOrder && index > 0) index--; else if (li > 0) { li--; index = model.manualOrder ? size(li, ci) : 0; } }
    else if (dir === "down") { if (model.manualOrder && index < size(li, ci)) index++; else if (li < lanes.length - 1) { li++; index = 0; } }
    moving.toLane = lanes[li].key;
    moving.toCol = cols[ci];
    moving.index = index;
    announceMove(false);
    rerender();
    return true;
  }

  /** @param {boolean} first */
  function announceMove(first) {
    if (!moving || !model) return;
    const colLabel = model.projection.columns.find((c) => c.group.key === moving?.toCol)?.group.label ?? moving.toCol;
    const lane = model.projection.lanes.find((l) => l.key === moving?.toLane);
    const pos = model.manualOrder ? `, position ${moving.index + 1}` : "";
    onAction("announce", `${first ? "Moving" : "To"} ${moving.entry.item.key} to ${colLabel}${lane?.group ? `, lane ${lane.group.label}` : ""}${pos}.${first ? " Use arrow keys to choose. Press Enter to confirm, Escape to cancel." : ""}`);
  }

  function commitMove() {
    if (!moving || !model) return false;
    const m = moving;
    moving = null;
    const lane = model.projection.lanes.find((l) => l.key === m.toLane);
    const ordered = lane ? cards(lane, m.toCol).filter((e) => e.key !== m.entry.key).map((e) => e.item) : [];
    rerender();
    if (m.toLane === m.fromLane && m.toCol === m.fromCol) {
      const original = lane ? cards(lane, m.fromCol).findIndex((e) => e.key === m.entry.key) : -1;
      if (!model.manualOrder || m.index === original) {
        onAction("announce", "Move cancelled: same place.");
        return true;
      }
    }
    onAction("move", { item: m.entry.item, fromLane: m.fromLane, toLane: m.toLane, toCol: m.toCol, ordered, index: m.index });
    return true;
  }

  function cancelMove() {
    if (!moving) return false;
    moving = null;
    onAction("announce", "Move cancelled.");
    rerender();
    return true;
  }

  function rerender() { if (model) update(model); focusCurrent({ scroll: false }); }

  // -------------------------------------------------------------------------------------------
  // Pointer: click, selection, context menu, drag and drop

  /** @param {Element|null} target */
  function cardFrom(target) {
    const card = /** @type {HTMLElement|null} */ (target?.closest?.("article.card:not(.ghost)") ?? null);
    if (!card || !model) return null;
    const lane = model.projection.lanes.find((l) => l.key === card.dataset.lane);
    const entry = lane?.cells.get(card.dataset.col ?? "")?.find((e) => e.key === card.dataset.key);
    return entry && entry.kind === "card" ? { card, entry, lane: /** @type {string} */ (card.dataset.lane), col: /** @type {string} */ (card.dataset.col) } : null;
  }

  lanesEl.addEventListener("click", (event) => {
    const e = /** @type {MouseEvent} */ (event);
    const t = /** @type {Element} */ (e.target);
    if (suppressClick) { suppressClick = false; return; }
    const empty = t.closest?.("li.cell-empty");
    if (empty && model) {
      const ul = /** @type {HTMLElement} */ (empty.closest("ul.cell"));
      onAction("focus", { key: `empty:${ul.dataset.lane}::${ul.dataset.col}`, lane: ul.dataset.lane, col: ul.dataset.col });
      return;
    }
    const hit = cardFrom(t);
    if (!hit) return;
    const action = /** @type {HTMLElement|null} */ (t.closest("[data-action]"))?.dataset.action;
    onAction("focus", { key: hit.entry.key, lane: hit.lane, col: hit.col, silent: true });
    if (action === "select") { e.preventDefault(); onAction("select", { item: hit.entry.item, toggle: true, range: e.shiftKey }); }
    else if (action === "menu") onAction("menu", { item: hit.entry.item, lane: hit.lane, anchor: t.closest("button") });
    else if (e.shiftKey) onAction("select", { item: hit.entry.item, range: true });
    else if (e.metaKey || e.ctrlKey) onAction("select", { item: hit.entry.item, toggle: true });
    else onAction("open", { item: hit.entry.item });
  });
  lanesEl.addEventListener("contextmenu", (event) => {
    const hit = cardFrom(/** @type {Element} */ (event.target));
    if (!hit || !model?.canWrite) return;
    event.preventDefault();
    const me = /** @type {MouseEvent} */ (event);
    onAction("menu", { item: hit.entry.item, lane: hit.lane, anchor: { x: me.clientX, y: me.clientY } });
  });
  lanesEl.addEventListener("mouseover", (event) => {
    const hit = cardFrom(/** @type {Element} */ (event.target));
    onAction("hover", hit ? hit.entry.item.id : null);
  });

  /** @type {null | { id: number, x: number, y: number, hit: NonNullable<ReturnType<typeof cardFrom>>, started: boolean, clone: HTMLElement|null, dx: number, dy: number, target: { ul: HTMLElement, index: number }|null, timer: ReturnType<typeof setTimeout>|null, touch: boolean, raf: number, lastX: number, lastY: number }} */
  let drag = null;
  let suppressClick = false;

  lanesEl.addEventListener("pointerdown", (event) => {
    const e = /** @type {PointerEvent} */ (event);
    if (e.button !== 0 || !model?.canWrite || moving) return;
    if (/** @type {Element} */ (e.target).closest("button, input, a, label")) return;
    const hit = cardFrom(/** @type {Element} */ (e.target));
    if (!hit) return;
    const rect = hit.card.getBoundingClientRect();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, hit, started: false, clone: null, dx: e.clientX - rect.left, dy: e.clientY - rect.top, target: null, timer: null, touch: e.pointerType === "touch", raf: 0, lastX: e.clientX, lastY: e.clientY };
    if (drag.touch) drag.timer = setTimeout(() => { if (drag && !drag.started) beginDrag(); }, 350);
  });

  function beginDrag() {
    if (!drag) return;
    drag.started = true;
    const rect = drag.hit.card.getBoundingClientRect();
    const clone = /** @type {HTMLElement} */ (drag.hit.card.cloneNode(true));
    clone.classList.add("drag-clone");
    clone.removeAttribute("tabindex");
    clone.setAttribute("aria-hidden", "true");
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    doc.body.append(clone);
    drag.clone = clone;
    drag.hit.card.classList.add("drag-source");
    el.classList.add("dragging");
    try { lanesEl.setPointerCapture(drag.id); } catch { /* ignore */ }
    positionClone();
  }

  function positionClone() {
    if (!drag?.clone) return;
    drag.clone.style.transform = `translate(${drag.lastX - drag.dx}px, ${drag.lastY - drag.dy}px) rotate(1.5deg)`;
  }

  lanesEl.addEventListener("pointermove", (event) => {
    const e = /** @type {PointerEvent} */ (event);
    if (!drag || e.pointerId !== drag.id) return;
    drag.lastX = e.clientX; drag.lastY = e.clientY;
    if (!drag.started) {
      if (drag.touch) { if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 8) { if (drag.timer) clearTimeout(drag.timer); drag = null; } return; }
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
      beginDrag();
    }
    e.preventDefault();
    if (drag.raf) return;
    drag.raf = requestAnimationFrame(() => {
      if (!drag) return;
      drag.raf = 0;
      positionClone();
      trackTarget();
      autoScroll();
    });
  });

  function trackTarget() {
    if (!drag?.clone) return;
    drag.clone.style.visibility = "hidden";
    const under = doc.elementFromPoint(drag.lastX, drag.lastY);
    drag.clone.style.visibility = "";
    const ul = /** @type {HTMLElement|null} */ (under?.closest?.("ul.cell:not(.collapsed)") ?? null);
    for (const x of lanesEl.querySelectorAll("ul.cell.drop-over")) if (x !== ul) x.classList.remove("drop-over");
    lanesEl.querySelector(".drop-line")?.remove();
    if (!ul) { drag.target = null; return; }
    ul.classList.add("drop-over");
    const slots = /** @type {HTMLElement[]} */ ([...ul.querySelectorAll(":scope > li.slot")]).filter((li) => !li.firstElementChild?.classList.contains("drag-source") && !li.firstElementChild?.classList.contains("ghost"));
    let index = slots.length;
    for (let i = 0; i < slots.length; i++) {
      const r = slots[i].getBoundingClientRect();
      if (drag.lastY < r.top + r.height / 2) { index = i; break; }
    }
    const offset = windows.get(`${ul.dataset.lane}::${ul.dataset.col}`)?.start ?? 0;
    drag.target = { ul, index: index + offset };
    if (model?.manualOrder) {
      const line = h("li", { class: "drop-line", "aria-hidden": "true" });
      ul.insertBefore(line, slots[index] ?? ul.querySelector(":scope > li.spacer.bottom"));
    }
  }

  function autoScroll() {
    if (!drag) return;
    const r = scroller.getBoundingClientRect();
    const edge = 56;
    let vx = 0, vy = 0;
    if (drag.lastX < r.left + edge) vx = -1; else if (drag.lastX > r.right - edge) vx = 1;
    if (drag.lastY < r.top + edge + 40) vy = -1; else if (drag.lastY > r.bottom - edge) vy = 1;
    if (vx || vy) {
      scroller.scrollBy(vx * 14, vy * 14);
      if (!drag.raf) drag.raf = requestAnimationFrame(() => { if (!drag) return; drag.raf = 0; trackTarget(); autoScroll(); });
    }
  }

  /** @param {boolean} commit */
  function endDrag(commit) {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.timer) clearTimeout(d.timer);
    if (d.raf) cancelAnimationFrame(d.raf);
    if (!d.started) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    d.clone?.remove();
    d.hit.card.classList.remove("drag-source");
    el.classList.remove("dragging");
    lanesEl.querySelector(".drop-line")?.remove();
    for (const x of lanesEl.querySelectorAll("ul.cell.drop-over")) x.classList.remove("drop-over");
    if (!commit || !d.target || !model) return;
    const toLane = /** @type {string} */ (d.target.ul.dataset.lane), toCol = /** @type {string} */ (d.target.ul.dataset.col);
    const lane = model.projection.lanes.find((l) => l.key === toLane);
    const ordered = lane ? cards(lane, toCol).filter((e) => e.item.id !== d.hit.entry.item.id).map((e) => e.item) : [];
    const all = lane ? cards(lane, toCol) : [];
    const oldIndex = all.findIndex((e) => e.key === d.hit.entry.key);
    let index = d.target.index;
    if (toLane === d.hit.lane && toCol === d.hit.col && oldIndex >= 0 && oldIndex < index) index = Math.max(0, index);
    if (toLane === d.hit.lane && toCol === d.hit.col && (!model.manualOrder || index === oldIndex)) return;
    onAction("move", { item: d.hit.entry.item, fromLane: d.hit.lane, toLane, toCol, ordered, index: Math.min(index, ordered.length), pointer: true });
  }

  lanesEl.addEventListener("pointerup", (e) => { if (drag && /** @type {PointerEvent} */ (e).pointerId === drag.id) endDrag(true); });
  lanesEl.addEventListener("pointercancel", () => endDrag(false));
  doc.addEventListener("keydown", (e) => { if (drag?.started && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); endDrag(false); onAction("announce", "Drag cancelled."); } }, true);

  return {
    el, scroller, update, navigate, focusCurrent, focusedEntry, startMove, commitMove, cancelMove,
    get moving() { return Boolean(moving); },
    /** For tests. */
    get windows() { return windows; },
  };
}

/** @param {string} s */
function cssq(s) { return s.replace(/["\\]/g, "\\$&"); }

/** Re-export for the app's empty-state text. */
export { setText };
