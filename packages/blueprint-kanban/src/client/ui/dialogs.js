// @ts-check
// In-DOM replacements for alert/confirm/prompt (all blocked in the sandboxed iframe), a popup
// menu and toasts.

import { h, icon, trapTab, PALETTE, avatar, colorName, inertOthers } from "./dom.js";

/**
 * Generic modal. Resolves with whatever `build`'s `close` is called with.
 * @template T
 * @param {(close: (value: T) => void) => HTMLElement} build
 * @param {T} escapeValue
 * @param {HTMLElement|null} [returnFocus]  where focus goes on close (default: what had it before)
 * @returns {Promise<T>}
 */
function modal(build, escapeValue, returnFocus = null) {
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
      const target = returnFocus?.isConnected ? returnFocus : previous;
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
 * @param {{title: string, message?: string, confirmLabel?: string, danger?: boolean, returnFocus?: HTMLElement|null}} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, message, confirmLabel = "OK", danger = false, returnFocus = null }) {
  return modal((close) => h("div", { class: "modal confirm-dialog", "aria-label": title },
    h("h2", null, title),
    message ? h("p", null, message) : null,
    h("div", { class: "modal-actions" },
      h("button", { type: "button", class: "btn outline", onclick: () => close(false) }, "Cancel"),
      h("button", {
        type: "button", class: "btn " + (danger ? "danger" : "primary"), "data-autofocus": true,
        "data-confirm": true, onclick: () => close(true),
      }, confirmLabel),
    ),
  ), false, returnFocus);
}

/**
 * Lets the viewer pick their colour. The name is the signed-in account's and is not editable.
 * @param {{name: string, color: string}} opts
 * @returns {Promise<string|null>}  the chosen colour; null when cancelled
 */
export function colorDialog({ name, color }) {
  return modal((close) => {
    let chosen = color;
    const preview = h("span", null);
    const refreshPreview = () => {
      preview.replaceChildren(avatar(name || "Guest", chosen));
    };
    const swatches = h("div", { class: "swatches", role: "radiogroup", "aria-label": "Colour" },
      PALETTE.map((c) => h("button", {
        type: "button", class: "swatch", role: "radio", "aria-checked": String(c === chosen),
        "aria-label": colorName(c), style: { background: c }, "data-autofocus": c === chosen || undefined,
        onclick: (/** @type {Event} */ e) => {
          chosen = c;
          for (const s of swatches.children) s.setAttribute("aria-checked", String(s === e.currentTarget));
          refreshPreview();
        },
      })),
    );
    refreshPreview();
    return h("div", { class: "modal color-dialog", "aria-label": "Your colour" },
      h("h2", null, "Your colour"),
      h("p", null, "Others see this colour next to your name on the board."),
      h("div", { style: { display: "flex", gap: "10px", alignItems: "center" } }, preview, h("strong", { class: "color-dialog-name" }, name || "Guest")),
      swatches,
      h("div", { class: "modal-actions" },
        h("button", { type: "button", class: "btn outline", onclick: () => close(null) }, "Cancel"),
        h("button", { type: "button", class: "btn primary save-btn", onclick: () => close(chosen) }, "Save"),
      ),
    );
  }, null);
}

/** @type {HTMLElement|null} */
let openMenuEl = null;

/**
 * A small popup menu anchored to `anchor`.
 * @param {HTMLElement} anchor
 * @param {{label: string, onSelect: () => void, danger?: boolean}[]} items
 */
export function openMenu(anchor, items) {
  closeMenu();
  const rect = anchor.getBoundingClientRect();
  const menu = h("div", { class: "menu", role: "menu" },
    items.map((item) => h("button", {
      type: "button", role: "menuitem", class: "btn" + (item.danger ? " danger-text" : ""),
      onclick: () => { closeMenu(); anchor.focus(); item.onSelect(); },
    }, item.label)),
  );
  document.body.appendChild(menu);
  const width = menu.offsetWidth;
  menu.style.top = Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8) + "px";
  menu.style.left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) + "px";
  openMenuEl = menu;
  const onDown = (/** @type {Event} */ e) => {
    if (!menu.contains(/** @type {Node} */ (e.target))) closeMenu();
  };
  const onKey = (/** @type {KeyboardEvent} */ e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); anchor.focus(); return; }
    // Tab leaves the menu: focus the anchor first so the browser's default Tab moves on from it.
    if (e.key === "Tab") { closeMenu(); anchor.focus(); return; }
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
