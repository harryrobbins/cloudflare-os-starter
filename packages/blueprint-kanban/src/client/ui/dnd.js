// @ts-check
// Pointer-event drag and drop for cards (within and between columns) and columns (by header).
// HTML5 drag and drop is avoided: it is unreliable in sandboxed iframes and absent on touch.

/** @typedef {import("./app.js").App} App */

const THRESHOLD_PX = 5;
const EDGE_PX = 56;
const MAX_SCROLL_STEP = 18;
const TAB_HOVER_MS = 350;

/** @param {App} app */
export function installDnd(app) {
  const { store } = app;
  const boardView = /** @type {NonNullable<App["boardView"]>} */ (app.boardView);
  const boardEl = boardView.boardEl;

  /**
   * @typedef {object} Pending
   * @property {"card"|"column"} kind
   * @property {string} id
   * @property {HTMLElement} el
   * @property {number} pointerId
   * @property {number} startX
   * @property {number} startY
   */
  /** @type {Pending|null} */
  let pending = null;

  /**
   * @typedef {object} Drag
   * @property {"card"|"column"} kind
   * @property {string} id
   * @property {HTMLElement} el
   * @property {HTMLElement} ghost
   * @property {HTMLElement} placeholder
   * @property {number} offsetX
   * @property {number} offsetY
   * @property {number} x
   * @property {number} y
   * @property {string} originColumnId   card drags
   * @property {string|null} originBeforeId  card drags
   * @property {number} originIndex      column drags
   * @property {string|null} hoverColumnId
   * @property {number} raf
   * @property {{id: string, since: number}|null} tabHover
   */
  /** @type {Drag|null} */
  let drag = null;

  boardEl.addEventListener("pointerdown", onDown);

  /** @param {PointerEvent} e */
  function onDown(e) {
    if (drag || pending) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const target = /** @type {HTMLElement} */ (e.target);
    const interactive = target.closest("button, input, textarea, select, a, form, [contenteditable]");
    const cardEl = /** @type {HTMLElement|null} */ (target.closest(".card"));
    if (cardEl && boardEl.contains(cardEl) && !interactive) {
      pending = { kind: "card", id: cardEl.dataset.cardId || "", el: cardEl, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY };
    } else {
      const head = /** @type {HTMLElement|null} */ (target.closest(".column-head"));
      if (!head) return;
      if (interactive && !interactive.classList.contains("inline-edit-display")) return;
      const columnEl = /** @type {HTMLElement} */ (head.closest(".column"));
      pending = { kind: "column", id: columnEl.dataset.columnId || "", el: columnEl, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY };
    }
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  }

  /** @param {PointerEvent} e */
  function onMove(e) {
    if (!pending || e.pointerId !== pending.pointerId) return;
    if (!drag) {
      if (Math.hypot(e.clientX - pending.startX, e.clientY - pending.startY) < THRESHOLD_PX) return;
      start(pending, e);
    }
    e.preventDefault();
    update(e.clientX, e.clientY);
  }

  /** @param {PointerEvent} e */
  function onUp(e) {
    if (!pending || e.pointerId !== pending.pointerId) return;
    if (drag) {
      update(e.clientX, e.clientY);
      drop();
      suppressNextClick();
    }
    reset();
  }

  /** @param {PointerEvent} e */
  function onCancel(e) {
    if (!pending || e.pointerId !== pending.pointerId) return;
    cancel();
  }

  /** @param {KeyboardEvent} e */
  function onKey(e) {
    if (e.key === "Escape" && pending) {
      e.preventDefault();
      e.stopPropagation();
      if (drag) suppressNextClick();
      cancel();
    }
  }

  function suppressNextClick() {
    const stop = (/** @type {Event} */ ev) => { ev.stopPropagation(); ev.preventDefault(); };
    window.addEventListener("click", stop, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 0);
  }

  /**
   * @param {Pending} p
   * @param {PointerEvent} e
   */
  function start(p, e) {
    const rect = p.el.getBoundingClientRect();
    const ghost = /** @type {HTMLElement} */ (p.el.cloneNode(true));
    ghost.classList.add("drag-ghost");
    ghost.classList.remove("peer-open", "peer-drag", "dim", "mobile-hidden");
    ghost.querySelector(".peer-badges")?.remove();
    ghost.removeAttribute("tabindex");
    ghost.setAttribute("aria-hidden", "true");
    ghost.style.width = rect.width + "px";
    ghost.style.left = rect.left + "px";
    ghost.style.top = rect.top + "px";
    for (const idEl of [ghost, ...ghost.querySelectorAll("[id]")]) idEl.removeAttribute("id");

    let placeholder;
    let originColumnId = "";
    let originBeforeId = null;
    let originIndex = -1;
    if (p.kind === "card") {
      placeholder = document.createElement("div");
      placeholder.className = "placeholder";
      placeholder.style.height = rect.height + "px";
      originColumnId = p.el.closest(".column")?.getAttribute("data-column-id") ?? "";
      originBeforeId = nextCardId(p.el);
      p.el.parentNode?.insertBefore(placeholder, p.el);
      p.el.classList.add("drag-source");
      ghost.style.height = rect.height + "px";
    } else {
      placeholder = document.createElement("div");
      placeholder.className = "column-placeholder";
      placeholder.style.height = Math.min(rect.height, boardEl.clientHeight - 28) + "px";
      originIndex = columnEls().indexOf(p.el);
      boardEl.insertBefore(placeholder, p.el);
      p.el.classList.add("col-drag-source");
    }
    document.body.appendChild(ghost);
    document.body.classList.add("dragging");
    try { boardEl.setPointerCapture(p.pointerId); } catch { /* pointer already gone */ }

    drag = {
      kind: p.kind, id: p.id, el: p.el, ghost, placeholder,
      offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top,
      x: e.clientX, y: e.clientY,
      originColumnId, originBeforeId, originIndex,
      hoverColumnId: originColumnId || null,
      raf: requestAnimationFrame(autoScroll),
      tabHover: null,
    };
    app.dragging = true;
    if (p.kind === "card") store.setPresence({ dragCardId: p.id, hoverColumnId: originColumnId });
  }

  /** @returns {HTMLElement[]} */
  function columnEls() {
    return /** @type {HTMLElement[]} */ ([...boardEl.children]).filter((c) => c.classList.contains("column"));
  }

  /** @param {HTMLElement} el */
  function nextCardId(el) {
    let next = el.nextElementSibling;
    while (next && (!next.classList.contains("card") || next.classList.contains("drag-source"))) next = next.nextElementSibling;
    return next ? /** @type {HTMLElement} */ (next).dataset.cardId ?? null : null;
  }

  /**
   * @param {number} x
   * @param {number} y
   */
  function update(x, y) {
    if (!drag) return;
    drag.x = x;
    drag.y = y;
    drag.ghost.style.left = x - drag.offsetX + "px";
    drag.ghost.style.top = y - drag.offsetY + "px";
    if (drag.kind === "card") updateCard(x, y);
    else updateColumn(x);
  }

  /**
   * @param {number} x
   * @param {number} y
   */
  function updateCard(x, y) {
    if (!drag) return;
    const under = document.elementFromPoint(x, y);
    // Phone layout: hovering a tab switches to that column.
    const tab = /** @type {HTMLElement|null} */ (under?.closest("[data-tab-column-id]") ?? null);
    if (tab) {
      const id = tab.dataset.tabColumnId || "";
      if (drag.tabHover?.id !== id) drag.tabHover = { id, since: performance.now() };
      else if (performance.now() - drag.tabHover.since > TAB_HOVER_MS && app.activeColumnId !== id) boardView.setActive(id);
    } else {
      drag.tabHover = null;
    }

    let columnEl = /** @type {HTMLElement|null} */ (under?.closest(".column") ?? null);
    if (!columnEl || !boardEl.contains(columnEl)) {
      // Between columns or outside the board: nearest visible column horizontally.
      let best = null;
      let bestDist = Infinity;
      for (const col of columnEls()) {
        const r = col.getBoundingClientRect();
        if (r.width === 0) continue;
        const dist = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
        if (dist < bestDist) { bestDist = dist; best = col; }
      }
      columnEl = best;
    }
    if (!columnEl) return;
    const list = /** @type {HTMLElement|null} */ (columnEl.querySelector(".cards"));
    if (!list) return;
    const cards = /** @type {HTMLElement[]} */ ([...list.children]).filter((c) => c.classList.contains("card") && !c.classList.contains("drag-source"));
    let before = null;
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      if (y < r.top + r.height / 2) { before = c; break; }
    }
    if (drag.placeholder.parentNode !== list || nextNonSource(drag.placeholder) !== before) {
      list.insertBefore(drag.placeholder, before);
    }
    const columnId = columnEl.dataset.columnId || null;
    if (columnId !== drag.hoverColumnId) {
      drag.hoverColumnId = columnId;
      store.setPresence({ dragCardId: drag.id, hoverColumnId: columnId });
    }
  }

  /** @param {Element} el */
  function nextNonSource(el) {
    let next = el.nextElementSibling;
    while (next && (!next.classList.contains("card") || next.classList.contains("drag-source"))) next = next.nextElementSibling;
    return next;
  }

  /** @param {number} x */
  function updateColumn(x) {
    if (!drag) return;
    const cols = columnEls().filter((c) => c !== drag?.el);
    let before = null;
    for (const c of cols) {
      const r = c.getBoundingClientRect();
      if (r.width === 0) continue;
      if (x < r.left + r.width / 2) { before = c; break; }
    }
    const addColumn = boardEl.querySelector(".add-column");
    const ref = before ?? addColumn;
    let next = drag.placeholder.nextElementSibling;
    while (next && next === drag.el) next = next.nextElementSibling;
    if (next !== ref) boardEl.insertBefore(drag.placeholder, ref);
  }

  function autoScroll() {
    if (!drag) return;
    const { x, y } = drag;
    const br = boardEl.getBoundingClientRect();
    let scrolled = false;
    const step = (/** @type {number} */ dist) => Math.ceil(MAX_SCROLL_STEP * Math.min(1, (EDGE_PX - dist) / EDGE_PX));
    if (x < br.left + EDGE_PX && boardEl.scrollLeft > 0) { boardEl.scrollLeft -= step(Math.max(0, x - br.left)); scrolled = true; }
    else if (x > br.right - EDGE_PX && boardEl.scrollLeft < boardEl.scrollWidth - boardEl.clientWidth) { boardEl.scrollLeft += step(Math.max(0, br.right - x)); scrolled = true; }
    if (drag.kind === "card") {
      const list = /** @type {HTMLElement|null} */ (drag.placeholder.parentElement);
      if (list && list.classList.contains("cards")) {
        const lr = list.getBoundingClientRect();
        if (x >= lr.left && x <= lr.right) {
          if (y < lr.top + EDGE_PX && list.scrollTop > 0) { list.scrollTop -= step(Math.max(0, y - lr.top)); scrolled = true; }
          else if (y > lr.bottom - EDGE_PX && list.scrollTop < list.scrollHeight - list.clientHeight) { list.scrollTop += step(Math.max(0, lr.bottom - y)); scrolled = true; }
        }
      }
    }
    if (scrolled || drag.tabHover) update(x, y);
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function drop() {
    if (!drag) return;
    const d = drag;
    const state = store.getState();
    if (d.kind === "card") {
      const list = d.placeholder.parentElement;
      const toColumnId = list?.dataset.columnList;
      const beforeCardId = nextNonSource(d.placeholder)?.getAttribute("data-card-id") ?? null;
      const card = state.board.cards[d.id];
      if (!card || !toColumnId || !state.board.columns[toColumnId]) return;
      const unchanged = toColumnId === card.columnId && beforeCardId === d.originBeforeId && toColumnId === d.originColumnId;
      if (unchanged) return;
      if (beforeCardId === d.id) return;
      list?.insertBefore(d.el, d.placeholder);
      d.el.classList.remove("drag-source");
      store.moveCard(d.id, toColumnId, beforeCardId);
    } else {
      const children = /** @type {HTMLElement[]} */ ([...boardEl.children]);
      let index = 0;
      for (const c of children) {
        if (c === d.placeholder) break;
        if (c.classList.contains("column") && c !== d.el) index++;
      }
      if (index === d.originIndex || !state.board.columns[d.id]) return;
      boardEl.insertBefore(d.el, d.placeholder);
      d.el.classList.remove("col-drag-source");
      store.moveColumn(d.id, index);
    }
  }

  function cancel() {
    reset();
  }

  function reset() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, true);
    const p = pending;
    pending = null;
    if (!drag) return;
    const d = drag;
    drag = null;
    cancelAnimationFrame(d.raf);
    d.ghost.remove();
    d.placeholder.remove();
    d.el.classList.remove("drag-source", "col-drag-source");
    document.body.classList.remove("dragging");
    try { if (p) boardEl.releasePointerCapture(p.pointerId); } catch { /* ignore */ }
    app.dragging = false;
    if (d.kind === "card") store.setPresence({ dragCardId: null, hoverColumnId: null });
    // Renders skipped nothing, but re-sync once so order reflects the store exactly.
    boardView.renderAll(store.getState());
    app.refreshPresence();
  }

  return { get active() { return !!drag; } };
}
