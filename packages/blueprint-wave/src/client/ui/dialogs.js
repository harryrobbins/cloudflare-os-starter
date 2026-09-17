// @ts-check
// In-DOM replacements for alert/confirm/prompt (all blocked in the sandboxed iframe): the colour
// dialog, a confirm, the Record decision dialog, a run card dialog, a text dialog for Markdown
// export (the clipboard API is blocked, so the text is selected for a native copy), a popup menu
// and toasts. Every dialog is focus-trapped, closes on Escape, restores focus, and uses no <form>
// (the sandbox lacks allow-forms).

import { LIMITS, DEFAULT_NAME } from "../../shared/protocol.js";
import { el, svgIcon, trapTab, PALETTE, avatar, colorName, inertOthers, blipTitle, formatTime } from "./dom.js";

/** @typedef {import("../../shared/protocol.js").Blip} Blip */

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
      if (target && target.isConnected) target.focus({ preventScroll: true });
      resolve(value);
    };
    const box = build(close);
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    const scrim = el("div", { class: "modal-scrim" }, box);
    scrim.addEventListener("pointerdown", (e) => { if (e.target === scrim) close(escapeValue); });
    scrim.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(escapeValue); return; }
      trapTab(box, e);
    });
    document.body.appendChild(scrim);
    restoreInert = inertOthers([scrim]);
    const autofocus = /** @type {HTMLElement|null} */ (box.querySelector("[data-autofocus]"));
    (autofocus || box.querySelector("button"))?.focus();
  });
}

/** @returns {boolean} whether a modal dialog is open */
export function isModalOpen() {
  return !!document.querySelector(".modal-scrim");
}

/**
 * Lets the viewer pick their colour. The name is the signed-in account's and is not editable:
 * nobody is ever asked for a name.
 * @param {{name: string, color: string, returnFocus?: HTMLElement|null|(() => HTMLElement|null)}} opts
 * @returns {Promise<string|null>}  the chosen colour; null when cancelled
 */
export function colorDialog({ name, color, returnFocus = null }) {
  return modal((close) => {
    let chosen = PALETTE.includes(color) ? color : PALETTE[0];
    const shownName = name || DEFAULT_NAME;
    const preview = el("span", null);
    const refreshPreview = () => { preview.replaceChildren(avatar(shownName, chosen)); };
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
    const swatches = el("div", { class: "swatches", role: "radiogroup", "aria-label": "Colour" },
      PALETTE.map((c, i) => el("button", {
        type: "button", class: "swatch", role: "radio", "aria-checked": String(c === chosen),
        tabindex: c === chosen ? "0" : "-1",
        "data-autofocus": c === chosen || undefined,
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
    refreshPreview();
    return el("div", { class: "modal color-dialog", "aria-label": "Your colour" },
      el("h2", null, "Your colour"),
      el("p", null, "Others see this colour on your caret and next to your name. Your name is your account's display name."),
      el("div", { class: "name-row" }, preview, el("strong", { class: "color-dialog-name" }, shownName)),
      swatches,
      el("div", { class: "modal-actions" },
        el("button", { type: "button", class: "btn outline", onclick: () => close(null) }, "Cancel"),
        el("button", { type: "button", class: "btn primary save-btn", onclick: () => close(chosen) }, "Save"),
      ),
    );
  }, null, returnFocus);
}

/**
 * A yes/no question. Resolves true when confirmed.
 * @param {{title: string, message?: string, confirmLabel?: string, cancelLabel?: string, danger?: boolean,
 *   returnFocus?: HTMLElement|null|(() => HTMLElement|null)}} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, message = "", confirmLabel = "OK", cancelLabel = "Cancel", danger = false, returnFocus = null }) {
  return modal((close) => el("div", { class: "modal confirm-dialog", "aria-label": title },
    el("h2", null, title),
    message ? el("p", null, message) : null,
    el("div", { class: "modal-actions" },
      el("button", { type: "button", class: "btn outline cancel-btn", onclick: () => close(false) }, cancelLabel),
      el("button", {
        type: "button", class: "btn primary confirm-btn" + (danger ? " danger" : ""), "data-autofocus": true, onclick: () => close(true),
      }, confirmLabel),
    ),
  ), false, returnFocus);
}

/**
 * The Record decision dialog, prefilled from the thread's brief and any accepted proposal.
 * @param {{thread: Blip|null, threadText?: string, brief?: string, acceptedProposal?: Blip|null,
 *   decisions?: Blip[], returnFocus?: HTMLElement|null|(() => HTMLElement|null)}} opts
 *   `decisions`: earlier decisions in the thread, oldest first (the latest not yet superseded is
 *   preselected under "Supersedes")
 * @returns {Promise<{text: string, rationale: string, dissent: string, nextSteps: string, supersedes?: string}|null>}
 */
export function decisionDialog({ thread, threadText = "", brief = "", acceptedProposal = null, decisions = [], returnFocus = null }) {
  return modal((close) => {
    const proposal = acceptedProposal?.proposal ?? null;
    const summary = proposal?.summary ?? "";
    const field = (/** @type {string} */ cls, /** @type {string} */ label, /** @type {string} */ value, /** @type {number} */ max, /** @type {string} */ hint, required = false) => {
      const id = "dd-" + cls;
      const area = /** @type {HTMLTextAreaElement} */ (el("textarea", {
        id, class: "field " + cls, value, maxlength: max, rows: cls === "decision" ? 3 : 2,
        "aria-required": required ? "true" : null, "aria-describedby": id + "-hint", "data-autofocus": cls === "decision" ? true : null,
      }));
      area.value = value;
      return { area, wrap: el("div", { class: "field-row" },
        el("label", { for: id }, label, required ? el("span", { class: "muted" }, " (required)") : null),
        area,
        el("div", { id: id + "-hint", class: "hint" }, hint)) };
    };
    const text = field("decision", "Decision", summary, LIMITS.textChars, "One or two sentences, in the form \"We choose …\" or \"We will …\".", true);
    const rationale = field("rationale", "Rationale", proposal ? `Accepted proposal ${acceptedProposal?.id}: ${summary}` : "", LIMITS.decisionFieldChars, "Why this, and what it weighed against. Cite blip ids (b_…) where the evidence is.");
    const dissent = field("dissent", "Dissent", "", LIMITS.decisionFieldChars, "Who disagreed and why, so it is not lost.");
    const nextSteps = field("next-steps", "Next steps", "", LIMITS.decisionFieldChars, "Owner, action, date.");

    const open = decisions.filter((d) => d.kind === "decision" && !d.deleted);
    const latest = [...open].reverse().find((d) => !d.decision?.supersededBy) ?? open[open.length - 1] ?? null;
    const select = /** @type {HTMLSelectElement} */ (el("select", { id: "dd-supersedes", class: "field supersedes" },
      el("option", { value: "" }, "None"),
      open.map((d, i) => el("option", { value: d.id, selected: latest?.id === d.id }, `Decision ${i + 1}: ${blipTitle(d, 60)}`)),
    ));
    if (latest) select.value = latest.id;

    const contextLines = [];
    if (thread) contextLines.push(el("div", null, el("strong", null, "Thread: "), blipTitle(thread, 100)));
    const briefExcerpt = (brief || "").replace(/^\s*#{1,3}\s*Brief\s*/i, "").replace(/\s+/g, " ").trim();
    if (briefExcerpt) contextLines.push(el("div", null, el("strong", null, "Brief: "), briefExcerpt.length > 280 ? briefExcerpt.slice(0, 279) + "…" : briefExcerpt));
    const threadExcerpt = (threadText || "").replace(/\s+/g, " ").trim();
    if (threadExcerpt && threadExcerpt !== briefExcerpt) contextLines.push(el("div", null, el("strong", null, "Root: "), threadExcerpt.length > 280 ? threadExcerpt.slice(0, 279) + "…" : threadExcerpt));
    if (acceptedProposal) contextLines.push(el("div", null, el("strong", null, "Accepted proposal: "), summary || acceptedProposal.id));

    const error = el("div", { class: "field-error", role: "alert", hidden: true });
    const record = () => {
      const value = text.area.value.trim();
      if (!value) {
        error.hidden = false;
        error.textContent = "Write the decision first.";
        text.area.focus();
        return;
      }
      close({
        text: value,
        rationale: rationale.area.value.trim(),
        dissent: dissent.area.value.trim(),
        nextSteps: nextSteps.area.value.trim(),
        supersedes: select.value || undefined,
      });
    };
    const box = el("div", { class: "modal decision-dialog", "aria-label": "Record decision" },
      el("h2", null, "Record decision"),
      contextLines.length ? el("div", { class: "context" }, contextLines) : null,
      text.wrap, rationale.wrap, dissent.wrap, nextSteps.wrap,
      open.length ? el("div", { class: "field-row" }, el("label", { for: "dd-supersedes" }, "Supersedes"), select) : null,
      el("p", { class: "muted" }, "Decisions are locked once recorded. To change one, record a new decision; it supersedes the old one and both remain."),
      error,
      el("div", { class: "modal-actions" },
        el("button", { type: "button", class: "btn outline cancel-btn", onclick: () => close(null) }, "Cancel"),
        el("button", { type: "button", class: "btn primary record-btn", onclick: record }, "Record decision"),
      ),
    );
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); record(); }
    });
    return box;
  }, null, returnFocus);
}

/**
 * Shows a run card in a dialog ("Show run" on an agent card). Resolves when closed.
 * @param {import("../../shared/protocol.js").Run} run
 * @param {{card: HTMLElement, returnFocus?: HTMLElement|null|(() => HTMLElement|null)}} opts
 *   `card`: the run card element (panel.js renderRunCard) so the two views never drift
 * @returns {Promise<void>}
 */
export function runDialog(run, { card, returnFocus = null }) {
  return modal((close) => el("div", { class: "modal run-dialog", "aria-label": "Agent run" },
    el("h2", null, "Agent run ", el("code", { class: "muted" }, run?.id ?? "")),
    card,
    el("div", { class: "modal-actions" },
      el("button", { type: "button", class: "btn primary close-btn", "data-autofocus": true, onclick: () => close(undefined) }, "Close"),
    ),
  ), undefined, returnFocus);
}

/**
 * Shows text in a read-only textarea, selected, so it can be copied with the keyboard or a
 * long-press (navigator.clipboard is blocked by the iframe's permissions policy).
 * @param {string} title
 * @param {string} text
 * @param {{note?: string, returnFocus?: HTMLElement|null|(() => HTMLElement|null)}} [opts]
 * @returns {Promise<void>}
 */
export function textDialog(title, text, { note = "", returnFocus = null } = {}) {
  return modal((close) => {
    const area = /** @type {HTMLTextAreaElement} */ (el("textarea", {
      class: "text-dialog-text", readOnly: true, "aria-label": title, rows: 16, "data-autofocus": true, spellcheck: "false",
    }));
    area.value = text;
    const selectAll = () => { area.focus(); area.select(); };
    requestAnimationFrame(selectAll);
    return el("div", { class: "modal text-dialog", "aria-label": title },
      el("h2", null, title),
      el("p", { class: "muted" }, note || "The text is selected: press Ctrl+C (⌘+C on a Mac) or use your browser's copy to take it with you."),
      area,
      el("div", { class: "modal-actions" },
        el("button", { type: "button", class: "btn outline select-all-btn", onclick: selectAll }, "Select all"),
        el("button", { type: "button", class: "btn primary close-btn", onclick: () => close(undefined) }, "Close"),
      ),
    );
  }, undefined, returnFocus);
}

// ---------------------------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------------------------

/** @type {HTMLElement|null} */
let openMenuEl = null;

/**
 * @typedef {{left: number, top: number, right: number, bottom: number}} ClientRect
 */

/**
 * Where to put a menu of size (w, h) so it sits below `avoid`, else above, else clamped. Pure.
 * @param {{w: number, h: number}} menu @param {ClientRect} avoid @param {{w: number, h: number}} view
 * @param {{margin?: number, gap?: number, alignRight?: boolean}} [opts]
 * @returns {{left: number, top: number}}
 */
export function placeMenu(menu, avoid, view, { margin = 8, gap = 4, alignRight = false } = {}) {
  const clampX = (/** @type {number} */ x) => Math.max(margin, Math.min(x, view.w - menu.w - margin));
  const clampY = (/** @type {number} */ y) => Math.max(margin, Math.min(y, view.h - menu.h - margin));
  const left = alignRight ? avoid.right - menu.w : avoid.left;
  const below = avoid.bottom + gap, above = avoid.top - gap - menu.h;
  if (below + menu.h <= view.h - margin) return { left: clampX(left), top: below };
  if (above >= margin) return { left: clampX(left), top: above };
  return { left: clampX(left), top: clampY(below) };
}

/**
 * A small popup menu anchored to an element. Items activate by keyboard or by a press that starts
 * after the menu opened. `disabled` items are shown but not activatable (aria-disabled).
 * @param {HTMLElement} anchor
 * @param {{label: string|Node|any[], onSelect?: () => void, danger?: boolean, className?: string, disabled?: boolean, description?: string}[]} items
 * @param {{label?: string, note?: string|null, head?: HTMLElement|null, alignRight?: boolean, className?: string}} [opts]
 *   `note`: explanatory text shown under the items; `head`: content shown above them
 */
export function openMenu(anchor, items, { label = "Actions", note = null, head = null, alignRight = true, className = "" } = {}) {
  closeMenu();
  const previous = /** @type {HTMLElement|null} */ (document.activeElement);
  const returnTo = anchor ?? previous;
  const refocus = () => { if (returnTo && returnTo.isConnected) returnTo.focus({ preventScroll: true }); };
  let armed = false;
  const menu = el("div", { class: "menu " + className, role: "menu", "aria-label": label },
    head,
    items.map((item) => el("button", {
      type: "button", role: "menuitem",
      class: "btn menu-item" + (item.danger ? " danger-text" : "") + (item.className ? " " + item.className : ""),
      "aria-disabled": item.disabled ? "true" : null,
      onclick: (/** @type {MouseEvent} */ e) => {
        // detail 0: keyboard (Enter/Space) or assistive technology activation.
        if (!armed && e.detail !== 0) return;
        if (item.disabled) return;
        closeMenu(); refocus(); item.onSelect?.();
      },
    }, item.label, item.description ? el("span", { class: "menu-desc" }, item.description) : null)),
    note ? el("div", { class: "menu-note" }, note) : null,
  );
  menu.addEventListener("pointerdown", () => { armed = true; }, true);
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const at = placeMenu({ w: menu.offsetWidth, h: menu.offsetHeight }, rect, { w: window.innerWidth, h: window.innerHeight }, { alignRight });
  menu.style.top = at.top + "px";
  menu.style.left = at.left + "px";
  openMenuEl = menu;
  anchor.setAttribute("aria-expanded", "true");
  const onDown = (/** @type {Event} */ e) => {
    if (!menu.contains(/** @type {Node} */ (e.target))) closeMenu();
  };
  const onKey = (/** @type {KeyboardEvent} */ e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); refocus(); return; }
    if (e.key === "Tab") { closeMenu(); refocus(); return; }
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.closest("input, textarea, select") && e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const buttons = /** @type {HTMLElement[]} */ ([...menu.querySelectorAll("button, input")]);
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
  /** @type {any} */ (menu)._cleanup = () => {
    document.removeEventListener("pointerdown", onDown, true);
    if (anchor.isConnected) anchor.setAttribute("aria-expanded", "false");
  };
  /** @type {HTMLElement|null} */ (menu.querySelector("[data-autofocus]") ?? menu.querySelector("button:not([aria-disabled='true'])") ?? menu.querySelector("button"))?.focus();
  return menu;
}

export function closeMenu() {
  if (!openMenuEl) return;
  /** @type {any} */ (openMenuEl)._cleanup?.();
  openMenuEl.remove();
  openMenuEl = null;
}

/** @returns {HTMLElement|null} */
export function currentMenu() {
  return openMenuEl;
}

// ---------------------------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------------------------

/** @type {HTMLElement|null} */
let toastHost = null;

/** Creates the (empty) toast live region up front so later toasts are announced reliably. */
export function ensureToastHost() {
  if (!toastHost || !toastHost.isConnected) {
    toastHost = /** @type {HTMLElement|null} */ (document.body.querySelector(".toasts")) ?? el("div", { class: "toasts", role: "status", "aria-live": "polite" });
    if (!toastHost.isConnected) document.body.appendChild(toastHost);
  }
  return toastHost;
}

/**
 * @param {string} message
 * @param {{timeout?: number, action?: {label: string, onClick: () => void, className?: string}}} [opts]
 *   timeout 0 = stays until dismissed
 */
export function showToast(message, { timeout = 8000, action } = {}) {
  const host = ensureToastHost();
  for (const existing of host.querySelectorAll(".toast")) {
    if (existing.querySelector(".msg")?.textContent === message) existing.remove();
  }
  const toast = el("div", { class: "toast" },
    el("span", { class: "msg" }, message),
    action ? el("button", {
      type: "button", class: "btn small toast-action " + (action.className ?? ""),
      onclick: () => { toast.remove(); action.onClick(); },
    }, action.label) : null,
    el("button", {
      type: "button", class: "btn icon-only", "aria-label": "Dismiss", onclick: () => toast.remove(),
    }, svgIcon("close")),
  );
  host.appendChild(toast);
  if (timeout) setTimeout(() => toast.remove(), timeout);
  return toast;
}

/** A one-line description of an error result for a toast. @param {any} result */
export function errorMessage(result) {
  const code = result?.error;
  switch (code) {
    case "no_model": return "No model is connected. Add a model to this Wave in its Connections panel.";
    case "busy": return "The agent is busy: one run at a time, three waiting. Try again in a moment.";
    case "limit": return "Limit reached: " + (result?.message || "this Wave has used its runs for the hour.");
    case "locked": return "That is a decision: it cannot be edited or deleted.";
    case "blip_full": return "That blip is full (16,000 characters). Reply instead.";
    case "unknown_blip": return "That blip no longer exists.";
    case "unknown_run": return "That run no longer exists.";
    case "invalid_update": return "The change could not be applied.";
    case "invalid_argument": return result?.message || "The request was not valid.";
    default: return result?.message || (typeof code === "string" ? code : "Something went wrong.");
  }
}

/** @param {number} ms */
export const when = (ms) => formatTime(ms);
