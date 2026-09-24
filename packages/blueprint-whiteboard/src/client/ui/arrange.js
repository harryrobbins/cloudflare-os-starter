// @ts-check
// Align, Distribute and Reconnect for the style bar and the selection's actions menu.
//
//   Align (2+ units: selected objects, a selected frame counting once with its members) and
//   Distribute (3+ units) change every moved object in ONE store call, so one undo reverses them.
//   Reconnect start / end (one connector selected) opens a searchable object picker and moves that
//   end of the connector to the chosen object: the keyboard path for dragging an endpoint handle.

import { h } from "./dom.js";
import { ALIGN_LABELS, DISTRIBUTE_LABELS } from "../model/alignment.js";
import { arrangeUnits } from "./canvas/index.js";
import { openObjectPicker, reconnectOptions } from "./object-picker.js";
import { openMenu } from "./dialogs.js";
import { describeObject } from "./outline.js";

/** @typedef {import("./app.js").App} App */
/** @typedef {import("../../shared/protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {import("../model/alignment.js").AlignMode} AlignMode */
/** @typedef {{label: string, onSelect: () => void, danger?: boolean, className?: string}} MenuItem */

const SVG_NS = "http://www.w3.org/2000/svg";
/** 24x24 stroke icons in the style of dom.js's set. */
const ICONS = {
  "align-left": "M4 3v18M8 7h12M8 13h7",
  "align-center": "M12 3v18M5 7h14M8 13h8",
  "align-right": "M20 3v18M4 7h12M9 13h7",
  "align-top": "M3 4h18M7 8v12M13 8v7",
  "align-middle": "M3 12h18M7 5v14M13 8v8",
  "align-bottom": "M3 20h18M7 4v12M13 9v7",
  "distribute-horizontal": "M4 4v16M20 4v16M10 8h4v8h-4z",
  "distribute-vertical": "M4 4h16M4 20h16M8 10h8v4H8z",
  "reconnect-start": "M5 12h14M5 9v6M16 9l3 3-3 3",
  "reconnect-end": "M5 12h14M19 9v6M8 9l-3 3 3 3",
};

/** @param {keyof typeof ICONS} name @param {number} [size] */
export function arrangeIcon(name, size = 16) {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": 2,
    "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
  })) svg.setAttribute(k, String(v));
  svg.classList.add("icon");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICONS[name]);
  svg.appendChild(path);
  return svg;
}

/** Spoken result of an Align command. @param {AlignMode} mode @param {number} moved */
export function alignMessage(mode, moved) {
  if (!moved) return "Already aligned";
  const what = { left: "left edges", center: "horizontal centres", right: "right edges", top: "top edges", middle: "vertical middles", bottom: "bottom edges" }[mode];
  return `Aligned ${what}, ${moved === 1 ? "1 object moved" : `${moved} objects moved`}`;
}

/** Spoken result of a Distribute command. @param {"horizontal"|"vertical"} axis @param {number} moved */
export function distributeMessage(axis, moved) {
  if (!moved) return "Already evenly spaced";
  return `Distributed ${axis === "horizontal" ? "horizontally" : "vertically"}, ${moved === 1 ? "1 object moved" : `${moved} objects moved`}`;
}

/**
 * Which arrange commands fit a selection: align needs 2 units, distribute 3, reconnect exactly one
 * connector.
 * @param {Record<string, WhiteboardObject>} objects @param {string[]} ids
 */
export function arrangeAvailability(objects, ids) {
  const units = arrangeUnits(objects, ids).length;
  const single = ids.length === 1 ? objects[ids[0]] : undefined;
  return { align: units >= 2, distribute: units >= 3, reconnect: single?.type === "connector" };
}

/** @param {App} app */
export function createArrange(app) {
  const { store, canvas } = app;

  /** @param {AlignMode} mode */
  function align(mode) {
    app.announce(alignMessage(mode, canvas.align(mode)));
  }

  /** @param {"horizontal"|"vertical"} axis */
  function distribute(axis) {
    app.announce(distributeMessage(axis, canvas.distribute(axis)));
  }

  /**
   * @param {"from"|"to"} end @param {HTMLElement|null} [returnFocus]
   */
  async function reconnect(end, returnFocus = null) {
    const ids = canvas.getSelection();
    const objects = store.getState().board.objects;
    const conn = ids.length === 1 ? objects[ids[0]] : undefined;
    if (!conn || conn.type !== "connector") return;
    const which = end === "from" ? "start" : "end";
    const options = reconnectOptions(objects, conn, end);
    if (!options.length) { app.announce("There is no other object to connect to"); return; }
    const chosen = await openObjectPicker({
      title: `Reconnect ${which} to`, options, returnFocus: returnFocus ?? canvas.element,
    });
    if (!chosen) return;
    const now = store.getState().board.objects;
    if (!now[conn.id]) { app.announce("That connector was deleted"); return; }
    if (canvas.reconnect(conn.id, end, chosen)) {
      const target = now[chosen];
      app.announce(`Connector ${which} moved to ${target ? describeObject(target, now) : "the chosen object"}`);
    } else if (now[conn.id][end] !== chosen) {
      app.announce("Connector not changed: that object is no longer available");
    }
  }

  /**
   * Style bar groups for the selection.
   * @param {WhiteboardObject[]} objs
   * @param {(key: string, attrs: Record<string, any>, ...children: any[]) => HTMLElement} btn
   * @returns {HTMLElement[]}
   */
  function groups(objs, btn) {
    const objects = store.getState().board.objects;
    const can = arrangeAvailability(objects, objs.map((o) => o.id));
    const out = [];
    if (can.align) {
      const modes = /** @type {AlignMode[]} */ (["left", "center", "right", "top", "middle", "bottom"]);
      out.push(h("div", { class: "style-group arrange-align-group", role: "group", "aria-label": "Align and distribute" },
        modes.map((m) => btn("align-objects-" + m, {
          class: "btn small icon-only align-objects-btn", "aria-label": ALIGN_LABELS[m], title: ALIGN_LABELS[m],
          dataset: { alignObjects: m }, onclick: () => align(m),
        }, arrangeIcon(/** @type {keyof typeof ICONS} */ ("align-" + m)))),
        can.distribute ? /** @type {const} */ (["horizontal", "vertical"]).map((a) => btn("distribute-" + a, {
          class: "btn small icon-only distribute-btn", "aria-label": DISTRIBUTE_LABELS[a], title: DISTRIBUTE_LABELS[a],
          dataset: { distribute: a }, onclick: () => distribute(a),
        }, arrangeIcon(/** @type {keyof typeof ICONS} */ ("distribute-" + a)))) : null,
      ));
    }
    if (can.reconnect) {
      out.push(h("div", { class: "style-group reconnect-group", role: "group", "aria-label": "Connector ends" },
        /** @type {const} */ (["from", "to"]).map((end) => {
          const label = end === "from" ? "Reconnect start" : "Reconnect end";
          /** @type {HTMLElement} */
          const b = btn("reconnect-" + end, {
            class: "btn small icon-only reconnect-btn", "aria-label": `${label}…`, title: `${label} (or drag the ${end === "from" ? "start" : "end"} handle)`,
            "aria-haspopup": "dialog", dataset: { end },
            onclick: () => reconnect(end, b),
          }, arrangeIcon(end === "from" ? "reconnect-start" : "reconnect-end"));
          return b;
        }),
      ));
    }
    return out;
  }

  /**
   * Actions-menu items for the selection: Reconnect start / end, and one "Align or distribute…"
   * item that opens a second menu with the eight commands at the same place.
   * @param {WhiteboardObject[]} objs
   * @param {Parameters<typeof openMenu>[0]} [anchor]  where the actions menu was opened
   * @returns {MenuItem[]}
   */
  function menuItems(objs, anchor) {
    const objects = store.getState().board.objects;
    const can = arrangeAvailability(objects, objs.map((o) => o.id));
    /** @type {MenuItem[]} */
    const items = [];
    if (can.reconnect) {
      items.push({ label: "Reconnect start…", className: "ctx-reconnect-from", onSelect: () => { reconnect("from"); } });
      items.push({ label: "Reconnect end…", className: "ctx-reconnect-to", onSelect: () => { reconnect("to"); } });
    }
    if (can.align) {
      const sub = arrangeMenuItems(can.distribute);
      items.push({
        label: "Align or distribute…", className: "ctx-arrange",
        onSelect: () => { openMenu(anchor ?? canvas.element, sub, { label: "Align and distribute" }); },
      });
    }
    return items;
  }

  /** @param {boolean} withDistribute @returns {MenuItem[]} */
  function arrangeMenuItems(withDistribute) {
    /** @type {MenuItem[]} */
    const items = [];
    for (const m of /** @type {AlignMode[]} */ (["left", "center", "right", "top", "middle", "bottom"])) {
      items.push({ label: ALIGN_LABELS[m], className: "ctx-align-" + m, onSelect: () => align(m) });
    }
    if (withDistribute) {
      for (const a of /** @type {const} */ (["horizontal", "vertical"])) {
        items.push({ label: DISTRIBUTE_LABELS[a], className: "ctx-distribute-" + a, onSelect: () => distribute(a) });
      }
    }
    return items;
  }

  return { align, distribute, reconnect, groups, menuItems };
}
