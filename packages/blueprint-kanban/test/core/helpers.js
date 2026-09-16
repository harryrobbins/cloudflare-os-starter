import { InMemoryRepository } from "../../src/core/repository.js";
import { createBoard } from "../../src/core/board.js";

export function setup(options = {}) {
  const repo = new InMemoryRepository();
  let t = 1_700_000_000_000;
  const events = [];
  const board = createBoard(repo, { now: () => (t += 1000), onEvent: (e) => events.push(e), ...options });
  return { repo, board, events };
}

/** Board with default columns; returns ids by name. */
export async function ready(options) {
  const ctx = setup(options);
  const snap = await ctx.board.getBoard();
  const col = Object.fromEntries(snap.columnOrder.map((id) => [snap.columns[id].name, id]));
  const label = Object.fromEntries(Object.values(snap.labels).map((l) => [l.name, l.id]));
  return { ...ctx, snap, col, label };
}

let n = 0;
export const cid = () => "c_" + (n++).toString(16).padStart(8, "0");
export const kid = () => "k_" + (0x10000000 + n++).toString(16).padStart(8, "0");
export const lid = () => "l_" + (0x20000000 + n++).toString(16).padStart(8, "0");

export async function create(board, columnId, card = {}, extra = {}) {
  const cardId = extra.cardId ?? cid();
  const { result } = await board.applyOperation({
    by: "Tester", senderId: "s1", ...extra,
    cardOps: [{ op: "upsert", cardId, columnId, baseVersion: 0, card }],
  });
  return { cardId, result, card: result.upserts.find((c) => c.id === cardId) };
}
