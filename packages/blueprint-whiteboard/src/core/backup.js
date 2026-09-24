// @ts-check
// exportData() and importData(): the agent-facing side of the portable board format
// (src/shared/backup.js). Both are built on the whiteboard's public methods only: an import is a
// sequence of ordinary applyOperation requests, each at most LIMITS.opsPerRequest creates, so
// every imported object goes through the same validation, caps, history and fan-out as any edit.

import { LIMITS, isObject, newId as protocolNewId } from "../shared/protocol.js";
import { buildBackup, importOffset, parseBackup, planCreates } from "../shared/backup.js";

/** @typedef {import("../shared/backup.js").BackupDocument} BackupDocument */
/** @typedef {import("../shared/protocol.js").OpError} OpError */

/**
 * @typedef {object} ImportResult
 * @property {number} created           objects created
 * @property {string[]} ids             their new ids, in creation order
 * @property {Record<string, number>} counts  objects per type the document held (after validation)
 * @property {number} skipped           objects the document held that were not usable
 * @property {string[]} problems        why (the first few), from reading the document
 * @property {OpError[]} errors         ops the board rejected; `index` is the object's position in the document
 * @property {number} revision
 */

/**
 * @param {{getBoard: () => Promise<any>}} board
 * @returns {Promise<BackupDocument>}
 */
export async function exportData(board) {
  return buildBackup(await board.getBoard());
}

/**
 * Imports a backup or clipboard document: `data` (the document or its JSON text), `at` (optional
 * top-left), `structure: true` to also take its title and background, `by`, `senderId`.
 * @param {{getBoard: () => Promise<any>, applyOperation: (req: any) => Promise<{result: any}>}} board
 * @param {any} args
 * @param {{newId?: () => string}} [opts]
 * @returns {Promise<ImportResult|{error: string}>}
 */
export async function importData(board, args, { newId = () => protocolNewId("object") } = {}) {
  const a = isObject(args) ? args : {};
  const parsed = parseBackup(a.data);
  if ("error" in parsed) return { error: parsed.error };
  const current = await board.getBoard();
  const room = Math.max(0, LIMITS.objects - Object.keys(current.objects ?? {}).length);
  const { dx, dy } = importOffset(parsed.entries, current.objects ?? {}, a.at);
  const { creates, idMap, dropped } = planCreates(parsed.entries, { newId, dx, dy, max: room });
  // Caller index per new id: the object's position in the document.
  /** @type {Map<string, number>} */
  const indexOfId = new Map();
  for (const e of parsed.entries) {
    const id = idMap.get(e.ref);
    if (id) indexOfId.set(id, e.index);
  }
  /** @type {OpError[]} */
  const errors = [];
  if (dropped) errors.push({ index: -1, code: "limit", message: `${dropped} objects were not imported: the board holds at most ${LIMITS.objects}.` });
  /** @type {string[]} */
  const ids = [];
  let revision = current.revision ?? 0;
  const common = { by: a.by, senderId: a.senderId };
  for (let i = 0; i < creates.length; i += LIMITS.opsPerRequest) {
    const chunk = creates.slice(i, i + LIMITS.opsPerRequest);
    const { result } = await board.applyOperation({ ...common, objectOps: chunk.map((object) => ({ op: "create", object })) });
    revision = result.revision;
    const failed = new Set();
    for (const e of result.errors ?? []) {
      const id = e.index >= 0 ? chunk[e.index]?.id : undefined;
      if (id) failed.add(id);
      errors.push({ ...e, index: id ? indexOfId.get(id) ?? -1 : -1 });
    }
    for (const c of chunk) if (!failed.has(c.id)) ids.push(c.id);
  }
  if (a.structure === true && (parsed.title || parsed.background)) {
    /** @type {Record<string, string>} */
    const structure = {};
    if (parsed.title) structure.title = parsed.title;
    if (parsed.background) structure.background = parsed.background;
    const { result } = await board.applyOperation({ ...common, structure });
    revision = result.revision;
  }
  return {
    created: ids.length, ids, counts: parsed.counts, skipped: parsed.skipped, problems: parsed.errors,
    errors: errors.slice(0, 50), revision,
  };
}
