// @ts-check
// Order keys for placing a card in a column.

import { cardsInColumn } from "../../shared/protocol.js";
import { isValidOrderKey, keyBetween, keysBetween } from "../../shared/order.js";

/** @typedef {import("../../shared/protocol.js").Card} Card */

/**
 * Key for a card placed before `beforeCardId` (or at the end when null or not in the column).
 * When the neighbours' keys are unusable (malformed, equal or out of order), the whole column is
 * re-keyed: `rekey` lists the other cards whose keys must change, in column order.
 *
 * @param {Record<string, Card>} cards   the optimistic board's cards
 * @param {string} columnId
 * @param {string|null|undefined} beforeCardId
 * @param {string|null} [movingCardId]   excluded from the neighbours
 * @returns {{order: string, rekey: {cardId: string, order: string}[]}}
 */
export function placeCard(cards, columnId, beforeCardId, movingCardId = null) {
  const list = cardsInColumn(cards, columnId).filter((c) => c.id !== movingCardId);
  let at = beforeCardId ? list.findIndex((c) => c.id === beforeCardId) : -1;
  if (at < 0) at = list.length;
  const prev = at > 0 ? list[at - 1].order : null;
  const next = at < list.length ? list[at].order : null;
  const ok = (prev === null || isValidOrderKey(prev)) && (next === null || isValidOrderKey(next)) &&
    (prev === null || next === null || prev < next);
  if (ok) {
    try {
      return { order: keyBetween(prev, next), rekey: [] };
    } catch {
      // fall through to a full re-key
    }
  }
  const keys = keysBetween(null, null, list.length + 1);
  /** @type {{cardId: string, order: string}[]} */
  const rekey = [];
  let k = 0;
  let order = "";
  for (let i = 0; i <= list.length; i++) {
    if (i === at) order = keys[k++];
    if (i < list.length) {
      const key = keys[k++];
      if (list[i].order !== key) rekey.push({ cardId: list[i].id, order: key });
    }
  }
  return { order, rekey };
}
