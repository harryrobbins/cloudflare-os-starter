// @ts-check
// A small static template gallery. Each template is a versioned portable document
// (src/shared/backup.js), so inserting one goes through the same reader, caps and id remapping as
// a paste, and becomes ordinary creates in ONE undo step.

import { COLORS } from "../../shared/protocol.js";
import { BACKUP_FORMAT, BACKUP_VERSION, parseBackup } from "../../shared/backup.js";
import { h } from "./dom.js";
import { modal } from "./dialogs.js";

/** @typedef {import("../../shared/backup.js").BackupDocument} BackupDocument */

/**
 * @typedef {object} Template
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {BackupDocument} doc
 */

let seq = 0;
/** @param {string} type @param {Record<string, any>} fields */
function o(type, fields) {
  return { id: fields.id ?? `${type}${++seq}`, type, rot: 0, text: "", ...fields };
}
const sticky = (/** @type {Record<string, any>} */ f, /** @type {string} */ fill = COLORS.yellow) =>
  o("sticky", { w: 200, h: 200, ...f, style: { fill, fontSize: 20, ...(f.style ?? {}) } });
const label = (/** @type {Record<string, any>} */ f, fontSize = 32) =>
  o("text", { w: 600, h: Math.round(fontSize * 1.8), ...f, style: { fill: "none", fontSize, align: "left" } });
const frame = (/** @type {Record<string, any>} */ f) => o("frame", { ...f, style: { fill: "#ffffff", stroke: "#9ca3af", strokeWidth: 1, fontSize: 18 } });
const box = (/** @type {Record<string, any>} */ { shape, ...f }, fill = "#ffffff") =>
  o(f.type ?? "rect", { w: 220, h: 110, ...f, style: { fill, stroke: "#1f2937", strokeWidth: 2, fontSize: 20, align: "center", ...(shape ? { shape } : {}) } });
const link = (/** @type {string} */ from, /** @type {string} */ to, text = "", /** @type {Record<string, any>} */ extra = {}) =>
  o("connector", { from, to, text, routing: "straight", ...extra, style: { stroke: "#1f2937", strokeWidth: 2, arrowEnd: "arrow", ...extra.style } });
const table = (/** @type {Record<string, any>} */ f) =>
  o("table", { w: 320, header: true, ...f, h: f.cells.length * 40, style: { fill: "#ffffff", stroke: "#6b7280", strokeWidth: 1, fontSize: 16, align: "left" } });

/** @param {any[]} objects @returns {BackupDocument} */
const doc = (objects) => ({ format: BACKUP_FORMAT, version: BACKUP_VERSION, objects });

function brainstorm() {
  const f = frame({ id: "f", x: 0, y: 0, w: 1400, h: 960, text: "Brainstorm" });
  const topic = box({ id: "topic", type: "ellipse", x: 580, y: 400, w: 240, h: 150, text: "Topic", frameId: "f" }, COLORS.blue);
  const ring = [[140, 140], [600, 120], [1060, 140], [1100, 400], [1060, 660], [600, 700], [140, 660], [100, 400]];
  const ideas = ring.map(([x, y], i) => sticky({ id: `i${i}`, x, y, text: `Idea ${i + 1}`, frameId: "f" }));
  return doc([f,
    label({ id: "q", x: 40, y: 40, w: 900, text: "What are we trying to solve?", frameId: "f" }),
    topic, ...ideas]);
}

function retrospective() {
  const cols = [["Went well", COLORS.green], ["To improve", COLORS.orange], ["Actions", COLORS.blue]];
  /** @type {any[]} */
  const out = [];
  cols.forEach(([name, fill], i) => {
    const x = i * 560;
    out.push(frame({ id: `c${i}`, x, y: 0, w: 520, h: 820, text: name }));
    out.push(sticky({ id: `h${i}`, x: x + 40, y: 40, w: 440, h: 120, text: name, frameId: `c${i}`, style: { fontSize: 32 } }, fill));
    for (let j = 0; j < 4; j++) {
      out.push(sticky({ id: `n${i}${j}`, x: x + 40 + (j % 2) * 240, y: 200 + Math.floor(j / 2) * 240, text: "", frameId: `c${i}` }, fill));
    }
  });
  return doc(out);
}

function journeyMap() {
  const stages = ["Discover", "Consider", "Buy", "Use", "Recommend"];
  const rows = [["Actions", COLORS.yellow], ["Thoughts", COLORS.blue], ["Feelings", COLORS.pink], ["Pain points", COLORS.red], ["Opportunities", COLORS.green]];
  /** @type {any[]} */
  const out = [frame({ id: "f", x: 0, y: 0, w: 280 + stages.length * 260, h: 180 + rows.length * 200, text: "Customer journey" })];
  stages.forEach((s, i) => out.push(label({ id: `s${i}`, x: 280 + i * 260, y: 60, w: 220, text: s, frameId: "f" }, 28)));
  rows.forEach(([r, fill], j) => {
    const y = 160 + j * 200;
    out.push(label({ id: `r${j}`, x: 40, y: y + 60, w: 220, text: r, frameId: "f" }, 24));
    stages.forEach((_, i) => out.push(sticky({ id: `c${j}${i}`, x: 280 + i * 260, y, w: 200, h: 160, frameId: "f" }, fill)));
  });
  return doc(out);
}

function architecture() {
  const f = frame({ id: "f", x: 0, y: 0, w: 1500, h: 800, text: "Architecture sketch" });
  const nodes = [
    box({ id: "users", type: "ellipse", x: 60, y: 320, w: 200, h: 120, text: "Users", frameId: "f" }, COLORS.gray),
    box({ id: "web", x: 380, y: 325, text: "Web app", frameId: "f" }, COLORS.blue),
    box({ id: "api", x: 700, y: 325, text: "API", frameId: "f" }, COLORS.purple),
    box({ id: "db", shape: "cylinder", x: 1100, y: 120, w: 150, h: 180, text: "Database", frameId: "f" }, COLORS.green),
    box({ id: "queue", shape: "queue", x: 1060, y: 490, w: 240, h: 100, text: "Queue", frameId: "f" }, COLORS.orange),
    box({ id: "worker", x: 700, y: 600, text: "Worker", frameId: "f" }, COLORS.teal),
  ];
  return doc([f, ...nodes,
    link("users", "web", "uses"), link("web", "api", "HTTPS"), link("api", "db", "reads, writes"),
    link("api", "queue", "enqueues"), link("queue", "worker", "delivers"), link("worker", "db")]);
}

function flowchart() {
  const f = frame({ id: "f", x: 0, y: 0, w: 1240, h: 1080, text: "Flowchart" });
  const elbow = (/** @type {string} */ a, /** @type {string} */ b, text = "", sides = {}) => link(a, b, text, { routing: "elbow", ...sides });
  return doc([f,
    box({ id: "start", shape: "pill", x: 420, y: 60, w: 200, h: 80, text: "Start", frameId: "f" }, COLORS.green),
    box({ id: "input", shape: "parallelogram", x: 400, y: 200, w: 240, h: 100, text: "Get request", frameId: "f" }),
    box({ id: "check", shape: "diamond", x: 410, y: 360, w: 220, h: 140, text: "Valid?", frameId: "f" }, COLORS.yellow),
    box({ id: "fix", x: 820, y: 200, w: 220, h: 100, text: "Ask for changes", frameId: "f" }, COLORS.orange),
    box({ id: "save", shape: "subprocess", x: 410, y: 560, w: 220, h: 110, text: "Process it", frameId: "f" }, COLORS.blue),
    box({ id: "store", shape: "cylinder", x: 120, y: 540, w: 160, h: 150, text: "Records", frameId: "f" }, COLORS.gray),
    box({ id: "report", shape: "document", x: 410, y: 730, w: 220, h: 120, text: "Send receipt", frameId: "f" }),
    box({ id: "end", shape: "pill", x: 420, y: 920, w: 200, h: 80, text: "Done", frameId: "f" }, COLORS.red),
    elbow("start", "input"), elbow("input", "check"), elbow("check", "save", "yes"), elbow("check", "fix", "no", { fromSide: "right", toSide: "bottom" }),
    elbow("fix", "input", "", { fromSide: "left", toSide: "right" }), elbow("save", "store", "writes"), elbow("save", "report"), elbow("report", "end"),
  ]);
}

function dataModel() {
  const f = frame({ id: "f", x: 0, y: 0, w: 1300, h: 640, text: "Data model" });
  const er = (/** @type {string} */ a, /** @type {string} */ b, text = "") =>
    link(a, b, text, { routing: "elbow", style: { arrowStart: "bar", arrowEnd: "crow" } });
  return doc([f,
    table({ id: "customer", x: 60, y: 80, frameId: "f", cells: [["Customer", "Type"], ["id", "uuid"], ["name", "text"], ["email", "text"]] }),
    table({ id: "order", x: 500, y: 80, frameId: "f", cells: [["Order", "Type"], ["id", "uuid"], ["customer_id", "uuid"], ["placed_at", "timestamp"], ["status", "text"]] }),
    table({ id: "line", x: 500, y: 380, frameId: "f", cells: [["Order line", "Type"], ["order_id", "uuid"], ["product_id", "uuid"], ["quantity", "int"]] }),
    table({ id: "product", x: 940, y: 380, frameId: "f", cells: [["Product", "Type"], ["id", "uuid"], ["name", "text"], ["price", "numeric"]] }),
    er("customer", "order", "places"), er("order", "line", "contains"), er("product", "line", "appears in"),
  ]);
}

/** @type {readonly Template[]} */
export const TEMPLATES = Object.freeze([
  { id: "brainstorm", name: "Brainstorm", description: "A topic in the middle with ideas around it", doc: brainstorm() },
  { id: "retrospective", name: "Retrospective", description: "Went well, to improve and actions, each in a frame", doc: retrospective() },
  { id: "journey", name: "Journey map", description: "Stages across, actions, thoughts, feelings, pain points and opportunities down", doc: journeyMap() },
  { id: "architecture", name: "Architecture sketch", description: "Boxes, a database and a queue for a simple system", doc: architecture() },
  { id: "flowchart", name: "Flowchart", description: "Start, input, a decision, a subprocess, a database and a document, with elbow arrows", doc: flowchart() },
  { id: "data-model", name: "Data model", description: "Tables for entities, joined by one-to-many (crow's foot) connectors", doc: dataModel() },
]);

/**
 * Inserts a template at the centre of the view as one undo step, selects it and fits it in view.
 * @param {import("./app.js").App} app
 * @param {{place: (entries: import("../../shared/backup.js").Entry[]) => string[]}} clipboard
 * @param {string} id
 * @returns {string[]} the new ids
 */
export function insertTemplate(app, clipboard, id) {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) return [];
  const parsed = parseBackup(t.doc);
  if ("error" in parsed) return [];
  const ids = clipboard.place(parsed.entries);
  if (ids.length) {
    app.canvas.fitObjects(ids, { padding: 60 });
    app.announce(`Added the ${t.name} template, ${ids.length} objects`);
  }
  return ids;
}

/**
 * The gallery: resolves with the chosen template id, or null.
 * @param {HTMLElement|null} [returnFocus]
 * @returns {Promise<string|null>}
 */
export function chooseTemplate(returnFocus = null) {
  return modal((close) => h("div", { class: "modal wb-templates", "aria-labelledby": "wb-templates-title" },
    h("h2", { id: "wb-templates-title" }, "Choose a template"),
    h("p", null, "The template is added in the middle of your view. Undo removes it again."),
    h("ul", { class: "wb-template-list" },
      TEMPLATES.map((t, i) => h("li", null, h("button", {
        type: "button", class: "btn outline wb-template", dataset: { template: t.id }, "data-autofocus": i === 0 || undefined,
        onclick: () => close(t.id),
      }, h("strong", null, t.name), h("span", { class: "muted" }, t.description))))),
    h("div", { class: "modal-actions" }, h("button", { type: "button", class: "btn outline", onclick: () => close(null) }, "Cancel")),
  ), null, returnFocus);
}
