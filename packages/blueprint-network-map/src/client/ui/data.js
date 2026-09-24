// @ts-check
// The Data panel: file and paste imports (docs/plans/network-map-blueprint.md §6.5) through
// reviewed changesets (§7.3, src/core/changesets.js), the list of imports with undo (§8.1), and
// in-app copies of the Kumu JSON and CSV exports (§5.9).
//
// Import flow: the browser parses the text into an ImportPlan (src/shared/imports.js) and shows
// its preview; "Continue to review" stages the items on the server (create, add in chunks,
// finalise), which resolves them against the map; the reviewer changes per-item decisions; Accept
// binds the digest the reviewer saw. acceptChangeset resolves only when the whole job is done, so
// the panel never waits on it for its display: progress and the outcome come from the manifests
// in store.changesets, which every pane receives. Drafts and the open changeset live in module
// memory, so switching tabs keeps them.

import { h, clear, formatTime } from "./dom.js";
import { modal } from "./dialogs.js";
import { ensureStyle } from "./css.js";
import { toKumuJson, toElementsCsv, toConnectionsCsv } from "../../shared/exports.js";
import {
  FORMATS, REVIEW_PAGE, STAGE_CHUNK, ACTION_LABELS, acceptCounts, acceptLabel, bulkDecisions, chunk, countRows,
  countWritable, currentDecision, decisionFor, decisionOptions, delimiterName, detectFormat, effectiveAction,
  exportFileName, groupUndoState, hasDecodingErrors, importedElementIds, kindTotals, manifestSummary, planFor,
  planSummary, plural, progressOf, sheetKind, sourceNameFromFile, statusLabel, storedMapOf, undoMessage,
} from "./data-logic.js";

/** Up to this many items, the accept label is counted exactly from every item. */
const EXACT_COUNT_ITEMS = 5000;
/** An "applying" import with no progress for this long is offered "Resume". */
const STALLED_MS = 15_000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_LIST = 30;
/** The server's cap on decisions per setDecisions call. */
const DECISIONS_PER_CALL = 5000;

const STYLE = String.raw`
.nm-data { display: flex; flex-direction: column; margin: -12px; }
.nm-data .nm-section { gap: 8px; padding: 12px; }
.nm-data .nm-section:last-child { border-bottom: 0; }
.nm-data fieldset { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.nm-data legend { padding: 0; margin-bottom: 4px; color: var(--text-2); font-size: 13px; }
.nm-data .radio { display: flex; gap: 6px; align-items: center; color: var(--text); font-size: 13px; }
.nm-data .stack { display: flex; flex-direction: column; gap: 10px; }
.nm-data textarea.code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; min-height: 84px; white-space: pre; overflow-wrap: normal; overflow-x: auto; }
.nm-data .label-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.nm-data .hint { font-size: 12px; color: var(--text-3); margin: 0; }
.nm-data .actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.nm-data .actions .btn { white-space: normal; text-align: left; }
.nm-data .preview { display: flex; flex-direction: column; gap: 8px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); }
.nm-data h4 { font-size: 12px; font-weight: 600; color: var(--text-2); margin: 0; }
.nm-data .preview .summary { font-weight: 600; margin: 0; }
.nm-data .kv { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; font-size: 13px; margin: 0; }
.nm-data .kv dt { color: var(--text-3); }
.nm-data .kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.nm-data .chips { display: flex; flex-wrap: wrap; gap: 4px; }
.nm-data ul.plain { margin: 0; padding-left: 18px; font-size: 13px; display: flex; flex-direction: column; gap: 2px; }
.nm-data ul.plain li { overflow-wrap: anywhere; }
.nm-data .field-list { display: flex; flex-direction: column; gap: 4px; font-size: 13px; margin: 0; padding: 0; list-style: none; }
.nm-data .field-list .kind { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; color: var(--accent); margin-left: 6px; }
.nm-data .field-list .sample { color: var(--text-3); font-size: 12px; overflow-wrap: anywhere; }
.nm-data .status-line { font-size: 13px; color: var(--text-2); margin: 0; }
.nm-data .status-line:empty { display: none; }
.nm-data .status-line.error { color: var(--danger); }
.nm-data .status-line.ok { color: var(--ok); }
.nm-data progress { width: 100%; height: 8px; accent-color: var(--accent); }
.nm-data .counts { display: flex; flex-wrap: wrap; gap: 4px; }
.nm-data .chip[data-action="create"], .nm-data .chip[data-status="applied"] { border-color: var(--ok); color: var(--ok); }
.nm-data .chip[data-action="update"], .nm-data .chip[data-action="use-existing"], .nm-data .chip[data-status="review"] { border-color: var(--accent); color: var(--accent); }
.nm-data .chip[data-action="invalid"], .nm-data .chip[data-status="failed"] { border-color: var(--danger); color: var(--danger); }
.nm-data .chip[data-action="blocked"], .nm-data .chip[data-status="partial"], .nm-data .chip[data-status="applying"], .nm-data .chip[data-status="staging"] { border-color: var(--warn); color: var(--warn); }
.nm-data .review-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.nm-data .review-head strong { font-size: 15px; overflow-wrap: anywhere; }
.nm-data .review-table { table-layout: fixed; }
.nm-data .review-table th, .nm-data .review-table td { white-space: normal; max-width: none; vertical-align: top; padding: 6px; }
.nm-data .review-table th:last-child, .nm-data .review-table td:last-child { width: 46%; }
.nm-data .review-table select { width: 100%; font-size: 12px; padding: 3px 4px; }
.nm-data .review-table .item-label { overflow-wrap: anywhere; color: var(--text); }
.nm-data .review-table .item-kind { font-size: 11px; color: var(--text-3); text-transform: uppercase; letter-spacing: .03em; }
.nm-data .review-table .item-problems { margin: 2px 0 0; padding-left: 14px; font-size: 12px; color: var(--warn); }
.nm-data .review-table .item-problems.bad { color: var(--danger); }
.nm-data .review-table .fixed-action { font-size: 12px; color: var(--text-2); overflow-wrap: anywhere; }
.nm-data .pager { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 12px; color: var(--text-3); }
.nm-data .small-print { font-size: 12px; color: var(--text-3); margin: 0; }
.nm-data .imports { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.nm-data .imports > li { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; }
.nm-data .imports > li.empty { border: 0; padding: 0; }
.nm-data .imports .row-head { display: flex; justify-content: space-between; gap: 6px; align-items: baseline; }
.nm-data .imports .name { font-weight: 600; overflow-wrap: anywhere; }
.nm-data .imports .meta { font-size: 12px; color: var(--text-3); }
.nm-export-modal a.btn { text-decoration: none; }
.nm-export-modal textarea { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; min-height: 280px; white-space: pre; overflow-wrap: normal; }
`;

/**
 * Module memory: survives the panel being unmounted when another tab is chosen. `local` holds
 * what only the staging pane knows about a changeset: item totals per kind and items the server
 * refused while staging.
 */
const memory = {
  /** @type {import("./data-logic.js").ImportFormat} */ format: "kumu-sheets",
  elements: "", connections: "", edges: "", json: "", sourceName: "", sourceAuto: true,
  /** @type {string|null} */ activeId: null,
  /** @type {Map<string, {totals: {element: number, connection: number}, refused: {index: number, message: string}[]}>} */
  local: new Map(),
};

let mountSeq = 0;

/** @param {unknown} e */
const messageOf = (e) => String(/** @type {any} */ (e)?.message ?? e).replace(/^Error:\s*/, "").slice(0, 240);

/** @param {string} s */
const cssEscape = (s) => (typeof globalThis.CSS?.escape === "function" ? globalThis.CSS.escape(s) : s.replace(/["\\]/g, "\\$&"));

/**
 * Focuses the element with `data-key` = key inside `root` (focus survives a re-render).
 * @param {HTMLElement} root @param {string|undefined} key
 */
function refocus(root, key) {
  if (!key) return;
  const el = /** @type {HTMLElement|null} */ (root.querySelector(`[data-key="${cssEscape(key)}"]`));
  if (el && !(/** @type {any} */ (el).disabled)) el.focus();
}

/**
 * @param {HTMLElement} host
 * @param {any} app
 */
export function mountData(host, app) {
  ensureStyle("nm-data", STYLE);
  const store = app.store;
  const seq = ++mountSeq;
  let destroyed = false;
  /** @type {(() => void)[]} */
  const cleanups = [];

  // --- Import form ----------------------------------------------------------------------------

  const formStatus = h("p", { class: "status-line", role: "status", "aria-live": "polite" });
  const formError = h("p", { class: "status-line error", role: "alert" });
  /** @param {string} text */
  const say = (text) => { formStatus.textContent = text; };

  /**
   * A textarea with a label and a "Load file…" button.
   * @param {{key: "elements"|"connections"|"edges"|"json", label: string, hint: string, accept: string, placeholder: string}} o
   */
  function input(o) {
    const id = `nm-data-${o.key}-${seq}`;
    const area = /** @type {HTMLTextAreaElement} */ (h("textarea", {
      id, class: "code", rows: "5", spellcheck: "false", placeholder: o.placeholder, value: memory[o.key],
      "aria-describedby": `${id}-hint`,
      oninput: () => { memory[o.key] = area.value; markStale(); },
    }));
    const file = /** @type {HTMLInputElement} */ (h("input", {
      type: "file", accept: o.accept, class: "sr-only", tabindex: "-1", "aria-hidden": "true",
      onchange: () => { const f = file.files?.[0]; file.value = ""; if (f) loadFile(f, o.key); },
    }));
    const loadBtn = h("button", { type: "button", class: "btn small outline", onclick: () => file.click(), "aria-label": `Load the ${o.label.toLowerCase()} from a file` }, "Load file…");
    const wrap = h("div", { class: "field-row" },
      h("div", { class: "label-row" }, h("label", { for: id }, o.label), loadBtn),
      area, file, h("p", { class: "hint", id: `${id}-hint` }, o.hint));
    return { wrap, area };
  }

  const TABLE_ACCEPT = ".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain";
  const inputs = {
    elements: input({
      key: "elements", label: "Elements sheet", accept: TABLE_ACCEPT, placeholder: "Label\tType\tDescription\tTags\t…",
      hint: "Paste from Excel or Google Sheets (tab-separated), or CSV. Columns: Label, Type, Description, Tags, then your own fields.",
    }),
    connections: input({
      key: "connections", label: "Connections sheet", accept: TABLE_ACCEPT, placeholder: "From\tTo\tType\tDirection\t…",
      hint: "Columns: From, To, Type, Direction, Label, Strength, then your own fields. Endpoints that are not elements are created.",
    }),
    edges: input({
      key: "edges", label: "Edge list", accept: TABLE_ACCEPT, placeholder: "From,To,Type,Weight",
      hint: "One connection per row: From and To (or Source and Target), optionally Type, Label and Weight. Elements are created from the names.",
    }),
    json: input({
      key: "json", label: "Kumu JSON", accept: ".json,application/json", placeholder: '{"elements": [...], "connections": [...]}',
      hint: "A Kumu project export or blueprint. Loops, perspectives and images are reported as skipped.",
    }),
  };

  const sourceId = `nm-data-source-${seq}`;
  const sourceInput = /** @type {HTMLInputElement} */ (h("input", {
    id: sourceId, type: "text", maxlength: "120", value: memory.sourceName, placeholder: "e.g. Partners 2026",
    "aria-describedby": `${sourceId}-hint`,
    oninput: () => { memory.sourceName = sourceInput.value; memory.sourceAuto = !sourceInput.value.trim(); markStale(); },
  }));

  const formatName = `nm-data-format-${seq}`;
  /** @type {HTMLInputElement[]} */
  const radios = [];
  const formatField = h("fieldset", null, h("legend", null, "Format"), FORMATS.map((f) => {
    const radio = /** @type {HTMLInputElement} */ (h("input", {
      type: "radio", name: formatName, value: f.id, checked: memory.format === f.id,
      onchange: () => { if (radio.checked) setFormat(f.id); },
    }));
    radios.push(radio);
    return h("label", { class: "radio" }, radio, f.label);
  }));

  const previewHost = h("div", { class: "preview", hidden: true, role: "region", "aria-label": "Import preview" });
  const previewBtn = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn outline", onclick: () => preview() }, "Preview"));
  const continueBtn = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn primary", disabled: true, onclick: () => stage() }, "Continue to review"));
  const stageProgress = /** @type {HTMLProgressElement} */ (h("progress", { max: "1", value: "0", hidden: true, "aria-label": "Staging progress" }));

  const form = h("div", { class: "stack" },
    formatField, inputs.elements.wrap, inputs.connections.wrap, inputs.edges.wrap, inputs.json.wrap,
    h("div", { class: "field-row" },
      h("label", { for: sourceId }, "Source name"), sourceInput,
      h("p", { class: "hint", id: `${sourceId}-hint` }, "Importing again with the same source name updates the elements it created instead of duplicating them.")),
    h("div", { class: "actions" }, previewBtn, continueBtn),
    stageProgress, formStatus, formError, previewHost);

  /** @param {import("./data-logic.js").ImportFormat} format */
  function setFormat(format) {
    memory.format = format;
    for (const r of radios) r.checked = r.value === format;
    inputs.elements.wrap.hidden = inputs.connections.wrap.hidden = format !== "kumu-sheets";
    inputs.edges.wrap.hidden = format !== "edge-list";
    inputs.json.wrap.hidden = format !== "kumu-json";
    markStale();
  }

  /** @type {ReturnType<typeof planFor>|null} */
  let plan = null;
  let decodeWarning = "";

  function markStale() {
    if (!plan) return;
    plan = null;
    continueBtn.disabled = true;
    say("The input changed: preview again before continuing.");
  }

  /** @param {File} f @param {"elements"|"connections"|"edges"|"json"} key */
  async function loadFile(f, key) {
    formError.textContent = "";
    if (f.size > MAX_FILE_BYTES) { formError.textContent = `“${f.name}” is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`; return; }
    if (/\.xlsx?$/i.test(f.name)) { formError.textContent = "Excel files cannot be read here yet: save each sheet as CSV, or copy the cells and paste them."; return; }
    let text;
    try { text = await f.text(); } catch (e) { formError.textContent = `Could not read “${f.name}”: ${messageOf(e)}`; return; }
    decodeWarning = hasDecodingErrors(text) ? `“${f.name}” is not UTF-8, so some characters could not be read. Save it as “CSV UTF-8” and load it again.` : "";
    let note = `Loaded “${f.name}”.`;
    const kind = sheetKind(text);
    if (key !== "json" && detectFormat(f.name, text) === "kumu-json") {
      key = "json";
      setFormat("kumu-json");
      note = `“${f.name}” is JSON, so the format is now Kumu JSON.`;
    } else if (key === "elements" && kind === "connections") {
      key = "connections";
      note = `“${f.name}” looks like a Connections sheet, so it went there.`;
    } else if (key === "connections" && kind === "elements") {
      key = "elements";
      note = `“${f.name}” looks like an Elements sheet, so it went there.`;
    }
    inputs[key].area.value = text;
    memory[key] = text;
    if (memory.sourceAuto || !sourceInput.value.trim()) {
      sourceInput.value = memory.sourceName = sourceNameFromFile(f.name);
      memory.sourceAuto = true;
    }
    markStale();
    say(note);
  }

  function currentInput() {
    return { format: memory.format, elements: memory.elements, connections: memory.connections, edges: memory.edges, json: memory.json, sourceName: sourceInput.value };
  }

  function preview() {
    formError.textContent = "";
    try {
      plan = planFor(currentInput());
    } catch (e) {
      plan = null;
      formError.textContent = "Could not read the input: " + messageOf(e);
      return;
    }
    renderPreview(plan);
    const p = plan.preview;
    continueBtn.disabled = !(p.elements || p.connections);
    say(p.elements || p.connections ? `Preview ready: ${planSummary(p)}.` : "Nothing to import yet.");
  }

  /** @param {NonNullable<typeof plan>} pl */
  function renderPreview(pl) {
    const p = pl.preview;
    clear(previewHost);
    previewHost.hidden = false;
    const kv = h("dl", { class: "kv" });
    const row = (/** @type {string} */ k, /** @type {any} */ v) => kv.append(h("dt", null, k), h("dd", null, v));
    row("Format", FORMATS.find((f) => f.id === pl.format)?.label ?? pl.format);
    row("Source", pl.source);
    if (pl.format !== "kumu-json") {
      row("Encoding", decodeWarning ? "Not UTF-8 (characters lost)" : "UTF-8");
      row("Delimiter", delimiterName(p.delimiter));
    }
    for (const [k, list] of Object.entries(p.headers ?? {})) {
      if (!list?.length) continue;
      row(k === "elements" ? "Element columns" : "Connection columns", h("span", { class: "chips" }, list.map((c) => h("span", { class: "chip" }, c || "(blank)"))));
    }
    if (p.types.length) row("Types", h("span", { class: "chips" }, p.types.map((t) => h("span", { class: "chip" }, t))));
    previewHost.append(h("p", { class: "summary" }, planSummary(p)), kv);
    if (p.fields.length) {
      previewHost.append(h("h4", null, "Fields"), h("ul", { class: "field-list", "aria-label": "Fields" }, p.fields.map((f) => h("li", { dataset: { field: f.name } },
        h("span", null, f.name), h("span", { class: "kind", dataset: { kind: f.kind } }, f.kind),
        h("span", { class: "muted" }, f.appliesTo === "both" ? " · elements and connections" : ` · ${f.appliesTo}s`),
        f.sample.length ? h("div", { class: "sample" }, "e.g. " + f.sample.join(", ")) : null))));
    }
    /** @param {string} title @param {string[]} items @param {string} [extra] */
    const list = (title, items, extra) => {
      if (!items.length && !extra) return;
      previewHost.append(h("h4", null, title), h("ul", { class: "plain" }, items.map((t) => h("li", null, t)), extra ? h("li", { class: "muted" }, extra) : null));
    };
    list("Duplicate keys (later rows left out)", p.duplicateKeys);
    list("Labels used by more than one element", p.duplicateLabels);
    list("Endpoints not in the elements table", p.unresolved, p.autoCreated ? `${plural(p.autoCreated, "element")} will be created for them` : "");
    list("Not imported", p.skipped);
    list("Problems", [...(decodeWarning ? [decodeWarning] : []), ...p.problems]);
  }

  /** Stages the plan on the server and opens its review. */
  async function stage() {
    const pl = plan ?? planFor(currentInput());
    if (!pl.items.length) { formError.textContent = "Nothing to import."; return; }
    formError.textContent = "";
    continueBtn.disabled = true;
    previewBtn.disabled = true;
    stageProgress.hidden = false;
    stageProgress.value = 0;
    const name = sourceInput.value.trim() || pl.sourceName;
    /** @type {any} */
    let m = null;
    try {
      m = await store.call("createChangeset", { name, source: pl.source, format: pl.format, by: app.by });
      /** @type {{index: number, message: string}[]} */
      const refused = [];
      let sent = 0;
      for (const [n, part] of chunk(pl.items, STAGE_CHUNK).entries()) {
        say(`Staging ${sent.toLocaleString("en")} of ${plural(pl.items.length, "item")}…`);
        const r = await store.call("addChangesetItems", { changesetId: m.id, items: part });
        for (const e of r.errors ?? []) refused.push({ index: e.index + n * STAGE_CHUNK, message: e.message });
        sent += part.length;
        stageProgress.value = sent / pl.items.length;
      }
      say("Checking the items against the map…");
      const refusedAt = new Set(refused.map((r) => r.index));
      memory.local.set(m.id, { totals: kindTotals(pl.items.filter((_, i) => !refusedAt.has(i))), refused });
      await store.call("finalizeChangeset", { changesetId: m.id });
      say("");
      plan = null;
      clear(previewHost);
      previewHost.hidden = true;
      memory.activeId = m.id;
      if (!destroyed) await openChangeset(m.id);
    } catch (e) {
      formError.textContent = m
        ? `Staging failed: ${messageOf(e)}. The staged part is listed under Imports, where it can be discarded.`
        : `Could not start the import: ${messageOf(e)}`;
      say("");
    } finally {
      stageProgress.hidden = true;
      previewBtn.disabled = false;
      continueBtn.disabled = !plan;
    }
  }

  // --- Review ---------------------------------------------------------------------------------

  /**
   * @typedef {{id: string, manifest: any, filter: "all"|"problems", cursor: number, page: any[],
   *   next: number|null, total: number, loading: boolean, counts: {elements: number, connections: number}|null,
   *   outcome: {failed: any[], kept: boolean}|null, busy: string, accepting: boolean, digestShown: string}} Active
   */
  /** @type {Active|null} */
  let active = null;

  const reviewHost = h("div", { class: "stack review", hidden: true });
  const reviewStatus = h("p", { class: "status-line", role: "status", "aria-live": "polite" });
  const reviewError = h("p", { class: "status-line error", role: "alert" });

  /** @param {any} a @param {any} b  the manifest updated last wins */
  const newer = (a, b) => (!b || (a && (a.updatedAt ?? 0) >= (b.updatedAt ?? 0)) ? a : b);

  /** @param {string} id */
  async function openChangeset(id) {
    memory.activeId = id;
    const m = store.changesets.get(id);
    active = {
      id, manifest: m ?? { id, status: "review", name: "Import", counts: {} }, filter: "all", cursor: 0, page: [], next: null, total: 0,
      loading: true, counts: null, outcome: null, busy: "", accepting: false, digestShown: m?.digest ?? "",
    };
    reviewStatus.textContent = reviewError.textContent = "";
    showMode();
    renderActive();
    await refreshActive({ page: true, count: true });
  }

  function closeChangeset() {
    memory.activeId = null;
    active = null;
    reviewStatus.textContent = reviewError.textContent = "";
    showMode();
    renderList();
    previewBtn.focus();
  }

  /**
   * Reloads what the open changeset shows. `page`: the item page; `count`: the accept label.
   * @param {{page?: boolean, count?: boolean}} what
   * @returns {Promise<void>}
   */
  async function refreshActive(what) {
    const a = active;
    if (!a) return;
    try {
      if (what.page) {
        a.loading = true;
        const r = await store.call("getChangeset", { changesetId: a.id, cursor: a.cursor, limit: REVIEW_PAGE, filter: a.filter });
        if (active !== a) return;
        a.manifest = newer(r.changeset, a.manifest);
        a.page = r.items;
        a.next = r.next;
        a.total = r.total;
        a.loading = false;
        if (!r.items.length && a.cursor > 0) { a.cursor = 0; return refreshActive(what); }
      }
      if (what.count && a.manifest.status === "review") a.counts = await countFor(a);
      a.digestShown = a.manifest.digest;
      if (a.manifest.status === "applied" || a.manifest.status === "partial") await loadOutcome(a);
    } catch (e) {
      if (active === a) {
        a.loading = false;
        reviewError.textContent = /No changeset/.test(messageOf(e)) ? "This import no longer exists." : "Could not load the import: " + messageOf(e);
      }
    }
    if (active === a && !destroyed) renderActive();
  }

  /**
   * What accepting will write: exact (every item read) up to EXACT_COUNT_ITEMS items, otherwise
   * estimated from the staged totals and the manifest's counts; null when neither is known.
   * @param {Active} a
   */
  async function countFor(a) {
    const m = a.manifest;
    if ((m.items ?? 0) <= EXACT_COUNT_ITEMS) return countWritable(await allItems(a.id, "all"));
    const local = memory.local.get(a.id);
    if (!local) return null;
    const c = m.counts ?? {};
    return acceptCounts(local.totals, { skipped: { element: c.skip ?? 0 }, invalid: { connection: c.invalid ?? 0 }, blocked: c.blocked ?? 0 });
  }

  /** @param {string} id @param {"all"|"problems"} filter */
  async function allItems(id, filter) {
    const out = [];
    /** @type {number|null} */
    let cursor = 0;
    while (cursor !== null) {
      /** @type {any} */
      const r = await store.call("getChangeset", { changesetId: id, cursor, limit: 500, filter });
      out.push(...r.items);
      cursor = r.next;
    }
    return out;
  }

  /** @param {Active} a */
  async function loadOutcome(a) {
    if (!a.manifest.chunks) { a.outcome = { failed: [], kept: false }; return; }
    const problems = await allItems(a.id, "problems");
    a.outcome = { failed: problems.filter((it) => it.state === "failed"), kept: true };
  }

  /**
   * Sends decisions and reloads.
   * @param {{iid: string, action: string, targetId?: string}[]} decisions @param {string} doneText
   */
  async function decide(decisions, doneText) {
    const a = active;
    if (!a) return;
    if (!decisions.length) { reviewStatus.textContent = "Nothing to change."; return; }
    a.busy = "Updating…";
    renderActive();
    try {
      for (const part of chunk(decisions, DECISIONS_PER_CALL)) {
        const r = await store.call("setDecisions", { changesetId: a.id, decisions: part });
        a.manifest = newer(r.changeset, a.manifest);
      }
      reviewError.textContent = "";
      a.busy = "";
      await refreshActive({ page: true, count: true });
      reviewStatus.textContent = doneText;
    } catch (e) {
      a.busy = "";
      reviewError.textContent = "Could not change the decision: " + messageOf(e);
      await refreshActive({ page: true, count: true });
    }
  }

  /** @param {"use-existing-single"|"create-label-matches"|"skip-invalid"} mode */
  async function bulk(mode) {
    const a = active;
    if (!a) return;
    a.busy = "Reading the items…";
    renderActive();
    let items;
    try {
      items = await allItems(a.id, "problems");
    } catch (e) {
      a.busy = "";
      reviewError.textContent = "Could not read the items: " + messageOf(e);
      renderActive();
      return;
    }
    a.busy = "";
    const decisions = bulkDecisions(items, mode);
    if (!decisions.length) { reviewStatus.textContent = "Nothing to change."; renderActive(); return; }
    await decide(decisions, `Changed ${plural(decisions.length, "item")}.`);
  }

  async function accept() {
    const a = active;
    if (!a || a.accepting) return;
    const m = store.changesets.get(a.id) ?? a.manifest;
    if (m.digest !== a.digestShown) {
      reviewError.textContent = "The import changed since it was shown here (someone may have changed a decision). Check it again, then accept.";
      await refreshActive({ page: true, count: true });
      return;
    }
    a.accepting = true;
    reviewError.textContent = "";
    reviewStatus.textContent = "Importing…";
    renderActive();
    try {
      const result = await store.call("acceptChangeset", { changesetId: a.id, digest: m.digest, by: app.by, senderId: store.viewer.clientId });
      if (active === a && result) {
        a.manifest = newer(result, a.manifest);
        reviewStatus.textContent = a.manifest.status === "partial" ? "Imported, but some items failed." : "Imported.";
        app.announce(reviewStatus.textContent);
      }
    } catch (e) {
      if (active === a) reviewError.textContent = `The import stopped: ${messageOf(e)}. What was applied stays; resume it to finish.`;
    }
    if (active === a) {
      a.accepting = false;
      await refreshActive({ page: false });
    }
  }

  async function resume() {
    const a = active;
    if (!a || a.accepting) return;
    a.accepting = true;
    reviewError.textContent = "";
    renderActive();
    try {
      const result = await store.call("resumeChangeset", { changesetId: a.id, by: app.by, senderId: store.viewer.clientId });
      if (active === a && result) a.manifest = newer(result, a.manifest);
    } catch (e) {
      if (active === a) reviewError.textContent = "Could not resume: " + messageOf(e);
    }
    if (active === a) { a.accepting = false; await refreshActive({ page: false }); }
  }

  async function discard() {
    const a = active;
    if (!a) return;
    a.busy = "Discarding…";
    renderActive();
    try {
      await store.call("rejectChangeset", { changesetId: a.id });
      memory.local.delete(a.id);
      closeChangeset();
      say("Import discarded.");
    } catch (e) {
      a.busy = "";
      reviewError.textContent = "Could not discard: " + messageOf(e);
      renderActive();
    }
  }

  /** Selects what the import wrote: its applied element items, else its source's elements. */
  async function selectImported() {
    const a = active;
    if (!a) return;
    /** @type {string[]} */
    let ids = [];
    try {
      if (a.manifest.chunks) {
        const items = await allItems(a.id, "all");
        ids = items.filter((it) => it.data?.kind === "element" && it.state === "applied" && it.targetId && store.objects.has(it.targetId)).map((it) => it.targetId);
      }
    } catch { /* fall back to provenance below */ }
    if (!ids.length) ids = importedElementIds(store.objects.values(), a.manifest);
    if (!ids.length) { reviewStatus.textContent = "None of the imported elements are on the map any more."; return; }
    app.select(ids, { announce: false });
    reviewStatus.textContent = `Selected ${plural(ids.length, "imported element")}.`;
    app.announce(reviewStatus.textContent);
  }

  /** @param {any} it */
  function itemLabel(it) {
    const d = it.data ?? {};
    if (d.kind === "element") return d.type ? `${d.label} · ${d.type}` : d.label;
    if (d.kind === "connection") return `${d.from} → ${d.to}${d.type ? ` · ${d.type}` : ""}${d.label ? ` “${d.label}”` : ""}`;
    if (d.kind === "type") return `${d.name} (${d.appliesTo} type)`;
    if (d.kind === "field") return `${d.name} (${d.fieldKind} field)`;
    return it.iid;
  }

  /** @param {Active} a @param {any} it */
  function decisionCell(a, it) {
    const opts = decisionOptions(it);
    const label = itemLabel(it);
    const action = effectiveAction(it);
    if (it.invalid || opts.length === 1) {
      return h("span", { class: "fixed-action", dataset: { action } }, ACTION_LABELS[action] ?? action, it.target && it.action !== "create" ? `: ${it.target.label}` : "");
    }
    const locked = a.manifest.status !== "review" || !!a.busy || a.accepting;
    const value = currentDecision(it);
    const select = /** @type {HTMLSelectElement} */ (h("select", {
      "aria-label": `Action for ${label}`, dataset: { key: `decision:${it.iid}`, action }, disabled: locked,
      onchange: () => decide([decisionFor(it, select.value)], `${label}: ${select.selectedOptions[0]?.textContent ?? select.value}.`),
    }, opts.map((o) => h("option", { value: o.value, selected: o.value === value }, o.label))));
    return h("div", null, select, it.blocked ? h("div", { class: "item-kind" }, "Blocked: an endpoint is skipped") : null);
  }

  /** @param {Active} a */
  function reviewTable(a) {
    const rows = a.page.map((it) => {
      const bad = it.invalid || it.state === "failed";
      const problems = [...(it.problems ?? []), ...(it.state === "failed" && it.error ? [it.error] : [])];
      return h("tr", { dataset: { iid: it.iid, kind: it.data?.kind ?? "" } },
        h("td", null,
          h("div", { class: "item-kind" }, it.data?.kind ?? ""),
          h("div", { class: "item-label" }, itemLabel(it)),
          problems.length ? h("ul", { class: "item-problems" + (bad ? " bad" : "") }, problems.slice(0, 4).map((p) => h("li", null, p))) : null),
        h("td", null, decisionCell(a, it)));
    });
    const empty = a.loading ? "Loading…" : a.filter === "problems" ? "No items with problems." : "No items.";
    const table = h("table", { class: "grid-table review-table" },
      h("caption", { class: "sr-only" }, "Items to import"),
      h("thead", null, h("tr", null, h("th", { scope: "col" }, "Item"), h("th", { scope: "col" }, "Action"))),
      h("tbody", null, rows.length ? rows : h("tr", null, h("td", { colspan: "2", class: "muted" }, empty))));
    if (a.total <= REVIEW_PAGE && !a.cursor) return table;
    const from = a.total ? a.cursor + 1 : 0, to = a.cursor + a.page.length;
    return h("div", { class: "stack" }, table, h("div", { class: "pager" },
      h("button", { type: "button", class: "btn small", dataset: { key: "prev" }, disabled: a.cursor === 0 || a.loading, onclick: () => { a.cursor = Math.max(0, a.cursor - REVIEW_PAGE); refreshActive({ page: true }); } }, "Previous"),
      h("span", null, `${from.toLocaleString("en")}–${to.toLocaleString("en")} of ${a.total.toLocaleString("en")}`),
      h("button", { type: "button", class: "btn small", dataset: { key: "next" }, disabled: a.next === null || a.loading, onclick: () => { a.cursor = a.next ?? 0; refreshActive({ page: true }); } }, "Next")));
  }

  /** @param {string} text @param {() => void} onclick @param {string} [cls] @param {string} [key] @param {boolean} [disabled] */
  const button = (text, onclick, cls = "btn outline", key = undefined, disabled = false) => h("button", { type: "button", class: cls, dataset: key ? { key } : undefined, disabled, onclick }, text);

  function renderActive() {
    if (!active || destroyed) return;
    const a = active;
    const m = a.manifest;
    const focusKey = /** @type {HTMLElement|null} */ (document.activeElement)?.dataset?.key;
    clear(reviewHost);
    /** Element.append would write null as text. @param {any[]} nodes */
    const put = (...nodes) => reviewHost.append(...nodes.filter((n) => n != null));
    put(
      h("div", { class: "review-head" },
        h("strong", null, m.name ?? "Import"),
        h("span", { class: "chip", dataset: { status: m.status } }, statusLabel(m.status))),
      h("p", { class: "hint" }, [FORMATS.find((f) => f.id === m.format)?.label, m.createdBy ? `staged by ${m.createdBy}` : "", m.createdAt ? formatTime(m.createdAt) : ""].filter(Boolean).join(" · ")));
    const locked = !!a.busy || a.accepting;

    if (m.status === "staging") {
      put(h("p", null, "This import is still being staged, or staging was interrupted."),
        h("div", { class: "actions" }, button("Discard", discard, "btn outline", "discard", locked), button("Back", closeChangeset, "btn")));
    } else if (m.status === "review") {
      const counts = countRows(m.counts);
      put(h("div", { class: "counts", role: "group", "aria-label": "Summary by action" },
        counts.length ? counts.map((r) => h("span", { class: "chip", dataset: { action: r.key } }, `${r.label}: ${r.n.toLocaleString("en")}`)) : h("span", { class: "muted" }, "No items")));
      const local = memory.local.get(a.id);
      const warnings = [...(m.warnings ?? [])];
      if (local?.refused.length) warnings.push(`${plural(local.refused.length, "item was", "items were")} refused while staging: ${local.refused[0].message}`);
      if (warnings.length) put(h("h4", null, "Warnings"), h("ul", { class: "plain warn-text" }, warnings.map((w) => h("li", null, w))));
      put(h("div", { class: "actions", role: "group", "aria-label": "Decide for many items" },
        button("Use existing for all single label matches", () => bulk("use-existing-single"), "btn small outline", "bulk-existing", locked),
        button("Create new for all label matches", () => bulk("create-label-matches"), "btn small outline", "bulk-create", locked),
        button("Skip all invalid", () => bulk("skip-invalid"), "btn small outline", "bulk-skip", locked || !m.counts?.invalid)));
      const problemsOnly = /** @type {HTMLInputElement} */ (h("input", {
        type: "checkbox", checked: a.filter === "problems", dataset: { key: "filter" },
        onchange: () => { a.filter = problemsOnly.checked ? "problems" : "all"; a.cursor = 0; refreshActive({ page: true }); },
      }));
      put(h("label", { class: "radio" }, problemsOnly, "Problems only"), reviewTable(a));
      const fallback = (m.items ?? 0) - (m.counts?.skip ?? 0) - (m.counts?.invalid ?? 0) - (m.counts?.blocked ?? 0);
      put(
        h("p", { class: "small-print" }, "Accepting applies the import to the map for everyone, in parts. It can be undone from Activity or from Imports below; anything someone changes in the meantime is kept, not undone."),
        h("div", { class: "actions" },
          button(a.counts ? acceptLabel(a.counts) : `Import ${plural(Math.max(0, fallback), "item")}`, accept, "btn primary", "accept", locked || a.loading),
          button("Discard", discard, "btn outline", "discard", locked),
          button("Back", closeChangeset, "btn")));
    } else if (m.status === "applying") {
      const p = progressOf(m);
      const stalled = !a.accepting && Date.now() - (m.updatedAt ?? 0) > STALLED_MS;
      put(
        h("progress", { max: "1", value: String(p.fraction), "aria-label": "Import progress" }),
        h("p", { class: "status-line", dataset: { progress: "" } }, `Applying: ${p.text}.`),
        stalled ? h("p", { class: "hint" }, "No progress for a while: the import may have been interrupted, for example by a restart. Resume it to finish; nothing is applied twice.") : null,
        h("div", { class: "actions" }, stalled ? button("Resume", resume, "btn primary", "resume") : null, button("Back", closeChangeset, "btn")));
    } else if (m.status === "applied" || m.status === "partial") {
      const failed = a.outcome?.failed ?? [];
      put(
        h("p", { class: "status-line " + (m.status === "applied" ? "ok" : "error"), dataset: { outcome: m.status } },
          `${m.status === "applied" ? "Imported" : "Partly imported"}: ${manifestSummary(m)}.`),
        failed.length ? h("div", { class: "stack" }, h("h4", null, "Failed items"),
          h("ul", { class: "plain error-text" }, failed.slice(0, 50).map((it) => h("li", null, `${itemLabel(it)}: ${it.error ?? "failed"}`)))) : null,
        a.outcome && !a.outcome.kept ? h("p", { class: "hint" }, "Item details are kept for the newest imports only.") : null,
        h("div", { class: "actions" },
          button("Lay out the new elements", () => app.runLayout("force"), "btn outline", "layout"),
          button("Select imported elements", selectImported, "btn outline", "select")),
        h("p", { class: "small-print" }, "Undo the whole import from Imports below or from Activity. Anything changed since is kept."),
        h("div", { class: "actions" }, button("Start another import", closeChangeset, "btn", "another")));
    } else {
      put(h("p", null, m.status === "rejected" ? "This import was discarded." : "This import failed."),
        h("div", { class: "actions" }, button("Start another import", closeChangeset, "btn", "another")));
    }
    if (a.busy) reviewStatus.textContent = a.busy;
    put(reviewStatus, reviewError);
    refocus(reviewHost, focusKey);
  }

  // --- Imports list ---------------------------------------------------------------------------

  const listHost = h("ul", { class: "imports", "aria-label": "Imports" });
  const listStatus = h("p", { class: "status-line", role: "status", "aria-live": "polite" });
  const listError = h("p", { class: "status-line error", role: "alert" });
  /** @type {Set<string>} */
  const listBusy = new Set();

  function renderList() {
    if (destroyed) return;
    const focusKey = /** @type {HTMLElement|null} */ (document.activeElement)?.dataset?.key;
    clear(listHost);
    const list = [...store.changesets.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, MAX_LIST);
    if (!list.length) { listHost.append(h("li", { class: "muted empty" }, "No imports yet.")); return; }
    for (const m of list) {
      const undo = groupUndoState(m.id, store.history);
      const busy = listBusy.has(m.id);
      /** @type {HTMLElement[]} */
      const actions = [];
      if (m.status === "review") actions.push(button("Review", () => openChangeset(m.id), "btn small outline", `open:${m.id}`));
      else if (m.status === "applying") {
        if (Date.now() - (m.updatedAt ?? 0) > STALLED_MS) actions.push(button("Resume", async () => { await openChangeset(m.id); await resume(); }, "btn small outline", `resume:${m.id}`));
        else actions.push(button("Show progress", () => openChangeset(m.id), "btn small outline", `open:${m.id}`));
      } else if (m.status === "applied" || m.status === "partial") {
        actions.push(button("Details", () => openChangeset(m.id), "btn small", `open:${m.id}`));
        if (undo !== "undone") actions.push(button(undo === "partly" ? "Undo the rest" : "Undo import", () => undoImport(m), "btn small outline", `undo:${m.id}`, busy));
      } else if (m.status === "staging" && memory.activeId !== m.id) {
        actions.push(button("Discard", () => discardFromList(m), "btn small outline", `discard:${m.id}`, busy));
      }
      listHost.append(h("li", { dataset: { changeset: m.id, status: m.status } },
        h("div", { class: "row-head" },
          h("span", { class: "name" }, m.name ?? "Import"),
          h("span", { class: "chip", dataset: { status: undo === "undone" ? "rejected" : m.status } }, undo === "undone" ? "Undone" : statusLabel(m.status))),
        h("div", { class: "meta" }, m.status === "applying" ? progressOf(m).text : manifestSummary(m)),
        h("div", { class: "meta" }, `${m.createdBy ?? "Someone"} · ${formatTime(m.createdAt)}${m.acceptedBy && m.acceptedBy !== m.createdBy ? ` · accepted by ${m.acceptedBy}` : ""}`),
        actions.length ? h("div", { class: "actions" }, actions) : null));
    }
    refocus(listHost, focusKey);
  }

  /** @param {any} m */
  async function undoImport(m) {
    listBusy.add(m.id);
    listError.textContent = "";
    listStatus.textContent = `Undoing “${m.name}”…`;
    renderList();
    try {
      const msg = undoMessage(await store.call("undoGroup", { groupId: m.id, senderId: store.viewer.clientId, by: app.by }));
      listStatus.textContent = msg.ok ? msg.message : "";
      listError.textContent = msg.ok ? "" : msg.message;
      app.announce(msg.message);
    } catch (e) {
      listStatus.textContent = "";
      listError.textContent = "Could not undo the import: " + messageOf(e);
    }
    listBusy.delete(m.id);
    renderList();
  }

  /** @param {any} m */
  async function discardFromList(m) {
    listBusy.add(m.id);
    listError.textContent = "";
    renderList();
    try {
      await store.call("rejectChangeset", { changesetId: m.id });
      listStatus.textContent = `Discarded “${m.name}”.`;
    } catch (e) {
      listError.textContent = "Could not discard: " + messageOf(e);
    }
    listBusy.delete(m.id);
    renderList();
  }

  // --- Export ---------------------------------------------------------------------------------

  const exportError = h("p", { class: "status-line error", role: "alert" });

  /** @param {"kumu"|"elements"|"connections"} kind */
  function showExport(kind) {
    exportError.textContent = "";
    let text = "";
    try {
      const map = storedMapOf(store);
      text = kind === "kumu" ? JSON.stringify(toKumuJson(map), null, 2) : kind === "elements" ? toElementsCsv(map) : toConnectionsCsv(map);
    } catch (e) {
      exportError.textContent = "Could not build the export: " + messageOf(e);
      return;
    }
    const title = kind === "kumu" ? "Kumu JSON" : kind === "elements" ? "Elements CSV" : "Connections CSV";
    const mime = kind === "kumu" ? "application/json" : "text/csv";
    const file = exportFileName(store.meta?.title, kind === "kumu" ? "kumu.json" : `${kind}.csv`);
    const areaId = `nm-export-text-${seq}`;
    modal((close) => {
      const area = /** @type {HTMLTextAreaElement} */ (h("textarea", {
        id: areaId, readonly: true, rows: "14", spellcheck: "false", "data-autofocus": true, value: text,
        onfocus: () => area.select(),
      }));
      return h("div", { class: "modal wide nm-export-modal", "aria-label": title },
        h("h2", null, title),
        h("p", null, "Select all (Ctrl+A, or ⌘A on a Mac) and copy: this frame cannot use the clipboard for you. The download link may be blocked here; the Export menu is the reliable way to save a file."),
        h("label", { for: areaId, class: "sr-only" }, title), area,
        h("div", { class: "modal-actions" },
          h("a", { class: "btn outline", href: `data:${mime};charset=utf-8,${encodeURIComponent(text)}`, download: file }, "Download"),
          h("button", { type: "button", class: "btn primary", onclick: () => close(undefined) }, "Close")));
    }, undefined);
  }

  // --- Assembly -------------------------------------------------------------------------------

  const section = (/** @type {string} */ key, /** @type {string} */ title, /** @type {any[]} */ ...children) =>
    h("section", { class: "nm-section", "aria-labelledby": `nm-data-${key}-h-${seq}` }, h("h3", { id: `nm-data-${key}-h-${seq}` }, title), ...children);
  const root = h("div", { class: "nm-data" },
    section("import", "Import", form, reviewHost),
    section("imports", "Imports", listHost, listStatus, listError),
    section("export", "Export",
      h("p", { class: "hint" }, "To save a file, use the gadget’s Export menu, outside the map: it has the full backup (JSON), Kumu JSON, CSV of elements and of connections, GraphML and GEXF. Downloads from inside the map may be blocked."),
      h("p", { class: "hint" }, "To copy the text instead:"),
      h("div", { class: "actions" },
        button("Copy as Kumu JSON", () => showExport("kumu"), "btn small outline"),
        button("Elements CSV", () => showExport("elements"), "btn small outline"),
        button("Connections CSV", () => showExport("connections"), "btn small outline")),
      exportError));
  host.appendChild(root);

  function showMode() {
    form.hidden = !!active;
    reviewHost.hidden = !active;
  }

  cleanups.push(store.subscribe((/** @type {any} */ change) => {
    if (destroyed) return;
    if (change.type === "history") { renderList(); return; }
    if (change.type !== "changesets") return;
    renderList();
    const a = active;
    const m = a && store.changesets.get(a.id);
    if (!a || !m || (m.updatedAt ?? 0) < (a.manifest.updatedAt ?? 0)) return;
    const prev = a.manifest;
    a.manifest = m;
    if (m.status === "review" && prev.status === "review" && m.digest !== a.digestShown && !a.busy) refreshActive({ page: true, count: true });
    else if ((m.status === "applied" || m.status === "partial") && prev.status !== m.status) refreshActive({ page: false });
    else renderActive();
  }));
  // "Stalled" is a matter of time, not of events.
  const tick = setInterval(() => {
    if (![...store.changesets.values()].some((m) => m.status === "applying")) return;
    renderList();
    if (active?.manifest.status === "applying") renderActive();
  }, 5000);
  cleanups.push(() => clearInterval(tick));

  setFormat(memory.format);
  showMode();
  renderList();
  store.ensureHistory().then(() => renderList(), () => {});
  if (memory.activeId) openChangeset(memory.activeId);

  return {
    destroy() {
      destroyed = true;
      for (const c of cleanups) { try { c(); } catch { /* ignore */ } }
      root.remove();
    },
  };
}
