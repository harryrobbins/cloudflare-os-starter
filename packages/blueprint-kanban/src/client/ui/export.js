// @ts-check
// Static, print-friendly board for the platform's HTML/PDF export. No interactive controls.

import { cardsInColumn } from "../../shared/protocol.js";
import { h, formatDue, todayIso } from "./dom.js";
import { labelChip } from "./card.js";
import { CSS } from "./styles.js";

/** @typedef {import("../../shared/protocol.js").BoardSnapshot} BoardSnapshot */

/**
 * @param {HTMLElement} root
 * @param {BoardSnapshot} board
 */
export function renderExport(root, board) {
  document.head.appendChild(h("style", null, CSS));
  document.body.classList.add("export-mode");
  document.title = board.title;
  const today = todayIso();
  const total = Object.keys(board.cards).length;
  root.replaceChildren(h("main", { class: "export" },
    h("h1", null, board.title),
    h("div", { class: "export-sub" },
      `${board.columnOrder.length} columns · ${total} cards · exported ${new Date().toLocaleString()}`),
    h("div", { class: "export-columns" }, board.columnOrder.map((columnId) => {
      const column = board.columns[columnId];
      if (!column) return null;
      const cards = cardsInColumn(board.cards, columnId);
      return h("section", { class: "export-column" },
        h("h2", null, h("span", null, column.name), h("span", { style: { fontWeight: "400", color: "#555" } }, String(cards.length))),
        cards.length ? cards.map((card) => {
          const labels = card.labels.map((id) => board.labels[id]).filter(Boolean);
          const done = card.checklist.filter((i) => i.done).length;
          const overdue = card.due && card.due < today;
          return h("article", { class: "export-card" },
            labels.length ? h("div", { class: "card-labels" }, labels.map(labelChip)) : null,
            h("h3", null, card.title || "Untitled"),
            card.description ? h("div", { class: "desc" }, card.description) : null,
            h("div", { class: "meta" },
              card.assignee ? h("span", null, "Assignee: ", h("strong", null, card.assignee)) : null,
              card.due ? h("span", { style: overdue ? { color: "#b91c1c", fontWeight: "600" } : null },
                "Due: " + formatDue(card.due) + (overdue ? " (overdue)" : "")) : null,
              card.checklist.length ? h("span", null, `Checklist: ${done}/${card.checklist.length}`) : null,
            ),
            card.checklist.length ? h("ul", null, card.checklist.map((i) =>
              h("li", { class: i.done ? "done" : "" }, (i.done ? "☑ " : "☐ ") + i.text))) : null,
          );
        }) : h("p", { style: { color: "#666", fontSize: "12px", margin: "4px 2px" } }, "No cards"),
      );
    })),
  ));
}
