// @ts-check
// Code block controls for the style bar and the actions menu: language (a searchable list), light
// or dark theme, line numbers, wrapping, code size, file name, and Copy code. Each control applies
// to every selected code block in ONE store call and refits their height to the code (the block
// grows and shrinks with its content, as while typing).
//
// Copy code goes through a copy command (writeClipboard in ./clipboard.js), the one route to the
// system clipboard open to the sandboxed frame; when the browser refuses, the code is shown
// selected in a dialog to copy by hand.

import { LIMITS } from "../../shared/protocol.js";
import { LANGUAGES, languageLabel } from "../../shared/code/languages.js";
import { codeHeight } from "../../shared/code/layout.js";
import { h } from "./dom.js";
import { modal, showToast } from "./dialogs.js";
import { openObjectPicker } from "./object-picker.js";
import { writeClipboard } from "./clipboard.js";

/** @typedef {import("./app.js").App} App */
/** @typedef {import("../../shared/protocol.js").WhiteboardObject} WhiteboardObject */

/** Code sizes the style bar offers (font size, world units). */
export const CODE_SIZES = [{ label: "S", size: 12, name: "small" }, { label: "M", size: 14, name: "medium" }, { label: "L", size: 18, name: "large" }, { label: "XL", size: 24, name: "extra large" }];

/**
 * The patch for `o` with `patch` applied, plus its fitted height.
 * @param {WhiteboardObject} o @param {Record<string, any>} patch
 */
export function codePatch(o, patch) {
  const next = { ...o, ...patch, style: { ...o.style, ...patch.style } };
  const hh = Math.min(LIMITS.sizeMax, codeHeight(next));
  return hh !== o.h ? { ...patch, h: hh } : patch;
}

/**
 * @param {App} app
 */
export function createCodeControls(app) {
  const { store, canvas } = app;

  /** @returns {WhiteboardObject[]} */
  const selectedCode = () => {
    const objects = store.getState().board.objects;
    return canvas.getSelection().map((id) => objects[id]).filter((o) => o?.type === "code");
  };

  /** @param {(o: WhiteboardObject) => Record<string, any>} patchFor @param {string} message */
  function apply(patchFor, message) {
    const updates = selectedCode().map((o) => ({ id: o.id, patch: codePatch(o, patchFor(o)) }));
    if (!updates.length) return;
    store.updateObjects(updates);
    app.announce(message);
  }

  /** @param {HTMLElement|null} [from] */
  async function chooseLanguage(from = null) {
    const blocks = selectedCode();
    if (!blocks.length) return;
    const current = blocks.every((o) => o.language === blocks[0].language) ? blocks[0].language : null;
    const id = await openObjectPicker({
      title: "Code language",
      options: LANGUAGES.map((l) => ({
        id: l.id, label: l.label + (l.aliases.length ? ` (${l.aliases.slice(0, 3).join(", ")})` : ""), current: l.id === current,
      })),
      returnFocus: from ?? canvas.element,
      searchLabel: "Search languages", placeholder: "Search languages", empty: "No languages match.",
    });
    if (id) apply(() => ({ language: id }), `Language ${languageLabel(id)}`);
  }

  /** @param {HTMLElement|null} [from] */
  async function editFilename(from = null) {
    const blocks = selectedCode();
    if (blocks.length !== 1) return;
    const o = blocks[0];
    const value = await modal((close) => {
      const input = /** @type {HTMLInputElement} */ (h("input", {
        type: "text", class: "wb-code-filename", value: o.filename ?? "", maxlength: String(LIMITS.codeFilename),
        "aria-label": "File name", placeholder: "for example main.py", autocomplete: "off", "data-autofocus": true,
      }));
      input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); close(input.value); } });
      return h("div", { class: "modal wb-code-name", "aria-labelledby": "wb-code-name-title" },
        h("h2", { id: "wb-code-name-title" }, "File name"),
        h("p", null, "Shown in the code block's header. Leave it empty to show the language only."),
        input,
        h("div", { class: "modal-actions" },
          h("button", { type: "button", class: "btn outline", onclick: () => close(null) }, "Cancel"),
          h("button", { type: "button", class: "btn primary", onclick: () => close(input.value) }, "Save"),
        ),
      );
    }, /** @type {string|null} */ (null), from ?? canvas.element);
    if (value === null) return;
    apply(() => ({ filename: value }), value.trim() ? `File name ${value.trim()}` : "File name removed");
  }

  /** @param {HTMLElement|null} [from] */
  function copyCode(from = null) {
    const blocks = selectedCode();
    if (blocks.length !== 1) return;
    const text = blocks[0].text;
    if (writeClipboard(text)) {
      showToast("Code copied", { timeout: 3000 });
      app.announce("Code copied");
      return;
    }
    modal((close) => {
      const area = /** @type {HTMLTextAreaElement} */ (h("textarea", {
        class: "wb-code-copy", readonly: true, rows: "12", "aria-label": "Code", "data-autofocus": true, spellcheck: "false",
      }));
      area.value = text;
      area.addEventListener("focus", () => area.select());
      return h("div", { class: "modal wb-code-copy-dialog", "aria-labelledby": "wb-code-copy-title" },
        h("h2", { id: "wb-code-copy-title" }, "Copy code"),
        h("p", null, "Copying was blocked here. The code is selected: copy it yourself (Ctrl+C, or ⌘+C on a Mac)."),
        area,
        h("div", { class: "modal-actions" }, h("button", { type: "button", class: "btn primary", onclick: () => close(null) }, "Done")),
      );
    }, null, from ?? canvas.element);
  }

  /**
   * The style bar group for code blocks in the selection, or null.
   * @param {WhiteboardObject[]} objs
   * @param {(key: string, attrs: Record<string, any>, ...children: any[]) => HTMLElement} btn
   */
  function group(objs, btn) {
    const blocks = objs.filter((o) => o.type === "code");
    if (!blocks.length) return null;
    const same = (/** @type {(o: WhiteboardObject) => any} */ get) => blocks.every((o) => get(o) === get(blocks[0])) ? get(blocks[0]) : null;
    const language = same((o) => o.language);
    const dark = same((o) => o.theme) === "dark";
    const numbers = same((o) => o.lineNumbers) !== false;
    const wrap = same((o) => o.wrap) === true;
    const size = same((o) => o.style.fontSize);
    const langName = language ? languageLabel(language) : "Mixed";
    return h("div", { class: "style-group code-group", role: "group", "aria-label": "Code" },
      btn("code-language", {
        class: "btn small code-language-btn", "aria-label": `Language: ${langName}`, title: "Code language", "aria-haspopup": "dialog",
        onclick: (/** @type {Event} */ e) => { chooseLanguage(/** @type {HTMLElement} */ (e.currentTarget)); },
      }, langName, " ▾"),
      btn("code-theme", {
        class: "btn small code-theme-btn", "aria-pressed": String(dark), "aria-label": "Dark theme", title: "Dark theme",
        onclick: () => apply(() => ({ theme: dark ? "light" : "dark" }), dark ? "Light theme" : "Dark theme"),
      }, "Dark"),
      btn("code-numbers", {
        class: "btn small code-numbers-btn", "aria-pressed": String(numbers), "aria-label": "Line numbers", title: "Line numbers",
        onclick: () => apply(() => ({ lineNumbers: !numbers }), numbers ? "Line numbers off" : "Line numbers on"),
      }, "1 2 3"),
      btn("code-wrap", {
        class: "btn small code-wrap-btn", "aria-pressed": String(wrap), "aria-label": "Wrap long lines", title: "Wrap long lines",
        onclick: () => apply(() => ({ wrap: !wrap }), wrap ? "Long lines clipped" : "Long lines wrapped"),
      }, "Wrap"),
      CODE_SIZES.map((f) => btn("code-size-" + f.size, {
        class: "btn small code-size-btn", "aria-pressed": String(size === f.size), "aria-label": `Code size ${f.name}`,
        title: `Code size ${f.size}`, dataset: { size: String(f.size) },
        onclick: () => apply(() => ({ style: { fontSize: f.size } }), `Code size ${f.name}`),
      }, f.label)),
      blocks.length === 1 ? [
        btn("code-filename", {
          class: "btn small code-filename-btn", "aria-label": `File name: ${blocks[0].filename || "none"}`, title: "File name", "aria-haspopup": "dialog",
          onclick: (/** @type {Event} */ e) => { editFilename(/** @type {HTMLElement} */ (e.currentTarget)); },
        }, "Name…"),
        btn("code-copy", {
          class: "btn small code-copy-btn", "aria-label": "Copy code", title: "Copy code",
          onclick: (/** @type {Event} */ e) => copyCode(/** @type {HTMLElement} */ (e.currentTarget)),
        }, "Copy code"),
      ] : null,
    );
  }

  /**
   * Actions menu items for a selection of one code block.
   * @param {WhiteboardObject[]} objs
   */
  function menuItems(objs) {
    if (objs.length !== 1 || objs[0].type !== "code") return [];
    return [
      { label: "Copy code", className: "ctx-copy-code", onSelect: () => copyCode() },
      { label: "Code language…", className: "ctx-code-language", onSelect: () => { chooseLanguage(); } },
    ];
  }

  return { group, menuItems, chooseLanguage, copyCode, editFilename };
}
