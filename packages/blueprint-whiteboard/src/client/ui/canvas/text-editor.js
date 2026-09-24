// @ts-check
// Inline text editing: an HTML <textarea> laid over the object, transformed to its screen box,
// rotation, zoom and font size. The object's own text is hidden while the editor covers it.
// Commits on blur, Escape or Ctrl/Cmd+Enter; Enter inserts a newline except in single-line fields
// (frame names and connector labels), where it commits. A remote update to the object being edited
// repositions the editor but never replaces what the user is typing.
//
// Focus moving into an element marked `data-wb-keeps-editor` (the icon picker's panel) does not
// commit: the editor stays open with its caret, so a picked emoji or symbol is inserted there
// (insert()). Whoever moved focus away is then responsible for commit() or focus().

import {
  textLayout, textObjectHeight, textWidth, center, LINE_HEIGHT,
} from "../../../shared/geometry.js";
import { FONT_FAMILY } from "../../../shared/render.js";
import { cleanCode, cleanLine, cleanText, LIMITS } from "../../../shared/protocol.js";
import { connectorRouteOf, canEditText } from "./model.js";
import { routeMidpoint } from "../../../shared/connectors.js";
import { codeHeight, codeMetrics, CODE_FONT_FAMILY, CODE_LINE_HEIGHT, TAB_WIDTH } from "../../../shared/code/layout.js";
import { codeTheme } from "../../../shared/code/theme.js";
import { applyEdit, indentEdit, indentUnitOf, newlineEdit } from "./code-editing.js";
import { keyAction } from "./keymap.js";

/** @typedef {import("../../../shared/protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {import("../../../shared/protocol.js").ObjectPatch} ObjectPatch */
/** @typedef {{x: number, y: number, zoom: number}} Camera */

/**
 * Where the editor goes, in world units: its unrotated box, the rotation centre and rotation.
 * @typedef {object} EditorBox
 * @property {number} x @property {number} y @property {number} w @property {number} h
 * @property {number} cx @property {number} cy @property {number} rot
 * @property {number} fontSize
 * @property {"left"|"center"|"right"} align
 * @property {boolean} singleLine
 * @property {boolean} centerVertically
 * @property {"none"|"label"|"frame"} chrome
 * @property {string} color
 * @property {number} maxLength
 * @property {{background: string, padLeft: number, pad: number, wrap: boolean, language: string}} [code]
 *   code blocks: the editor covers the body (below the header) in the block's monospace font
 */

/**
 * @param {WhiteboardObject} o @param {(id: string) => WhiteboardObject|undefined} resolve
 * @param {import("../../../shared/connectors.js").RouteEnv} [env]
 * @returns {EditorBox|null}
 */
export function editorBox(o, resolve, env) {
  if (!canEditText(o)) return null;
  const fontSize = o.style.fontSize;
  const lineHeight = fontSize * LINE_HEIGHT;
  if (o.type === "connector") {
    const route = connectorRouteOf(o, resolve, env);
    if (!route) return null;
    const mid = routeMidpoint(route);
    const w = Math.max(fontSize * 8, textWidth(o.text || "", fontSize) + fontSize * 2);
    return {
      x: mid.x - w / 2, y: mid.y - lineHeight / 2, w, h: lineHeight, cx: mid.x, cy: mid.y, rot: 0, fontSize,
      align: "center", singleLine: true, centerVertically: false, chrome: "label", color: o.style.textColor,
      maxLength: LIMITS.connectorLabel,
    };
  }
  const c = center(o);
  if (o.type === "code") {
    const m = codeMetrics(o);
    const th = codeTheme(o.theme);
    return {
      x: o.x, y: m.bodyY, w: o.w, h: Math.max(m.lineH + 2 * m.pad, o.y + o.h - m.bodyY), cx: c.x, cy: c.y, rot: 0, fontSize,
      align: "left", singleLine: false, centerVertically: false, chrome: "none", color: th.tokens[""],
      maxLength: LIMITS.codeText,
      code: { background: th.background, padLeft: m.pad + m.gutterW, pad: m.pad, wrap: !!o.wrap, language: o.language ?? "plain" },
    };
  }
  if (o.type === "frame") {
    const layout = textLayout(o);
    return {
      x: o.x, y: layout.y, w: Math.max(o.w, fontSize * 10), h: lineHeight, cx: c.x, cy: c.y, rot: 0, fontSize,
      align: "left", singleLine: true, centerVertically: false, chrome: "frame", color: "#4b5563",
      maxLength: LIMITS.frameName,
    };
  }
  const layout = textLayout(o);
  return {
    x: layout.x, y: layout.y, w: layout.w, h: o.type === "text" ? Math.max(layout.h, lineHeight) : layout.h,
    cx: c.x, cy: c.y, rot: o.rot || 0, fontSize, align: o.style.align,
    singleLine: false, centerVertically: o.type !== "text", chrome: "none", color: o.style.textColor,
    maxLength: LIMITS.text,
  };
}

/**
 * The patch committing `value` as the text of `o`, or null when nothing changes. Text objects also
 * get their auto-grown height.
 * @param {WhiteboardObject} o @param {string} value
 * @returns {ObjectPatch|null}
 */
export function textPatch(o, value) {
  const text = o.type === "frame" ? cleanLine(value, LIMITS.frameName)
    : o.type === "connector" ? cleanLine(value, LIMITS.connectorLabel)
    : o.type === "code" ? cleanCode(value)
    : cleanText(value, LIMITS.text);
  /** @type {ObjectPatch} */
  const patch = {};
  if (text !== o.text) patch.text = text;
  if (o.type === "text") {
    const h = textObjectHeight(text, o.w, o.style.fontSize);
    if (h !== o.h) patch.h = h;
  }
  if (o.type === "code") {
    const h = Math.min(LIMITS.sizeMax, codeHeight({ ...o, text }));
    if (h !== o.h) patch.h = h;
  }
  return Object.keys(patch).length ? patch : null;
}

/**
 * @typedef {object} EditorDeps
 * @property {HTMLElement} host
 * @property {(id: string) => WhiteboardObject|undefined} getObject   committed object
 * @property {(id: string) => WhiteboardObject|undefined} resolve
 * @property {import("../../../shared/connectors.js").RouteEnv} [routeEnv]
 * @property {() => Camera} getCamera
 * @property {(id: string, value: string) => void} onCommit
 * @property {(id: string) => void} onClose
 * @property {(id: string, text: string) => string|null} [onCodePaste]  paste into an EMPTY code
 *   block: may set its language and returns the text to insert instead (null: paste as is)
 * @property {(target: EventTarget|null) => boolean} [keepOpen]  focus moving to `target` keeps
 *   the editor open (with its caret) instead of committing
 * @property {(command: string) => void} [onCommand]  a shell command pressed while typing
 *   (keymap.js rows with scope "text")
 */

export class TextEditor {
  /** @param {EditorDeps} deps */
  constructor(deps) {
    this.deps = deps;
    /** @type {string|null} */
    this.id = null;
    /** @type {HTMLTextAreaElement|null} */
    this.textarea = null;
    /** @type {EditorBox|null} */
    this.box = null;
    this.closing = false;
  }

  get isOpen() {
    return this.id !== null;
  }

  /** @param {string} id @returns {boolean} opened */
  open(id) {
    if (this.id === id) { this.textarea?.focus(); return true; }
    if (this.id) this.commit();
    const o = this.deps.getObject(id);
    if (!o) return false;
    const box = editorBox(o, this.deps.resolve, this.deps.routeEnv);
    if (!box) return false;
    const ta = document.createElement("textarea");
    ta.className = "wb-editor" + (box.chrome === "label" ? " wb-editor-label" : box.chrome === "frame" ? " wb-editor-frame" : "");
    ta.setAttribute("aria-label", o.type === "frame" ? "Frame name" : o.type === "connector" ? "Connector label" : o.type === "code" ? "Code" : "Text");
    ta.spellcheck = !box.code;
    if (box.code) {
      ta.classList.add("wb-editor-code");
      ta.setAttribute("wrap", box.code.wrap ? "soft" : "off");
      ta.setAttribute("autocapitalize", "off");
      ta.setAttribute("autocomplete", "off");
      ta.setAttribute("aria-description", "Tab indents and Shift+Tab outdents. Press Escape or Ctrl+Enter to finish.");
      ta.addEventListener("paste", (e) => this.onPaste(e));
    }
    ta.maxLength = box.maxLength;
    ta.value = o.text || "";
    ta.rows = 1;
    ta.addEventListener("keydown", (e) => this.onKey(e));
    ta.addEventListener("input", () => this.position());
    ta.addEventListener("blur", (e) => { if (this.id && !this.deps.keepOpen?.(e.relatedTarget)) this.commit(); });
    // Pointer and wheel events inside the editor are for the textarea, not the canvas.
    for (const type of ["pointerdown", "pointermove", "pointerup", "dblclick", "contextmenu"]) {
      ta.addEventListener(type, (e) => e.stopPropagation());
    }
    this.id = id;
    this.textarea = ta;
    this.box = box;
    this.deps.host.appendChild(ta);
    this.position();
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
    if (o.type === "frame" || o.type === "connector") ta.select();
    return true;
  }

  /** @param {ClipboardEvent} e */
  onPaste(e) {
    const ta = this.textarea;
    if (!ta || !this.id || ta.value !== "" || !this.deps.onCodePaste) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    const replacement = this.deps.onCodePaste(this.id, text);
    if (replacement === null || replacement === text) return;
    e.preventDefault();
    applyEdit(ta, { from: 0, to: ta.value.length, insert: replacement, selStart: replacement.length, selEnd: replacement.length });
  }

  /** @param {KeyboardEvent} e */
  onKey(e) {
    e.stopPropagation();
    if (e.isComposing) return;
    const action = keyAction(e, "text");
    if (action?.type === "command") {
      e.preventDefault();
      this.deps.onCommand?.(action.command);
      return;
    }
    const ta = this.textarea;
    const code = this.box?.code;
    if (code && ta && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.key === "Tab") {
        e.preventDefault();
        const edit = indentEdit(ta.value, ta.selectionStart, ta.selectionEnd, indentUnitOf(ta.value, code.language), e.shiftKey);
        if (edit) applyEdit(ta, edit);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        applyEdit(ta, newlineEdit(ta.value, ta.selectionStart, ta.selectionEnd));
        return;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      this.commit();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey || this.box?.singleLine)) {
      e.preventDefault();
      this.commit();
    }
  }

  /**
   * Inserts `text` at the caret, replacing any selected text, and leaves the caret after it.
   * False (and nothing changes) when the result would pass the field's length limit.
   * @param {string} text
   */
  insert(text) {
    const ta = this.textarea;
    if (!ta || !this.box || !text) return false;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    if (ta.value.length - (end - start) + text.length > this.box.maxLength) return false;
    ta.setRangeText(text, start, end, "end");
    this.position();
    return true;
  }

  /** Moves focus back into the open editor (its caret is where it was). */
  focus() {
    this.textarea?.focus({ preventScroll: true });
  }

  /** Re-applies geometry (camera moved, object changed remotely). Closes if the object is gone. */
  sync() {
    if (!this.id) return;
    const o = this.deps.getObject(this.id);
    if (!o) { this.close(); return; }
    const box = editorBox(o, this.deps.resolve, this.deps.routeEnv);
    if (!box) { this.close(); return; }
    this.box = box;
    this.position();
  }

  position() {
    const ta = this.textarea, box = this.box;
    if (!ta || !box || !this.id) return;
    const cam = this.deps.getCamera();
    const lineHeight = box.fontSize * LINE_HEIGHT;
    const o = this.deps.getObject(this.id);
    if (box.code) {
      const c = box.code;
      Object.assign(ta.style, {
        width: `${box.w}px`, boxSizing: "border-box", fontSize: `${box.fontSize}px`, lineHeight: String(CODE_LINE_HEIGHT),
        fontFamily: CODE_FONT_FAMILY, fontWeight: "400", textAlign: "left", color: box.color, background: c.background,
        padding: `${c.pad}px ${c.pad}px ${c.pad}px ${c.padLeft}px`, tabSize: String(TAB_WIDTH),
        whiteSpace: c.wrap ? "pre-wrap" : "pre", overflowWrap: c.wrap ? "anywhere" : "normal", wordBreak: c.wrap ? "break-all" : "normal",
        overflowX: c.wrap ? "hidden" : "auto", overflowY: "hidden", borderRadius: "0 0 6px 6px",
      });
      ta.style.height = "0px";
      const height = Math.max(box.h, ta.scrollHeight);
      ta.style.height = `${height}px`;
      const sx = (box.cx - cam.x) * cam.zoom, sy = (box.cy - cam.y) * cam.zoom;
      ta.style.transform = `translate(${sx}px, ${sy}px) scale(${cam.zoom}) translate(${box.x - box.cx}px, ${box.y - box.cy}px)`;
      return;
    }
    Object.assign(ta.style, {
      width: `${box.w}px`,
      fontSize: `${box.fontSize}px`,
      lineHeight: String(LINE_HEIGHT),
      fontFamily: FONT_FAMILY,
      fontWeight: box.chrome === "frame" ? "600" : "400",
      textAlign: box.align,
      color: box.color,
      whiteSpace: box.singleLine ? "pre" : "pre-wrap",
    });
    ta.style.height = "0px";
    const content = Math.max(lineHeight, ta.scrollHeight);
    let height = box.h, offsetY = 0;
    if (o?.type === "text") {
      height = Math.max(content, textObjectHeight(ta.value, o.w, o.style.fontSize));
    } else if (box.centerVertically) {
      height = Math.min(box.h, content);
      offsetY = (box.h - height) / 2;
    }
    ta.style.height = `${height}px`;
    const sx = (box.cx - cam.x) * cam.zoom, sy = (box.cy - cam.y) * cam.zoom;
    ta.style.transform = `translate(${sx}px, ${sy}px) rotate(${box.rot}deg) scale(${cam.zoom}) ` +
      `translate(${box.x - box.cx}px, ${box.y + offsetY - box.cy}px)`;
  }

  /** Commits the current value (if changed) and closes. */
  commit() {
    if (!this.id || this.closing) return;
    const id = this.id;
    const value = this.textarea?.value ?? "";
    this.closing = true;
    try {
      this.deps.onCommit(id, value);
    } finally {
      this.closing = false;
      this.close();
    }
  }

  /** Closes without committing. */
  close() {
    if (!this.id) return;
    const id = this.id;
    const ta = this.textarea;
    this.id = null;
    this.textarea = null;
    this.box = null;
    ta?.remove();
    this.deps.onClose(id);
  }
}
