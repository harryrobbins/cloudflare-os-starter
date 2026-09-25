// @ts-check
// The work board: loading, sync, actions and rendering.
//
// Committed items come only from the Records service: a bounded snapshot, then journal pages pulled
// by cursor and permission epoch. The viewer's changes are exact-intent commands: each carries a
// one-use viewer assertion over the SHA-256 of its complete intent, is usually queued for approval
// in the Workshop, and shows as an overlay (a chip and the status panel) until the service's
// version arrives. Pending changes never move cards.

import { h, option } from "./dom.js";
import { CSS } from "./styles.js";
import { STATUSES, STATUS_LABELS, applyChanges, changedFields, columns, emptyState, fromSnapshot, isWorkV1, statusOf, validTitle } from "../model.js";
import { intentDigest } from "../intent.js";
import { BINDING_NAME, errorCode, errorDetail } from "../../shared/records.js";

/**
 * One change the viewer asked for, as shown in the status panel.
 * @typedef {{
 *   id: number, label: string, itemId: string|null, command: string, input: Record<string, unknown>,
 *   revision: number|undefined, idempotencyKey: string,
 *   status: "saving"|"pending"|"applied"|"conflict"|"rejected", actionId: number|null, message: string,
 * }} Change
 */

const SNAPSHOT_LIMIT = 2000;
const MAX_PAGES_PER_PULL = 50;
const APPLIED_VISIBLE_MS = 6_000;
const STATUS_TEXT = { saving: "Sending", pending: "Awaiting approval", applied: "Saved", conflict: "Conflict", rejected: "Not saved" };

/** @param {Change} change */
export function describeChange(change) {
  switch (change.status) {
    case "saving": return "Sending to the Records service…";
    case "pending": return `Awaiting approval in the Workshop (action #${change.actionId}). Not saved yet.`;
    case "applied": return "Saved.";
    case "conflict": return "Not saved: someone changed this item first. The board shows the current version; make the change again if it is still needed.";
    case "rejected": return `Not saved: ${change.message || "the Records service refused this change."}`;
  }
}

/**
 * @param {{
 *   gadget: any, root: HTMLElement, viewer?: { id: string, displayName: string } | null,
 *   timers?: { visibleMs?: number, hiddenMs?: number, outcomeMs?: number },
 *   doc?: Document, randomUUID?: () => string,
 * }} options
 */
export function createBoardApp(options) {
  const { gadget, root } = options;
  const doc = options.doc ?? document;
  const visibleMs = options.timers?.visibleMs ?? 3_000;
  const hiddenMs = options.timers?.hiddenMs ?? 15_000;
  const outcomeMs = options.timers?.outcomeMs ?? 2_000;
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());

  const style = doc.createElement("style");
  style.textContent = CSS;
  doc.head.append(style);

  /** @type {"loading"|"not_connected"|"forbidden"|"wrong_module"|"too_large"|"error"|"ready"} */
  let phase = "loading";
  let phaseMessage = "";
  /** @type {any} */ let connection = null;
  /** @type {any} */ let description = null;
  let state = emptyState();
  /** @type {Change[]} */ let changes = [];
  let nextChangeId = 1;
  /** @type {string|null} */ let selectedId = null;
  /** @type {{ title: string, description: string, status: string, baseRevision: number } | null} */ let draft = null;
  /** The item and revision the detail panel was last built for. @type {string|null} */ let detailBuiltFor = null;
  let draftEdited = false;
  let dialogOpen = false;
  let syncError = "";
  let lastSync = 0;
  let destroyed = false;
  /** @type {Promise<void>|null} */ let pulling = null;
  /** @type {ReturnType<typeof setTimeout>|null} */ let pollTimer = null;
  /** @type {ReturnType<typeof setTimeout>|null} */ let outcomeTimer = null;

  const canWrite = () => connection?.access === "write";
  const item = (/** @type {string|null} */ id) => (id ? state.items.get(id) ?? null : null);

  // ---------------------------------------------------------------------------------------------
  // Loading and sync

  /** @param {unknown} err */
  function stopFor(err) {
    const code = errorCode(err);
    if (code === "not_connected") phase = "not_connected";
    else if (code === "forbidden") phase = "forbidden";
    else if (code === "too_large") phase = "too_large";
    else phase = "error";
    phaseMessage = errorDetail(err);
    // Never keep showing protected data after a refusal.
    if (phase !== "error") { state = emptyState(); selectedId = null; draft = null; }
  }

  async function bootstrap() {
    phase = "loading";
    render();
    const setup = await gadget.getSetup();
    if (!setup.connected) { phase = "not_connected"; phaseMessage = ""; return; }
    if (setup.error) { stopFor(new Error(setup.error)); return; }
    connection = setup.connection;
    description = setup.description;
    if (!isWorkV1(description)) { phase = "wrong_module"; phaseMessage = ""; return; }
    await takeSnapshot();
  }

  async function takeSnapshot() {
    try {
      state = fromSnapshot(await gadget.snapshot(SNAPSHOT_LIMIT));
      phase = "ready";
      syncError = "";
      lastSync = Date.now();
    } catch (err) {
      stopFor(err);
    }
  }

  /** Pull journal pages until one is empty. Single-flight. */
  function pull() {
    if (phase !== "ready") return Promise.resolve();
    pulling ??= (async () => {
      try {
        for (let i = 0; i < MAX_PAGES_PER_PULL; i++) {
          const page = await gadget.changes(state.cursor, state.epoch ?? undefined);
          if (destroyed) return;
          state = applyChanges(state, page);
          if (!page.changes.length) break;
        }
        syncError = "";
        lastSync = Date.now();
      } catch (err) {
        const code = errorCode(err);
        if (code === "reset_required") {
          state = emptyState();
          await takeSnapshot();
        } else if (code === "forbidden" || code === "not_connected" || code === "too_large") {
          stopFor(err);
        } else {
          syncError = errorDetail(err) || "The Records service could not be reached.";
        }
      }
    })().finally(() => { pulling = null; render(); });
    return pulling;
  }

  function schedulePoll() {
    if (destroyed) return;
    if (pollTimer) clearTimeout(pollTimer);
    const visible = doc.visibilityState !== "hidden";
    pollTimer = setTimeout(async () => { await pull(); schedulePoll(); }, visible ? visibleMs : hiddenMs);
  }

  function scheduleOutcomes() {
    if (destroyed || outcomeTimer) return;
    if (!changes.some((c) => c.status === "pending")) return;
    outcomeTimer = setTimeout(async () => {
      outcomeTimer = null;
      for (const change of changes.filter((c) => c.status === "pending")) {
        try {
          handleOutcome(change, await gadget.getOutcome(change.actionId));
        } catch (err) {
          if (errorCode(err) === "not_found") { change.status = "rejected"; change.message = "the Workshop no longer knows this request."; }
        }
      }
      render();
      scheduleOutcomes();
    }, outcomeMs);
  }

  // ---------------------------------------------------------------------------------------------
  // Writes

  /**
   * @param {string} label @param {string} command @param {Record<string, unknown>} input
   * @param {number|undefined} revision @param {string|null} itemId
   */
  async function request(label, command, input, revision, itemId) {
    /** @type {Change} */
    const change = { id: nextChangeId++, label, itemId, command, input, revision, idempotencyKey: randomUUID(), status: "saving", actionId: null, message: "" };
    changes = [...changes, change];
    render();
    try {
      let outcome;
      try {
        outcome = await send(change);
      } catch (err) {
        // Nothing reached the Workshop's queue: retry once with a fresh assertion, same key and input.
        if (errorCode(err) !== "unavailable") throw err;
        outcome = await send(change);
      }
      handleOutcome(change, outcome);
    } catch (err) {
      const code = errorCode(err);
      if (code === "stale_revision") { change.status = "conflict"; void pull(); }
      else { change.status = "rejected"; change.message = errorDetail(err) || "the request could not be sent."; }
    }
    render();
    scheduleOutcomes();
  }

  /** @param {Change} change */
  async function send(change) {
    const intent = {
      datastore: connection.datastore, binding: connection.binding, moduleId: "work", apiMajor: 1,
      command: change.command, input: change.input, expectedRevision: change.revision ?? null, idempotencyKey: change.idempotencyKey,
    };
    const digest = await intentDigest(intent);
    let viewerAssertion;
    try {
      viewerAssertion = await gadget.$createViewerAssertion(BINDING_NAME, digest);
    } catch (err) {
      throw new Error(`forbidden: The Workshop could not confirm this change came from you (${errorDetail(err) || "no reason given"}).`);
    }
    if (typeof viewerAssertion !== "string" || !viewerAssertion) throw new Error("forbidden: Only signed-in viewers can change items.");
    /** @type {{ viewerAssertion: string, idempotencyKey: string, revision?: number }} */
    const commandOptions = { viewerAssertion, idempotencyKey: change.idempotencyKey };
    if (change.revision !== undefined) commandOptions.revision = change.revision;
    return gadget.command(change.command, change.input, commandOptions);
  }

  /** @param {Change} change @param {any} outcome */
  function handleOutcome(change, outcome) {
    if (outcome?.status === "pending") {
      change.status = "pending";
      change.actionId = outcome.actionId;
    } else if (outcome?.status === "applied") {
      change.status = "applied";
      void pull();
      setTimeout(() => { changes = changes.filter((c) => c !== change); render(); }, APPLIED_VISIBLE_MS);
    } else if (outcome?.status === "rejected") {
      const reason = String(outcome.reason ?? "");
      if (reason.includes("(412)")) { change.status = "conflict"; void pull(); }
      else { change.status = "rejected"; change.message = reason; }
    }
  }

  /** @param {string} title @param {string} descriptionText */
  function createItem(title, descriptionText) {
    /** @type {Record<string, unknown>} */
    const input = { title, status: "open" };
    if (descriptionText) input.description = descriptionText;
    void request(`Create “${title}”`, "work.create", input, undefined, null);
  }

  /** @param {any} target @param {Record<string, string>} fields @param {string} label */
  function updateItem(target, fields, label) {
    if (!Object.keys(fields).length) return;
    void request(label, "work.update", { id: target.id, ...fields }, target.revision, target.id);
  }

  // ---------------------------------------------------------------------------------------------
  // Rendering

  const headerEl = h("header", { class: "wb-header" });
  const bannerEl = h("div");
  const boardEl = h("div", { class: "wb-board" });
  const detailEl = h("aside", { class: "wb-detail", hidden: true, "aria-label": "Item details" });
  const mainEl = h("div", { class: "wb-main" }, boardEl, detailEl);
  const writesEl = h("div", { class: "wb-writes", role: "status", "aria-live": "polite" });
  const dialogEl = h("div", { hidden: true });
  const app = h("div", { class: "wb-app" }, headerEl, bannerEl, mainEl, writesEl, dialogEl);
  root.replaceChildren(app);

  function render() {
    if (destroyed) return;
    renderHeader();
    renderBanner();
    if (phase === "ready") { renderBoard(); renderDetail(); } else { boardEl.replaceChildren(statePanel()); detailEl.hidden = true; }
    renderWrites();
  }

  function renderHeader() {
    const label = connection?.label ?? "Work board";
    const live = phase === "ready" ? (syncError ? "Reconnecting…" : `Up to date${lastSync ? ` · checked ${new Date(lastSync).toLocaleTimeString()}` : ""}`) : "";
    headerEl.replaceChildren(
      h("h1", null, "Work board"),
      h("span", { class: "datastore" }, connection ? `${label} · work v1${canWrite() ? "" : " · read only"}` : ""),
      h("span", { class: "spacer" }),
      phase === "ready" ? h("span", { class: "live", "data-live": syncError ? "requested" : "active" }, h("span", { class: "dot", "aria-hidden": "true" }), live) : null,
      h("button", { type: "button", onclick: () => { void refresh(); } }, "Refresh"),
      phase === "ready" && canWrite() ? h("button", { type: "button", class: "primary", onclick: openDialog }, "New item") : null,
    );
  }

  function renderBanner() {
    bannerEl.replaceChildren(...(phase === "ready" && syncError ? [h("div", { class: "banner warn", role: "alert" }, `Could not check for changes: ${syncError} Retrying automatically.`)] : []));
  }

  function statePanel() {
    const panel = h("div", { class: "state-panel" });
    switch (phase) {
      case "loading": panel.append(h("h2", null, "Loading the board…")); break;
      case "not_connected":
        panel.append(h("h2", null, "Connect a work datastore"), h("ol", null,
          h("li", null, "Open this gadget's Connections tab."),
          h("li", null, `Add a Records datastore with the work module, named ${BINDING_NAME}.`),
          h("li", null, "Choose “Read and request changes” to edit items, or “Read only” to just view them.")));
        break;
      case "wrong_module":
        panel.append(h("h2", null, "This board needs a work v1 datastore"),
          h("p", null, `The connected datastore uses ${description?.module_id ?? "another module"} v${description?.api_major ?? "?"}. Connect a work datastore instead.`));
        break;
      case "forbidden":
        panel.append(h("h2", null, "You don't have access to this datastore"), h("p", null, phaseMessage || "The Records service refused this connection."));
        break;
      case "too_large":
        panel.append(h("h2", null, "This datastore is too large for a board"),
          h("p", null, `The board loads a complete snapshot of at most ${SNAPSHOT_LIMIT.toLocaleString()} items, and this datastore has more. Use a Records Explorer or the Records API instead.`));
        break;
      default:
        panel.append(h("h2", null, "The board could not load"), h("p", null, phaseMessage || "The Records service could not be reached."),
          h("button", { type: "button", class: "primary", onclick: () => { void refresh(); } }, "Try again"));
    }
    return panel;
  }

  /** @param {string} itemId */
  function pendingFor(itemId) {
    return changes.find((c) => c.itemId === itemId && (c.status === "pending" || c.status === "saving"));
  }

  function renderBoard() {
    const grouped = columns(state);
    boardEl.replaceChildren(...STATUSES.map((status) => {
      const list = h("ul", { "aria-label": `${STATUS_LABELS[status]} items` });
      if (!grouped[status].length) list.append(h("li", { class: "empty" }, "No items"));
      for (const entry of grouped[status]) list.append(cardEl(entry));
      const column = h("section", { class: "wb-column", "data-status": status, "aria-labelledby": `col-${status}` },
        h("h2", { id: `col-${status}` }, h("span", null, STATUS_LABELS[status]), h("span", { "aria-label": `${grouped[status].length} items` }, String(grouped[status].length))),
        list);
      if (canWrite()) {
        column.addEventListener("dragover", (e) => { e.preventDefault(); column.classList.add("drop-over"); });
        column.addEventListener("dragleave", () => column.classList.remove("drop-over"));
        column.addEventListener("drop", (e) => {
          e.preventDefault();
          column.classList.remove("drop-over");
          const target = item(e.dataTransfer?.getData("text/plain") ?? null);
          if (target && statusOf(target.data.status) !== status && !pendingFor(target.id)) {
            updateItem(target, { status }, `Move “${target.data.title}” to ${STATUS_LABELS[status]}`);
          }
        });
      }
      return column;
    }));
  }

  /** @param {any} entry */
  function cardEl(entry) {
    const pending = pendingFor(entry.id);
    const title = String(entry.data.title ?? "(untitled)");
    const snippet = String(entry.data.description ?? "").trim();
    const card = h("li", { class: "wb-card", "data-item-id": entry.id, "aria-current": entry.id === selectedId ? "true" : null, draggable: canWrite() && !pending ? "true" : null },
      h("button", { type: "button", class: "open", onclick: () => select(entry.id) },
        h("div", { class: "title" }, title),
        snippet ? h("div", { class: "snippet" }, snippet.slice(0, 240)) : null));
    card.addEventListener("dragstart", (e) => { e.dataTransfer?.setData("text/plain", entry.id); });
    const foot = h("div", { class: "foot" });
    if (pending) foot.append(h("span", { class: `chip ${pending.status}` }, pending.status === "pending" ? `Awaiting approval (action #${pending.actionId})` : "Sending…"));
    if (canWrite()) {
      const current = statusOf(entry.data.status);
      const move = h("select", {
        "aria-label": `Move “${title}”`, disabled: Boolean(pending),
        onchange: (/** @type {Event} */ e) => {
          const next = /** @type {HTMLSelectElement} */ (e.target).value;
          if (next !== current) updateItem(entry, { status: next }, `Move “${title}” to ${STATUS_LABELS[/** @type {"open"} */ (next)]}`);
        },
      }, ...STATUSES.map((s) => option(s, s === current ? `In ${STATUS_LABELS[s]}` : `Move to ${STATUS_LABELS[s]}`, s === current)));
      foot.append(move);
    }
    if (foot.childNodes.length) card.append(foot);
    return card;
  }

  /** @param {string} id */
  function select(id) {
    selectedId = id;
    const target = item(id);
    draft = target ? draftFor(target) : null;
    draftEdited = false;
    detailBuiltFor = null;
    render();
    detailEl.querySelector("h2")?.focus();
  }

  function closeDetail() {
    const returnTo = selectedId;
    selectedId = null;
    draft = null;
    detailBuiltFor = null;
    render();
    /** @type {HTMLElement|null} */ (boardEl.querySelector(`.wb-card[data-item-id="${returnTo}"] button.open`))?.focus();
  }

  /** @param {any} target */
  function draftFor(target) {
    return { title: String(target.data.title ?? ""), description: String(target.data.description ?? ""), status: statusOf(target.data.status), baseRevision: target.revision };
  }

  /** The detail panel is rebuilt only when its item or revision changes, so typing is never lost. */
  function renderDetail() {
    const target = item(selectedId);
    if (!target || !draft) { detailEl.hidden = true; detailEl.replaceChildren(); detailBuiltFor = null; return; }
    detailEl.hidden = false;
    const key = `${target.id}@${target.revision}`;
    if (detailBuiltFor === key) return;
    detailBuiltFor = key;
    if (draft.baseRevision !== target.revision) {
      // A newer version arrived. Adopt it when the draft has nothing unsaved: it matches the new
      // version (our own save landed) or was never edited from the version it started from.
      const unsaved = Object.keys(changedFields(target, draft)).length > 0;
      if (!unsaved || !draftEdited) { draft = draftFor(target); draftEdited = false; }
    }
    const title = String(target.data.title ?? "");
    const stale = draft.baseRevision !== target.revision;
    const children = [
      h("h2", { tabindex: "-1" }, title || "(untitled)"),
      h("div", { class: "sub" }, `Revision ${target.revision} · ${target.id}`),
    ];
    if (canWrite()) {
      const d = draft;
      const error = h("div", { class: "field-error", role: "alert" });
      const titleInput = h("input", { type: "text", id: "wb-title", value: d.title, maxlength: "500", oninput: (/** @type {Event} */ e) => { d.title = /** @type {HTMLInputElement} */ (e.target).value; draftEdited = true; } });
      const statusSelect = h("select", { id: "wb-status", onchange: (/** @type {Event} */ e) => { d.status = /** @type {HTMLSelectElement} */ (e.target).value; draftEdited = true; } },
        ...STATUSES.map((s) => option(s, STATUS_LABELS[s], s === d.status)));
      const descInput = h("textarea", { id: "wb-description", rows: "6", oninput: (/** @type {Event} */ e) => { d.description = /** @type {HTMLTextAreaElement} */ (e.target).value; draftEdited = true; } });
      /** @type {HTMLTextAreaElement} */ (descInput).value = d.description;
      const save = () => {
        const checked = validTitle(d.title);
        if (!checked.ok) { error.textContent = checked.error; titleInput.focus(); return; }
        const base = { ...target, revision: d.baseRevision };
        const fields = changedFields(base, { title: checked.title, description: d.description, status: d.status });
        if (!Object.keys(fields).length) { error.textContent = "Nothing has changed."; return; }
        error.textContent = "";
        updateItem(base, fields, `Edit “${checked.title}”`);
      };
      titleInput.addEventListener("keydown", (e) => { if (/** @type {KeyboardEvent} */ (e).key === "Enter") save(); });
      children.push(
        h("label", { for: "wb-title" }, "Title"), titleInput,
        h("label", { for: "wb-status" }, "Status"), statusSelect,
        h("label", { for: "wb-description" }, "Description"), descInput,
        error,
        stale ? h("div", { class: "notice" }, "This item changed after you started editing. Saving now will be refused as a conflict; close and reopen it to edit the current version.") : null,
        h("div", { class: "row" },
          h("button", { type: "button", class: "primary", onclick: save }, "Save changes"),
          h("button", { type: "button", onclick: closeDetail }, "Close")),
      );
    } else {
      children.push(
        h("label", null, "Status"), h("div", null, STATUS_LABELS[statusOf(target.data.status)]),
        h("label", null, "Description"), h("div", { class: "readonly" }, String(target.data.description ?? "") || "No description."),
        h("div", { class: "row" }, h("button", { type: "button", onclick: closeDetail }, "Close")),
      );
    }
    detailEl.replaceChildren(...children.filter(Boolean));
  }

  function renderWrites() {
    writesEl.replaceChildren(...changes.map((change) => h("div", { class: "write", "data-status": change.status },
      h("div", { class: "what" }, change.label),
      h("div", null, h("span", { class: `chip ${change.status}` }, STATUS_TEXT[change.status]), " ", describeChange(change)),
      change.status === "applied" || change.status === "pending" || change.status === "saving" ? null
        : h("div", { class: "actions" }, h("button", { type: "button", class: "link", onclick: () => { changes = changes.filter((c) => c !== change); render(); } }, "Dismiss")),
    )));
  }

  function openDialog() {
    dialogOpen = true;
    const error = h("div", { class: "field-error", role: "alert" });
    const titleInput = /** @type {HTMLInputElement} */ (h("input", { type: "text", id: "wb-new-title", maxlength: "500", autocomplete: "off" }));
    const descInput = /** @type {HTMLTextAreaElement} */ (h("textarea", { id: "wb-new-description", rows: "4" }));
    const close = () => { dialogOpen = false; dialogEl.hidden = true; dialogEl.replaceChildren(); /** @type {HTMLElement|null} */ (headerEl.querySelector("button.primary"))?.focus(); };
    const create = () => {
      const checked = validTitle(titleInput.value);
      if (!checked.ok) { error.textContent = checked.error; titleInput.focus(); return; }
      createItem(checked.title, descInput.value.trim());
      close();
    };
    titleInput.addEventListener("keydown", (e) => { if (e.key === "Enter") create(); });
    const dialog = h("div", { class: "dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "wb-new-heading" },
      h("h2", { id: "wb-new-heading" }, "New item"),
      h("label", { for: "wb-new-title" }, "Title"), titleInput,
      h("label", { for: "wb-new-description" }, "Description (optional)"), descInput,
      error,
      h("div", { class: "row" }, h("button", { type: "button", onclick: close }, "Cancel"), h("button", { type: "button", class: "primary", onclick: create }, "Create item")));
    const backdrop = h("div", { class: "dialog-backdrop", onclick: (/** @type {Event} */ e) => { if (e.target === backdrop) close(); } }, dialog);
    backdrop.addEventListener("keydown", (e) => { if (/** @type {KeyboardEvent} */ (e).key === "Escape") close(); });
    dialogEl.replaceChildren(backdrop);
    dialogEl.hidden = false;
    titleInput.focus();
  }

  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !dialogOpen && selectedId) closeDetail();
  });

  async function refresh() {
    if (phase === "ready") { await pull(); return; }
    try { await bootstrap(); } catch (err) { stopFor(err); }
    render();
    if (phase === "ready") await pull();
  }

  const onVisibility = () => { if (doc.visibilityState !== "hidden") { void pull(); schedulePoll(); } };
  doc.addEventListener("visibilitychange", onVisibility);

  const ready = (async () => {
    try { await bootstrap(); } catch (err) { stopFor(err); }
    render();
    if (phase === "ready") await pull();
    schedulePoll();
  })();

  return {
    ready,
    refresh,
    pull,
    get state() { return state; },
    get changes() { return changes; },
    destroy() {
      destroyed = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (outcomeTimer) clearTimeout(outcomeTimer);
      doc.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
