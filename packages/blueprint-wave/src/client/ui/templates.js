// @ts-check
// The first-open template picker: when the Wave has no template and no blips, five cards
// (Blank, Decision, Design review, Retrospective, Incident review) sit where the conversation
// will be. Choosing one calls store.applyTemplate(id); whoever picks first wins and everyone
// else sees the result arrive.

import { TEMPLATES } from "../../shared/templates.js";
import { el, svgIcon } from "./dom.js";
import { showToast, errorMessage } from "./dialogs.js";

/** @typedef {import("../store-contract.js").ClientState} ClientState */

/**
 * Whether to show the picker: no template chosen yet and nothing (live) in the Wave. Pure.
 * @param {Pick<ClientState, "meta"|"blips">|null|undefined} state
 */
export function shouldOfferTemplates(state) {
  if (!state || !state.meta) return false;
  if (state.meta.template != null) return false;
  for (const blip of Object.values(state.blips ?? {})) if (blip && !blip.deleted) return false;
  return true;
}

/**
 * The picker element and its render. `onApplied` runs after a successful apply (focus the
 * conversation).
 * @param {{store: import("../store-contract.js").Store, announce: (m: string) => void, onApplied?: () => void}} app
 */
export function createTemplatePicker({ store, announce, onApplied }) {
  let busy = false;
  const buttons = TEMPLATES.map((t) => el("button", {
    type: "button", class: "template-btn", dataset: { template: t.id }, "aria-describedby": "tpl-desc-" + t.id,
    onclick: () => choose(t.id),
  },
  el("span", { class: "template-title" }, svgIcon(t.id === "blank" ? "plus" : "layout", 18), t.title),
  el("span", { class: "template-desc", id: "tpl-desc-" + t.id }, t.description),
  ));
  const note = el("p", { class: "muted templates-note" }, "Whoever chooses first sets the template for everyone; it only adds a brief and a few starter threads, all of which can be edited or deleted.");
  const root = el("section", { class: "templates", "aria-label": "Start this Wave", hidden: true },
    el("h2", null, "Start this Wave"),
    el("p", null, "Pick a template. Each creates a pinned brief and a few threads to fill in."),
    el("div", { class: "template-grid" }, buttons),
    note,
  );

  /** @param {string} id */
  async function choose(id) {
    if (busy) return;
    busy = true;
    for (const b of buttons) b.disabled = true;
    note.textContent = "Setting up…";
    try {
      const result = await store.applyTemplate(id);
      if (result && "error" in result) {
        showToast(errorMessage(result));
      } else if (result && result.status === "unchanged") {
        showToast("Someone else chose a template first; showing theirs.");
      } else {
        announce("Template applied");
        onApplied?.();
      }
    } catch (err) {
      showToast("Couldn't apply the template: " + (/** @type {any} */ (err)?.message ?? err));
    } finally {
      busy = false;
      for (const b of buttons) b.disabled = false;
      note.textContent = "Whoever chooses first sets the template for everyone; it only adds a brief and a few starter threads, all of which can be edited or deleted.";
    }
  }

  return {
    el: root,
    /** @param {ClientState} state @returns {boolean} whether the picker is showing */
    render(state) {
      const show = shouldOfferTemplates(state) && state.connection !== "connecting";
      if (root.hidden === !show) return show;
      root.hidden = !show;
      return show;
    },
    focusFirst() { buttons[0]?.focus(); },
  };
}
