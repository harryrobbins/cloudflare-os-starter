// @ts-check
// The card side panel: every field of one card, saved as you type, plus the conflict banner,
// checklist and comment thread.

import { LIMITS, newId, cardsInColumn } from "../../shared/protocol.js";
import { h, icon, avatar, debounce, formatTime, trapTab, PALETTE, textOn, colorName, inertOthers } from "./dom.js";
import { confirmDialog, showToast } from "./dialogs.js";
import { colorForName } from "./card.js";

/** @typedef {import("../store-contract.js").ClientState} ClientState */
/** @typedef {import("../store-contract.js").Change} Change */
/** @typedef {import("../../shared/protocol.js").Card} Card */
/** @typedef {import("../../shared/protocol.js").Comment} Comment */
/** @typedef {import("./app.js").App} App */

const SAVE_DEBOUNCE_MS = 400;

/** @param {App} app */
export function createPanel(app) {
  const { store } = app;
  /** @type {null | ReturnType<typeof build>} */
  let current = null;

  /** @param {string} cardId */
  function open(cardId) {
    if (current?.cardId === cardId) { current.focus(); return; }
    close({ restoreFocus: false });
    const state = store.getState();
    if (!state.board.cards[cardId]) return;
    current = build(cardId);
    store.setPresence({ openCardId: cardId });
    current.sync(state);
    current.focus();
  }

  function close({ restoreFocus = true } = {}) {
    if (!current) return;
    const { cardId } = current;
    current.destroy();
    current = null;
    store.setPresence({ openCardId: null });
    if (restoreFocus) app.cardEls.get(cardId)?.focus();
  }

  /**
   * @param {ClientState} state
   * @param {Change} change
   */
  function onChange(state, change) {
    if (!current) return;
    if (change.kind === "comment" && change.comment?.cardId === current.cardId) {
      current.addComments([change.comment]);
      return;
    }
    if (change.kind === "presence") return;
    current.sync(state);
  }

  /** @param {ClientState} state */
  function renderViewers(state) { current?.renderViewers(state); }

  /** @param {string} cardId */
  function build(cardId) {
    const card = () => store.getState().board.cards[cardId];
    /** @type {(() => void)[]} */
    const cleanups = [];
    /** @type {{flush: () => void, cancel: () => void}[]} */
    const debouncers = [];

    // ---- head
    const where = h("div", { class: "where" });
    const viewers = h("div", { class: "viewers", role: "group", "aria-label": "Also viewing" });
    const closeBtn = h("button", {
      type: "button", class: "btn icon-only panel-close", "aria-label": "Close card", title: "Close (Esc)",
      onclick: () => close(),
    }, icon("close", 18));
    const head = h("div", { class: "panel-head" },
      h("div", { style: { flex: "1", minWidth: "0" } }, where),
      viewers, closeBtn);

    // ---- banner
    const banner = h("div", { class: "banner-host" });
    let bannerKey = "";

    // ---- title
    const titleId = "panel-title-" + cardId;
    const titleInput = /** @type {HTMLTextAreaElement} */ (h("textarea", {
      id: titleId, class: "panel-title", rows: 1, maxlength: LIMITS.cardTitle, "aria-label": "Card title",
    }));
    const autoGrow = () => { titleInput.style.height = "auto"; titleInput.style.height = titleInput.scrollHeight + "px"; };
    titleInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); titleInput.blur(); } });
    titleInput.addEventListener("input", autoGrow);
    const syncTitle = bindField(titleInput, "title", (v) => v.replace(/\s+/g, " ").trim(), { allowEmpty: false });

    // ---- assignee + due
    const datalistId = "assignees-" + cardId;
    const datalist = h("datalist", { id: datalistId });
    const assigneeInput = /** @type {HTMLInputElement} */ (h("input", {
      type: "text", class: "assignee-input", maxlength: LIMITS.assignee, placeholder: "Unassigned", list: datalistId, "aria-label": "Assignee",
    }));
    const syncAssignee = bindField(assigneeInput, "assignee", (v) => v.trim(), { allowEmpty: true });
    const dueInput = /** @type {HTMLInputElement} */ (h("input", { type: "date", class: "due-input", "aria-label": "Due date" }));
    dueInput.addEventListener("change", () => {
      if (!card()) return;
      store.updateCard(cardId, { due: dueInput.value || null });
    });
    const clearDue = h("button", {
      type: "button", class: "btn small", onclick: () => { dueInput.value = ""; store.updateCard(cardId, { due: null }); },
    }, "Clear");
    const meBtn = h("button", {
      type: "button", class: "btn small", onclick: () => {
        const name = store.getState().viewer.name;
        if (!name) return;
        assigneeInput.value = name;
        store.updateCard(cardId, { assignee: name });
      },
    }, "Assign me");

    // ---- column / position (keyboard alternative to dragging)
    const moveSelect = /** @type {HTMLSelectElement} */ (h("select", { class: "move-select", "aria-label": "Move to column" }));
    moveSelect.addEventListener("change", () => {
      const c = card();
      const to = moveSelect.value;
      const state = store.getState();
      if (!c || to === c.columnId || !state.board.columns[to]) return;
      store.moveCard(cardId, to, null);
      app.announce(`Moved "${c.title}" to ${state.board.columns[to].name}`);
    });
    /** @param {"top"|"bottom"} where */
    const moveWithin = (where) => {
      const c = card();
      if (!c) return;
      const siblings = cardsInColumn(store.getState().board.cards, c.columnId);
      const index = siblings.findIndex((x) => x.id === cardId);
      if (where === "top") {
        if (index <= 0) { app.announce("Already at the top"); return; }
        store.moveCard(cardId, c.columnId, siblings[0].id);
        app.announce(`Moved "${c.title}" to the top`);
      } else {
        if (index === siblings.length - 1) { app.announce("Already at the bottom"); return; }
        store.moveCard(cardId, c.columnId, null);
        app.announce(`Moved "${c.title}" to the bottom`);
      }
    };
    const topBtn = h("button", {
      type: "button", class: "btn small outline move-top", "aria-label": "Move to top of column", onclick: () => moveWithin("top"),
    }, "Top");
    const bottomBtn = h("button", {
      type: "button", class: "btn small outline move-bottom", "aria-label": "Move to bottom of column", onclick: () => moveWithin("bottom"),
    }, "Bottom");

    // ---- labels
    const labelToggles = h("div", { class: "label-toggles", role: "group", "aria-label": "Labels" });
    let newLabelColor = PALETTE[5];
    const newLabelName = /** @type {HTMLInputElement} */ (h("input", {
      type: "text", placeholder: "New label", maxlength: LIMITS.labelName, "aria-label": "New label name",
    }));
    const newLabelSwatches = h("div", { class: "swatches", role: "radiogroup", "aria-label": "Label colour" },
      PALETTE.map((c) => h("button", {
        type: "button", class: "swatch", role: "radio", "aria-checked": String(c === newLabelColor),
        "aria-label": colorName(c), style: { background: c },
        onclick: (/** @type {Event} */ e) => {
          newLabelColor = c;
          for (const s of newLabelSwatches.children) s.setAttribute("aria-checked", String(s === e.currentTarget));
        },
      })));
    const newLabelForm = h("form", { class: "new-label" },
      newLabelName, newLabelSwatches, h("button", { type: "submit", class: "btn small outline" }, icon("plus", 14), "Create label"));
    newLabelForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = newLabelName.value.trim();
      if (!name || !card()) return;
      const labelId = store.upsertLabel(null, name, newLabelColor);
      const c = card();
      if (c && labelId && !c.labels.includes(labelId)) store.updateCard(cardId, { labels: [...c.labels, labelId] });
      newLabelName.value = "";
    });
    let labelsKey = "";

    // ---- description
    const descInput = /** @type {HTMLTextAreaElement} */ (h("textarea", {
      class: "description", maxlength: LIMITS.description, placeholder: "Add a more detailed description…", "aria-label": "Description",
    }));
    const syncDesc = bindField(descInput, "description", (v) => v, { allowEmpty: true });

    // ---- checklist
    const progressBar = h("div", {});
    const progress = h("div", { class: "progress" }, progressBar);
    const progressText = h("span", { class: "muted checklist-count" });
    const checklistEl = h("div", { class: "checklist" });
    /** @type {Map<string, {row: HTMLElement, box: HTMLInputElement, text: HTMLInputElement, del: HTMLElement, save: ReturnType<typeof debounce>}>} */
    const itemRows = new Map();
    const addItemInput = /** @type {HTMLInputElement} */ (h("input", {
      type: "text", placeholder: "Add an item", maxlength: LIMITS.checklistText, "aria-label": "New checklist item",
    }));
    const addItemForm = h("form", { class: "check-add" }, addItemInput, h("button", { type: "submit", class: "btn small outline" }, "Add"));
    addItemForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = addItemInput.value.trim();
      const c = card();
      if (!text || !c) return;
      store.updateCard(cardId, { checklist: [...c.checklist, { id: newId("item"), text, done: false }] });
      addItemInput.value = "";
      addItemInput.focus();
    });

    /**
     * @param {(items: Card["checklist"]) => Card["checklist"]} fn
     */
    function editChecklist(fn) {
      const c = card();
      if (!c) return;
      store.updateCard(cardId, { checklist: fn(c.checklist.map((i) => ({ ...i }))) });
    }

    /** @param {Card["checklist"][number]} item */
    function createItemRow(item) {
      const box = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", "aria-label": "Done: " + item.text }));
      const text = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "check-text", maxlength: LIMITS.checklistText, "aria-label": "Checklist item: " + item.text }));
      const save = debounce(() => {
        const value = text.value.trim();
        if (!value) return;
        editChecklist((items) => items.map((i) => i.id === item.id ? { ...i, text: value } : i));
      }, SAVE_DEBOUNCE_MS);
      debouncers.push(save);
      box.addEventListener("change", () => {
        editChecklist((items) => items.map((i) => i.id === item.id ? { ...i, done: box.checked } : i));
      });
      text.addEventListener("input", () => save());
      text.addEventListener("blur", () => {
        save.flush();
        const c = card();
        const stored = c?.checklist.find((i) => i.id === item.id);
        if (stored && !text.value.trim()) text.value = stored.text;
      });
      text.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); text.blur(); } });
      const del = h("button", {
        type: "button", class: "btn icon-only small", "aria-label": "Delete item: " + item.text, title: "Delete item",
        onclick: () => { save.cancel(); editChecklist((items) => items.filter((i) => i.id !== item.id)); },
      }, icon("trash", 14));
      const row = h("div", { class: "check-item", dataset: { itemId: item.id } }, box, text, del);
      return { row, box, text, del, save };
    }

    /** @param {Card} c */
    function syncChecklist(c) {
      const seen = new Set();
      let prev = /** @type {HTMLElement|null} */ (null);
      for (const item of c.checklist) {
        seen.add(item.id);
        let entry = itemRows.get(item.id);
        if (!entry) { entry = createItemRow(item); itemRows.set(item.id, entry); }
        if (entry.box.checked !== item.done) entry.box.checked = item.done;
        if (entry.box.getAttribute("aria-label") !== "Done: " + item.text) {
          entry.box.setAttribute("aria-label", "Done: " + item.text);
          entry.text.setAttribute("aria-label", "Checklist item: " + item.text);
          entry.del.setAttribute("aria-label", "Delete item: " + item.text);
        }
        entry.row.classList.toggle("done", item.done);
        if (document.activeElement !== entry.text && !entry.save.pending() && entry.text.value !== item.text) entry.text.value = item.text;
        const expectedNext = prev ? prev.nextElementSibling : checklistEl.firstElementChild;
        if (expectedNext !== entry.row) checklistEl.insertBefore(entry.row, expectedNext);
        prev = entry.row;
      }
      for (const [id, entry] of itemRows) {
        if (!seen.has(id)) { entry.save.cancel(); entry.row.remove(); itemRows.delete(id); }
      }
      const done = c.checklist.filter((i) => i.done).length;
      const total = c.checklist.length;
      progressBar.style.width = total ? `${Math.round((done / total) * 100)}%` : "0%";
      progress.classList.toggle("complete", total > 0 && done === total);
      progress.hidden = total === 0;
      progressText.textContent = total ? `${done}/${total}` : "";
    }

    // ---- comments
    const commentsEl = h("div", { class: "comments", "aria-live": "polite" }, h("p", { class: "muted" }, "Loading comments…"));
    /** @type {Map<string, Comment>} */
    const comments = new Map();
    let commentsLoaded = false;
    /** @param {Comment[]} list */
    function addComments(list) {
      let changed = false;
      for (const c of list) {
        if (!c || c.cardId !== cardId || comments.has(c.id)) continue;
        comments.set(c.id, c);
        changed = true;
      }
      if (changed || !commentsLoaded) renderComments();
    }
    function renderComments() {
      const sorted = [...comments.values()].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
      if (!sorted.length) {
        commentsEl.replaceChildren(h("p", { class: "muted" }, commentsLoaded ? "No comments yet." : "Loading comments…"));
        return;
      }
      commentsEl.replaceChildren(...sorted.map((c) => h("div", { class: "comment", dataset: { commentId: c.id } },
        avatar(c.author || "Guest", colorForName(c.author || "Guest"), "small"),
        h("div", { class: "comment-body" },
          h("div", { class: "comment-head" }, h("strong", null, c.author || "Guest"), formatTime(c.at)),
          h("div", { class: "comment-text" }, c.text)),
      )));
    }
    store.loadComments(cardId).then((list) => {
      commentsLoaded = true;
      addComments(list);
    }, (err) => {
      commentsLoaded = true;
      commentsEl.replaceChildren(h("p", { class: "muted" }, "Couldn't load comments: " + (err?.message ?? err)));
    });
    const commentInput = /** @type {HTMLTextAreaElement} */ (h("textarea", {
      placeholder: "Write a comment…", maxlength: LIMITS.commentText, "aria-label": "New comment", class: "comment-input",
    }));
    const commentBtn = /** @type {HTMLButtonElement} */ (h("button", { type: "submit", class: "btn primary small" }, "Comment"));
    const commentForm = h("form", { class: "comment-form" }, commentInput, h("div", null, commentBtn));
    const sendComment = async () => {
      const text = commentInput.value.trim();
      if (!text) return;
      commentBtn.disabled = true;
      try {
        const comment = await store.addComment(cardId, text);
        commentInput.value = "";
        if (comment) addComments([comment]);
      } catch (err) {
        showToast("Comment not sent: " + (/** @type {any} */ (err)?.message ?? err));
      } finally {
        commentBtn.disabled = false;
      }
    };
    commentForm.addEventListener("submit", (e) => { e.preventDefault(); sendComment(); });
    commentInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendComment(); }
    });

    // ---- foot
    const info = h("div", { class: "card-info" });
    const deleteBtn = h("button", {
      type: "button", class: "btn small delete-card", style: { color: "var(--danger)" },
      onclick: async () => {
        const c = card();
        if (!c) return;
        const ok = await confirmDialog({
          title: "Delete this card?", message: `"${c.title}" and its comments will be deleted for everyone.`,
          confirmLabel: "Delete card", danger: true, returnFocus: deleteBtn,
        });
        if (!ok) return;
        for (const d of debouncers) d.cancel();
        const columnId = card()?.columnId ?? c.columnId;
        const siblings = cardsInColumn(store.getState().board.cards, columnId);
        const index = siblings.findIndex((x) => x.id === cardId);
        const nextId = (siblings[index + 1] ?? siblings[index - 1])?.id ?? null;
        store.deleteCard(cardId);
        close({ restoreFocus: false });
        const next = nextId ? app.cardEls.get(nextId) : null;
        if (next && next.isConnected) next.focus();
        else /** @type {HTMLElement|null|undefined} */ (app.boardView?.views.get(columnId)?.el.querySelector(".column-foot button, .column-foot textarea"))?.focus();
        app.announce(`Deleted "${c.title}"`);
      },
    }, icon("trash", 14), "Delete card");

    const body = h("div", { class: "panel-body" },
      banner,
      titleInput,
      h("div", { class: "field-row" },
        h("div", null, h("div", { class: "field-label" }, icon("user", 13), "Assignee"),
          h("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, assigneeInput, meBtn), datalist),
        h("div", null, h("div", { class: "field-label" }, icon("calendar", 13), "Due date"),
          h("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, dueInput, clearDue)),
      ),
      h("div", null, h("div", { class: "field-label" }, icon("list", 13), "Column"),
        h("div", { class: "move-row" }, moveSelect, topBtn, bottomBtn)),
      h("div", null, h("div", { class: "field-label" }, icon("tag", 13), "Labels"), labelToggles, newLabelForm),
      h("div", null, h("div", { class: "field-label" }, icon("text", 13), "Description"), descInput),
      h("div", null,
        h("div", { class: "field-label" }, icon("check", 13), "Checklist", progress, progressText),
        checklistEl, addItemForm),
      h("div", null, h("div", { class: "field-label" }, icon("comment", 13), "Comments"), commentsEl, commentForm),
      h("div", { class: "panel-foot" }, info, deleteBtn),
    );

    const panel = h("aside", {
      class: "panel", role: "dialog", "aria-modal": "true", "aria-labelledby": titleId, tabindex: "-1",
      dataset: { panelCardId: cardId },
    }, head, body);
    const scrim = h("div", { class: "scrim" });
    scrim.addEventListener("pointerdown", () => close());
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        // Escape in a field first commits it, then closes.
        close();
        return;
      }
      trapTab(panel, e);
    });
    document.body.append(scrim, panel);
    const restoreInert = inertOthers([scrim, panel]);
    cleanups.push(() => { scrim.remove(); panel.remove(); restoreInert(); });

    /**
     * Binds a text field: debounced save while typing, save on blur, and remote updates only
     * when the user isn't mid-edit.
     * @param {HTMLInputElement|HTMLTextAreaElement} input
     * @param {"title"|"description"|"assignee"} field
     * @param {(v: string) => string} clean
     * @param {{allowEmpty: boolean}} opts
     */
    function bindField(input, field, clean, { allowEmpty }) {
      const save = debounce(() => {
        const c = card();
        if (!c) return;
        const value = clean(input.value);
        if (!allowEmpty && !value) return;
        if (value === c[field]) return;
        store.updateCard(cardId, { [field]: value });
      }, SAVE_DEBOUNCE_MS);
      debouncers.push(save);
      input.addEventListener("input", () => save());
      input.addEventListener("blur", () => {
        save.flush();
        const c = card();
        if (c && !allowEmpty && !clean(input.value)) input.value = c[field];
      });
      return (/** @type {Card} */ c) => {
        if (document.activeElement === input || save.pending()) return;
        if (input.value !== c[field]) input.value = c[field];
      };
    }

    /** @param {ClientState} state */
    function renderViewers(state) {
      const peers = [...state.peers.values()].filter((p) => p.openCardId === cardId);
      const key = peers.map((p) => p.clientId + p.name + p.color).join("|");
      if (viewers.dataset.key === key) return;
      viewers.dataset.key = key;
      viewers.replaceChildren(...peers.map((p) => avatar(p.name || "Guest", p.color, "small")));
      viewers.title = peers.length ? "Also viewing: " + peers.map((p) => p.name || "Guest").join(", ") : "";
    }

    /** @param {ClientState} state */
    function renderBanner(state) {
      const conflict = state.conflicts.get(cardId);
      const c = state.board.cards[cardId];
      let key = "";
      if (conflict) key = "conflict:" + JSON.stringify([conflict.mine, conflict.theirs]);
      else if (!c) key = "deleted";
      if (key === bannerKey) return;
      bannerKey = key;
      if (!key) { banner.replaceChildren(); return; }
      if (!conflict || conflict.theirs === null) {
        const resolveDeleted = () => {
          for (const d of debouncers) d.cancel();
          if (conflict) store.resolveConflict(cardId, "discard");
          close({ restoreFocus: false });
        };
        // Announced through the app's live region (with who did it), so no role="alert" here.
        banner.replaceChildren(h("div", { class: "banner conflict-banner" },
          h("strong", null, "This card was deleted"),
          h("span", null, "Someone else deleted this card. Your unsaved changes can't be kept."),
          h("div", { class: "actions" }, h("button", { type: "button", class: "btn primary small", onclick: resolveDeleted }, "Close")),
        ));
        return;
      }
      const theirs = conflict.theirs;
      const rows = [];
      for (const field of Object.keys(conflict.mine)) {
        rows.push(h("dt", null, fieldName(field)), h("dd", null, describe(field, /** @type {any} */ (theirs)[field], state)));
      }
      banner.replaceChildren(h("div", { class: "banner conflict-banner" },
        h("strong", null, "Someone else changed this card"),
        h("span", null, "Their version:"),
        h("dl", null, rows),
        h("span", { class: "muted" }, "Your version: " + Object.entries(conflict.mine).map(([f, v]) => `${fieldName(f)}: ${describe(f, v, state)}`).join("; ")),
        h("div", { class: "actions" },
          h("button", {
            type: "button", class: "btn primary small keep-mine",
            onclick: () => { for (const d of debouncers) d.flush(); store.resolveConflict(cardId, "overwrite"); },
          }, "Keep mine"),
          h("button", {
            type: "button", class: "btn outline small use-theirs",
            onclick: () => {
              for (const d of debouncers) d.cancel();
              store.resolveConflict(cardId, "discard");
              forceSync();
            },
          }, "Use theirs"),
        ),
      ));
    }

    function forceSync() {
      const c = card();
      if (!c) return;
      titleInput.value = c.title;
      descInput.value = c.description;
      assigneeInput.value = c.assignee;
      autoGrow();
    }

    /** @param {ClientState} state */
    function sync(state) {
      renderBanner(state);
      const c = state.board.cards[cardId];
      const disabled = !c;
      for (const el of panel.querySelectorAll(".panel-body input, .panel-body textarea, .panel-body select, .panel-body button:not(.banner button)")) {
        /** @type {any} */ (el).disabled = disabled;
      }
      if (!c) return;
      const column = state.board.columns[c.columnId];
      where.replaceChildren("in ", h("strong", null, column?.name ?? "?"));
      const columnsKey = state.board.columnOrder.map((id) => id + ":" + (state.board.columns[id]?.name ?? "")).join("|");
      if (moveSelect.dataset.key !== columnsKey) {
        moveSelect.dataset.key = columnsKey;
        moveSelect.replaceChildren(...state.board.columnOrder.filter((id) => state.board.columns[id])
          .map((id) => h("option", { value: id }, state.board.columns[id].name)));
      }
      if (moveSelect.value !== c.columnId) moveSelect.value = c.columnId;
      syncTitle(c);
      autoGrow();
      syncAssignee(c);
      syncDesc(c);
      if (document.activeElement !== dueInput && dueInput.value !== (c.due ?? "")) dueInput.value = c.due ?? "";
      clearDue.hidden = !c.due;
      meBtn.hidden = !state.viewer.name || c.assignee === state.viewer.name;

      const names = new Set(Object.values(state.board.cards).map((x) => x.assignee).filter(Boolean));
      if (state.viewer.name) names.add(state.viewer.name);
      const namesKey = [...names].sort().join("|");
      if (datalist.dataset.key !== namesKey) {
        datalist.dataset.key = namesKey;
        datalist.replaceChildren(...[...names].sort().map((n) => h("option", { value: n })));
      }

      const labels = Object.values(state.board.labels).sort((a, b) => a.name.localeCompare(b.name));
      const lk = labels.map((l) => `${l.id}:${l.name}:${l.color}:${c.labels.includes(l.id)}`).join("|");
      if (lk !== labelsKey) {
        labelsKey = lk;
        const focusedLabel = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.labelId : undefined;
        labelToggles.replaceChildren(...labels.map((l) => h("button", {
          type: "button", class: "chip label-toggle", "aria-pressed": String(c.labels.includes(l.id)),
          style: { "--chip": l.color, "--chip-text": textOn(l.color) }, dataset: { labelId: l.id },
          onclick: () => {
            const cur = card();
            if (!cur) return;
            const on = cur.labels.includes(l.id);
            store.updateCard(cardId, { labels: on ? cur.labels.filter((x) => x !== l.id) : [...cur.labels, l.id] });
          },
        }, l.name)));
        if (!labels.length) labelToggles.appendChild(h("span", { class: "muted" }, "No labels yet."));
        if (focusedLabel) /** @type {HTMLElement|null} */ (labelToggles.querySelector(`[data-label-id="${focusedLabel}"]`))?.focus();
      }

      syncChecklist(c);
      info.replaceChildren(
        `Created by ${c.createdBy || "someone"} ${formatTime(c.createdAt)}`,
        c.updatedAt && c.updatedAt !== c.createdAt ? ` · updated ${formatTime(c.updatedAt)}` : "",
      );
      renderViewers(state);
    }

    return {
      cardId,
      sync,
      addComments,
      renderViewers,
      focus: () => panel.focus(),
      destroy() {
        for (const d of debouncers) d.flush();
        for (const fn of cleanups) fn();
      },
    };
  }

  return {
    open,
    close,
    onChange,
    renderViewers,
    get cardId() { return current?.cardId ?? null; },
  };
}

/** @param {string} field */
function fieldName(field) {
  return ({ title: "Title", description: "Description", labels: "Labels", assignee: "Assignee", due: "Due", checklist: "Checklist", order: "Position" })[field] ?? field;
}

/**
 * @param {string} field
 * @param {any} value
 * @param {ClientState} state
 */
function describe(field, value, state) {
  if (value == null || value === "") return "(empty)";
  if (field === "labels") return value.map((/** @type {string} */ id) => state.board.labels[id]?.name).filter(Boolean).join(", ") || "(none)";
  if (field === "checklist") return value.map((/** @type {any} */ i) => (i.done ? "☑ " : "☐ ") + i.text).join(", ") || "(empty)";
  return String(value);
}
