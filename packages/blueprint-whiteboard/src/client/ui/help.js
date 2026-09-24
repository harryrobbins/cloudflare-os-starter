// @ts-check
// The keyboard shortcuts dialog, generated from the same table the key handling reads
// (COMMANDS in ./canvas/keymap.js).

import { h } from "./dom.js";
import { modal } from "./dialogs.js";
import { helpGroups, formatKeys } from "./canvas/keymap.js";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/**
 * Rows of the dialog, as plain data (tested without a DOM).
 * @param {boolean} [mac]
 * @returns {{group: string, rows: {label: string, keys: string[]}[]}[]}
 */
export function helpRows(mac = IS_MAC) {
  return helpGroups().map(({ group, commands }) => ({
    group,
    rows: commands.map((c) => ({ label: c.label, keys: c.keys.map((k) => formatKeys(k, mac)) })),
  }));
}

/**
 * @param {HTMLElement|null} [returnFocus]
 * @returns {Promise<null>}
 */
export function openHelp(returnFocus = null) {
  return modal((close) => h("div", { class: "modal wb-help", "aria-labelledby": "wb-help-title" },
    h("div", { class: "wb-help-head" },
      h("h2", { id: "wb-help-title" }, "Keyboard shortcuts"),
      h("button", { type: "button", class: "btn outline", "data-autofocus": true, onclick: () => close(null) }, "Close"),
    ),
    h("div", { class: "wb-help-body", tabindex: "0", role: "region", "aria-label": "Shortcuts" },
      helpRows().map(({ group, rows }) => h("section", null,
        h("h3", null, group),
        h("table", null,
          h("tbody", null, rows.map((r) => h("tr", null,
            h("th", { scope: "row" }, r.label),
            h("td", null, r.keys.map((k, i) => [i ? h("span", { class: "muted" }, " or ") : null, h("kbd", null, k)])),
          ))),
        ),
      )),
    ),
  ), null, returnFocus);
}
