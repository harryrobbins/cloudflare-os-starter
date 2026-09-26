// @ts-check
// Layers: modal dialogs and anchored popovers with a focus trap, Escape to close (top layer
// only), and focus returned to the invoker on close. Plus the live regions.

import { h, focus } from "./dom.js";

let nextId = 1;

/** @param {HTMLElement} container */
function tabbables(container) {
  return /** @type {HTMLElement[]} */ ([...container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')])
    .filter((el) => !(/** @type {any} */ (el).disabled) && !el.closest("[hidden]") && el.getAttribute("aria-hidden") !== "true");
}

/**
 * @param {HTMLElement} root the app root (layers are appended here, inside the app's theme)
 */
export function createLayers(root) {
  /** @type {{ el: HTMLElement, close: (reason?: string) => void, returnTo: HTMLElement|null }[]} */
  const stack = [];
  const host = h("div", { class: "layers" });
  root.append(host);

  /** @param {HTMLElement} el @param {() => void} onEscape */
  function trap(el, onEscape) {
    el.addEventListener("keydown", (event) => {
      const e = /** @type {KeyboardEvent} */ (event);
      if (e.key === "Escape") {
        if (stack[stack.length - 1]?.el !== el) return;
        e.preventDefault();
        e.stopPropagation();
        onEscape();
      } else if (e.key === "Tab") {
        const list = tabbables(el);
        if (!list.length) { e.preventDefault(); return; }
        const first = list[0], last = list[list.length - 1];
        const active = /** @type {HTMLElement|null} */ (el.ownerDocument.activeElement);
        if (e.shiftKey && (active === first || !el.contains(active))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
      }
    });
  }

  /**
   * @param {{ title: string, content: (close: (reason?: string) => void) => (Node|string)[]|Node, onClose?: (reason: string) => void,
   *   size?: "sm"|"md"|"lg", initialFocus?: () => HTMLElement|null, className?: string, description?: string }} opts
   */
  function openDialog(opts) {
    const id = `dlg-${nextId++}`;
    const returnTo = /** @type {HTMLElement|null} */ (root.ownerDocument.activeElement);
    let closed = false;
    const close = (reason = "close") => {
      if (closed) return;
      closed = true;
      const i = stack.findIndex((l) => l.el === backdrop);
      if (i !== -1) stack.splice(i, 1);
      backdrop.remove();
      opts.onClose?.(reason);
      if (returnTo?.isConnected) focus(returnTo, { scroll: false });
    };
    const body = h("div", { class: "dialog-body" });
    const content = opts.content(close);
    body.append(...(Array.isArray(content) ? content : [content]));
    const dialog = h("div", { class: `dialog ${opts.size ?? "md"} ${opts.className ?? ""}`, role: "dialog", "aria-modal": "true", "aria-labelledby": `${id}-t`, "aria-describedby": opts.description ? `${id}-d` : null },
      h("div", { class: "dialog-head" },
        h("h2", { id: `${id}-t`, class: "dialog-title" }, opts.title),
        h("button", { type: "button", class: "icon-btn", "aria-label": "Close", title: "Close (Esc)", onclick: () => close("cancel") }, closeGlyph())),
      opts.description ? h("p", { id: `${id}-d`, class: "dialog-desc" }, opts.description) : null,
      body);
    const backdrop = h("div", { class: "backdrop", onmousedown: (/** @type {MouseEvent} */ e) => { if (e.target === backdrop) close("cancel"); } }, dialog);
    trap(dialog, () => close("cancel"));
    host.append(backdrop);
    stack.push({ el: backdrop, close, returnTo });
    const first = opts.initialFocus?.() ?? tabbables(body)[0] ?? tabbables(dialog)[0];
    focus(first, { scroll: false });
    return { close, el: dialog };
  }

  /**
   * An anchored, non-modal popover that traps focus while open and closes on outside click.
   * @param {{ anchor: HTMLElement|{ x: number, y: number }, label: string, content: (close: (reason?: string) => void) => Node,
   *   onClose?: (reason: string) => void, className?: string, initialFocus?: () => HTMLElement|null, returnTo?: HTMLElement|null }} opts
   */
  function openPopover(opts) {
    const returnTo = opts.returnTo ?? /** @type {HTMLElement|null} */ (root.ownerDocument.activeElement);
    let closed = false;
    const close = (reason = "close") => {
      if (closed) return;
      closed = true;
      const i = stack.findIndex((l) => l.el === pop);
      if (i !== -1) stack.splice(i, 1);
      pop.remove();
      root.ownerDocument.removeEventListener("mousedown", outside, true);
      opts.onClose?.(reason);
      if (returnTo?.isConnected && (reason !== "outside")) focus(returnTo, { scroll: false });
    };
    const pop = h("div", { class: `popover ${opts.className ?? ""}`, role: "dialog", "aria-label": opts.label });
    pop.append(opts.content(close));
    trap(pop, () => close("cancel"));
    const outside = (/** @type {Event} */ e) => { if (!pop.contains(/** @type {Node} */ (e.target))) close("outside"); };
    root.ownerDocument.addEventListener("mousedown", outside, true);
    pop.addEventListener("focusout", (e) => {
      const next = /** @type {Node|null} */ (/** @type {FocusEvent} */ (e).relatedTarget);
      if (next && !pop.contains(next) && !host.contains(next)) close("blur");
    });
    host.append(pop);
    stack.push({ el: pop, close, returnTo });
    place(pop, opts.anchor);
    focus(opts.initialFocus?.() ?? tabbables(pop)[0], { scroll: false });
    return { close, el: pop };
  }

  /** @param {HTMLElement} pop @param {HTMLElement|{ x: number, y: number }} anchor */
  function place(pop, anchor) {
    const win = root.ownerDocument.defaultView;
    const vw = win?.innerWidth ?? 1024, vh = win?.innerHeight ?? 768;
    const r = "getBoundingClientRect" in anchor ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
    const pr = pop.getBoundingClientRect();
    const w = pr.width || 280, hgt = pr.height || 320;
    if (vw < 520) { pop.classList.add("sheet"); return; }
    let left = Math.min(Math.max(8, r.left), vw - w - 8);
    let top = r.bottom + 4;
    if (top + hgt > vh - 8 && r.top - hgt - 4 > 8) top = r.top - hgt - 4;
    top = Math.max(8, Math.min(top, vh - hgt - 8));
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  }

  return {
    openDialog, openPopover,
    get open() { return stack.length > 0; },
    closeTop() { stack[stack.length - 1]?.close("cancel"); },
    closeAll() { for (const l of [...stack].reverse()) l.close("cancel"); },
  };
}

function closeGlyph() {
  const span = h("span", { class: "x", "aria-hidden": "true" }, "×");
  return span;
}

/**
 * Polite and assertive live regions. Repeated identical messages are still announced.
 * @param {HTMLElement} root
 */
export function createLive(root) {
  const polite = h("div", { class: "sr-only", "aria-live": "polite", "aria-atomic": "true", "data-live": "polite" });
  const assertive = h("div", { class: "sr-only", "aria-live": "assertive", "aria-atomic": "true", "data-live": "assertive" });
  root.append(polite, assertive);
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  return {
    /** @param {string} text @param {{ assertive?: boolean }} [opts] */
    announce(text, opts = {}) {
      const region = opts.assertive ? assertive : polite;
      region.textContent = "";
      if (timer) clearTimeout(timer);
      // A tick between clear and set makes screen readers repeat identical text.
      timer = setTimeout(() => { region.textContent = text; }, 30);
    },
    get last() { return polite.textContent || ""; },
    polite, assertive,
  };
}
