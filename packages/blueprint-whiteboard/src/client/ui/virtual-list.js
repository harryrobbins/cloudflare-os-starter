// @ts-check
// A virtualised list for the side panels (Objects, Activity): only the rows in and near the
// scrolled window are in the DOM, between two aria-hidden spacers that keep the scroll height.
// Rows have one height (measured from the first rendered row; single-line summaries keep them
// uniform).
//
// Accessibility:
// - every row carries aria-setsize (all rows) and aria-posinset (1-based), so screen readers
//   announce "3 of 4,812" although only a few dozen rows exist;
// - one row is "active" (roving tabindex): only its buttons (or the row itself, when it has no
//   enabled buttons) are in the Tab order, so Tab enters
//   the list once and leaves it; Up/Down move to the same button in the previous/next row,
//   Left/Right between a row's buttons, Home/End and PageUp/PageDown jump, scrolling as needed;
// - a re-render (store change, filter, scroll) restores focus to the same button of the same row
//   (by key), or, when that row is gone, to the same button of the row now at its position; the
//   focused row is kept rendered while the list scrolls, unless it is scrolled far away, in which
//   case focus moves to the list itself (the active row is remembered for the arrow keys).

/** Rows rendered beyond each edge of the window. */
export const ROW_OVERSCAN = 8;
/** Assumed visible rows while the list has no layout height (hidden, or not measured yet). */
const UNMEASURED_ROWS = 20;
/** A focused row further than this from the window is dropped (focus moves to the list). */
const MAX_FOCUS_GAP = 100;

/**
 * Rows [start, end) to render for a scroll position.
 * @param {{scrollTop: number, viewportHeight: number, rowHeight: number, count: number, overscan?: number}} args
 * @returns {{start: number, end: number}}
 */
export function windowRange({ scrollTop, viewportHeight, rowHeight, count, overscan = ROW_OVERSCAN }) {
  if (count <= 0) return { start: 0, end: 0 };
  const rh = rowHeight > 0 ? rowHeight : 1;
  const h = viewportHeight > 0 ? viewportHeight : rh * UNMEASURED_ROWS;
  const first = Math.min(count - 1, Math.max(0, Math.floor((Number(scrollTop) || 0) / rh)));
  const visible = Math.ceil(h / rh) + 1;
  return { start: Math.max(0, first - overscan), end: Math.min(count, first + visible + overscan) };
}

/**
 * Row index a navigation key moves to, or null for keys the list does not handle.
 * @param {string} key @param {number} index @param {number} count @param {number} page rows per page
 * @returns {number|null}
 */
export function navIndex(key, index, count, page) {
  if (count <= 0) return null;
  const clamp = (/** @type {number} */ i) => Math.max(0, Math.min(count - 1, i));
  switch (key) {
    case "ArrowDown": return clamp(index + 1);
    case "ArrowUp": return clamp(index - 1);
    case "Home": return 0;
    case "End": return count - 1;
    case "PageDown": return clamp(index + Math.max(1, page));
    case "PageUp": return clamp(index - Math.max(1, page));
    default: return null;
  }
}

/**
 * @typedef {object} VirtualListOptions
 * @property {HTMLElement} list        the scrolling <ul>/<ol>
 * @property {number} rowHeight        initial row height in px (re-measured once rows exist)
 * @property {(index: number) => HTMLElement} renderRow  builds row `index` (an <li>)
 * @property {(index: number) => string} rowKey  identity of row `index` (same key: same row)
 * @property {(index: number) => string} [rowStamp]  changes when row `index` must be rebuilt
 * @property {() => HTMLElement|null} [fallbackFocus]  where focus goes when the list becomes empty
 * @property {number} [overscan]
 */

/** @param {VirtualListOptions} opts */
export function createVirtualList(opts) {
  const { list, renderRow, rowKey } = opts;
  const rowStamp = opts.rowStamp ?? rowKey;
  const overscan = opts.overscan ?? ROW_OVERSCAN;
  let rowHeight = opts.rowHeight;
  let count = 0;
  /** Active (roving tabindex) row. */
  let active = 0;
  /** Button position within the active row that last had focus. */
  let column = 0;
  /** @type {Map<string, {el: HTMLElement, stamp: string}>} */
  let cache = new Map();
  let scheduled = false;
  /** Extra content shown instead of rows (empty or loading message). @type {HTMLElement|null} */
  let placeholder = null;

  const top = spacer();
  const bottom = spacer();
  /** Algorithmic counters (never content). */
  const stats = { renders: 0, rowsBuilt: 0, rendered: 0 };

  list.addEventListener("scroll", () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; render(false); });
  });
  list.addEventListener("keydown", onKeyDown);
  list.addEventListener("focusin", (e) => {
    const row = rowOf(/** @type {any} */ (e.target));
    if (!row) return;
    const i = Number(row.dataset.index);
    if (Number.isInteger(i)) {
      const buttons = focusables(row);
      const at = buttons.indexOf(/** @type {any} */ (e.target));
      if (at >= 0) column = at;
      if (i !== active) { active = i; updateTabStops(); }
    }
  });

  function spacer() {
    const li = document.createElement("li");
    li.className = "virtual-spacer";
    li.setAttribute("aria-hidden", "true");
    li.setAttribute("role", "presentation");
    return li;
  }

  /**
   * A row's focus targets: its enabled buttons, or the row itself when it has none (an entry
   * without actions is still reachable, and read, by the arrow keys).
   * @param {HTMLElement} row @returns {HTMLElement[]}
   */
  function focusables(row) {
    const buttons = /** @type {HTMLButtonElement[]} */ ([...row.querySelectorAll("button")]).filter((b) => !b.disabled);
    return buttons.length ? buttons : [row];
  }

  /** @param {HTMLElement|null} el @returns {HTMLElement|null} */
  function rowOf(el) {
    const row = /** @type {HTMLElement|null} */ (el?.closest?.("[data-index]") ?? null);
    return row && list.contains(row) ? row : null;
  }

  function viewportHeight() {
    return list.clientHeight || 0;
  }

  function pageRows() {
    const h = viewportHeight();
    return Math.max(1, Math.floor((h > 0 ? h : rowHeight * UNMEASURED_ROWS) / rowHeight) - 1);
  }

  /**
   * Renders the window, putting focus back where it was (same row by key, else same position)
   * unless `navigating` (a key press is about to move focus itself).
   * @param {boolean} [navigating]
   */
  function render(navigating = false) {
    stats.renders++;
    const activeEl = /** @type {HTMLElement|null} */ (document.activeElement);
    const focusRow = navigating ? null : rowOf(activeEl);
    const listFocused = activeEl === list;
    const focusKey = focusRow?.dataset.key ?? null;
    const focusIndex = focusRow ? Number(focusRow.dataset.index) : -1;
    const focusColumn = focusRow ? Math.max(0, focusables(focusRow).indexOf(/** @type {HTMLElement} */ (activeEl))) : column;

    if (!count) {
      cache = new Map();
      list.replaceChildren(...(placeholder ? [placeholder] : []));
      stats.rendered = 0;
      if (focusRow || listFocused) opts.fallbackFocus?.()?.focus();
      return;
    }
    active = Math.max(0, Math.min(count - 1, active));
    let { start, end } = windowRange({ scrollTop: list.scrollTop, viewportHeight: viewportHeight(), rowHeight, count, overscan });
    // Where the focused row is now: the same key, else the same position.
    let target = -1;
    if (focusRow) {
      if (focusKey !== null && focusIndex >= 0 && focusIndex < count && rowKey(focusIndex) === focusKey) target = focusIndex;
      else target = findKey(focusKey, focusIndex);
      if (target < 0) target = Math.min(count - 1, Math.max(0, focusIndex));
      active = target;
      if (target < start || target >= end) {
        if (target < start - MAX_FOCUS_GAP || target >= end + MAX_FOCUS_GAP) target = -2; // too far: focus the list
        else { start = Math.min(start, target); end = Math.max(end, target + 1); }
      }
    }
    /** @type {Map<string, {el: HTMLElement, stamp: string}>} */
    const next = new Map();
    /** @type {HTMLElement[]} */
    const rows = [];
    for (let i = start; i < end; i++) {
      const key = rowKey(i), stamp = rowStamp(i);
      let entry = cache.get(key);
      if (!entry || entry.stamp !== stamp) {
        entry = { el: renderRow(i), stamp };
        stats.rowsBuilt++;
      }
      const el = entry.el;
      el.dataset.index = String(i);
      el.dataset.key = key;
      el.setAttribute("aria-setsize", String(count));
      el.setAttribute("aria-posinset", String(i + 1));
      next.set(key, entry);
      rows.push(el);
    }
    cache = next;
    top.style.height = `${start * rowHeight}px`;
    bottom.style.height = `${(count - end) * rowHeight}px`;
    list.replaceChildren(top, ...rows, bottom);
    stats.rendered = rows.length;
    updateTabStops();
    measure(rows);
    if (target >= 0) focusIndexNow(target, focusColumn, false);
    else if (target === -2 || listFocused) list.focus();
  }

  /** Index of the row with `key`, searching outward from `near`. @param {string|null} key @param {number} near */
  function findKey(key, near) {
    if (key === null) return -1;
    const from = Math.max(0, Math.min(count - 1, near));
    for (let d = 0; d < count; d++) {
      if (from + d < count && rowKey(from + d) === key) return from + d;
      if (d && from - d >= 0 && rowKey(from - d) === key) return from - d;
      if (from + d >= count && from - d < 0) break;
    }
    return -1;
  }

  /** Adopts the rendered rows' height when it differs (fonts, zoom, phone layout). @param {HTMLElement[]} rows */
  function measure(rows) {
    const h = rows[0]?.offsetHeight;
    if (!h || Math.abs(h - rowHeight) < 1) return;
    rowHeight = h;
    const start = Number(rows[0].dataset.index), end = start + rows.length;
    top.style.height = `${start * rowHeight}px`;
    bottom.style.height = `${(count - end) * rowHeight}px`;
  }

  function updateTabStops() {
    for (const { el } of cache.values()) {
      const tab = Number(el.dataset.index) === active ? 0 : -1;
      for (const b of focusables(el)) b.tabIndex = tab;
    }
  }

  /** Scrolls row `i` into the window. @param {number} i */
  function reveal(i) {
    const h = viewportHeight();
    const y = i * rowHeight;
    if (y < list.scrollTop) list.scrollTop = y;
    else if (h > 0 && y + rowHeight > list.scrollTop + h) list.scrollTop = y + rowHeight - h;
  }

  /** @param {number} i @param {number} col @param {boolean} [rerender] */
  function focusIndexNow(i, col, rerender = true) {
    if (!count) return;
    active = Math.max(0, Math.min(count - 1, i));
    if (rerender) {
      reveal(active);
      const el = [...cache.values()].find((e) => Number(e.el.dataset.index) === active)?.el;
      if (!el) render(true);
      else updateTabStops();
    }
    const row = [...cache.values()].find((e) => Number(e.el.dataset.index) === active)?.el;
    if (!row) return;
    const buttons = focusables(row);
    const b = buttons[Math.max(0, Math.min(buttons.length - 1, col))];
    column = Math.max(0, Math.min(buttons.length - 1, col));
    if (b && document.activeElement !== b) b.focus();
  }

  /** @param {KeyboardEvent} e */
  function onKeyDown(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const target = /** @type {HTMLElement} */ (e.target);
    const row = rowOf(target);
    const from = row ? Number(row.dataset.index) : target === list ? active : -1;
    if (from < 0 || !Number.isInteger(from)) return;
    if (row && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      const buttons = focusables(row);
      const at = buttons.indexOf(target);
      if (at < 0) return;
      const to = Math.max(0, Math.min(buttons.length - 1, at + (e.key === "ArrowRight" ? 1 : -1)));
      e.preventDefault();
      column = to;
      buttons[to]?.focus();
      return;
    }
    const to = navIndex(e.key, from, count, pageRows());
    if (to === null) return;
    e.preventDefault();
    const col = row ? Math.max(0, focusables(row).indexOf(target)) : column;
    focusIndexNow(to, col);
  }

  return {
    stats,
    /**
     * New rows (count and content through renderRow/rowKey); re-renders, keeping focus.
     * @param {number} n @param {HTMLElement|null} [empty]  shown when n is 0
     */
    update(n, empty = null) {
      count = Math.max(0, n);
      placeholder = empty;
      render();
    },
    render: () => render(false),
    /** Focuses row `i` (clamped), the button at `col`. @param {number} i @param {number} [col] */
    focusRow: (i, col = column) => focusIndexNow(i, col),
    get count() { return count; },
    get active() { return active; },
    get rowHeight() { return rowHeight; },
  };
}
