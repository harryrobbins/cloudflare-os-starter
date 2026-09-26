// @ts-check
// The detail panel ("peek"). Every property edit is one command; the panel shows the committed
// item with pending changes explained inline. Text being edited (title, description, a comment)
// is never replaced by a re-render.

import { h, reconcile, relativeTime, shortDate, focus as focusEl, setChildren } from "./dom.js";
import { icon, priorityIcon } from "./icons.js";
import { avatar, itemStateIcon, stateOf, pendingLabel } from "./card.js";
import { renderMarkdown } from "./markdown.js";
import { PRIORITIES, LIMITS } from "../../shared/model/work.js";
import { personName, progressOf, relationsFor } from "../../shared/model/index.js";

/**
 * @typedef {import("../../shared/model/index.js").ItemView} ItemView
 * @typedef {import("../../shared/model/index.js").WorkIndex} WorkIndex
 * @typedef {import("../../shared/replica.js").HistoryEntry} HistoryEntry
 * @typedef {{
 *   index: () => WorkIndex, today: () => string, now: () => number, canWrite: () => boolean, me: string|null,
 *   history: (id: string) => HistoryEntry[], historyComplete: () => boolean,
 *   pendingFor: (id: string) => import("../store/store.js").Change|null,
 *   changesFor: (id: string) => import("../store/store.js").Change[],
 *   pick: (prop: string, items: ItemView[], anchor: HTMLElement) => void,
 *   update: (item: ItemView, patch: Record<string, unknown>, label: string) => { ok: boolean, error?: string },
 *   createSub: (parent: ItemView, title: string) => { ok: boolean, error?: string },
 *   relate: (item: ItemView, anchor: HTMLElement) => void,
 *   unrelate: (rel: import("../../shared/model/index.js").RelationView, item: ItemView) => void,
 *   comment: (item: ItemView, body: string) => { ok: boolean, error?: string },
 *   editComment: (c: import("../../shared/model/index.js").CommentView, body: string) => { ok: boolean, error?: string },
 *   open: (item: ItemView) => void, close: () => void, retry: (c: import("../store/store.js").Change) => void,
 *   announce: (text: string) => void,
 * }} DetailController
 */

/** @param {{ doc: Document, controller: DetailController }} opts */
export function createDetail({ doc, controller: c }) {
  const el = h("aside", { class: "detail", "aria-labelledby": "wb-detail-heading", hidden: true });
  /** @type {string|null} */ let itemId = null;
  let editingDescription = false;
  /** @type {string|null} */ let descriptionDraft = null;
  /** @type {string|null} */ let editingComment = null;
  const titleInput = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "title-edit", rows: "1", maxlength: String(LIMITS.title), "aria-label": "Title", spellcheck: "true" }));
  const composer = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "composer", rows: "3", placeholder: "Leave a comment… (Markdown, Ctrl+Enter to send)", "aria-label": "New comment", maxlength: String(LIMITS.comment) }));
  const composerError = h("p", { class: "field-error", role: "alert" });
  const titleError = h("p", { class: "field-error", role: "alert" });
  let titleDirty = false;

  titleInput.addEventListener("input", () => { titleDirty = true; autosize(titleInput); });
  titleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveTitle(); titleInput.blur(); }
    else if (e.key === "Escape") { const item = current(); if (item) titleInput.value = item.title; titleDirty = false; e.stopPropagation(); titleInput.blur(); }
  });
  titleInput.addEventListener("blur", () => saveTitle());
  composer.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendComment(); }
  });

  function current() { return itemId ? c.index().items.get(itemId) ?? null : null; }

  function saveTitle() {
    const item = current();
    if (!item || !titleDirty) return;
    titleDirty = false;
    const value = titleInput.value.trim();
    if (value === item.title) return;
    const r = c.update(item, { title: value }, `Rename ${item.key}`);
    titleError.textContent = r.ok ? "" : r.error ?? "";
    if (!r.ok) titleInput.value = item.title;
  }

  function sendComment() {
    const item = current();
    if (!item) return;
    const r = c.comment(item, composer.value);
    composerError.textContent = r.ok ? "" : r.error ?? "";
    if (r.ok) { composer.value = ""; c.announce("Comment sent."); }
  }

  /** @param {string|null} id @param {{ focus?: boolean }} [opts] */
  function show(id, opts = {}) {
    if (id !== itemId) { editingDescription = false; descriptionDraft = null; editingComment = null; titleDirty = false; titleError.textContent = ""; composerError.textContent = ""; }
    itemId = id;
    el.hidden = !id;
    render();
    if (id && opts.focus) focusEl(/** @type {HTMLElement|null} */ (el.querySelector(".detail-head .detail-key")), { scroll: false });
  }

  function render() {
    const item = current();
    if (!item) { setChildren(el, ); return; }
    const index = c.index();
    const today = c.today();
    const canWrite = c.canWrite();
    const parent = item.parent ? index.items.get(item.parent) ?? null : null;
    if (doc.activeElement !== titleInput && !titleDirty) titleInput.value = item.title;
    titleInput.readOnly = !canWrite;

    const head = h("div", { class: "detail-head" },
      parent ? h("button", { type: "button", class: "crumb", onclick: () => c.open(parent), title: parent.title }, parent.key, h("span", { "aria-hidden": "true" }, " ›")) : null,
      h("span", { class: "detail-key", tabindex: "-1" }, item.key),
      h("span", { class: "grow" }),
      h("button", { type: "button", class: "icon-btn", "aria-label": "Close details", title: "Close (Esc)", onclick: () => c.close() }, h("span", { class: "x", "aria-hidden": "true" }, "×")));

    const pending = c.changesFor(item.id).filter((x) => x.status !== "applied" || !x.settledAt);
    const notices = pending.length ? h("div", { class: "notices" }, pending.map((ch) => h("div", { class: `notice ${ch.status}`, role: ch.status === "conflict" || ch.status === "rejected" ? "alert" : null },
      h("span", { class: "notice-text" }, ch.status === "conflict" || ch.status === "rejected" ? `Not saved: ${ch.label}. ${ch.message}` : pendingLabel(ch, false)),
      ch.status === "conflict" || ch.status === "rejected" ? h("button", { type: "button", class: "btn sm", onclick: () => c.retry(ch) }, "Retry") : null))) : null;

    const title = canWrite
      ? h("div", { class: "title-wrap" }, h("h2", { id: "wb-detail-heading", class: "sr-only" }, `${item.key}: ${item.title}`), titleInput, titleError)
      : h("h2", { id: "wb-detail-heading", class: "detail-title" }, item.title || "Untitled");

    const props = index.planning ? propGrid(item, index, today, canWrite) : h("dl", { class: "props" },
      h("dt", null, "Status"), h("dd", null, propButton("state", item, canWrite, [itemStateIcon(item, index), stateOf(item, index)?.name ?? item.state])));

    const desc = descriptionSection(item, canWrite);
    const subs = index.planning ? subIssues(item, index, canWrite) : null;
    const rels = index.planning ? relations(item, index, canWrite) : null;
    const activity = activitySection(item, index, canWrite);

    const scroll = h("div", { class: "detail-scroll" }, notices, title, props, desc, subs, rels, activity,
      h("p", { class: "attribution" }, `Created by ${personName(index, item.created_by)}${item.created ? ` · ${relativeTime(item.created, c.now())}` : ""} · Last changed by ${personName(index, item.updated_by)}${item.updated ? ` · ${relativeTime(item.updated, c.now())}` : ""} · Revision ${item.revision}`));
    const prevScroll = /** @type {HTMLElement|null} */ (el.querySelector(".detail-scroll"))?.scrollTop ?? 0;
    const active = doc.activeElement;
    const keep = active && el.contains(active) && active !== titleInput && active !== composer ? describeFocus(/** @type {HTMLElement} */ (active)) : null;
    setChildren(el, head, scroll);
    scroll.scrollTop = prevScroll;
    autosize(titleInput);
    if (keep) restoreFocus(keep);
  }

  /** @param {HTMLElement} node */
  function describeFocus(node) { return node.dataset.focusKey ?? null; }
  /** @param {string} key */
  function restoreFocus(key) { /** @type {HTMLElement|null} */ (el.querySelector(`[data-focus-key="${key}"]`))?.focus(); }

  /**
   * @param {string} prop @param {ItemView} item @param {boolean} canWrite @param {any[]} content
   */
  function propButton(prop, item, canWrite, content) {
    if (!canWrite) return h("span", { class: "prop-value" }, content);
    return h("button", { type: "button", class: "prop-value", "data-focus-key": `prop-${prop}`, "aria-haspopup": "dialog", onclick: (/** @type {Event} */ e) => c.pick(prop, [item], /** @type {HTMLElement} */ (e.currentTarget)) }, content);
  }

  /** @param {ItemView} item @param {WorkIndex} index @param {string} today @param {boolean} canWrite */
  function propGrid(item, index, today, canWrite) {
    const muted = (/** @type {string} */ t) => h("span", { class: "muted" }, t);
    const project = item.project ? index.projectById.get(item.project) : null;
    const cycle = item.cycle ? index.cycleById.get(item.cycle) : null;
    const parent = item.parent ? index.items.get(item.parent) : null;
    const rows = [
      ["state", "State", [itemStateIcon(item, index), stateOf(item, index)?.name ?? item.state]],
      ["priority", "Priority", [priorityIcon(item.priority), PRIORITIES[item.priority].name]],
      ["assignee", "Assignee", item.assignee ? [avatar(item.assignee, index, 18), personName(index, item.assignee)] : [avatar(null, index, 18), muted("Unassigned")]],
      ["labels", "Labels", item.labels.length ? item.labels.map((l) => h("span", { class: "chip label" }, h("span", { class: "dot", style: { background: index.labelByKey.get(l)?.color ?? "#8a8f98" } }), index.labelByKey.get(l)?.name ?? l)) : muted("Add labels")],
      ["estimate", "Estimate", item.estimate === null ? muted("No estimate") : `${item.estimate} ${item.estimate === 1 ? "point" : "points"}`],
      ["due", "Due date", item.due ? h("span", { class: item.due < today && item.category !== "done" ? "overdue" : "" }, shortDate(item.due, today), item.due < today && item.category !== "done" ? " · overdue" : "") : muted("No due date")],
      ["start", "Start date", item.start ? shortDate(item.start, today) : muted("No start date")],
      ["project", "Project", project ? [h("span", { class: "dot", style: { background: project.color } }), project.name] : muted("No project")],
      ["cycle", "Cycle", cycle ? cycle.name : muted("No cycle")],
      ["parent", "Parent", parent ? `${parent.key} ${parent.title}` : muted("No parent")],
    ];
    return h("dl", { class: "props" }, rows.flatMap(([prop, label, content]) => [
      h("dt", null, /** @type {string} */ (label)),
      h("dd", null, propButton(/** @type {string} */ (prop), item, canWrite, /** @type {any[]} */ ([content].flat()))),
    ]));
  }

  /** @param {ItemView} item @param {boolean} canWrite */
  function descriptionSection(item, canWrite) {
    const section = h("section", { class: "detail-section", "aria-labelledby": "wb-desc-h" });
    const heading = h("div", { class: "section-head" }, h("h3", { id: "wb-desc-h" }, "Description"), h("span", { class: "grow" }),
      canWrite && !editingDescription ? h("button", { type: "button", class: "btn ghost sm", "data-focus-key": "desc-edit", onclick: () => { editingDescription = true; descriptionDraft = item.description; render(); /** @type {HTMLElement|null} */ (el.querySelector(".desc-edit"))?.focus(); } }, "Edit") : null);
    section.append(heading);
    if (editingDescription) {
      const area = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "desc-edit", rows: "8", "aria-label": "Description (Markdown)", maxlength: String(LIMITS.description) }));
      area.value = descriptionDraft ?? item.description;
      area.addEventListener("input", () => { descriptionDraft = area.value; });
      const error = h("p", { class: "field-error", role: "alert" });
      const save = () => {
        const r = c.update(item, { description: area.value }, `Edit the description of ${item.key}`);
        if (!r.ok) { error.textContent = r.error ?? ""; return; }
        editingDescription = false; descriptionDraft = null; render();
        /** @type {HTMLElement|null} */ (el.querySelector('[data-focus-key="desc-edit"]'))?.focus();
      };
      const cancel = () => { editingDescription = false; descriptionDraft = null; render(); /** @type {HTMLElement|null} */ (el.querySelector('[data-focus-key="desc-edit"]'))?.focus(); };
      area.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
      });
      section.append(area, error, h("div", { class: "row end" },
        h("span", { class: "hint" }, "Markdown · Ctrl+Enter saves · Esc cancels"),
        h("button", { type: "button", class: "btn", onclick: cancel }, "Cancel"),
        h("button", { type: "button", class: "btn primary", onclick: save }, "Save description")));
    } else if (item.description.trim()) {
      const body = h("div", { class: "markdown" });
      body.append(renderMarkdown(doc, item.description));
      section.append(body);
    } else section.append(h("p", { class: "muted empty-line" }, canWrite ? "No description yet. Add context, links and acceptance criteria." : "No description."));
    return section;
  }

  /** @param {ItemView} item @param {WorkIndex} index @param {boolean} canWrite */
  function subIssues(item, index, canWrite) {
    const kids = (index.children.get(item.id) ?? []).filter((k) => !k.archived).sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    const progress = progressOf(index, item.id);
    const section = h("section", { class: "detail-section", "aria-labelledby": "wb-sub-h" },
      h("div", { class: "section-head" }, h("h3", { id: "wb-sub-h" }, "Sub-issues"),
        progress ? h("span", { class: "muted" }, `${progress.done} of ${progress.total} done`) : null,
        progress ? h("span", { class: "progress-bar", role: "img", "aria-label": `${Math.round((progress.done / progress.total) * 100)}% done` }, h("span", { style: { width: `${(progress.done / progress.total) * 100}%` } })) : null));
    if (kids.length) {
      section.append(h("ul", { class: "mini-list" }, kids.map((k) => h("li", null,
        h("button", { type: "button", class: "mini-item", "data-focus-key": `sub-${k.id}`, onclick: () => c.open(k) },
          itemStateIcon(k, index, { size: 13 }), h("span", { class: "card-key" }, k.key), h("span", { class: "mini-title" }, k.title),
          k.assignee ? avatar(k.assignee, index, 18) : null)))));
    }
    if (canWrite) {
      const input = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "inline-add", placeholder: "Add a sub-issue and press Enter", "aria-label": `New sub-issue of ${item.key}`, maxlength: String(LIMITS.title), "data-focus-key": "sub-add" }));
      const error = h("p", { class: "field-error", role: "alert" });
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        const r = c.createSub(item, input.value);
        error.textContent = r.ok ? "" : r.error ?? "";
        if (r.ok) { input.value = ""; c.announce("Sub-issue sent."); }
      });
      section.append(h("div", { class: "inline-add-row" }, icon("plus"), input), error);
    } else if (!kids.length) section.append(h("p", { class: "muted empty-line" }, "No sub-issues."));
    return section;
  }

  /** @param {ItemView} item @param {WorkIndex} index @param {boolean} canWrite */
  function relations(item, index, canWrite) {
    const r = relationsFor(index, item.id);
    const groups = /** @type {[string, import("../../shared/model/index.js").RelationView[], (rel: any) => string][]} */ ([
      ["Blocked by", r.blockedBy, (x) => x.from], ["Blocks", r.blocks, (x) => x.to], ["Related", r.relates, (x) => (x.from === item.id ? x.to : x.from)],
      ["Duplicates", r.duplicates, (x) => x.to], ["Duplicated by", r.duplicatedBy, (x) => x.from],
    ]).filter(([, list]) => list.length);
    const section = h("section", { class: "detail-section", "aria-labelledby": "wb-rel-h" },
      h("div", { class: "section-head" }, h("h3", { id: "wb-rel-h" }, "Relations"), h("span", { class: "grow" }),
        canWrite ? h("button", { type: "button", class: "btn ghost sm", "data-focus-key": "rel-add", "aria-haspopup": "dialog", onclick: (/** @type {Event} */ e) => c.relate(item, /** @type {HTMLElement} */ (e.currentTarget)) }, icon("link", { size: 14 }), "Add") : null));
    if (!groups.length) section.append(h("p", { class: "muted empty-line" }, "No blockers or related items."));
    for (const [label, list, other] of groups) {
      section.append(h("h4", { class: "rel-label" }, label), h("ul", { class: "mini-list" }, list.map((rel) => {
        const o = index.items.get(other(rel));
        if (!o) return null;
        const blocking = label === "Blocked by" && o.category !== "done";
        return h("li", { class: blocking ? "is-blocker" : "" },
          h("button", { type: "button", class: "mini-item", "data-focus-key": `rel-${rel.id}`, onclick: () => c.open(o) },
            blocking ? h("span", { class: "blocker-icon", title: "Blocking" }, icon("blocked", { size: 13 })) : itemStateIcon(o, index, { size: 13 }),
            h("span", { class: "card-key" }, o.key), h("span", { class: "mini-title" }, o.title)),
          canWrite ? h("button", { type: "button", class: "icon-btn sm", "aria-label": `Remove relation to ${o.key}`, title: "Remove relation", onclick: () => c.unrelate(rel, item) }, h("span", { class: "x", "aria-hidden": "true" }, "×")) : null);
      })));
    }
    return section;
  }

  /** @param {ItemView} item @param {WorkIndex} index @param {boolean} canWrite */
  function activitySection(item, index, canWrite) {
    const now = c.now();
    const entries = c.history(item.id);
    const comments = index.comments.get(item.id) ?? [];
    /** @type {{ seq: number, node: Node }[]} */
    const timeline = [];
    for (const e of entries) {
      const text = describeEntry(e, index, c.today());
      if (!text) continue;
      timeline.push({ seq: e.seq, node: h("li", { class: "event" },
        h("span", { class: "event-dot", "aria-hidden": "true" }),
        h("span", null, h("strong", null, personName(index, e.actor)), ` ${text}`, e.at ? h("span", { class: "muted" }, ` · ${relativeTime(e.at, now)}`) : null)) });
    }
    for (const cm of comments) {
      const mine = canWrite && cm.created_by !== null && cm.created_by === c.me;
      const body = h("div", { class: "markdown" });
      if (editingComment === cm.id) {
        const area = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "composer", rows: "3", "aria-label": "Edit comment", maxlength: String(LIMITS.comment) }));
        area.value = cm.body;
        const err = h("p", { class: "field-error", role: "alert" });
        const save = () => { const r = c.editComment(cm, area.value); if (!r.ok) { err.textContent = r.error ?? ""; return; } editingComment = null; render(); };
        area.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); } else if (e.key === "Escape") { e.stopPropagation(); editingComment = null; render(); } });
        body.append(area, err, h("div", { class: "row end" }, h("button", { type: "button", class: "btn", onclick: () => { editingComment = null; render(); } }, "Cancel"), h("button", { type: "button", class: "btn primary", onclick: save }, "Save")));
        queueMicrotask(() => area.focus());
      } else body.append(renderMarkdown(doc, cm.body));
      const seq = entries.find((e) => e.created)?.seq ?? 0;
      timeline.push({ seq: Math.max(seq, cm.revision) + 0.5, node: h("li", { class: "comment" },
        h("div", { class: "comment-head" }, avatar(cm.created_by, index, 20), h("strong", null, personName(index, cm.created_by)),
          cm.created ? h("span", { class: "muted" }, relativeTime(cm.created, now)) : null, cm.edited ? h("span", { class: "muted" }, "(edited)") : null,
          h("span", { class: "grow" }),
          mine && editingComment !== cm.id ? h("button", { type: "button", class: "btn ghost sm", "data-focus-key": `cm-${cm.id}`, onclick: () => { editingComment = cm.id; render(); } }, "Edit") : null),
        body) });
    }
    timeline.sort((a, b) => a.seq - b.seq);
    const section = h("section", { class: "detail-section", "aria-labelledby": "wb-act-h" },
      h("div", { class: "section-head" }, h("h3", { id: "wb-act-h" }, "Activity"), !c.historyComplete() ? h("span", { class: "muted", role: "status" }, "Loading earlier history…") : null),
      timeline.length ? h("ol", { class: "timeline" }, timeline.map((t) => t.node)) : h("p", { class: "muted empty-line" }, "No activity yet."));
    if (canWrite && index.planning) section.append(composer, composerError, h("div", { class: "row end" }, h("button", { type: "button", class: "btn primary", onclick: sendComment }, "Comment")));
    return section;
  }

  return {
    el, show, render,
    get itemId() { return itemId; },
    get editing() { return editingDescription || editingComment !== null || titleDirty; },
  };
}

/** @param {HTMLTextAreaElement} area */
function autosize(area) {
  area.style.height = "auto";
  if (area.scrollHeight) area.style.height = `${area.scrollHeight}px`;
}

/**
 * One journal entry as a sentence fragment ("moved from Todo to In Progress").
 * @param {HistoryEntry} e @param {WorkIndex} index @param {string} today
 */
export function describeEntry(e, index, today) {
  if (e.created) return "created the item";
  const d = e.diff;
  /** @type {string[]} */
  const parts = [];
  const stateName = (/** @type {unknown} */ k) => index.stateByKey.get(String(k))?.name ?? String(k ?? "");
  if (d.state) parts.push(d.state[0] ? `moved from ${stateName(d.state[0])} to ${stateName(d.state[1])}` : `moved to ${stateName(d.state[1])}`);
  else if (d.status) parts.push(`changed status to ${String(d.status[1])}`);
  if (d.title) parts.push(`renamed it to “${String(d.title[1] ?? "")}”`);
  if (d.description) parts.push("edited the description");
  if (d.priority) parts.push(Number(d.priority[1]) ? `set priority to ${PRIORITIES[Number(d.priority[1])]?.name ?? d.priority[1]}` : "removed the priority");
  if (d.assignee) parts.push(d.assignee[1] ? `assigned it to ${personName(index, /** @type {string} */ (d.assignee[1]))}` : "unassigned it");
  if (d.labels) {
    const before = new Set(/** @type {string[]} */ (d.labels[0] ?? [])), after = new Set(/** @type {string[]} */ (d.labels[1] ?? []));
    const added = [...after].filter((l) => !before.has(l)), removed = [...before].filter((l) => !after.has(l));
    const name = (/** @type {string} */ l) => index.labelByKey.get(l)?.name ?? l;
    if (added.length) parts.push(`added ${added.length === 1 ? "label" : "labels"} ${added.map(name).join(", ")}`);
    if (removed.length) parts.push(`removed ${removed.length === 1 ? "label" : "labels"} ${removed.map(name).join(", ")}`);
  }
  if (d.estimate) parts.push(d.estimate[1] === null ? "removed the estimate" : `estimated it at ${d.estimate[1]}`);
  if (d.due_date) parts.push(d.due_date[1] ? `set the due date to ${shortDate(String(d.due_date[1]), today)}` : "removed the due date");
  if (d.start_date) parts.push(d.start_date[1] ? `set the start date to ${shortDate(String(d.start_date[1]), today)}` : "removed the start date");
  if (d.parent) { const p = index.items.get(String(d.parent[1] ?? "")); parts.push(p ? `moved it under ${p.key}` : "removed the parent"); }
  if (d.project) { const p = index.projectById.get(String(d.project[1] ?? "")); parts.push(p ? `moved it to ${p.name}` : "removed it from its project"); }
  if (d.cycle) { const cy = index.cycleById.get(String(d.cycle[1] ?? "")); parts.push(cy ? `added it to ${cy.name}` : "removed it from its cycle"); }
  if (d.archived) parts.push(d.archived[1] ? "archived it" : "restored it");
  if (d.rank && !parts.length) parts.push("reordered it");
  if (d.extensions) parts.push("updated custom fields");
  if (!parts.length) return "";
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
