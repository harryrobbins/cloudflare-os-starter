// @ts-check
// Board settings: the key prefix and this viewer's shortcut preference (gadget documents), and the
// datastore's workflow states, labels, projects and cycles (Records commands, each approved like
// any other change). Tabs follow the APG tabs pattern.

import { h, setChildren } from "./dom.js";
import { stateIcon } from "./icons.js";
import { KINDS, KIND_LABELS, KIND_COLORS, PROJECT_STATES, addDays, keyPrefixFrom, validKeyPrefix } from "../../shared/model/work.js";

/**
 * @typedef {{
 *   layers: ReturnType<typeof import("./overlay.js").createLayers>, store: import("../store/store.js").Store,
 *   today: () => string, announce: (t: string) => void, initialTab?: string,
 * }} SettingsOptions
 */

const TABS = [["general", "General"], ["states", "Workflow"], ["labels", "Labels"], ["projects", "Projects"], ["cycles", "Cycles"]];

/** @param {SettingsOptions} o */
export function openSettings(o) {
  const { store } = o;
  let tab = o.initialTab ?? "general";
  const tablist = h("div", { class: "tabs", role: "tablist", "aria-label": "Settings sections" });
  const panel = h("div", { class: "tab-panel", role: "tabpanel", tabindex: "0" });
  const unsubscribe = store.subscribe((topics) => { if (topics.has("data") || topics.has("changes")) renderPanel(false); });

  function renderTabs() {
    setChildren(tablist, ...TABS.map(([id, label]) => h("button", {
      type: "button", role: "tab", id: `wb-tab-${id}`, "aria-selected": String(id === tab), "aria-controls": "wb-tab-panel", tabindex: id === tab ? "0" : "-1",
      onclick: () => select(id),
    }, label)));
    panel.id = "wb-tab-panel";
    panel.setAttribute("aria-labelledby", `wb-tab-${tab}`);
  }
  /** @param {string} id */
  function select(id) { tab = id; renderTabs(); renderPanel(true); /** @type {HTMLElement|null} */ (tablist.querySelector(`#wb-tab-${id}`))?.focus(); }
  tablist.addEventListener("keydown", (e) => {
    const i = TABS.findIndex(([id]) => id === tab);
    if (e.key === "ArrowRight") { e.preventDefault(); select(TABS[(i + 1) % TABS.length][0]); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); select(TABS[(i - 1 + TABS.length) % TABS.length][0]); }
    else if (e.key === "Home") { e.preventDefault(); select(TABS[0][0]); }
    else if (e.key === "End") { e.preventDefault(); select(TABS[TABS.length - 1][0]); }
  });

  /** @param {boolean} force */
  function renderPanel(force) {
    // Never rebuild a form the person is typing in.
    if (!force && panel.contains(panel.ownerDocument.activeElement) && /INPUT|TEXTAREA|SELECT/.test(panel.ownerDocument.activeElement?.tagName ?? "")) return;
    const index = store.index();
    const canWrite = store.canWrite();
    const blocked = tab !== "general" && !store.planning
      ? h("p", { class: "notice" }, "This datastore has the basic work model. Workflow states, labels, projects and cycles arrive with the Records planning upgrade (migration 010).")
      : null;
    if (blocked) { setChildren(panel, blocked); return; }
    if (tab === "general") setChildren(panel, general(index));
    else if (tab === "states") setChildren(panel, states(index, canWrite));
    else if (tab === "labels") setChildren(panel, labels(index, canWrite));
    else if (tab === "projects") setChildren(panel, projects(index, canWrite));
    else setChildren(panel, cycles(index, canWrite));
  }

  /** Reports a store result under a form. @param {HTMLElement} error @param {{ ok: boolean, error?: string }} r @param {string} ok */
  const report = (error, r, ok) => { error.textContent = r.ok ? "" : r.error ?? "Not sent."; if (r.ok) o.announce(ok); return r.ok; };
  /** @param {string} id */
  const pendingChip = (id) => {
    const ch = store.pendingFor(id);
    return ch ? h("span", { class: `pending-chip ${ch.status}` }, ch.status === "pending" ? "Awaiting approval" : ch.status === "saving" ? "Sending…" : "Saved") : null;
  };

  /** @param {import("../../shared/model/index.js").WorkIndex} index */
  function general(index) {
    const prefix = /** @type {HTMLInputElement} */ (h("input", { type: "text", id: "wb-prefix", value: store.settings.keyPrefix ?? "", placeholder: keyPrefixFrom(store.connection?.label), maxlength: "10", autocapitalize: "characters", "aria-describedby": "wb-prefix-help" }));
    const error = h("p", { class: "field-error", role: "alert" });
    const shortcuts = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", id: "wb-shortcuts", checked: store.prefs.shortcuts !== false }));
    shortcuts.addEventListener("change", () => { store.setPrefs({ shortcuts: shortcuts.checked }); o.announce(`Single-key shortcuts ${shortcuts.checked ? "on" : "off"}.`); });
    const save = async () => {
      const value = prefix.value.trim().toUpperCase();
      if (value && !validKeyPrefix(value)) { error.textContent = "A key prefix is 2–10 capital letters or digits, starting with a letter."; prefix.focus(); return; }
      try { await store.saveSettings({ keyPrefix: value || null }); error.textContent = ""; o.announce(`Items are now numbered ${value || index.keyPrefix}-1, ${value || index.keyPrefix}-2…`); }
      catch (err) { error.textContent = String(/** @type {any} */ (err)?.message ?? err).replace(/^[a-z_]+:\s*/, ""); }
    };
    prefix.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } });
    return h("div", { class: "settings-general" },
      h("h3", null, "Item keys"),
      h("div", { class: "field" }, h("label", { for: "wb-prefix" }, "Key prefix"), h("div", { class: "row" }, prefix, h("button", { type: "button", class: "btn", onclick: save, disabled: !store.canWrite() }, "Save prefix")),
        h("p", { id: "wb-prefix-help", class: "hint" }, `Shown before item numbers, e.g. ${index.keyPrefix}-42. Shared by everyone using this board; empty uses “${keyPrefixFrom(store.connection?.label)}” from the datastore name.`), error),
      h("h3", null, "Keyboard"),
      h("div", { class: "field" }, h("label", { class: "check-label", for: "wb-shortcuts" }, shortcuts, "Single-key shortcuts (C, J, K, X, S…)"),
        h("p", { class: "hint" }, "Just for you. Turn off if you use speech input or a screen reader's single-key navigation. Ctrl/⌘+K and the arrow keys always work.")),
      h("h3", null, "Datastore"),
      h("p", { class: "hint" }, `${store.connection?.label ?? "Records"} · work v1${store.planning ? " with planning" : ""} · ${store.connection?.access === "write" ? "read and request changes" : "read only"}. Changes to items, states, labels, projects and cycles go through Workshop approval.`));
  }

  /** @param {import("../../shared/model/index.js").WorkIndex} index @param {boolean} canWrite */
  function states(index, canWrite) {
    const rows = index.states.map((s, i) => {
      const name = /** @type {HTMLInputElement} */ (h("input", { type: "text", value: s.name, maxlength: "60", "aria-label": `Name of ${s.name}`, disabled: !canWrite }));
      const kind = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": `Kind of ${s.name}`, disabled: !canWrite }, KINDS.map((k) => h("option", { value: k, selected: k === s.kind }, KIND_LABELS[k]))));
      const color = /** @type {HTMLInputElement} */ (h("input", { type: "color", value: s.color, "aria-label": `Colour of ${s.name}`, disabled: !canWrite }));
      const wip = /** @type {HTMLInputElement} */ (h("input", { type: "number", min: "1", max: "100000", value: s.wipLimit ?? "", placeholder: "—", "aria-label": `WIP limit of ${s.name}`, disabled: !canWrite, class: "narrow" }));
      const error = h("p", { class: "field-error", role: "alert" });
      const save = () => {
        /** @type {Record<string, unknown>} */
        const input = { id: s.id };
        if (name.value.trim() !== s.name) input.name = name.value;
        if (kind.value !== s.kind) input.kind = kind.value;
        if (color.value !== s.color) input.color = color.value;
        const w = wip.value ? Number(wip.value) : null;
        if (w !== s.wipLimit) input.wip_limit = w;
        if (Object.keys(input).length === 1) { error.textContent = "Nothing has changed."; return; }
        if (s.virtual || !s.id) { error.textContent = "The default states are created with the first change to this datastore. Make any change, then edit them."; return; }
        report(error, store.entity("work.state.update", input, { label: `Update state ${s.name}`, revision: s.revision, itemId: s.id }), `Sent: update ${s.name}.`);
      };
      const moveBy = (/** @type {number} */ d) => {
        const other = index.states[i + d];
        if (!other || !s.id || !other.id) return;
        const a = s.position === other.position ? other.position + d : other.position;
        report(error, store.entity("work.state.update", { id: s.id, position: a }, { label: `Move state ${s.name}`, revision: s.revision, itemId: s.id }), "");
        report(error, store.entity("work.state.update", { id: other.id, position: s.position }, { label: `Move state ${other.name}`, revision: other.revision, itemId: other.id }), `Sent: move ${s.name} ${d < 0 ? "up" : "down"}.`);
      };
      return h("li", { class: "settings-row" },
        h("span", { class: "row-icon", "aria-hidden": "true" }, stateIcon(s.kind, s.color)),
        name, kind, color, wip,
        canWrite ? h("span", { class: "row-actions" },
          h("button", { type: "button", class: "icon-btn sm", "aria-label": `Move ${s.name} up`, disabled: i === 0 || s.virtual, onclick: () => moveBy(-1) }, "↑"),
          h("button", { type: "button", class: "icon-btn sm", "aria-label": `Move ${s.name} down`, disabled: i === index.states.length - 1 || s.virtual, onclick: () => moveBy(1) }, "↓"),
          h("button", { type: "button", class: "btn sm", onclick: save }, "Save")) : null,
        s.id ? pendingChip(s.id) : null, error);
    });
    const add = addRow("state", canWrite, () => {
      const name = /** @type {HTMLInputElement} */ (h("input", { type: "text", placeholder: "New state name", maxlength: "60", "aria-label": "New state name" }));
      const kind = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Kind of the new state" }, KINDS.map((k) => h("option", { value: k, selected: k === "started" }, KIND_LABELS[k]))));
      const color = /** @type {HTMLInputElement} */ (h("input", { type: "color", value: KIND_COLORS.started, "aria-label": "Colour of the new state" }));
      kind.addEventListener("change", () => { color.value = /** @type {any} */ (KIND_COLORS)[kind.value]; });
      const error = h("p", { class: "field-error", role: "alert" });
      const create = () => {
        const key = name.value.trim().toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^([0-9])/, "s_$1").slice(0, 40);
        const sameKind = index.states.filter((x) => x.kind === kind.value);
        const position = (sameKind.length ? Math.max(...sameKind.map((x) => x.position)) : Math.max(0, ...index.states.map((x) => x.position))) + 1;
        if (report(error, store.entity("work.state.create", { key, name: name.value, kind: kind.value, color: color.value, position }, { label: `Create state ${name.value.trim()}` }), `Sent: create state ${name.value.trim()}.`)) name.value = "";
      };
      name.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); create(); } });
      return [name, kind, color, h("button", { type: "button", class: "btn primary sm", onclick: create }, "Add state"), error];
    });
    return h("div", null, h("p", { class: "hint" }, "Columns follow these states. The kind decides the category (open, active, done) that reports and the v1 status use; a state that items use cannot change category."),
      h("ul", { class: "settings-list" }, rows), add);
  }

  /** @param {import("../../shared/model/index.js").WorkIndex} index @param {boolean} canWrite */
  function labels(index, canWrite) {
    const used = new Map();
    for (const item of index.itemList) for (const l of item.labels) used.set(l, (used.get(l) ?? 0) + 1);
    const rows = index.labels.map((l) => {
      const name = /** @type {HTMLInputElement} */ (h("input", { type: "text", value: l.name, maxlength: "60", "aria-label": `Name of label ${l.name}`, disabled: !canWrite }));
      const color = /** @type {HTMLInputElement} */ (h("input", { type: "color", value: l.color, "aria-label": `Colour of label ${l.name}`, disabled: !canWrite }));
      const error = h("p", { class: "field-error", role: "alert" });
      const save = (/** @type {Record<string, unknown>} */ extra = {}) => {
        /** @type {Record<string, unknown>} */
        const input = { id: l.id, ...extra };
        if (name.value.trim() !== l.name) input.name = name.value;
        if (color.value !== l.color) input.color = color.value;
        if (Object.keys(input).length === 1) { error.textContent = "Nothing has changed."; return; }
        report(error, store.entity("work.label.update", input, { label: `Update label ${l.name}`, revision: l.revision, itemId: l.id }), `Sent: update label ${l.name}.`);
      };
      return h("li", { class: `settings-row${l.archived ? " archived" : ""}` },
        h("span", { class: "dot lg", style: { background: l.color }, "aria-hidden": "true" }), name, color,
        h("span", { class: "muted" }, `${used.get(l.key) ?? 0} items`),
        canWrite ? h("span", { class: "row-actions" }, h("button", { type: "button", class: "btn sm", onclick: () => save() }, "Save"),
          h("button", { type: "button", class: "btn ghost sm", onclick: () => save({ archived: !l.archived }) }, l.archived ? "Restore" : "Archive")) : null,
        l.id ? pendingChip(l.id) : null, error);
    });
    const free = [...used.keys()].filter((k) => !index.labelByKey.has(k)).toSorted();
    const add = addRow("label", canWrite, () => {
      const name = /** @type {HTMLInputElement} */ (h("input", { type: "text", placeholder: "New label", maxlength: "60", "aria-label": "New label name" }));
      const color = /** @type {HTMLInputElement} */ (h("input", { type: "color", value: "#5e6ad2", "aria-label": "Colour of the new label" }));
      const error = h("p", { class: "field-error", role: "alert" });
      const create = () => { if (report(error, store.entity("work.label.create", { key: name.value.trim(), name: name.value, color: color.value }, { label: `Create label ${name.value.trim()}` }), `Sent: create label ${name.value.trim()}.`)) name.value = ""; };
      name.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); create(); } });
      return [name, color, h("button", { type: "button", class: "btn primary sm", onclick: create }, "Add label"), error];
    });
    return h("div", null, h("ul", { class: "settings-list" }, rows),
      free.length ? h("p", { class: "hint" }, `Also used without a colour: ${free.join(", ")}. Add one with the same name to give it a colour.`) : null, add);
  }

  /** @param {import("../../shared/model/index.js").WorkIndex} index @param {boolean} canWrite */
  function projects(index, canWrite) {
    const rows = index.projects.map((p) => {
      const name = /** @type {HTMLInputElement} */ (h("input", { type: "text", value: p.name, maxlength: "200", "aria-label": `Name of project ${p.name}`, disabled: !canWrite }));
      const state = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": `State of ${p.name}`, disabled: !canWrite }, PROJECT_STATES.map((s) => h("option", { value: s, selected: s === p.state }, s[0].toUpperCase() + s.slice(1)))));
      const target = /** @type {HTMLInputElement} */ (h("input", { type: "date", value: p.target ?? "", "aria-label": `Target date of ${p.name}`, disabled: !canWrite }));
      const color = /** @type {HTMLInputElement} */ (h("input", { type: "color", value: p.color, "aria-label": `Colour of ${p.name}`, disabled: !canWrite }));
      const error = h("p", { class: "field-error", role: "alert" });
      const save = () => {
        /** @type {Record<string, unknown>} */
        const input = { id: p.id };
        if (name.value.trim() !== p.name) input.name = name.value;
        if (state.value !== p.state) input.state = state.value;
        if ((target.value || null) !== p.target) input.target_date = target.value || null;
        if (color.value !== p.color) input.color = color.value;
        if (Object.keys(input).length === 1) { error.textContent = "Nothing has changed."; return; }
        report(error, store.entity("work.project.update", input, { label: `Update project ${p.name}`, revision: p.revision, itemId: p.id }), `Sent: update ${p.name}.`);
      };
      return h("li", { class: "settings-row" }, h("span", { class: "dot lg", style: { background: p.color }, "aria-hidden": "true" }), name, state, target, color,
        canWrite ? h("span", { class: "row-actions" }, h("button", { type: "button", class: "btn sm", onclick: save }, "Save")) : null, pendingChip(p.id), error);
    });
    const add = addRow("project", canWrite, () => {
      const name = /** @type {HTMLInputElement} */ (h("input", { type: "text", placeholder: "New project", maxlength: "200", "aria-label": "New project name" }));
      const error = h("p", { class: "field-error", role: "alert" });
      const create = () => { if (report(error, store.entity("work.project.create", { name: name.value, state: "planned" }, { label: `Create project ${name.value.trim()}` }), `Sent: create project ${name.value.trim()}.`)) name.value = ""; };
      name.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); create(); } });
      return [name, h("button", { type: "button", class: "btn primary sm", onclick: create }, "Add project"), error];
    });
    return h("div", null, h("ul", { class: "settings-list" }, rows), add);
  }

  /** @param {import("../../shared/model/index.js").WorkIndex} index @param {boolean} canWrite */
  function cycles(index, canWrite) {
    const today = o.today();
    const rows = index.cycles.map((cy) => {
      const current = cy.start && cy.end && cy.start <= today && today <= cy.end;
      const name = /** @type {HTMLInputElement} */ (h("input", { type: "text", value: cy.name, maxlength: "200", "aria-label": `Name of ${cy.name}`, disabled: !canWrite }));
      const start = /** @type {HTMLInputElement} */ (h("input", { type: "date", value: cy.start ?? "", "aria-label": `Start of ${cy.name}`, disabled: !canWrite }));
      const end = /** @type {HTMLInputElement} */ (h("input", { type: "date", value: cy.end ?? "", "aria-label": `End of ${cy.name}`, disabled: !canWrite }));
      const error = h("p", { class: "field-error", role: "alert" });
      const save = () => {
        /** @type {Record<string, unknown>} */
        const input = { id: cy.id };
        if (name.value.trim() && name.value.trim() !== cy.name) input.name = name.value;
        if (start.value !== (cy.start ?? "")) input.starts_on = start.value;
        if (end.value !== (cy.end ?? "")) input.ends_on = end.value;
        if (Object.keys(input).length === 1) { error.textContent = "Nothing has changed."; return; }
        report(error, store.entity("work.cycle.update", input, { label: `Update ${cy.name}`, revision: cy.revision, itemId: cy.id }), `Sent: update ${cy.name}.`);
      };
      return h("li", { class: `settings-row${current ? " current" : ""}` }, name, start, end, current ? h("span", { class: "chip" }, "Current") : null,
        canWrite ? h("span", { class: "row-actions" }, h("button", { type: "button", class: "btn sm", onclick: save }, "Save")) : null, pendingChip(cy.id), error);
    });
    const last = index.cycles.map((c) => c.end).filter(Boolean).toSorted().pop();
    const nextStart = last && last >= today ? addDays(/** @type {string} */ (last), 1) : today;
    const add = addRow("cycle", canWrite, () => {
      const start = /** @type {HTMLInputElement} */ (h("input", { type: "date", value: nextStart, "aria-label": "Start of the new cycle" }));
      const end = /** @type {HTMLInputElement} */ (h("input", { type: "date", value: addDays(nextStart, 13), "aria-label": "End of the new cycle" }));
      const error = h("p", { class: "field-error", role: "alert" });
      const create = () => { report(error, store.entity("work.cycle.create", { starts_on: start.value, ends_on: end.value }, { label: `Create a cycle from ${start.value}` }), "Sent: create cycle."); };
      return [start, end, h("button", { type: "button", class: "btn primary sm", onclick: create }, "Add cycle"), error];
    });
    return h("div", null, h("p", { class: "hint" }, "Cycles are numbered by Records and cannot overlap."), h("ul", { class: "settings-list" }, rows), add);
  }

  /** @param {string} what @param {boolean} canWrite @param {() => any[]} build */
  function addRow(what, canWrite, build) {
    if (!canWrite) return null;
    return h("div", { class: "settings-add", role: "group", "aria-label": `Add a ${what}` }, build());
  }

  renderTabs();
  renderPanel(true);
  return o.layers.openDialog({
    title: "Board settings", size: "lg", className: "settings",
    content: () => [tablist, panel],
    initialFocus: () => /** @type {HTMLElement|null} */ (tablist.querySelector('[aria-selected="true"]')),
    onClose: () => unsubscribe(),
  });
}
