// @ts-check
// The interface between the conversation view (stream C1: src/client/ui/{conversation,blip,
// composer,keymap}.js: cards, threads, focus view, paragraph replies, edit mode, keyboard
// navigation) and the app shell (stream C2: src/client/ui/{app,header,panel,dialogs,history,
// export,templates,styles}.js: layout, header, side panel, Ask agent menu, run cards, decision
// dialog, History mode, export, templates, phone layout). Types plus the DOM selectors the two
// UI streams and the e2e suites share.
//
// The shell owns the DOM around the conversation and every button outside it; the conversation
// owns its element and every gesture inside it. Both talk to the Store
// (src/client/store-contract.js); neither calls `gadget`. Rendering blip text goes through
// src/shared/markdown.js and the client's node builder; never innerHTML with user text.

/** @typedef {import("../store-contract.js").Store} Store */
/** @typedef {import("../../shared/protocol.js").Anchor} Anchor */
/** @typedef {import("../../shared/protocol.js").RunOp} RunOp */

/**
 * What the conversation has focused: a blip card (roving tabindex), and optionally a thread
 * shown full width (focus view).
 * @typedef {{blipId: string|null, threadId: string|null}} Focus
 */

/**
 * @typedef {object} ConversationEvents
 * @property {"focus"|"editing"|"thread"|"request-panel"|"request-agent"|"request-decision"|"request-run"} kind
 *   focus:            the focused blip changed; carries {blipId}.
 *   editing:          an editor or composer opened or closed; carries {blipId, editing}.
 *   thread:           the focus view opened (threadId) or closed (null); carries {threadId}.
 *   request-panel:    the conversation asks the shell to open a panel tab; carries {tab}.
 *   request-agent:    "Ask agent" from a card's menu; carries {blipIds} (the thread's scope).
 *   request-decision: "Record decision" from a thread; carries {threadId}.
 *   request-run:      "Show run" on an agent card; carries {runId}.
 * @property {string|null} [blipId]
 * @property {string|null} [threadId]
 * @property {boolean} [editing]
 * @property {PanelTab} [tab]
 * @property {string[]} [blipIds]
 * @property {string} [runId]
 */

/**
 * @typedef {"decisions"|"agent"|"people"|"history"} PanelTab
 */

/**
 * @typedef {object} ConversationController
 * @property {HTMLElement} element                  the scrollable conversation the shell places in its layout
 * @property {(id: string, options?: {scroll?: boolean, highlight?: boolean}) => void} focusBlip
 *   Moves the roving focus to the card (opening its thread's collapsed replies if needed),
 *   scrolls it into view and optionally flashes it.
 * @property {(rootId: string|null) => void} focusThread  show one thread full width, or return
 * @property {() => Focus} getFocus
 * @property {(parentId: string, anchor?: Anchor) => void} openComposer
 *   Opens a reply composer under the parent (at the end, or after the paragraph `anchor`
 *   names). The blip is created on the first keystroke; an empty composer is removed on close.
 * @property {(blipId: string) => void} openEditor       enters edit mode on a blip (no-op for locked ones)
 * @property {() => void} closeEditor                    "Done": returns any open editor or composer to the read view
 * @property {(seq: number|null, changedIds: string[]) => void} setHistoryMode
 *   seq null: live. Otherwise the conversation shows the Wave as of `seq`: blips with seq >
 *   `seq` are hidden or shown at their replayed text (the shell fetches playback data through
 *   the store and passes changed ids), editing and every write action are disabled, and
 *   `changedIds` are highlighted.
 * @property {(sinceSeq: number) => void} setSinceSeq   the since marker: blips with seq > sinceSeq
 *   are "changed" (dot on the card); N / Shift+N walk them
 * @property {(direction: 1|-1) => string|null} jumpToNextChanged  focuses the next (or previous)
 *   changed blip after the current focus; returns its id or null when there is none
 * @property {(listener: (event: ConversationEvents) => void) => () => void} on
 * @property {() => void} destroy
 */

/**
 * Services the shell hands the conversation. createConversation(store, shell, options) ->
 * ConversationController, exported from src/client/ui/conversation.js.
 * @typedef {object} Shell
 * @property {(message: string) => void} announce   polite live-region announcement; the shell
 *   rate-limits it to one message per two seconds and never per keystroke
 * @property {(kind: "confirm"|"color"|"decision"|"run", args?: any) => Promise<any>} openDialog
 *   Modal dialogs live in the shell (no window.confirm): "confirm" resolves boolean, "color"
 *   resolves the chosen colour or null (there is no name dialog: names come from the account), "decision" resolves the RecordDecisionRequest fields or null, "run"
 *   shows a run card and resolves when closed. Focus returns to the caller's card.
 * @property {(scope: {blipIds: string[], op?: RunOp}) => void} askAgent  opens the Ask agent menu for the scope
 * @property {(threadId: string) => void} recordDecision  opens the decision dialog prefilled from the thread
 * @property {(tab: PanelTab) => void} openPanel
 * @property {() => boolean} isHistoryMode
 */

/**
 * @typedef {object} ConversationOptions
 * @property {boolean} [exportMode]  static render for HTML/PDF export: no editors, no presence,
 *   every thread expanded
 * @property {(id: string) => void} [onBlipLink]  a bliplink was activated; default focusBlip
 */

/**
 * Stable selectors inside the client's DOM, shared by both UI streams and by
 * e2e/harness-helpers.mjs and the platform suite. Keep names in sync with the templates.
 *   .wave-blip[data-bid]      a blip card (article, focusable); data-kind carries the kind and
 *                             data-changed="1" the since-marker state
 *   .blip-body                the rendered read view inside a card
 *   .blip-editor              the textarea in edit mode or a composer
 *   .reply-btn / .edit-btn    card actions; .para-reply-btn is the gutter button per paragraph
 *   .record-decision-btn      on a thread (root card)
 *   .proposal-accept / .proposal-reject / .agent-discard
 *   .me-btn .me-name          the viewer's own (account) name; .color-dialog is the colour picker
 *   namePrompt                anything that would ask for a name; must never match
 *   .conn[data-state]         connecting | live | reconnecting
 *   .saving-chip[data-state]  saved | saving | failed
 *   .panel-tab[data-tab]      decisions | agent | people | history
 *   .history-banner           visible in History mode; .history-scrubber is its range input
 *   .run-card[data-run]       one run in the Agent tab; data-state carries its state
 *   .template-btn[data-template]  one template on first open
 *   .live-region              the polite aria-live element
 */
export const SEL = Object.freeze({
  blip: (/** @type {string} */ id) => `.wave-blip[data-bid="${id}"]`,
  anyBlip: ".wave-blip",
  blipBody: ".blip-body",
  blipEditor: ".blip-editor",
  replyButton: ".reply-btn",
  paraReplyButton: ".para-reply-btn",
  editButton: ".edit-btn",
  doneButton: ".done-btn",
  deleteButton: ".delete-btn",
  recordDecisionButton: ".record-decision-btn",
  proposalAccept: ".proposal-accept",
  proposalReject: ".proposal-reject",
  agentDiscard: ".agent-discard",
  /** anything that would ask the viewer for a name (the removed name dialog); must never match */
  namePrompt: '.name-dialog, .name-input, [data-skip], .join-btn, input[aria-label="Your name"]',
  /** the viewer's own (account) name inside the me button */
  meName: ".me-btn .me-name",
  colorDialog: ".color-dialog",
  conn: ".conn",
  live: '.conn[data-state="live"]',
  savingChip: ".saving-chip",
  saved: '.saving-chip[data-state="saved"]',
  panelTab: (/** @type {string} */ tab) => `.panel-tab[data-tab="${tab}"]`,
  historyToggle: ".history-toggle",
  historyBanner: ".history-banner",
  historyScrubber: ".history-scrubber",
  askAgentButton: ".ask-agent-btn",
  askAgentItem: (/** @type {string} */ op) => `.menu .agent-${op}`,
  runCard: (/** @type {string} */ runId) => `.run-card[data-run="${runId}"]`,
  anyRunCard: ".run-card",
  runCancel: ".run-cancel",
  runRetry: ".run-retry",
  templateButton: (/** @type {string} */ id) => `.template-btn[data-template="${id}"]`,
  exportButton: ".export-btn",
  titleInput: ".wave-title",
  peer: (/** @type {string} */ clientId) => `.people .peer[data-client="${clientId}"]`,
  editingChip: ".editing-chip",
  remoteCaret: ".remote-caret",
  liveRegion: ".live-region",
  toast: ".toast",
  menu: ".menu",
});

/**
 * Keyboard map (conversation focused, no editor open). Documented here so keymap.js, the
 * shell's help and the README agree. Modifier-free keys act only when focus is on a card.
 */
export const KEYS = Object.freeze({
  nextBlip: "j", prevBlip: "k",
  nextChanged: "n", prevChanged: "N",
  reply: "r", edit: "e",
  focusThread: "Enter", back: "Escape",
  delete: "Delete",
  done: "Ctrl+Enter",
});

export {};
