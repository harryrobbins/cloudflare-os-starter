// @ts-check
// One blip as a card (stream C1). `renderCard` fills an `article.wave-blip` for its kind (note,
// brief, agent, proposal, decision): head, read view (or the editor the conversation hands in),
// chips, action bar, and the slots the conversation drops child cards into (after each paragraph
// for para-anchored replies, at the end for the rest). Buttons call back into `ctx.actions`;
// nothing here talks to the store.
//
// CSS classes used (the shell's stylesheet styles them): see the report in the stream's handover
// and the class names below. Selectors from ui-contract.js SEL are used verbatim.

import { citedBlipIds, firstLine, parseMarkdown } from "../../shared/markdown.js";
import { RUN_OP_LABELS } from "../../shared/protocol.js";
import { button, clear, el, relativeTime, renderBlocks, shortId, svgIcon, editingLabel } from "./render.js";

/** @typedef {import("../../shared/protocol.js").Blip} Blip */
/** @typedef {import("../../shared/markdown.js").Block} Block */
/** @typedef {import("../store-contract.js").ClientState} ClientState */
/** @typedef {import("../store-contract.js").TextState} TextState */

/**
 * @typedef {object} CardActions
 * @property {(id: string) => void} reply
 * @property {(id: string, blockIndex: number) => void} replyPara
 * @property {(id: string) => void} edit
 * @property {(id: string) => void} done
 * @property {(id: string) => void} remove          Delete / Discard (asks first)
 * @property {(id: string) => void} accept
 * @property {(id: string) => void} reject
 * @property {(id: string) => void} regenerate
 * @property {(runId: string) => void} showRun
 * @property {(id: string) => void} recordDecision  id: any blip in the thread
 * @property {(id: string) => void} focusThread     id: any blip in the thread
 * @property {(id: string) => void} askAgent        the thread of id
 * @property {(id: string) => void} refreshBrief
 * @property {(id: string) => void} expand          show collapsed replies under id
 * @property {(id: string) => void} goTo            focus a blip (bliplinks, supersedes, sources)
 * @property {(id: string) => void} replyInstead    "Reply instead" after blip_full
 */

/**
 * @typedef {object} CardContext
 * @property {ClientState} state
 * @property {Blip} blip
 * @property {string} text               the text to render (live, preview or playback)
 * @property {Block[]} blocks            parseMarkdown(text)
 * @property {boolean} preview           text is only the preview (the live text is not open yet)
 * @property {number} now
 * @property {number} depth
 * @property {boolean} editing           this card is in edit mode: `editor` replaces the read view
 * @property {HTMLElement|null} editor   the editor wrapper (textarea + caret host + Done)
 * @property {boolean} exportMode
 * @property {boolean} historyMode       no write actions
 * @property {boolean} historyChanged    highlighted in History mode
 * @property {boolean} changed           since marker: blip.seq > sinceSeq
 * @property {string[]} peersEditing     names of peers editing this blip
 * @property {TextState|undefined} textState
 * @property {string[]} editedBy         names other than the author seen editing it (live)
 * @property {number} hidden             collapsed descendants ("N more replies")
 * @property {number} decisionNumber     "Decision N" (decision cards)
 * @property {(id: string) => number} decisionNumberOf
 * @property {CardActions} actions
 * @property {(id: string) => void} onBlipLink
 */

/**
 * @typedef {object} CardSlots
 * @property {HTMLElement} body            the `.blip-body` (or the editor wrapper's parent)
 * @property {HTMLElement[]} paraSlots     one per top-level block: append para-anchored child cards
 * @property {HTMLElement} tail            replies that could not be placed (removed text, pending)
 * @property {HTMLElement} replies         end-anchored replies
 * @property {HTMLElement} more            the "N more replies" row (empty when nothing hides)
 */

/** @param {Blip} blip */
export function kindLabel(blip) {
  switch (blip.kind) {
    case "brief": return "Brief";
    case "agent": return "Agent output";
    case "proposal": return "Proposal";
    case "decision": return "Decision";
    default: return blip.parentId === null ? "Post" : "Reply";
  }
}

/**
 * The card's accessible name: "Reply by Alice, 3 minutes ago".
 * @param {Blip} blip @param {number} now @param {number} [decisionNumber]
 */
export function cardLabel(blip, now, decisionNumber = 0) {
  const kind = blip.kind === "decision" && decisionNumber ? `Decision ${decisionNumber}` : kindLabel(blip);
  const by = blip.kind === "agent" || blip.kind === "proposal" ? "the agent" : (blip.by || "Guest");
  return `${kind} by ${by}, ${relativeTime(blip.createdAt, now)}`;
}

/**
 * A blank card element. The conversation keeps it across renders; renderCard fills it.
 * @param {string} id
 * @param {string} kind
 */
export function createCard(id, kind) {
  return el("article", { class: "wave-blip", "data-bid": id, "data-kind": kind, tabindex: "-1" });
}

/**
 * Attributes and classes of the card that the head-only update also refreshes.
 * @param {HTMLElement} card @param {CardContext} ctx
 */
function applyFlags(card, ctx) {
  const { blip } = ctx;
  card.setAttribute("data-kind", blip.kind);
  card.setAttribute("data-depth", String(Math.min(ctx.depth, 6)));
  card.setAttribute("aria-label", cardLabel(blip, ctx.now, ctx.decisionNumber));
  card.classList.toggle("is-editing", ctx.editing);
  card.classList.toggle("is-locked", !!blip.locked);
  card.classList.toggle("is-preview", ctx.preview && !ctx.editing);
  setFlag(card, "data-changed", ctx.changed);
  setFlag(card, "data-history-changed", ctx.historyChanged);
  setFlag(card, "data-locked", !!blip.locked);
}

/**
 * The card's header: kind badge, author, time, "edited by", proposal chips, editing chip, saving chip.
 * @param {CardContext} ctx
 */
function buildHead(ctx) {
  const { blip } = ctx;
  const head = el("header", { class: "blip-head" });
  if (ctx.changed) head.appendChild(el("span", { class: "changed-dot", title: "Changed since you last looked" }, el("span", { class: "sr-only" }, "Changed. ")));
  if (blip.kind === "brief") head.appendChild(el("span", { class: "blip-kind kind-brief" }, "Brief"));
  else if (blip.kind === "agent") head.appendChild(el("span", { class: "blip-kind kind-agent" }, svgIcon("robot"), " ", agentOpLabel(ctx)));
  else if (blip.kind === "proposal") head.appendChild(el("span", { class: "blip-kind kind-proposal" }, svgIcon("robot"), " Proposal for ", targetLabel(ctx)));
  else if (blip.kind === "decision") head.appendChild(el("span", { class: "blip-kind kind-decision" }, svgIcon("lock"), ` Decision ${ctx.decisionNumber || ""}`.trimEnd()));
  if (blip.kind === "decision" && blip.decision) {
    head.appendChild(el("span", { class: "blip-author" }, "recorded by ", blip.decision.recordedBy || blip.by || "Guest", el("span", { class: "unverified" }, " (unverified)")));
    head.appendChild(timeEl(blip.decision.recordedAt || blip.createdAt, ctx.now));
  } else if (blip.kind !== "agent" && blip.kind !== "proposal") {
    head.appendChild(el("span", { class: "blip-author" }, blip.by || "Guest"));
    head.appendChild(timeEl(blip.createdAt, ctx.now));
  } else {
    head.appendChild(timeEl(blip.createdAt, ctx.now));
  }
  if (ctx.editedBy.length) head.appendChild(el("span", { class: "blip-edited" }, "edited by ", ctx.editedBy.join(", ")));
  if (blip.kind === "proposal" && blip.proposal) head.appendChild(proposalChips(ctx));
  if (ctx.peersEditing.length) head.appendChild(el("span", { class: "editing-chip" }, editingLabel(ctx.peersEditing)));
  if (ctx.textState && !ctx.exportMode) head.appendChild(savingChip(ctx));
  return head;
}

/**
 * Refreshes only the head and the card's flags (chips, times, since-marker dot), leaving the body,
 * an open editor and the reply slots untouched.
 * @param {HTMLElement} card @param {CardContext} ctx
 */
export function updateHead(card, ctx) {
  applyFlags(card, ctx);
  const old = card.querySelector(":scope > .blip-head");
  const head = buildHead(ctx);
  if (old) card.replaceChild(head, old);
  else card.insertBefore(head, card.firstChild);
}

/**
 * Fills `card` for `ctx`. Every previous child is dropped, except that `ctx.editor` (when editing)
 * is placed in the body's position as is.
 * @param {HTMLElement} card
 * @param {CardContext} ctx
 * @returns {CardSlots}
 */
export function renderCard(card, ctx) {
  const { blip, actions } = ctx;
  const a = actions;
  clear(card);
  applyFlags(card, ctx);
  const writable = !ctx.exportMode && !ctx.historyMode;
  card.appendChild(buildHead(ctx));

  // --- body ----------------------------------------------------------------------------------
  /** @type {HTMLElement[]} */
  const paraSlots = [];
  /** @type {HTMLElement} */
  let body;
  if (ctx.editing && ctx.editor) {
    body = el("div", { class: "blip-edit" }, ctx.editor);
  } else {
    body = el("div", { class: "blip-body" });
    if (blip.kind === "proposal" && blip.proposal) {
      body.appendChild(proposalBody(ctx));
    } else {
      const blockEls = renderBlocks(ctx.blocks, { onBlipLink: ctx.onBlipLink });
      if (blockEls.length === 0) body.appendChild(el("p", { class: "blip-empty" }, ctx.preview ? "…" : "(empty)"));
      blockEls.forEach((blockEl, i) => {
        const wrap = el("div", { class: "blip-para", "data-para": String(i) }, blockEl);
        if (writable && !blip.locked && blip.kind !== "agent") {
          wrap.appendChild(button("Reply to this paragraph", () => a.replyPara(blip.id, i), {
            class: "para-reply-btn", "aria-label": `Reply to paragraph ${i + 1}`, title: "Reply to this paragraph", tabindex: "-1",
          }));
        }
        const slot = el("div", { class: "para-replies", "data-para": String(i) });
        wrap.appendChild(slot);
        paraSlots.push(slot);
        body.appendChild(wrap);
      });
      if (blip.kind === "agent") body.appendChild(agentSources(ctx));
      if (blip.kind === "decision" && blip.decision) body.appendChild(decisionSections(ctx));
    }
    if (!ctx.exportMode && !ctx.historyMode && !blip.locked && blip.kind !== "proposal" && blip.kind !== "agent") {
      body.addEventListener("click", (e) => {
        const t = /** @type {HTMLElement} */ (e.target);
        if (t.closest(".wave-blip") !== card || t.closest("button, a, .para-replies")) return;
        a.edit(blip.id);
      });
    }
  }
  card.appendChild(body);
  const tail = el("div", { class: "para-replies para-replies-tail" });
  card.appendChild(tail);

  // --- actions -------------------------------------------------------------------------------
  const bar = el("div", { class: "blip-actions", role: "toolbar", "aria-label": "Actions" });
  if (writable) {
    if (!ctx.editing) { // the editor wrapper carries its own Done bar
      switch (blip.kind) {
        case "brief":
          bar.appendChild(button("Edit", () => a.edit(blip.id), { class: "edit-btn", tabindex: "-1" }));
          bar.appendChild(button("Reply", () => a.reply(blip.id), { class: "reply-btn", tabindex: "-1" }));
          if (ctx.state.capabilities?.model) bar.appendChild(button("Refresh brief", () => a.refreshBrief(blip.id), { class: "refresh-brief-btn", tabindex: "-1" }));
          break;
        case "agent":
          bar.appendChild(button("Discard", () => a.remove(blip.id), { class: "agent-discard", tabindex: "-1" }));
          bar.appendChild(button("Reply", () => a.reply(blip.id), { class: "reply-btn", tabindex: "-1" }));
          if (blip.runId) { const runId = blip.runId; bar.appendChild(button("Show run", () => a.showRun(runId), { class: "show-run-btn", tabindex: "-1" })); }
          break;
        case "proposal": {
          const p = blip.proposal;
          const target = p ? ctx.state.blips[p.targetId] : undefined;
          const stale = !!p && (p.state === "stale" || (!!target && target.seq !== p.baseSeq));
          if (p && (p.state === "review" || p.state === "stale")) {
            if (stale) bar.appendChild(button("Regenerate", () => a.regenerate(blip.id), { class: "proposal-regenerate", tabindex: "-1", disabled: !ctx.state.capabilities?.model || null }));
            else bar.appendChild(button("Accept", () => a.accept(blip.id), { class: "proposal-accept", tabindex: "-1" }));
            bar.appendChild(button("Reject", () => a.reject(blip.id), { class: "proposal-reject", tabindex: "-1" }));
          }
          bar.appendChild(button("Reply", () => a.reply(blip.id), { class: "reply-btn", tabindex: "-1" }));
          if (blip.runId) { const runId = blip.runId; bar.appendChild(button("Show run", () => a.showRun(runId), { class: "show-run-btn", tabindex: "-1" })); }
          break;
        }
        case "decision":
          bar.appendChild(button("Reply", () => a.reply(blip.id), { class: "reply-btn", tabindex: "-1" }));
          bar.appendChild(button("Record new decision", () => a.recordDecision(blip.id), { class: "record-decision-btn", tabindex: "-1" }));
          break;
        default:
          bar.appendChild(button("Reply", () => a.reply(blip.id), { class: "reply-btn", tabindex: "-1" }));
          bar.appendChild(button("Edit", () => a.edit(blip.id), { class: "edit-btn", tabindex: "-1" }));
          bar.appendChild(button("Delete", () => a.remove(blip.id), { class: "delete-btn", tabindex: "-1" }));
          if (blip.parentId === null) bar.appendChild(button("Record decision", () => a.recordDecision(blip.id), { class: "record-decision-btn", tabindex: "-1" }));
      }
      if (ctx.depth === 1 && blip.kind !== "brief") bar.appendChild(button("Focus", () => a.focusThread(blip.id), { class: "focus-btn", tabindex: "-1" }));
      bar.appendChild(moreMenu(card, ctx));
    }
  } else if (!ctx.exportMode && ctx.depth === 1 && blip.kind !== "brief") {
    bar.appendChild(button("Focus", () => a.focusThread(blip.id), { class: "focus-btn", tabindex: "-1" }));
  }
  if (bar.childNodes.length) card.appendChild(bar);

  // --- replies -------------------------------------------------------------------------------
  const replies = el("div", { class: "blip-replies" });
  card.appendChild(replies);
  const more = el("div", { class: "blip-more" });
  if (ctx.hidden > 0) {
    more.appendChild(button(`${ctx.hidden} more ${ctx.hidden === 1 ? "reply" : "replies"}`, () => a.expand(blip.id), { class: "expand-btn", tabindex: "-1", "aria-expanded": "false" }));
  }
  card.appendChild(more);
  return { body, paraSlots, tail, replies, more };
}

/** @param {HTMLElement} node @param {string} name @param {boolean} on */
function setFlag(node, name, on) {
  if (on) node.setAttribute(name, "1");
  else node.removeAttribute(name);
}

/** @param {number} ms @param {number} now */
function timeEl(ms, now) {
  return el("time", { class: "blip-time", datetime: ms ? new Date(ms).toISOString() : null, title: ms ? new Date(ms).toLocaleString() : null }, relativeTime(ms, now));
}

/** @param {CardContext} ctx */
function agentOpLabel(ctx) {
  const run = ctx.blip.runId ? ctx.state.runs[ctx.blip.runId] : undefined;
  return run ? (RUN_OP_LABELS[run.op] ?? run.op) : "Agent";
}

/** @param {CardContext} ctx */
function targetLabel(ctx) {
  const p = ctx.blip.proposal;
  const target = p ? ctx.state.blips[p.targetId] : undefined;
  if (!p) return "";
  const label = target ? (target.kind === "brief" ? "the brief" : (firstLine(target.preview, 40) || shortId(target.id))) : shortId(p.targetId);
  return button(label, () => ctx.actions.goTo(p.targetId), { class: "bliplink proposal-target", "data-bid": p.targetId, tabindex: "-1" });
}

/** @param {CardContext} ctx */
function proposalChips(ctx) {
  const p = /** @type {NonNullable<Blip["proposal"]>} */ (ctx.blip.proposal);
  const target = ctx.state.blips[p.targetId];
  const current = target ? target.seq : null;
  const stale = p.state === "stale" || (current !== null && current !== p.baseSeq);
  const wrap = el("span", { class: "proposal-chips" });
  wrap.appendChild(el("span", { class: "chip version-chip" }, `based on version ${p.baseSeq}`));
  if (current !== null) wrap.appendChild(el("span", { class: "chip version-chip" }, `current ${current}`));
  if (p.state === "review" && stale) wrap.appendChild(el("span", { class: "chip stale-chip" }, "based on an older version"));
  if (p.state === "accepted") wrap.appendChild(el("span", { class: "chip state-chip", "data-state": "accepted" }, "Accepted", p.reviewedBy ? ` by ${p.reviewedBy}` : ""));
  if (p.state === "rejected") wrap.appendChild(el("span", { class: "chip state-chip", "data-state": "rejected" }, "Rejected", p.reviewedBy ? ` by ${p.reviewedBy}` : ""));
  if (p.state === "stale") wrap.appendChild(el("span", { class: "chip stale-chip" }, "based on an older version"));
  return wrap;
}

/** @param {CardContext} ctx */
function proposalBody(ctx) {
  const p = /** @type {NonNullable<Blip["proposal"]>} */ (ctx.blip.proposal);
  const wrap = el("div", { class: "proposal" });
  if (p.summary) wrap.appendChild(el("p", { class: "proposal-summary" }, p.summary));
  const diff = el("div", { class: "diff diff-stacked" });
  diff.appendChild(el("div", { class: "diff-side diff-quote" },
    el("div", { class: "diff-label" }, p.quote ? "Replaces" : "Replaces the whole text"),
    p.quote ? el("del", { class: "diff-text" }, ...renderBlocks(parseMarkdown(p.quote), { onBlipLink: ctx.onBlipLink })) : null));
  diff.appendChild(el("div", { class: "diff-side diff-replacement" },
    el("div", { class: "diff-label" }, "With"),
    el("ins", { class: "diff-text" }, ...renderBlocks(parseMarkdown(p.replacement), { onBlipLink: ctx.onBlipLink }))));
  wrap.appendChild(diff);
  if (p.sources?.length) wrap.appendChild(sourcesRow(p.sources, ctx));
  if (ctx.text && ctx.text.trim()) wrap.appendChild(el("div", { class: "proposal-note" }, ...renderBlocks(ctx.blocks, { onBlipLink: ctx.onBlipLink })));
  return wrap;
}

/** @param {CardContext} ctx */
function agentSources(ctx) {
  const ids = citedBlipIds(ctx.text).filter((id) => id !== ctx.blip.id);
  return ids.length ? sourcesRow(ids, ctx) : el("div", { class: "agent-sources agent-sources-empty" });
}

/** @param {string[]} ids @param {CardContext} ctx */
function sourcesRow(ids, ctx) {
  const row = el("div", { class: "agent-sources" }, el("span", { class: "sources-label" }, "sources: "));
  ids.forEach((id, i) => {
    if (i) row.appendChild(document.createTextNode(", "));
    row.appendChild(button(shortId(id), () => ctx.actions.goTo(id), { class: "bliplink source-link", "data-bid": id, title: "Go to " + id, tabindex: "-1" }));
  });
  return row;
}

/** @param {CardContext} ctx */
function decisionSections(ctx) {
  const d = /** @type {NonNullable<Blip["decision"]>} */ (ctx.blip.decision);
  const wrap = el("div", { class: "decision-sections" });
  const section = (/** @type {string} */ label, /** @type {string} */ text) => {
    if (!text || !text.trim()) return;
    wrap.appendChild(el("section", { class: "decision-section" },
      el("h4", { class: "decision-section-title" }, label),
      ...renderBlocks(parseMarkdown(text), { onBlipLink: ctx.onBlipLink })));
  };
  section("Rationale", d.rationale);
  section("Dissent", d.dissent);
  section("Next steps", d.nextSteps);
  if (d.supersedes) {
    const n = ctx.decisionNumberOf(d.supersedes);
    wrap.appendChild(el("p", { class: "decision-supersedes" }, "supersedes ",
      button(n ? `Decision ${n}` : shortId(d.supersedes), () => ctx.actions.goTo(/** @type {string} */ (d.supersedes)), { class: "bliplink supersedes-link", "data-bid": d.supersedes, tabindex: "-1" })));
  }
  if (d.supersededBy) {
    const n = ctx.decisionNumberOf(d.supersededBy);
    wrap.appendChild(el("p", { class: "decision-superseded" }, "superseded by ",
      button(n ? `Decision ${n}` : shortId(d.supersededBy), () => ctx.actions.goTo(/** @type {string} */ (d.supersededBy)), { class: "bliplink supersedes-link", "data-bid": d.supersededBy, tabindex: "-1" })));
  }
  return wrap;
}

/** @param {CardContext} ctx */
function savingChip(ctx) {
  const ts = /** @type {TextState} */ (ctx.textState);
  const state = ts.saving;
  const chip = el("span", { class: "saving-chip", "data-state": state, role: state === "failed" ? "status" : null },
    state === "saved" ? "Saved" : state === "saving" ? "Saving…" : failedLabel(ts.lastError));
  if (state === "failed" && ts.lastError === "blip_full" && !ctx.historyMode) {
    chip.appendChild(document.createTextNode(" "));
    chip.appendChild(button("Reply instead", () => ctx.actions.replyInstead(ctx.blip.id), { class: "reply-instead-btn", tabindex: "-1" }));
  }
  return chip;
}

/** @param {string|null} code */
function failedLabel(code) {
  switch (code) {
    case "blip_full": return "Not saved: this blip is full.";
    case "locked": return "Not saved: this blip is locked.";
    default: return "Not saved";
  }
}

/**
 * The "More" button and its menu (role="menu"): paragraph replies for keyboard users on phones,
 * Focus thread, Ask agent about this thread, Record decision. Opened inline inside the card.
 * @param {HTMLElement} card @param {CardContext} ctx
 */
function moreMenu(card, ctx) {
  const { blip, actions: a } = ctx;
  const wrap = el("span", { class: "blip-menu-wrap" });
  const menu = el("div", { class: "menu blip-menu", role: "menu", hidden: true });
  const btn = button("", () => toggle(), { class: "more-btn", "aria-haspopup": "menu", "aria-expanded": "false", "aria-label": "More actions", title: "More actions", tabindex: "-1" });
  btn.appendChild(svgIcon("more"));
  /** @param {string} label @param {() => void} fn @param {string} cls */
  const item = (label, fn, cls) => menu.appendChild(button(label, () => { close(); fn(); }, { class: "menu-item " + cls, role: "menuitem", tabindex: "-1" }));
  if (!blip.locked && blip.kind !== "agent" && blip.kind !== "proposal") {
    ctx.blocks.forEach((_, i) => { if (i < 20) item(`Reply to paragraph ${i + 1}`, () => a.replyPara(blip.id, i), "menu-reply-para"); });
  }
  item("Focus thread", () => a.focusThread(blip.id), "menu-focus");
  if (ctx.state.capabilities?.model) item("Ask agent about this thread", () => a.askAgent(blip.id), "menu-ask-agent");
  if (blip.kind !== "decision") item("Record decision", () => a.recordDecision(blip.id), "menu-record-decision");
  const items = () => /** @type {HTMLElement[]} */ ([...menu.querySelectorAll(".menu-item")]);
  function close() {
    if (menu.hidden) return;
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutside, true);
    btn.focus();
  }
  function toggle() {
    if (!menu.hidden) { close(); return; }
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onOutside, true);
    items()[0]?.focus();
  }
  /** @param {Event} e */
  function onOutside(e) {
    if (!wrap.contains(/** @type {Node} */ (e.target))) close();
  }
  menu.addEventListener("keydown", (e) => {
    const list = items();
    const i = list.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); e.stopPropagation(); list[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); e.stopPropagation(); list[list.length - 1]?.focus(); }
    else if (e.key === "Tab") { close(); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) e.stopPropagation();
  });
  menu.addEventListener("focusout", (e) => {
    const to = /** @type {Node|null} */ (e.relatedTarget);
    if (to && !wrap.contains(to)) { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); document.removeEventListener("pointerdown", onOutside, true); }
  });
  wrap.appendChild(btn);
  wrap.appendChild(menu);
  const anyCard = /** @type {any} */ (card);
  if (anyCard.__menuOpen) card.removeEventListener("blip-menu-open", anyCard.__menuOpen);
  anyCard.__menuOpen = () => toggle();
  card.addEventListener("blip-menu-open", anyCard.__menuOpen);
  return wrap;
}
