// @ts-check
// The normalised, derived view of a work datastore: every record of the snapshot (plus applied
// journal pages) turned into typed views and indexes. Rebuilt from the raw records whenever they
// change (a few milliseconds for 5,000 records), so it is always consistent and never mutated in
// place. Shared by the client store, the gadget server's query cache and WQL.

import {
  DEFAULT_STATES, KIND_COLORS, STATE_FOR_STATUS, V1_STATES, actorLabel, categoryOfKind, dateOnly, instant,
  keyPrefixFrom, priorityOf, refId, safeColor,
} from "./work.js";

/**
 * A raw Records record as the snapshot and journal carry it.
 * @typedef {{ id: string, entity: string, revision: number, created_by?: string, updated_by?: string,
 *   created_at?: string, updated_at?: string, data: Record<string, any> }} RawRecord
 *
 * @typedef {{ id: string|null, key: string, name: string, kind: string, category: "open"|"active"|"done",
 *   position: number, color: string, wipLimit: number|null, revision: number, virtual: boolean }} StateView
 * @typedef {{ id: string|null, key: string, name: string, color: string, description: string, archived: boolean, revision: number }} LabelView
 * @typedef {{ id: string, name: string, description: string, state: string, lead: string|null, start: string|null,
 *   target: string|null, color: string, archived: boolean, revision: number }} ProjectView
 * @typedef {{ id: string, name: string, number: number|null, start: string|null, end: string|null, goal: string, revision: number }} CycleView
 * @typedef {{ id: string, from: string, to: string, kind: "blocks"|"relates"|"duplicates", active: boolean, revision: number,
 *   created_by: string|null }} RelationView
 * @typedef {{ id: string, item: string, body: string, edited: boolean, revision: number, created_by: string|null,
 *   updated_by: string|null, created: number|null }} CommentView
 *
 * @typedef {{
 *   id: string, revision: number, raw: RawRecord, key: string, number: number|null,
 *   title: string, description: string, status: "open"|"active"|"done",
 *   state: string, kind: string, category: "open"|"active"|"done",
 *   priority: 0|1|2|3|4, assignee: string|null, labels: string[], estimate: number|null,
 *   start: string|null, due: string|null, parent: string|null, project: string|null, cycle: string|null,
 *   rank: string, archived: boolean, created_by: string|null, updated_by: string|null,
 *   created: number|null, updated: number|null, ext: Record<string, unknown>,
 * }} ItemView
 *
 * @typedef {{ id: string, name: string }} Person
 *
 * @typedef {{
 *   planning: boolean, keyPrefix: string,
 *   records: Map<string, RawRecord>,
 *   items: Map<string, ItemView>, itemList: ItemView[], byNumber: Map<number, ItemView>,
 *   states: StateView[], stateByKey: Map<string, StateView>, virtualStates: boolean,
 *   labels: LabelView[], labelByKey: Map<string, LabelView>,
 *   projects: ProjectView[], projectById: Map<string, ProjectView>,
 *   cycles: CycleView[], cycleById: Map<string, CycleView>,
 *   relations: RelationView[], relationsOf: Map<string, RelationView[]>,
 *   comments: Map<string, CommentView[]>, children: Map<string, ItemView[]>,
 *   blockedBy: Map<string, string[]>, blocking: Map<string, string[]>,
 *   people: Map<string, Person>, names: Map<string, string>,
 * }} WorkIndex
 */

/**
 * @param {Iterable<RawRecord>} records
 * @param {{ planning?: boolean, keyPrefix?: string|null, label?: string|null, names?: Map<string, string>,
 *   times?: Map<string, { created: number|null, updated: number|null }> }} [options]
 *   `times`: first/last change times per record learned from the journal, when records carry none.
 * @returns {WorkIndex}
 */
export function buildIndex(records, options = {}) {
  /** @type {Map<string, RawRecord>} */
  const all = new Map();
  /** @type {Record<string, RawRecord[]>} */
  const byEntity = { work_item: [], project: [], cycle: [], workflow_state: [], label: [], relation: [], comment: [] };
  for (const record of records) {
    if (!record || typeof record.id !== "string") continue;
    all.set(record.id, record);
    byEntity[record.entity]?.push(record);
  }
  const planning = options.planning ?? (byEntity.workflow_state.length > 0 || byEntity.work_item.some((r) => r.data && "number" in r.data));
  const keyPrefix = options.keyPrefix || keyPrefixFrom(options.label ?? "");
  const names = options.names ?? new Map();
  const times = options.times ?? new Map();

  // Workflow states: real ones, else the defaults the service will seed (or the v1 statuses).
  /** @type {StateView[]} */
  let states = byEntity.workflow_state.map((r) => {
    const kind = typeof r.data.kind === "string" && r.data.kind in KIND_COLORS ? r.data.kind : kindFromCategory(r.data.category);
    return {
      id: r.id, key: String(r.data.key ?? r.id), name: String(r.data.name ?? r.data.key ?? "State"), kind,
      category: categoryOfKind(kind), position: Number.isFinite(r.data.position) ? Number(r.data.position) : 999,
      color: safeColor(r.data.color, /** @type {any} */ (KIND_COLORS)[kind]),
      wipLimit: Number.isInteger(r.data.wip_limit) && r.data.wip_limit > 0 ? r.data.wip_limit : null,
      revision: r.revision, virtual: false,
    };
  });
  const virtualStates = states.length === 0;
  if (virtualStates) {
    states = (planning ? DEFAULT_STATES : V1_STATES).map((s) => ({
      id: null, key: s.key, name: s.name, kind: s.kind, category: categoryOfKind(s.kind), position: s.position,
      color: safeColor(/** @type {any} */ (s).color, /** @type {any} */ (KIND_COLORS)[s.kind]), wipLimit: null, revision: 0, virtual: true,
    }));
  }
  states.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  const stateByKey = new Map(states.map((s) => [s.key, s]));

  /** @type {LabelView[]} */
  const labels = byEntity.label.map((r) => ({
    id: r.id, key: String(r.data.key ?? r.data.name ?? r.id), name: String(r.data.name ?? r.data.key ?? ""),
    color: safeColor(r.data.color, "#8a8f98"), description: String(r.data.description ?? ""), archived: r.data.archived === true,
    revision: r.revision,
  }));
  const labelByKey = new Map(labels.map((l) => [l.key, l]));

  /** @type {ProjectView[]} */
  const projects = byEntity.project.map((r) => ({
    id: r.id, name: String(r.data.name ?? "Untitled project"), description: String(r.data.description ?? ""),
    state: String(r.data.state ?? "planned"), lead: typeof r.data.lead === "string" ? r.data.lead : null,
    start: dateOnly(r.data.start_date), target: dateOnly(r.data.target_date), color: safeColor(r.data.color, "#5b6ee1"),
    archived: r.data.archived === true, revision: r.revision,
  })).toSorted((a, b) => a.name.localeCompare(b.name));
  const projectById = new Map(projects.map((p) => [p.id, p]));

  /** @type {CycleView[]} */
  const cycles = byEntity.cycle.map((r) => ({
    id: r.id, name: String(r.data.name ?? ""), number: Number.isInteger(r.data.number) ? r.data.number : null,
    start: dateOnly(r.data.starts_on), end: dateOnly(r.data.ends_on), goal: String(r.data.goal ?? ""), revision: r.revision,
  })).map((c) => ({ ...c, name: c.name || (c.number ? `Cycle ${c.number}` : "Cycle") }))
    .toSorted((a, b) => String(a.start ?? "9999").localeCompare(String(b.start ?? "9999")) || (a.number ?? 0) - (b.number ?? 0));
  const cycleById = new Map(cycles.map((c) => [c.id, c]));

  // Items.
  /** @type {Map<string, ItemView>} */
  const items = new Map();
  /** @type {Map<number, ItemView>} */
  const byNumber = new Map();
  /** @type {Map<string, Person>} */
  const people = new Map();
  const person = (/** @type {unknown} */ actor) => {
    if (typeof actor !== "string" || !actor || people.has(actor)) return;
    people.set(actor, { id: actor, name: actorLabel(actor, names) });
  };
  const env = { keyPrefix, stateByKey, states, times };
  for (const r of byEntity.work_item) {
    const item = makeItem(r, env);
    const number = item.number;
    items.set(item.id, item);
    if (number) byNumber.set(number, item);
    person(item.assignee); person(item.created_by); person(item.updated_by);
  }
  for (const p of projects) person(p.lead);

  // Children (only real parents), relations and the blocking graph.
  /** @type {Map<string, ItemView[]>} */
  const children = new Map();
  for (const item of items.values()) {
    if (!item.parent || !items.has(item.parent) || item.parent === item.id) continue;
    let list = children.get(item.parent);
    if (!list) children.set(item.parent, list = []);
    list.push(item);
  }
  /** @type {RelationView[]} */
  const relations = [];
  /** @type {Map<string, RelationView[]>} */
  const relationsOf = new Map();
  /** @type {Map<string, string[]>} */
  const blockedBy = new Map();
  /** @type {Map<string, string[]>} */
  const blocking = new Map();
  const push = (/** @type {Map<string, any[]>} */ map, /** @type {string} */ key, /** @type {any} */ value) => {
    const list = map.get(key);
    if (list) list.push(value); else map.set(key, [value]);
  };
  for (const r of byEntity.relation) {
    const from = refId(r.data.from), to = refId(r.data.to);
    const kind = r.data.kind === "blocks" || r.data.kind === "duplicates" ? r.data.kind : "relates";
    if (!from || !to) continue;
    /** @type {RelationView} */
    const rel = { id: r.id, from, to, kind, active: r.data.active !== false, revision: r.revision, created_by: r.created_by ?? null };
    relations.push(rel);
    if (!rel.active) continue;
    push(relationsOf, from, rel);
    push(relationsOf, to, rel);
    // A blocker stops blocking once it is done (Linear moves it to "related").
    const blocker = items.get(from), blocked = items.get(to);
    if (kind === "blocks" && blocker && blocked && blocker.category !== "done") {
      push(blockedBy, to, from);
      push(blocking, from, to);
    }
  }

  /** @type {Map<string, CommentView[]>} */
  const comments = new Map();
  for (const r of byEntity.comment) {
    const item = refId(r.data.item);
    if (!item) continue;
    push(comments, item, {
      id: r.id, item, body: String(r.data.body ?? ""), edited: r.data.edited === true, revision: r.revision,
      created_by: r.created_by ?? null, updated_by: r.updated_by ?? null,
      created: instant(r.created_at ?? r.data.created_at) ?? times.get(r.id)?.created ?? null,
    });
    person(r.created_by);
  }
  for (const list of comments.values()) list.sort((a, b) => a.revision - b.revision);

  const itemList = [...items.values()];
  return {
    planning, keyPrefix, records: all, items, itemList, byNumber, states, stateByKey, virtualStates,
    labels, labelByKey, projects, projectById, cycles, cycleById, relations, relationsOf, comments,
    children, blockedBy, blocking, people, names,
  };
}

/**
 * @param {RawRecord} r
 * @param {{ keyPrefix: string, stateByKey: Map<string, StateView>, states: StateView[], times: Map<string, { created: number|null, updated: number|null }> }} env
 * @returns {ItemView}
 */
function makeItem(r, env) {
  const d = r.data ?? {};
  const status = d.status === "active" || d.status === "done" ? d.status : "open";
  const state = resolveState(d.state, status, env.stateByKey, env.states);
  const number = Number.isInteger(d.number) && d.number > 0 ? d.number : null;
  const learned = env.times.get(r.id);
  return {
    id: r.id, revision: r.revision, raw: r, number,
    key: number ? `${env.keyPrefix}-${number}` : `#${r.id.slice(0, 6)}`,
    title: String(d.title ?? ""), description: String(d.description ?? ""), status,
    state: state.key, kind: state.kind, category: state.category,
    priority: priorityOf(d.priority), assignee: typeof d.assignee === "string" && d.assignee ? d.assignee : null,
    labels: Array.isArray(d.labels) ? d.labels.filter((l) => typeof l === "string" && l) : [],
    estimate: typeof d.estimate === "number" && Number.isFinite(d.estimate) ? d.estimate : null,
    start: dateOnly(d.start_date), due: dateOnly(d.due_date),
    parent: refId(d.parent), project: refId(d.project), cycle: refId(d.cycle),
    rank: typeof d.rank === "string" ? d.rank : "", archived: d.archived === true,
    created_by: r.created_by ?? null, updated_by: r.updated_by ?? null,
    created: instant(r.created_at ?? d.created_at) ?? learned?.created ?? null,
    updated: instant(r.updated_at ?? d.updated_at) ?? learned?.updated ?? null,
    ext: d.extensions && typeof d.extensions === "object" && !Array.isArray(d.extensions) ? d.extensions : {},
  };
}

/**
 * An item as it would be after `input` (a work.create/work.update input) is applied: how pending
 * changes are previewed. The id of a not-yet-created item is `pending:<n>`.
 * @param {WorkIndex} index @param {ItemView|null} item @param {Record<string, unknown>} input @param {string} [pendingId]
 */
export function projectItem(index, item, input, pendingId = "pending") {
  const { id: _id, ...fields } = /** @type {Record<string, unknown>} */ (input);
  const data = { ...item?.raw.data, ...fields };
  if ("state" in fields && !("status" in fields)) {
    const s = index.stateByKey.get(String(fields.state));
    if (s) data.status = s.category;
  } else if ("status" in fields && !("state" in fields)) {
    delete data.state;
  }
  for (const key of Object.keys(data)) if (data[key] === null) delete data[key];
  const raw = { ...(item?.raw ?? { id: pendingId, entity: "work_item", revision: 0 }), data };
  const out = makeItem(raw, { keyPrefix: index.keyPrefix, stateByKey: index.stateByKey, states: index.states, times: new Map() });
  if (!item) out.key = "New";
  return out;
}

/** @param {unknown} category */
function kindFromCategory(category) {
  return category === "active" ? "started" : category === "done" ? "completed" : "unstarted";
}

/**
 * The state an item is in: its `state` when that names a known state, else the state its v1
 * status maps to, else the first state of the status's category.
 * @param {unknown} key @param {"open"|"active"|"done"} status
 * @param {Map<string, StateView>} byKey @param {StateView[]} states
 * @returns {StateView}
 */
export function resolveState(key, status, byKey, states) {
  if (typeof key === "string" && byKey.has(key)) return /** @type {StateView} */ (byKey.get(key));
  const mapped = byKey.get(status) ?? byKey.get(STATE_FOR_STATUS[status]);
  if (mapped && mapped.category === status) return mapped;
  return states.find((s) => s.category === status) ?? states[0];
}

/** Active relations of an item, split the way the detail panel shows them. @param {WorkIndex} index @param {string} id */
export function relationsFor(index, id) {
  const out = { blocks: /** @type {RelationView[]} */ ([]), blockedBy: /** @type {RelationView[]} */ ([]), relates: /** @type {RelationView[]} */ ([]), duplicates: /** @type {RelationView[]} */ ([]), duplicatedBy: /** @type {RelationView[]} */ ([]) };
  for (const rel of index.relationsOf.get(id) ?? []) {
    if (rel.kind === "blocks") (rel.from === id ? out.blocks : out.blockedBy).push(rel);
    else if (rel.kind === "duplicates") (rel.from === id ? out.duplicates : out.duplicatedBy).push(rel);
    else out.relates.push(rel);
  }
  return out;
}

/** Sub-issue progress: done / total children. @param {WorkIndex} index @param {string} id */
export function progressOf(index, id) {
  const list = index.children.get(id);
  if (!list?.length) return null;
  const live = list.filter((c) => !c.archived);
  return { done: live.filter((c) => c.category === "done").length, total: live.length };
}

/** @param {WorkIndex} index @param {string} key e.g. "WRK-12", "12", "#1a2b3c" */
export function itemByKey(index, key) {
  const text = String(key ?? "").trim();
  const numeric = /^(?:[A-Za-z][A-Za-z0-9]*-)?(\d+)$/.exec(text);
  if (numeric) return index.byNumber.get(Number(numeric[1])) ?? null;
  if (text.startsWith("#")) {
    const prefix = text.slice(1).toLowerCase();
    for (const item of index.items.values()) if (item.id.startsWith(prefix)) return item;
    return null;
  }
  return index.items.get(text.toLowerCase()) ?? null;
}

/** @param {WorkIndex} index @param {string|null} actor */
export function personName(index, actor) {
  if (!actor) return "Unassigned";
  return index.people.get(actor)?.name ?? actorLabel(actor, index.names);
}
