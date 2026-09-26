// @ts-check
// Board projection: filtered, sorted items laid out as columns (one property) × swimlanes (an
// optional second property). Multi-valued lane properties (labels) put a card in every matching
// lane; each extra copy is marked as a mirror. Pending changes appear as ghost cards where they
// will land; the committed card stays where it is until Records has saved the change.

import { projectItem } from "../../shared/model/index.js";
import { NONE, property } from "../../shared/model/properties.js";

/**
 * @typedef {import("../../shared/model/index.js").ItemView} ItemView
 * @typedef {import("../../shared/model/index.js").WorkIndex} WorkIndex
 * @typedef {import("../../shared/model/properties.js").Group} Group
 * @typedef {import("../store/store.js").Change} Change
 * @typedef {{ kind: "card", key: string, item: ItemView, mirror: boolean, pending: Change|null }
 *   | { kind: "ghost", key: string, item: ItemView, change: Change, create: boolean }} Entry
 * @typedef {{ group: Group, count: number, estimate: number, wip: { limit: number, over: boolean }|null }} ColumnInfo
 * @typedef {{ group: Group|null, key: string, count: number, estimate: number, cells: Map<string, Entry[]> }} Lane
 * @typedef {{ columns: ColumnInfo[], lanes: Lane[], total: number, columnsBy: string, swimlanesBy: string|null }} Projection
 */

export const SINGLE_LANE = "__all__";

/**
 * @param {{
 *   index: WorkIndex, items: ItemView[], columnsBy: string, swimlanesBy: string|null,
 *   ctx: { index: WorkIndex, today: string, viewer: string|null },
 *   changes?: Change[], matches?: (item: ItemView) => boolean, compare?: (a: ItemView, b: ItemView) => number,
 *   hideEmptyLanes?: boolean, hideEmptyColumns?: boolean, showSubIssues?: boolean,
 * }} p
 * @returns {Projection}
 */
export function project(p) {
  const colProp = /** @type {import("../../shared/model/properties.js").Property} */ (property(p.columnsBy) ?? property("state"));
  const laneProp = p.swimlanesBy ? property(p.swimlanesBy) : null;
  const ctx = p.ctx;
  let items = p.items;
  if (p.showSubIssues === false) items = items.filter((i) => !i.parent || !p.index.items.has(i.parent));

  const colGroups = colProp.groups(ctx, items);
  const laneGroups = laneProp ? laneProp.groups(ctx, items) : null;
  const colKeys = new Set(colGroups.map((g) => g.key));

  /** @type {Map<string, Lane>} */
  const lanes = new Map();
  const newLane = (/** @type {Group|null} */ group) => {
    /** @type {Lane} */
    const lane = { group, key: group ? group.key : SINGLE_LANE, count: 0, estimate: 0, cells: new Map(colGroups.map((g) => [g.key, /** @type {Entry[]} */ ([])])) };
    lanes.set(lane.key, lane);
    return lane;
  };
  if (laneGroups) for (const g of laneGroups) newLane(g); else newLane(null);

  /** @type {Map<string, { count: number, estimate: number }>} */
  const colTotals = new Map(colGroups.map((g) => [g.key, { count: 0, estimate: 0 }]));
  /** @type {Map<string, Change>} */
  const pendingByItem = new Map();
  for (const c of p.changes ?? []) {
    if (c.itemId && (c.status === "saving" || c.status === "pending" || (c.status === "applied" && !c.settledAt))) pendingByItem.set(c.itemId, c);
  }

  /** @param {ItemView} item @returns {[string, string[]]} column key and lane keys */
  const place = (item) => {
    let col = colProp.keysOf(item, ctx)[0] ?? NONE;
    if (!colKeys.has(col)) col = colGroups[colGroups.length - 1]?.key ?? NONE;
    const laneKeys = laneProp ? laneProp.keysOf(item, ctx) : [SINGLE_LANE];
    return [col, laneKeys];
  };

  for (const item of items) {
    const [col, laneKeys] = place(item);
    const pending = pendingByItem.get(item.id) ?? null;
    laneKeys.forEach((lk, i) => {
      const lane = lanes.get(lk) ?? newLane(/** @type {Group} */ ({ key: lk, label: lk }));
      lane.cells.get(col)?.push({ kind: "card", key: lk === SINGLE_LANE || i === 0 ? item.id : `${item.id}@${lk}`, item, mirror: i > 0, pending });
      lane.count++;
      lane.estimate += item.estimate ?? 0;
    });
    const total = colTotals.get(col);
    if (total) { total.count++; total.estimate += item.estimate ?? 0; }
  }

  // Ghosts: pending creates, and pending updates that land somewhere else.
  const compare = p.compare ?? (() => 0);
  for (const c of p.changes ?? []) {
    const unsettled = c.status === "saving" || c.status === "pending" || (c.status === "applied" && !c.settledAt);
    if (!unsettled) continue;
    if (c.command === "work.create") {
      // The record can arrive (journal pull) before the outcome poll says it was applied.
      if (c.resultId && p.index.items.has(c.resultId)) continue;
      const ghost = projectItem(p.index, null, c.input, `pending:${c.id}`);
      if (p.matches && !p.matches(ghost)) continue;
      insertGhost(ghost, c, true);
    } else if (c.command === "work.update" && c.itemId) {
      const item = p.index.items.get(c.itemId);
      if (!item || (c.status === "applied" && c.resultRevision !== null && item.revision >= c.resultRevision)) continue;
      const ghost = projectItem(p.index, item, c.input);
      if (p.matches && !p.matches(ghost)) continue;
      const [fromCol, fromLanes] = place(item);
      const [toCol, toLanes] = place(ghost);
      const moved = fromCol !== toCol || fromLanes.join("\n") !== toLanes.join("\n") || ghost.rank !== item.rank;
      if (moved) insertGhost(ghost, c, false);
    }
  }

  /** @param {ItemView} ghost @param {Change} change @param {boolean} create */
  function insertGhost(ghost, change, create) {
    const [col, laneKeys] = place(ghost);
    for (const lk of laneKeys) {
      const cell = lanes.get(lk)?.cells.get(col);
      if (!cell) continue;
      let at = cell.findIndex((e) => e.kind === "card" && compare(ghost, e.item) < 0);
      if (at === -1) at = cell.length;
      cell.splice(at, 0, { kind: "ghost", key: `ghost-${change.id}${lk === SINGLE_LANE ? "" : `@${lk}`}`, item: ghost, change, create });
    }
  }

  let laneList = [...lanes.values()];
  if (p.hideEmptyLanes && laneProp) laneList = laneList.filter((l) => l.count > 0 || [...l.cells.values()].some((c) => c.length));
  let columns = colGroups.map((group) => {
    const t = /** @type {{ count: number, estimate: number }} */ (colTotals.get(group.key));
    const limit = group.wipLimit ?? null;
    return { group, count: t.count, estimate: t.estimate, wip: limit ? { limit, over: t.count > limit } : null };
  });
  if (p.hideEmptyColumns) {
    const keep = new Set(columns.filter((c) => c.count > 0).map((c) => c.group.key));
    for (const lane of laneList) for (const [key, cell] of lane.cells) if (cell.length) keep.add(key);
    columns = columns.filter((c) => keep.has(c.group.key));
  }
  return { columns, lanes: laneList, total: items.length, columnsBy: colProp.field, swimlanesBy: laneProp?.field ?? null };
}

/**
 * The patch that moves `item` to column `toCol` and lane `toLane`, from lane `fromLane` (the lane
 * the card was dragged from; matters for labels). Returns `{ patch }` or `{ error }`.
 * @param {{ ctx: { index: WorkIndex, today: string, viewer: string|null }, columnsBy: string, swimlanesBy: string|null }} p
 * @param {ItemView} item @param {{ toCol: string, toLane: string, fromLane: string, rank?: string|null }} move
 */
export function movePatch(p, item, move) {
  const colProp = property(p.columnsBy);
  const laneProp = p.swimlanesBy ? property(p.swimlanesBy) : null;
  /** @type {Record<string, unknown>} */
  const patch = {};
  if (colProp && colProp.keysOf(item, p.ctx)[0] !== move.toCol) {
    if (!colProp.settable) return { error: colProp.why ?? `${colProp.label} cannot be changed by moving.` };
    Object.assign(patch, colProp.patch(item, colProp.keysOf(item, p.ctx)[0], move.toCol, p.ctx) ?? {});
  }
  if (laneProp && move.toLane !== move.fromLane && move.toLane !== SINGLE_LANE) {
    if (!laneProp.settable) return { error: laneProp.why ?? `${laneProp.label} cannot be changed by moving.` };
    const lanePatch = laneProp.patch(item, move.fromLane, move.toLane, p.ctx);
    if (lanePatch) Object.assign(patch, lanePatch);
  }
  if (move.rank && move.rank !== item.rank) patch.rank = move.rank;
  return { patch };
}
