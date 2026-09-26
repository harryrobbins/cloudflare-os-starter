// @ts-check
// The picker: a popover holding a search box (ARIA combobox) and a listbox of options, following
// the APG "combobox with listbox popup" pattern: focus stays in the input, arrows move the active
// option (aria-activedescendant), Enter chooses, Escape closes. Multi-select pickers toggle with
// Enter or click and apply once when closed.

import { h, reconcile, setChildren } from "./dom.js";
import { fuzzyFilter } from "./fuzzy.js";

let nextPicker = 1;

/**
 * @typedef {{ value: string, label: string, detail?: string, keywords?: string, icon?: () => Node|null,
 *   section?: string, selected?: boolean, disabled?: boolean, hint?: string }} PickerOption
 * @typedef {{
 *   layers: ReturnType<typeof import("./overlay.js").createLayers>, anchor: HTMLElement|{ x: number, y: number },
 *   title: string, options: PickerOption[], multi?: boolean, placeholder?: string,
 *   onPick: (values: string[]) => void, onClose?: () => void,
 *   create?: (text: string) => PickerOption|null, custom?: (text: string) => PickerOption|null, footer?: string,
 *   returnTo?: HTMLElement|null,
 * }} PickerOptions
 */

/** @param {PickerOptions} opts */
export function openPicker(opts) {
  const id = `pk-${nextPicker++}`;
  /** @type {Set<string>} */
  const chosen = new Set(opts.options.filter((o) => o.selected).map((o) => o.value));
  const initial = new Set(chosen);
  let active = 0;
  /** @type {PickerOption[]} */
  let shown = [];
  let picked = false;

  const input = /** @type {HTMLInputElement} */ (h("input", {
    type: "text", class: "picker-input", role: "combobox", "aria-expanded": "true", "aria-controls": `${id}-list`,
    "aria-autocomplete": "list", "aria-label": opts.title, placeholder: opts.placeholder ?? "Search…", autocomplete: "off", spellcheck: "false",
  }));
  const list = h("ul", { id: `${id}-list`, class: "picker-list", role: "listbox", "aria-label": opts.title, "aria-multiselectable": opts.multi ? "true" : null });
  const status = h("div", { class: "picker-empty", role: "status" });
  const hint = h("div", { class: "picker-foot", "aria-hidden": "true" }, opts.footer ?? (opts.multi ? "↑↓ move · Enter toggles · Esc done" : "↑↓ move · Enter choose · Esc close"));

  function compute() {
    const q = input.value;
    let items = fuzzyFilter(q, opts.options, (o) => `${o.label} ${o.keywords ?? ""} ${o.detail ?? ""}`, 200);
    const extra = q.trim() ? (opts.custom?.(q.trim()) ?? null) : null;
    if (extra) items = [extra, ...items.filter((o) => o.value !== extra.value)];
    const make = q.trim() && opts.create && !items.some((o) => o.label.toLowerCase() === q.trim().toLowerCase()) ? opts.create(q.trim()) : null;
    if (make) items = [...items, make];
    shown = items;
    active = Math.min(active, Math.max(0, shown.length - 1));
    if (q.trim() && shown.length) active = shown.findIndex((o) => !o.disabled);
  }

  function render() {
    compute();
    /** @type {(PickerOption|{ section: string, header: true })[]} */
    const rows = [];
    let last = "";
    for (const o of shown) {
      if (o.section && o.section !== last && !input.value.trim()) { rows.push({ section: o.section, header: true }); last = o.section; }
      rows.push(o);
    }
    reconcile(list, rows, {
      key: (r) => ("header" in r ? `h:${r.section}` : `o:${r.value}`),
      create: (r) => ("header" in r
        ? h("li", { role: "presentation", class: "picker-section" }, r.section)
        : h("li", { role: "option", class: "picker-option", onmousedown: (/** @type {Event} */ e) => e.preventDefault(), onclick: () => choose(/** @type {PickerOption} */ (r)) })),
      update: (el, r) => {
        if ("header" in r) return;
        const i = shown.indexOf(r);
        el.id = `${id}-o${i}`;
        const selected = chosen.has(r.value);
        el.setAttribute("aria-selected", String(opts.multi ? selected : i === active));
        if (opts.multi) el.setAttribute("aria-checked", String(selected));
        el.classList.toggle("active", i === active);
        el.classList.toggle("chosen", selected);
        el.toggleAttribute("aria-disabled", Boolean(r.disabled));
        setChildren(el, 
          h("span", { class: "check", "aria-hidden": "true" }, selected ? "✓" : ""),
          r.icon ? h("span", { class: "opt-icon", "aria-hidden": "true" }, r.icon()) : null,
          h("span", { class: "opt-label" }, r.label),
          r.detail ? h("span", { class: "opt-detail" }, r.detail) : null,
          r.hint ? h("kbd", { class: "opt-hint", "aria-hidden": "true" }, r.hint) : null,
        );
      },
    });
    status.textContent = shown.length ? "" : "No matches";
    const current = shown[active];
    if (current) {
      input.setAttribute("aria-activedescendant", `${id}-o${active}`);
      list.ownerDocument.getElementById(`${id}-o${active}`)?.scrollIntoView?.({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }

  /** @param {PickerOption} option */
  function choose(option) {
    if (!option || option.disabled) return;
    if (opts.multi) {
      if (chosen.has(option.value)) chosen.delete(option.value); else chosen.add(option.value);
      if (!opts.options.includes(option)) { opts.options = [option, ...opts.options]; }
      render();
      input.focus();
      return;
    }
    picked = true;
    popover.close("pick");
    opts.onPick([option.value]);
  }

  /** @param {number} delta */
  function move(delta) {
    if (!shown.length) return;
    let i = active;
    for (let n = 0; n < shown.length; n++) {
      i = (i + delta + shown.length) % shown.length;
      if (!shown[i].disabled) break;
    }
    active = i;
    render();
  }

  input.addEventListener("input", () => { active = 0; render(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Home" && !input.value) { e.preventDefault(); active = 0; render(); }
    else if (e.key === "End" && !input.value) { e.preventDefault(); active = shown.length - 1; render(); }
    else if (e.key === "Enter") { e.preventDefault(); const o = shown[active]; if (o) choose(o); else if (opts.multi) popover.close("done"); }
    else if (e.key === "Tab" && opts.multi) { popover.close("done"); }
  });

  const popover = opts.layers.openPopover({
    anchor: opts.anchor, label: opts.title, className: "picker", returnTo: opts.returnTo,
    content: () => h("div", { class: "picker-inner" }, h("div", { class: "picker-title", "aria-hidden": "true" }, opts.title), input, list, status, hint),
    initialFocus: () => input,
    onClose: () => {
      if (opts.multi && !picked) {
        const changed = chosen.size !== initial.size || [...chosen].some((v) => !initial.has(v));
        if (changed) opts.onPick([...chosen]);
      }
      opts.onClose?.();
    },
  });
  render();
  return popover;
}
