// @ts-check
// The Design panel: the current view (name, default, duplicate, delete, own layout, layout kind),
// its ordered decoration rules with a picker-based rule editor, filter / showcase / focus, and the
// map's element types, connection types and custom fields. The JSON contract and validation live
// in src/shared/rules.js and src/shared/protocol.js; editor state, summaries and usage counts in
// ./design-logic.js.
//
// Re-rendering: each section re-renders when what it shows changes (compared by object identity,
// so a peer's drag does not rebuild the panel). A section holding a focused text entry (input,
// select, textarea) waits until focus leaves it; other controls keep focus through a rebuild by
// their data-fkey.

import { h, clear, icon, inlineEditable, debounce } from "./dom.js";
import { modal, showToast } from "./dialogs.js";
import { ensureStyle } from "./css.js";
import { APPLIES_TO, FIELD_KINDS, LAYOUT_KINDS, LIMITS, PALETTE, SHAPES, cleanColor, normalizeField, normalizeType } from "../../shared/protocol.js";
import { SCALES, SHARED_LAYOUT } from "../../shared/rules.js";
import * as L from "./design-logic.js";

/** @typedef {import("./design-logic.js").SelectorState} SelectorState */
/** @typedef {import("./design-logic.js").RuleState} RuleState */
/** @typedef {"element"|"connection"} Target */

const PALETTE_NAMES = ["Blue", "Orange", "Red", "Teal", "Green", "Yellow", "Purple", "Pink", "Brown", "Grey"];
const KIND_LABELS = { text: "Text", longtext: "Long text", number: "Number", date: "Date", daterange: "Date range", bool: "Yes / no", choice: "Choice", multichoice: "Multiple choice", url: "Link" };
const APPLIES_LABELS = { element: "Elements", connection: "Connections", both: "Both" };
const LAYOUT_LABELS = { force: "Force", circle: "Circle", grid: "Grid", manual: "Manual (no automatic layout)" };

const DESIGN_CSS = String.raw`
.nm-design { display: flex; flex-direction: column; gap: 10px; }
.nm-design-sec { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.nm-design-sec > summary {
  list-style: none; cursor: pointer; padding: 8px 10px; display: flex; align-items: center; gap: 6px; border-radius: var(--radius);
  font-size: 12px; font-weight: 650; text-transform: uppercase; letter-spacing: .04em; color: var(--text-3);
}
.nm-design-sec > summary::-webkit-details-marker { display: none; }
.nm-design-sec > summary::before { content: "▸"; font-size: 11px; transition: transform .12s; }
.nm-design-sec[open] > summary::before { transform: rotate(90deg); }
.nm-design-sec > summary .count { margin-left: auto; font-weight: 500; text-transform: none; letter-spacing: 0; }
.nm-design-body { padding: 2px 10px 10px; display: flex; flex-direction: column; gap: 8px; }
.nm-design h4 { font-size: 13px; font-weight: 600; color: var(--text-2); margin: 4px 0 0; display: flex; align-items: center; gap: 6px; }
.nm-design .hint { font-size: 12px; color: var(--text-3); margin: 0; }
.nm-design .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.nm-design .row > .grow { flex: 1; min-width: 0; }
.nm-design .check { display: inline-flex; gap: 6px; align-items: center; color: var(--text); font-size: 13px; }
.nm-design .error-text { font-size: 13px; }
.nm-design .error-text:empty { display: none; }
.nm-design .chip.on { background: var(--accent-soft); color: var(--accent-hover); border-color: transparent; }
.nm-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.nm-rule {
  border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 4px 4px 8px;
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 2px 6px; align-items: start;
}
.nm-rule[data-off] .nm-rule-text { opacity: .55; }
.nm-rule input[type="checkbox"] { margin-top: 3px; }
.nm-rule-text { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.nm-rule-text strong { font-weight: 600; font-size: 13px; overflow-wrap: anywhere; }
.nm-rule-text span { font-size: 12px; color: var(--text-3); overflow-wrap: anywhere; display: flex; gap: 6px; align-items: center; }
.nm-rule-actions { display: grid; grid-template-columns: repeat(2, auto); }
.nm-rule-actions .btn { min-height: 26px; min-width: 26px; padding: 3px; }
.nm-item { display: flex; gap: 6px; align-items: center; min-height: 32px; }
.nm-item .inline-edit { flex: 1; min-width: 0; }
.nm-item .inline-edit-display {
  border: 0; background: transparent; padding: 3px 6px; border-radius: var(--radius-sm); text-align: left; width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text);
}
.nm-item .inline-edit-display:hover { background: rgba(127,127,127,.14); }
.nm-item .inline-edit-input { width: 100%; }
.nm-item .uses { font-size: 12px; color: var(--text-3); white-space: nowrap; }
.nm-item select { padding: 3px 4px; font-size: 12px; }
.nm-swatch-btn { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--border-strong); padding: 0; flex: none; }
.nm-field { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 4px 6px 6px; display: flex; flex-direction: column; gap: 4px; }
.nm-field .row select { font-size: 12px; padding: 3px 4px; }
.nm-choices { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.nm-choices .chip, .nm-roots .chip { padding-right: 2px; }
.nm-choices .chip .btn, .nm-roots .chip .btn { min-height: 18px; min-width: 18px; padding: 0; }
.nm-choices input { width: 9em; padding: 2px 6px; font-size: 12px; }
.nm-conds { display: flex; flex-direction: column; gap: 6px; }
.nm-cond { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr) auto; gap: 4px; align-items: center; padding-left: 8px; border-left: 2px solid var(--border); }
.nm-cond > .value { grid-column: 1 / 3; min-width: 0; display: flex; }
.nm-cond > .value > input, .nm-cond > .value > select { width: 100%; }
.nm-cond > .value.checks { flex-wrap: wrap; gap: 4px; }
.nm-cond > .value.checks label { display: inline-flex; gap: 4px; align-items: center; font-size: 12px; color: var(--text); border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px 1px 4px; }
.nm-cond select, .nm-cond input, .nm-conds > .row select { font-size: 13px; padding: 4px 6px; }
.nm-deco { display: grid; grid-template-columns: 6.5em minmax(0, 1fr); gap: 8px 10px; align-items: center; }
.nm-deco > .lbl { font-size: 13px; color: var(--text-2); }
.nm-deco > .ctl { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-width: 0; }
.nm-deco input[type="number"] { width: 5.5em; }
.nm-deco input[type="range"] { flex: 1; min-width: 100px; }
.nm-sw { display: inline-flex; gap: 3px; flex-wrap: wrap; align-items: center; }
.nm-sw .swatch { width: 20px; height: 20px; border-width: 2px; }
.nm-sw input[type="text"], .modal .nm-sw input[type="text"] { width: 6.5em; font-family: ui-monospace, monospace; font-size: 12px; padding: 3px 6px; }
.nm-sw input[aria-invalid="true"] { border-color: var(--danger); }
.nm-seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
.nm-seg .btn { border-radius: 0; }
.modal.nm-rule-editor { width: min(680px, 100%); }
.nm-rule-editor h3 { font-size: 13px; font-weight: 650; color: var(--text-2); margin: 0; }
.nm-rule-editor .preview { font-size: 13px; color: var(--text-2); margin-left: auto; }
.nm-rule-editor .box { border: 1px solid var(--border); border-radius: var(--radius); padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.nm-roots { display: flex; flex-wrap: wrap; gap: 4px; }
@media (max-width: 560px) { .nm-deco { grid-template-columns: 1fr; gap: 4px; } }
`;

/**
 * @param {HTMLElement} host
 * @param {any} app
 */
export function mountDesign(host, app) {
  ensureStyle("design", DESIGN_CSS);
  const store = app.store;

  /** @typedef {{el: HTMLDetailsElement, body: HTMLElement, count: HTMLElement, sig: any[]|null, pending: boolean, focusKey: string|null}} Section */
  /** @param {string} title @param {string} key @param {boolean} open @returns {Section} */
  function section(title, key, open) {
    const count = h("span", { class: "count" });
    const body = h("div", { class: "nm-design-body" });
    const el = /** @type {HTMLDetailsElement} */ (h("details", { class: "nm-design-sec", open, dataset: { section: key } }, h("summary", null, h("span", null, title), count), body));
    /** @type {Section} */
    const sec = { el, body, count, sig: null, pending: false, focusKey: null };
    body.addEventListener("focusout", () => setTimeout(() => {
      if (sec.pending && !isTextEntry(document.activeElement, body)) { sec.pending = false; sec.sig = null; refresh(); }
    }));
    el.addEventListener("toggle", () => { if (el.open) { sec.sig = null; refresh(); } });
    return sec;
  }

  const secView = section("View", "view", true);
  const secRules = section("Rules", "rules", true);
  const secFilter = section("Filter, showcase, focus", "filter", false);
  const secTypes = section("Types", "types", false);
  const secFields = section("Fields", "fields", false);
  const root = h("div", { class: "nm-design" }, secView.el, secRules.el, secFilter.el, secTypes.el, secFields.el);
  host.appendChild(root);

  /**
   * Re-renders a section when its signature changed.
   * @param {Section} sec @param {any[]} sig @param {(body: HTMLElement) => void} build
   */
  function update(sec, sig, build) {
    if (sec.sig && sec.sig.length === sig.length && sec.sig.every((v, i) => v === sig[i])) return;
    if (!sec.el.open) { sec.sig = null; return; }
    const active = /** @type {HTMLInputElement|null} */ (document.activeElement);
    // An empty text input (after "Add") can be rebuilt with its focus; anything in progress waits.
    const idle = active?.tagName === "INPUT" && active.value === "" && active.hasAttribute("data-fkey");
    if (isTextEntry(active, sec.body) && !idle) { sec.pending = true; return; }
    sec.sig = sig;
    rebuild(sec.body, build, sec.focusKey);
    sec.focusKey = null;
  }

  function refresh() {
    const m = app.model;
    if (!m) return;
    const view = m.view;
    const schema = [...m.index.types.values(), ...m.index.fields.values()];
    secRules.count.textContent = view?.rules.length ? String(view.rules.length) : "";
    secTypes.count.textContent = String(m.index.types.size);
    secFields.count.textContent = String(m.index.fields.size);
    secFilter.count.textContent = view ? [view.filter && "filter", view.showcase && "showcase", view.focus && "focus"].filter(Boolean).join(", ") + (view.filter || view.showcase || view.focus ? " on" : "") : "";
    update(secView, [view, store.meta?.defaultViewId, m.views.size], renderView);
    update(secRules, [view, ...schema], renderRules);
    update(secFilter, [view, m.index.elements.size, m.index.connections.size, ...schema], renderFilter);
    if (secTypes.el.open) {
      const use = L.typeUsage(m.index);
      update(secTypes, [...m.index.types.values(), ...[...m.index.types.keys()].map((id) => use.get(id) ?? 0)], (b) => renderTypes(b, use));
    }
    if (secFields.el.open) {
      const use = L.fieldUsage(m.index);
      update(secFields, [...m.index.fields.values(), ...[...m.index.fields.keys()].map((id) => use.get(id) ?? 0)], (b) => renderFields(b, use));
    }
  }

  /** Where focus goes after the next rebuild of a section (a moved rule, a new choice). @param {Section} sec @param {string} key */
  const focusNext = (sec, key) => { sec.focusKey = key; };

  /** @param {Record<string, any>} patch */
  function patchView(patch) {
    const v = app.view;
    if (v) app.apply([{ op: "update", id: v.id, patch }]);
  }

  // --- View -------------------------------------------------------------------------------------

  /** @param {HTMLElement} body */
  function renderView(body) {
    const view = app.view;
    if (!view) { body.appendChild(h("p", { class: "hint" }, "No view yet.")); return; }
    const isDefault = view.id === store.meta?.defaultViewId;
    const name = /** @type {HTMLInputElement} */ (h("input", {
      type: "text", id: "nm-view-name", value: view.name, maxlength: LIMITS.viewName, "data-fkey": "view-name",
      onchange: () => {
        const v = name.value.trim();
        if (!v) { name.value = app.view?.name ?? ""; showToast("A view needs a name"); return; }
        if (v !== app.view?.name) patchView({ name: v });
      },
    }));
    const desc = /** @type {HTMLTextAreaElement} */ (h("textarea", {
      id: "nm-view-desc", rows: 2, maxlength: 2000, placeholder: "What this view shows (optional)", "data-fkey": "view-desc",
      onchange: () => { const v = desc.value.trim(); if (v !== (app.view?.description ?? "")) patchView({ description: v || null }); },
    }));
    desc.value = view.description ?? "";
    const own = view.layout?.own === true;
    const kind = view.layout?.kind ?? "force";
    const kindSelect = /** @type {HTMLSelectElement} */ (h("select", {
      "aria-label": "Preferred layout", "data-fkey": "view-layout-kind",
      onchange: () => patchView({ layout: { kind: kindSelect.value, own: app.view?.layout?.own === true } }),
    }, LAYOUT_KINDS.map((k) => h("option", { value: k, selected: k === kind }, LAYOUT_LABELS[k]))));
    body.append(
      h("div", { class: "field-row" }, h("label", { for: "nm-view-name" }, "Name"), name),
      h("div", { class: "field-row" }, h("label", { for: "nm-view-desc" }, "Description"), desc),
      h("div", { class: "row" },
        isDefault
          ? h("span", { class: "chip on", title: "Everyone sees this view until they pick another" }, "★ Default view")
          : h("button", { type: "button", class: "btn small outline", "data-fkey": "view-default", title: "Show this view to everyone who has not picked one", onclick: () => makeDefault(view.id) }, "Make default"),
        h("button", { type: "button", class: "btn small outline", "data-fkey": "view-duplicate", onclick: () => duplicate(view) }, icon("copy", 14), "Duplicate"),
        h("button", {
          type: "button", class: "btn small outline danger-text", "data-fkey": "view-delete", "aria-disabled": isDefault ? "true" : null,
          title: isDefault ? "The default view cannot be deleted; make another view the default first" : `Delete the view “${view.name}”`,
          onclick: () => {
            if (isDefault) { showToast("The default view cannot be deleted. Make another view the default first."); return; }
            deleteView(view);
          },
        }, icon("trash", 14), "Delete")),
      h("h4", null, "Layout"),
      h("label", { class: "check" },
        h("input", { type: "checkbox", checked: own, "data-fkey": "view-own", onchange: (/** @type {Event} */ e) => setOwnLayout(/** @type {HTMLInputElement} */ (e.target).checked) }),
        "Own layout"),
      h("p", { class: "hint" }, own
        ? "Positions in this view are its own: moving elements here does not move them in other views."
        : "Positions are shared with the other views that have no layout of their own."),
      h("div", { class: "row" }, kindSelect,
        h("button", {
          type: "button", class: "btn small outline", "data-fkey": "view-run", disabled: kind === "manual",
          title: kind === "manual" ? "Manual layout: drag elements to place them" : `Run the ${kind} layout now`,
          onclick: () => { if (kind !== "manual") app.runLayout(kind); },
        }, icon("play", 14), "Run now")),
    );
  }

  /** @param {string} id */
  function makeDefault(id) {
    app.apply([], { structure: { defaultViewId: id } });
    app.announce("This is now the default view");
  }

  /** @param {any} view */
  function duplicate(view) {
    const m = app.model;
    if (!m) return;
    if (m.views.size >= LIMITS.views) { showToast(`A map can have at most ${LIMITS.views} views`); return; }
    const id = app.newId("view");
    const order = Math.max(0, ...[...m.views.values()].map((v) => v.order ?? 0)) + 1;
    app.apply([{ op: "create", object: L.duplicateView(view, id, L.copyName(view.name), order) }]);
    if (view.layout?.own) {
      const pos = store.positions.get(view.id) ?? new Map();
      for (const op of L.copyLayoutMoves(id, pos.keys(), (eid) => pos.get(eid))) app.apply([op]);
    }
    requestAnimationFrame(() => app.setView(id));
    app.announce(`Duplicated the view as “${L.copyName(view.name)}”`);
  }

  /** @param {any} view */
  async function deleteView(view) {
    const ok = await confirm(`Delete the view “${view.name}”?`, "Its rules, filter and layout go with it. You can undo this from the Activity tab.", "Delete view");
    if (!ok) return;
    const fallback = store.meta?.defaultViewId;
    if (app.viewId === view.id && fallback) app.setView(fallback);
    app.apply([{ op: "delete", id: view.id }]);
    app.announce(`Deleted the view “${view.name}”`);
  }

  /** @param {boolean} on */
  function setOwnLayout(on) {
    const v = app.view;
    const m = app.model;
    if (!v || !m) return;
    // The server refuses moves into a view without its own layout, so the update goes first and
    // the copied positions follow in later calls (the store sends in order).
    app.apply([{ op: "update", id: v.id, patch: { layout: { kind: v.layout?.kind ?? "force", own: on } } }]);
    if (!on) { app.announce("This view now uses the shared layout"); return; }
    const shared = store.positions.get(SHARED_LAYOUT) ?? new Map();
    const placed = m.layout === SHARED_LAYOUT ? m.placed : new Map();
    for (const op of L.copyLayoutMoves(v.id, m.index.elements.keys(), (id) => shared.get(id) ?? placed.get(id))) app.apply([op]);
    app.announce("This view now has its own layout, starting from the shared positions");
  }

  // --- Rules ------------------------------------------------------------------------------------

  /** @param {HTMLElement} body */
  function renderRules(body) {
    const view = app.view;
    const index = app.model?.index;
    if (!view || !index) return;
    const rules = /** @type {any[]} */ (view.rules ?? []);
    body.appendChild(h("p", { class: "hint" }, rules.length
      ? "Rules apply in order; later rules win."
      : "No rules. Types set colours and shapes; add a rule to colour, size, label or hide items by their fields, tags or connections."));
    const list = h("ol", { class: "nm-list", "aria-label": "Rules" });
    rules.forEach((rule, i) => {
      const d = L.describeRule(rule, index);
      const n = i + 1;
      const swatch = rule.set.color?.value ? h("span", { class: "swatch-dot", style: { background: rule.set.color.value } }) : null;
      list.appendChild(h("li", { class: "nm-rule", "data-off": rule.off ? "" : null },
        h("input", {
          type: "checkbox", role: "switch", checked: !rule.off, "data-fkey": `rule-${i}-on`,
          "aria-label": `Rule ${n} on`, title: rule.off ? "Turn this rule on" : "Turn this rule off",
          onchange: (/** @type {Event} */ e) => {
            const on = /** @type {HTMLInputElement} */ (e.target).checked;
            saveRules(rules.map((r, j) => (j === i ? toggled(r, on) : r)));
          },
        }),
        h("div", { class: "nm-rule-text" },
          h("strong", null, !rule.name && swatch ? [swatch, " "] : null, d.title),
          h("span", null, d.selector),
          rule.name ? h("span", null, swatch, d.effect) : null,
          rule.off ? h("span", null, "Off") : null),
        h("div", { class: "nm-rule-actions" },
          h("button", {
            type: "button", class: "btn icon-only", "data-fkey": `rule-${i}-up`, "aria-label": `Move rule ${n} up`, title: "Move up", disabled: i === 0,
            onclick: () => { focusNext(secRules, i - 1 === 0 ? "rule-0-down" : `rule-${i - 1}-up`); saveRules(L.moveItem(rules, i, i - 1)); },
          }, icon("arrowUp", 14)),
          h("button", {
            type: "button", class: "btn icon-only", "data-fkey": `rule-${i}-down`, "aria-label": `Move rule ${n} down`, title: "Move down", disabled: i === rules.length - 1,
            onclick: () => { focusNext(secRules, i + 1 === rules.length - 1 ? `rule-${i + 1}-up` : `rule-${i + 1}-down`); saveRules(L.moveItem(rules, i, i + 1)); },
          }, icon("arrowDown", 14)),
          h("button", { type: "button", class: "btn icon-only", "data-fkey": `rule-${i}-edit`, "aria-label": `Edit rule ${n}`, title: "Edit", onclick: () => openRuleEditor(rule, i) }, icon("edit", 14)),
          h("button", {
            type: "button", class: "btn icon-only danger-text", "data-fkey": `rule-${i}-delete`, "aria-label": `Delete rule ${n}`, title: "Delete",
            onclick: () => { focusNext(secRules, "rule-add"); saveRules(rules.filter((_, j) => j !== i)); app.announce(`Deleted rule ${n}`); },
          }, icon("trash", 14)))));
    });
    if (rules.length) body.appendChild(list);
    const full = rules.length >= LIMITS.rules;
    body.appendChild(h("div", { class: "row" },
      h("button", {
        type: "button", class: "btn small outline", "data-fkey": "rule-add", disabled: full,
        title: full ? `A view may have at most ${LIMITS.rules} rules` : null, onclick: () => openRuleEditor(null, rules.length),
      }, icon("plus", 14), "Add rule")));
  }

  /** @param {any} rule @param {boolean} on */
  function toggled(rule, on) {
    const next = { ...rule };
    if (on) delete next.off;
    else next.off = true;
    return next;
  }

  /** @param {any[]} rules */
  const saveRules = (rules) => patchView({ rules });

  /**
   * The rule editor, in a modal.
   * @param {any|null} original the rule being edited (null for a new one) @param {number} at its position
   */
  function openRuleEditor(original, at) {
    if (!app.model) return;
    const viewId = app.view?.id;
    /** @type {RuleState} */
    let state = original ? L.stateFromRule(original) : L.emptyRuleState("element");
    let showErrors = false;
    const index = () => app.model.index;
    modal((close) => {
      const nameInput = /** @type {HTMLInputElement} */ (h("input", {
        type: "text", id: "nm-rule-name", value: state.name, maxlength: 80, placeholder: "e.g. Public sector in red",
        oninput: () => { state.name = nameInput.value; },
      }));
      const targetSeg = h("div", { class: "nm-seg", role: "group", "aria-label": "Rule applies to" });
      const renderTarget = () => rebuild(targetSeg, (el) => {
        for (const [t, label] of /** @type {const} */ ([["element", "Elements"], ["connection", "Connections"]])) {
          el.appendChild(h("button", {
            type: "button", class: "btn small", "aria-pressed": String(state.target === t), "data-fkey": `target-${t}`,
            onclick: () => { if (state.target === t) return; state = L.retarget(state, t, index()); renderTarget(); conds.render(); renderDeco(); changed(); },
          }, label));
        }
      });
      const conds = conditionBuilder({ get: () => state, index, onChange: () => changed(), name: "Condition" });
      const preview = h("span", { class: "preview", role: "status" });
      const decoHost = h("div", { class: "nm-deco" });
      const error = h("div", { class: "error-text", role: "alert" });
      const renderDeco = () => rebuild(decoHost, (el) => decorationControls(el, state, index(), () => { renderDeco(); changed(); }, () => changed()));
      const updatePreview = debounce(() => {
        const sel = L.selectorFromState(state, index());
        preview.textContent = "error" in sel ? "" : `Matches ${L.plural(L.matchCount(sel.value, index()), state.target)}`;
      }, 120);
      function changed() {
        updatePreview();
        if (showErrors) validate();
      }
      function validate() {
        const r = L.ruleFromState(state, index());
        error.textContent = "error" in r ? r.error : "";
        return r;
      }
      function save() {
        showErrors = true;
        const r = validate();
        if ("error" in r) return;
        const view = app.view;
        if (!view || view.id !== viewId) { error.textContent = "The view changed while you were editing. Cancel and edit the rule in the current view."; return; }
        saveRules(L.replaceRule(view.rules ?? [], original, at, r.value));
        app.announce(original ? "Rule saved" : "Rule added");
        close(null);
      }
      renderTarget();
      renderDeco();
      updatePreview();
      updatePreview.flush();
      return h("div", { class: "modal wide nm-rule-editor nm-design", "aria-label": original ? "Edit rule" : "New rule" },
        h("h2", null, original ? "Edit rule" : "New rule"),
        h("div", { class: "field-row" }, h("label", { for: "nm-rule-name" }, "Name (optional)"), nameInput),
        h("div", { class: "box", role: "group", "aria-label": "Which items" },
          h("div", { class: "row" }, h("h3", null, "Which"), targetSeg, preview),
          conds.el),
        h("div", { class: "box", role: "group", "aria-label": "What changes" }, h("h3", null, "Change"), decoHost),
        error,
        h("div", { class: "modal-actions" },
          h("button", { type: "button", class: "btn outline", onclick: () => close(null) }, "Cancel"),
          h("button", { type: "button", class: "btn primary", "data-action": "save-rule", onclick: () => save() }, original ? "Save rule" : "Add rule")));
    }, null);
  }

  /**
   * The decoration pickers of the rule editor.
   * @param {HTMLElement} el @param {RuleState} state @param {any} index
   * @param {() => void} structural  a choice that changes which controls show
   * @param {() => void} changed     a value changed
   */
  function decorationControls(el, state, index, structural, changed) {
    const d = state.deco;
    const target = state.target;
    const isEl = target === "element";
    /**
     * @param {string} label @param {string} fkey @param {[string, string, boolean?][]} options @param {string} value
     * @param {(v: string) => void} onPick @param {boolean} [struct]
     */
    const pick = (label, fkey, options, value, onPick, struct = true) => {
      const s = /** @type {HTMLSelectElement} */ (h("select", {
        "aria-label": label, "data-fkey": fkey,
        onchange: () => { onPick(s.value); if (struct) structural(); else changed(); },
      }, options.map(([v, text, disabled]) => h("option", { value: v, selected: v === value, disabled: !!disabled }, text))));
      return s;
    };
    /** @param {string} label @param {...any} control */
    const row = (label, ...control) => { el.append(h("span", { class: "lbl" }, label), h("div", { class: "ctl" }, ...control)); };
    const cats = L.categorySubjectOptions(target, index);
    const nums = L.numberSubjectOptions(target, index);
    /** @param {{key: string, label: string}[]} list @param {string} current @returns {[string, string][]} */
    const subjectChoices = (list, current) => {
      /** @type {[string, string][]} */
      const out = list.map((o) => [o.key, o.label]);
      if (current && !list.some((o) => o.key === current)) out.unshift([current, L.subjectLabel(current, index)]);
      return out;
    };

    /** @type {HTMLElement[]} */
    const colorCtl = [pick("Colour", "deco-color-mode", [["none", "Unchanged"], ["fixed", "One colour"], ["category", "By category"], ["number", "By number", !nums.length]], d.color.mode, (v) => {
      d.color.mode = /** @type {any} */ (v);
      if (v === "category" && !cats.some((o) => o.key === d.color.subject)) d.color.subject = cats[0]?.key ?? "type";
      if (v === "number" && L.subjectKind(d.color.subject, index) !== "number") d.color.subject = nums[0]?.key ?? "";
    })];
    if (d.color.mode === "fixed") colorCtl.push(swatchPicker({ value: d.color.value, label: "Rule colour", fkey: "deco-color", onChange: (c) => { d.color.value = c; changed(); } }));
    if (d.color.mode === "category") colorCtl.push(pick("Colour by", "deco-color-subject", subjectChoices(cats, d.color.subject), d.color.subject, (v) => { d.color.subject = v; }, false));
    if (d.color.mode === "number") {
      colorCtl.push(pick("Colour by number of", "deco-color-subject", subjectChoices(nums, d.color.subject), d.color.subject, (v) => { d.color.subject = v; }, false),
        h("span", { class: "muted" }, "from"), swatchPicker({ value: d.color.from, label: "Low colour", fkey: "deco-color-from", compact: true, onChange: (c) => { d.color.from = c; changed(); } }),
        h("span", { class: "muted" }, "to"), swatchPicker({ value: d.color.to, label: "High colour", fkey: "deco-color-to", compact: true, onChange: (c) => { d.color.to = c; changed(); } }));
    }
    row("Colour", ...colorCtl);

    const what = isEl ? "Size" : "Width";
    const [lo, hi] = L.sizeBounds(target);
    /** @param {string} label @param {string} fkey @param {number} value @param {(n: number) => void} set */
    const numInput = (label, fkey, value, set) => {
      const input = /** @type {HTMLInputElement} */ (h("input", {
        type: "number", min: lo, max: hi, step: isEl ? 1 : 0.5, value: String(value), "aria-label": label, "data-fkey": fkey,
        oninput: () => { set(input.value === "" ? NaN : Number(input.value)); changed(); },
      }));
      return input;
    };
    /** @type {HTMLElement[]} */
    const sizeCtl = [pick(what, "deco-size-mode", [["none", "Unchanged"], ["fixed", "Fixed"], ["number", "By number", !nums.length]], d.size.mode, (v) => {
      d.size.mode = /** @type {any} */ (v);
      if (v === "number" && L.subjectKind(d.size.subject, index) !== "number") d.size.subject = nums[0]?.key ?? "";
    })];
    if (d.size.mode === "fixed") sizeCtl.push(numInput(`${what} value`, "deco-size-value", d.size.value, (n) => { d.size.value = n; }));
    if (d.size.mode === "number") {
      sizeCtl.push(pick(`${what} by`, "deco-size-subject", subjectChoices(nums, d.size.subject), d.size.subject, (v) => { d.size.subject = v; }, false),
        numInput(`${what} minimum`, "deco-size-min", d.size.min, (n) => { d.size.min = n; }), h("span", { class: "muted" }, "to"),
        numInput(`${what} maximum`, "deco-size-max", d.size.max, (n) => { d.size.max = n; }),
        pick(`${what} scale`, "deco-size-scale", SCALES.map((s) => /** @type {[string, string]} */ ([s, s === "linear" ? "Linear" : s === "sqrt" ? "Square root" : "Logarithmic"])), d.size.scale, (v) => { d.size.scale = v; }, false));
    }
    row(what, ...sizeCtl);

    if (isEl) row("Shape", pick("Shape", "deco-shape", [["", "Unchanged"], ...SHAPES.map((s) => /** @type {[string, string]} */ ([s, s[0].toUpperCase() + s.slice(1)]))], d.shape, (v) => { d.shape = v; }, false));

    const labelFields = [...index.fields.values()].filter((f) => f.appliesTo === "both" || f.appliesTo === target).sort((a, b) => a.name.localeCompare(b.name));
    /** @type {[string, string][]} */
    const labelOpts = [["", "Unchanged"], ["label", "Its label"], ["none", "No label"], ...labelFields.map((f) => /** @type {[string, string]} */ ([`field:${f.id}`, `Field: ${f.name}`]))];
    if (d.label.startsWith("field:") && !labelOpts.some(([v]) => v === d.label)) labelOpts.push([d.label, "Field: missing field"]);
    row("Label", pick("Label", "deco-label", labelOpts, d.label, (v) => { d.label = v; }, false));

    row("Visibility", pick("Visibility", "deco-hidden", [["", "Unchanged"], ["hide", "Hide"], ["show", "Show (undo an earlier hide)"]], d.hidden, (v) => { d.hidden = /** @type {any} */ (v); }, false));

    const opacityOn = d.opacity !== null && d.opacity !== undefined;
    const opacityText = h("span", { class: "muted" }, opacityOn ? `${Math.round(Number(d.opacity) * 100)}%` : "");
    const opacityCtl = [h("label", { class: "check" }, h("input", {
      type: "checkbox", checked: opacityOn, "data-fkey": "deco-opacity-on",
      onchange: (/** @type {Event} */ e) => { d.opacity = /** @type {HTMLInputElement} */ (e.target).checked ? 0.5 : null; structural(); },
    }), "Change opacity")];
    if (opacityOn) {
      const range = /** @type {HTMLInputElement} */ (h("input", {
        type: "range", min: 0, max: 1, step: 0.05, value: String(d.opacity), "aria-label": "Opacity", "data-fkey": "deco-opacity",
        oninput: () => { d.opacity = Number(range.value); opacityText.textContent = `${Math.round(d.opacity * 100)}%`; changed(); },
      }));
      opacityCtl.push(range, opacityText);
    }
    row("Opacity", ...opacityCtl);

    if (isEl) {
      const borderCtl = [h("label", { class: "check" }, h("input", {
        type: "checkbox", checked: !!d.border, "data-fkey": "deco-border-on",
        onchange: (/** @type {Event} */ e) => { d.border = /** @type {HTMLInputElement} */ (e.target).checked ? "#1a1f2b" : ""; structural(); },
      }), "Add a border")];
      if (d.border) borderCtl.push(swatchPicker({ value: d.border, label: "Border colour", fkey: "deco-border", compact: true, onChange: (c) => { d.border = c; changed(); } }));
      row("Border", ...borderCtl);
    } else {
      row("Arrows", pick("Arrows", "deco-arrow", [["", "Unchanged"], ["auto", "By direction"], ["none", "None"]], d.arrow, (v) => { d.arrow = /** @type {any} */ (v); }, false));
      row("Curve", pick("Curve", "deco-curved", [["", "Unchanged"], ["yes", "Curved"], ["no", "Straight"]], d.curved, (v) => { d.curved = /** @type {any} */ (v); }, false));
    }
  }

  /**
   * An editable list of conditions (rule editor, filter, showcase). Mutates the state `get`
   * returns and re-renders itself when a condition's controls change shape.
   * @param {{get: () => SelectorState, index: () => any, onChange: () => void, name: string, targetPicker?: boolean}} opts
   */
  function conditionBuilder({ get, index, onChange, name, targetPicker = false }) {
    const el = h("div", { class: "nm-conds" });
    const prefix = name.toLowerCase().replace(/\s+/g, "-");
    function render() {
      rebuild(el, (host) => {
        const state = get();
        const g = index();
        const options = L.subjectOptions(state.target, g);
        const noun = state.target === "element" ? "Elements" : "Connections";
        const head = h("div", { class: "row" });
        if (targetPicker) {
          const t = /** @type {HTMLSelectElement} */ (h("select", {
            "aria-label": `${name}s apply to`, "data-fkey": `${prefix}-target`,
            onchange: () => {
              const valid = new Set(L.subjectOptions(/** @type {Target} */ (t.value), g).map((o) => o.key));
              state.target = /** @type {Target} */ (t.value);
              state.conditions = state.conditions.filter((c) => valid.has(c.subject));
              render(); onChange();
            },
          }, h("option", { value: "element", selected: state.target === "element" }, "Elements"), h("option", { value: "connection", selected: state.target === "connection" }, "Connections")));
          head.appendChild(t);
        } else head.appendChild(h("span", null, noun));
        if (state.conditions.length > 1) {
          const m = /** @type {HTMLSelectElement} */ (h("select", {
            "aria-label": `${name}s: match`, "data-fkey": `${prefix}-match`,
            onchange: () => { state.match = m.value === "any" ? "any" : "all"; onChange(); },
          }, h("option", { value: "all", selected: state.match === "all" }, "matching all of"), h("option", { value: "any", selected: state.match === "any" }, "matching any of")));
          head.appendChild(m);
        } else head.appendChild(h("span", { class: "muted" }, state.conditions.length ? "where" : "(all of them)"));
        host.appendChild(head);
        state.conditions.forEach((cond, i) => host.appendChild(conditionRow(state, cond, i, options, g)));
        const full = state.conditions.length >= LIMITS.predicates;
        host.appendChild(h("div", { class: "row" }, h("button", {
          type: "button", class: "btn small outline", "data-fkey": `${prefix}-add`, disabled: full,
          title: full ? `At most ${LIMITS.predicates} conditions` : null,
          onclick: () => {
            state.conditions.push(L.conditionFor(options.find((o) => o.key.startsWith("field:"))?.key ?? "type", g, state.target));
            render();
            focusIn(el, `${prefix}-${state.conditions.length - 1}-subject`);
            onChange();
          },
        }, icon("plus", 14), "Condition")));
      });
    }
    /**
     * @param {SelectorState} state @param {any} cond @param {number} i
     * @param {{key: string, label: string, group: string}[]} options @param {any} g
     */
    function conditionRow(state, cond, i, options, g) {
      const label = `${name} ${i + 1}`;
      const kind = L.subjectKind(cond.subject, g);
      const list = options.some((o) => o.key === cond.subject) ? options : [{ key: cond.subject, label: L.subjectLabel(cond.subject, g), group: "Built in" }, ...options];
      const groups = [...new Set(list.map((o) => o.group))];
      const subject = /** @type {HTMLSelectElement} */ (h("select", {
        "aria-label": `${label} subject`, "data-fkey": `${prefix}-${i}-subject`,
        onchange: () => { state.conditions[i] = L.conditionFor(subject.value, g, state.target); render(); onChange(); },
      }, groups.map((grp) => h("optgroup", { label: grp }, list.filter((o) => o.group === grp).map((o) => h("option", { value: o.key, selected: o.key === cond.subject }, o.label))))));
      const ops = L.opsForKind(kind);
      const shape = (/** @type {string} */ o) => (!L.opNeedsValue(o) ? "none" : o === "in" ? "list" : "one");
      const op = /** @type {HTMLSelectElement} */ (h("select", {
        "aria-label": `${label} operator`, "data-fkey": `${prefix}-${i}-op`,
        onchange: () => {
          const before = shape(cond.op);
          state.conditions[i] = L.withOp(cond, op.value);
          if (before !== shape(op.value)) render();
          onChange();
        },
      }, (ops.includes(cond.op) ? ops : [cond.op, ...ops]).map((o) => h("option", { value: o, selected: o === cond.op }, L.OP_LABELS[/** @type {keyof typeof L.OP_LABELS} */ (o)] ?? o))));
      const remove = h("button", {
        type: "button", class: "btn icon-only", "aria-label": `Remove ${label.toLowerCase()}`, title: "Remove", "data-fkey": `${prefix}-${i}-remove`,
        onclick: () => {
          state.conditions.splice(i, 1);
          render();
          focusIn(el, state.conditions.length ? `${prefix}-${Math.min(i, state.conditions.length - 1)}-subject` : `${prefix}-add`);
          onChange();
        },
      }, icon("close", 14));
      const row = h("div", { class: "nm-cond", role: "group", "aria-label": label }, subject, op, remove);
      if (!L.opNeedsValue(cond.op)) return row;
      const values = L.valueOptions(cond.subject, g, state.target);
      if (cond.op === "in" && values) {
        const chosen = new Set(Array.isArray(cond.value) ? cond.value : [cond.value]);
        row.appendChild(h("div", { class: "value checks", role: "group", "aria-label": `${label} values` },
          values.map((v, j) => h("label", null, h("input", {
            type: "checkbox", checked: chosen.has(v.value), "data-fkey": `${prefix}-${i}-v${j}`,
            onchange: (/** @type {Event} */ e) => {
              if (/** @type {HTMLInputElement} */ (e.target).checked) chosen.add(v.value); else chosen.delete(v.value);
              cond.value = values.map((x) => x.value).filter((x) => chosen.has(x));
              onChange();
            },
          }), v.label))));
      } else if (values) {
        const current = Array.isArray(cond.value) ? cond.value[0] ?? "" : cond.value;
        const shown = values.some((v) => v.value === current) || !current ? values : [{ value: current, label: `${current} (not an option)` }, ...values];
        if (!current && shown.length) cond.value = shown[0].value;
        const s = /** @type {HTMLSelectElement} */ (h("select", {
          "aria-label": `${label} value`, "data-fkey": `${prefix}-${i}-value`,
          onchange: () => { cond.value = s.value; onChange(); },
        }, shown.map((v) => h("option", { value: v.value, selected: v.value === cond.value }, v.label))));
        row.appendChild(h("div", { class: "value" }, s));
      } else {
        const input = /** @type {HTMLInputElement} */ (h("input", {
          type: cond.op === "in" ? "text" : L.inputTypeFor(kind), value: Array.isArray(cond.value) ? cond.value.join(", ") : cond.value,
          "data-fkey": `${prefix}-${i}-value`,
          "aria-label": cond.op === "in" ? `${label} values, separated by commas` : `${label} value`,
          placeholder: cond.op === "in" ? "a, b, c" : kind === "number" ? "0" : "", step: kind === "number" ? "any" : null,
          oninput: () => { cond.value = cond.op === "in" ? L.splitList(input.value) : input.value; onChange(); },
        }));
        row.appendChild(h("div", { class: "value" }, input));
      }
      return row;
    }
    render();
    return { el, render };
  }

  // --- Filter, showcase, focus ------------------------------------------------------------------

  /** Edited selectors survive re-renders until applied or cleared; another view starts over. */
  /** @type {Record<"filter"|"showcase", {viewId: string|null, state: SelectorState, dirty: boolean}>} */
  const drafts = {
    filter: { viewId: null, state: L.emptySelectorState("element"), dirty: false },
    showcase: { viewId: null, state: L.emptySelectorState("element"), dirty: false },
  };
  /** @type {(() => void)|null} */
  let syncRootsButton = null;

  /** @param {HTMLElement} body */
  function renderFilter(body) {
    const view = app.view;
    if (!view) return;
    body.append(
      selectorEditor("filter", "Filter", "Only matching items stay visible. A hidden element hides its connections."),
      selectorEditor("showcase", "Showcase", "Matching items stay bright; everything else dims."),
      focusEditor(view),
    );
  }

  /** @param {"filter"|"showcase"} key @param {string} title @param {string} hint */
  function selectorEditor(key, title, hint) {
    const view = app.view;
    const draft = drafts[key];
    if (draft.viewId !== view.id || !draft.dirty) {
      draft.viewId = view.id;
      draft.dirty = false;
      draft.state = view[key] ? L.stateFromSelector(view[key]) : L.emptySelectorState("element");
    }
    const index = () => app.model.index;
    const status = h("span", { class: "muted", role: "status" });
    const error = h("div", { class: "error-text", role: "alert" });
    const applyBtn = h("button", { type: "button", class: "btn small primary", "data-fkey": `${key}-apply`, disabled: !draft.dirty, onclick: () => apply() }, "Apply");
    const refreshStatus = () => {
      const sel = L.selectorFromState(draft.state, index());
      if ("error" in sel) { status.textContent = ""; return; }
      if (!draft.dirty && !view[key]) { status.textContent = ""; return; }
      const n = L.matchCount(sel.value, index());
      const total = (draft.state.target === "element" ? index().elements : index().connections).size;
      status.textContent = `${draft.dirty ? "Would match" : "Matches"} ${n} of ${L.plural(total, draft.state.target)}`;
    };
    const statusLater = debounce(refreshStatus, 150);
    const builder = conditionBuilder({
      get: () => draft.state, index, name: key === "filter" ? "Filter condition" : "Showcase condition", targetPicker: true,
      onChange: () => { draft.dirty = true; error.textContent = ""; applyBtn.removeAttribute("disabled"); clearBtn.removeAttribute("disabled"); statusLater(); },
    });
    const clearBtn = h("button", {
      type: "button", class: "btn small outline", "data-fkey": `${key}-clear`, disabled: !view[key] && !draft.dirty,
      onclick: () => {
        draft.dirty = false;
        draft.state = L.emptySelectorState("element");
        focusNext(secFilter, `${key}-condition-add`);
        if (app.view?.[key]) patchView({ [key]: null });
        else { secFilter.sig = null; refresh(); }
        app.announce(`${title} cleared`);
      },
    }, "Clear");
    function apply() {
      const sel = L.selectorFromState(draft.state, index());
      if ("error" in sel) { error.textContent = sel.error; return; }
      draft.dirty = false;
      patchView({ [key]: sel.value });
      app.announce(`${title} applied`);
    }
    refreshStatus();
    return h("div", { class: "field-row", role: "group", "aria-label": title, dataset: { editor: key } },
      h("h4", null, title, view[key] ? h("span", { class: "chip on" }, "on") : null),
      h("p", { class: "hint" }, hint),
      builder.el, error,
      h("div", { class: "row" }, applyBtn, clearBtn, status));
  }

  /** @param {any} view */
  function focusEditor(view) {
    const index = app.model.index;
    const focus = view.focus;
    const roots = /** @type {string[]} */ (focus?.roots ?? []);
    const depthSel = /** @type {HTMLSelectElement} */ (h("select", {
      "aria-label": "Focus depth", "data-fkey": "focus-depth",
      onchange: () => { if (focus) patchView({ focus: { ...focus, depth: Number(depthSel.value) } }); },
    }, [1, 2, 3, 4].map((d) => h("option", { value: String(d), selected: d === (focus?.depth ?? 1) }, `${d} step${d === 1 ? "" : "s"} away`))));
    const dirSel = /** @type {HTMLSelectElement} */ (h("select", {
      "aria-label": "Focus direction", "data-fkey": "focus-direction",
      onchange: () => { if (focus) patchView({ focus: { ...focus, direction: dirSel.value } }); },
    }, [["both", "Both ways"], ["out", "Outgoing"], ["in", "Incoming"]].map(([v, t]) => h("option", { value: v, selected: v === (focus?.direction ?? "both") }, t))));
    const useSel = h("button", {
      type: "button", class: "btn small outline", "data-fkey": "focus-use",
      onclick: () => {
        const ids = [...app.selection].filter((id) => id[0] === "e").slice(0, LIMITS.focusRoots);
        if (!ids.length) { showToast("Select elements on the map first"); return; }
        patchView({ focus: { roots: ids, depth: Number(depthSel.value), direction: dirSel.value } });
        app.announce(`Focused on ${L.plural(ids.length, "element")}`);
      },
    }, icon("focus", 14), "Use selection as roots");
    syncRootsButton = () => {
      const n = [...app.selection].filter((id) => id[0] === "e").length;
      useSel.setAttribute("aria-disabled", String(!n));
      useSel.title = n ? `Focus on the ${L.plural(n, "selected element")}` : "Select elements on the map first";
    };
    syncRootsButton();
    return h("div", { class: "field-row", role: "group", "aria-label": "Focus", dataset: { editor: "focus" } },
      h("h4", null, "Focus", focus ? h("span", { class: "chip on" }, "on") : null),
      h("p", { class: "hint" }, focus ? "Only elements near these roots are shown." : "Show only what is near some elements: select them on the map, then use them as roots."),
      roots.length ? h("div", { class: "nm-roots", role: "list", "aria-label": "Focus roots" },
        roots.map((id, i) => {
          const label = index.elements.get(id)?.label ?? "Deleted element";
          return h("span", { class: "chip", role: "listitem" }, label,
            h("button", {
              type: "button", class: "btn icon-only", "aria-label": `Remove ${label} from the focus`, "data-fkey": `focus-root-${i}`,
              onclick: () => {
                const next = roots.filter((r) => r !== id);
                focusNext(secFilter, next.length ? `focus-root-${Math.min(i, next.length - 1)}` : "focus-use");
                patchView({ focus: next.length ? { ...focus, roots: next } : null });
              },
            }, icon("close", 12)));
        })) : null,
      h("div", { class: "row" }, depthSel, dirSel),
      h("div", { class: "row" }, useSel,
        h("button", { type: "button", class: "btn small outline", "data-fkey": "focus-clear", disabled: !focus, onclick: () => { focusNext(secFilter, "focus-use"); patchView({ focus: null }); app.announce("Focus cleared"); } }, "Clear focus")));
  }

  // --- Types ------------------------------------------------------------------------------------

  /** @param {HTMLElement} body @param {Map<string, number>} use */
  function renderTypes(body, use) {
    const index = app.model.index;
    for (const [appliesTo, title] of /** @type {const} */ ([["element", "Element types"], ["connection", "Connection types"]])) {
      const types = [...index.types.values()].filter((t) => t.appliesTo === appliesTo).sort((a, b) => a.name.localeCompare(b.name));
      const input = /** @type {HTMLInputElement} */ (h("input", {
        type: "text", class: "grow", maxlength: LIMITS.typeName, placeholder: appliesTo === "element" ? "New element type" : "New connection type",
        "aria-label": appliesTo === "element" ? "New element type name" : "New connection type name", "data-fkey": `type-new-${appliesTo}`,
        onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === "Enter") { e.preventDefault(); add(); } },
      }));
      const add = () => {
        const n = normalizeType({ name: input.value, appliesTo, color: L.nextTypeColor(index, appliesTo) });
        if ("error" in n) { showToast(n.error); return; }
        if (index.types.size >= LIMITS.types) { showToast(`A map can have at most ${LIMITS.types} types`); return; }
        input.value = "";
        focusNext(secTypes, `type-new-${appliesTo}`);
        app.apply([{ op: "create", object: { id: app.newId("type"), ...n.value } }]);
        app.announce(`Added the type “${n.value.name}”`);
      };
      body.append(
        h("h4", null, title),
        types.length
          ? h("ul", { class: "nm-list", "aria-label": title, dataset: { list: appliesTo } }, types.map((t) => typeRow(t, use.get(t.id) ?? 0)))
          : h("p", { class: "hint" }, "None yet."),
        h("div", { class: "row" }, input, h("button", { type: "button", class: "btn small outline", "data-fkey": `type-add-${appliesTo}`, onclick: add }, icon("plus", 14), "Add")));
    }
  }

  /** @param {any} t @param {number} used */
  function typeRow(t, used) {
    const name = inlineEditable({
      className: "nm-type-name", label: `Name of the ${t.appliesTo} type`, maxLength: LIMITS.typeName,
      getValue: () => t.name,
      onSave: (v) => app.apply([{ op: "update", id: t.id, patch: { name: v } }]),
    });
    name.el.querySelector("button")?.setAttribute("data-fkey", `type-${t.id}-name`);
    const color = t.color ?? (t.appliesTo === "element" ? "#4e79a7" : "#9aa3ad");
    const swatch = h("button", {
      type: "button", class: "nm-swatch-btn", style: { background: color },
      "aria-label": `Colour of ${t.name}: ${color}`, title: "Change colour", "data-fkey": `type-${t.id}-color`,
      onclick: async () => {
        const c = await pickColor(`Colour of “${t.name}”`, color);
        if (c && c !== t.color) app.apply([{ op: "update", id: t.id, patch: { color: c } }]);
      },
    });
    const shape = t.appliesTo === "element" ? /** @type {HTMLSelectElement} */ (h("select", {
      "aria-label": `Shape of ${t.name}`, "data-fkey": `type-${t.id}-shape`,
      onchange: () => app.apply([{ op: "update", id: t.id, patch: { shape: /** @type {HTMLSelectElement} */ (shape).value } }]),
    }, SHAPES.map((s) => h("option", { value: s, selected: s === (t.shape ?? "circle") }, s)))) : null;
    const del = h("button", {
      type: "button", class: "btn icon-only danger-text", "data-fkey": `type-${t.id}-delete`,
      "aria-label": `Delete the type ${t.name}`, "aria-disabled": used ? "true" : null,
      title: used ? `Used by ${L.plural(used, "item")}; change their type first` : "Delete",
      onclick: () => {
        if (used) { showToast(`“${t.name}” is used by ${L.plural(used, "item")}. Change their type first.`); return; }
        focusNext(secTypes, `type-new-${t.appliesTo}`);
        app.apply([{ op: "delete", id: t.id }]);
        app.announce(`Deleted the type “${t.name}”`);
      },
    }, icon("trash", 14));
    return h("li", { class: "nm-item", dataset: { typeId: t.id } }, swatch, name.el, shape,
      h("span", { class: "uses", title: "Items of this type" }, used ? L.plural(used, "use") : "unused"), del);
  }

  // --- Fields -----------------------------------------------------------------------------------

  /** @param {HTMLElement} body @param {Map<string, number>} use */
  function renderFields(body, use) {
    const index = app.model.index;
    const fields = [...index.fields.values()].sort((a, b) => a.name.localeCompare(b.name));
    body.append(
      fields.length
        ? h("ul", { class: "nm-list", "aria-label": "Fields" }, fields.map((f) => fieldRow(f, use.get(f.id) ?? 0, index)))
        : h("p", { class: "hint" }, "No custom fields. Fields hold values such as a sector, a score or a date; rules can colour, size and filter by them."),
      newFieldForm(index));
  }

  /** @param {any} f @param {number} used @param {any} index */
  function fieldRow(f, used, index) {
    const name = inlineEditable({
      className: "nm-field-name", label: "Field name", maxLength: LIMITS.fieldName,
      getValue: () => f.name,
      onSave: (v) => app.apply([{ op: "update", id: f.id, patch: { name: v } }]),
    });
    name.el.querySelector("button")?.setAttribute("data-fkey", `field-${f.id}-name`);
    const isChoice = (/** @type {string} */ k) => k === "choice" || k === "multichoice";
    const kind = /** @type {HTMLSelectElement} */ (h("select", {
      "aria-label": `Kind of ${f.name}`, "data-fkey": `field-${f.id}-kind`, disabled: used > 0,
      title: used ? `${L.plural(used, "item")} ${used === 1 ? "has" : "have"} a value, so the kind cannot change` : "Kind of value",
      onchange: () => {
        /** @type {Record<string, any>} */
        const patch = { kind: kind.value };
        if (isChoice(kind.value) && !(f.choices ?? []).length) patch.choices = ["Option 1"];
        app.apply([{ op: "update", id: f.id, patch }]);
      },
    }, FIELD_KINDS.map((k) => h("option", { value: k, selected: k === f.kind }, KIND_LABELS[k]))));
    const applies = /** @type {HTMLSelectElement} */ (h("select", {
      "aria-label": `${f.name} applies to`, "data-fkey": `field-${f.id}-applies`,
      title: used ? "A field with values can only widen to both" : "Applies to",
      onchange: () => app.apply([{ op: "update", id: f.id, patch: { appliesTo: applies.value } }]),
    }, APPLIES_TO.map((a) => h("option", { value: a, selected: a === f.appliesTo, disabled: used > 0 && a !== f.appliesTo && a !== "both" }, APPLIES_LABELS[a]))));
    const del = h("button", {
      type: "button", class: "btn icon-only danger-text", "aria-label": `Delete the field ${f.name}`, "data-fkey": `field-${f.id}-delete`, title: "Delete",
      onclick: async () => {
        const ok = await confirm(`Delete the field “${f.name}”?`,
          used ? `${L.plural(used, "item")} ${used === 1 ? "has" : "have"} a value for it. The values stay stored but are hidden, and rules that use the field stop matching. You can undo this from the Activity tab.`
            : "No item has a value for it. You can undo this from the Activity tab.",
          "Delete field");
        if (!ok) return;
        app.apply([{ op: "delete", id: f.id }]);
        app.announce(`Deleted the field “${f.name}”`);
      },
    }, icon("trash", 14));
    return h("li", { class: "nm-field", dataset: { fieldId: f.id } },
      h("div", { class: "nm-item" }, name.el, h("span", { class: "uses" }, used ? L.plural(used, "value") : "no values"), del),
      h("div", { class: "row" }, kind, applies),
      isChoice(f.kind) ? choicesEditor(f, index) : null);
  }

  /** @param {any} f @param {any} index */
  function choicesEditor(f, index) {
    const choices = /** @type {string[]} */ (f.choices ?? []);
    const input = /** @type {HTMLInputElement} */ (h("input", {
      type: "text", maxlength: LIMITS.choice, placeholder: "New choice", "aria-label": `New choice for ${f.name}`, "data-fkey": `field-${f.id}-choice-new`,
      onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === "Enter") { e.preventDefault(); add(); } },
    }));
    const add = () => {
      const v = input.value.trim();
      if (!v) return;
      if (choices.some((c) => c.toLowerCase() === v.toLowerCase())) { showToast(`“${v}” is already a choice`); return; }
      if (choices.length >= LIMITS.choices) { showToast(`A field can have at most ${LIMITS.choices} choices`); return; }
      input.value = "";
      focusNext(secFields, `field-${f.id}-choice-new`);
      app.apply([{ op: "update", id: f.id, patch: { choices: [...choices, v] } }]);
    };
    return h("div", { class: "nm-choices", role: "list", "aria-label": `Choices of ${f.name}` },
      choices.map((c, i) => h("span", { class: "chip", role: "listitem" }, c,
        h("button", {
          type: "button", class: "btn icon-only", "aria-label": `Remove the choice ${c}`, "data-fkey": `field-${f.id}-choice-${i}`,
          onclick: () => {
            const next = choices.filter((x) => x !== c);
            const blocked = L.blockedChoiceRemovals(f, next, app.model?.index ?? index);
            if (blocked.length) { showToast(`“${c}” is used by ${L.plural(blocked[0].count, "item")}. Change their values first.`); return; }
            if (!next.length) { showToast("A choice field needs at least one choice"); return; }
            focusNext(secFields, `field-${f.id}-choice-new`);
            app.apply([{ op: "update", id: f.id, patch: { choices: next } }]);
          },
        }, icon("close", 12)))),
      input,
      h("button", { type: "button", class: "btn small outline", "data-fkey": `field-${f.id}-choice-add`, onclick: add }, "Add"));
  }

  /** @param {any} index */
  function newFieldForm(index) {
    const name = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "grow", maxlength: LIMITS.fieldName, placeholder: "Field name", "aria-label": "New field name", "data-fkey": "field-new-name" }));
    const kind = /** @type {HTMLSelectElement} */ (h("select", {
      "aria-label": "New field kind", "data-fkey": "field-new-kind",
      onchange: () => { choices.hidden = kind.value !== "choice" && kind.value !== "multichoice"; },
    }, FIELD_KINDS.map((k) => h("option", { value: k }, KIND_LABELS[k]))));
    const applies = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "New field applies to", "data-fkey": "field-new-applies" },
      APPLIES_TO.map((a) => h("option", { value: a }, APPLIES_LABELS[a]))));
    const choices = /** @type {HTMLInputElement} */ (h("input", { type: "text", hidden: true, placeholder: "Choices, separated by commas", "aria-label": "New field choices, separated by commas", "data-fkey": "field-new-choices" }));
    const error = h("div", { class: "error-text", role: "alert" });
    const add = () => {
      const n = normalizeField({ name: name.value, kind: kind.value, appliesTo: applies.value, choices: L.splitList(choices.value) });
      if ("error" in n) { error.textContent = n.error; return; }
      if (index.fields.size >= LIMITS.fields) { error.textContent = `A map can have at most ${LIMITS.fields} fields`; return; }
      if ([...index.fields.values()].some((f) => f.name.toLowerCase() === n.value.name.toLowerCase())) { error.textContent = `There is already a field called “${n.value.name}”`; return; }
      error.textContent = "";
      name.value = "";
      choices.value = "";
      focusNext(secFields, "field-new-name");
      app.apply([{ op: "create", object: { id: app.newId("field"), ...n.value } }]);
      app.announce(`Added the field “${n.value.name}”`);
    };
    for (const input of [name, choices]) input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
    return h("div", { class: "field-row", role: "group", "aria-label": "New field", dataset: { editor: "new-field" } },
      h("h4", null, "New field"),
      h("div", { class: "row" }, name),
      h("div", { class: "row" }, kind, applies),
      choices, error,
      h("div", { class: "row" }, h("button", { type: "button", class: "btn small outline", "data-fkey": "field-new-add", onclick: add }, icon("plus", 14), "Add field")));
  }

  // --- Dialogs ----------------------------------------------------------------------------------

  /** @param {string} heading @param {string} body @param {string} action @returns {Promise<boolean>} */
  function confirm(heading, body, action) {
    return modal((close) => h("div", { class: "modal", "aria-label": heading },
      h("h2", null, heading), h("p", null, body),
      h("div", { class: "modal-actions" },
        h("button", { type: "button", class: "btn outline", "data-autofocus": true, onclick: () => close(false) }, "Cancel"),
        h("button", { type: "button", class: "btn primary", onclick: () => close(true) }, action))), false);
  }

  /** @param {string} title @param {string} current @returns {Promise<string|null>} */
  function pickColor(title, current) {
    let chosen = current;
    /** @type {(close: (v: string|null) => void) => HTMLElement} */
    const build = (close) => h("div", { class: "modal nm-design", "aria-label": title },
      h("h2", null, title),
      swatchPicker({ value: current, label: title, fkey: "pick", onChange: (c) => { chosen = c; } }),
      h("div", { class: "modal-actions" },
        h("button", { type: "button", class: "btn outline", onclick: () => close(null) }, "Cancel"),
        h("button", { type: "button", class: "btn primary", onclick: () => close(chosen) }, "Save")));
    return modal(build, null);
  }

  const unsubs = [
    app.on("model", refresh),
    app.on("view", refresh),
    app.on("selection", () => syncRootsButton?.()),
  ];
  if (app.model) refresh();
  else secView.body.appendChild(h("p", { class: "hint" }, "Loading…"));

  return {
    destroy() {
      for (const u of unsubs) u();
      root.remove();
    },
  };
}

/**
 * Palette swatches (a radio group: one Tab stop, arrow keys move) and a hex input; `compact` shows
 * only a colour dot and the hex input.
 * @param {{value: string, label: string, fkey: string, onChange: (c: string) => void, compact?: boolean}} opts
 */
function swatchPicker({ value, label, fkey, onChange, compact = false }) {
  const initial = cleanColor(value) ?? PALETTE[0];
  const list = compact ? [] : PALETTE;
  const hex = /** @type {HTMLInputElement} */ (h("input", {
    type: "text", value: initial, maxlength: 7, spellcheck: "false", "aria-label": `${label} (hex)`, "data-fkey": `${fkey}-hex`,
    oninput: () => {
      const raw = hex.value.trim();
      const c = cleanColor(raw.startsWith("#") ? raw : "#" + raw);
      hex.setAttribute("aria-invalid", String(!c));
      if (c) set(c, false);
    },
  }));
  const dot = compact ? h("span", { class: "swatch-dot", style: { background: initial, width: "16px", height: "16px" } }) : null;
  const group = h("div", { class: "nm-sw", role: compact ? "group" : "radiogroup", "aria-label": label },
    list.map((c, i) => h("button", {
      type: "button", class: "swatch", role: "radio", style: { background: c }, dataset: { color: c },
      "aria-label": `${PALETTE_NAMES[i]} ${c}`, "aria-checked": String(c === initial),
      tabindex: c === initial || (i === 0 && !list.includes(initial)) ? "0" : "-1", "data-fkey": `${fkey}-${i}`,
      onclick: () => set(c, true),
    })), dot, hex);
  /** @param {string} c @param {boolean} fromSwatch */
  function set(c, fromSwatch) {
    for (const b of /** @type {NodeListOf<HTMLElement>} */ (group.querySelectorAll(".swatch"))) {
      const on = b.dataset.color === c;
      b.setAttribute("aria-checked", String(on));
      b.setAttribute("tabindex", on ? "0" : "-1");
    }
    if (!group.querySelector('.swatch[tabindex="0"]')) group.querySelector(".swatch")?.setAttribute("tabindex", "0");
    if (fromSwatch) { hex.value = c; hex.removeAttribute("aria-invalid"); }
    if (dot) dot.style.background = c;
    onChange(c);
  }
  group.addEventListener("keydown", (e) => {
    const buttons = /** @type {HTMLElement[]} */ ([...group.querySelectorAll(".swatch")]);
    const i = buttons.indexOf(/** @type {any} */ (document.activeElement));
    if (i < 0) return;
    const n = buttons.length;
    const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % n
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i - 1 + n) % n
        : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
    if (next === null) return;
    e.preventDefault();
    buttons[next].focus();
    set(/** @type {string} */ (buttons[next].dataset.color), true);
  });
  return group;
}

/**
 * Whether `el` is a text entry inside `within` that a re-render would disturb.
 * @param {Element|null} el @param {HTMLElement} within
 */
function isTextEntry(el, within) {
  if (!el || !within.contains(el)) return false;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.tagName !== "INPUT") return false;
  return !["checkbox", "radio", "button"].includes(/** @type {HTMLInputElement} */ (el).type);
}

/**
 * Rebuilds `el`'s children and puts focus back on the control with the same data-fkey (or on
 * `focusKey`).
 * @param {HTMLElement} el @param {(el: HTMLElement) => void} build @param {string|null} [focusKey]
 */
function rebuild(el, build, focusKey = null) {
  const active = document.activeElement;
  const key = focusKey ?? (active && el.contains(active) ? active.getAttribute("data-fkey") : null);
  clear(el);
  build(el);
  if (key) focusIn(el, key);
}

/** @param {HTMLElement} el @param {string} key */
function focusIn(el, key) {
  /** @type {HTMLElement|null} */ (el.querySelector(`[data-fkey="${key.replace(/["\\]/g, "\\$&")}"]`))?.focus();
}
