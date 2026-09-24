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
const box = (/** @type {Record<string, any>} */ f, fill = "#ffffff") =>
  o(f.type ?? "rect", { w: 220, h: 110, ...f, style: { fill, stroke: "#1f2937", strokeWidth: 2, fontSize: 20, align: "center" } });
const link = (/** @type {string} */ from, /** @type {string} */ to, text = "") =>
  o("connector", { from, to, text, routing: "straight", style: { stroke: "#1f2937", strokeWidth: 2, arrowEnd: "arrow" } });

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
    box({ id: "db", x: 1060, y: 160, text: "Database", frameId: "f" }, COLORS.green),
    box({ id: "queue", x: 1060, y: 490, text: "Queue", frameId: "f" }, COLORS.orange),
    box({ id: "worker", x: 700, y: 600, text: "Worker", frameId: "f" }, COLORS.teal),
  ];
  return doc([f, ...nodes,
    link("users", "web", "uses"), link("web", "api", "HTTPS"), link("api", "db", "reads, writes"),
    link("api", "queue", "enqueues"), link("queue", "worker", "delivers"), link("worker", "db")]);
}

/** @type {readonly Template[]} */
export const TEMPLATES = Object.freeze([
  { id: "brainstorm", name: "Brainstorm", description: "A topic in the middle with ideas around it", doc: brainstorm() },
  { id: "retrospective", name: "Retrospective", description: "Went well, to improve and actions, each in a frame", doc: retrospective() },
  { id: "journey", name: "Journey map", description: "Stages across, actions, thoughts, feelings, pain points and opportunities down", doc: journeyMap() },
  { id: "architecture", name: "Architecture sketch", description: "Boxes and arrows for a simple system", doc: architecture() },
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
