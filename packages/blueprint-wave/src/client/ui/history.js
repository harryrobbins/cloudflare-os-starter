// @ts-check
// History mode: a banner ("Viewing history · editing off"), a range input over the event
// sequence, the list of blips changed since the scrubber, the earliest available point, and text
// playback (getPlayback per changed blip, replayed into a scratch Y.Doc up to the scrubber). The
// conversation renders the result through setHistoryMode(seq, changedIds) and the playbackText
// callback. Also the "Catch up since here" hook into the Ask agent menu.
//
// The pure parts (range, clamping, changed set, text at a sequence, seq at a time) are exported
// for the unit tests.

import * as Y from "yjs";
import { decodeBytes } from "../../shared/protocol.js";
import { el, svgIcon, blipTitle, formatTime, debounce } from "./dom.js";
import { showToast } from "./dialogs.js";

/** @typedef {import("../store-contract.js").ClientState} ClientState */
/** @typedef {import("../store-contract.js").Change} Change */
/** @typedef {import("../../shared/protocol.js").WaveEvent} WaveEvent */
/** @typedef {import("../../shared/protocol.js").GetPlaybackResult} GetPlaybackResult */
/** @typedef {Exclude<GetPlaybackResult, {error: any}>} Playback */

/** Blips fetched per batch while scrubbing (about 45 RPC/s on the platform, shared with typing). */
const FETCH_BATCH = 6;
/** Most blips whose playback one scrub position fetches; beyond it the rest show live text. */
const FETCH_MAX = 200;
/** getChanges page size (its maximum). */
const EVENTS_PAGE = 1000;
/** Delay between the last scrubber move and the playback fetches it needs. */
const SCRUB_FETCH_MS = 120;

// ---------------------------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------------------------

/**
 * The scrubber's range: from the earliest sequence History can replay to the live one.
 * @param {number} earliestSeq @param {number} seq
 * @returns {{min: number, max: number}}
 */
export function scrubberRange(earliestSeq, seq) {
  const max = Math.max(0, Math.floor(Number(seq) || 0));
  const min = Math.min(max, Math.max(0, Math.floor(Number(earliestSeq) || 0)));
  return { min, max };
}

/**
 * @param {unknown} value @param {{min: number, max: number}} range
 * @returns {number}
 */
export function clampSeq(value, range) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return range.max;
  return Math.min(range.max, Math.max(range.min, n));
}

/**
 * Merges events into a cache sorted by seq, dropping duplicates and anything below `earliestSeq`.
 * @param {WaveEvent[]} cache @param {WaveEvent[]} incoming @param {number} [earliestSeq]
 * @returns {WaveEvent[]}
 */
export function mergeEvents(cache, incoming, earliestSeq = 0) {
  /** @type {Map<number, WaveEvent>} */
  const bySeq = new Map();
  for (const e of cache) if (e && Number.isInteger(e.seq) && e.seq >= earliestSeq) bySeq.set(e.seq, e);
  for (const e of incoming) if (e && Number.isInteger(e.seq) && e.seq >= earliestSeq) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * Ids of the blips touched by events with a sequence in (lo, hi] (either order of `a` and `b`),
 * in sequence order, unique.
 * @param {WaveEvent[]} events  sorted by seq
 * @param {number} a @param {number} b
 * @returns {string[]}
 */
export function changedBetween(events, a, b) {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  /** @type {string[]} */
  const ids = [];
  const seen = new Set();
  for (const e of events) {
    if (e.seq <= lo || e.seq > hi || !e.blipId || seen.has(e.blipId)) continue;
    seen.add(e.blipId);
    ids.push(e.blipId);
  }
  return ids;
}

/**
 * The smallest sequence at or after `time` (epoch ms), or null when no event is that recent.
 * @param {WaveEvent[]} events  sorted by seq
 * @param {number} time
 */
export function seqAtTime(events, time) {
  for (const e of events) if (typeof e.at === "number" && e.at >= time) return e.seq;
  return null;
}

/**
 * The creation sequence of each blip the events know about ("blip.create"). A blip absent from
 * the map was created before the earliest retained event.
 * @param {WaveEvent[]} events
 * @returns {Map<string, number>}
 */
export function createdSeqs(events) {
  /** @type {Map<string, number>} */
  const m = new Map();
  for (const e of events) if (e.kind === "blip.create" && e.blipId && !m.has(e.blipId)) m.set(e.blipId, e.seq);
  return m;
}

/**
 * The sequence of each blip's seeded text: the "text" event that was committed together with its
 * "blip.create" (a create with text, a reply, an agent blip, a template's blips). The core records
 * the create and the seed as two events in one commit, so no reader ever saw the blip without its
 * text; History shows the seed from the create step on (seededSeq) instead of an empty blip. Stored
 * data has no commit id: an event belongs to the create's commit when it follows the create with
 * no event of another time (`at`, the commit's clock) in between. A blip created empty has no seed.
 * @param {WaveEvent[]} events  sorted by seq
 * @returns {Map<string, number>}
 */
export function seededSeqs(events) {
  /** @type {Map<string, number>} */
  const seeds = new Map();
  /** @type {Map<string, number>} blip id -> its create's `at`, while that commit's events run */
  let open = new Map();
  let openAt = /** @type {number|null} */ (null);
  for (const e of events) {
    if (e.at !== openAt) { open = new Map(); openAt = e.at; }
    if (!e.blipId) continue;
    if (e.kind === "blip.create") open.set(e.blipId, e.seq);
    else if (e.kind === "text" && open.has(e.blipId)) {
      if (!seeds.has(e.blipId)) seeds.set(e.blipId, e.seq);
      open.delete(e.blipId);
    }
  }
  return seeds;
}

/**
 * The sequence to replay a blip's text to for scrubber position `seq`: `seq` itself, or the seed's
 * sequence when `seq` is the create step (or between it and the seed, in the same commit).
 * @param {number} seq @param {number|undefined} createdSeq @param {number|undefined} seedSeq
 */
export function replaySeq(seq, createdSeq, seedSeq) {
  if (createdSeq === undefined || seedSeq === undefined) return seq;
  return seq >= createdSeq && seq < seedSeq ? seedSeq : seq;
}

/**
 * The blip's text as of `seq`: the base state plus every update with seq <= `seq`, replayed into
 * a scratch Y.Doc (text "t"). `from` is the earliest sequence the playback covers (base.seq);
 * asking for an earlier `seq` returns the base text. Malformed updates are skipped.
 * @param {Playback} playback
 * @param {number} seq
 * @returns {{text: string, from: number, trimmed: boolean}}
 */
export function textAtSeq(playback, seq) {
  const doc = new Y.Doc();
  const from = Number(playback?.base?.seq) || 0;
  const baseState = playback?.base?.state ? decodeBytes(playback.base.state) : null;
  const trimmed = !!(baseState && baseState.length);
  try {
    if (baseState && baseState.length) Y.applyUpdateV2(doc, baseState);
    for (const u of playback?.updates ?? []) {
      if (!u || typeof u.seq !== "number" || u.seq > seq) continue;
      const bytes = decodeBytes(u.update);
      if (!bytes) continue;
      try { Y.applyUpdateV2(doc, bytes); } catch { /* skip a malformed update */ }
    }
    return { text: doc.getText("t").toString(), from, trimmed };
  } finally {
    doc.destroy();
  }
}

/** "history from version N" for a blip whose early updates were folded into its base, else null. @param {Playback} playback */
export function trimmedNote(playback) {
  const state = playback?.base?.state;
  const seq = Number(playback?.base?.seq) || 0;
  return state && seq > 0 ? `history from version ${seq}` : null;
}

/**
 * Which blips need playback data at `seq`: those that existed then (created at or before it, or
 * before the retained events) and have changed since (blip.seq > seq). Deleted blips count too:
 * a deletion after `seq` had not happened yet.
 * @param {Record<string, import("../../shared/protocol.js").Blip>} blips
 * @param {Map<string, number>} created
 * @param {number} seq
 * @returns {string[]}
 */
export function blipsToReplay(blips, created, seq) {
  /** @type {string[]} */
  const ids = [];
  for (const blip of Object.values(blips)) {
    if (!blip || blip.seq <= seq) continue;
    const c = created.get(blip.id);
    if (c !== undefined && c > seq) continue;
    ids.push(blip.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------------------------
// The History tab and mode
// ---------------------------------------------------------------------------------------------

/**
 * @param {import("./app.js").App} app
 */
export function createHistory(app) {
  const { store } = app;
  let active = false;
  let scrub = 0;
  /** @type {{min: number, max: number}} */
  let range = { min: 0, max: 0 };
  /** @type {WaveEvent[]} */
  let events = [];
  let eventsLoaded = false;
  /** @type {Promise<void>|null} */
  let loading = null;
  /** @type {Map<string, number>} */
  let created = new Map();
  /** @type {Map<string, number>} blip id -> seq of the text seeded with its create */
  let seeded = new Map();
  /** @type {Map<string, {playback: Playback, toSeq: number}>} */
  const cache = new Map();
  /** @type {Set<string>} */
  const failed = new Set();
  let fetchGeneration = 0;
  /** @type {string[]} */
  let changedIds = [];

  // ---- elements
  const scrubber = /** @type {HTMLInputElement} */ (el("input", {
    type: "range", class: "history-scrubber", min: "0", max: "0", step: "1", value: "0",
    "aria-label": "Version", "aria-valuetext": "",
  }));
  const position = el("span", { class: "history-pos", "aria-hidden": "true" });
  const earliest = el("p", { class: "history-earliest muted" });
  const changedHead = el("h3", { class: "history-changed-head" });
  const changedList = el("ul", { class: "history-changed" });
  const liveBtn = el("button", { type: "button", class: "btn outline history-live", onclick: () => exit() }, svgIcon("play"), "Back to live");
  const catchUpBtn = el("button", {
    type: "button", class: "btn outline catch-up-here", title: "Ask the agent what changed after this point",
    onclick: () => app.openAskAgent({ op: "catch_up", sinceSeq: scrub, blipIds: [] }),
  }, svgIcon("sparkle"), "Catch up since here");
  const enterBtn = el("button", { type: "button", class: "btn primary history-enter", onclick: () => enter() }, svgIcon("history"), "View history");
  const inactiveNote = el("p", { class: "muted" });
  const inactive = el("div", { class: "history-inactive" },
    el("p", null, "Look at the Wave as it was at any earlier point. Editing is off while you look; nothing changes for anyone else."),
    enterBtn, inactiveNote);
  const controls = el("div", { class: "history-active", hidden: true },
    el("div", { class: "history-scrub-row" },
      el("label", { for: "history-scrubber", class: "sr-only" }, "Version"),
      scrubber, position),
    el("p", { class: "muted" }, "Drag, or use the arrow keys to step one change at a time (Home and End jump to the ends)."),
    el("div", { class: "history-actions" }, liveBtn, catchUpBtn),
    earliest,
    changedHead, changedList,
  );
  scrubber.id = "history-scrubber";
  const root = el("div", { class: "history-tab" }, inactive, controls);

  const bannerPos = el("span", { class: "history-banner-pos" });
  const banner = el("div", { class: "history-banner", role: "status", hidden: true },
    svgIcon("history"), el("strong", null, "Viewing history"), el("span", { "aria-hidden": "true" }, " · "), "editing off",
    el("span", { "aria-hidden": "true" }, " · "), bannerPos,
    el("button", { type: "button", class: "btn small outline history-banner-live", onclick: () => exit() }, "Back to live"));

  // ---- events cache
  /** Loads every retained event once (paged), then keeps it current from "events" changes. */
  function loadEvents() {
    if (eventsLoaded) return Promise.resolve();
    if (loading) return loading;
    loading = (async () => {
      const state = store.getState();
      let after = Math.max(0, (state.meta.earliestSeq || 1) - 1);
      for (let page = 0; page < 10; page++) {
        const result = await store.getChanges(after, EVENTS_PAGE);
        if (!result || "error" in result) break;
        events = mergeEvents(events, result.events, result.earliestSeq);
        if (result.events.length < EVENTS_PAGE) break;
        after = result.events[result.events.length - 1].seq;
      }
      created = createdSeqs(events);
      seeded = seededSeqs(events);
      eventsLoaded = true;
    })().catch((err) => {
      showToast("Couldn't load history: " + (/** @type {any} */ (err)?.message ?? err));
    }).finally(() => { loading = null; });
    return loading;
  }

  /** @param {WaveEvent[]} incoming */
  function noteEvents(incoming) {
    if (!incoming?.length) return;
    events = mergeEvents(events, incoming, store.getState().meta.earliestSeq || 0);
    for (const e of incoming) if (e.kind === "blip.create" && e.blipId && !created.has(e.blipId)) created.set(e.blipId, e.seq);
    if (incoming.some((e) => e.kind === "blip.create" || e.kind === "text")) seeded = seededSeqs(events);
  }

  /**
   * The sequence just before the first event at or after `time`, so catch_up covers everything
   * since then; null when nothing has changed since.
   * @param {number} time
   */
  async function seqAt(time) {
    await loadEvents();
    const s = seqAtTime(events, time);
    return s === null ? null : s - 1;
  }

  // ---- mode
  function enter() {
    if (active) return;
    active = true;
    const state = store.getState();
    range = scrubberRange(state.meta.earliestSeq, state.seq);
    scrub = range.max;
    changedIds = [];
    inactive.hidden = true;
    controls.hidden = false;
    banner.hidden = false;
    app.conversation.setHistoryMode(scrub, changedIds);
    app.onHistoryChange?.(true);
    loadEvents().then(() => { if (active) applyScrub(scrub, true); });
    renderControls(state);
    // The scrubber lives in the History tab: show it, or focusing it would do nothing.
    app.openPanel("history");
    app.announce("Viewing history. Editing is off. Press Escape to return to live.");
    scrubber.focus();
  }

  function exit() {
    if (!active) return;
    active = false;
    fetchGeneration++;
    changedIds = [];
    inactive.hidden = false;
    controls.hidden = true;
    banner.hidden = true;
    app.conversation.setHistoryMode(null, []);
    app.onHistoryChange?.(false);
    renderInactive(store.getState());
    app.announce("Back to live");
    const toggle = /** @type {HTMLElement|null} */ (document.querySelector(".history-toggle"));
    (toggle ?? enterBtn).focus({ preventScroll: true });
  }

  /**
   * @param {number} seq
   * @param {boolean} [force]  re-apply even when the position is unchanged (events just loaded)
   */
  function applyScrub(seq, force = false) {
    const next = clampSeq(seq, range);
    if (next === scrub && !force) return;
    scrub = next;
    changedIds = changedBetween(events, scrub, range.max);
    app.conversation.setHistoryMode(scrub, changedIds);
    renderControls(store.getState());
    fetchDebounced();
  }

  const fetchDebounced = debounce(() => { void fetchPlayback(); }, SCRUB_FETCH_MS);

  /** Fetches playback for the blips the current position needs, in small batches, newest change first. */
  async function fetchPlayback() {
    if (!active) return;
    const generation = ++fetchGeneration;
    const state = store.getState();
    const seqNow = scrub;
    const wanted = blipsToReplay(state.blips, created, seqNow)
      .filter((id) => {
        const entry = cache.get(id);
        const blip = state.blips[id];
        return !failed.has(id) && (!entry || (blip && blip.textSeq > entry.toSeq));
      })
      .sort((a, b) => (state.blips[b]?.seq ?? 0) - (state.blips[a]?.seq ?? 0))
      .slice(0, FETCH_MAX);
    for (let i = 0; i < wanted.length; i += FETCH_BATCH) {
      const batch = wanted.slice(i, i + FETCH_BATCH);
      await Promise.all(batch.map(async (id) => {
        try {
          const result = await store.getPlayback(id, 0, undefined);
          if (!result || "error" in result) { failed.add(id); return; }
          cache.set(id, { playback: result, toSeq: result.seq });
        } catch {
          failed.add(id);
        }
      }));
      if (generation !== fetchGeneration || !active) return;
      app.conversation.setHistoryMode(scrub, changedIds);
      renderChanged(store.getState());
    }
  }

  /**
   * The conversation's playbackText callback: the text at the scrubber for a blip that existed
   * then and has changed since; null for blips created later (hidden) or unchanged (live text).
   * @param {string} id
   * @returns {string|null}
   */
  function playbackText(id) {
    if (!active) return null;
    const blip = store.getState().blips[id];
    if (!blip || blip.seq <= scrub) return null;
    const c = created.get(id);
    if (c !== undefined && c > scrub) return null;
    const entry = cache.get(id);
    if (!entry) return null;
    // At a blip's create step, its text as committed with the create (seededSeqs).
    return textAtSeq(entry.playback, replaySeq(scrub, c, seeded.get(id))).text;
  }

  // ---- rendering
  /** @param {number} seq */
  function eventAt(seq) {
    return events.find((e) => e.seq === seq) ?? null;
  }

  /** @param {ClientState} state */
  function renderInactive(state) {
    const r = scrubberRange(state.meta.earliestSeq, state.seq);
    inactiveNote.textContent = r.max === 0
      ? "Nothing has happened in this Wave yet."
      : r.min > 1
        ? `History goes back to version ${r.min} of ${r.max}; older changes were trimmed.`
        : `${r.max} ${r.max === 1 ? "change" : "changes"} so far.`;
    enterBtn.disabled = r.max === 0;
  }

  /** @param {ClientState} state */
  function renderControls(state) {
    scrubber.min = String(range.min);
    scrubber.max = String(range.max);
    if (scrubber.value !== String(scrub)) scrubber.value = String(scrub);
    scrubber.disabled = range.max <= range.min;
    const ev = eventAt(scrub);
    const when = ev ? formatTime(ev.at) : "";
    const posText = `${scrub} of ${range.max}${when ? " · " + when : ""}`;
    scrubber.setAttribute("aria-valuetext", `Version ${posText}${ev ? `, ${ev.by} ${describeEvent(ev)}` : ""}`);
    position.textContent = posText;
    bannerPos.textContent = `version ${scrub} of ${range.max}`;
    earliest.textContent = range.min > 1
      ? `Earliest available: version ${range.min} (older changes were trimmed to save space).`
      : `Earliest available: version ${range.min}.`;
    renderChanged(state);
  }

  /** @param {ClientState} state */
  function renderChanged(state) {
    const n = changedIds.length;
    changedHead.textContent = scrub >= range.max
      ? "You are at the live version."
      : n ? `Changed since version ${scrub}: ${n} ${n === 1 ? "blip" : "blips"}` : `Nothing has changed since version ${scrub}.`;
    const items = changedIds.slice(0, 100).map((id) => {
      const blip = state.blips[id];
      const entry = cache.get(id);
      const note = entry ? trimmedNote(entry.playback) : null;
      const last = [...events].reverse().find((e) => e.blipId === id && e.seq > scrub);
      return el("li", { class: "history-item", dataset: { bid: id } },
        el("button", {
          type: "button", class: "btn small history-item-btn",
          disabled: !blip,
          onclick: () => { if (blip) app.conversation.focusBlip(id, { scroll: true, highlight: true }); },
        }, blip ? blipTitle(blip, 60) : id),
        el("span", { class: "muted" }, last ? ` ${last.by} ${describeEvent(last)} · ${formatTime(last.at)}` : "",
          note ? ` · ${note}` : ""),
      );
    });
    changedList.replaceChildren(...items, n > 100 ? el("li", { class: "muted" }, `and ${n - 100} more`) : "");
  }

  scrubber.addEventListener("input", () => applyScrub(Number(scrubber.value)));
  scrubber.addEventListener("change", () => applyScrub(Number(scrubber.value)));

  return {
    el: root,
    banner,
    enter, exit,
    toggle: () => (active ? exit() : enter()),
    isActive: () => active,
    currentSeq: () => (active ? scrub : null),
    playbackText,
    seqAt,
    loadEvents,
    /**
     * @param {ClientState} state
     * @param {Change} change
     */
    render(state, change) {
      if (change.kind === "events" && change.events) noteEvents(change.events);
      if (!active) {
        if (change.kind === "snapshot" || change.kind === "meta" || change.kind === "events" || change.kind === "blips") renderInactive(state);
        return;
      }
      const r = scrubberRange(state.meta.earliestSeq, state.seq);
      if (r.min !== range.min || r.max !== range.max) {
        // At the live end, stay there as new changes arrive ("You are at the live version");
        // anywhere earlier, stay on the same version.
        const atEnd = scrub >= range.max;
        range = r;
        scrub = atEnd ? range.max : clampSeq(scrub, range);
        changedIds = changedBetween(events, scrub, range.max);
        if (change.kind !== "text") app.conversation.setHistoryMode(scrub, changedIds);
        renderControls(state);
        fetchDebounced();
      } else if (change.kind === "blips" || change.kind === "events") {
        renderChanged(state);
      }
    },
  };
}

/** @param {WaveEvent} e */
export function describeEvent(e) {
  switch (e.kind) {
    case "blip.create": return "added it";
    case "blip.delete": return "deleted it";
    case "blip.restore": return "restored it";
    case "blip.move": return "moved it";
    case "text": return "edited it";
    case "proposal.accept": return "accepted the proposal";
    case "proposal.reject": return "rejected the proposal";
    case "decision.record": return "recorded a decision";
    case "run.queued": return "asked the agent";
    case "run.started": return "started a run";
    case "run.done": return "finished a run";
    case "run.failed": return "had a run fail";
    case "run.cancelled": return "cancelled a run";
    case "run.unknown": return "lost a run to a restart";
    case "structure": return e.detail ? `changed the title to "${e.detail}"` : "changed the Wave";
    default: return "changed it";
  }
}
