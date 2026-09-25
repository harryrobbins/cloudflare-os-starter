// @ts-check
// Pure board state: committed work items from a snapshot plus journal pages. Pending changes are
// kept separately by the UI and never alter committed items.

export const STATUSES = /** @type {const} */ (["open", "active", "done"]);
export const STATUS_LABELS = { open: "Open", active: "Active", done: "Done" };
export const TITLE_MAX = 500;

/**
 * @typedef {{ id: string, entity: string, revision: number, data: Record<string, any> }} WorkItem
 * @typedef {{ items: Map<string, WorkItem>, cursor: number, epoch: number|null }} BoardState
 */

/** @returns {BoardState} */
export function emptyState() { return { items: new Map(), cursor: 0, epoch: null }; }

/** @param {{ records: WorkItem[], seq: number, permission_epoch: number }} snapshot @returns {BoardState} */
export function fromSnapshot(snapshot) {
  const items = new Map();
  for (const record of snapshot.records) if (record.entity === "work_item") items.set(record.id, record);
  return { items, cursor: snapshot.seq, epoch: snapshot.permission_epoch };
}

/**
 * Applies one whole journal page, returning a new state. Entries older than a record's current
 * revision are ignored, so replays are harmless.
 * @param {BoardState} state
 * @param {{ changes: { entity: string, record_id: string, revision: number, data: Record<string, any> }[], cursor: number, permission_epoch: number }} page
 * @returns {BoardState}
 */
export function applyChanges(state, page) {
  const items = new Map(state.items);
  for (const change of page.changes) {
    if (change.entity !== "work_item") continue;
    const current = items.get(change.record_id);
    if (current && current.revision >= change.revision) continue;
    items.set(change.record_id, { id: change.record_id, entity: change.entity, revision: change.revision, data: change.data ?? {} });
  }
  return { items, cursor: Math.max(state.cursor, page.cursor), epoch: page.permission_epoch };
}

/** @param {unknown} status */
export function statusOf(status) {
  return STATUSES.includes(/** @type {any} */ (status)) ? /** @type {typeof STATUSES[number]} */ (status) : "open";
}

/** Items grouped by status, each column sorted by title then id. @param {BoardState} state */
export function columns(state) {
  /** @type {Record<string, WorkItem[]>} */
  const out = { open: [], active: [], done: [] };
  for (const item of state.items.values()) out[statusOf(item.data.status)].push(item);
  for (const list of Object.values(out)) {
    list.sort((a, b) => String(a.data.title ?? "").localeCompare(String(b.data.title ?? "")) || a.id.localeCompare(b.id));
  }
  return out;
}

/** @param {unknown} raw @returns {{ ok: true, title: string } | { ok: false, error: string }} */
export function validTitle(raw) {
  const title = typeof raw === "string" ? raw.trim() : "";
  if (!title) return { ok: false, error: "Enter a title." };
  if (title.length > TITLE_MAX) return { ok: false, error: `Titles can be at most ${TITLE_MAX} characters.` };
  return { ok: true, title };
}

/**
 * The fields of an edit that differ from the item, as a work.update input (absent fields omitted).
 * @param {WorkItem} item @param {{ title?: string, description?: string, status?: string }} edit
 */
export function changedFields(item, edit) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of /** @type {const} */ (["title", "description", "status"])) {
    const value = edit[key];
    if (value !== undefined && value !== (item.data[key] ?? "")) out[key] = value;
  }
  return out;
}

/** Whether a description names a work v1 datastore. @param {any} description */
export function isWorkV1(description) {
  return description?.module_id === "work" && description?.api_major === 1;
}
