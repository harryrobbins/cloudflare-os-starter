// @ts-check
// The app shell: header, conversation in the centre, right panel (a bottom sheet on phones), the
// Shell services the conversation calls (announce, dialogs, Ask agent, Record decision, panel),
// the capture-phase undo interceptor, the polite live region, toasts, the first-open template
// picker, and routing of every store Change to the narrowest re-render. The conversation
// (./conversation.js, stream C1) owns its element and every gesture inside it; see ui-contract.js.

import { DEFAULT_TITLE, RUN_OP_LABELS } from "../../shared/protocol.js";
import { parseMarkdown } from "../../shared/markdown.js";
import { createConversation } from "./conversation.js";
import { renderMarkdown } from "./render.js";
import { el, createAnnouncer, undoAction, isTextField, isPhone, blipTitle } from "./dom.js";
import { injectStyles } from "./styles.js";
import { createHeader } from "./header.js";
import { createPanel, threadRootId } from "./panel.js";
import { createHistory } from "./history.js";
import { createTemplatePicker } from "./templates.js";
import { SEL } from "./ui-contract.js";
import {
  showToast, ensureToastHost, closeMenu, currentMenu, isModalOpen, errorMessage,
  confirmDialog, colorDialog, decisionDialog, runDialog,
} from "./dialogs.js";

export { injectStyles };

/** @typedef {import("../store-contract.js").Store} Store */
/** @typedef {import("../store-contract.js").ClientState} ClientState */
/** @typedef {import("../store-contract.js").Change} Change */
/** @typedef {import("./ui-contract.js").ConversationController} ConversationController */
/** @typedef {import("./ui-contract.js").Shell} Shell */
/** @typedef {import("./ui-contract.js").PanelTab} PanelTab */
/** @typedef {import("../../shared/protocol.js").WaveEvent} WaveEvent */
/** @typedef {import("../../shared/protocol.js").Blip} Blip */

/**
 * Shared shell context handed to header, panel and history.
 * @typedef {object} App
 * @property {Store} store
 * @property {HTMLElement} root                 the .wave-app element
 * @property {ConversationController} conversation
 * @property {Shell} shell
 * @property {ReturnType<typeof createHistory>} history
 * @property {ReturnType<typeof createPanel>} panel
 * @property {ReturnType<typeof createHeader>} header
 * @property {(message: string) => void} announce   polite, rate-limited
 * @property {() => boolean} isPhone
 * @property {(text: string) => HTMLElement} renderMarkdown
 * @property {(scope: import("./header.js").AskScope) => void} openAskAgent
 * @property {(threadId: string) => Promise<void>} recordDecision
 * @property {(runId: string) => Promise<void>} showRun
 * @property {(tab: PanelTab) => void} openPanel
 * @property {() => {threadId: string|null, blipIds: string[]}} currentScope  the focused thread, or the whole Wave
 * @property {number} sinceSeq                  the since marker (blips changed after it carry a dot)
 * @property {(seq: number) => void} setSinceSeq
 * @property {string|null} editingBlipId        the blip whose editor or composer is open, if any
 * @property {(active: boolean) => void} [onHistoryChange]
 */

/** How long a non-live connection goes before the banner explains itself. */
const CONN_BANNER_MS = 3000;
/** A remote event by this viewer's own name within this long of a local action is treated as ours. */
const OWN_EVENT_WINDOW_MS = 15000;

/**
 * A short sentence for the live region about someone else's change, or null when it is not
 * worth announcing. Pure.
 * @param {WaveEvent} e
 * @param {Record<string, Blip>} blips
 * @param {Record<string, import("../../shared/protocol.js").Run>} runs
 * @returns {string|null}
 */
export function describeForAnnouncement(e, blips, runs) {
  const by = e.by || "Someone";
  const blip = e.blipId ? blips[e.blipId] : null;
  const rootId = e.blipId ? threadRootId(blips, e.blipId) : null;
  const root = rootId ? blips[rootId] : null;
  const inThread = root && root.id !== blip?.id ? ` in ${blipTitle(root, 40)}` : "";
  switch (e.kind) {
    case "blip.create":
      if (!blip) return `${by} added a blip`;
      if (blip.kind === "agent") return `New agent output${inThread}`;
      if (blip.kind === "proposal") return `New proposal${inThread}`;
      if (blip.kind === "decision") return null; // decision.record covers it
      if (!blip.parentId) return `${by} started a thread: ${blipTitle(blip, 40)}`;
      return `New reply from ${by}${inThread}`;
    case "text":
      if (!blip) return null;
      if (blip.kind === "brief") return `${by} edited the brief`;
      if (!blip.parentId) return `${by} edited the thread ${blipTitle(blip, 40)}`;
      return `${by} edited a reply${inThread}`;
    case "blip.delete": return `${by} deleted ${blip ? blipTitle(blip, 40) : "a blip"}`;
    case "blip.restore": return `${by} restored ${blip ? blipTitle(blip, 40) : "a blip"}`;
    case "decision.record": return `${by} recorded a decision${inThread || (root ? ` in ${blipTitle(root, 40)}` : "")}`;
    case "proposal.accept": return `${by} accepted a proposal${inThread}`;
    case "proposal.reject": return `${by} rejected a proposal${inThread}`;
    case "run.done": {
      const run = e.runId ? runs[e.runId] : null;
      return `The agent finished ${run ? RUN_OP_LABELS[run.op] : "a run"}`;
    }
    case "run.failed": return "An agent run failed";
    case "structure": return e.detail ? `${by} renamed the Wave to ${e.detail}` : null;
    default: return null;
  }
}

/**
 * @param {HTMLElement} root
 * @param {Store} store
 * @param {{exportMode?: boolean, sinceSeq?: number|null}} [options]
 * @returns {{app: App, conversation: ConversationController, unsubscribe: () => void}}
 */
export function mountApp(root, store, { exportMode = false, sinceSeq = null } = {}) {
  injectStyles();
  ensureToastHost();
  let live = /** @type {HTMLElement|null} */ (document.body.querySelector(".live-region"));
  if (!live) {
    live = el("div", { class: "sr-only live-region", "aria-live": "polite", "aria-atomic": "true" });
    document.body.appendChild(live);
  }
  const announcer = createAnnouncer(live);
  const announce = announcer.announce;

  // Calls made through the UI are this viewer's own; remote-change announcements skip them.
  let lastLocalAt = 0;
  const markLocal = () => { lastLocalAt = Date.now(); };
  const initial = store.getState();

  /** @type {App} */
  const app = /** @type {App} */ ({
    store,
    root: el("div", { class: "wave-app" }),
    announce,
    isPhone,
    sinceSeq: typeof sinceSeq === "number" ? Math.min(sinceSeq, initial.seq) : initial.seq,
    editingBlipId: null,
    renderMarkdown(text) {
      return renderMarkdown(parseMarkdown(text || ""), { onBlipLink: (id) => app.conversation.focusBlip(id, { scroll: true, highlight: true }) });
    },
    setSinceSeq(seq) { app.sinceSeq = seq; app.conversation.setSinceSeq(seq); },
    currentScope() {
      const focus = app.conversation.getFocus();
      const state = store.getState();
      const threadId = focus.threadId ?? (focus.blipId ? threadRootId(state.blips, focus.blipId) : null);
      return { threadId, blipIds: threadId ? [threadId] : [] };
    },
    openAskAgent(scope) { markLocal(); app.header.openAskAgent(scope); },
    openPanel(tab) { app.panel.open(tab); },
    async showRun(runId) {
      const state = store.getState();
      const run = state.runs[runId];
      if (!run) { showToast("That run is no longer listed (the last 50 are kept)."); return; }
      await runDialog(run, { card: app.panel.renderRunCard(run, state) });
    },
    async recordDecision(threadId) {
      const state = store.getState();
      const rootId = threadRootId(state.blips, threadId);
      if (!rootId) { showToast("That thread no longer exists."); return; }
      const inThread = (/** @type {Blip} */ b) => !b.deleted && threadRootId(state.blips, b.id) === rootId;
      const brief = Object.values(state.blips).find((b) => b && !b.deleted && b.kind === "brief" && b.parentId === null) ?? null;
      const accepted = Object.values(state.blips).filter((b) => b && b.kind === "proposal" && b.proposal?.state === "accepted" && inThread(b))
        .sort((a, b) => (b.proposal?.reviewedAt ?? 0) - (a.proposal?.reviewedAt ?? 0))[0] ?? null;
      const decisions = Object.values(state.blips).filter((b) => b && b.kind === "decision" && inThread(b))
        .sort((a, b) => (a.decision?.recordedAt ?? 0) - (b.decision?.recordedAt ?? 0));
      const textOf = async (/** @type {Blip|null} */ b) => {
        if (!b) return "";
        try {
          const handle = await store.openBlip(b.id);
          const text = handle.text.toString();
          handle.close();
          return text;
        } catch { return b.preview || ""; }
      };
      const [briefText, threadText] = await Promise.all([textOf(brief), textOf(state.blips[rootId])]);
      const returnFocus = () => /** @type {HTMLElement|null} */ (document.querySelector(SEL.blip(threadId)) ?? document.querySelector(SEL.blip(rootId)));
      const fields = await decisionDialog({ thread: state.blips[rootId], threadText, brief: briefText, acceptedProposal: accepted, decisions, returnFocus });
      if (!fields) return;
      markLocal();
      let result;
      try { result = await store.recordDecision({ threadId: rootId, ...fields }); } catch (err) { result = { error: "failed", message: String(/** @type {any} */ (err)?.message ?? err) }; }
      if (result && "error" in result) { showToast(errorMessage(result)); return; }
      announce("Decision recorded");
      app.conversation.focusBlip(result.blip.id, { scroll: true, highlight: true });
    },
  });

  /** @type {Shell} */
  const shell = {
    announce,
    async openDialog(kind, args = {}) {
      switch (kind) {
        case "confirm": return confirmDialog({ title: args.title ?? "Are you sure?", message: args.message, confirmLabel: args.confirmLabel, cancelLabel: args.cancelLabel, danger: args.danger, returnFocus: args.returnFocus });
        case "color": {
          // Colour only: the name is the signed-in account's and never asked for.
          const v = store.getState().viewer;
          const color = await colorDialog({ name: v.name, color: args.color ?? v.color, returnFocus: args.returnFocus });
          if (color && args.apply !== false) store.setViewer(v.name, color);
          return color;
        }
        case "decision": {
          const state = store.getState();
          const rootId = args.threadId ? threadRootId(state.blips, args.threadId) : null;
          const decisions = rootId ? Object.values(state.blips).filter((b) => b && b.kind === "decision" && !b.deleted && threadRootId(state.blips, b.id) === rootId)
            .sort((a, b) => (a.decision?.recordedAt ?? 0) - (b.decision?.recordedAt ?? 0)) : [];
          return decisionDialog({ thread: rootId ? state.blips[rootId] : null, brief: args.brief ?? "", acceptedProposal: args.acceptedProposal ?? null, decisions, returnFocus: args.returnFocus });
        }
        case "run": return app.showRun(typeof args === "string" ? args : args.runId);
        default: return null;
      }
    },
    askAgent(scope) { app.openAskAgent({ blipIds: scope.blipIds, op: scope.op }); },
    recordDecision(threadId) { void app.recordDecision(threadId); },
    openPanel(tab) { app.openPanel(tab); },
    isHistoryMode: () => app.history?.isActive() ?? false,
  };
  app.shell = shell;

  // ---- parts (order matters: the conversation before history, history before the panel)
  const conversation = createConversation(store, shell, {
    exportMode,
    playbackText: (/** @type {string} */ id) => app.history.playbackText(id),
  });
  app.conversation = conversation;
  app.history = createHistory(app);
  app.panel = createPanel(app);
  app.header = createHeader(app);
  const templates = createTemplatePicker({ store, announce, onApplied: () => { markLocal(); conversation.element.focus?.({ preventScroll: true }); } });
  const connBanner = el("div", { class: "conn-banner", role: "status", hidden: true },
    el("span", { class: "conn-banner-text" }, "Reconnecting…"),
    el("span", { class: "muted" }, " Your edits are kept here and sent when the connection returns."));

  const centre = el("main", { class: "wave-centre", "aria-label": "Conversation" }, connBanner, app.history.banner, templates.el, conversation.element);
  // DOM order sets the Tab order: conversation, then header, then panel (plan 3.6).
  app.root.append(centre, app.header.el, app.panel.el);
  root.replaceChildren(app.root);
  conversation.setSinceSeq(app.sinceSeq);
  app.onHistoryChange = (active) => {
    app.root.classList.toggle("history-mode", active);
    app.header.render(store.getState());
  };

  // ---- conversation events
  conversation.on((event) => {
    switch (event.kind) {
      case "editing":
        markLocal();
        app.editingBlipId = event.editing ? (event.blipId ?? null) : null;
        break;
      case "request-panel": if (event.tab) app.openPanel(event.tab); break;
      case "request-agent": app.openAskAgent({ blipIds: event.blipIds ?? [] }); break;
      case "request-decision": if (event.threadId) void app.recordDecision(event.threadId); break;
      case "request-run": if (event.runId) void app.showRun(event.runId); break;
      default: break;
    }
  });
  conversation.element.addEventListener("pointerdown", markLocal, true);
  conversation.element.addEventListener("keydown", markLocal, true);

  // ---- keyboard: undo outside editors is ignored (never the browser's native undo, which
  // refocuses the last edited field); inside an editor the binding routes it to Y.UndoManager.
  const onUndoKey = (/** @type {KeyboardEvent} */ e) => {
    if (isTextField(e.target)) return;
    if (undoAction(e)) e.preventDefault();
  };
  window.addEventListener("keydown", onUndoKey, { capture: true });
  // Escape: History mode returns to live (after the conversation, menus, dialogs and the phone
  // panel have had their turn).
  const onEscape = (/** @type {KeyboardEvent} */ e) => {
    if (e.key !== "Escape" || e.defaultPrevented || isTextField(e.target) || currentMenu() || isModalOpen()) return;
    if (app.history.isActive()) { e.preventDefault(); app.history.exit(); }
  };
  document.addEventListener("keydown", onEscape);

  // ---- store changes
  let lastErrorShown = /** @type {string|null} */ (null);
  /** @type {any} */
  let connTimer = null;
  const mountedAt = Date.now();

  /** @param {ClientState} state */
  function renderConnection(state) {
    clearTimeout(connTimer);
    if (state.connection === "live") { connBanner.hidden = true; return; }
    connTimer = setTimeout(() => {
      const s = store.getState();
      if (s.connection === "live") return;
      /** @type {HTMLElement} */ (connBanner.querySelector(".conn-banner-text")).textContent = s.connection === "reconnecting" ? "Reconnecting…" : "Connecting…";
      connBanner.hidden = false;
    }, CONN_BANNER_MS);
  }

  /** @param {ClientState} state @param {WaveEvent[]} events */
  function announceEvents(state, events) {
    const own = state.viewer.name || "Guest";
    for (const e of events) {
      if (!e || e.at < mountedAt - 5000) continue;
      if (e.by === own && Date.now() - lastLocalAt < OWN_EVENT_WINDOW_MS) continue;
      if (e.by === own && e.kind === "text") continue;
      const text = describeForAnnouncement(e, state.blips, state.runs);
      if (text) announce(text);
    }
  }

  /**
   * @param {ClientState} state
   * @param {Change} change
   */
  function onChange(state, change) {
    switch (change.kind) {
      case "snapshot":
        app.header.render(state);
        app.panel.render(state, change);
        app.history.render(state, change);
        templates.render(state);
        renderConnection(state);
        break;
      case "blips":
      case "meta":
        app.header.render(state);
        app.panel.render(state, change);
        app.history.render(state, change);
        templates.render(state);
        break;
      case "runs":
        app.panel.render(state, change);
        break;
      case "presence":
      case "viewer":
        app.header.render(state);
        app.panel.render(state, change);
        break;
      case "connection":
        app.header.render(state);
        app.panel.render(state, change);
        templates.render(state);
        renderConnection(state);
        break;
      case "saving":
        app.header.render(state);
        break;
      case "events":
        if (change.events) announceEvents(state, change.events);
        app.history.render(state, change);
        break;
      case "text":
        app.history.render(state, change);
        break;
      default:
        break;
    }
    const t = state.meta.title || DEFAULT_TITLE;
    if (document.title !== t) document.title = t;
    if (state.lastError && state.lastError !== lastErrorShown) {
      showToast(errorMessage({ error: state.lastError }));
      lastErrorShown = state.lastError;
    }
    if (!state.lastError) lastErrorShown = null;
  }

  onChange(initial, { kind: "snapshot" });
  const unsubscribe = store.subscribe(onChange);

  // Leave presence promptly when the iframe goes away.
  window.addEventListener("pagehide", () => { closeMenu(); store.dispose(); });

  return {
    app,
    conversation,
    unsubscribe() {
      unsubscribe();
      window.removeEventListener("keydown", onUndoKey, { capture: true });
      document.removeEventListener("keydown", onEscape);
      conversation.destroy();
    },
  };
}
