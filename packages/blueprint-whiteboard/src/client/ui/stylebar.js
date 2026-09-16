// @ts-check
// The contextual style bar for the current selection: colours, stroke width, font size,
// alignment, connector routing and arrows, stacking, duplicate, delete, edit text, and a Move
// group (the keyboard alternative to dragging). Every change applies to all applicable selected
// objects in ONE store call. Also the long-press / right-click context menu.

import { COLORS, INK } from "../../shared/protocol.js";
import { h, icon } from "./dom.js";
import { openMenu } from "./dialogs.js";
import { expandMoveIds, moveUpdates } from "./canvas/model.js";

/** @typedef {import("./app.js").App} App */
/** @typedef {import("../../shared/protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {import("../../shared/protocol.js").ObjectType} ObjectType */
/** @typedef {import("../../shared/protocol.js").Style} Style */

const FILL_TYPES = new Set(["sticky", "rect", "ellipse", "text", "frame"]);
const STROKE_TYPES = new Set(["rect", "ellipse", "frame", "pen", "connector"]);
const TEXT_COLOR_TYPES = new Set(["sticky", "rect", "ellipse", "text", "connector"]);
const WIDTH_TYPES = new Set(["rect", "ellipse", "frame", "pen", "connector"]);
const FONT_TYPES = new Set(["sticky", "rect", "ellipse", "text", "frame", "connector"]);
const ALIGN_TYPES = new Set(["sticky", "rect", "ellipse", "text"]);
const TEXT_TYPES = new Set(["sticky", "rect", "ellipse", "text", "frame", "connector"]);
const MOVABLE = (/** @type {WhiteboardObject} */ o) => o.type !== "connector";

export const NUDGE = 10;
const WIDTHS = [1, 2, 4, 8];
const FONT_SIZES = [{ label: "S", size: 14 }, { label: "M", size: 20 }, { label: "L", size: 32 }, { label: "XL", size: 48 }];

const COLOR_NAMES = new Map(Object.entries(COLORS).map(([name, hex]) => [hex, name[0].toUpperCase() + name.slice(1)]));
const INK_NAMES = ["Charcoal", "Grey", "Red", "Orange", "Green", "Blue", "Violet", "Pink"];
/** @param {string} hex */
export function colorLabel(hex) {
  if (hex === "none") return "None";
  const i = INK.indexOf(hex);
  return COLOR_NAMES.get(hex) ?? (i >= 0 ? INK_NAMES[i] : hex);
}

/** @param {ObjectType} type */
export function typeLabel(type) {
  return { sticky: "Sticky note", rect: "Rectangle", ellipse: "Ellipse", text: "Text", frame: "Frame", pen: "Drawing", connector: "Connector" }[type] ?? type;
}

/** @param {App} app */
export function createStyleBar(app) {
  const { store, canvas } = app;
  const el = h("div", { class: "wb-float wb-stylebar", role: "toolbar", "aria-label": "Selection", hidden: true });
  /** @type {HTMLElement|null} */
  let popover = null;
  let renderKey = "";

  /** @returns {WhiteboardObject[]} */
  function selected() {
    const objects = store.getState().board.objects;
    return canvas.getSelection().map((id) => objects[id]).filter(Boolean);
  }

  /**
   * One store call for every applicable selected object.
   * @param {(o: WhiteboardObject) => boolean} applies
   * @param {(o: WhiteboardObject) => any} patchFor
   */
  function update(applies, patchFor) {
    const updates = selected().filter(applies).map((o) => ({ id: o.id, patch: patchFor(o) }));
    if (updates.length) store.updateObjects(updates);
  }

  /** @param {Set<string>} types @param {Partial<Style>} style */
  function setStyle(types, style) {
    update((o) => types.has(o.type), () => ({ style }));
  }

  /**
   * Moves the selection like a drag would: frames bring their members, connectors follow their
   * endpoints, and frame membership is updated where an object's centre crosses a frame edge.
   * @param {number} dx @param {number} dy
   */
  function nudge(dx, dy) {
    const objects = store.getState().board.objects;
    const ids = expandMoveIds(objects, canvas.getSelection());
    const updates = moveUpdates(objects, ids, dx, dy);
    if (!updates.length) return;
    store.updateObjects(updates);
    const n = selected().filter(MOVABLE).length;
    app.announce(`Moved ${n === 1 ? "1 object" : n + " objects"} ${dx < 0 ? "left" : dx > 0 ? "right" : dy < 0 ? "up" : "down"}`);
  }

  function duplicate() {
    const ids = canvas.getSelection();
    if (ids.length) canvas.duplicate(ids);
  }
  function remove() {
    const ids = canvas.getSelection();
    if (!ids.length) return;
    store.deleteObjects(ids);
    app.announce(ids.length === 1 ? "Deleted 1 object" : `Deleted ${ids.length} objects`);
  }
  /** @param {"front"|"back"} where */
  function reorder(where) {
    const ids = canvas.getSelection();
    if (ids.length) store.reorder(ids, where);
  }
  function editText() {
    const objs = selected();
    if (objs.length === 1 && TEXT_TYPES.has(objs[0].type)) canvas.editText(objs[0].id);
  }

  /**
   * A swatch popover for one colour property.
   * @param {HTMLElement} anchor
   * @param {string} label
   * @param {string[]} colors
   * @param {string|null} current
   * @param {(color: string) => void} pick
   */
  function openSwatches(anchor, label, colors, current, pick) {
    closePopover();
    const buttons = colors.map((c) => h("button", {
      type: "button", class: "swatch" + (c === "none" ? " none" : ""), "aria-label": colorLabel(c), title: colorLabel(c),
      "aria-pressed": String(c === current), dataset: { color: c }, style: c === "none" ? null : { background: c },
      onclick: () => { closePopover(); anchor.focus(); pick(c); },
    }));
    const pop = h("div", { class: "wb-float swatch-pop", role: "group", "aria-label": label, style: { position: "fixed", padding: "6px", zIndex: "45" } },
      h("div", { class: "swatches", style: { maxWidth: "184px" } }, buttons));
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const below = r.bottom + 6 + ph < window.innerHeight;
    pop.style.top = (below ? r.bottom + 6 : Math.max(8, r.top - ph - 6)) + "px";
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8)) + "px";
    popover = pop;
    pop.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePopover(); anchor.focus(); return; }
      const i = buttons.indexOf(/** @type {any} */ (document.activeElement));
      let next = null;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % buttons.length;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + buttons.length) % buttons.length;
      else if (e.key === "Tab") { closePopover(); anchor.focus(); return; }
      if (next !== null) { e.preventDefault(); buttons[next].focus(); }
    });
    const onDown = (/** @type {Event} */ e) => {
      if (!pop.contains(/** @type {Node} */ (e.target)) && e.target !== anchor) closePopover();
    };
    setTimeout(() => document.addEventListener("pointerdown", onDown, true));
    /** @type {any} */ (pop)._cleanup = () => document.removeEventListener("pointerdown", onDown, true);
    (buttons.find((b) => b.getAttribute("aria-pressed") === "true") ?? buttons[0])?.focus();
  }

  function closePopover() {
    if (!popover) return;
    /** @type {any} */ (popover)._cleanup?.();
    popover.remove();
    popover = null;
  }

  /**
   * @param {WhiteboardObject[]} objs
   * @param {(o: WhiteboardObject) => any} get
   */
  function common(objs, get) {
    if (!objs.length) return null;
    const first = get(objs[0]);
    return objs.every((o) => get(o) === first) ? first : null;
  }

  /**
   * @param {string} key  stable key for focus restoration
   * @param {Record<string, any>} attrs
   * @param {...any} children
   */
  function btn(key, attrs, ...children) {
    return h("button", { type: "button", class: "btn small", ...attrs, dataset: { key, ...(attrs.dataset ?? {}) } }, ...children);
  }

  /**
   * @param {string} key @param {string} label @param {Set<string>} types @param {WhiteboardObject[]} objs
   * @param {keyof Style} prop @param {string[]} colors
   */
  function colorButton(key, label, types, objs, prop, colors) {
    const applicable = objs.filter((o) => types.has(o.type));
    if (!applicable.length) return null;
    const current = common(applicable, (o) => o.style[prop]);
    const chip = h("span", {
      class: "swatch swatch-chip" + (current === "none" ? " none" : ""), "aria-hidden": "true",
      style: current && current !== "none" ? { background: current } : null,
    });
    const b = btn(key, {
      class: "btn small style-" + key, title: label, "aria-label": `${label}: ${current ? colorLabel(current) : "mixed"}`,
      "aria-haspopup": "true",
    }, chip);
    b.addEventListener("click", () => openSwatches(b, label, colors, current, (c) => setStyle(types, { [prop]: c })));
    return b;
  }

  function render() {
    const objs = selected();
    const state = store.getState();
    if (!objs.length || state.board === undefined) {
      if (!el.hidden) {
        el.hidden = true;
        closePopover();
        renderKey = "";
        app.onStyleBarToggle?.(false);
      }
      return;
    }
    const key = objs.map((o) => `${o.id}:${o.version}:${JSON.stringify(o.style)}:${o.routing ?? ""}`).join("|");
    if (key === renderKey && !el.hidden) return;
    renderKey = key;
    const types = new Set(objs.map((o) => o.type));
    const has = (/** @type {Set<string>} */ set) => objs.some((o) => set.has(o.type));
    const noSticky = !types.has("sticky") && !types.has("frame");

    // Keep focus on the same control across the rebuild.
    const active = /** @type {HTMLElement|null} */ (document.activeElement);
    const focusKey = active && el.contains(active) ? active.dataset.key ?? null : null;

    /** @type {any[]} */
    const groups = [];
    const count = h("span", { class: "style-group-label selection-count", "aria-live": "off" },
      objs.length === 1 ? typeLabel(objs[0].type) : `${objs.length} selected`);
    groups.push(count);

    const colors = h("div", { class: "style-group", role: "group", "aria-label": "Colours" },
      colorButton("fill", "Fill colour", FILL_TYPES, objs, "fill", [...Object.values(COLORS), ...(noSticky ? ["none"] : [])]),
      colorButton("stroke", "Line colour", STROKE_TYPES, objs, "stroke",
        [...INK, ...(objs.some((o) => o.type === "pen" || o.type === "connector") ? [] : ["none"])]),
      colorButton("text-color", "Text colour", TEXT_COLOR_TYPES, objs, "textColor", [...INK, "#ffffff"]),
    );
    if (colors.children.length) groups.push(colors);

    if (has(WIDTH_TYPES)) {
      const current = common(objs.filter((o) => WIDTH_TYPES.has(o.type)), (o) => o.style.strokeWidth);
      groups.push(h("div", { class: "style-group width-group", role: "group", "aria-label": "Line width" },
        WIDTHS.map((w) => btn("width-" + w, {
          class: "btn small width-btn", "aria-pressed": String(current === w), "aria-label": `Line width ${w}`, title: `Line width ${w}`,
          onclick: () => setStyle(WIDTH_TYPES, { strokeWidth: w }),
        }, h("span", { "aria-hidden": "true", style: { display: "block", width: "16px", height: Math.max(1, Math.min(6, w)) + "px", background: "currentColor", borderRadius: "2px" } })))));
    }
    if (has(FONT_TYPES)) {
      const current = common(objs.filter((o) => FONT_TYPES.has(o.type)), (o) => o.style.fontSize);
      groups.push(h("div", { class: "style-group font-group", role: "group", "aria-label": "Text size" },
        FONT_SIZES.map((f) => btn("font-" + f.size, {
          class: "btn small font-btn", "aria-pressed": String(current === f.size), "aria-label": `Text size ${f.label === "S" ? "small" : f.label === "M" ? "medium" : f.label === "L" ? "large" : "extra large"}`,
          title: `Text size ${f.size}`, dataset: { size: String(f.size) },
          onclick: () => setStyle(FONT_TYPES, { fontSize: f.size }),
        }, f.label))));
    }
    if (has(ALIGN_TYPES)) {
      const current = common(objs.filter((o) => ALIGN_TYPES.has(o.type)), (o) => o.style.align);
      groups.push(h("div", { class: "style-group align-group", role: "group", "aria-label": "Text alignment" },
        /** @type {const} */ (["left", "center", "right"]).map((a) => btn("align-" + a, {
          class: "btn small icon-only align-btn", "aria-pressed": String(current === a), "aria-label": `Align ${a}`, title: `Align ${a}`,
          dataset: { align: a }, onclick: () => setStyle(ALIGN_TYPES, { align: a }),
        }, icon(a === "left" ? "alignLeft" : a === "center" ? "alignCenter" : "alignRight", 16)))));
    }
    if (types.has("connector")) {
      const conns = objs.filter((o) => o.type === "connector");
      const routing = common(conns, (o) => o.routing);
      const start = common(conns, (o) => o.style.arrowStart);
      const end = common(conns, (o) => o.style.arrowEnd);
      const isConn = (/** @type {WhiteboardObject} */ o) => o.type === "connector";
      groups.push(h("div", { class: "style-group connector-group", role: "group", "aria-label": "Connector" },
        /** @type {const} */ (["straight", "elbow"]).map((r) => btn("routing-" + r, {
          class: "btn small icon-only routing-btn", "aria-pressed": String(routing === r), "aria-label": r === "straight" ? "Straight line" : "Elbow line",
          title: r === "straight" ? "Straight line" : "Elbow line", dataset: { routing: r },
          onclick: () => update(isConn, () => ({ routing: r })),
        }, icon(r, 16))),
        btn("arrow-start", {
          class: "btn small icon-only arrow-start-btn", "aria-pressed": String(start === "arrow"), "aria-label": "Arrow at start", title: "Arrow at start",
          onclick: () => update(isConn, () => ({ style: { arrowStart: start === "arrow" ? "none" : "arrow" } })),
        }, icon("arrowStart", 16)),
        btn("arrow-end", {
          class: "btn small icon-only arrow-end-btn", "aria-pressed": String(end === "arrow"), "aria-label": "Arrow at end", title: "Arrow at end",
          onclick: () => update(isConn, () => ({ style: { arrowEnd: end === "arrow" ? "none" : "arrow" } })),
        }, icon("arrowEnd", 16)),
      ));
    }
    if (objs.some(MOVABLE)) {
      groups.push(h("div", { class: "style-group move-group", role: "group", "aria-label": "Move" },
        h("span", { class: "style-group-label", "aria-hidden": "true" }, "Move"),
        btn("move-left", { class: "btn small icon-only move-left", "aria-label": "Move left", title: "Move left (Arrow key)", onclick: () => nudge(-NUDGE, 0) }, icon("arrowLeft", 16)),
        btn("move-up", { class: "btn small icon-only move-up", "aria-label": "Move up", title: "Move up (Arrow key)", onclick: () => nudge(0, -NUDGE) }, icon("arrowUp", 16)),
        btn("move-down", { class: "btn small icon-only move-down", "aria-label": "Move down", title: "Move down (Arrow key)", onclick: () => nudge(0, NUDGE) }, icon("arrowDown", 16)),
        btn("move-right", { class: "btn small icon-only move-right", "aria-label": "Move right", title: "Move right (Arrow key)", onclick: () => nudge(NUDGE, 0) }, icon("arrowRight", 16)),
      ));
    }
    groups.push(h("div", { class: "style-group arrange-group", role: "group", "aria-label": "Arrange" },
      objs.length === 1 && TEXT_TYPES.has(objs[0].type)
        ? btn("edit-text", { class: "btn small icon-only edit-text-btn", "aria-label": "Edit text", title: "Edit text (Enter)", onclick: editText }, icon("edit", 16))
        : null,
      btn("front", { class: "btn small icon-only front-btn", "aria-label": "Bring to front", title: "Bring to front", onclick: () => reorder("front") }, icon("front", 16)),
      btn("back", { class: "btn small icon-only back-btn", "aria-label": "Send to back", title: "Send to back", onclick: () => reorder("back") }, icon("back", 16)),
      btn("duplicate", { class: "btn small icon-only duplicate-btn", "aria-label": "Duplicate", title: `Duplicate`, onclick: duplicate }, icon("copy", 16)),
      btn("delete", { class: "btn small icon-only delete-btn danger-text", "aria-label": "Delete", title: "Delete (Delete key)", onclick: remove }, icon("trash", 16)),
    ));

    const wasHidden = el.hidden;
    el.replaceChildren(...groups);
    el.hidden = false;
    if (wasHidden) app.onStyleBarToggle?.(true);
    if (focusKey) {
      const again = /** @type {HTMLElement|null} */ (el.querySelector(`[data-key="${focusKey}"]`));
      again?.focus({ preventScroll: true });
    }
  }

  /**
   * Context menu for the selection (right-click or long-press on the canvas).
   * @param {{x: number, y: number}} at  client coordinates
   */
  function openContextMenu(at) {
    const objs = selected();
    /** @type {{label: string, onSelect: () => void, danger?: boolean, className?: string}[]} */
    const items = [];
    if (objs.length) {
      if (objs.length === 1 && TEXT_TYPES.has(objs[0].type)) items.push({ label: "Edit text", className: "ctx-edit", onSelect: editText });
      items.push({ label: "Style…", className: "ctx-style", onSelect: () => focusFirst() });
      items.push({ label: "Duplicate", className: "ctx-duplicate", onSelect: duplicate });
      items.push({ label: "Bring to front", className: "ctx-front", onSelect: () => reorder("front") });
      items.push({ label: "Send to back", className: "ctx-back", onSelect: () => reorder("back") });
      items.push({ label: "Delete", className: "ctx-delete", danger: true, onSelect: remove });
    } else {
      items.push({ label: "Add sticky note", className: "ctx-add-sticky", onSelect: () => { canvas.addAtCenter("sticky"); } });
      items.push({ label: "Zoom to fit", className: "ctx-fit", onSelect: () => canvas.zoomToFit() });
      items.push({ label: "Objects list", className: "ctx-outline", onSelect: () => app.toggleOutline() });
    }
    openMenu({ x: at.x, y: at.y, returnFocus: canvas.element }, items, { label: objs.length ? "Selection actions" : "Board actions" });
  }

  function focusFirst() {
    render();
    /** @type {HTMLElement|null} */ (el.querySelector("button"))?.focus();
  }

  return { el, render, openContextMenu, focusFirst, nudge, closePopover };
}
