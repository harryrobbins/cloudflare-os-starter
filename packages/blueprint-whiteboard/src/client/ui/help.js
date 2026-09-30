// @ts-check
// The keyboard shortcuts dialog, generated from the same table the key handling reads
// (COMMANDS in ./canvas/keymap.js).

import { h } from "./dom.js";
import { modal } from "./dialogs.js";
import { helpGroups, formatKeys } from "./canvas/keymap.js";

import { characterShortcutsEnabled, setCharacterShortcutsEnabled } from "./shortcut-preferences.js";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/**
 * Rows of the dialog, as plain data (tested without a DOM).
 * @param {boolean} [mac]
 * @param {string} [query]
 * @returns {{group: string, rows: {label: string, keys: string[]}[]}[]}
 */
export function helpRows(mac = IS_MAC, query = "") {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return helpGroups().map(({ group, commands }) => ({
    group,
    rows: commands.map((c) => ({ label: c.label, keys: c.keys.map((k) => formatKeys(k, mac)) }))
      .filter((row) => terms.every((term) => `${group} ${row.label} ${row.keys.join(" ")}`.toLowerCase().includes(term))),
  })).filter(({ rows }) => rows.length);
}

/**
 * @param {HTMLElement|null} [returnFocus]
 * @returns {Promise<null>}
 */
export function openHelp(returnFocus = null) {
  return modal((close) => {
    const search = /** @type {HTMLInputElement} */ (h("input", {
      type: "search", "aria-label": "Find a command or shortcut", placeholder: "Find a command or shortcut",
      "data-autofocus": true, autocomplete: "off", style: { width: "100%", marginBottom: "12px" },
    }));
    const results = h("div", null);
    const render = () => {
      const groups = helpRows(IS_MAC, search.value);
      results.replaceChildren(...groups.map(({ group, rows }) => h("section", null,
        h("h3", null, group),
        h("table", null, h("tbody", null, rows.map((r) => h("tr", null,
          h("th", { scope: "row" }, r.label),
          h("td", null, r.keys.map((k, i) => [i ? h("span", { class: "muted" }, " or ") : null, h("kbd", null, k)])),
        )))),
      )));
      if (!groups.length) results.appendChild(h("p", { role: "status" }, "No matching shortcuts. Try a tool or action name."));
    };
    search.addEventListener("input", render);
    render();
    return h("div", { class: "modal wb-help", "aria-labelledby": "wb-help-title" },
      h("div", { class: "wb-help-head" },
        h("h2", { id: "wb-help-title" }, "Keyboard shortcuts"),
        h("button", { type: "button", class: "btn outline", onclick: () => close(null) }, "Close"),
      ),
      h("div", { class: "wb-help-body", tabindex: "0", role: "region", "aria-label": "Shortcuts" },
      search,
      h("label", { style: { display: "flex", gap: "8px", alignItems: "center", minHeight: "44px" } },
        h("input", { type: "checkbox", checked: characterShortcutsEnabled(), "aria-describedby": "wb-shortcut-preference-hint",
          onchange: (/** @type {Event} */ event) => setCharacterShortcutsEnabled(/** @type {HTMLInputElement} */ (event.currentTarget).checked),
        }), "Enable single-character shortcuts"),
      h("p", { id: "wb-shortcut-preference-hint", class: "muted" },
        "Turn off to avoid accidental actions with speech input or assistive technology. Applies until this board is reloaded. Navigation keys and Ctrl/⌘ shortcuts still work."),
        h("p", null, "Paste a website or YouTube URL onto the board to create a link card. Select the card, then Open website to view or copy the address."),
        h("p", null, "For syntax-highlighted code, choose Code block from Add, or paste a Markdown code fence (three backticks, a language name, then your code). Select the block to change language, theme, line numbers and wrapping."),
        h("p", null, "Tables: Tab and Shift+Tab move between cells, Enter moves down (both add a row past the end), Shift+Enter starts a new line. Paste spreadsheet cells, CSV or a Markdown table to make one."),
        h("p", null, "Diagrams: write D2 or Mermaid, or paste a d2 or mermaid code fence. They are drawn by the MermaiD2 renderer when it is connected to the board."),
        results,
      ),
    );
  }, null, returnFocus);
}
