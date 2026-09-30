// @ts-check
// Tool palette (select, hand, the creation tools), the keyboard-reachable "Add" menu that creates
// objects at the view centre without dragging, and undo/redo. The Shapes tool draws rectangles in
// the shape picked from its popover (./shape-picker.js), or ellipses; R and O pick it directly.
//
// Keyboard: one Tab stop, arrow keys move between the buttons. On phones the bar runs along the
// bottom and Add, Objects and Activity come first (in DOM order too, so focus order matches), so
// the actions that have no other touch path are never scrolled out of sight.

import { h, icon, rovingFocus } from "./dom.js";
import { openMenu } from "./dialogs.js";
import { openPicker, shapeIcon, shapeChoiceLabel, SHAPE_CHOICES } from "./shape-picker.js";

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
  { tool: "rect", label: "Shapes", key: "R", icon: "rect" },
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
  { type: "shape", label: "Shape…" },
  { type: "text", label: "Text" },
  { type: "frame", label: "Frame" },
  { type: "code", label: "Code block (K)" },
  { type: "table", label: "Table" },
  { type: "diagram", label: "Diagram (D2)" },
  { type: "diagramMermaid", label: "Diagram (Mermaid)" },
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
      if (t.tool === "rect") {
        // The Shapes tool: keep drawing the last shape, and offer the others.
        const current = canvas.getTool() === "ellipse" ? "ellipse" : canvas.getShape();
        canvas.setTool(current === "ellipse" ? "ellipse" : "rect", false);
        openShapes(btn, (v) => { pickShape(v); });
      } else canvas.setTool(t.tool, false);
      render();
    });
    btn.addEventListener("dblclick", () => {
      const tool = t.tool === "rect" && canvas.getTool() === "ellipse" ? "ellipse" : t.tool;
      lockedTool = tool;
      canvas.setTool(tool, true);
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

  // Insert buttons (not tools): each adds its object at the centre of the view.
  const insertButtons = /** @type {const} */ ([
    { type: "table", label: "Table", icon: "table" },
    { type: "code", label: "Code block (K)", icon: "code" },
    { type: "diagram", label: "Diagram (D2 or Mermaid)", icon: "diagram" },
  ]).map((b) => h("button", {
    type: "button", class: `btn icon-only insert-btn insert-${b.type}`, title: `Add a ${b.label.charAt(0).toLowerCase()}${b.label.slice(1)}`,
    "aria-label": `Add ${b.label.replace(/ \(.*\)$/, "").toLowerCase()}`, onclick: () => { canvas.addAtCenter(b.type); },
  }, icon(b.icon, 20)));

  const sep = h("div", { class: "wb-sep", role: "separator" });
  const el = h("div", { class: "wb-float wb-toolbar", role: "toolbar", "aria-label": "Tools", "aria-orientation": "vertical" },
    [...toolButtons.values()], ...insertButtons, sep, addBtn, outlineBtn, activityBtn,
  );
  const roving = rovingFocus(el);

  const phone = typeof matchMedia === "function" ? matchMedia("(max-width: 600px)") : null;
  function layout() {
    const small = !!phone?.matches;
    const actions = [addBtn, outlineBtn, activityBtn];
    const order = small ? [...actions, sep, ...toolButtons.values(), ...insertButtons] : [...toolButtons.values(), ...insertButtons, sep, ...actions];
    if (order.some((node, i) => el.children[i] !== node)) {
      const active = document.activeElement;
      el.replaceChildren(...order);
      if (active instanceof HTMLElement && el.contains(active)) active.focus({ preventScroll: true });
    }
    el.setAttribute("aria-orientation", small ? "horizontal" : "vertical");
    el.scrollTop = 0;
    el.scrollLeft = 0;
  }
  layout();
  phone?.addEventListener?.("change", layout, { signal: app.signal });

  /**
   * The shape grid, beside `anchor`.
   * @param {HTMLElement} anchor @param {(value: string) => void} onPick
   */
  function openShapes(anchor, onPick) {
    const current = canvas.getTool() === "ellipse" ? "ellipse" : canvas.getShape();
    openPicker(anchor, {
      label: "Shapes", choices: SHAPE_CHOICES, current, icon: (v) => shapeIcon(v, 22), onPick, columns: 7, className: "shape-pop",
    });
  }

  /** The Shapes tool draws `value` from now on. @param {string} value */
  function pickShape(value) {
    const locked = lockedTool === "rect" || lockedTool === "ellipse";
    if (value !== "ellipse") canvas.setShape(value);
    canvas.setTool(value === "ellipse" ? "ellipse" : "rect", locked);
    app.announce?.(`${shapeChoiceLabel(value)} tool: drag on the board, or click for the default size`);
    render();
  }

  /** @param {HTMLElement} anchor */
  function openAddMenu(anchor) {
    openMenu(anchor, [
      ...ADDABLE.map((a) => ({
        label: a.label,
        className: "add-" + a.type,
        onSelect: () => {
          if (a.type === "shape") openShapes(addBtn, (v) => { canvas.addAtCenter(v === "ellipse" ? "ellipse" : "rect", { shape: v }); });
          else if (a.type === "diagramMermaid") canvas.addAtCenter("diagram", { syntax: "mermaid" });
          else canvas.addAtCenter(a.type);
        },
      })),
      { label: "Icons and shapes… (I)", className: "add-icon", onSelect: () => app.toggleIconPicker?.() },
      { label: `Emoji and symbols… (${MOD}.)`, className: "add-emoji", onSelect: () => app.openEmojiPicker?.() },
    ], { label: "Add object" });
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
    const shapeBtn = toolButtons.get("rect");
    if (shapeBtn) {
      const shown = current === "ellipse" ? "ellipse" : canvas.getShape();
      if (shapeBtn.dataset.shape !== shown) {
        shapeBtn.dataset.shape = shown;
        shapeBtn.replaceChildren(shapeIcon(shown, 20));
        shapeBtn.setAttribute("aria-label", `Shapes: ${shapeChoiceLabel(shown)}`);
      }
    }
    for (const [tool, btn] of toolButtons) {
      const on = tool === current || (tool === "rect" && current === "ellipse");
      btn.setAttribute("aria-pressed", String(on));
      if (on && (lockedTool === tool || (tool === "rect" && lockedTool === current))) btn.dataset.locked = "true";
      else delete btn.dataset.locked;
    }
    const state = store.getState();
    // aria-disabled rather than disabled, so focus stays on the button after the last undo.
    undoBtn.setAttribute("aria-disabled", String(!state.canUndo));
    redoBtn.setAttribute("aria-disabled", String(!state.canRedo));
    outlineBtn.setAttribute("aria-pressed", String(app.outlineOpen));
    activityBtn.setAttribute("aria-pressed", String(app.activityOpen));
    roving.refresh(toolButtons.get(current === "ellipse" ? "rect" : current) ?? null);
  }

  return { el, history, render, openAddMenu: () => openAddMenu(addBtn) };
}
