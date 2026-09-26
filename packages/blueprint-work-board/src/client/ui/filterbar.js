// @ts-check
// The WQL filter bar: a text input with syntax highlighting (a mirrored, aria-hidden layer),
// autocomplete as an APG combobox, inline errors with position and "did you mean", the chips
// builder (each top-level term as a removable, editable chip that round-trips to WQL), and quick
// filters. The query is applied only when it is valid; until then the last valid query stays.

import { h, reconcile, setChildren } from "./dom.js";
import { icon } from "./icons.js";
import { check, describe, fieldByName, format, fromChips, hasTerm, highlight, parse, suggest, toChips, toggleTerm } from "../../shared/wql/index.js";

export const QUICK_FILTERS = [
  { id: "mine", label: "My issues", term: "assignee:me" },
  { id: "unassigned", label: "Unassigned", term: "is:unassigned" },
  { id: "blocked", label: "Blocked", term: "is:blocked" },
  { id: "overdue", label: "Overdue", term: "is:overdue" },
  { id: "cycle", label: "Current cycle", term: "cycle:current" },
];

/**
 * @typedef {{
 *   ctx: () => import("../../shared/wql/evaluate.js").WqlContext, planning: () => boolean,
 *   apply: (query: string) => void, announce: (text: string) => void, addFilter: (anchor: HTMLElement) => void,
 *   editChip: (chip: any, anchor: HTMLElement) => void,
 * }} FilterController
 */

/** @param {{ doc: Document, controller: FilterController }} opts */
export function createFilterBar({ doc, controller: c }) {
  const listId = "wb-wql-suggest";
  const input = /** @type {HTMLInputElement} */ (h("input", {
    type: "text", class: "wql-input", id: "wb-wql", role: "combobox", "aria-expanded": "false", "aria-controls": listId,
    "aria-autocomplete": "list", "aria-describedby": "wb-wql-status", autocomplete: "off", spellcheck: "false",
    placeholder: "Filter: assignee:me priority:<=high is:blocked “text”…",
  }));
  const layer = h("div", { class: "wql-layer", "aria-hidden": "true" });
  const list = h("ul", { id: listId, class: "wql-suggest", role: "listbox", "aria-label": "Suggestions", hidden: true });
  const clear = h("button", { type: "button", class: "icon-btn sm wql-clear", "aria-label": "Clear filter", title: "Clear filter", hidden: true, onclick: () => { input.value = ""; onInput(); applyNow(); input.focus(); } }, h("span", { class: "x", "aria-hidden": "true" }, "×"));
  const status = h("div", { id: "wb-wql-status", class: "wql-status" });
  const chipsEl = h("div", { class: "chips", role: "group", "aria-label": "Filters" });
  const quickEl = h("div", { class: "quick", role: "group", "aria-label": "Quick filters" });
  const field = h("div", { class: "wql-field" }, h("label", { for: "wb-wql", class: "wql-icon" }, icon("search"), h("span", { class: "sr-only" }, "Filter items (WQL)")), h("div", { class: "wql-wrap" }, layer, input), clear, list);
  const el = h("div", { class: "filterbar" }, h("div", { class: "filter-row" }, field, quickEl), h("div", { class: "filter-row second" }, chipsEl, status));

  let applied = "";
  /** @type {{ from: number, to: number, items: { label: string, insert: string, detail: string, kind: string }[] }} */
  let sugg = { from: 0, to: 0, items: [] };
  let active = -1;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  let count = { shown: 0, total: 0 };

  function paint() {
    const text = input.value;
    const tokens = highlight(text);
    /** @type {Node[]} */
    const out = [];
    let at = 0;
    for (const t of tokens) {
      if (t.start > at) out.push(doc.createTextNode(text.slice(at, t.start)));
      out.push(h("span", { class: `tk-${t.kind}` }, text.slice(t.start, t.end)));
      at = t.end;
    }
    if (at < text.length) out.push(doc.createTextNode(text.slice(at)));
    out.push(doc.createTextNode("​"));
    setChildren(layer, ...out);
    layer.scrollLeft = input.scrollLeft;
    clear.hidden = !text;
  }

  function validate() {
    const { ast, errors } = parse(input.value);
    const problems = errors.length ? errors : check(ast, c.ctx());
    return { ast, problems };
  }

  function renderStatus() {
    const { ast, problems } = validate();
    input.setAttribute("aria-invalid", String(problems.length > 0));
    field.classList.toggle("invalid", problems.length > 0);
    if (problems.length) {
      const p = problems[0];
      setChildren(status, h("span", { class: "wql-error", role: "alert" },
        `${p.message} (at character ${p.start + 1}).`, input.value.trim() !== applied.trim() ? " Showing the last valid filter." : ""),
        ...p.suggestions.slice(0, 3).map((s) => h("button", { type: "button", class: "btn ghost sm", onclick: () => fix(p, s) }, `Use “${s}”`)));
      return;
    }
    const text = describe(ast, c.ctx());
    setChildren(status, h("span", { class: "wql-desc" }, h("strong", null, `${count.shown.toLocaleString()} ${count.shown === 1 ? "item" : "items"}`), count.total !== count.shown ? ` of ${count.total.toLocaleString()}` : "", ` · ${text}`));
  }

  /** @param {{ start: number, end: number, message: string }} p @param {string} s */
  function fix(p, s) {
    const text = input.value;
    const slice = text.slice(p.start, p.end);
    const colon = slice.indexOf(":");
    // Replace the field name or the value, whichever the suggestion is for.
    let next;
    if (colon > 0 && fieldByName(s)) next = text.slice(0, p.start) + s + slice.slice(colon) + text.slice(p.end);
    else if (colon > 0) next = text.slice(0, p.start) + slice.slice(0, colon + 1) + (/\s/.test(s) ? `"${s}"` : s) + text.slice(p.end);
    else next = text.slice(0, p.start) + s + text.slice(p.end);
    input.value = next;
    onInput();
    applyNow();
    input.focus();
  }

  function applyNow() {
    const { ast, problems } = validate();
    if (problems.length) { renderStatus(); return; }
    const canonical = input.value.trim() ? format(ast) : "";
    if (canonical !== applied) { applied = canonical; c.apply(canonical); }
    renderStatus();
    renderChips();
  }

  function onInput() {
    paint();
    updateSuggestions();
    if (timer) clearTimeout(timer);
    timer = setTimeout(applyNow, 180);
  }

  function updateSuggestions() {
    if (doc.activeElement !== input) { closeList(); return; }
    sugg = suggest(input.value, input.selectionStart ?? input.value.length, c.ctx());
    const items = sugg.items.slice(0, 12);
    if (!items.length) { closeList(); return; }
    active = -1;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    reconcile(list, items, {
      key: (s) => `${s.kind}:${s.insert}`,
      create: () => h("li", { role: "option", class: "wql-opt", onmousedown: (/** @type {Event} */ e) => e.preventDefault() }),
      update: (node, s) => {
        const i = items.indexOf(s);
        node.id = `${listId}-${i}`;
        node.setAttribute("aria-selected", String(i === active));
        setChildren(node, h("span", { class: `tk-${s.kind === "field" ? "field" : s.kind === "keyword" ? "keyword" : "value"}` }, s.label), s.detail ? h("span", { class: "opt-detail" }, s.detail) : null);
        /** @type {HTMLElement} */ (node).dataset.insert = String(i);
      },
    });
  }

  function closeList() {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  }

  /** @param {{ insert: string }} s */
  function accept(s) {
    const text = input.value;
    const next = text.slice(0, sugg.from) + s.insert + text.slice(sugg.to);
    input.value = next;
    const caret = sugg.from + s.insert.length;
    input.setSelectionRange(caret, caret);
    onInput();
  }

  /** @param {number} delta */
  function moveActive(delta) {
    const n = list.children.length;
    if (!n) return;
    active = (active + delta + n) % n;
    for (const [i, li] of [...list.children].entries()) li.setAttribute("aria-selected", String(i === active));
    input.setAttribute("aria-activedescendant", `${listId}-${active}`);
    list.children[active]?.scrollIntoView?.({ block: "nearest" });
  }

  list.addEventListener("click", (e) => {
    const li = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest("[data-insert]"));
    const s = li ? sugg.items[Number(li.dataset.insert)] : null;
    if (s) accept(s);
  });
  input.addEventListener("input", onInput);
  input.addEventListener("scroll", () => { layer.scrollLeft = input.scrollLeft; });
  input.addEventListener("focus", () => updateSuggestions());
  input.addEventListener("click", () => updateSuggestions());
  input.addEventListener("blur", () => setTimeout(closeList, 100));
  input.addEventListener("keydown", (e) => {
    const open = !list.hidden;
    if (e.key === "ArrowDown") { e.preventDefault(); if (!open) updateSuggestions(); else moveActive(1); }
    else if (e.key === "ArrowUp" && open) { e.preventDefault(); moveActive(-1); }
    else if ((e.key === "Enter" || e.key === "Tab") && open && active >= 0) {
      e.preventDefault();
      const s = sugg.items[active];
      if (s) accept(s);
    } else if (e.key === "Enter") { e.preventDefault(); closeList(); if (timer) clearTimeout(timer); applyNow(); }
    else if (e.key === "Escape") {
      if (open) { e.preventDefault(); e.stopPropagation(); closeList(); }
      else { e.preventDefault(); e.stopPropagation(); input.blur(); c.announce("Left the filter."); }
    }
  });

  function renderChips() {
    const { ast, errors } = parse(applied);
    const { chips, rest } = errors.length ? { chips: [], rest: [] } : toChips(ast);
    /** @type {any[]} */
    const nodes = chips.map((chip, i) => h("span", { class: `chip filter-chip${chip.negated ? " negated" : ""}` },
      h("button", { type: "button", class: "chip-main", title: "Change this filter", "aria-haspopup": "dialog", onclick: (/** @type {Event} */ e) => c.editChip({ chip, index: i, chips, rest, sort: ast.sort }, /** @type {HTMLElement} */ (e.currentTarget)) }, chip.text),
      h("button", { type: "button", class: "chip-x", "aria-label": `Remove filter ${chip.text}`, onclick: () => {
        const next = format(fromChips(chips.filter((_, j) => j !== i), rest, ast.sort));
        setQuery(next, true);
        c.announce(`Removed filter ${chip.text}.`);
      } }, h("span", { "aria-hidden": "true" }, "×"))));
    if (rest.length) nodes.push(h("span", { class: "chip filter-chip advanced", title: "Edit in the filter box" }, rest.map((r) => format({ type: "query", where: r, sort: [] })).join(" ")));
    nodes.push(h("button", { type: "button", class: "btn ghost sm add-filter", "aria-haspopup": "dialog", onclick: (/** @type {Event} */ e) => c.addFilter(/** @type {HTMLElement} */ (e.currentTarget)) }, icon("plus", { size: 14 }), "Filter"));
    setChildren(chipsEl, ...nodes);
    const planning = c.planning();
    setChildren(quickEl, ...QUICK_FILTERS.filter(() => planning).map((q) => {
      const on = hasTerm(applied, q.term);
      return h("button", { type: "button", class: `btn toggle sm${on ? " on" : ""}`, "aria-pressed": String(on), title: q.term, onclick: () => {
        setQuery(toggleTerm(applied, q.term), true);
        c.announce(`${q.label} filter ${on ? "off" : "on"}.`);
      } }, q.label);
    }));
  }

  /** @param {string} query @param {boolean} [apply] */
  function setQuery(query, apply = false) {
    input.value = query;
    paint();
    if (apply) applyNow();
    else { applied = query; renderStatus(); renderChips(); }
  }

  return {
    el, input,
    setQuery,
    /** @param {{ shown: number, total: number }} next */
    setCount(next) { count = next; renderStatus(); },
    refresh() { renderStatus(); renderChips(); },
    get applied() { return applied; },
    focus() { input.focus(); input.select(); },
  };
}
