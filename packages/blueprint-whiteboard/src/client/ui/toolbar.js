// @ts-check
// Tool palette (select, hand, the creation tools), the keyboard-reachable "Add" menu that creates
// objects at the view centre without dragging, and undo/redo.

import { h, icon } from "./dom.js";
import { openMenu } from "./dialogs.js";

/** @typedef {import("./app.js").App} App */
/** @typedef {import("./ui-contract.js").Tool} Tool */

/**
 * Tools in toolbar order. `key` is the single-key shortcut (no modifiers).
 * @type {{tool: Tool, label: string, key: string, icon: Parameters<typeof icon>[0]}[]}
 */
export const TOOLS = [
  { tool: "select", label: "Select", key: "V", icon: "select" },
  { tool: "hand", label: "Hand (pan)", key: "H", icon: "hand" },
  { tool: "sticky", label: "Sticky note", key: "N", icon: "sticky" },
  { tool: "rect", label: "Rectangle", key: "R", icon: "rect" },
  { tool: "ellipse", label: "Ellipse", key: "O", icon: "ellipse" },
  { tool: "text", label: "Text", key: "T", icon: "text" },
  { tool: "frame", label: "Frame", key: "F", icon: "frame" },
  { tool: "connector", label: "Connector", key: "C", icon: "connector" },
  { tool: "pen", label: "Pen", key: "P", icon: "pen" },
];

/** Types the Add menu creates at the view centre. */
export const ADDABLE = /** @type {const} */ ([
  { type: "sticky", label: "Sticky note" },
  { type: "rect", label: "Rectangle" },
  { type: "ellipse", label: "Ellipse" },
  { type: "text", label: "Text" },
  { type: "frame", label: "Frame" },
]);

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = IS_MAC ? "⌘" : "Ctrl+";

/** @param {App} app */
export function createToolbar(app) {
  const { canvas, store } = app;
  /** @type {Map<Tool, HTMLElement>} */
  const toolButtons = new Map();
  let lockedTool = /** @type {Tool|null} */ (null);

  for (const t of TOOLS) {
    const btn = h("button", {
      type: "button", class: "btn icon-only tool-btn", "aria-pressed": "false",
      title: `${t.label} (${t.key})${t.tool === "select" || t.tool === "hand" ? "" : ". Double-click to keep it on"}`,
      "aria-label": t.label, "aria-keyshortcuts": t.key, dataset: { tool: t.tool },
    }, icon(t.icon, 20));
    btn.addEventListener("click", () => {
      lockedTool = null;
      canvas.setTool(t.tool, false);
      render();
    });
    btn.addEventListener("dblclick", () => {
      lockedTool = t.tool;
      canvas.setTool(t.tool, true);
      render();
    });
    toolButtons.set(t.tool, btn);
  }

  const addBtn = h("button", {
    type: "button", class: "btn icon-only add-btn", title: "Add an object at the centre of the view (A)",
    "aria-label": "Add object", "aria-haspopup": "menu", "aria-keyshortcuts": "A",
  }, icon("plus", 20));
  addBtn.addEventListener("click", () => openAddMenu(addBtn));

  const outlineBtn = h("button", {
    type: "button", class: "btn icon-only outline-toggle", title: "Objects list (Shift+O)",
    "aria-label": "Objects list", "aria-keyshortcuts": "Shift+O", "aria-pressed": "false",
    onclick: () => app.toggleOutline(),
  }, icon("list", 20));
  const activityBtn = h("button", {
    type: "button", class: "btn icon-only activity-toggle", title: "Activity", "aria-label": "Activity",
    "aria-pressed": "false", onclick: () => app.toggleActivity(),
  }, icon("activity", 20));

  const el = h("div", { class: "wb-float wb-toolbar", role: "toolbar", "aria-label": "Tools", "aria-orientation": "vertical" },
    [...toolButtons.values()],
    h("div", { class: "wb-sep", role: "separator" }),
    addBtn, outlineBtn, activityBtn,
  );

  /** @param {HTMLElement} anchor */
  function openAddMenu(anchor) {
    openMenu(anchor, ADDABLE.map((a) => ({
      label: a.label,
      className: "add-" + a.type,
      onSelect: () => { canvas.addAtCenter(a.type); },
    })), { label: "Add object" });
  }

  const undoBtn = h("button", {
    type: "button", class: "btn icon-only undo-btn", title: `Undo (${MOD}Z)`, "aria-label": "Undo",
    "aria-keyshortcuts": "Control+Z", "aria-disabled": "true",
    onclick: () => { if (store.getState().canUndo) store.undo(); },
  }, icon("undo", 18));
  const redoBtn = h("button", {
    type: "button", class: "btn icon-only redo-btn", title: `Redo (${MOD}Shift+Z)`, "aria-label": "Redo",
    "aria-keyshortcuts": "Control+Shift+Z", "aria-disabled": "true",
    onclick: () => { if (store.getState().canRedo) store.redo(); },
  }, icon("redo", 18));
  const history = h("div", { class: "wb-float wb-history", role: "group", "aria-label": "History" }, undoBtn, redoBtn);

  /** @param {{tool?: Tool, locked?: boolean}} [event]  the canvas "tool" event, when that is why */
  function render(event) {
    const current = canvas.getTool();
    if (event && event.tool === current && typeof event.locked === "boolean") lockedTool = event.locked ? current : null;
    if (lockedTool && lockedTool !== current) lockedTool = null;
    for (const [tool, btn] of toolButtons) {
      const on = tool === current;
      btn.setAttribute("aria-pressed", String(on));
      if (on && lockedTool === tool) btn.dataset.locked = "true";
      else delete btn.dataset.locked;
    }
    const state = store.getState();
    // aria-disabled rather than disabled, so focus stays on the button after the last undo.
    undoBtn.setAttribute("aria-disabled", String(!state.canUndo));
    redoBtn.setAttribute("aria-disabled", String(!state.canRedo));
    outlineBtn.setAttribute("aria-pressed", String(app.outlineOpen));
    activityBtn.setAttribute("aria-pressed", String(app.activityOpen));
  }

  return { el, history, render, openAddMenu: () => openAddMenu(addBtn) };
}
