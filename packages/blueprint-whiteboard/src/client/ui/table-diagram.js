// @ts-check
// Style bar groups and actions-menu items for tables and diagrams.
//
// Tables: rows and columns in and out (at the cell being edited, else at the end), header row,
// fit columns to their text, edit cells, copy as Markdown. Diagrams: D2 or Mermaid, layout
// engine, sketch and dark styles, edit source, fit the box to the drawing, render again, copy
// source. Each applies to the selected objects of that type in ONE store call.

import { h } from "./dom.js";
import { showToast } from "./dialogs.js";
import { writeClipboard } from "./clipboard.js";
import { textWidth } from "../../shared/geometry.js";
import { insertRow, removeRow, insertColumn, removeColumn, fitColumns, tableToMarkdown, cellsOf } from "../../shared/table.js";
import { DIAGRAM_EXAMPLES, svgSize } from "../../shared/diagram.js";

/** @typedef {import("./app.js").App} App */
/** @typedef {import("../../shared/protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {(key: string, attrs: Record<string, any>, ...children: any[]) => HTMLElement} Btn */

const LAYOUT_LABELS = Object.freeze({ dagre: "Dagre", elk: "ELK", tala: "TALA" });

/** @param {App} app */
export function createTableDiagramControls(app) {
  const { store, canvas } = app;

  /** @param {string} type @returns {WhiteboardObject[]} */
  const selectedOf = (type) => {
    const objects = store.getState().board.objects;
    return canvas.getSelection().map((id) => objects[id]).filter((o) => o?.type === type);
  };

  /** @param {string} text @param {string} what */
  function copy(text, what) {
    if (writeClipboard(text)) {
      showToast(`${what} copied`, { timeout: 3000 });
      app.announce(`${what} copied`);
    } else {
      showToast("Copying was blocked here", { timeout: 4000 });
      app.announce("Copying was blocked here");
    }
  }

  // ---- tables ------------------------------------------------------------------------------

  /**
   * Applies `edit` to each selected table; the edit gets the cell being edited in that table (or
   * null) and returns a patch or null.
   * @param {(o: WhiteboardObject, cell: {r: number, c: number}|null) => Record<string, any>|null} edit
   * @param {string} message @param {string} [limit]  said when no table could change
   */
  function editTables(edit, message, limit) {
    const editing = canvas.getTextEdit?.();
    const updates = [];
    for (const o of selectedOf("table")) {
      const cell = editing && editing.id === o.id ? editing.cell ?? null : null;
      const patch = edit(o, cell);
      if (patch) updates.push({ id: o.id, patch });
    }
    if (!updates.length) { if (limit) app.announce(limit); return; }
    if (editing) canvas.finishTextEdit?.();
    store.updateObjects(updates);
    app.announce(message);
  }

  /** @param {WhiteboardObject[]} objs @param {Btn} btn */
  function tableGroup(objs, btn) {
    const tables = objs.filter((o) => o.type === "table");
    if (!tables.length) return null;
    const header = tables.every((o) => o.header);
    const one = tables.length === 1 ? tables[0] : null;
    const size = one ? `${cellsOf(one).length} × ${cellsOf(one)[0].length}` : "";
    return h("div", { class: "style-group table-group", role: "group", "aria-label": "Table" },
      one ? h("span", { class: "style-group-label table-size", "aria-label": `${cellsOf(one).length} rows, ${cellsOf(one)[0].length} columns` }, size) : null,
      btn("table-add-row", {
        class: "btn small table-add-row", title: "Add a row (below the cell being edited, else at the end)", "aria-label": "Add row",
        onclick: () => editTables((o, cell) => insertRow(o, cell ? cell.r + 1 : cellsOf(o).length), "Row added", "The table has the most rows it can"),
      }, "+ Row"),
      btn("table-remove-row", {
        class: "btn small table-remove-row", title: "Remove a row (the one being edited, else the last)", "aria-label": "Remove row",
        onclick: () => editTables((o, cell) => removeRow(o, cell ? cell.r : cellsOf(o).length - 1), "Row removed", "A table keeps at least one row"),
      }, "− Row"),
      btn("table-add-col", {
        class: "btn small table-add-col", title: "Add a column (right of the cell being edited, else at the end)", "aria-label": "Add column",
        onclick: () => editTables((o, cell) => insertColumn(o, cell ? cell.c + 1 : cellsOf(o)[0].length), "Column added", "The table has the most columns it can"),
      }, "+ Col"),
      btn("table-remove-col", {
        class: "btn small table-remove-col", title: "Remove a column (the one being edited, else the last)", "aria-label": "Remove column",
        onclick: () => editTables((o, cell) => removeColumn(o, cell ? cell.c : cellsOf(o)[0].length - 1), "Column removed", "A table keeps at least one column"),
      }, "− Col"),
      btn("table-header", {
        class: "btn small table-header-btn", "aria-pressed": String(header), title: "First row is a header", "aria-label": "Header row",
        onclick: () => editTables(() => ({ header: !header }), header ? "Header row off" : "Header row on"),
      }, "Header"),
      btn("table-fit", {
        class: "btn small table-fit-btn", title: "Fit column widths to their text", "aria-label": "Fit columns",
        onclick: () => editTables((o) => ({ colWidths: fitColumns(o, textWidth) }), "Columns fitted"),
      }, "Fit"),
      one ? btn("table-copy", {
        class: "btn small table-copy-btn", title: "Copy the table as Markdown", "aria-label": "Copy as Markdown",
        onclick: () => copy(tableToMarkdown(one), "Table"),
      }, "Copy") : null,
    );
  }

  // ---- diagrams ----------------------------------------------------------------------------

  /** @param {(o: WhiteboardObject) => Record<string, any>|null} patchFor @param {string} message */
  function editDiagrams(patchFor, message) {
    const updates = selectedOf("diagram").map((o) => ({ id: o.id, patch: patchFor(o) })).filter((u) => u.patch);
    if (!updates.length) return;
    store.updateObjects(/** @type {any} */ (updates));
    app.announce(message);
  }

  /**
   * Switching language swaps a starter example for the other language's; any other source is
   * kept (it then needs rewriting, which the placeholder's error says).
   * @param {"d2"|"mermaid"} syntax
   */
  function setSyntax(syntax) {
    editDiagrams((o) => {
      if (o.syntax === syntax) return null;
      const example = /** @type {string[]} */ (Object.values(DIAGRAM_EXAMPLES)).includes(o.text) || !o.text.trim();
      return example ? { syntax, text: DIAGRAM_EXAMPLES[syntax] } : { syntax };
    }, syntax === "mermaid" ? "Mermaid" : "D2");
  }

  /** Sets each diagram's height so the box has its drawing's proportions. */
  function fitToDrawing() {
    editDiagrams((o) => {
      const r = canvas.getDiagramRender?.(o.id);
      const size = r?.href ? svgSize(atob(r.href.slice(r.href.indexOf(",") + 1))) : null;
      if (!size) return null;
      const pad = Math.min(12, o.w / 10, o.h / 10);
      const height = Math.round(((o.w - 2 * pad) * size.h) / size.w + 2 * pad);
      return height !== o.h ? { h: Math.max(40, height) } : null;
    }, "Fitted to the drawing");
  }

  /** @param {WhiteboardObject[]} objs @param {Btn} btn */
  function diagramGroup(objs, btn) {
    const ds = objs.filter((o) => o.type === "diagram");
    if (!ds.length) return null;
    const same = (/** @type {(o: WhiteboardObject) => any} */ get) => (ds.every((o) => get(o) === get(ds[0])) ? get(ds[0]) : null);
    const syntax = same((o) => o.syntax), layout = same((o) => o.layout);
    const sketch = same((o) => !!o.sketch) === true, dark = same((o) => o.theme) === "dark";
    const one = ds.length === 1 ? ds[0] : null;
    const status = one ? canvas.getDiagramRender?.(one.id)?.status : null;
    return h("div", { class: "style-group diagram-group", role: "group", "aria-label": "Diagram" },
      /** @type {const} */ (["d2", "mermaid"]).map((s) => btn("diagram-syntax-" + s, {
        class: "btn small diagram-syntax-btn", "aria-pressed": String(syntax === s), dataset: { syntax: s },
        title: s === "d2" ? "D2 source" : "Mermaid source", onclick: () => setSyntax(s),
      }, s === "d2" ? "D2" : "Mermaid")),
      /** @type {const} */ (["dagre", "elk", "tala"]).map((l) => btn("diagram-layout-" + l, {
        class: "btn small diagram-layout-btn", "aria-pressed": String(layout === l), dataset: { layout: l },
        title: `${LAYOUT_LABELS[l]} layout`, "aria-label": `${LAYOUT_LABELS[l]} layout`,
        onclick: () => editDiagrams((o) => (o.layout === l ? null : { layout: l }), `${LAYOUT_LABELS[l]} layout`),
      }, LAYOUT_LABELS[l])),
      btn("diagram-sketch", {
        class: "btn small diagram-sketch-btn", "aria-pressed": String(sketch), title: "Hand-drawn style", "aria-label": "Sketch style",
        onclick: () => editDiagrams(() => ({ sketch: !sketch }), sketch ? "Sketch style off" : "Sketch style on"),
      }, "Sketch"),
      btn("diagram-dark", {
        class: "btn small diagram-dark-btn", "aria-pressed": String(dark), title: "Dark theme", "aria-label": "Dark theme",
        onclick: () => editDiagrams(() => ({ theme: dark ? "light" : "dark", style: { fill: dark ? "#ffffff" : "#111827" } }), dark ? "Light theme" : "Dark theme"),
      }, "Dark"),
      one ? [
        btn("diagram-edit", {
          class: "btn small diagram-edit-btn", title: "Edit the source (Enter)", "aria-label": "Edit source",
          onclick: () => canvas.editText(one.id),
        }, "Source"),
        status === "ok" ? btn("diagram-fit", {
          class: "btn small diagram-fit-btn", title: "Fit the box to the drawing's proportions", "aria-label": "Fit to drawing",
          onclick: fitToDrawing,
        }, "Fit") : null,
        btn("diagram-render", {
          class: "btn small diagram-render-btn", title: "Render again", "aria-label": "Render again",
          onclick: () => { canvas.refreshDiagram?.(one.id); app.announce("Rendering"); },
        }, "Render"),
      ] : null,
    );
  }

  /** @param {WhiteboardObject[]} objs @param {Btn} btn */
  function groups(objs, btn) {
    return [tableGroup(objs, btn), diagramGroup(objs, btn)].filter(Boolean);
  }

  /** Actions menu items for one selected table or diagram. @param {WhiteboardObject[]} objs */
  function menuItems(objs) {
    if (objs.length !== 1) return [];
    const o = objs[0];
    if (o.type === "table") return [{ label: "Copy table as Markdown", className: "ctx-copy-table", onSelect: () => copy(tableToMarkdown(o), "Table") }];
    if (o.type === "diagram") {
      return [
        { label: "Edit source", className: "ctx-diagram-source", onSelect: () => canvas.editText(o.id) },
        { label: "Render again", className: "ctx-diagram-render", onSelect: () => canvas.refreshDiagram?.(o.id) },
        { label: "Copy source", className: "ctx-diagram-copy", onSelect: () => copy(o.text, "Source") },
      ];
    }
    return [];
  }

  return { groups, menuItems };
}
