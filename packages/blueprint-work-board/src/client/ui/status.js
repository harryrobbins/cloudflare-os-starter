// @ts-check
// The status centre: one compact button (bottom right) summarising your changes ("2 awaiting
// approval"), expanding to a panel that lists them, groups bulk edits, explains conflicts and
// refusals, and offers Retry, Undo and Dismiss. Plus toasts for the moment-to-moment feedback.

import { h, reconcile, relativeTime, setChildren } from "./dom.js";
import { icon } from "./icons.js";

/**
 * @typedef {import("../store/store.js").Change} Change
 * @typedef {{ changes: () => Change[], now: () => number, retry: (c: Change) => void, dismiss: (c: Change) => void,
 *   undo: (c: Change) => void, open: (c: Change) => void }} StatusController
 */

const TEXT = { saving: "Sending", pending: "Awaiting approval", applied: "Saved", conflict: "Conflict", rejected: "Not saved" };

/** @param {{ controller: StatusController }} opts */
export function createStatusCentre({ controller: c }) {
  const button = h("button", { type: "button", class: "status-btn", "aria-expanded": "false", "aria-controls": "wb-status-panel" });
  const list = h("ul", { class: "status-list" });
  const panel = h("section", { id: "wb-status-panel", class: "status-panel", "aria-labelledby": "wb-status-h", hidden: true },
    h("div", { class: "status-head" }, h("h2", { id: "wb-status-h" }, "Your changes"), h("span", { class: "grow" }),
      h("button", { type: "button", class: "btn ghost sm", onclick: () => { for (const ch of c.changes().filter((x) => x.status === "conflict" || x.status === "rejected" || x.settledAt)) c.dismiss(ch); } }, "Clear finished"),
      h("button", { type: "button", class: "icon-btn sm", "aria-label": "Close", onclick: () => toggle(false) }, h("span", { class: "x", "aria-hidden": "true" }, "×"))),
    h("p", { class: "hint" }, "Changes are applied by Records after approval in the Workshop. Cards move only once a change is saved."),
    list);
  const el = h("div", { class: "status-centre" }, panel, button);
  let open = false;

  /** @param {boolean} next */
  function toggle(next) {
    open = next;
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (open) render();
    (open ? /** @type {HTMLElement|null} */ (panel.querySelector("button")) : button)?.focus();
  }
  button.addEventListener("click", () => toggle(!open));
  panel.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); toggle(false); } });

  function render() {
    const changes = c.changes();
    const counts = { saving: 0, pending: 0, applied: 0, conflict: 0, rejected: 0 };
    for (const ch of changes) counts[ch.status]++;
    const failed = counts.conflict + counts.rejected;
    const waiting = counts.pending + counts.saving;
    el.hidden = !changes.length && !open;
    el.dataset.state = failed ? "bad" : waiting ? "pending" : "ok";
    const summary = failed ? `${failed} not saved` : counts.pending ? `${counts.pending} awaiting approval` : counts.saving ? `Sending ${counts.saving}…` : `${counts.applied} saved`;
    setChildren(button, h("span", { class: `status-dot ${el.dataset.state}`, "aria-hidden": "true" }), h("span", null, summary),
      waiting && failed ? h("span", { class: "muted" }, ` · ${waiting} waiting`) : null);
    button.setAttribute("aria-label", `Your changes: ${summary}${waiting && failed ? `, ${waiting} waiting` : ""}. ${open ? "Hide" : "Show"} details.`);
    if (!open) return;
    // Group bulk edits.
    /** @type {{ key: string, group: string|null, items: Change[] }[]} */
    const rows = [];
    for (const ch of [...changes].reverse()) {
      const existing = ch.group ? rows.find((r) => r.group === ch.group) : null;
      if (existing) existing.items.push(ch); else rows.push({ key: ch.group ?? `c${ch.id}`, group: ch.group, items: [ch] });
    }
    reconcile(list, rows, {
      key: (r) => r.key,
      create: () => h("li", { class: "status-item" }),
      update: (node, r) => {
        const sig = r.items.map((x) => `${x.id}:${x.status}:${x.settledAt ? 1 : 0}`).join(",") + `|${Math.floor(c.now() / 30000)}`;
        const li = /** @type {HTMLElement} */ (node);
        if (li.dataset.sig === sig) return;
        li.dataset.sig = sig;
        setChildren(li, r.group ? groupRow(r.items) : changeRow(r.items[0]));
      },
    });
  }

  /** @param {Change} ch */
  function changeRow(ch) {
    const bad = ch.status === "conflict" || ch.status === "rejected";
    return h("div", { class: `change ${ch.status}` },
      h("span", { class: `status-dot ${bad ? "bad" : ch.status === "applied" ? "ok" : "pending"}`, "aria-hidden": "true" }),
      h("div", { class: "change-body" },
        h("button", { type: "button", class: "link change-label", onclick: () => c.open(ch) }, ch.label),
        h("div", { class: "change-status" }, h("strong", null, TEXT[ch.status]), ch.actionId && ch.status === "pending" ? ` · action #${ch.actionId}` : "", ` · ${relativeTime(ch.createdAt, c.now())}`),
        bad && ch.message ? h("div", { class: "change-message" }, ch.message) : null),
      h("div", { class: "change-actions" },
        bad ? h("button", { type: "button", class: "btn sm", onclick: () => c.retry(ch) }, "Retry") : null,
        ch.undo && ch.status === "applied" ? h("button", { type: "button", class: "btn ghost sm", onclick: () => c.undo(ch) }, icon("undo", { size: 14 }), "Undo") : null,
        bad || ch.settledAt ? h("button", { type: "button", class: "icon-btn sm", "aria-label": `Dismiss ${ch.label}`, onclick: () => c.dismiss(ch) }, h("span", { class: "x", "aria-hidden": "true" }, "×")) : null));
  }

  /** @param {Change[]} items */
  function groupRow(items) {
    const n = (/** @type {Change["status"]} */ s) => items.filter((x) => x.status === s).length;
    const failed = items.filter((x) => x.status === "conflict" || x.status === "rejected");
    const label = items[0].label.replace(/ · [^·]+$/, "");
    return h("div", { class: "change group" },
      h("span", { class: `status-dot ${failed.length ? "bad" : n("pending") || n("saving") ? "pending" : "ok"}`, "aria-hidden": "true" }),
      h("div", { class: "change-body" },
        h("div", { class: "change-label" }, `${label} (${items.length} items)`),
        h("div", { class: "change-status" }, [n("applied") && `${n("applied")} saved`, n("pending") && `${n("pending")} awaiting approval`, n("saving") && `${n("saving")} sending`, failed.length && `${failed.length} not saved`].filter(Boolean).join(" · ")),
        failed.length ? h("ul", { class: "failures" }, failed.map((f) => h("li", null, h("strong", null, f.label.split(" · ").pop()), `: ${f.message}`,
          h("button", { type: "button", class: "btn sm", onclick: () => c.retry(f) }, "Retry")))) : null));
  }

  return { el, render, toggle, get open() { return open; } };
}

/** Toasts: short, dismissible, paused on hover/focus. Announcements go through the live region. */
export function createToasts() {
  const el = h("div", { class: "toasts", role: "region", "aria-label": "Notifications" });
  /**
   * @param {string} text @param {{ action?: { label: string, run: () => void, disabled?: () => boolean }, ms?: number, tone?: string }} [opts]
   */
  function show(text, opts = {}) {
    const actionBtn = opts.action ? h("button", { type: "button", class: "btn sm", onclick: () => { opts.action?.run(); close(); } }, opts.action.label) : null;
    const toast = h("div", { class: `toast ${opts.tone ?? ""}` }, h("span", { class: "toast-text" }, text), actionBtn,
      h("button", { type: "button", class: "icon-btn sm", "aria-label": "Dismiss notification", onclick: () => close() }, h("span", { class: "x", "aria-hidden": "true" }, "×")));
    let remaining = opts.ms ?? 7000;
    let started = Date.now();
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = setTimeout(close, remaining);
    const pause = () => { if (timer) { clearTimeout(timer); timer = null; remaining -= Date.now() - started; } };
    const resume = () => { if (!timer) { started = Date.now(); timer = setTimeout(close, Math.max(1500, remaining)); } };
    toast.addEventListener("mouseenter", pause);
    toast.addEventListener("mouseleave", resume);
    toast.addEventListener("focusin", pause);
    toast.addEventListener("focusout", resume);
    function close() { if (timer) clearTimeout(timer); toast.classList.add("leaving"); setTimeout(() => toast.remove(), 160); }
    el.append(toast);
    while (el.children.length > 3) el.firstElementChild?.remove();
    const refresh = () => { if (actionBtn && opts.action?.disabled) /** @type {HTMLButtonElement} */ (actionBtn).disabled = opts.action.disabled(); };
    refresh();
    return { close, refresh, el: toast, setText: (/** @type {string} */ t) => { const s = toast.querySelector(".toast-text"); if (s) s.textContent = t; } };
  }
  return { el, show };
}
