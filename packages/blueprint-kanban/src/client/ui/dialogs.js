// @ts-check
// In-DOM replacements for alert/confirm/prompt (all blocked in the sandboxed iframe), a popup
// menu and toasts.

import { h, icon, trapTab, PALETTE, avatar } from "./dom.js";

/**
 * Generic modal. Resolves with whatever `build`'s `close` is called with.
 * @template T
 * @param {(close: (value: T) => void) => HTMLElement} build
 * @param {T} escapeValue
 * @returns {Promise<T>}
 */
function modal(build, escapeValue) {
  return new Promise((resolve) => {
    const previous = /** @type {HTMLElement|null} */ (document.activeElement);
    let closed = false;
    const close = (/** @type {T} */ value) => {
      if (closed) return;
      closed = true;
      scrim.remove();
      if (previous && previous.isConnected) previous.focus();
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
    const autofocus = /** @type {HTMLElement|null} */ (box.querySelector("[data-autofocus]"));
    (autofocus || box.querySelector("button"))?.focus();
  });
}

/**
 * @param {{title: string, message?: string, confirmLabel?: string, danger?: boolean}} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, message, confirmLabel = "OK", danger = false }) {
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
  ), false);
}

/**
 * Asks for a display name and colour.
 * @param {{name: string, color: string, title?: string, skippable?: boolean}} opts
 * @returns {Promise<{name: string, color: string}|null>}  null when skipped/cancelled
 */
export function nameDialog({ name, color, title = "Who's here?", skippable = true }) {
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
    const swatches = h("div", { class: "swatches", role: "radiogroup", "aria-label": "Colour" },
      PALETTE.map((c) => h("button", {
        type: "button", class: "swatch", role: "radio", "aria-checked": String(c === chosen),
        "aria-label": "Colour " + c, style: { background: c },
        onclick: (/** @type {Event} */ e) => {
          chosen = c;
          for (const s of swatches.children) s.setAttribute("aria-checked", String(s === e.currentTarget));
          refreshPreview();
        },
      })),
    );
    input.addEventListener("input", refreshPreview);
    refreshPreview();
    const form = h("form", { class: "modal name-dialog", "aria-label": title },
      h("h2", null, title),
      h("p", null, "Pick a name and colour so others can see who is on the board. Nothing is stored."),
      h("div", { style: { display: "flex", gap: "10px", alignItems: "center" } }, preview, input),
      swatches,
      h("div", { class: "modal-actions" },
        skippable
          ? h("button", { type: "button", class: "btn outline", "data-skip": true, onclick: () => close(null) }, "Continue as guest")
          : h("button", { type: "button", class: "btn outline", onclick: () => close(null) }, "Cancel"),
        h("button", { type: "submit", class: "btn primary" }, "Join board"),
      ),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const value = input.value.trim();
      close(value ? { name: value, color: chosen } : null);
    });
    requestAnimationFrame(() => input.select());
    return form;
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
      onclick: () => { closeMenu(); item.onSelect(); },
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
    if (e.key === "Escape") { e.stopPropagation(); closeMenu(); anchor.focus(); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const buttons = [...menu.querySelectorAll("button")];
      const i = buttons.indexOf(/** @type {any} */ (document.activeElement));
      const next = e.key === "ArrowDown" ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
      buttons[next].focus();
    }
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

/**
 * @param {string} message
 * @param {{timeout?: number}} [opts]  0 = stays until dismissed
 */
export function showToast(message, { timeout = 8000 } = {}) {
  if (!toastHost || !toastHost.isConnected) {
    toastHost = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.appendChild(toastHost);
  }
  for (const existing of toastHost.querySelectorAll(".toast")) {
    if (existing.querySelector(".msg")?.textContent === message) existing.remove();
  }
  const toast = h("div", { class: "toast", role: "alert" },
    h("span", { class: "msg" }, message),
    h("button", {
      type: "button", class: "btn icon-only", "aria-label": "Dismiss", onclick: () => toast.remove(),
    }, icon("close")),
  );
  toastHost.appendChild(toast);
  if (timeout) setTimeout(() => toast.remove(), timeout);
  return toast;
}
