// @ts-check
// The right panel (a bottom sheet on phones): Decisions (latest first, supersedes chain,
// Export), Agent (run cards with scope, sizes, omitted count, timing, Cancel and Retry; catch-up
// results with Post to wave), People (who is here, who is editing what, name and colour) and
// History (the scrubber UI from history.js). Tabs use a roving tabindex.
//
// The pure formatting (run card summary, decision numbering, catch-up Markdown) is exported for
// the unit tests.

import { RUN_OP_LABELS, DEFAULT_NAME } from "../../shared/protocol.js";
import { el, svgIcon, avatar, blipTitle, formatTime, formatBytes, formatDuration, rovingFocus, isPhone, hereLabel } from "./dom.js";
import { showToast, errorMessage, colorDialog, textDialog } from "./dialogs.js";

/** @typedef {import("../store-contract.js").ClientState} ClientState */
/** @typedef {import("../store-contract.js").Change} Change */
/** @typedef {import("../store-contract.js").Peer} Peer */
/** @typedef {import("../../shared/protocol.js").Run} Run */
/** @typedef {import("../../shared/protocol.js").Blip} Blip */
/** @typedef {import("./ui-contract.js").PanelTab} PanelTab */

/** @type {PanelTab[]} */
export const TABS = ["decisions", "agent", "people", "history"];
const TAB_LABELS = { decisions: "Decisions", agent: "Agent", people: "People", history: "History" };
const STATE_LABELS = { queued: "Queued", running: "Running…", done: "Done", failed: "Failed", cancelled: "Cancelled", unknown: "Interrupted" };

// ---------------------------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------------------------

/**
 * What a run card shows. `now` is for durations of running and queued runs.
 * @param {Run} run
 * @param {number} [now]
 */
export function runCardSummary(run, now = Date.now()) {
  const label = /** @type {Record<string, string>} */ (RUN_OP_LABELS)[run.op] ?? "Agent run";
  const state = run.state;
  const scope = run.scope ?? { blipIds: [], sinceSeq: 0, snapshotSeq: 0, inputBytes: 0, omitted: [] };
  const n = scope.blipIds?.length ?? 0;
  const scopeParts = [
    run.op === "catch_up" ? `Changes since version ${scope.sinceSeq ?? 0}` : n ? `${n} ${n === 1 ? "blip" : "blips"}` : "Whole Wave",
  ];
  if (scope.inputBytes) scopeParts.push(`${formatBytes(scope.inputBytes)} in`);
  if (typeof run.outputBytes === "number" && run.outputBytes > 0) scopeParts.push(`${formatBytes(run.outputBytes)} out`);
  const omittedCount = scope.omitted?.length ?? 0;
  const start = run.startedAt ?? run.createdAt;
  let timing = "";
  if (typeof run.finishedAt === "number" && typeof start === "number") timing = `took ${formatDuration(run.finishedAt - start)}`;
  else if (state === "running" && typeof run.startedAt === "number") timing = `running for ${formatDuration(now - run.startedAt)}`;
  else if (state === "queued") timing = `queued ${formatTime(run.createdAt, now)}`;
  else if (state === "unknown") timing = "interrupted by a server restart";
  return {
    label,
    state,
    stateLabel: /** @type {Record<string, string>} */ (STATE_LABELS)[state] ?? state,
    scope: scopeParts.join(" · "),
    omitted: omittedCount ? `${omittedCount} ${omittedCount === 1 ? "blip" : "blips"} left out for the input cap` : null,
    timing,
    error: (state === "failed" || state === "unknown") && run.error ? run.error : null,
    canCancel: state === "queued" || state === "running",
    canRetry: state === "failed" || state === "cancelled" || state === "unknown",
    hasResultBlip: state === "done" && !!run.resultBlipId,
    hasResult: state === "done" && !!run.result && !run.resultBlipId,
  };
}

/**
 * Wave-wide numbers for decisions ("Decision 3"), by recordedAt then id. Deleted ones excluded.
 * @param {Record<string, Blip>} blips
 * @returns {Map<string, number>}
 */
export function decisionNumbers(blips) {
  const list = Object.values(blips).filter((b) => b && b.kind === "decision" && !b.deleted)
    .sort((a, b) => ((a.decision?.recordedAt ?? a.createdAt) - (b.decision?.recordedAt ?? b.createdAt)) || (a.id < b.id ? -1 : 1));
  return new Map(list.map((b, i) => [b.id, i + 1]));
}

/**
 * Runs for the Agent tab: newest first.
 * @param {Record<string, Run>} runs
 */
export function sortRuns(runs) {
  return Object.values(runs).filter(Boolean).sort((a, b) => (b.createdAt - a.createdAt) || (a.id < b.id ? 1 : -1));
}

/**
 * The Markdown "Post to wave" writes for a catch-up result.
 * @param {Run} run
 */
export function catchUpMarkdown(run) {
  const r = run.result;
  if (!r) return "";
  const lines = [`**Catch-up** (changes since version ${run.scope?.sinceSeq ?? 0})`, ""];
  if (r.summary) lines.push(r.summary, "");
  if (r.body) lines.push(r.body.trim(), "");
  if (r.questions?.length) {
    lines.push("Open questions:", "");
    for (const q of r.questions) lines.push(`- ${q}`);
    lines.push("");
  }
  if (r.sources?.length) lines.push(`Sources: ${r.sources.join(", ")}`);
  return lines.join("\n").trim();
}

/**
 * Where a catch-up is posted: the brief, else the first root, else null.
 * @param {ClientState} state
 * @returns {string|null}
 */
export function postTarget(state) {
  const live = Object.values(state.blips).filter((b) => b && !b.deleted && b.parentId === null);
  const brief = live.find((b) => b.kind === "brief");
  if (brief) return brief.id;
  const first = state.meta.rootOrder.map((id) => state.blips[id]).find((b) => b && !b.deleted) ?? live[0];
  return first ? first.id : null;
}

/**
 * One line about what a peer is doing.
 * @param {Peer} peer @param {Record<string, Blip>} blips
 */
export function peerActivity(peer, blips) {
  const blip = peer.blipId ? blips[peer.blipId] : null;
  if (!blip) return "here";
  return `${peer.editing ? "editing" : "reading"} ${blipTitle(blip, 40)}`;
}

// ---------------------------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------------------------

/**
 * @param {import("./app.js").App} app
 */
export function createPanel(app) {
  const { store } = app;
  /** @type {PanelTab} */
  let current = "decisions";
  let open = !isPhone();
  /** @type {Set<PanelTab>} */
  const dirty = new Set(TABS);
  /** @type {any} */
  let tickTimer = null;

  const tabButtons = /** @type {Record<PanelTab, HTMLButtonElement>} */ ({});
  const counts = /** @type {Record<PanelTab, HTMLElement>} */ ({});
  const tabs = el("div", { class: "panel-tabs", role: "tablist", "aria-label": "Panel" },
    TABS.map((tab) => {
      counts[tab] = el("span", { class: "tab-count", hidden: true });
      tabButtons[tab] = /** @type {HTMLButtonElement} */ (el("button", {
        type: "button", class: "panel-tab", dataset: { tab }, role: "tab", id: "panel-tab-" + tab,
        "aria-selected": String(tab === current), "aria-controls": "panel-body", tabindex: tab === current ? "0" : "-1",
        onclick: () => {
          if (isPhone() && open && current === tab) { close(); return; }
          select(tab, true);
        },
      }, TAB_LABELS[tab], counts[tab]));
      return tabButtons[tab];
    }),
  );
  const roving = rovingFocus(tabs);
  const body = el("div", { class: "panel-body", role: "tabpanel", id: "panel-body", "aria-labelledby": "panel-tab-" + current, tabindex: "-1" });
  const closeBtn = el("button", { type: "button", class: "btn icon-only panel-close", "aria-label": "Close panel", onclick: () => close() }, svgIcon("close", 18));
  const root = el("aside", { class: "wave-panel", "aria-label": "Panel", dataset: { open: String(open) } }, tabs, el("div", { class: "panel-sheet" }, closeBtn, body));
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isPhone() && open && !e.defaultPrevented) { e.preventDefault(); close(); }
  });

  /** @param {PanelTab} tab @param {boolean} [show] */
  function select(tab, show = true) {
    if (!TABS.includes(tab)) return;
    current = tab;
    for (const t of TABS) tabButtons[t].setAttribute("aria-selected", String(t === tab));
    roving.refresh(tabButtons[tab]);
    body.setAttribute("aria-labelledby", "panel-tab-" + tab);
    body.dataset.tab = tab;
    if (show && !open) { open = true; root.dataset.open = "true"; }
    dirty.add(tab);
    renderCurrent(store.getState());
  }

  function close() {
    if (!isPhone()) return;
    open = false;
    root.dataset.open = "false";
    tabButtons[current].focus({ preventScroll: true });
  }

  // ---- content
  const bodies = /** @type {Record<PanelTab, HTMLElement>} */ ({
    decisions: el("div", { class: "decisions-tab" }),
    agent: el("div", { class: "agent-tab" }),
    people: el("div", { class: "people-tab" }),
    history: app.history.el,
  });

  /** @param {ClientState} state */
  function renderDecisions(state) {
    const numbers = decisionNumbers(state.blips);
    const list = [...numbers.keys()].map((id) => state.blips[id]).reverse();
    const exportBtn = el("button", {
      type: "button", class: "btn outline small export-decisions-btn", disabled: !list.length,
      onclick: async () => {
        try {
          const md = await store.exportMarkdown({ decisions: true });
          await textDialog("Decisions as Markdown", md, { returnFocus: exportBtn });
        } catch (err) { showToast("Couldn't export: " + (/** @type {any} */ (err)?.message ?? err)); }
      },
    }, svgIcon("download"), "Export decisions");
    const items = list.map((d) => {
      const n = numbers.get(d.id) ?? 0;
      const dec = d.decision;
      const supersedes = dec?.supersedes && numbers.has(dec.supersedes) ? numbers.get(dec.supersedes) : null;
      const supersededBy = dec?.supersededBy && numbers.has(dec.supersededBy) ? numbers.get(dec.supersededBy) : null;
      const rootId = threadRootId(state.blips, d.id);
      const rootBlip = rootId ? state.blips[rootId] : null;
      return el("li", { class: "decision-item" + (supersededBy ? " superseded" : ""), dataset: { bid: d.id } },
        el("button", {
          type: "button", class: "btn decision-link", onclick: () => app.conversation.focusBlip(d.id, { scroll: true, highlight: true }),
        }, svgIcon("lock", 14), el("span", { class: "decision-n" }, `Decision ${n}`), el("span", { class: "decision-text" }, blipTitle(d, 120))),
        el("div", { class: "muted decision-meta" },
          `recorded by ${dec?.recordedBy || d.by || DEFAULT_NAME} (unverified) · ${formatTime(dec?.recordedAt ?? d.createdAt)}`,
          rootBlip && rootBlip.id !== d.id ? ` · in ${blipTitle(rootBlip, 40)}` : ""),
        supersedes || supersededBy ? el("div", { class: "muted decision-chain" },
          supersedes ? el("button", { type: "button", class: "btn link-btn", onclick: () => app.conversation.focusBlip(/** @type {string} */ (dec?.supersedes), { scroll: true, highlight: true }) }, `supersedes Decision ${supersedes}`) : null,
          supersedes && supersededBy ? " · " : null,
          supersededBy ? el("button", { type: "button", class: "btn link-btn", onclick: () => app.conversation.focusBlip(/** @type {string} */ (dec?.supersededBy), { scroll: true, highlight: true }) }, `superseded by Decision ${supersededBy}`) : null,
        ) : null,
      );
    });
    bodies.decisions.replaceChildren(
      el("div", { class: "tab-toolbar" }, el("h2", null, "Decisions"), exportBtn),
      list.length
        ? el("ol", { class: "decision-list", reversed: true }, items)
        : el("p", { class: "muted" }, "No decisions yet. Open a thread and use Record decision; the dialog is prefilled from the brief and any accepted proposal."),
    );
    counts.decisions.hidden = !list.length;
    counts.decisions.textContent = String(list.length);
  }

  /**
   * A run card (also shown by the "Show run" dialog).
   * @param {Run} run
   * @param {ClientState} state
   */
  function renderRunCard(run, state) {
    const s = runCardSummary(run);
    const actions = [];
    if (s.canCancel) {
      actions.push(el("button", {
        type: "button", class: "btn small outline run-cancel", onclick: async (/** @type {MouseEvent} */ e) => {
          const b = /** @type {HTMLButtonElement} */ (e.currentTarget); b.disabled = true;
          const r = await store.cancelRun(run.id).catch((err) => ({ error: "failed", message: String(err?.message ?? err) }));
          if (r && "error" in r) { showToast(errorMessage(r)); b.disabled = false; }
        },
      }, svgIcon("stop", 14), "Cancel"));
    }
    if (s.canRetry) {
      actions.push(el("button", {
        type: "button", class: "btn small outline run-retry", onclick: async (/** @type {MouseEvent} */ e) => {
          const b = /** @type {HTMLButtonElement} */ (e.currentTarget); b.disabled = true;
          const r = await store.retryRun(run.id).catch((err) => ({ error: "failed", message: String(err?.message ?? err) }));
          if (r && "error" in r) { showToast(errorMessage(r)); b.disabled = false; } else app.announce(`${s.label} queued again`);
        },
      }, svgIcon("refresh", 14), "Retry"));
    }
    if (s.hasResultBlip) {
      actions.push(el("button", {
        type: "button", class: "btn small outline run-show", onclick: () => app.conversation.focusBlip(/** @type {string} */ (run.resultBlipId), { scroll: true, highlight: true }),
      }, "Show result"));
    }
    /** @type {HTMLElement|null} */
    let resultEl = null;
    if (s.hasResult && run.result) {
      const target = postTarget(state);
      const postBtn = el("button", {
        type: "button", class: "btn small primary run-post", disabled: !target,
        title: target ? "Post this catch-up as a reply under the brief" : "Nothing to post under yet",
        onclick: async (/** @type {MouseEvent} */ e) => {
          const b = /** @type {HTMLButtonElement} */ (e.currentTarget); b.disabled = true;
          if (!target) return;
          const r = await store.reply({ parentId: target, text: catchUpMarkdown(run) }).catch((err) => ({ error: "failed", message: String(err?.message ?? err) }));
          if (r && "error" in r) { showToast(errorMessage(r)); b.disabled = false; return; }
          showToast("Posted to the Wave");
          app.conversation.focusBlip(r.blip.id, { scroll: true, highlight: true });
        },
      }, "Post to wave");
      actions.push(postBtn);
      resultEl = el("div", { class: "run-result" },
        run.result.summary ? el("p", { class: "run-summary" }, el("strong", null, run.result.summary)) : null,
        app.renderMarkdown(run.result.body || ""),
        run.result.questions?.length ? el("div", null, el("strong", null, "Open questions"), el("ul", null, run.result.questions.map((q) => el("li", null, q)))) : null,
        run.result.sources?.length ? el("div", { class: "sources" }, "sources: ", run.result.sources.map((id, i) => [
          i ? ", " : null,
          el("button", { type: "button", class: "btn link-btn bliplink", onclick: () => app.conversation.focusBlip(id, { scroll: true, highlight: true }) }, id),
        ])) : null,
      );
    }
    return el("article", { class: "run-card", dataset: { run: run.id, state: run.state }, "aria-label": `${s.label}, ${s.stateLabel}`, tabindex: "-1" },
      el("div", { class: "run-head" }, svgIcon("robot", 16), el("span", { class: "run-op" }, s.label), el("span", { class: "run-state", dataset: { state: run.state } }, s.stateLabel)),
      el("div", { class: "muted run-meta" }, `by ${run.by || DEFAULT_NAME} · ${formatTime(run.createdAt)}`),
      run.instructions ? el("div", { class: "run-instructions" }, "Instructions: ", el("q", null, run.instructions)) : null,
      el("div", { class: "muted run-scope" }, s.scope),
      s.omitted ? el("div", { class: "run-omitted" }, svgIcon("warn", 14), s.omitted) : null,
      s.timing ? el("div", { class: "muted run-timing" }, s.timing) : null,
      s.error ? el("div", { class: "run-error" }, s.error) : null,
      resultEl,
      actions.length ? el("div", { class: "run-actions" }, actions) : null,
    );
  }

  /** @param {ClientState} state */
  function renderAgent(state) {
    const runs = sortRuns(state.runs);
    const askBtn = el("button", {
      type: "button", class: "btn primary small agent-ask-btn", onclick: () => app.openAskAgent({}),
    }, svgIcon("sparkle", 14), "Ask agent");
    bodies.agent.replaceChildren(
      el("div", { class: "tab-toolbar" }, el("h2", null, "Agent"), askBtn),
      // Not null: replaceChildren turns null into the text "null".
      state.capabilities.model ? "" : el("p", { class: "muted no-model-note" }, "No model is connected. Add a model to this Wave in its Connections panel to use Ask agent."),
      runs.length
        ? el("div", { class: "run-list" }, runs.map((run) => renderRunCard(run, state)))
        : el("p", { class: "muted" }, "No runs yet. Ask agent summarises a thread or the Wave, compares options, proposes next steps, refreshes the brief or catches you up."),
    );
    const active = runs.filter((r) => r.state === "queued" || r.state === "running").length;
    counts.agent.hidden = !active;
    counts.agent.textContent = String(active);
    // Running durations tick while the tab shows a running run.
    clearTimeout(tickTimer);
    if (runs.some((r) => r.state === "running") && current === "agent") tickTimer = setTimeout(() => { dirty.add("agent"); renderCurrent(store.getState()); }, 1000);
  }

  /** @param {ClientState} state */
  function renderPeople(state) {
    const v = state.viewer;
    const peers = [...state.peers.values()].sort((a, b) => ((a.name || "") < (b.name || "") ? -1 : 1));
    const changeBtn = el("button", {
      type: "button", class: "btn outline small change-color-btn", onclick: async () => {
        const color = await colorDialog({ name: v.name, color: v.color, returnFocus: changeBtn });
        if (color) store.setViewer(v.name, color);
      },
    }, "Change colour");
    bodies.people.replaceChildren(
      el("div", { class: "tab-toolbar" }, el("h2", null, "People"), el("span", { class: "muted" }, hereLabel(peers.length))),
      el("div", { class: "people" },
        el("div", { class: "peer me" }, avatar(v.name || DEFAULT_NAME, v.color), el("span", { class: "peer-name" }, v.name || DEFAULT_NAME, el("span", { class: "muted" }, " (you)")), changeBtn),
        peers.length
          ? el("ul", { class: "peer-list" }, peers.map((p) => el("li", { class: "peer", dataset: { client: p.clientId } },
            avatar(p.name || DEFAULT_NAME, p.color),
            el("span", { class: "peer-name" }, p.name || DEFAULT_NAME),
            el("span", { class: "muted peer-activity" }, peerActivity(p, state.blips)),
            p.blipId && state.blips[p.blipId] ? el("button", {
              type: "button", class: "btn small link-btn", onclick: () => app.conversation.focusBlip(/** @type {string} */ (p.blipId), { scroll: true, highlight: true }),
            }, "Show") : null,
          )))
          : el("p", { class: "muted" }, "Nobody else is here right now."),
      ),
      el("p", { class: "muted" }, "Everyone appears under their account's display name. The server does not check the name a client sends."),
    );
  }

  /** @param {ClientState} state */
  function renderCurrent(state) {
    if (body.firstChild !== bodies[current]) body.replaceChildren(bodies[current]);
    if (!dirty.has(current)) return;
    dirty.delete(current);
    if (current === "decisions") renderDecisions(state);
    else if (current === "agent") renderAgent(state);
    else if (current === "people") renderPeople(state);
  }

  /** @param {ClientState} state */
  function renderCounts(state) {
    const n = decisionNumbers(state.blips).size;
    counts.decisions.hidden = !n;
    counts.decisions.textContent = String(n);
    const active = Object.values(state.runs).filter((r) => r && (r.state === "queued" || r.state === "running")).length;
    counts.agent.hidden = !active;
    counts.agent.textContent = String(active);
    const others = state.peers.size;
    counts.people.hidden = !others;
    counts.people.textContent = String(others);
  }

  const phone = typeof matchMedia === "function" ? matchMedia("(max-width: 720px)") : null;
  phone?.addEventListener?.("change", (e) => {
    open = !e.matches;
    root.dataset.open = String(open);
  });

  select(current, false);

  return {
    el: root,
    /** @param {PanelTab} tab */
    open(tab) { select(tab, true); if (isPhone()) body.focus({ preventScroll: true }); },
    close,
    isOpen: () => open,
    current: () => current,
    renderRunCard,
    /**
     * @param {ClientState} state
     * @param {Change} change
     */
    render(state, change) {
      switch (change.kind) {
        case "snapshot": for (const t of TABS) dirty.add(t); break;
        case "blips": case "meta": dirty.add("decisions"); dirty.add("agent"); dirty.add("people"); break;
        case "runs": dirty.add("agent"); break;
        case "presence": case "viewer": dirty.add("people"); break;
        case "connection": dirty.add("agent"); break;
        default: break;
      }
      renderCounts(state);
      renderCurrent(state);
    },
  };
}

/**
 * The root of the thread a blip is in.
 * @param {Record<string, Blip>} blips @param {string} id
 */
export function threadRootId(blips, id) {
  let cur = blips[id];
  for (let i = 0; cur && cur.parentId && i < 12; i++) cur = blips[cur.parentId];
  return cur ? cur.id : null;
}
