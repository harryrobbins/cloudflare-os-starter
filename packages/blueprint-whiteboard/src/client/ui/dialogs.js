// @ts-check
// In-DOM replacements for alert/confirm/prompt (all blocked in the sandboxed iframe), a popup
// menu and toasts.

import { h, icon, trapTab, PALETTE, avatar, colorName, inertOthers } from "./dom.js";

/**
 * Generic modal. Resolves with whatever `build`'s `close` is called with.
 * @template T
 * @param {(close: (value: T) => void) => HTMLElement} build
 * @param {T} escapeValue
 * @param {HTMLElement|null|(() => HTMLElement|null)} [returnFocus]  where focus goes on close
 *   (default: what had it before); a function is called at close time, for elements created later
 * @returns {Promise<T>}
 */
export function modal(build, escapeValue, returnFocus = null) {
  return new Promise((resolve) => {
    const previous = /** @type {HTMLElement|null} */ (document.activeElement);
    let closed = false;
    /** @type {() => void} */
    let restoreInert = () => {};
    const close = (/** @type {T} */ value) => {
      if (closed) return;
      closed = true;
      scrim.remove();
      restoreInert();
      const wanted = typeof returnFocus === "function" ? returnFocus() : returnFocus;
      const target = wanted?.isConnected ? wanted : previous;
      if (target && target.isConnected) target.focus();
      resolve(value);
    };
    const box = build(close);
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    const scrim = h("div", { class: "modal-scrim" }, box);
    scrim.addEventListener("pointerdown", (e) => { if (e.target === scrim) close(escapeValue); });
    scrim.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(escapeValue); }
      trapTab(box, e);
    });
    document.body.appendChild(scrim);
    restoreInert = inertOthers([scrim]);
    const autofocus = /** @type {HTMLElement|null} */ (box.querySelector("[data-autofocus]"));
    (autofocus || box.querySelector("button"))?.focus();
  });
}

/**
 * Asks for a display name and colour.
 * @param {{name: string, color: string, title?: string, skippable?: boolean,
 *   returnFocus?: HTMLElement|null|(() => HTMLElement|null)}} opts
 * @returns {Promise<{name: string, color: string}|null>}  null when skipped/cancelled
 */
export function nameDialog({ name, color, title = "Who's here?", skippable = true, returnFocus = null }) {
  return modal((close) => {
    let chosen = color;
    const input = /** @type {HTMLInputElement} */ (h("input", {
      type: "text", value: name, maxlength: 40, placeholder: "Your name", "aria-label": "Your name",
      "data-autofocus": true, autocomplete: "off", class: "name-input",
    }));
    const preview = h("span", null);
    const refreshPreview = () => {
      preview.replaceChildren(avatar(input.value || "Guest", chosen));
    };
    // A radio group: one Tab stop (the checked colour), arrow keys move and choose.
    const choose = (/** @type {number} */ i, /** @type {boolean} */ focus) => {
      chosen = PALETTE[i];
      [...swatches.children].forEach((sw, j) => {
        sw.setAttribute("aria-checked", String(j === i));
        sw.setAttribute("tabindex", j === i ? "0" : "-1");
      });
      if (focus) /** @type {HTMLElement} */ (swatches.children[i]).focus();
      refreshPreview();
    };
    const swatches = h("div", { class: "swatches", role: "radiogroup", "aria-label": "Colour" },
      PALETTE.map((c, i) => h("button", {
        type: "button", class: "swatch", role: "radio", "aria-checked": String(c === chosen),
        tabindex: c === chosen || (i === 0 && !PALETTE.includes(chosen)) ? "0" : "-1",
        "aria-label": colorName(c), style: { background: c },
        onclick: () => choose(i, false),
      })),
    );
    swatches.addEventListener("keydown", (e) => {
      const i = [...swatches.children].indexOf(/** @type {any} */ (document.activeElement));
      if (i < 0) return;
      const n = PALETTE.length;
      const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % n
        : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i - 1 + n) % n
          : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
      if (next === null) return;
      e.preventDefault();
      choose(next, true);
    });
    input.addEventListener("input", refreshPreview);
    refreshPreview();
    // No <form>: the platform iframe's sandbox lacks allow-forms, so native submission is blocked
    // before a submit event fires. A button click and Enter in the input do the same thing.
    const join = () => {
      const value = input.value.trim();
      close(value ? { name: value, color: chosen } : null);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); join(); }
    });
    const form = h("div", { class: "modal name-dialog", "aria-label": title },
      h("h2", null, title),
      h("p", null, "Pick a name and colour so others can see your cursor and changes on the whiteboard. Nothing is stored."),
      h("div", { style: { display: "flex", gap: "10px", alignItems: "center" } }, preview, input),
      swatches,
      h("div", { class: "modal-actions" },
        skippable
          ? h("button", { type: "button", class: "btn outline", "data-skip": true, onclick: () => close(null) }, "Continue as guest")
          : h("button", { type: "button", class: "btn outline", onclick: () => close(null) }, "Cancel"),
        h("button", { type: "button", class: "btn primary join-btn", onclick: join }, "Join whiteboard"),
      ),
    );
    requestAnimationFrame(() => input.select());
    return form;
  }, null, returnFocus);
}

/** @type {HTMLElement|null} */
let openMenuEl = null;

/**
 * @typedef {{left: number, top: number, right: number, bottom: number}} ClientRect
 */

/** Distance (px) a touch-opened menu keeps from the finger. */
export const TOUCH_CLEARANCE = 48;

/**
 * Where to put a menu of size (w, h) so it does not cover `avoid` (e.g. the finger, or the
 * selection it acts on): below it, else above, else to the right, else to the left, else clamped.
 * `prefer: "above"` tries above first (a finger hides what is below it). Pure.
 * @param {{w: number, h: number}} menu @param {ClientRect} avoid @param {{w: number, h: number}} view
 * @param {{prefer?: "below"|"above", margin?: number, gap?: number}} [opts]
 * @returns {{left: number, top: number}}
 */
export function placeMenu(menu, avoid, view, { prefer = "below", margin = 8, gap = 4 } = {}) {
  const clampX = (/** @type {number} */ x) => Math.max(margin, Math.min(x, view.w - menu.w - margin));
  const clampY = (/** @type {number} */ y) => Math.max(margin, Math.min(y, view.h - menu.h - margin));
  const below = avoid.bottom + gap, above = avoid.top - gap - menu.h;
  const fitsBelow = below + menu.h <= view.h - margin, fitsAbove = above >= margin;
  const vertical = prefer === "above"
    ? (fitsAbove ? above : fitsBelow ? below : null)
    : (fitsBelow ? below : fitsAbove ? above : null);
  if (vertical !== null) return { left: clampX(avoid.left), top: vertical };
  const right = avoid.right + gap, left = avoid.left - gap - menu.w;
  if (right + menu.w <= view.w - margin) return { left: right, top: clampY(avoid.top) };
  if (left >= margin) return { left, top: clampY(avoid.top) };
  return { left: clampX(avoid.left), top: clampY(avoid.bottom) };
}

/**
 * A small popup menu anchored to an element or a point (client coordinates).
 *
 * Items activate only by keyboard or by a press that STARTS after the menu opened: a touch
 * long-press opens the menu while the finger is still down, and lifting that finger must not pick
 * whatever item ended up under it.
 * @param {HTMLElement|{x: number, y: number, returnFocus?: HTMLElement|null, avoid?: ClientRect|null, pointerType?: string}} anchor
 *   `avoid`: a client rect the menu is placed beside (default: the point itself). A touch
 *   anchor keeps TOUCH_CLEARANCE from the point and prefers to sit above it.
 * @param {{label: string, onSelect: () => void, danger?: boolean, className?: string}[]} items
 * @param {{label?: string}} [opts]
 */
export function openMenu(anchor, items, { label = "Actions" } = {}) {
  closeMenu();
  const isEl = anchor instanceof HTMLElement;
  const previous = /** @type {HTMLElement|null} */ (document.activeElement);
  const returnTo = isEl ? anchor : (anchor.returnFocus ?? previous);
  const refocus = () => { if (returnTo && returnTo.isConnected) returnTo.focus({ preventScroll: true }); };
  let armed = false;
  const menu = h("div", { class: "menu", role: "menu", "aria-label": label },
    items.map((item) => h("button", {
      type: "button", role: "menuitem", class: "btn" + (item.danger ? " danger-text" : "") + (item.className ? " " + item.className : ""),
      onclick: (/** @type {MouseEvent} */ e) => {
        // detail 0: keyboard (Enter/Space) or assistive technology activation.
        if (!armed && e.detail !== 0) return;
        closeMenu(); refocus(); item.onSelect();
      },
    }, item.label)),
  );
  // Arm on a press inside the menu (the capture listener below sees it before the item's click).
  menu.addEventListener("pointerdown", () => { armed = true; }, true);
  document.body.appendChild(menu);
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  if (isEl) {
    const rect = anchor.getBoundingClientRect();
    menu.style.top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8)) + "px";
    menu.style.left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) + "px";
  } else {
    const touch = anchor.pointerType === "touch";
    const c = touch ? TOUCH_CLEARANCE : 0;
    const avoid = anchor.avoid ?? { left: anchor.x - c, top: anchor.y - c, right: anchor.x + c, bottom: anchor.y + c };
    const at = placeMenu({ w: width, h: height }, avoid, { w: window.innerWidth, h: window.innerHeight },
      { prefer: touch ? "above" : "below" });
    menu.style.top = at.top + "px";
    menu.style.left = at.left + "px";
  }
  openMenuEl = menu;
  const onDown = (/** @type {Event} */ e) => {
    if (!menu.contains(/** @type {Node} */ (e.target))) closeMenu();
  };
  const onKey = (/** @type {KeyboardEvent} */ e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); refocus(); return; }
    // Tab leaves the menu: focus the anchor first so the browser's default Tab moves on from it.
    if (e.key === "Tab") { closeMenu(); refocus(); return; }
    const buttons = /** @type {HTMLElement[]} */ ([...menu.querySelectorAll("button")]);
    const i = buttons.indexOf(/** @type {any} */ (document.activeElement));
    /** @type {number|null} */
    let next = null;
    if (e.key === "ArrowDown") next = (i + 1) % buttons.length;
    else if (e.key === "ArrowUp") next = (i - 1 + buttons.length) % buttons.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = buttons.length - 1;
    if (next !== null) { e.preventDefault(); buttons[next].focus(); }
  };
  setTimeout(() => document.addEventListener("pointerdown", onDown, true));
  menu.addEventListener("keydown", onKey);
  /** @type {any} */ (menu)._cleanup = () => document.removeEventListener("pointerdown", onDown, true);
  /** @type {HTMLElement|null} */ (menu.querySelector("button"))?.focus();
  return menu;
}

export function closeMenu() {
  if (!openMenuEl) return;
  /** @type {any} */ (openMenuEl)._cleanup?.();
  openMenuEl.remove();
  openMenuEl = null;
}

/** @type {HTMLElement|null} */
let toastHost = null;

/** Creates the (empty) toast live region up front so later toasts are announced reliably. */
export function ensureToastHost() {
  if (!toastHost || !toastHost.isConnected) {
    toastHost = /** @type {HTMLElement|null} */ (document.body.querySelector(".toasts")) ?? h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    if (!toastHost.isConnected) document.body.appendChild(toastHost);
  }
  return toastHost;
}

/**
 * @param {string} message
 * @param {{timeout?: number}} [opts]  0 = stays until dismissed
 */
export function showToast(message, { timeout = 8000 } = {}) {
  const host = ensureToastHost();
  for (const existing of host.querySelectorAll(".toast")) {
    if (existing.querySelector(".msg")?.textContent === message) existing.remove();
  }
  const toast = h("div", { class: "toast" },
    h("span", { class: "msg" }, message),
    h("button", {
      type: "button", class: "btn icon-only", "aria-label": "Dismiss", onclick: () => toast.remove(),
    }, icon("close")),
  );
  host.appendChild(toast);
  if (timeout) setTimeout(() => toast.remove(), timeout);
  return toast;
}
