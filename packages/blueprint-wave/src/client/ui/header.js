// @ts-check
// The header: editable title, presence avatars ("3 here"), connection and saving chips, the Ask
// agent menu (scope, one line of instructions, five operations; disabled with an explanation
// when no model is connected), the History toggle and the Export menu (Markdown in a dialog;
// HTML and PDF are the platform's own export). One roving-tabindex group plus the title input.

import { LIMITS, DEFAULT_TITLE, DEFAULT_NAME, RUN_OPS, RUN_OP_LABELS } from "../../shared/protocol.js";
import { el, svgIcon, avatar, rovingFocus, hereLabel, blipTitle } from "./dom.js";
import { openMenu, closeMenu, showToast, errorMessage, colorDialog, textDialog } from "./dialogs.js";

/** @typedef {import("../store-contract.js").ClientState} ClientState */
/** @typedef {import("../store-contract.js").Change} Change */
/** @typedef {import("../../shared/protocol.js").RunOp} RunOp */

/** What each operation does, one line each, for the menu. */
export const OP_DESCRIPTIONS = Object.freeze({
  summarise: "Evidence, interpretation and open questions",
  compare: "Weigh the options in a thread against each other",
  next_steps: "Propose what to do next",
  refresh_brief: "Propose a rewrite of the brief (you accept or reject it)",
  catch_up: "What changed since a point in time",
});

const MAX_AVATARS = 4;
const HOUR_MS = 3_600_000;

/**
 * @typedef {object} AskScope
 * @property {string[]} [blipIds]   the thread (its root id) or [] / absent for the whole Wave
 * @property {RunOp} [op]           preselect; with sinceSeq, catch_up runs from there
 * @property {number} [sinceSeq]
 */

/**
 * @param {import("./app.js").App} app
 */
export function createHeader(app) {
  const { store } = app;

  // ---- title
  const title = /** @type {HTMLInputElement} */ (el("input", {
    type: "text", class: "wave-title", "aria-label": "Wave title", maxlength: LIMITS.title, autocomplete: "off", spellcheck: "false",
    placeholder: DEFAULT_TITLE,
  }));
  let titleBefore = "";
  const commitTitle = () => {
    const value = title.value.trim();
    const currentTitle = store.getState().meta.title || "";
    if (value && value !== currentTitle) store.setTitle(value);
    else if (!value) title.value = currentTitle || DEFAULT_TITLE;
  };
  title.addEventListener("focus", () => { titleBefore = title.value; });
  title.addEventListener("blur", commitTitle);
  title.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); commitTitle(); title.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); title.value = titleBefore; title.blur(); }
  });

  // ---- presence and chips
  const avatars = el("span", { class: "avatars", "aria-hidden": "true" });
  const hereText = el("span", { class: "here-count" }, "Only you");
  const peopleBtn = el("button", {
    type: "button", class: "btn people-btn", title: "Who is here", onclick: () => app.openPanel("people"),
  }, avatars, hereText);
  const meBtn = el("button", {
    type: "button", class: "btn me-btn", title: "Change your colour", "aria-label": "Change your colour",
    onclick: async () => {
      // The name is the signed-in account's; only the colour can change.
      const v = store.getState().viewer;
      const color = await colorDialog({ name: v.name, color: v.color, returnFocus: meBtn });
      if (color) store.setViewer(v.name, color);
    },
  });
  const conn = el("span", { class: "conn", role: "status", dataset: { state: "connecting" } },
    el("span", { class: "conn-dot", "aria-hidden": "true" }), el("span", { class: "conn-text" }, "Connecting…"));
  const saving = el("span", { class: "saving-chip", role: "status", dataset: { state: "saved" } }, "Saved");

  // ---- actions
  const askBtn = el("button", {
    type: "button", class: "btn ask-agent-btn", "aria-haspopup": "menu", "aria-expanded": "false",
    onclick: () => openAskAgent({}),
  }, svgIcon("sparkle"), el("span", { class: "btn-label" }, "Ask agent"), svgIcon("chevronDown", 14));
  const historyBtn = el("button", {
    type: "button", class: "btn history-toggle", "aria-pressed": "false", title: "View the Wave as it was earlier",
    onclick: () => app.history.toggle(),
  }, svgIcon("history"), el("span", { class: "btn-label" }, "History"));
  const exportBtn = el("button", {
    type: "button", class: "btn export-btn", "aria-haspopup": "menu", "aria-expanded": "false",
    onclick: () => openExportMenu(),
  }, svgIcon("download"), el("span", { class: "btn-label" }, "Export"), svgIcon("chevronDown", 14));

  const root = el("header", { class: "wave-header" },
    el("div", { class: "header-title" }, el("h1", { class: "sr-only" }, "Wave"), title),
    el("div", { class: "header-status" }, peopleBtn, meBtn, conn, saving),
    el("div", { class: "header-actions" }, askBtn, historyBtn, exportBtn),
  );
  const roving = rovingFocus(root, { items: () => [peopleBtn, meBtn, askBtn, historyBtn, exportBtn] });

  // ---- Ask agent
  /**
   * @param {AskScope} scope
   */
  function openAskAgent(scope) {
    const state = store.getState();
    const hasModel = !!state.capabilities.model;
    const focused = app.currentScope();
    let useThread = scope.blipIds ? scope.blipIds.length > 0 : focused.threadId !== null;
    const threadId = scope.blipIds?.length ? scope.blipIds[0] : focused.threadId;
    const threadLabel = threadId ? blipTitle(state.blips[threadId], 40) : "";
    const presetSince = scope.op === "catch_up" && typeof scope.sinceSeq === "number" ? scope.sinceSeq : null;

    const scopeText = el("span", { class: "scope-text" });
    const scopeToggle = el("button", { type: "button", class: "btn small link-btn scope-toggle" });
    const refreshScope = () => {
      scopeText.textContent = useThread && threadId ? `Scope: the thread "${threadLabel}"` : "Scope: the whole Wave";
      scopeToggle.textContent = useThread ? "Use the whole Wave" : "Use this thread";
      scopeToggle.hidden = !threadId;
    };
    scopeToggle.addEventListener("click", () => { useThread = !useThread; refreshScope(); });
    refreshScope();
    const instructions = /** @type {HTMLInputElement} */ (el("input", {
      type: "text", class: "agent-instructions", maxlength: LIMITS.instructions, placeholder: "Instructions (optional, one line)",
      "aria-label": "Instructions for the agent, optional", autocomplete: "off", disabled: !hasModel,
    }));
    const head = el("div", { class: "menu-head" },
      el("div", { class: "menu-title" }, "Ask agent"),
      el("div", { class: "scope-row" }, scopeText, scopeToggle),
      presetSince !== null ? el("div", { class: "muted" }, `Catch up covers changes after version ${presetSince}.`) : null,
      instructions,
    );

    /** @param {RunOp} op @param {number} [sinceSeq] */
    const run = async (op, sinceSeq) => {
      const blipIds = useThread && threadId ? [threadId] : undefined;
      const args = { op, blipIds, sinceSeq, instructions: instructions.value.trim() || undefined };
      let result;
      try { result = await store.askAgent(args); } catch (err) { result = { error: "failed", message: String(/** @type {any} */ (err)?.message ?? err) }; }
      if (result && "error" in result) { showToast(errorMessage(result)); return; }
      app.announce(`${RUN_OP_LABELS[op]} queued`);
      showToast(`${RUN_OP_LABELS[op]} queued. Watch the Agent tab.`, { timeout: 4000, action: { label: "Agent tab", onClick: () => app.openPanel("agent") } });
      if (!app.isPhone()) app.openPanel("agent");
    };

    /** Catch up needs a starting point: a submenu of choices, unless History supplied one. */
    const catchUp = () => {
      if (presetSince !== null) { void run("catch_up", presetSince); return; }
      const now = Date.now();
      const today = new Date(now); today.setHours(0, 0, 0, 0);
      /** @param {number} time @param {string} label */
      const since = async (time, label) => {
        const seq = await app.history.seqAt(time);
        if (seq === null) { showToast(`Nothing has changed ${label}.`); return; }
        void run("catch_up", seq);
      };
      const scrub = app.history.currentSeq();
      const items = [
        { label: "Since the last hour", className: "catch-up-hour", onSelect: () => { void since(now - HOUR_MS, "in the last hour"); } },
        { label: "Since today", className: "catch-up-today", onSelect: () => { void since(today.getTime(), "today"); } },
        { label: "Since I opened this Wave", className: "catch-up-session", onSelect: () => { void run("catch_up", app.sinceSeq); } },
      ];
      if (scrub !== null) items.push({ label: `Since the History scrubber (version ${scrub})`, className: "catch-up-here", onSelect: () => { void run("catch_up", scrub); } });
      const instr = instructions.value;
      setTimeout(() => {
        instructions.value = instr;
        openMenu(askBtn, items, { label: "Catch up since", className: "ask-agent-menu catch-up-menu", head: el("div", { class: "menu-head" }, el("div", { class: "menu-title" }, "Catch up since…")) });
      });
    };

    openMenu(askBtn, RUN_OPS.map((op) => ({
      label: RUN_OP_LABELS[op],
      description: OP_DESCRIPTIONS[op],
      className: "agent-" + op,
      disabled: !hasModel,
      onSelect: () => { if (op === "catch_up") catchUp(); else void run(op); },
    })), {
      label: "Ask agent", className: "ask-agent-menu", head,
      note: hasModel ? "The result appears at the end of the thread (or in the Agent tab for Catch up). Model output cites blip ids; check them." : "Add a model to this Wave in its Connections panel to use Ask agent.",
    });
    if (hasModel && scope.op && scope.op !== "catch_up") {
      const item = /** @type {HTMLElement|null} */ (document.querySelector(`.menu .agent-${scope.op}`));
      item?.focus();
    }
  }

  // ---- Export
  function openExportMenu() {
    /** @param {boolean} decisions */
    const exportMd = async (decisions) => {
      try {
        const md = await store.exportMarkdown({ decisions });
        await textDialog(decisions ? "Decisions as Markdown" : "Wave as Markdown", md, { returnFocus: exportBtn });
      } catch (err) {
        showToast("Couldn't export: " + (/** @type {any} */ (err)?.message ?? err));
      }
    };
    openMenu(exportBtn, [
      { label: "Markdown of the Wave", className: "export-markdown", description: "Every thread, agent output, proposal and decision", onSelect: () => { void exportMd(false); } },
      { label: "Markdown of decisions only", className: "export-decisions", description: "One decision record per decision, with context", onSelect: () => { void exportMd(true); } },
    ], { label: "Export", note: "For HTML or PDF, use the platform's own Export button on this gadget." });
  }

  // ---- render
  let peersKey = "";
  let meKey = "";
  /**
   * @param {ClientState} state
   */
  function render(state) {
    const t = state.meta.title || "";
    if (document.activeElement !== title && title.value !== t) title.value = t;
    // Presence.
    const peers = [...state.peers.values()].sort((a, b) => ((a.name || "") < (b.name || "") ? -1 : 1));
    const key = peers.map((p) => `${p.clientId}:${p.name}:${p.color}`).join("|");
    if (key !== peersKey) {
      peersKey = key;
      const shown = peers.length <= MAX_AVATARS ? peers : peers.slice(0, MAX_AVATARS - 1);
      const hidden = peers.length - shown.length;
      avatars.replaceChildren(
        ...shown.map((p) => { const a = avatar(p.name || DEFAULT_NAME, p.color, "peer-avatar"); a.removeAttribute("role"); a.removeAttribute("aria-label"); return a; }),
        hidden > 0 ? el("span", { class: "avatar more" }, `+${hidden}`) : "",
      );
      hereText.textContent = hereLabel(peers.length);
      peopleBtn.setAttribute("aria-label", peers.length ? `${hereLabel(peers.length)}: ${peers.map((p) => p.name || DEFAULT_NAME).join(", ")}. Open the People tab` : "Only you are here. Open the People tab");
    }
    const v = state.viewer;
    const mk = v.name + v.color;
    if (mk !== meKey) {
      meKey = mk;
      const a = avatar(v.name || DEFAULT_NAME, v.color, "me");
      a.removeAttribute("role"); a.removeAttribute("aria-label");
      meBtn.replaceChildren(a, el("span", { class: "me-name sr-only" }, v.name || DEFAULT_NAME));
      meBtn.title = `${v.name || DEFAULT_NAME}: change your colour`;
      meBtn.setAttribute("aria-label", `${v.name || DEFAULT_NAME}: change your colour`);
    }
    // Connection.
    const c = state.connection;
    if (conn.dataset.state !== c) {
      conn.dataset.state = c;
      /** @type {HTMLElement} */ (conn.querySelector(".conn-text")).textContent = c === "live" ? "Live" : c === "reconnecting" ? "Reconnecting…" : "Connecting…";
    }
    // Saving.
    const s = state.saving === "failed" ? "failed" : state.saving === "saving" || state.pending > 0 ? "saving" : "saved";
    if (saving.dataset.state !== s) {
      saving.dataset.state = s;
      saving.textContent = s === "saved" ? "Saved" : s === "saving" ? "Saving…" : "Couldn't save";
    }
    if (s === "failed") saving.title = state.lastError ? String(state.lastError) : "";
    // Ask agent availability.
    askBtn.title = state.capabilities.model ? "Summarise, compare, propose next steps, refresh the brief or catch up" : "No model connected: add one in the Connections panel";
    askBtn.classList.toggle("no-model", !state.capabilities.model);
    historyBtn.setAttribute("aria-pressed", String(app.history.isActive()));
    roving.refresh();
  }

  return {
    el: root,
    render,
    openAskAgent,
    closeMenus: closeMenu,
    focusFirst() { (roving.first() ?? title).focus(); },
    titleInput: title,
  };
}
