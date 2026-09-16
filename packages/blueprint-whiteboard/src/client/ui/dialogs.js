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
        "aria-label": colorName(c), style: { background: c },
        onclick: (/** @type {Event} */ e) => {
          chosen = c;
          for (const s of swatches.children) s.setAttribute("aria-checked", String(s === e.currentTarget));
          refreshPreview();
        },
      })),
    );
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
  }, null);
}

/** @type {HTMLElement|null} */
let openMenuEl = null;

/**
 * A small popup menu anchored to an element or a point (client coordinates).
 * @param {HTMLElement|{x: number, y: number, returnFocus?: HTMLElement|null}} anchor
 * @param {{label: string, onSelect: () => void, danger?: boolean, className?: string}[]} items
 * @param {{label?: string}} [opts]
 */
export function openMenu(anchor, items, { label = "Actions" } = {}) {
  closeMenu();
  const isEl = anchor instanceof HTMLElement;
  const previous = /** @type {HTMLElement|null} */ (document.activeElement);
  const returnTo = isEl ? anchor : (anchor.returnFocus ?? previous);
  const refocus = () => { if (returnTo && returnTo.isConnected) returnTo.focus({ preventScroll: true }); };
  const menu = h("div", { class: "menu", role: "menu", "aria-label": label },
    items.map((item) => h("button", {
      type: "button", role: "menuitem", class: "btn" + (item.danger ? " danger-text" : "") + (item.className ? " " + item.className : ""),
      onclick: () => { closeMenu(); refocus(); item.onSelect(); },
    }, item.label)),
  );
  document.body.appendChild(menu);
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  if (isEl) {
    const rect = anchor.getBoundingClientRect();
    menu.style.top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8)) + "px";
    menu.style.left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) + "px";
  } else {
    menu.style.top = Math.max(8, Math.min(anchor.y, window.innerHeight - height - 8)) + "px";
    menu.style.left = Math.max(8, Math.min(anchor.x, window.innerWidth - width - 8)) + "px";
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
