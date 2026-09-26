// @ts-check
// The command palette (Ctrl/⌘+K): one fuzzy list over commands (with their shortcuts, so the
// palette teaches the keys), items by key or title, saved views and navigation. Contextual
// commands act on the selection or the focused item.

import { h, reconcile, setChildren } from "./dom.js";
import { fuzzyScore } from "./fuzzy.js";
import { keyLabel } from "./keys.js";

/**
 * @typedef {{ id: string, label: string, group: string, keys?: string[], detail?: string, keywords?: string,
 *   icon?: () => Node|null, run: (anchor: HTMLElement) => void }} PaletteEntry
 */

/**
 * @param {{ layers: ReturnType<typeof import("./overlay.js").createLayers>, entries: () => PaletteEntry[],
 *   items: (query: string) => PaletteEntry[], mac: boolean, context: string }} opts
 */
export function openPalette(opts) {
  const listId = "wb-palette-list";
  const input = /** @type {HTMLInputElement} */ (h("input", {
    type: "text", class: "palette-input", role: "combobox", "aria-expanded": "true", "aria-controls": listId,
    "aria-autocomplete": "list", "aria-label": "Search commands and items", placeholder: opts.context ? `Command for ${opts.context}, or search items…` : "Type a command or search items…",
    autocomplete: "off", spellcheck: "false",
  }));
  const list = h("ul", { id: listId, class: "palette-list", role: "listbox", "aria-label": "Results" });
  const empty = h("p", { class: "picker-empty", role: "status" });
  let active = 0;
  /** @type {PaletteEntry[]} */
  let shown = [];
  const all = opts.entries();

  function compute() {
    const q = input.value.trim();
    if (!q) { shown = all.slice(0, 60); return; }
    const scored = all.map((e, i) => ({ e, i, s: fuzzyScore(q, `${e.label} ${e.keywords ?? ""} ${e.group}`) }))
      .filter((x) => x.s !== null).toSorted((a, b) => /** @type {number} */ (b.s) - /** @type {number} */ (a.s) || a.i - b.i).map((x) => x.e);
    shown = [...scored.slice(0, 30), ...opts.items(q)].slice(0, 60);
  }

  function render() {
    compute();
    active = Math.min(active, Math.max(0, shown.length - 1));
    /** @type {({ header: string } | PaletteEntry)[]} */
    const rows = [];
    let last = "";
    for (const e of shown) {
      if (e.group !== last) { rows.push({ header: e.group }); last = e.group; }
      rows.push(e);
    }
    reconcile(list, rows, {
      key: (r) => ("header" in r ? `h:${r.header}` : `e:${r.id}`),
      create: (r) => ("header" in r ? h("li", { role: "presentation", class: "picker-section" }, r.header)
        : h("li", { role: "option", class: "picker-option palette-option", onmousedown: (/** @type {Event} */ e) => e.preventDefault(), onclick: () => run(/** @type {PaletteEntry} */ (r)) })),
      update: (node, r) => {
        if ("header" in r) return;
        const i = shown.indexOf(r);
        node.id = `${listId}-${i}`;
        node.setAttribute("aria-selected", String(i === active));
        node.classList.toggle("active", i === active);
        setChildren(node, 
          r.icon ? h("span", { class: "opt-icon", "aria-hidden": "true" }, r.icon()) : h("span", { class: "opt-icon" }),
          h("span", { class: "opt-label" }, r.label),
          r.detail ? h("span", { class: "opt-detail" }, r.detail) : null,
          r.keys?.length ? h("span", { class: "opt-keys" }, r.keys.map((k) => h("kbd", null, keyLabel(k, opts.mac)))) : null);
      },
    });
    empty.textContent = shown.length ? `${shown.length} results` : "Nothing matches. Try an item key like WRK-12.";
    if (shown[active]) {
      input.setAttribute("aria-activedescendant", `${listId}-${active}`);
      list.ownerDocument.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }

  /** @param {PaletteEntry} e */
  function run(e) {
    dlg.close("run");
    e.run(input);
  }

  input.addEventListener("input", () => { active = 0; render(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(shown.length - 1, active + 1); render(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, active - 1); render(); }
    else if (e.key === "PageDown") { e.preventDefault(); active = Math.min(shown.length - 1, active + 8); render(); }
    else if (e.key === "PageUp") { e.preventDefault(); active = Math.max(0, active - 8); render(); }
    else if (e.key === "Enter") { e.preventDefault(); const x = shown[active]; if (x) run(x); }
  });

  const dlg = opts.layers.openDialog({
    title: "Command palette", size: "md", className: "palette",
    content: () => [input, list, empty, h("p", { class: "picker-foot", "aria-hidden": "true" }, "↑↓ move · Enter run · Esc close")],
    initialFocus: () => input,
  });
  render();
  return dlg;
}
