// @ts-check
// Card tiles on the board. Elements are kept per card id and only rebuilt when what they show
// changed, so remote re-renders are cheap and don't disturb focus.

import { h, icon, avatar, formatDue, todayIso, PALETTE, textOn } from "./dom.js";

/** @typedef {import("../../shared/protocol.js").Card} Card */
/** @typedef {import("../../shared/protocol.js").Label} Label */

/** Id of the hidden element describing card keyboard shortcuts (created by mountApp). */
export const CARD_HELP_ID = "kanban-card-help";

/**
 * Accessible name of a card element without the filter suffix.
 * @param {HTMLElement} el
 * @returns {string}
 */
export function cardBaseLabel(el) {
  return /** @type {any} */ (el)._label ?? el.getAttribute("aria-label") ?? "";
}

/**
 * Stable colour for a free-text assignee name.
 * @param {string} name
 */
export function colorForName(name) {
  let hash = 0;
  for (const ch of name.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

/**
 * @param {Label} label
 */
export function labelChip(label) {
  return h("span", {
    class: "chip", style: { background: label.color, color: textOn(label.color) }, title: label.name,
  }, label.name);
}

/**
 * @param {Card} card
 * @param {Record<string, Label>} labels
 */
function signature(card, labels) {
  const labelSig = card.labels.map((id) => labels[id] ? `${id}:${labels[id].name}:${labels[id].color}` : "").join(",");
  return `${card.title}|${card.assignee}|${card.due}|${todayIso()}|${labelSig}|${!!card.description.trim()}|` +
    card.checklist.map((i) => (i.done ? 1 : 0)).join("");
}

/**
 * @param {Card} card
 * @param {Record<string, Label>} labels
 * @param {(cardId: string) => void} onOpen
 */
export function createCardEl(card, labels, onOpen) {
  const el = h("div", {
    class: "card", tabindex: "0", role: "button", dataset: { cardId: card.id },
    "aria-describedby": CARD_HELP_ID,
  });
  el.addEventListener("click", () => {
    if (el.dataset.suppressClick) { delete el.dataset.suppressClick; return; }
    onOpen(card.id);
  });
  el.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target === el) { e.preventDefault(); onOpen(el.dataset.cardId || card.id); }
  });
  updateCardEl(el, card, labels);
  return el;
}

/**
 * @param {HTMLElement} el
 * @param {Card} card
 * @param {Record<string, Label>} labels
 */
export function updateCardEl(el, card, labels) {
  const sig = signature(card, labels);
  if (/** @type {any} */ (el)._sig === sig) return;
  /** @type {any} */ (el)._sig = sig;

  const knownLabels = card.labels.map((id) => labels[id]).filter(Boolean);
  const done = card.checklist.filter((i) => i.done).length;
  const total = card.checklist.length;
  const today = todayIso();
  const overdue = !!card.due && card.due < today;
  const dueToday = !!card.due && card.due === today;

  const meta = h("div", { class: "card-meta" },
    card.due ? h("span", {
      class: "meta-item due" + (overdue ? " overdue" : ""),
      title: overdue ? "Overdue" : dueToday ? "Due today" : "Due date",
    }, icon("clock", 13), formatDue(card.due)) : null,
    total ? h("span", {
      class: "meta-item checklist-progress" + (done === total ? " complete" : ""),
      title: "Checklist",
    }, icon("check", 13), `${done}/${total}`) : null,
    card.description.trim() ? h("span", { class: "meta-item", title: "Has description" }, icon("text", 13)) : null,
    card.assignee ? avatar(card.assignee, colorForName(card.assignee), "small assignee") : null,
  );

  const peerBadges = el.querySelector(".peer-badges");
  el.replaceChildren(
    knownLabels.length ? h("div", { class: "card-labels" }, knownLabels.map(labelChip)) : "",
    h("div", { class: "card-title" }, card.title || "Untitled"),
    meta,
  );
  if (peerBadges) el.appendChild(peerBadges);
  const parts = [card.title || "Untitled"];
  if (knownLabels.length) parts.push("labels " + knownLabels.map((l) => l.name).join(", "));
  if (card.assignee) parts.push("assigned to " + card.assignee);
  if (card.due) parts.push((overdue ? "overdue, was due " : "due ") + card.due);
  if (total) parts.push(`checklist ${done} of ${total}`);
  /** @type {any} */ (el)._label = parts.join("; ");
  el.setAttribute("aria-label", parts.join("; "));
}
