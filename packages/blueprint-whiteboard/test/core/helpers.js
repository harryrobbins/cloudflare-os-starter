import { InMemoryRepository } from "../../src/core/repository.js";
import { createWhiteboard } from "../../src/core/whiteboard.js";

export function setup(options = {}) {
  const repo = new InMemoryRepository();
  let t = 1_700_000_000_000;
  const events = [];
  const board = createWhiteboard(repo, { now: () => (t += 1000), onEvent: (e) => events.push(e), ...options });
  return { repo, board, events };
}

let n = 0;
/** A fresh, valid object id. */
export const oid = () => "o_" + (0x100000000000 + n++).toString(16);

export const apply = async (board, req) => (await board.applyOperation(req)).result;

export const createOp = (object) => ({ op: "create", object: { id: oid(), type: "sticky", ...object } });
export const updateOp = (id, baseVersion, patch) => ({ op: "update", id, baseVersion, patch });
export const deleteOp = (id, baseVersion) => ({ op: "delete", id, baseVersion });

/** Creates one object and returns it as stored. */
export async function create(board, object = {}, extra = {}) {
  const op = createOp(object);
  const result = await apply(board, { by: "Tester", senderId: "s1", ...extra, objectOps: [op] });
  return { id: op.object.id, result, obj: result.upserts.find((o) => o.id === op.object.id) };
}

export const pen = (extra = {}) => ({ type: "pen", points: [0, 0, 1, 1], w: 100, h: 100, ...extra });
