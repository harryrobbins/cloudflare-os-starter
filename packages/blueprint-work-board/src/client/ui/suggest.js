// @ts-check
// Jev triage suggestions for one or more items: priority, state, labels and a possible duplicate,
// each with its probability as text ("94% likely"). Suggestions at 90% or more are pre-selected,
// 50–90% are shown unselected, less likely ones are hidden (and counted). Nothing is applied by
// itself: "Apply selected" stores a proposal (proposed by Jev, on the person's behalf) and applies
// it through the normal write path; "Save as proposal" leaves it in the Proposals tray.

import { h, setChildren } from "./dom.js";
import { icon } from "./icons.js";
import { suggestionsToChanges } from "../../shared/insights/triage.js";

/**
 * @typedef {import("../../shared/insights/triage.js").Suggestion} Suggestion
 * @param {{
 *   layers: ReturnType<typeof import("./overlay.js").createLayers>, title: string, count: number,
 *   triage: () => Promise<{ results: { key: string, title: string, suggestions: Suggestion[], hidden: number,
 *     current?: { state: string, priority: string, labels: string[], assignee: string|null } }[], limited: string[], message?: string }>,
 *   apply: (changes: any[], meta: { keys: string[] }) => Promise<void>, save: (changes: any[], meta: { keys: string[] }) => Promise<void>,
 *   announce: (text: string, opts?: any) => void,
 * }} opts
 */
export function openSuggestions(opts) {
  const body = h("div", { class: "suggest-body" });
  const status = h("p", { class: "suggest-status", role: "status" }, icon("sparkle", { size: 14 }), ` Asking Jev about ${opts.count === 1 ? "this item" : `${opts.count} items`}…`);
  const error = h("p", { class: "field-error", role: "alert" });
  /** @type {Map<string, Suggestion>} */
  const byId = new Map();
  /** @type {Set<string>} */
  const chosen = new Set();
  let busy = false;
  const applyBtn = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn primary", disabled: true, onclick: () => finish("apply") }, "Apply selected"));
  const saveBtn = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn", disabled: true, onclick: () => finish("save") }, "Save as proposal"));
  const dlg = opts.layers.openDialog({
    title: opts.title, size: "md", className: "suggest",
    description: "Jev gives calibrated probabilities. Suggestions of 90% or more are selected for you, 50–90% are shown unselected, and less likely ones are hidden. Nothing changes until you apply; the changes are attributed to you.",
    content: (close) => [status, body, error, h("div", { class: "row end suggest-foot" }, h("button", { type: "button", class: "btn ghost", onclick: () => close("cancel") }, "Cancel"), saveBtn, applyBtn)],
    initialFocus: () => status.nextElementSibling?.querySelector("input") ?? null,
  });

  function sync() {
    applyBtn.textContent = chosen.size ? `Apply ${chosen.size} selected` : "Apply selected";
    applyBtn.disabled = busy || !chosen.size;
    saveBtn.disabled = busy || !chosen.size;
  }

  opts.triage().then((out) => {
    const total = out.results.reduce((n, r) => n + r.suggestions.length, 0);
    const hidden = out.results.reduce((n, r) => n + r.hidden, 0);
    setChildren(status, icon("sparkle", { size: 14 }), ` ${total ? `${total} ${total === 1 ? "suggestion" : "suggestions"}` : "No confident suggestions"} for ${out.results.length} ${out.results.length === 1 ? "item" : "items"}${hidden ? `; ${hidden} less likely ${hidden === 1 ? "one" : "ones"} hidden` : ""}.${out.message ? ` ${out.message}` : ""}`);
    opts.announce(status.textContent ?? "");
    setChildren(body, out.results.map((r) => h("section", { class: "suggest-item", "aria-labelledby": `sg-${r.key}` },
      h("h3", { id: `sg-${r.key}` }, h("span", { class: "key" }, r.key), " ", r.title),
      r.current ? h("p", { class: "suggest-now" }, h("span", { class: "muted" }, "Now: "), [r.current.state, r.current.priority, r.current.labels.length ? `labels ${r.current.labels.join(", ")}` : "no labels", r.current.assignee ?? "unassigned"].join(" · ")) : null,
      r.suggestions.length ? h("ul", { class: "suggest-list" }, r.suggestions.map((s) => {
        byId.set(s.id, s);
        if (s.preselect) chosen.add(s.id);
        const id = `sg-${s.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
        const box = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", id, checked: s.preselect }));
        box.addEventListener("change", () => { if (box.checked) chosen.add(s.id); else chosen.delete(s.id); sync(); });
        return h("li", null, h("label", { class: "check-label", for: id }, box, h("span", null, s.text)),
          h("span", { class: `confidence ${s.probability >= 0.9 ? "high" : "mid"}` }, s.confidence, s.probability >= 0.9 ? " · pre-selected" : ""),
          s.candidate ? h("details", { class: "peek-dup" }, h("summary", null, `Peek ${s.candidate.key}`),
            h("p", null, h("strong", null, `${s.candidate.key} ${s.candidate.title}`), h("span", { class: "muted" }, ` · ${s.candidate.state}`)),
            s.candidate.description ? h("p", { class: "muted" }, `${s.candidate.description}${s.candidate.description.length >= 280 ? "…" : ""}`) : null) : null);
      })) : h("p", { class: "muted" }, "Nothing Jev is confident about for this item."),
      r.hidden ? h("p", { class: "hint" }, `${r.hidden} less likely ${r.hidden === 1 ? "suggestion" : "suggestions"} hidden.`) : null)));
    sync();
    /** @type {HTMLElement|null} */ (body.querySelector("input"))?.focus();
  }).catch((err) => {
    setChildren(status, icon("warning", { size: 14 }), " Jev could not make suggestions.");
    error.textContent = String(err?.message ?? err).replace(/^[a-z_]+:\s*/, "");
    opts.announce(`Jev could not make suggestions. ${error.textContent}`, { assertive: true });
  });

  /** @param {"apply"|"save"} how */
  async function finish(how) {
    const list = [...chosen].map((id) => byId.get(id)).filter(/** @returns {s is Suggestion} */ (s) => Boolean(s));
    if (!list.length) return;
    const changes = suggestionsToChanges(list);
    busy = true;
    sync();
    try {
      const meta = { keys: [...new Set(list.map((s) => s.key))] };
      if (how === "apply") await opts.apply(changes, meta); else await opts.save(changes, meta);
      dlg.close("done");
    } catch (err) {
      error.textContent = String(/** @type {any} */ (err)?.message ?? err).replace(/^[a-z_]+:\s*/, "");
      busy = false;
      sync();
    }
  }
  return dlg;
}
