// @ts-check
// Properties the board can group by (columns) or project into swimlanes. Each descriptor lists
// its groups in natural order ("No value" last), says which group(s) an item belongs to, and how
// to move an item from one group to another as a work.update patch (null: not settable).

import { personName } from "./index.js";
import { CATEGORY_LABELS, KIND_COLORS, PRIORITIES, PRIORITY_ORDER, addDays, refOut } from "./work.js";

export const NONE = "__none__";

/**
 * @typedef {import("./index.js").WorkIndex} WorkIndex
 * @typedef {import("./index.js").ItemView} ItemView
 * @typedef {{ key: string, label: string, color?: string, person?: string, priority?: number, stateKind?: string,
 *   wipLimit?: number|null, none?: boolean }} Group
 * @typedef {{ index: WorkIndex, today: string, viewer: string|null }} GroupContext
 * @typedef {{
 *   field: string, label: string, noneLabel: string, multi: boolean, settable: boolean, column: boolean,
 *   groups: (ctx: GroupContext, items: ItemView[]) => Group[],
 *   keysOf: (item: ItemView, ctx: GroupContext) => string[],
 *   patch: (item: ItemView, from: string, to: string, ctx: GroupContext) => Record<string, unknown>|null,
 *   why?: string,
 * }} Property
 */

const byLabel = (/** @type {Group} */ a, /** @type {Group} */ b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
const none = (/** @type {string} */ label) => ({ key: NONE, label, none: true });
/** @param {string|null} v */
const k = (v) => (v === null || v === undefined || v === "" ? NONE : v);

/** @type {Record<string, Property>} */
const PROPERTIES = {
  state: {
    field: "state", label: "State", noneLabel: "No state", multi: false, settable: true, column: true,
    groups: ({ index }) => index.states.map((s) => ({ key: s.key, label: s.name, color: s.color, stateKind: s.kind, wipLimit: s.wipLimit })),
    keysOf: (item) => [item.state],
    patch: (item, _from, to, { index }) => {
      if (to === NONE || to === item.state) return null;
      return index.planning ? { state: to } : { status: to };
    },
  },
  status: {
    field: "status", label: "Status", noneLabel: "No status", multi: false, settable: true, column: true,
    groups: () => (/** @type {const} */ (["open", "active", "done"])).map((c) => ({ key: c, label: CATEGORY_LABELS[c], color: KIND_COLORS[c === "open" ? "unstarted" : c === "active" ? "started" : "completed"], stateKind: c === "open" ? "unstarted" : c === "active" ? "started" : "completed" })),
    keysOf: (item) => [item.category],
    patch: (item, _from, to) => (to === NONE || to === item.category ? null : { status: to }),
  },
  assignee: {
    field: "assignee", label: "Assignee", noneLabel: "Unassigned", multi: false, settable: true, column: true,
    groups: ({ index }, items) => {
      const seen = new Set(items.map((i) => i.assignee).filter(Boolean));
      for (const item of index.itemList) if (item.assignee) seen.add(item.assignee);
      return [...[...seen].map((id) => ({ key: /** @type {string} */ (id), label: personName(index, id), person: /** @type {string} */ (id) })).toSorted(byLabel), none("Unassigned")];
    },
    keysOf: (item) => [k(item.assignee)],
    patch: (item, _from, to) => (k(item.assignee) === to ? null : { assignee: to === NONE ? null : to }),
  },
  priority: {
    field: "priority", label: "Priority", noneLabel: "No priority", multi: false, settable: true, column: true,
    groups: () => PRIORITY_ORDER.map((p) => ({ key: String(p), label: PRIORITIES[p].name, priority: p, none: p === 0 })),
    keysOf: (item) => [String(item.priority)],
    patch: (item, _from, to) => (String(item.priority) === to || to === NONE ? null : { priority: Number(to) }),
  },
  project: {
    field: "project", label: "Project", noneLabel: "No project", multi: false, settable: true, column: true,
    groups: ({ index }, items) => {
      const used = new Set(items.map((i) => i.project));
      return [...index.projects.filter((p) => !p.archived || used.has(p.id)).map((p) => ({ key: p.id, label: p.name, color: p.color })), none("No project")];
    },
    keysOf: (item) => [k(item.project)],
    patch: (item, _from, to) => (k(item.project) === to ? null : { project: to === NONE ? null : refOut(to) }),
  },
  cycle: {
    field: "cycle", label: "Cycle", noneLabel: "No cycle", multi: false, settable: true, column: true,
    groups: ({ index, today }) => [...index.cycles.map((c) => ({
      key: c.id, label: c.start && c.end && c.start <= today && today <= c.end ? `${c.name} (current)` : c.name,
    })), none("No cycle")],
    keysOf: (item) => [k(item.cycle)],
    patch: (item, _from, to) => (k(item.cycle) === to ? null : { cycle: to === NONE ? null : refOut(to) }),
  },
  parent: {
    field: "parent", label: "Parent", noneLabel: "No parent", multi: false, settable: true, column: false,
    groups: ({ index }, items) => {
      const parents = [...new Set(items.map((i) => i.parent).filter((p) => p && index.items.has(p)))]
        .map((id) => /** @type {ItemView} */ (index.items.get(/** @type {string} */ (id))))
        .toSorted((a, b) => (a.number ?? 0) - (b.number ?? 0));
      return [...parents.map((p) => ({ key: p.id, label: `${p.key} ${p.title}` })), none("No parent")];
    },
    keysOf: (item, { index }) => [item.parent && index.items.has(item.parent) ? item.parent : NONE],
    patch: (item, _from, to) => {
      if (to === item.id) return null;
      return k(item.parent) === to ? null : { parent: to === NONE ? null : refOut(to) };
    },
  },
  label: {
    field: "label", label: "Label", noneLabel: "No labels", multi: true, settable: true, column: false,
    groups: ({ index }, items) => {
      const keys = new Set(index.labels.filter((l) => !l.archived).map((l) => l.key));
      for (const item of items) for (const l of item.labels) keys.add(l);
      return [...[...keys].map((key) => {
        const l = index.labelByKey.get(key);
        return { key, label: l?.name || key, color: l?.color ?? "#8a8f98" };
      }).toSorted(byLabel), none("No labels")];
    },
    keysOf: (item) => (item.labels.length ? item.labels : [NONE]),
    patch: (item, from, to) => {
      if (from === to) return null;
      const next = item.labels.filter((l) => l !== from);
      if (to !== NONE && !next.includes(to)) next.push(to);
      return next.length === item.labels.length && next.every((l, i) => l === item.labels[i]) ? null : { labels: next };
    },
  },
  due: {
    field: "due", label: "Due date", noneLabel: "No due date", multi: false, settable: false, column: false,
    why: "Due-date lanes are computed from the due date; change the due date instead.",
    groups: () => [
      { key: "overdue", label: "Overdue" }, { key: "today", label: "Today" }, { key: "week", label: "Next 7 days" },
      { key: "later", label: "Later" }, { key: "past", label: "Past, finished" }, none("No due date"),
    ],
    keysOf: (item, { today }) => [dueBucket(item, today)],
    patch: () => null,
  },
  created_by: {
    field: "created_by", label: "Creator", noneLabel: "Unknown creator", multi: false, settable: false, column: false,
    why: "The creator of an item cannot change.",
    groups: ({ index }, items) => [...[...new Set(items.map((i) => i.created_by).filter(Boolean))]
      .map((id) => ({ key: /** @type {string} */ (id), label: personName(index, id), person: /** @type {string} */ (id) })).toSorted(byLabel), none("Unknown creator")],
    keysOf: (item) => [k(item.created_by)],
    patch: () => null,
  },
};

/** @param {ItemView} item @param {string} today */
export function dueBucket(item, today) {
  if (!item.due) return NONE;
  if (item.due < today && item.category !== "done") return "overdue";
  if (item.due === today) return "today";
  if (item.due <= addDays(today, 7) && item.due > today) return "week";
  return item.due < today ? "past" : "later";
}

/** An extension field as a property. @param {string} name */
function extProperty(name) {
  /** @param {ItemView} item */
  const valueOf = (item) => {
    const v = item.ext?.[name];
    return v === null || v === undefined || v === "" ? NONE : typeof v === "object" ? JSON.stringify(v) : String(v);
  };
  /** @type {Property} */
  const prop = {
    field: `ext.${name}`, label: name, noneLabel: `No ${name}`, multi: false, settable: true, column: false,
    groups: (_ctx, items) => [...[...new Set(items.map(valueOf).filter((v) => v !== NONE))].map((v) => ({ key: v, label: v })).toSorted(byLabel), none(`No ${name}`)],
    keysOf: (item) => [valueOf(item)],
    patch: (item, _from, to) => {
      if (valueOf(item) === to) return null;
      const next = { ...item.ext };
      if (to === NONE) delete next[name]; else next[name] = to;
      return { extensions: next };
    },
  };
  return prop;
}

/** @param {string|null|undefined} field @returns {Property|null} */
export function property(field) {
  if (!field) return null;
  if (field.startsWith("ext.") && /^ext\.[A-Za-z0-9_]{1,64}$/.test(field)) return extProperty(field.slice(4));
  return PROPERTIES[field] ?? null;
}

/** Fields offered for columns and lanes in the display menu. @param {WorkIndex} index */
export function groupableFields(index) {
  const base = index.planning ? ["state", "status", "assignee", "priority", "project", "cycle", "parent", "label", "due", "created_by"] : ["state", "created_by"];
  const ext = new Set();
  for (const item of index.itemList) for (const key of Object.keys(item.ext ?? {})) if (/^[A-Za-z0-9_]{1,64}$/.test(key)) ext.add(`ext.${key}`);
  return [...base, ...[...ext].toSorted().slice(0, 12)].map((f) => ({ field: f, label: property(f)?.label ?? f, column: property(f)?.column ?? false }));
}
