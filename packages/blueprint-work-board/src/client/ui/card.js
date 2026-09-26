// @ts-check
// A board card: built once per item, updated in place only when its signature changes (item
// revision, pending status, selection, display options), so a re-render costs almost nothing.

import { h, shortDate, setChildren } from "./dom.js";
import { icon, priorityIcon, stateIcon } from "./icons.js";
import { PRIORITIES, hash, initials } from "../../shared/model/work.js";
import { personName, progressOf } from "../../shared/model/index.js";
import { plainText } from "./markdown.js";

/** Avatar backgrounds, each ≥ 4.5:1 against white initials. */
const AVATAR = ["#b4235a", "#8e3fbf", "#4f46e5", "#1d6fb8", "#0f766e", "#3f7d20", "#99560b", "#b3401e", "#5b6472", "#a21caf"];

/**
 * @typedef {import("../../shared/model/index.js").ItemView} ItemView
 * @typedef {import("../../shared/model/index.js").WorkIndex} WorkIndex
 * @typedef {import("../board/projection.js").Entry} Entry
 * @typedef {{
 *   index: WorkIndex, today: string, density: string, props: Set<string>, columnsBy: string,
 *   selected: Set<string>, canWrite: boolean, lanesBy: string|null, metaWidth?: number,
 * }} CardEnv
 */

/** @param {string|null} actor @param {WorkIndex} index @param {number} [size] */
export function avatar(actor, index, size = 20) {
  if (!actor) return h("span", { class: "avatar none", style: { width: `${size}px`, height: `${size}px` }, "aria-hidden": "true" }, icon("user", { size: Math.round(size * 0.7) }));
  const name = personName(index, actor);
  return h("span", { class: "avatar", "aria-hidden": "true", title: actorTitle(actor, name), style: { width: `${size}px`, height: `${size}px`, background: AVATAR[hash(actor) % AVATAR.length], fontSize: `${Math.round(size * 0.42)}px` } }, initials(name));
}

/** A tooltip naming a person and, when different, the account behind the name. @param {string} actor @param {string} name */
export function actorTitle(actor, name) {
  const account = actor.startsWith("cloudflare-os:") ? actor.slice("cloudflare-os:".length) : actor;
  return account === name ? name : `${name} (${account})`;
}

/**
 * Which chips fit in `budget` px, whole: an estimate from text length (system font at 11.5 px)
 * that errs on the wide side. The meta row also wraps, so a misestimate hides a chip whole
 * rather than clipping it; nothing is ever cut mid-word.
 * @param {string[]} texts @param {number} budget @param {number} [extra] fixed width per chip (icon, dot)
 */
export function fitChips(texts, budget, extra = 12) {
  const width = (/** @type {string} */ t) => Math.ceil(t.length * 6.2) + 14 + extra + 4;
  let used = 0;
  let n = 0;
  for (const t of texts) {
    const w = width(t);
    const moreAfter = n < texts.length - 1 ? 30 : 0;
    if (used + w + moreAfter > budget) break;
    used += w;
    n++;
  }
  return n;
}

/** @param {ItemView} item @param {WorkIndex} index */
export function stateOf(item, index) {
  return index.stateByKey.get(item.state) ?? index.states[0];
}

/** Position of a started state among started states (for the half-filled icon). @param {WorkIndex} index @param {string} key */
export function startedProgress(index, key) {
  const started = index.states.filter((s) => s.kind === "started");
  const i = started.findIndex((s) => s.key === key);
  return started.length <= 1 || i < 0 ? 0.5 : 0.25 + (0.5 * i) / (started.length - 1);
}

/** @param {ItemView} item @param {WorkIndex} index @param {{ size?: number }} [opts] */
export function itemStateIcon(item, index, opts = {}) {
  const s = stateOf(item, index);
  return stateIcon(s?.kind ?? "unstarted", s?.color ?? "#8a8f98", { progress: startedProgress(index, s?.key ?? ""), size: opts.size });
}

/**
 * The accessible name of a card.
 * @param {ItemView} item @param {CardEnv} env @param {{ pending?: string, mirror?: boolean, selected?: boolean }} [extra]
 */
export function cardLabel(item, env, extra = {}) {
  const { index, today } = env;
  const parts = [`${item.key}: ${item.title || "Untitled"}`];
  parts.push(`State ${stateOf(item, index)?.name ?? item.state}`);
  if (index.planning) {
    parts.push(item.assignee ? `Assigned to ${personName(index, item.assignee)}` : "Unassigned");
    if (item.priority) parts.push(`Priority ${PRIORITIES[item.priority].name}`);
    if (item.due) parts.push(`Due ${shortDate(item.due, today)}${item.due < today && item.category !== "done" ? ", overdue" : ""}`);
    if (item.labels.length) parts.push(`Labels ${item.labels.map((l) => index.labelByKey.get(l)?.name ?? l).join(", ")}`);
    if (item.estimate !== null) parts.push(`Estimate ${item.estimate}`);
    const blockedBy = index.blockedBy.get(item.id)?.length ?? 0;
    if (blockedBy) parts.push(`Blocked by ${blockedBy} ${blockedBy === 1 ? "item" : "items"}`);
  }
  if (extra.mirror) parts.push("Also shown in another lane");
  if (extra.pending) parts.push(extra.pending);
  if (extra.selected) parts.push("Selected");
  return parts.join(". ");
}

/** @param {boolean} ghost */
export function createCard(ghost = false) {
  const el = h("article", { class: ghost ? "card ghost" : "card", tabindex: ghost ? null : "-1" });
  return el;
}

/**
 * @param {HTMLElement} el
 * @param {Entry} entry
 * @param {CardEnv} env
 * @param {{ focused: boolean }} state
 */
export function updateCard(el, entry, env, state) {
  const item = entry.item;
  const ghost = entry.kind === "ghost";
  const pending = entry.kind === "card" ? entry.pending : entry.change;
  const selected = !ghost && env.selected.has(item.id);
  const sig = [
    item.id, item.revision, item.key, pending?.status ?? "", pending?.id ?? "", selected ? 1 : 0, env.density, [...env.props].join(","),
    env.columnsBy, env.today, env.canWrite ? 1 : 0, env.metaWidth ?? 0, entry.kind === "card" && entry.mirror ? 1 : 0, env.index.keyPrefix,
    env.index.blockedBy.get(item.id)?.length ?? 0, env.index.children.get(item.id)?.length ?? 0, env.index.comments.get(item.id)?.length ?? 0,
    item.assignee ? personName(env.index, item.assignee) : "",
  ].join("|");
  if (!ghost) el.tabIndex = state.focused ? 0 : -1;
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  el.dataset.id = item.id;
  el.classList.toggle("selected", selected);
  el.classList.toggle("pending", Boolean(pending && !ghost));
  el.classList.toggle("mirror", entry.kind === "card" && entry.mirror);
  el.classList.toggle("compact", env.density === "compact");
  el.classList.toggle("done", item.category === "done");
  if (ghost) el.dataset.status = pending?.status ?? "";

  const { index, today, props } = env;
  const pendingText = pending ? pendingLabel(pending, ghost) : "";
  if (ghost) {
    el.setAttribute("aria-label", `${entry.kind === "ghost" && entry.create ? "New item" : item.key}: ${item.title}. ${pendingText}`);
  } else {
    el.setAttribute("aria-label", cardLabel(item, env, { pending: pendingText, mirror: entry.kind === "card" && entry.mirror, selected }));
  }
  el.setAttribute("aria-roledescription", ghost ? "pending card" : "card");

  const top = h("div", { class: "card-top" },
    !ghost && env.canWrite ? h("label", { class: "check-hit card-check", "data-action": "select" }, h("input", { type: "checkbox", tabindex: "-1", checked: selected, "aria-label": `Select ${item.key}` })) : null,
    props.has("key") ? h("span", { class: "card-key" }, entry.kind === "ghost" && entry.create ? "New" : item.key) : null,
    env.columnsBy !== "state" ? h("span", { class: "card-state", title: stateOf(item, index)?.name }, itemStateIcon(item, index, { size: 12 })) : null,
    h("span", { class: "grow" }),
    pending ? h("span", { class: `pending-chip ${pending.status}`, "aria-hidden": "true" }, shortPending(pending, ghost)) : null,
    props.has("assignee") && index.planning ? avatar(item.assignee, index, env.density === "compact" ? 18 : 20) : null,
    !ghost && env.canWrite ? h("button", { type: "button", class: "card-menu", tabindex: "-1", "aria-label": `Move or edit ${item.key}`, title: "Move to… (M)", "data-action": "menu", "aria-haspopup": "dialog" }, icon("more")) : null,
  );

  const title = h("div", { class: "card-title" }, item.title || "Untitled");
  const meta = h("div", { class: "card-meta" });
  if (index.planning) {
    // Priority is an icon only on cards (the card's accessible name says it); only Urgent is coloured.
    if (props.has("priority") && item.priority) meta.append(h("span", { class: `chip prio p${item.priority}`, title: `Priority: ${PRIORITIES[item.priority].name}` }, priorityIcon(item.priority)));
    const blocked = index.blockedBy.get(item.id)?.length ?? 0;
    if (props.has("blocked") && blocked) meta.append(h("span", { class: "chip blocked", title: `Blocked by ${blocked}` }, icon("blocked", { size: 12 }), h("span", { class: "chip-text" }, "Blocked")));
    if (props.has("due") && item.due) {
      const overdue = item.due < today && item.category !== "done";
      meta.append(h("span", { class: `chip due${overdue ? " overdue" : ""}`, title: overdue ? "Overdue" : "Due date" }, icon("calendar", { size: 12 }), shortDate(item.due, today)));
    }
    if (props.has("estimate") && item.estimate !== null) meta.append(h("span", { class: "chip est", title: "Estimate" }, icon("estimate", { size: 12 }), String(item.estimate)));
    const progress = progressOf(index, item.id);
    if (props.has("progress") && progress) meta.append(h("span", { class: `chip progress${progress.done === progress.total ? " complete" : ""}`, title: "Sub-issues done" }, icon("subtask", { size: 12 }), `${progress.done}/${progress.total}`));
    const comments = index.comments.get(item.id)?.length ?? 0;
    if (props.has("comments") && comments) meta.append(h("span", { class: "chip comments", title: `${comments} comments` }, icon("comment", { size: 12 }), String(comments)));
    if (props.has("labels") && item.labels.length) {
      const names = item.labels.map((l) => index.labelByKey.get(l)?.name ?? l);
      // Room left after the other chips (each estimated like a label chip).
      const fixed = [...meta.children].reduce((w, c) => w + (c.classList.contains("prio") ? 22 : Math.ceil((c.textContent ?? "").length * 6.2) + 34), 0);
      const n = fitChips(names, (env.metaWidth ?? 240) - fixed);
      names.slice(0, n).forEach((name, i) => {
        const label = index.labelByKey.get(item.labels[i]);
        meta.append(h("span", { class: "chip label" }, h("span", { class: "dot", style: { background: label?.color ?? "#8a8f98" } }), name));
      });
      if (n < names.length) {
        const rest = names.slice(n).join(", ");
        meta.append(h("span", { class: "chip more", title: rest, "aria-label": `${names.length - n} more labels: ${rest}` }, `+${names.length - n}`));
      }
    }
  } else if (item.description) {
    meta.append(h("span", { class: "snippet" }, plainText(item.description).slice(0, 140)));
  }
  setChildren(el, top, title, meta);
}

/** @param {import("../store/store.js").Change} change @param {boolean} ghost */
function shortPending(change, ghost) {
  switch (change.status) {
    case "saving": return "Sending…";
    case "pending": return ghost ? "Awaiting approval" : "Pending";
    case "applied": return "Saved";
    default: return "";
  }
}

/** @param {import("../store/store.js").Change} change @param {boolean} ghost */
export function pendingLabel(change, ghost) {
  const where = ghost ? "Will appear here once saved. " : "";
  switch (change.status) {
    case "saving": return `${where}Sending to the Records service.`;
    case "pending": return `${where}Awaiting approval in the Workshop${change.actionId ? ` (action ${change.actionId})` : ""}: ${change.label}.`;
    case "applied": return "Saved.";
    default: return "";
  }
}
