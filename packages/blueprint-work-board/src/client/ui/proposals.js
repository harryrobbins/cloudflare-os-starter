// @ts-check
// The Proposals tray: changes the agent (or Jev triage) proposed, each shown as a readable diff
// ("WRK-12 priority High → Urgent") with its reason. A person picks some or all and applies them
// through the normal write path (attributed to them). Stale changes offer a one-click refresh.
// Fully keyboard operable (native checkboxes and buttons in a dialog) with announced outcomes.

import { h, relativeTime, setChildren } from "./dom.js";
import { icon } from "./icons.js";

/**
 * @typedef {import("../store/apply.js").ChangeState} ChangeState
 * @typedef {{
 *   proposals: () => any[], recent: () => any[], now: () => number, canWrite: () => boolean, signedIn: () => boolean,
 *   state: (p: any, c: any) => { state: ChangeState, text: string, selectable: boolean },
 *   apply: (p: any, ns: number[]) => Promise<void>|void, refresh: (p: any) => Promise<void>, withdraw: (p: any) => Promise<void>,
 *   history: () => Promise<any[]>, openItem: (key: string) => void, announce: (text: string, opts?: any) => void,
 * }} TrayController
 */

/** @type {Record<string, string>} */
const STATE_CLASS = { ready: "ready", stale: "warn", noop: "muted", invalid: "bad", sent: "pending", pending: "pending", applied: "ok", conflict: "bad", rejected: "bad" };

/** @param {any} p */
function proposer(p) {
  const by = p.proposed_by ?? {};
  return by.kind === "jev" ? `Jev, for ${by.name}` : by.name ?? "the agent";
}

/** @param {ChangeState} s */
function stateIcon(s) {
  const name = s === "applied" ? "check" : s === "stale" ? "refresh" : s === "invalid" || s === "conflict" || s === "rejected" ? "warning" : s === "sent" || s === "pending" ? "inbox" : null;
  return name ? icon(name, { size: 13 }) : null;
}

/**
 * @param {{ layers: ReturnType<typeof import("./overlay.js").createLayers>, controller: TrayController }} opts
 */
export function createProposalsTray({ layers, controller: c }) {
  /** @type {Map<string, Set<number>>} */
  const selected = new Map();
  /** @type {{ close: (r?: string) => void, el: HTMLElement }|null} */
  let dlg = null;
  const body = h("div", { class: "tray-body" });
  /** @type {any[]|null} */
  let history = null;
  let historyOpen = false;
  /** @type {Set<string>} */
  const busy = new Set();
  /** @type {string|null} */
  let lastKey = null;

  /** @param {any} p */
  function selection(p) {
    let set = selected.get(p.id);
    const selectable = p.changes.filter((/** @type {any} */ ch) => c.state(p, ch).selectable).map((/** @type {any} */ ch) => ch.n);
    if (!set) { set = new Set(selectable); selected.set(p.id, set); }
    for (const n of set) if (!selectable.includes(n)) set.delete(n);
    return set;
  }

  function render() {
    if (!dlg) return;
    const active = /** @type {HTMLElement|null} */ (body.ownerDocument.activeElement);
    const focusKey = active && body.contains(active) ? active.dataset?.focusKey ?? null : null;
    const list = c.proposals();
    const recent = c.recent();
    const canApply = c.canWrite();
    setChildren(body,
      !canApply ? h("p", { class: "banner info" }, c.signedIn() ? "This board is read-only for you: you can review proposals but not apply them." : "Sign in to the Workshop to apply proposals.") : null,
      list.length ? list.map((p) => proposal(p, canApply)) : h("div", { class: "tray-empty" }, icon("inbox", { size: 20 }),
        h("p", null, h("strong", null, "No proposals waiting.")),
        h("p", { class: "muted" }, "When the Workshop agent or Jev triage suggests changes, they appear here for you to review and apply.")),
      recent.length ? h("section", { class: "tray-recent", "aria-labelledby": "tray-recent-h" }, h("h3", { id: "tray-recent-h", class: "tray-sub" }, "Just applied from this board"),
        recent.map((p) => proposal(p, false))) : null,
      h("details", { class: "tray-history", open: historyOpen, ontoggle: (/** @type {Event} */ e) => { historyOpen = /** @type {HTMLDetailsElement} */ (e.currentTarget).open; if (historyOpen && !history) void loadHistory(); } },
        h("summary", { "data-focus-key": "history" }, "Recently applied or withdrawn"),
        history === null ? h("p", { class: "muted" }, "Loading…") : history.length ? h("ul", { class: "tray-history-list" }, history.map((p) => h("li", null,
          h("strong", null, p.title), " · ", p.status === "withdrawn" ? "withdrawn" : p.status === "applied" ? `applied${p.applied_by ? ` by ${p.applied_by.name}` : ""}` : "partly applied",
          h("span", { class: "muted" }, ` · ${relativeTime(Date.parse(p.updated_at), c.now())}`)))) : h("p", { class: "muted" }, "Nothing yet.")));
    const doc = body.ownerDocument;
    const restored = focusKey ? /** @type {HTMLElement|null} */ (body.querySelector(`[data-focus-key="${focusKey}"]:not(:disabled)`)) : null;
    if (restored) { restored.focus(); lastKey = focusKey; return; }
    // A modal never loses focus to the page: back to the last control, else the first one.
    if (!doc.activeElement || doc.activeElement === doc.body || !dlg?.el.contains(doc.activeElement)) {
      const back = (lastKey ? /** @type {HTMLElement|null} */ (body.querySelector(`[data-focus-key="${lastKey}"]:not(:disabled)`)) : null)
        ?? /** @type {HTMLElement|null} */ (body.querySelector("input:not(:disabled), button:not(:disabled), summary"));
      back?.focus();
    }
    if (focusKey) lastKey = focusKey;
  }

  async function loadHistory() {
    try { history = (await c.history()).filter((p) => p.status !== "open").slice(0, 20); } catch { history = []; }
    render();
  }

  /** @param {any} p @param {boolean} canApply */
  function proposal(p, canApply) {
    const set = selection(p);
    const states = p.changes.map((/** @type {any} */ ch) => ({ ch, st: c.state(p, ch) }));
    const stale = states.some((/** @type {any} */ x) => x.st.state === "stale" || x.st.state === "conflict");
    const selectable = states.filter((/** @type {any} */ x) => x.st.selectable);
    const hid = `prop-${p.id}`;
    const isBusy = busy.has(p.id);
    const toggleAll = (/** @type {boolean} */ on) => { selected.set(p.id, new Set(on ? selectable.map((/** @type {any} */ x) => x.ch.n) : [])); render(); c.announce(on ? `All ${selectable.length} changes selected.` : "No changes selected."); };
    return h("section", { class: "proposal", "aria-labelledby": `${hid}-t`, "data-proposal": p.id },
      h("header", { class: "proposal-head" },
        h("h3", { id: `${hid}-t` }, p.title),
        p.status === "partial" ? h("span", { class: "tag" }, "partly applied") : null,
        h("p", { class: "muted proposal-meta" }, `Proposed by ${proposer(p)} · ${relativeTime(Date.parse(p.created_at), c.now())} · ${p.changes.length} ${p.changes.length === 1 ? "change" : "changes"}`)),
      p.reason ? h("p", { class: "proposal-reason" }, p.reason) : null,
      canApply && selectable.length > 1 ? h("div", { class: "row tight" },
        h("button", { type: "button", class: "btn ghost sm", "data-focus-key": `${p.id}:all`, onclick: () => toggleAll(true) }, "Select all"),
        h("button", { type: "button", class: "btn ghost sm", "data-focus-key": `${p.id}:none`, onclick: () => toggleAll(false) }, "Select none")) : null,
      h("ul", { class: "proposal-changes", "aria-label": `Changes in ${p.title}` }, states.map((/** @type {any} */ { ch, st }) => {
        const id = `${hid}-c${ch.n}`;
        const box = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", id, "data-focus-key": `${p.id}:${ch.n}`, checked: set.has(ch.n), disabled: !canApply || !st.selectable || isBusy, "aria-describedby": `${id}-s` }));
        box.addEventListener("change", () => { if (box.checked) set.add(ch.n); else set.delete(ch.n); render(); });
        return h("li", { class: `proposal-change ${STATE_CLASS[st.state] ?? ""}` },
          h("div", { class: "change-line" },
            h("label", { class: "check-label change-check", for: id }, box, h("span", { class: "change-text" }, ch.text)),
            h("span", { id: `${id}-s`, class: `change-state ${STATE_CLASS[st.state] ?? ""}` }, stateIcon(st.state), st.text)),
          ch.diff?.length > 1 ? h("ul", { class: "change-diff" }, ch.diff.map((/** @type {any} */ d) => h("li", null, h("span", { class: "muted" }, `${d.label}: `), d.from, h("span", { "aria-hidden": "true" }, " → "), h("span", { class: "sr-only" }, " to "), d.to))) : null,
          ch.reason ? h("p", { class: "change-reason muted" }, ch.reason) : null,
          ch.key && ch.command !== "work.create" ? h("button", { type: "button", class: "link sm", "data-focus-key": `${p.id}:${ch.n}:open`, onclick: () => c.openItem(ch.key) }, `Open ${ch.key}`) : null);
      })),
      h("div", { class: "row end proposal-actions" },
        stale && canApply ? h("button", { type: "button", class: "btn", "data-focus-key": `${p.id}:refresh`, disabled: isBusy, onclick: () => run(p, () => c.refresh(p), "Refreshed: changes now apply to the items as they are.") }, icon("refresh", { size: 14 }), "Refresh stale changes") : null,
        canApply ? h("button", { type: "button", class: "btn ghost", "data-focus-key": `${p.id}:withdraw`, disabled: isBusy, onclick: () => run(p, () => c.withdraw(p), `Withdrew “${p.title}”.`) }, "Withdraw") : null,
        canApply ? h("button", { type: "button", class: "btn primary", "data-focus-key": `${p.id}:apply`, disabled: isBusy || !set.size,
          onclick: () => run(p, async () => { await c.apply(p, [...set]); }, null) }, set.size ? `Apply ${set.size} selected` : "Apply selected") : null));
  }

  /** @param {any} p @param {() => Promise<void>|void} fn @param {string|null} done */
  async function run(p, fn, done) {
    const active = /** @type {HTMLElement|null} */ (body.ownerDocument.activeElement);
    const key = active && body.contains(active) ? active.dataset?.focusKey ?? null : null;
    busy.add(p.id);
    render();
    try { await fn(); if (done) c.announce(done); } catch (err) { c.announce(`Could not update the proposal: ${String(/** @type {any} */ (err)?.message ?? err).replace(/^[a-z_]+:\s*/, "")}`, { assertive: true }); }
    busy.delete(p.id);
    selected.delete(p.id);
    render();
    // Keep keyboard focus in the tray: on the same control, else this proposal, else the first control.
    const again = key ? /** @type {HTMLElement|null} */ (body.querySelector(`[data-focus-key="${key}"]:not(:disabled)`)) : null;
    const fallback = /** @type {HTMLElement|null} */ (body.querySelector(`[data-proposal="${p.id}"] button:not(:disabled), [data-proposal="${p.id}"] h3`) ?? body.querySelector("input:not(:disabled), button:not(:disabled), summary"));
    const target = again ?? fallback;
    if (target && target.tagName === "H3") target.setAttribute("tabindex", "-1");
    target?.focus();
  }

  return {
    get open() { return Boolean(dlg); },
    /** Opens the tray (focus on the given proposal, else the first). @param {string} [focusId] */
    show(focusId) {
      if (dlg) { render(); return; }
      history = null;
      dlg = layers.openDialog({
        title: "Proposals", size: "lg", className: "tray",
        description: "Changes suggested by the Workshop agent or Jev. Nothing changes until you apply it; applied changes are attributed to you and go through approval like any other change.",
        content: () => body, onClose: () => { dlg = null; },
        initialFocus: () => null,
      });
      render();
      const target = /** @type {HTMLElement|null} */ (body.querySelector(`[data-proposal="${focusId ?? ""}"] input:not(:disabled)`)
        ?? body.querySelector(".proposal input:not(:disabled)") ?? body.querySelector(".proposal button, summary"));
      target?.focus();
    },
    render,
    close() { dlg?.close("close"); },
  };
}
