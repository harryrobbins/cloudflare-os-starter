// @ts-check
// Quick create (C): a title with inline tokens (#label @person !priority ^cycle), property buttons
// pre-filled from where it was opened (the lane, the column, the filter), an optional Markdown
// description, and "create more" for entering several items in a row.

import { h, setChildren } from "./dom.js";
import { icon } from "./icons.js";
import { parseTokens } from "./tokens.js";
import { LIMITS } from "../../shared/model/work.js";

/**
 * @typedef {{
 *   layers: ReturnType<typeof import("./overlay.js").createLayers>,
 *   index: () => import("../../shared/model/index.js").WorkIndex,
 *   me: string|null, today: () => string,
 *   defaults: Record<string, unknown>, context: string,
 *   summarize: (prop: string, fields: Record<string, unknown>) => { label: string, icon: Node|null },
 *   choose: (prop: string, fields: Record<string, unknown>, anchor: HTMLElement, done: (patch: Record<string, unknown>) => void) => void,
 *   submit: (fields: Record<string, unknown>) => { ok: boolean, error?: string, field?: string },
 *   draft: { title?: string, description?: string } | null,
 *   saveDraft: (draft: { title: string, description: string } | null) => void,
 *   announce: (text: string) => void,
 * }} CreateOptions
 */

/** @param {CreateOptions} o */
export function openCreate(o) {
  const index = o.index();
  /** @type {Record<string, unknown>} */
  let fields = { ...o.defaults };
  let createMore = false;
  const title = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "create-title", maxlength: String(LIMITS.title + 200), placeholder: index.planning ? "Title — try #bug @me !high ^current" : "Title", "aria-label": "Title", "aria-describedby": "wb-create-help wb-create-tokens", autocomplete: "off" }));
  const description = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "create-desc", rows: "4", placeholder: "Add a description (Markdown)…", "aria-label": "Description", maxlength: String(LIMITS.description) }));
  title.value = o.draft?.title ?? "";
  description.value = o.draft?.description ?? "";
  const tokens = h("div", { id: "wb-create-tokens", class: "token-preview", "aria-live": "polite" });
  const error = h("p", { class: "field-error", role: "alert" });
  const propsRow = h("div", { class: "create-props", role: "group", "aria-label": "Properties" });
  const PROPS = index.planning ? ["state", "priority", "assignee", "labels", "estimate", "due", "project", "cycle"] : ["state"];

  function tokenFields() { return parseTokens(title.value, index, { me: o.me, today: o.today() }); }

  function renderProps() {
    const parsed = tokenFields();
    const merged = { ...fields, ...parsed.fields };
    setChildren(propsRow, ...PROPS.map((prop) => {
      const s = o.summarize(prop, merged);
      return h("button", { type: "button", class: "btn sm prop-chip", "aria-haspopup": "dialog", onclick: (/** @type {Event} */ e) => o.choose(prop, merged, /** @type {HTMLElement} */ (e.currentTarget), (patch) => { fields = { ...fields, ...patch }; renderProps(); }) },
        s.icon, s.label);
    }));
    setChildren(tokens, ...parsed.tokens.map((t) => h("span", { class: "chip token" }, t.label)));
  }

  let saveTimer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);
  const persist = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => o.saveDraft(title.value || description.value ? { title: title.value.slice(0, 600), description: description.value.slice(0, 2000) } : null), 500);
  };
  title.addEventListener("input", () => { renderProps(); persist(); error.textContent = ""; });
  description.addEventListener("input", persist);

  function create() {
    const parsed = tokenFields();
    /** @type {Record<string, unknown>} */
    const all = { ...fields, ...parsed.fields, title: parsed.title };
    if (description.value.trim()) all.description = description.value;
    const r = o.submit(all);
    if (!r.ok) {
      error.textContent = r.error ?? "The item could not be created.";
      (r.field === "description" ? description : title).focus();
      return;
    }
    o.saveDraft(null);
    o.announce(`Created “${parsed.title}”. ${createMore ? "Ready for the next one." : ""}`);
    if (createMore) {
      title.value = ""; description.value = ""; renderProps(); title.focus();
    } else dlg.close("created");
  }

  const onKey = (/** @type {KeyboardEvent} */ e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); create(); }
  };
  title.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); create(); } });

  const more = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", id: "wb-create-more", onchange: (/** @type {Event} */ e) => { createMore = /** @type {HTMLInputElement} */ (e.target).checked; } }));
  const dlg = o.layers.openDialog({
    title: o.context ? `New item in ${o.context}` : "New item", size: "md", className: "create",
    content: () => {
      const wrap = h("div", { class: "create-body" },
        title, tokens, propsRow, description,
        h("p", { id: "wb-create-help", class: "hint" }, index.planning ? "Tokens: #label, @person or @me, !urgent/!high/!1–4, ^current or ^cycle name. Enter creates; Ctrl+Enter from the description." : "Enter creates the item."),
        error,
        h("div", { class: "row end" },
          h("label", { class: "check-label", for: "wb-create-more" }, more, "Create more"),
          h("span", { class: "grow" }),
          h("button", { type: "button", class: "btn", onclick: () => dlg.close("cancel") }, "Cancel"),
          h("button", { type: "button", class: "btn primary", onclick: create }, icon("plus", { size: 14 }), "Create item")));
      wrap.addEventListener("keydown", onKey);
      return wrap;
    },
    initialFocus: () => title,
  });
  renderProps();
  return dlg;
}
