// @ts-check
// The conversation view (stream C1): root blips as cards, replies indented, deeper levels behind
// "N more replies", the brief pinned first; a focused-thread view; paragraph-anchored replies
// placed after their paragraph; live text through the store's text handles; edit mode and the
// reply composer (composer.js); J/K/N/R/E/Enter/Esc/Delete keys (keymap.js); the since marker;
// History mode; live-region announcements through the shell. Implements ConversationController
// from ui-contract.js. It owns its element and every gesture inside it and talks only to the
// Store and the Shell.

import * as Y from "yjs";
import { firstLine, parseMarkdown } from "../../shared/markdown.js";
import { decodeBytes } from "../../shared/protocol.js";
import { createCard, renderCard, updateHead } from "./blip.js";
import { createEditor, encodePosition } from "./composer.js";
import { keyAction, nextChanged, stepFocus, SHORTCUTS_HINT } from "./keymap.js";
import { ancestorsToExpand, button, clear, el, placeParaReplies, rootOf, threadTree } from "./render.js";

/** @typedef {import("../store-contract.js").Store} Store */
/** @typedef {import("../store-contract.js").ClientState} ClientState */
/** @typedef {import("../store-contract.js").Change} Change */
/** @typedef {import("../store-contract.js").TextHandle} TextHandle */
/** @typedef {import("../store-contract.js").Peer} Peer */
/** @typedef {import("../../shared/protocol.js").Blip} Blip */
/** @typedef {import("../../shared/protocol.js").Anchor} Anchor */
/** @typedef {import("../../shared/protocol.js").WaveEvent} WaveEvent */
/** @typedef {import("../../shared/markdown.js").Block} Block */
/** @typedef {import("./ui-contract.js").Shell} Shell */
/** @typedef {import("./ui-contract.js").ConversationController} ConversationController */
/** @typedef {import("./ui-contract.js").ConversationEvents} ConversationEvents */
/**
 * ConversationOptions plus: `playbackText(id)` (the text at the History scrubber position for a
 * blip the shell fetched playback for, else null), `timers` (injectable clock), and
 * `announceEvents` (true: the conversation announces remote changes through shell.announce;
 * default false because the shell's app.js announces them from the same "events" change).
 * @typedef {import("./ui-contract.js").ConversationOptions & {playbackText?: (id: string) => string|null, timers?: any, announceEvents?: boolean}} Options
 */
/** @typedef {import("./blip.js").CardSlots} CardSlots */
/** @typedef {import("./composer.js").Editor} Editor */
/** @typedef {import("./render.js").ThreadNode} ThreadNode */

/**
 * @typedef {object} CardRecord
 * @property {HTMLElement} card
 * @property {CardSlots|null} slots
 * @property {string} sig           body signature of the last render (rebuild when it changes)
 * @property {string} headSig       head signature (head-only update when only this changes)
 * @property {string} text          text rendered last
 * @property {boolean} preview
 * @property {Block[]} blocks
 */

/**
 * @typedef {object} HandleRecord
 * @property {TextHandle|null} handle
 * @property {boolean} closed
 * @property {boolean} failed   openBlip was refused; retried when the blip record changes
 */

const FLASH_MS = 1500;
const TIME_REFRESH_MS = 60_000;

/**
 * @param {Store} store
 * @param {Shell} shell
 * @param {Options} [options]
 * @returns {ConversationController}
 */
export function createConversation(store, shell, options = {}) {
  const exportMode = !!options.exportMode;
  const timers = options.timers ?? {
    setTimeout: (/** @type {any} */ f, /** @type {number} */ ms) => setTimeout(f, ms),
    clearTimeout: (/** @type {any} */ t) => clearTimeout(t),
    setInterval: (/** @type {any} */ f, /** @type {number} */ ms) => setInterval(f, ms),
    clearInterval: (/** @type {any} */ t) => clearInterval(t),
    now: () => Date.now(),
  };
  const onBlipLink = options.onBlipLink ?? ((/** @type {string} */ id) => focusBlip(id, { scroll: true, highlight: true }));

  // --- DOM ---------------------------------------------------------------------------------
  const backBtn = button("\u2190 All threads", () => focusThread(null), { class: "back-btn" });
  const threadBar = el("div", { class: "thread-bar", hidden: true }, backBtn, el("span", { class: "thread-bar-title" }));
  const list = el("div", { class: "thread-list" });
  const empty = el("p", { class: "conversation-empty", hidden: true }, "Nothing here yet. Reply to the brief to start.");
  const hint = el("span", { class: "sr-only", id: "conversation-hint" }, SHORTCUTS_HINT);
  const element = el("section", {
    class: "conversation", "aria-label": "Conversation", "data-view": "all", "data-export": exportMode ? "1" : null,
    "aria-describedby": exportMode ? null : "conversation-hint", tabindex: "-1",
  }, hint, threadBar, empty, list);

  // --- state -------------------------------------------------------------------------------
  /** @type {{blipId: string|null, threadId: string|null}} */
  const focus = { blipId: null, threadId: null };
  const expanded = new Set();
  /** @type {number|null} */
  let sinceSeq = null;
  /** @type {{seq: number, changed: Set<string>}|null} */
  let history = null;
  /** @type {Map<string, CardRecord>} */
  const cards = new Map();
  /** @type {Map<string, HandleRecord>} */
  const handles = new Map();
  /** @type {Map<string, Set<string>>} */
  const editedBy = new Map();
  /** "was attached to removed text" notes, one per orphaned reply, kept across renders. */
  /** @type {Map<string, HTMLElement>} */
  const notes = new Map();
  /** @type {Set<(event: ConversationEvents) => void>} */
  const listeners = new Set();
  /** @type {string[]} */
  let visibleIds = [];
  /** @type {Editor|null} */
  let editor = null;
  /** @type {{parentId: string, blockIndex: number|null, host: HTMLElement}|null} */
  let composer = null;
  /** @type {Set<string>} */
  let dirty = new Set();
  let dirtyAll = true;
  let renderQueued = false;
  let destroyed = false;
  /** @type {any} */
  let flashTimer = null;
  /** @type {HTMLElement|null} */
  let flashed = null;

  // --- events ------------------------------------------------------------------------------
  /** @param {ConversationEvents} event */
  function emit(event) {
    for (const fn of listeners) {
      try { fn(event); } catch (err) { console.error(err); }
    }
  }

  // --- text handles ------------------------------------------------------------------------
  /** @param {string} id */
  function ensureOpen(id) {
    const existing = handles.get(id);
    if (existing && !(existing.failed && dirty.has(id))) return;
    /** @type {HandleRecord} */
    const rec = { handle: null, closed: false, failed: false };
    handles.set(id, rec);
    store.openBlip(id).then((h) => {
      if (rec.closed || destroyed) { h.close(); return; }
      rec.handle = h;
      markDirty([id]);
      // Children anchored to this blip's paragraphs can now be placed.
      for (const b of Object.values(store.getState().blips)) if (b.parentId === id && b.anchor?.type === "para") markDirty([b.id]);
    }).catch(() => {
      if (handles.get(id) === rec) rec.failed = true;
    });
  }

  /** @param {string} id */
  function closeHandle(id) {
    const rec = handles.get(id);
    if (!rec) return;
    rec.closed = true;
    handles.delete(id);
    rec.handle?.close();
  }

  /**
   * The text to render for a blip: playback text in History mode when the shell has it, else the
   * live Y.Text when open, else the preview.
   * @param {Blip} blip
   * @returns {{text: string, preview: boolean}}
   */
  function textOf(blip) {
    if (history && options.playbackText) {
      const t = options.playbackText(blip.id);
      if (typeof t === "string") return { text: t, preview: false };
    }
    const h = handles.get(blip.id)?.handle;
    if (h) return { text: h.text.toString(), preview: false };
    return { text: blip.preview || "", preview: true };
  }

  /**
   * Absolute index of a para anchor in the parent's live text: undefined while the parent's text
   * is not open, null when the position no longer resolves.
   * @param {string} parentId @param {Anchor} anchor
   */
  function resolveAnchor(parentId, anchor) {
    if (anchor.type !== "para") return null;
    const h = handles.get(parentId)?.handle;
    if (!h) return undefined;
    const bytes = decodeBytes(anchor.pos, 512);
    if (!bytes) return null;
    try {
      const abs = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(bytes), h.doc);
      if (!abs || abs.type !== h.text) return null;
      return abs.index;
    } catch {
      return null;
    }
  }

  // --- rendering ---------------------------------------------------------------------------
  /** @param {string[]} ids */
  function markDirty(ids) {
    for (const id of ids) dirty.add(id);
    scheduleRender();
  }
  function markAll() {
    dirtyAll = true;
    scheduleRender();
  }
  function scheduleRender() {
    if (renderQueued || destroyed) return;
    renderQueued = true;
    queueMicrotask(() => { renderQueued = false; if (!destroyed) render(); });
  }

  /** @param {Blip} b */
  function visibleInHistory(b) {
    if (!history) return true;
    const created = /** @type {any} */ (b).createdSeq;
    if (typeof created === "number" && created > history.seq) return false;
    if (b.seq > history.seq) {
      const t = options.playbackText ? options.playbackText(b.id) : null;
      return typeof t === "string";
    }
    return true;
  }

  /** Decision numbers by id, in recording order. */
  function decisionNumbers() {
    const state = store.getState();
    const decisions = Object.values(state.blips).filter((b) => b.kind === "decision" && !b.deleted)
      .sort((a, b) => (a.decision?.recordedAt ?? a.createdAt) - (b.decision?.recordedAt ?? b.createdAt) || (a.id < b.id ? -1 : 1));
    const map = new Map();
    decisions.forEach((d, i) => map.set(d.id, i + 1));
    return map;
  }

  function render() {
    const state = store.getState();
    const blips = state.blips;
    const now = timers.now ? timers.now() : Date.now();
    const active = /** @type {HTMLElement|null} */ (document.activeElement);
    const activeInside = !!active && element.contains(active);
    const activeCardId = activeInside ? active?.closest(".wave-blip")?.getAttribute("data-bid") ?? null : null;
    const activeWasTextarea = !!editor && active === editor.textarea;

    const tree = threadTree(blips, state.meta.rootOrder, {
      expanded, expandAll: exportMode || focus.threadId !== null, visible: visibleInHistory,
    });
    const shown = focus.threadId ? tree.filter((n) => n.id === focus.threadId) : tree;
    if (focus.threadId && shown.length === 0) {
      // The thread went away (deleted or hidden in History mode): fall back to the full view.
      focus.threadId = null;
      element.setAttribute("data-view", "all");
      emit({ kind: "thread", threadId: null });
      render();
      return;
    }
    const decisionNo = decisionNumbers();
    const peersByBlip = new Map();
    if (!exportMode) {
      for (const p of state.peers.values()) {
        if (!p.editing || !p.blipId) continue;
        let arr = peersByBlip.get(p.blipId);
        if (!arr) peersByBlip.set(p.blipId, arr = []);
        arr.push(p);
      }
    }
    const editingId = editor?.id() ?? null;
    const seen = new Set();

    /** @param {ThreadNode} node @returns {HTMLElement} */
    const renderNode = (node) => {
      const blip = blips[node.id];
      seen.add(node.id);
      ensureOpen(node.id);
      let rec = cards.get(node.id);
      const fresh = !rec;
      if (!rec) {
        rec = { card: createCard(node.id, blip.kind), slots: null, sig: "", headSig: "", text: "", preview: true, blocks: [] };
        cards.set(node.id, rec);
      }
      const isEditing = editingId === node.id && !!editor;
      if (!isEditing && (fresh || dirtyAll || dirty.has(node.id))) {
        const t = textOf(blip);
        if (t.text !== rec.text || t.preview !== rec.preview || fresh) {
          rec.text = t.text;
          rec.preview = t.preview;
          rec.blocks = parseMarkdown(t.text);
          rec.sig = ""; // force a rebuild
        }
      }
      const peers = /** @type {Peer[]} */ (peersByBlip.get(node.id) ?? []);
      const textState = state.text[node.id];
      const target = blip.kind === "proposal" && blip.proposal ? blips[blip.proposal.targetId] : undefined;
      const run = blip.runId ? state.runs[blip.runId] : undefined;
      const edited = [...(editedBy.get(node.id) ?? [])];
      const changed = sinceSeq !== null && blip.seq > sinceSeq;
      const historyChanged = !!history && history.changed.has(node.id);
      // What the body and actions depend on: a change rebuilds the card.
      const sig = [
        blip.kind, blip.version, blip.locked ? 1 : 0, blip.by, blip.createdAt, blip.parentId ?? "",
        blip.proposal?.state ?? "", blip.proposal?.reviewedBy ?? "", target?.seq ?? "",
        blip.decision?.supersededBy ?? "", blip.decision?.supersedes ?? "", decisionNo.get(node.id) ?? 0,
        run?.op ?? "", isEditing ? 1 : 0, rec.preview ? 1 : 0, node.hidden, node.depth,
        state.capabilities?.model ? 1 : 0, history ? "h" + history.seq : "", exportMode ? 1 : 0, rec.blocks.length,
      ].join("|");
      // What only the head depends on: a change replaces the head in place (no focus churn).
      const headSig = [
        changed ? 1 : 0, historyChanged ? 1 : 0, peers.map((p) => p.name).join("\u0001"),
        textState ? textState.saving + ":" + (textState.lastError ?? "") : "", edited.join("\u0001"),
        Math.floor(now / 60_000),
      ].join("|");
      if (sig !== rec.sig || headSig !== rec.headSig || !rec.slots) {
        const ctx = {
          state, blip, text: rec.text, blocks: rec.blocks, preview: rec.preview, now, depth: node.depth,
          editing: isEditing, editor: isEditing && editor ? editor.element : null,
          exportMode, historyMode: history !== null, historyChanged, changed,
          peersEditing: peers.map((p) => p.name), textState, editedBy: edited, hidden: node.hidden,
          decisionNumber: decisionNo.get(node.id) ?? 0, decisionNumberOf: (/** @type {string} */ id) => decisionNo.get(id) ?? 0,
          actions, onBlipLink,
        };
        if (sig !== rec.sig || !rec.slots) rec.slots = renderCard(rec.card, ctx);
        else updateHead(rec.card, ctx);
        rec.sig = sig;
        rec.headSig = headSig;
      }
      const slots = /** @type {CardSlots} */ (rec.slots);
      // Children: para-anchored ones after their paragraph, the rest at the end.
      const paraKids = node.children.filter((c) => blips[c.id].anchor?.type === "para");
      const endKids = node.children.filter((c) => blips[c.id].anchor?.type !== "para");
      const topBlocks = isEditing ? [] : rec.blocks;
      const placement = placeParaReplies(topBlocks, paraKids.map((c) => ({ id: c.id, index: resolveAnchor(node.id, /** @type {Anchor} */ (blips[c.id].anchor)) })));
      const byId = new Map(node.children.map((c) => [c.id, c]));
      placement.byBlock.forEach((ids, i) => {
        const slot = slots.paraSlots[i];
        if (slot) setChildren(slot, ids.map((id) => renderNode(/** @type {ThreadNode} */ (byId.get(id)))));
      });
      /** @type {HTMLElement[]} */
      const tail = [];
      for (const id of placement.pending) tail.push(renderNode(/** @type {ThreadNode} */ (byId.get(id))));
      for (const id of placement.trailing) tail.push(renderNode(/** @type {ThreadNode} */ (byId.get(id))));
      for (const id of placement.orphaned) {
        let note = notes.get(id);
        if (!note) notes.set(id, note = el("p", { class: "anchor-note" }, "was attached to removed text"));
        tail.push(note);
        tail.push(renderNode(/** @type {ThreadNode} */ (byId.get(id))));
      }
      setChildren(slots.tail, tail);
      setChildren(slots.replies, endKids.map((c) => renderNode(c)));
      // The composer, until its blip exists.
      if (composer && composer.parentId === node.id && editor && editor.id() === null) {
        const slot = composer.blockIndex !== null && slots.paraSlots[composer.blockIndex] ? slots.paraSlots[composer.blockIndex] : slots.replies;
        if (composer.host.parentNode !== slot) slot.appendChild(composer.host);
      }
      return rec.card;
    };

    const roots = shown.map(renderNode);
    setChildren(list, roots);

    // Drop cards and handles that are no longer shown (never the one being edited).
    for (const [id, rec] of cards) {
      if (seen.has(id)) continue;
      if (id === editingId) continue;
      rec.card.remove();
      cards.delete(id);
    }
    for (const id of [...handles.keys()]) if (!seen.has(id) && id !== editingId) closeHandle(id);
    // A composer whose blip now exists lives inside its card; its host is empty and goes.
    if (composer && editor && editor.id() !== null) {
      composer.host.remove();
      composer = null;
    }
    dirty = new Set();
    dirtyAll = false;

    empty.hidden = roots.length > 0;
    threadBar.hidden = focus.threadId === null;
    if (focus.threadId) {
      const rootBlip = blips[focus.threadId];
      const title = threadBar.querySelector(".thread-bar-title");
      if (title) title.textContent = rootBlip ? (firstLine(rootBlip.preview, 60) || "Thread") : "";
    }

    // Roving tabindex.
    visibleIds = [...list.querySelectorAll(".wave-blip")].map((c) => /** @type {string} */ (c.getAttribute("data-bid")));
    if (focus.blipId !== null && !visibleIds.includes(focus.blipId)) focus.blipId = null;
    const tabId = focus.blipId ?? visibleIds[0] ?? null;
    for (const [id, rec] of cards) rec.card.setAttribute("tabindex", id === tabId ? "0" : "-1");

    // Focus restoration after DOM moves.
    if (activeInside && document.activeElement !== active) {
      if (activeWasTextarea && editor && editor.isOpen()) editor.restoreFocus();
      else if (activeCardId && cards.get(activeCardId)) cards.get(activeCardId)?.card.focus({ preventScroll: true });
      else if (editor && editor.isOpen() && (activeWasTextarea || active?.closest(".editor"))) editor.restoreFocus();
    }
  }

  /**
   * Makes `nodes` the children of `parent` (moving existing elements), skipping a no-op. A
   * composer host already sitting last in the slot stays where it is.
   * @param {HTMLElement} parent @param {HTMLElement[]} nodes
   */
  function setChildren(parent, nodes) {
    const current = [...parent.childNodes];
    const host = composer && current[current.length - 1] === composer.host ? composer.host : null;
    const kept = host ? current.slice(0, -1) : current;
    if (kept.length === nodes.length && nodes.every((n, i) => kept[i] === n)) return;
    clear(parent);
    for (const n of nodes) parent.appendChild(n);
    if (host) parent.appendChild(host);
  }

  // --- focus -------------------------------------------------------------------------------
  /** @param {string|null} id */
  function setFocusId(id) {
    if (focus.blipId === id) return;
    focus.blipId = id;
    for (const [cid, rec] of cards) rec.card.setAttribute("tabindex", cid === id ? "0" : "-1");
    emit({ kind: "focus", blipId: id });
    if (!exportMode && !editor && id) store.setPresence({ blipId: id, editing: false, anchor: null, head: null });
  }

  /** @type {ConversationController["focusBlip"]} */
  function focusBlip(id, { scroll = true, highlight = false } = {}) {
    const blip = store.getState().blips[id];
    if (!blip || blip.deleted || !visibleInHistory(blip)) { shell.announce("That blip is not available."); return; }
    const root = rootOf(store.getState().blips, id);
    if (focus.threadId && root && root !== focus.threadId) focusThread(root);
    for (const a of ancestorsToExpand(store.getState().blips, id)) expanded.add(a);
    render();
    const rec = cards.get(id);
    if (!rec) return;
    setFocusId(id);
    rec.card.focus({ preventScroll: !scroll });
    if (scroll) rec.card.scrollIntoView({ block: "center", behavior: "smooth" });
    if (highlight) flash(rec.card);
  }

  /** @param {HTMLElement} card */
  function flash(card) {
    if (flashed) flashed.classList.remove("flash");
    if (flashTimer) timers.clearTimeout(flashTimer);
    flashed = card;
    card.classList.add("flash");
    flashTimer = timers.setTimeout(() => { card.classList.remove("flash"); flashed = null; flashTimer = null; }, FLASH_MS);
  }

  /** @type {ConversationController["focusThread"]} */
  function focusThread(rootId) {
    const blips = store.getState().blips;
    const root = rootId ? rootOf(blips, rootId) : null;
    if (root === focus.threadId) return;
    const previous = focus.threadId;
    focus.threadId = root;
    element.setAttribute("data-view", root ? "thread" : "all");
    render();
    emit({ kind: "thread", threadId: root });
    if (root) {
      const keep = focus.blipId && cards.get(focus.blipId) ? focus.blipId : root;
      focusBlip(keep, { scroll: false });
      element.scrollTop = 0;
    } else if (previous && cards.get(previous)) {
      focusBlip(previous, { scroll: true });
    }
  }

  // --- editors -----------------------------------------------------------------------------
  /** @type {ConversationController["openEditor"]} */
  function openEditor(id) {
    if (exportMode || history) return;
    const blip = store.getState().blips[id];
    if (!blip || blip.deleted || blip.locked || blip.kind === "proposal" || blip.kind === "agent") return;
    if (editor && editor.id() === id) { editor.focus(); return; }
    closeEditor();
    const rec = cards.get(id);
    editor = createEditor({
      store, blipId: id, initialText: rec?.text ?? blip.preview, timers,
      label: blip.kind === "brief" ? "Edit the brief" : "Edit text",
      onClose: () => { editor = null; markDirty([id]); render(); emit({ kind: "editing", blipId: id, editing: false }); focusAfterClose(id); },
      onError: (m) => shell.announce(m),
    });
    editor.updateCarets(peersOn(id));
    setFocusId(id);
    markDirty([id]);
    render();
    editor.focus();
    emit({ kind: "editing", blipId: id, editing: true });
  }

  /** @param {string} id */
  function focusAfterClose(id) {
    const rec = cards.get(id);
    if (rec) { setFocusId(id); rec.card.focus({ preventScroll: true }); }
    else if (composer?.parentId && cards.get(composer.parentId)) cards.get(composer.parentId)?.card.focus({ preventScroll: true });
    else element.focus({ preventScroll: true });
  }

  /** @type {ConversationController["openComposer"]} */
  function openComposer(parentId, anchor = { type: "end" }, blockIndex = /** @type {number|null} */ (null)) {
    if (exportMode || history) return;
    const parent = store.getState().blips[parentId];
    if (!parent || parent.deleted) return;
    closeEditor();
    if (blockIndex === null && anchor.type === "para") {
      const index = resolveAnchor(parentId, anchor);
      if (typeof index === "number") {
        const rec = cards.get(parentId);
        const p = placeParaReplies(rec?.blocks ?? [], [{ id: "x", index }]);
        blockIndex = p.byBlock.findIndex((ids) => ids.length > 0);
        if (blockIndex < 0) blockIndex = null;
      }
    }
    const host = el("div", { class: "composer", "data-parent": parentId });
    const ed = createEditor({
      store, blipId: null, parentId, anchor, timers, placeholder: "Reply…", label: "Reply",
      onCreated: () => { markAll(); },
      onClose: ({ id, deleted }) => {
        editor = null;
        host.remove();
        composer = null;
        if (id) markDirty([id]);
        markAll();
        render();
        emit({ kind: "editing", blipId: id, editing: false });
        focusAfterClose(id && !deleted ? id : parentId);
      },
      onError: (m) => shell.announce(m),
    });
    host.appendChild(ed.element);
    editor = ed;
    composer = { parentId, blockIndex, host };
    if (!cards.get(parentId)) { for (const a of ancestorsToExpand(store.getState().blips, parentId)) expanded.add(a); expanded.add(parentId); }
    expanded.add(parentId);
    render();
    ed.focus();
    emit({ kind: "editing", blipId: null, editing: true });
  }

  /** @type {ConversationController["closeEditor"]} */
  function closeEditor() {
    if (!editor) return;
    editor.close();
  }

  /** @param {string} id */
  function peersOn(id) {
    return [...store.getState().peers.values()].filter((p) => p.editing && p.blipId === id);
  }

  /**
   * Reply after paragraph `blockIndex` of `id`: needs the parent's Y.Text for the relative position.
   * @param {string} id @param {number} blockIndex
   */
  function replyToParagraph(id, blockIndex) {
    if (exportMode || history) return;
    const rec = cards.get(id);
    const blocks = rec?.blocks ?? parseMarkdown(store.getState().blips[id]?.preview ?? "");
    const block = blocks[blockIndex];
    if (!block) { openComposer(id); return; }
    const open = handles.get(id)?.handle;
    if (open) {
      openComposer(id, { type: "para", pos: encodePosition(open.text, block.start) }, blockIndex);
      return;
    }
    store.openBlip(id).then((h) => {
      try {
        const liveBlocks = parseMarkdown(h.text.toString());
        const b = liveBlocks[blockIndex] ?? block;
        openComposer(id, { type: "para", pos: encodePosition(h.text, b.start) }, blockIndex);
      } finally {
        h.close();
      }
    }).catch(() => openComposer(id));
  }

  // --- card actions ------------------------------------------------------------------------
  /** @param {string} id */
  async function confirmRemove(id) {
    if (history || exportMode) return;
    const blip = store.getState().blips[id];
    if (!blip || blip.locked) return;
    const agent = blip.kind === "agent";
    const ok = await shell.openDialog("confirm", {
      title: agent ? "Discard this agent output?" : blip.kind === "brief" ? "Delete the brief?" : "Delete this reply?",
      message: "It is hidden, not destroyed; History keeps it.",
      confirm: agent ? "Discard" : "Delete",
    });
    if (!ok || destroyed) { cards.get(id)?.card.focus({ preventScroll: true }); return; }
    const next = stepFocus(visibleIds, id, 1) ?? stepFocus(visibleIds, id, -1);
    if (editor && editor.id() === id) closeEditor();
    store.deleteBlip(id);
    render();
    if (next && next !== id && cards.get(next)) focusBlip(next, { scroll: false });
    else element.focus({ preventScroll: true });
  }

  /** @param {string} id @param {"accept"|"reject"} decision */
  async function review(id, decision) {
    if (history || exportMode) return;
    try {
      const res = await store.reviewProposal(id, decision);
      if ("error" in res) { shell.announce(res.message || res.error); return; }
      if (res.status === "conflict") shell.announce(res.blip.proposal?.state === "accepted" ? "Already applied by someone else." : "Someone else reviewed this proposal first.");
      else if (res.status === "stale") shell.announce("The target changed since this proposal was made; it is based on an older version.");
      else if (res.status === "applied") shell.announce("Proposal applied.");
      else if (res.status === "rejected") shell.announce("Proposal rejected.");
    } catch (err) {
      shell.announce(err instanceof Error ? err.message : String(err));
    } finally {
      cards.get(id)?.card.focus({ preventScroll: true });
    }
  }

  /** Every non-deleted blip in the thread of `id`, root first (depth first). @param {string} id */
  function threadIds(id) {
    const blips = store.getState().blips;
    const root = rootOf(blips, id);
    if (!root) return [id];
    const out = [root];
    const kids = new Map();
    for (const b of Object.values(blips)) {
      if (b.deleted || b.parentId === null) continue;
      if (!kids.has(b.parentId)) kids.set(b.parentId, []);
      kids.get(b.parentId).push(b.id);
    }
    const seen = new Set([root]);
    const walk = (/** @type {string} */ p) => { for (const c of kids.get(p) ?? []) { if (seen.has(c)) continue; seen.add(c); out.push(c); walk(c); } };
    walk(root);
    return out;
  }

  /** @type {import("./blip.js").CardActions} */
  const actions = {
    reply: (id) => openComposer(id, { type: "end" }),
    replyPara: (id, i) => replyToParagraph(id, i),
    edit: (id) => openEditor(id),
    done: () => closeEditor(),
    remove: (id) => { void confirmRemove(id); },
    accept: (id) => { void review(id, "accept"); },
    reject: (id) => { void review(id, "reject"); },
    regenerate: (id) => {
      const state = store.getState();
      const blip = state.blips[id];
      const run = blip?.runId ? state.runs[blip.runId] : undefined;
      const targetId = blip?.proposal?.targetId ?? id;
      const scope = { blipIds: [targetId], op: run?.op ?? "refresh_brief" };
      emit({ kind: "request-agent", blipIds: scope.blipIds });
      shell.askAgent(scope);
    },
    showRun: (runId) => {
      emit({ kind: "request-run", runId });
      void shell.openDialog("run", { runId }).then(() => { if (focus.blipId) cards.get(focus.blipId)?.card.focus({ preventScroll: true }); });
    },
    recordDecision: (id) => {
      const root = rootOf(store.getState().blips, id) ?? id;
      emit({ kind: "request-decision", threadId: root });
      shell.recordDecision(root);
    },
    focusThread: (id) => focusThread(id),
    askAgent: (id) => {
      const blipIds = threadIds(id);
      emit({ kind: "request-agent", blipIds });
      shell.askAgent({ blipIds });
    },
    refreshBrief: (id) => {
      emit({ kind: "request-agent", blipIds: [id] });
      shell.askAgent({ blipIds: [id], op: "refresh_brief" });
    },
    expand: (id) => {
      expanded.add(id);
      markDirty([id]);
      render();
      const first = cards.get(id)?.card.querySelector(".wave-blip");
      const firstId = first?.getAttribute("data-bid");
      if (firstId) focusBlip(firstId, { scroll: false });
    },
    goTo: (id) => onBlipLink(id),
    replyInstead: (id) => openComposer(id, { type: "end" }),
  };

  // --- keyboard ----------------------------------------------------------------------------
  /** @param {HTMLElement} card */
  const ownButtons = (card) => /** @type {HTMLElement[]} */ ([...card.querySelectorAll("button")])
    .filter((b) => b.closest(".wave-blip") === card && !b.closest(".editor") && !(/** @type {HTMLButtonElement} */ (b).disabled)
      && !b.closest("[hidden]") && b.getClientRects().length > 0);

  element.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (!mod || e.altKey || (key !== "z" && key !== "y")) return;
    const t = /** @type {HTMLElement} */ (e.target);
    if (editor && t === editor.textarea) return; // the binding routes these to its Y.UndoManager
    if (!t.closest("textarea, input, [contenteditable]")) e.preventDefault(); // keep native undo off the page
  }, true);

  element.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;
    const t = /** @type {HTMLElement} */ (e.target);
    const inEditor = !!t.closest("textarea, input, select, [contenteditable]");
    const card = /** @type {HTMLElement|null} */ (t.closest(".wave-blip"));
    const onCard = !!card && t === card;
    const state = store.getState();

    // Buttons inside a card: Left/Right cycle them, Up/Down/Escape return to the card.
    if (!inEditor && card && !onCard && t instanceof HTMLButtonElement && !t.closest(".menu")) {
      const buttons = ownButtons(card);
      const i = buttons.indexOf(t);
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const n = buttons.length;
        if (n) buttons[(i + (e.key === "ArrowRight" ? 1 : -1) + n) % n].focus();
        return;
      }
      if (e.key === "Escape" || e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        card.focus({ preventScroll: true });
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) return; // let the button's own keys be
    }
    if (onCard && e.key === "ArrowRight") {
      const buttons = ownButtons(card);
      if (buttons.length) { e.preventDefault(); buttons[0].focus(); }
      return;
    }
    const focused = focus.blipId;
    const focusedBlip = focused ? state.blips[focused] : undefined;
    const action = keyAction(e, {
      onCard, inEditor, historyMode: history !== null, threadOpen: focus.threadId !== null,
      locked: !!focusedBlip?.locked, composing: e.isComposing,
    });
    if (!action) return;
    if (inEditor && (action === "done" || action === "undo" || action === "redo")) return; // the editor handles its own keys
    if (action === "back" && !editor && !focus.threadId) return; // nothing to go back from: leave Esc to the shell
    e.preventDefault();
    switch (action) {
      case "next": case "prev": case "first": case "last": {
        const step = action === "next" ? 1 : action === "prev" ? -1 : action === "first" ? -visibleIds.length : visibleIds.length;
        const id = stepFocus(visibleIds, focus.blipId, step);
        if (id) focusBlip(id, { scroll: true });
        break;
      }
      case "nextChanged": jumpToNextChanged(1); break;
      case "prevChanged": jumpToNextChanged(-1); break;
      case "reply": if (focused) openComposer(focused, { type: "end" }); break;
      case "edit": if (focused) openEditor(focused); break;
      case "focusThread": if (focused) focusThread(focused); break;
      case "back":
        if (editor) closeEditor();
        else if (focus.threadId) focusThread(null);
        break;
      case "delete": if (focused) void confirmRemove(focused); break;
      case "menu": if (focused) cards.get(focused)?.card.dispatchEvent(new Event("blip-menu-open")); break;
    }
  });

  element.addEventListener("focusin", (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const card = t.closest(".wave-blip");
    const id = card?.getAttribute("data-bid") ?? null;
    if (id && id !== focus.blipId) setFocusId(id);
  });
  element.addEventListener("click", (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const card = /** @type {HTMLElement|null} */ (t.closest(".wave-blip"));
    if (!card || t.closest("button, a, textarea, input, select")) return;
    if (card.contains(document.activeElement) && document.activeElement !== element) return;
    card.focus({ preventScroll: true });
  });

  // --- since marker and History ------------------------------------------------------------
  /** @type {ConversationController["setSinceSeq"]} */
  function setSinceSeq(seq) {
    sinceSeq = Number.isFinite(seq) ? seq : null;
    markAll();
  }

  function changedSet() {
    const blips = store.getState().blips;
    return { has: (/** @type {string} */ id) => sinceSeq !== null && !!blips[id] && blips[id].seq > sinceSeq };
  }

  /** @type {ConversationController["jumpToNextChanged"]} */
  function jumpToNextChanged(direction) {
    const id = nextChanged(visibleIds, focus.blipId, direction, changedSet());
    if (id) focusBlip(id, { scroll: true, highlight: true });
    else shell.announce(direction === 1 ? "No more changed blips." : "No earlier changed blips.");
    return id;
  }

  /** @type {ConversationController["setHistoryMode"]} */
  function setHistoryMode(seq, changedIds) {
    if (seq === null) {
      if (history === null) return;
      history = null;
    } else {
      if (history === null) closeEditor();
      history = { seq, changed: new Set(changedIds ?? []) };
    }
    element.setAttribute("data-history", history ? "1" : "0");
    markAll();
    render();
  }

  // --- announcements -----------------------------------------------------------------------
  /** @param {WaveEvent[]} events @param {ClientState} state */
  function announceEvents(events, state) {
    const me = state.viewer?.name ?? "";
    for (const ev of events) {
      const blip = ev.blipId ? state.blips[ev.blipId] : undefined;
      if (ev.kind === "text" && blip && ev.by && ev.by !== blip.by) {
        let set = editedBy.get(blip.id);
        if (!set) editedBy.set(blip.id, set = new Set());
        if (!set.has(ev.by)) { set.add(ev.by); markDirty([blip.id]); }
      }
      if (exportMode || !options.announceEvents) continue;
      if (ev.by && ev.by === me) continue;
      const who = ev.by === "agent" || !ev.by ? "the agent" : ev.by;
      const place = blip ? placeOf(blip, state) : "";
      /** @type {string|null} */
      let message = null;
      switch (ev.kind) {
        case "text": message = blip ? `${who} edited ${blip.kind === "brief" ? "the brief" : place}` : null; break;
        case "blip.create":
          if (!blip) break;
          if (blip.kind === "agent") message = `New agent output in ${place}`;
          else if (blip.kind === "proposal") message = `New proposal in ${place}`;
          else if (blip.parentId === null) message = `New post from ${who}: ${firstLine(blip.preview, 60) || "(empty)"}`;
          else message = `New reply from ${who} in ${place}`;
          break;
        case "blip.delete": message = blip ? `${who} removed ${blip.kind === "agent" ? "agent output" : "a reply"} in ${place}` : null; break;
        case "blip.restore": message = blip ? `${who} restored a reply in ${place}` : null; break;
        case "proposal.accept": message = `${who} accepted a proposal${place ? " in " + place : ""}`; break;
        case "proposal.reject": message = `${who} rejected a proposal${place ? " in " + place : ""}`; break;
        case "decision.record": message = `${who} recorded a decision${place ? " in " + place : ""}`; break;
        case "structure": message = ev.detail ? `${who} renamed the wave to ${ev.detail}` : null; break;
        default: break;
      }
      if (message) shell.announce(message);
    }
  }

  /** "the brief" / "<thread first line>" @param {Blip} blip @param {ClientState} state */
  function placeOf(blip, state) {
    const root = rootOf(state.blips, blip.id);
    const rootBlip = root ? state.blips[root] : undefined;
    if (!rootBlip) return "the wave";
    if (rootBlip.kind === "brief") return "the brief";
    return firstLine(rootBlip.preview, 40) || "a thread";
  }

  // --- store subscription ------------------------------------------------------------------
  const unsubscribe = store.subscribe((state, change) => {
    if (destroyed) return;
    switch (change.kind) {
      case "snapshot": case "meta": markAll(); break;
      case "blips": markDirty(change.blips ?? []); markAll(); break;
      case "text":
        markDirty(change.blips ?? []);
        for (const id of change.blips ?? []) {
          if (editor && editor.id() === id) editor.updateCarets(peersOn(id));
          for (const b of Object.values(state.blips)) if (b.parentId === id && b.anchor?.type === "para") dirty.add(b.id);
        }
        break;
      case "presence":
        if (editor) { const id = editor.id(); if (id) editor.updateCarets(peersOn(id)); }
        markAll();
        break;
      case "saving": markDirty(change.blips ?? []); break;
      case "runs": markAll(); break;
      case "events": announceEvents(change.events ?? [], state); break;
      default: break;
    }
  });

  const timeTimer = exportMode ? null : timers.setInterval(() => { if (!destroyed) markAll(); }, TIME_REFRESH_MS);

  render();

  /** @type {ConversationController} */
  const controller = {
    element,
    focusBlip,
    focusThread,
    getFocus: () => ({ ...focus }),
    openComposer: (parentId, anchor) => openComposer(parentId, anchor),
    openEditor,
    closeEditor,
    setHistoryMode,
    setSinceSeq,
    jumpToNextChanged,
    on: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    destroy() {
      if (destroyed) return;
      closeEditor();
      destroyed = true;
      unsubscribe();
      if (timeTimer !== null) timers.clearInterval(timeTimer);
      if (flashTimer) timers.clearTimeout(flashTimer);
      for (const id of [...handles.keys()]) closeHandle(id);
      cards.clear();
      listeners.clear();
      element.remove();
    },
  };
  return controller;
}
