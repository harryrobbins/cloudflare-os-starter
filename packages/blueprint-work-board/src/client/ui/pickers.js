// @ts-check
// Property pickers: one place that knows how to offer and apply each property, used by the
// single-key shortcuts, the detail panel, the bulk bar, the Move menu and quick create.

import { h } from "./dom.js";
import { icon, priorityIcon, stateIcon } from "./icons.js";
import { avatar } from "./card.js";
import { openPicker } from "./picker.js";
import { PRIORITIES, PRIORITY_ORDER, addDays, isIsoDate } from "../../shared/model/work.js";
import { personName, projectItem } from "../../shared/model/index.js";
import { NONE, property } from "../../shared/model/properties.js";

/**
 * @typedef {import("../../shared/model/index.js").ItemView} ItemView
 * @typedef {import("../../shared/model/index.js").WorkIndex} WorkIndex
 * @typedef {import("./picker.js").PickerOption} PickerOption
 * @typedef {{
 *   layers: ReturnType<typeof import("./overlay.js").createLayers>, index: () => WorkIndex, today: () => string,
 *   me: string|null, apply: (items: ItemView[], patchFor: (item: ItemView) => Record<string, unknown>|null, label: string) => void,
 *   move: (item: ItemView, target: { col?: string, lane?: string, position?: "top"|"bottom" }) => void,
 *   view: () => { columnsBy: string, swimlanesBy: string|null, manualOrder: boolean },
 *   laneOf: (item: ItemView) => string|null,
 *   ctx: () => { index: WorkIndex, today: string, viewer: string|null },
 * }} PickerDeps
 */

/** @param {WorkIndex} index @param {string} today */
export function datePresets(index, today) {
  void index;
  const d = new Date(`${today}T00:00:00`);
  const dow = d.getDay();
  const friday = addDays(today, (5 - dow + 7) % 7 || 7);
  const monday = addDays(today, ((1 - dow + 7) % 7) || 7);
  const endOfMonth = (() => { const x = new Date(d.getFullYear(), d.getMonth() + 1, 0); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; })();
  return [["Today", today], ["Tomorrow", addDays(today, 1)], ["This Friday", friday], ["Next Monday", monday], ["In one week", addDays(today, 7)], ["In two weeks", addDays(today, 14)], ["End of the month", endOfMonth]];
}

/** Parses typed dates: 2026-10-03, 3d, 2w, "fri" etc. @param {string} text @param {string} today */
export function parseDateInput(text, today) {
  const t = text.trim().toLowerCase();
  if (isIsoDate(t)) return t;
  const rel = /^\+?(\d{1,3})\s*(d|w|m)$/.exec(t);
  if (rel) return addDays(today, Number(rel[1]) * (rel[2] === "w" ? 7 : rel[2] === "m" ? 30 : 1));
  if (t === "today") return today;
  if (t === "tomorrow") return addDays(today, 1);
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const i = days.findIndex((d) => t.startsWith(d));
  if (i >= 0) { const dow = new Date(`${today}T00:00:00`).getDay(); return addDays(today, ((i - dow + 7) % 7) || 7); }
  return null;
}

/** The value all items share, or undefined. @param {ItemView[]} items @param {(i: ItemView) => unknown} get */
const commonValue = (items, get) => items.length > 0 && items.every((i) => get(i) === get(items[0])) ? get(items[0]) : undefined;
/** "WRK-3" or "4 items". @param {ItemView[]} items */
const targetLabel = (items) => (items.length === 1 ? items[0].key : `${items.length} items`);

/** @param {PickerDeps} deps */
export function createPickers(deps) {

  /**
   * Opens the picker for a property. With `onValues`, the chosen patch is handed back instead of
   * being sent (quick create uses this).
   * @param {string} prop @param {ItemView[]} items @param {HTMLElement|{ x: number, y: number }} anchor
   * @param {((patch: Record<string, unknown>) => void)|null} [onValues]
   */
  function pick(prop, items, anchor, onValues = null) {
    const index = deps.index();
    const today = deps.today();
    const target = targetLabel(items);
    const returnTo = "getBoundingClientRect" in anchor ? anchor : null;
    /** @param {(item: ItemView) => Record<string, unknown>|null} patchFor @param {string} label */
    const send = (patchFor, label) => {
      if (onValues) { const p = patchFor(items[0] ?? /** @type {any} */ ({ labels: [] })); if (p) onValues(p); return; }
      deps.apply(items, patchFor, label);
    };
    /** @param {string} title @param {PickerOption[]} options @param {(values: string[]) => void} onPick @param {Partial<import("./picker.js").PickerOptions>} [extra] */
    const open = (title, options, onPick, extra = {}) => openPicker({ layers: deps.layers, anchor, title, options, onPick, returnTo, ...extra });

    switch (prop) {
      case "state": {
        const current = commonValue(items, (i) => i.state);
        return open(`State for ${target}`, index.states.map((s, n) => ({
          value: s.key, label: s.name, icon: () => stateIcon(s.kind, s.color), selected: s.key === current, hint: n < 9 ? String(n + 1) : undefined,
        })), ([key]) => {
          const s = index.stateByKey.get(key);
          send(() => (index.planning ? { state: key } : { status: key }), `Move ${target} to ${s?.name ?? key}`);
        });
      }
      case "priority": {
        const current = commonValue(items, (i) => i.priority);
        return open(`Priority for ${target}`, PRIORITY_ORDER.map((p, n) => ({
          value: String(p), label: PRIORITIES[p].name, icon: () => priorityIcon(p), selected: p === current, hint: String(n === 4 ? 0 : n + 1),
        })), ([v]) => send(() => ({ priority: Number(v) }), `Set priority of ${target} to ${PRIORITIES[Number(v)].name}`));
      }
      case "assignee": {
        const current = commonValue(items, (i) => i.assignee ?? "");
        const people = [...index.people.values()].filter((p) => p.id.startsWith("cloudflare-os:") || p.id === deps.me).toSorted((a, b) => a.name.localeCompare(b.name));
        /** @type {PickerOption[]} */
        const options = [];
        if (deps.me) options.push({ value: deps.me, label: `${personName(index, deps.me)} (you)`, icon: () => avatar(deps.me, index, 18), selected: current === deps.me, keywords: "me myself" });
        for (const p of people) if (p.id !== deps.me) options.push({ value: p.id, label: p.name, icon: () => avatar(p.id, index, 18), selected: current === p.id, detail: p.id.replace(/^cloudflare-os:/, "") === p.name ? "" : p.id.replace(/^cloudflare-os:/, "") });
        options.push({ value: "", label: "Unassigned", icon: () => avatar(null, index, 18), selected: current === "" });
        return open(`Assign ${target}`, options, ([v]) => send(() => ({ assignee: v || null }), v ? `Assign ${target} to ${personName(index, v)}` : `Unassign ${target}`), { placeholder: "Assign to…" });
      }
      case "labels": {
        const all = new Map(index.labels.filter((l) => !l.archived).map((l) => [l.key, l]));
        const used = new Set(index.itemList.flatMap((i) => i.labels));
        for (const u of used) if (!all.has(u)) all.set(u, /** @type {any} */ ({ key: u, name: u, color: "#8a8f98" }));
        const initial = new Set([...all.keys()].filter((k) => items.length && items.every((i) => i.labels.includes(k))));
        const options = [...all.values()].toSorted((a, b) => a.name.localeCompare(b.name)).map((l) => ({
          value: l.key, label: l.name, icon: () => h("span", { class: "dot", style: { background: l.color } }), selected: initial.has(l.key),
        }));
        return open(`Labels for ${target}`, options, (values) => {
          const chosen = new Set(values);
          const added = values.filter((v) => !initial.has(v));
          const removed = [...initial].filter((v) => !chosen.has(v));
          if (!added.length && !removed.length) return;
          const text = [added.length && `add ${added.join(", ")}`, removed.length && `remove ${removed.join(", ")}`].filter(Boolean).join(" and ");
          send((item) => {
            const next = item.labels.filter((l) => !removed.includes(l));
            for (const a of added) if (!next.includes(a)) next.push(a);
            return { labels: next };
          }, `Labels on ${target}: ${text}`);
        }, {
          multi: true, placeholder: "Search or create a label…",
          create: (text) => (text.length <= 60 ? { value: text, label: `Create label “${text}”`, icon: () => icon("plus", { size: 14 }) } : null),
        });
      }
      case "estimate": {
        const current = commonValue(items, (i) => i.estimate);
        const values = [0, 1, 2, 3, 5, 8, 13, 21];
        return open(`Estimate for ${target}`, [
          ...values.map((v) => ({ value: String(v), label: `${v} ${v === 1 ? "point" : "points"}`, selected: v === current, icon: () => icon("estimate", { size: 14 }) })),
          { value: "", label: "No estimate", selected: current === null },
        ], ([v]) => send(() => ({ estimate: v === "" ? null : Number(v) }), v === "" ? `Remove the estimate of ${target}` : `Estimate ${target} at ${v}`), {
          placeholder: "Points, e.g. 4",
          custom: (text) => { const n = Number(text); return Number.isFinite(n) && n >= 0 && n <= 1000 && text.trim() !== "" ? { value: String(n), label: `${n} points` } : null; },
        });
      }
      case "due": case "start": {
        const field = prop === "due" ? "due_date" : "start_date";
        const noun = prop === "due" ? "due date" : "start date";
        const current = commonValue(items, (i) => (prop === "due" ? i.due : i.start));
        return open(`${noun[0].toUpperCase()}${noun.slice(1)} for ${target}`, [
          ...datePresets(index, today).map(([label, day]) => ({ value: day, label, detail: new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }), selected: day === current, icon: () => icon("calendar", { size: 14 }) })),
          { value: "", label: `No ${noun}`, selected: current === null },
        ], ([v]) => send(() => ({ [field]: v || null }), v ? `Set the ${noun} of ${target} to ${v}` : `Remove the ${noun} of ${target}`), {
          placeholder: "e.g. 2026-10-30, 3d, fri",
          custom: (text) => { const d = parseDateInput(text, today); return d ? { value: d, label: new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }), icon: () => icon("calendar", { size: 14 }) } : null; },
        });
      }
      case "project": {
        const current = commonValue(items, (i) => i.project ?? "");
        return open(`Project for ${target}`, [
          ...index.projects.filter((p) => !p.archived).map((p) => ({ value: p.id, label: p.name, detail: p.state, icon: () => h("span", { class: "dot", style: { background: p.color } }), selected: p.id === current })),
          { value: "", label: "No project", selected: current === "" },
        ], ([v]) => send(() => ({ project: v || null }), v ? `Move ${target} to ${index.projectById.get(v)?.name}` : `Remove ${target} from its project`));
      }
      case "cycle": {
        const current = commonValue(items, (i) => i.cycle ?? "");
        return open(`Cycle for ${target}`, [
          ...index.cycles.filter((c) => !c.end || c.end >= addDays(today, -28)).map((c) => ({
            value: c.id, label: c.name, selected: c.id === current,
            detail: c.start && c.end ? `${c.start <= today && today <= c.end ? "Current · " : c.start > today ? "Upcoming · " : "Past · "}${c.start} → ${c.end}` : "",
            icon: () => icon("cycle", { size: 14 }),
          })),
          { value: "", label: "No cycle", selected: current === "" },
        ], ([v]) => send(() => ({ cycle: v || null }), v ? `Add ${target} to ${index.cycleById.get(v)?.name}` : `Remove ${target} from its cycle`));
      }
      case "parent": {
        const ids = new Set(items.map((i) => i.id));
        // Never offer an item's own descendants (that would be a loop of parents).
        const blocked = new Set(ids);
        let grew = true;
        while (grew) { grew = false; for (const it of index.itemList) if (it.parent && blocked.has(it.parent) && !blocked.has(it.id)) { blocked.add(it.id); grew = true; } }
        const current = commonValue(items, (i) => i.parent ?? "");
        const options = index.itemList.filter((i) => !blocked.has(i.id) && !i.archived).toSorted((a, b) => (b.number ?? 0) - (a.number ?? 0)).slice(0, 400).map((i) => ({
          value: i.id, label: `${i.key} ${i.title}`, selected: i.id === current, keywords: i.key,
        }));
        return open(`Parent of ${target}`, [{ value: "", label: "No parent", selected: current === "" }, ...options],
          ([v]) => send(() => ({ parent: v || null }), v ? `Move ${target} under ${index.items.get(v)?.key}` : `Remove the parent of ${target}`), { placeholder: "Search items by key or title…" });
      }
      case "move": {
        const item = items[0];
        if (!item) return null;
        const view = deps.view();
        const colProp = property(view.columnsBy);
        const laneProp = view.swimlanesBy ? property(view.swimlanesBy) : null;
        const ctx = deps.ctx();
        /** @type {PickerOption[]} */
        const options = [];
        if (colProp) {
          const current = colProp.keysOf(item, ctx)[0];
          for (const g of colProp.groups(ctx, index.itemList)) {
            options.push({ value: `col:${g.key}`, label: g.label, section: `Move to ${colProp.label.toLowerCase()}`, selected: g.key === current, disabled: !colProp.settable,
              icon: () => (g.stateKind ? stateIcon(g.stateKind, g.color ?? "#888") : g.priority !== undefined ? priorityIcon(g.priority) : g.person ? avatar(g.person, index, 18) : null) });
          }
        }
        if (laneProp && laneProp.settable) {
          const laneNow = deps.laneOf(item);
          for (const g of laneProp.groups(ctx, index.itemList)) {
            options.push({ value: `lane:${g.key}`, label: g.label, section: `Move to lane (${laneProp.label.toLowerCase()})`, selected: g.key === laneNow,
              icon: () => (g.person ? avatar(g.person, index, 18) : g.color ? h("span", { class: "dot", style: { background: g.color } }) : g.priority !== undefined ? priorityIcon(g.priority) : null) });
          }
        }
        if (view.manualOrder) {
          options.push({ value: "pos:top", label: "Top of the column", section: "Position" }, { value: "pos:bottom", label: "Bottom of the column", section: "Position" });
        }
        return open(`Move ${item.key}`, options, ([v]) => {
          const [kind, ...rest] = v.split(":");
          const key = rest.join(":");
          if (kind === "col") deps.move(item, { col: key });
          else if (kind === "lane") deps.move(item, { lane: key });
          else deps.move(item, { position: /** @type {"top"|"bottom"} */ (key) });
        }, { placeholder: "Move to…", footer: "↑↓ move · Enter moves · Esc closes" });
      }
      default:
        return null;
    }
  }

  /**
   * A short label and icon for a property of a draft (quick create's property buttons).
   * @param {string} prop @param {Record<string, unknown>} fields
   */
  function summarize(prop, fields) {
    const index = deps.index();
    const item = projectItem(index, null, fields);
    switch (prop) {
      case "state": { const s = index.stateByKey.get(item.state); return { label: s?.name ?? "State", icon: s ? stateIcon(s.kind, s.color) : null }; }
      case "priority": return { label: item.priority ? PRIORITIES[item.priority].name : "Priority", icon: priorityIcon(item.priority) };
      case "assignee": return { label: item.assignee ? personName(index, item.assignee) : "Assignee", icon: avatar(item.assignee, index, 16) };
      case "labels": return { label: item.labels.length ? item.labels.map((l) => index.labelByKey.get(l)?.name ?? l).join(", ") : "Labels", icon: icon("tag", { size: 14 }) };
      case "estimate": return { label: item.estimate === null ? "Estimate" : `${item.estimate} pts`, icon: icon("estimate", { size: 14 }) };
      case "due": return { label: item.due ?? "Due date", icon: icon("calendar", { size: 14 }) };
      case "project": return { label: item.project ? index.projectById.get(item.project)?.name ?? "Project" : "Project", icon: icon("project", { size: 14 }) };
      case "cycle": return { label: item.cycle ? index.cycleById.get(item.cycle)?.name ?? "Cycle" : "Cycle", icon: icon("cycle", { size: 14 }) };
      default: return { label: prop, icon: null };
    }
  }

  /** Quick create: pick for a draft. @param {string} prop @param {Record<string, unknown>} fields @param {HTMLElement} anchor @param {(patch: Record<string, unknown>) => void} done */
  function chooseForDraft(prop, fields, anchor, done) {
    const draft = projectItem(deps.index(), null, fields, "draft");
    return pick(prop, [draft], anchor, done);
  }

  return { pick, summarize, chooseForDraft, NONE };
}
