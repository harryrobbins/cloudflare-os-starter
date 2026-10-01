// @ts-check
// The adapt block's side of the library: validates the `adapt` object from client.js (main.js)
// and builds the `app` handle that its actions and onReady receive. README.md ("Adapting this
// gadget") documents both; keep them in step.
//
// The handle offers the server's domain verbs (src/core/whiteboard.js) with the same names and
// argument shapes, applied through the client store: optimistic, synced in the background, and
// each call is ONE undo step for this viewer. They are synchronous and return what they made.

import { COLORS, OBJECT_TYPES, TYPE_DEFAULTS, cleanColor, compareObjects, newId } from "../../shared/protocol.js";
import { getPack } from "../../shared/icons/registry.js";

/** @typedef {import("../../shared/protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {import("../store-contract.js").Store} Store */
/** @typedef {import("./ui-contract.js").CanvasController} CanvasController */

/**
 * @typedef {object} AdaptAction
 * @property {string} id
 * @property {string} label   shown in the board menu and the right-click menu
 * @property {string} [title] tooltip
 * @property {(app: AppHandle) => unknown} run
 */

/**
 * @typedef {object} AdaptSettings  the validated adapt block
 * @property {Map<string, Record<string, string>>} newObjectColors  style per object type for new objects
 * @property {boolean} minimap
 * @property {string} styles
 * @property {AdaptAction[]} actions
 * @property {((app: AppHandle) => unknown)|null} onReady
 */

/** Types whose `color` is their fill; the rest (pen, connector, glyph icons) take it as their line. */
const FILL_TYPES = new Set(["sticky", "rect", "ellipse", "text", "frame"]);
const GAP = 40;

/** @param {unknown} v @returns {string|null} "#rrggbb" for a colour name or hex, else null */
export function resolveColor(v) {
  if (typeof v !== "string") return null;
  const key = v.trim().toLowerCase();
  if (Object.hasOwn(COLORS, key)) return /** @type {any} */ (COLORS)[key];
  return cleanColor(v.trim(), true);
}

/** @param {string} type @param {unknown} packId */
function colorKey(type, packId) {
  return FILL_TYPES.has(type) || (type === "icon" && getPack(/** @type {any} */ (packId))?.kind === "stencil") ? "fill" : "stroke";
}

/** @param {...unknown} args */
function warn(...args) {
  try { console.warn("[whiteboard adapt]", ...args); } catch { /* ignore */ }
}

/**
 * Validates the adapt block. Unknown keys are ignored; a bad field or action is reported in the
 * console and left out, never thrown.
 * @param {any} raw
 * @returns {AdaptSettings}
 */
export function normalizeAdapt(raw) {
  const a = raw && typeof raw === "object" ? raw : {};
  /** @type {AdaptSettings} */
  const out = { newObjectColors: new Map(), minimap: true, styles: "", actions: [], onReady: null };

  if (a.newObjectColors !== undefined) {
    if (!a.newObjectColors || typeof a.newObjectColors !== "object") warn("newObjectColors must be an object like { sticky: \"blue\" }");
    else {
      for (const [type, value] of Object.entries(a.newObjectColors)) {
        if (!OBJECT_TYPES.includes(/** @type {any} */ (type))) { warn(`newObjectColors: unknown object type ${type}`); continue; }
        /** @type {Record<string, string>} */
        const style = {};
        if (typeof value === "string") {
          const hex = resolveColor(value);
          if (hex) style[colorKey(type, undefined)] = hex;
          else warn(`newObjectColors.${type}: unknown colour ${value}`);
        } else if (value && typeof value === "object") {
          for (const k of ["fill", "stroke", "textColor"]) {
            if (/** @type {any} */ (value)[k] === undefined) continue;
            const hex = resolveColor(/** @type {any} */ (value)[k]);
            if (hex) style[k] = hex;
            else warn(`newObjectColors.${type}.${k}: unknown colour ${/** @type {any} */ (value)[k]}`);
          }
        }
        if (Object.keys(style).length) out.newObjectColors.set(type, style);
      }
    }
  }
  if (a.minimap !== undefined) out.minimap = a.minimap !== false;
  if (a.styles !== undefined) {
    if (typeof a.styles === "string") out.styles = a.styles;
    else warn("styles must be a string of CSS");
  }
  if (a.actions !== undefined) {
    if (!Array.isArray(a.actions)) warn("actions must be an array");
    else {
      const ids = new Set();
      a.actions.forEach((/** @type {any} */ action, /** @type {number} */ i) => {
        const where = `actions[${i}]`;
        if (!action || typeof action !== "object") return warn(`${where} is not an object`);
        const label = typeof action.label === "string" ? action.label.trim() : "";
        if (!label) return warn(`${where} needs a label`);
        if (typeof action.run !== "function") return warn(`${where} (${label}) needs a run(app) function`);
        const id = typeof action.id === "string" && action.id.trim() ? action.id.trim() : label;
        if (ids.has(id)) return warn(`${where}: duplicate id ${id}`);
        ids.add(id);
        out.actions.push({ id, label, title: typeof action.title === "string" ? action.title : undefined, run: action.run });
      });
    }
  }
  if (a.onReady !== undefined) {
    if (typeof a.onReady === "function") out.onReady = a.onReady;
    else warn("onReady must be a function");
  }
  return out;
}

/**
 * @typedef {object} AppHandle
 * @property {() => {title: string, background: string, objects: WhiteboardObject[]}} getBoard
 * @property {(filter?: {type?: string|string[], text?: string, frame?: string}) => WhiteboardObject[]} findObjects
 * @property {(args: {stickies: (string|{text: string, color?: string})[], frame?: string, at?: {x: number, y: number}, columns?: number, gap?: number}) => {created: WhiteboardObject[], errors: AppError[]}} addStickies
 * @property {(args: {objects: any[]}) => {created: WhiteboardObject[], errors: AppError[]}} addObjects
 * @property {(args: {from: string, to: string, label?: string, routing?: string, arrow?: string, color?: string}) => {connector: WhiteboardObject|null, errors: AppError[]}} connectObjects
 * @property {(args: {updates: {id: string, fields: Record<string, any>}[]}) => {errors: AppError[]}} updateObjects
 * @property {(args: {ids: string[], dx?: number, dy?: number}) => {errors: AppError[]}} moveObjects
 * @property {(args: {ids: string[], columns?: number, gap?: number, at?: {x: number, y: number}}) => {errors: AppError[]}} arrangeGrid
 * @property {(args: {ids: string[]}) => {errors: AppError[]}} deleteObjects
 * @property {() => string[]} getSelection
 * @property {(ids: string[]) => void} setSelection
 * @property {(ids: string[]) => void} showObjects
 * @property {() => {x: number, y: number, w: number, h: number}} getViewport
 * @property {(message: string) => void} toast
 * @property {(listener: (board: ReturnType<AppHandle["getBoard"]>) => void) => () => void} onChange
 */
/** @typedef {{index: number, message: string}} AppError */

/**
 * @param {object} o
 * @param {Store} o.store          the shell's store (its calls count as this viewer's own)
 * @param {CanvasController} o.canvas
 * @param {(message: string) => void} o.toast
 * @param {AbortSignal} [o.signal]
 * @returns {AppHandle}
 */
export function createAppHandle({ store, canvas, toast }) {
  const objects = () => store.getState().board.objects;
  const list = () => Object.values(objects()).sort(compareObjects);

  /** @param {unknown} ref @returns {string|null} */
  const frameId = (ref) => {
    if (typeof ref !== "string") return null;
    if (objects()[ref]?.type === "frame") return ref;
    const name = ref.trim().toLowerCase();
    return list().find((o) => o.type === "frame" && o.text.toLowerCase() === name)?.id ?? null;
  };

  /**
   * Friendly fields (color, frame) to raw ones, like the server's convenience methods.
   * @param {string} type @param {any} fields @param {number} index @param {AppError[]} errors
   * @returns {Record<string, any>|null}
   */
  const friendly = (type, fields, index, errors) => {
    const { color, frame, ...rest } = fields && typeof fields === "object" ? fields : /** @type {any} */ ({});
    /** @type {Record<string, any>} */
    const out = { ...rest };
    if (color !== undefined) {
      const hex = resolveColor(color);
      if (!hex) { errors.push({ index, message: `Unknown colour ${String(color)}` }); return null; }
      out.style = { ...(rest.style ?? {}), [colorKey(type, rest.packId ?? objects()[rest.id]?.packId)]: hex };
    }
    if (frame !== undefined) {
      if (frame === null) out.frameId = null;
      else {
        const id = frameId(frame);
        if (!id) { errors.push({ index, message: `No frame ${String(frame)}` }); return null; }
        out.frameId = id;
      }
    }
    return out;
  };

  /** @param {unknown} v @param {number} n */
  const columnsOf = (v, n) => typeof v === "number" && v >= 1 ? Math.min(Math.trunc(v), Math.max(1, n)) : Math.max(1, Math.ceil(Math.sqrt(n)));
  /** @param {unknown} v */
  const gapOf = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : GAP;
  /** @param {unknown} at @returns {{x: number, y: number}|null} */
  const cleanAt = (at) => at && typeof at === "object" && Number.isFinite(/** @type {any} */ (at).x) && Number.isFinite(/** @type {any} */ (at).y)
    ? { x: /** @type {any} */ (at).x, y: /** @type {any} */ (at).y } : null;
  /** @param {unknown} ids @returns {string[]} */
  const idList = (ids) => [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string"))];
  /** @param {string[]} ids */
  const created = (ids) => ids.map((id) => objects()[id]).filter(Boolean);
  /** @param {unknown} ids @param {AppError[]} errors @returns {WhiteboardObject[]} */
  const existing = (ids, errors) => idList(ids).flatMap((id, index) => {
    const o = objects()[id];
    if (!o) { errors.push({ index, message: `No object ${id}` }); return []; }
    return [o];
  });

  /** @type {AppHandle} */
  const handle = {
    getBoard() {
      const { title, background } = store.getState().board;
      return { title, background, objects: structuredClone(list()) };
    },

    findObjects(filter = {}) {
      const f = filter && typeof filter === "object" ? filter : {};
      const types = f.type === undefined ? null : new Set(Array.isArray(f.type) ? f.type : [f.type]);
      const text = typeof f.text === "string" ? f.text.trim().toLowerCase() : "";
      const frame = f.frame === undefined ? undefined : frameId(f.frame);
      if (frame === null) return [];
      return structuredClone(list().filter((o) => (!types || types.has(o.type)) &&
        (!text || o.text.toLowerCase().includes(text)) && (frame === undefined || o.frameId === frame)));
    },

    addStickies({ stickies, frame, at, columns, gap } = /** @type {any} */ ({})) {
      /** @type {AppError[]} */
      const errors = [];
      let inFrame = null;
      if (frame !== undefined && frame !== null) {
        inFrame = frameId(frame);
        if (!inFrame) return { created: [], errors: [{ index: -1, message: `No frame ${String(frame)}` }] };
      }
      const items = (Array.isArray(stickies) ? stickies : []).flatMap((item, index) => {
        const fields = friendly("sticky", typeof item === "string" ? { text: item } : item, index, errors);
        return fields ? [fields] : [];
      });
      const d = TYPE_DEFAULTS.sticky;
      const n = items.length;
      const cols = columnsOf(columns, n), g = gapOf(gap);
      const rows = Math.ceil(n / cols);
      const f = inFrame ? objects()[inFrame] : null;
      const view = canvas.getViewport();
      const origin = cleanAt(at) ?? (f ? { x: f.x + GAP, y: f.y + GAP } : {
        // Centred in the view, so the person sees what was added.
        x: Math.round(view.x + view.w / 2 - (cols * (d.w + g) - g) / 2),
        y: Math.round(view.y + view.h / 2 - (rows * (d.h + g) - g) / 2),
      });
      const ids = store.createObjects(items.map((fields, k) => ({
        w: d.w, h: d.h, ...fields, type: "sticky", id: newId("object"),
        x: origin.x + (k % cols) * (d.w + g), y: origin.y + Math.floor(k / cols) * (d.h + g),
        ...(inFrame ? { frameId: inFrame } : {}),
      })));
      return { created: created(ids), errors };
    },

    addObjects({ objects: input } = /** @type {any} */ ({})) {
      /** @type {AppError[]} */
      const errors = [];
      const view = canvas.getViewport();
      const raw = (Array.isArray(input) ? input : []).flatMap((item, index) => {
        if (!item || !OBJECT_TYPES.includes(item.type)) { errors.push({ index, message: `Unknown type ${String(item?.type)}` }); return []; }
        const fields = friendly(item.type, item, index, errors);
        if (!fields) return [];
        const d = TYPE_DEFAULTS[/** @type {keyof typeof TYPE_DEFAULTS} */ (item.type)];
        return [{
          x: Math.round(view.x + view.w / 2 - d.w / 2), y: Math.round(view.y + view.h / 2 - d.h / 2),
          ...fields, id: fields.id ?? newId("object"),
        }];
      });
      return { created: created(store.createObjects(/** @type {any} */ (raw))), errors };
    },

    connectObjects({ from, to, label, routing, arrow, color } = /** @type {any} */ ({})) {
      /** @type {AppError[]} */
      const errors = [];
      for (const [end, id] of [["from", from], ["to", to]]) {
        const o = typeof id === "string" ? objects()[id] : undefined;
        if (!o || o.type === "connector") errors.push({ index: 0, message: `${end}: no object ${String(id)} to connect` });
      }
      const fields = friendly("connector", { color }, 0, errors);
      if (errors.length || !fields) return { connector: null, errors };
      const ends = arrow === "both" ? ["arrow", "arrow"] : arrow === "none" ? ["none", "none"] : ["none", "arrow"];
      const [id] = store.createObjects([{
        type: "connector", id: newId("object"), from, to, text: typeof label === "string" ? label : "",
        routing: routing === "elbow" || routing === "curved" ? routing : "straight",
        style: /** @type {any} */ ({ ...(fields.style ?? {}), arrowStart: ends[0], arrowEnd: ends[1] }),
      }]);
      return { connector: id ? created([id])[0] ?? null : null, errors };
    },

    updateObjects({ updates } = /** @type {any} */ ({})) {
      /** @type {AppError[]} */
      const errors = [];
      const patches = (Array.isArray(updates) ? updates : []).flatMap((u, index) => {
        const o = typeof u?.id === "string" ? objects()[u.id] : undefined;
        if (!o) { errors.push({ index, message: `No object ${String(u?.id)}` }); return []; }
        const patch = friendly(o.type, { ...u.fields, id: o.id }, index, errors);
        if (!patch) return [];
        delete patch.id;
        delete patch.type;
        if (patch.style) patch.style = { ...o.style, ...patch.style };
        return [{ id: o.id, patch }];
      });
      if (patches.length) store.updateObjects(patches);
      return { errors };
    },

    moveObjects({ ids, dx = 0, dy = 0 } = /** @type {any} */ ({})) {
      /** @type {AppError[]} */
      const errors = [];
      const mx = Number.isFinite(dx) ? dx : 0, my = Number.isFinite(dy) ? dy : 0;
      const patches = existing(ids, errors).filter((o) => o.type !== "connector")
        .map((o) => ({ id: o.id, patch: { x: o.x + mx, y: o.y + my } }));
      if (patches.length) store.updateObjects(patches);
      return { errors };
    },

    arrangeGrid({ ids, columns, gap, at } = /** @type {any} */ ({})) {
      /** @type {AppError[]} */
      const errors = [];
      const items = existing(ids, errors).filter((o) => o.type !== "connector");
      if (!items.length) return { errors };
      const cols = columnsOf(columns, items.length), g = gapOf(gap);
      const cellW = Math.max(...items.map((o) => o.w)), cellH = Math.max(...items.map((o) => o.h));
      const origin = cleanAt(at) ?? { x: Math.min(...items.map((o) => o.x)), y: Math.min(...items.map((o) => o.y)) };
      store.updateObjects(items.map((o, k) => ({
        id: o.id, patch: { x: origin.x + (k % cols) * (cellW + g), y: origin.y + Math.floor(k / cols) * (cellH + g) },
      })));
      return { errors };
    },

    deleteObjects({ ids } = /** @type {any} */ ({})) {
      /** @type {AppError[]} */
      const errors = [];
      const found = existing(ids, errors).map((o) => o.id);
      if (found.length) store.deleteObjects(found);
      return { errors };
    },

    getSelection: () => [...canvas.getSelection()],
    setSelection: (ids) => canvas.setSelection(idList(ids)),
    showObjects: (ids) => { const found = idList(ids).filter((id) => objects()[id]); if (found.length) canvas.focusObjects(found); },
    getViewport: () => ({ ...canvas.getViewport() }),
    toast: (message) => toast(String(message)),
    onChange(listener) {
      if (typeof listener !== "function") return () => {};
      return store.subscribe((_state, change) => {
        if (change.kind !== "objects" && change.kind !== "snapshot" && change.kind !== "structure") return;
        try { listener(handle.getBoard()); } catch (e) { console.error("[whiteboard adapt] onChange listener failed", e); }
      });
    },
  };
  return Object.freeze(handle);
}

/**
 * Runs an action or onReady, reporting a failure without breaking the board.
 * @param {string} what @param {() => unknown} fn @param {(message: string) => void} toast
 */
export function runSafely(what, fn, toast) {
  const fail = (/** @type {any} */ e) => {
    console.error(`[whiteboard adapt] ${what} failed`, e);
    toast(`${what} failed: ${e?.message ?? e}`);
  };
  try {
    const r = fn();
    if (r && typeof (/** @type {any} */ (r)).then === "function") /** @type {Promise<unknown>} */ (r).catch(fail);
  } catch (e) {
    fail(e);
  }
}
