// @ts-check
// What differs between two optimistic board views, for narrow re-rendering.

import { deepEqual } from "./equal.js";

/** @typedef {import("../../shared/protocol.js").BoardSnapshot} BoardSnapshot */

/**
 * @param {BoardSnapshot} prev
 * @param {BoardSnapshot} next
 * @returns {{all: boolean, columns: string[], cards: string[]}}
 *   `cards`: ids whose card was added, removed or changed. `columns`: ids of columns containing a
 *   changed card before or after the change. `all`: title, column list/order/names/collapsed or
 *   labels changed.
 */
export function diffBoards(prev, next) {
  const cards = new Set();
  const columns = new Set();
  for (const [id, card] of Object.entries(next.cards)) {
    const old = prev.cards[id];
    if (old === card) continue;
    if (old && deepEqual(old, card)) continue;
    cards.add(id);
    columns.add(card.columnId);
    if (old) columns.add(old.columnId);
  }
  for (const [id, old] of Object.entries(prev.cards)) {
    if (!next.cards[id]) {
      cards.add(id);
      columns.add(old.columnId);
    }
  }
  const all = prev.title !== next.title ||
    (prev.columnOrder !== next.columnOrder && !deepEqual(prev.columnOrder, next.columnOrder)) ||
    (prev.columns !== next.columns && !deepEqual(prev.columns, next.columns)) ||
    (prev.labels !== next.labels && !deepEqual(prev.labels, next.labels));
  return { all, columns: [...columns], cards: [...cards] };
}
