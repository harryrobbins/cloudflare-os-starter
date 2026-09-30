// @ts-check
// The Arcade UI: plain DOM, no framework. Four places:
//   Games     the shelf: every game, its best scores, and New game from a starter
//   Play      one game full size, with its controls and live high scores
//   Code      the game's source beside a live preview, with errors pointing at lines
//   Music     the tunes, and the composer (composer.js)
//   Controls  this player's key layout and sound
//
// The server pushes a fresh view (games without code, tunes, prefs) after every change. A game's
// code is fetched when it is opened. No <form> and no confirm(): the iframe allows neither, so
// dangerous buttons take two clicks.

import { h, when } from "./dom.js";
import { mountPlayer, errorLine, audioContext, layoutFor } from "./player.js";
import { mountComposer } from "./composer.js";
import { ACTIONS, LAYOUTS, keyName } from "../engine/input.js";
// @ts-ignore text import, resolved by the build
import README from "../README.md?raw";

const LAYOUT_INFO = /** @type {Record<string, string>} */ ({
  auto: "Each game's own layout",
  arcade: "Arrows, Space or Z to fire, X or Shift for the second button",
  bbc: "Z and X left and right, ; and / up and down, Return to fire (the Acornsoft keys)",
  wasd: "W A S D to move, J to fire, K for the second button",
  both: "Arrows or WASD (or Z X) to move, Space or J to fire",
});
const ACTION_INFO = /** @type {Record<string, string>} */ ({
  left: "Left", right: "Right", up: "Up / thrust / jump", down: "Down", fire: "Fire / A", alt: "Second button / B", start: "Start", pause: "Pause",
});

/** The README's sections on writing games and composing, for the Code tab's reference panel. */
function referenceText() {
  const text = String(README);
  const start = text.indexOf("## Writing a game");
  const end = text.indexOf("## RPC surface");
  return start >= 0 ? text.slice(start, end > start ? end : undefined).trim() : text;
}

/**
 * @param {HTMLElement} root
 * @param {{me: {id: string, name: string}, call: (method: string, ...args: any[]) => Promise<any>, onRetry: () => void}} opts
 */
export function mountApp(root, opts) {
  const { me, call } = opts;
  /** @type {any} */
  let view = null;
  /** @type {{name: string, id?: string}} */
  let route = { name: "shelf" };
  let connection = "connecting";
  /** Revision a local write is waiting to see; main.js polls when a push is late. */
  let awaitRevision = 0;
  /** @type {any} */
  let player = null;
  /** @type {any} */
  let composer = null;
  /** @type {null | {gameId: string, version: number, source: string, dirty: boolean}} */
  let editing = null;

  const header = h("header", { class: "top" });
  const main = h("main", { class: "main" });
  const toasts = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
  const banner = h("div", { class: "banner", hidden: true });
  root.append(header, banner, main, toasts);

  /** @param {string} msg @param {string} [kind] */
  function toast(msg, kind = "info") {
    const t = h("div", { class: `toast ${kind}`, text: msg });
    toasts.append(t);
    setTimeout(() => t.remove(), kind === "error" ? 7000 : 3500);
  }

  /** A write: attributes it, remembers the revision to expect, and toasts refusals. @param {string} method @param {any} args */
  async function write(method, args) {
    const r = await call(method, { by: me, ...args });
    if (typeof r?.revision === "number") awaitRevision = Math.max(awaitRevision, r.revision);
    return r;
  }

  /** @param {Function} fn */
  const guarded = (fn) => async (/** @type {any[]} */ ...args) => {
    try { return await fn(...args); } catch (e) { toast(String(/** @type {any} */ (e)?.message ?? e), "error"); }
  };

  /** A button that asks for a second click within 3 s. @param {string} label @param {string} confirmLabel @param {() => any} action @param {Record<string, any>} [props] */
  function twoStep(label, confirmLabel, action, props = {}) {
    let armed = false;
    /** @type {any} */
    let timer = 0;
    const b = h("button", { type: "button", ...props, text: label });
    b.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        b.textContent = confirmLabel;
        b.classList.add("armed");
        timer = setTimeout(() => { armed = false; b.textContent = label; b.classList.remove("armed"); }, 3000);
        return;
      }
      clearTimeout(timer);
      armed = false;
      b.textContent = label;
      b.classList.remove("armed");
      action();
    });
    return b;
  }

  const gameById = (/** @type {string|undefined} */ id) => view?.games.find((/** @type {any} */ g) => g.id === id);

  function tuneByName(/** @type {string} */ name) {
    const key = String(name).toLowerCase();
    return view?.tunes.find((/** @type {any} */ t) => t.id === name || t.song.title.toLowerCase() === key)?.song;
  }

  /** @param {{name: string, id?: string}} next */
  function go(next) {
    if (editing?.dirty && route.name === "code" && next.name !== "code") {
      toast("You have unsaved code: Save it (Ctrl+S) or Revert first.", "error");
      return;
    }
    if (composer?.dirty && route.name === "music" && (next.name !== "music" || next.id !== route.id)) {
      toast("You have an unsaved tune: Save it first (Ctrl+S).", "error");
      return;
    }
    teardown();
    route = next;
    renderHeader();
    renderMain();
  }

  function teardown() {
    player?.stop();
    player = null;
    composer?.destroy();
    composer = null;
    editing = null;
  }

  // --- Header --------------------------------------------------------------------------------

  function renderHeader() {
    const tab = (/** @type {string} */ name, /** @type {string} */ label) => h("button", {
      type: "button", class: `tab${route.name === name || (name === "shelf" && ["play", "code"].includes(route.name)) ? " on" : ""}`, text: label,
      "aria-current": route.name === name ? "page" : undefined, onclick: () => go({ name }),
    });
    const title = h("button", { type: "button", class: "arcade-title", text: view?.title ?? "Arcade", title: "Rename this arcade" });
    title.addEventListener("click", () => {
      const input = h("input", { class: "arcade-title-input", value: view?.title ?? "", "aria-label": "Arcade name", maxLength: 60 });
      const done = guarded(async () => {
        const v = input.value.trim();
        if (v && v !== view?.title) await write("setTitle", { title: v });
        renderHeader();
      });
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); if (e.key === "Escape") { input.value = view?.title ?? ""; input.blur(); } });
      input.addEventListener("blur", done);
      title.replaceWith(input);
      input.focus();
      input.select();
    });
    const conn = h("span", { class: `conn ${connection}`, text: connection === "live" ? "" : connection === "lost" ? "Reconnecting…" : "Connecting…" });
    header.replaceChildren(
      h("div", { class: "brand" }, [h("span", { class: "logo", "aria-hidden": "true", text: "▚" }), title]),
      h("nav", { class: "tabs", "aria-label": "Arcade" }, [tab("shelf", "Games"), tab("music", "Music"), tab("controls", "Controls")]),
      conn,
    );
  }

  // --- Main ----------------------------------------------------------------------------------

  function renderMain() {
    if (!view) { main.replaceChildren(h("p", { class: "muted pad", text: "Loading the arcade…" })); return; }
    if (route.name === "play") return renderPlay(/** @type {string} */ (route.id));
    if (route.name === "code") return renderCode(/** @type {string} */ (route.id));
    if (route.name === "music") return renderMusic(route.id);
    if (route.name === "controls") return renderControls();
    renderShelf();
  }

  function renderShelf() {
    const cards = view.games.map((/** @type {any} */ g) => {
      const best = g.scores[0];
      const menu = h("details", { class: "card-menu" }, [
        h("summary", { "aria-label": `More for ${g.title}`, text: "⋯" }),
        h("div", { class: "menu" }, [
          h("button", { type: "button", text: "Rename…", onclick: guarded(async () => renameGame(g)) }),
          h("button", { type: "button", text: "Duplicate", onclick: guarded(async () => { const r = await write("duplicateGame", { gameId: g.id }); toast(`Made ${r.game.title}`); }) }),
          g.template && g.template !== "blank" ? twoStep("Reset code to the starter", "Click again to reset", guarded(async () => { await write("resetGame", { gameId: g.id }); toast(`${g.title} is back to the starter code`); })) : null,
          g.scores.length ? twoStep("Clear high scores", "Click again to clear", guarded(async () => { await write("clearScores", { gameId: g.id }); })) : null,
          twoStep("Delete game", "Click again to delete", guarded(async () => { await write("deleteGame", { gameId: g.id }); toast(`Deleted ${g.title}`); }), { class: "danger" }),
        ]),
      ]);
      return h("article", { class: `card kind-${g.kind}`, dataset: { game: g.id } }, [
        h("div", { class: "card-top" }, [h("span", { class: "badge", text: g.kind === "classroom" ? "Classroom" : "Arcade" }), menu]),
        h("h3", { text: g.title }),
        h("p", { class: "desc", text: g.description || "No description yet." }),
        h("p", { class: "best", text: best ? `Best: ${best.score.toLocaleString()} by ${best.name}` : "No scores yet" }),
        h("div", { class: "card-actions" }, [
          h("button", { type: "button", class: "primary", text: "▶ Play", "aria-label": `Play ${g.title}`, onclick: () => go({ name: "play", id: g.id }) }),
          h("button", { type: "button", text: "Code", "aria-label": `Edit the code of ${g.title}`, onclick: () => go({ name: "code", id: g.id }) }),
        ]),
      ]);
    });
    const tplSelect = h("select", { "aria-label": "Start from" }, view.templates.map((/** @type {any} */ t) => h("option", { value: t.id, text: t.kind === "template" ? `${t.title} (empty)` : t.title, selected: t.id === "blank" })));
    const newTitle = h("input", { placeholder: "Name your game", "aria-label": "New game name", maxLength: 60 });
    const create = guarded(async () => {
      const r = await write("createGame", { template: tplSelect.value, title: newTitle.value.trim() || undefined });
      go({ name: "code", id: r.game.id });
    });
    newTitle.addEventListener("keydown", (e) => { if (e.key === "Enter") create(); });
    const newCard = h("article", { class: "card new-card" }, [
      h("h3", { text: "New game" }),
      h("p", { class: "desc", text: "Start from a blank cartridge, or copy a starter to adapt it." }),
      h("label", { class: "stack" }, ["Start from", tplSelect]),
      newTitle,
      h("div", { class: "card-actions" }, [h("button", { type: "button", class: "primary", text: "Create and open code", onclick: create })]),
    ]);
    main.replaceChildren(h("section", { class: "shelf" }, [
      h("div", { class: "grid" }, [...cards, newCard]),
      h("p", { class: "muted pad", text: "Everyone in this workspace shares these games, tunes and high scores. Scores are recorded under your account." }),
    ]));
  }

  /** @param {any} g */
  function renameGame(g) {
    const card = main.querySelector(`[data-game="${g.id}"]`);
    if (!card) return;
    const title = h("input", { value: g.title, "aria-label": "Game name", maxLength: 60 });
    const desc = h("textarea", { value: g.description, "aria-label": "Description", rows: 3, maxLength: 240 });
    const save = guarded(async () => { await write("updateGame", { gameId: g.id, title: title.value, description: desc.value }); renderMain(); });
    card.replaceChildren(title, desc, h("div", { class: "card-actions" }, [
      h("button", { type: "button", class: "primary", text: "Save", onclick: save }),
      h("button", { type: "button", text: "Cancel", onclick: () => renderMain() }),
    ]));
    title.focus();
  }

  // --- Play ----------------------------------------------------------------------------------

  /** @param {string} gameId @param {HTMLElement} el @param {(err: any) => void} onError @param {(...a: any[]) => void} [log] */
  async function startPlayer(gameId, el, source, onError, log) {
    const g = gameById(gameId);
    return mountPlayer(el, source, g?.title ?? "game", {
      player: me,
      prefs: () => view.prefs,
      scores: () => gameById(gameId)?.scores ?? [],
      tune: tuneByName,
      log,
      onError,
      submitScore: async (score, detail) => {
        try {
          const r = await write("submitScore", { gameId, score, detail });
          if (r?.recorded) toast(r.rank === 1 ? `New top score: ${score.toLocaleString()}!` : `Score ${score.toLocaleString()} is number ${r.rank} on the table`);
          return r;
        } catch (e) { toast(`Your score was not saved: ${/** @type {any} */ (e)?.message ?? e}`, "error"); }
      },
    });
  }

  /** @param {string} gameId */
  function renderPlay(gameId) {
    const g = gameById(gameId);
    if (!g) { go({ name: "shelf" }); return; }
    const stage = h("div", { class: "stage", "aria-label": "Game" });
    const help = h("div", { class: "help-list" });
    const scores = h("ol", { class: "scores" });
    const notice = h("div", { class: "notice", hidden: true });
    const muteBtn = h("button", { type: "button", "aria-pressed": String(view.prefs.muted), text: view.prefs.muted ? "Sound off" : "Sound on" });
    muteBtn.addEventListener("click", guarded(async () => { await write("setPrefs", { muted: !view.prefs.muted }); }));
    let loadedVersion = 0;
    const load = guarded(async () => {
      player?.stop();
      notice.hidden = true;
      const full = await call("getGame", gameId);
      loadedVersion = full.version;
      try {
        player = await startPlayer(gameId, stage, full.source, (err) => showCrash(err));
      } catch (err) { showCrash(err); return; }
      renderHelp();
    });
    const showCrash = (/** @type {any} */ err) => {
      stage.replaceChildren(h("div", { class: "crash" }, [
        h("h3", { text: "This game stopped with an error" }),
        h("pre", { text: `${err?.message ?? err}${errorLine(err) ? `\n(line ${errorLine(err)})` : ""}` }),
        h("button", { type: "button", class: "primary", text: "Open the code", onclick: () => go({ name: "code", id: gameId }) }),
      ]));
    };
    const renderHelp = () => {
      if (!player) return;
      const layout = layoutFor(view.prefs, player.game.config.controls ?? "arcade");
      const lines = /** @type {string[]} */ (Array.isArray(player.game.config.help) ? player.game.config.help : []);
      const used = ACTIONS.filter((a) => a !== "start" || lines.some((l) => /start|return|enter/i.test(l)));
      help.replaceChildren(
        ...lines.map((l) => h("p", { text: String(l) })),
        player.game.config.typing ? null : h("table", { class: "keys" }, used.map((a) => h("tr", {}, [h("th", { text: ACTION_INFO[a] }), h("td", { text: [...new Set((layout[a] ?? []).map(keyName))].join(" or ") })]))),
        h("p", { class: "muted", text: player.game.config.typing ? "This game reads typing: letters and numbers go to the game." : "P pauses. Change keys on the Controls tab." }),
      );
    };
    const renderScores = () => {
      const list = gameById(gameId)?.scores ?? [];
      scores.replaceChildren(...(list.length ? list.map((/** @type {any} */ s) => h("li", { class: s.name === me.name ? "me" : "" }, [h("span", { text: s.name }), h("b", { text: s.score.toLocaleString() })])) : [h("li", { class: "muted", text: "No scores yet. Be the first." })]));
    };
    main.replaceChildren(h("section", { class: "play" }, [
      h("div", { class: "toolbar" }, [
        h("button", { type: "button", text: "← Games", onclick: () => go({ name: "shelf" }) }),
        h("h2", { text: g.title }),
        h("button", { type: "button", text: "Restart", onclick: load }),
        muteBtn,
        h("button", { type: "button", text: "Code", onclick: () => go({ name: "code", id: gameId }) }),
      ]),
      h("div", { class: "play-body" }, [
        stage,
        h("aside", { class: "side" }, [notice, h("h3", { text: "Controls" }), help, h("h3", { text: "High scores" }), scores]),
      ]),
    ]));
    renderScores();
    load();
    // Called with every new view while this page is open.
    playRefresh = () => {
      const now = gameById(gameId);
      if (!now) { toast("This game was deleted."); go({ name: "shelf" }); return; }
      renderScores();
      muteBtn.textContent = view.prefs.muted ? "Sound off" : "Sound on";
      muteBtn.setAttribute("aria-pressed", String(view.prefs.muted));
      player?.applyPrefs();
      renderHelp();
      if (now.version !== loadedVersion && loadedVersion) {
        notice.hidden = false;
        notice.replaceChildren(h("span", { text: `${now.updatedBy.name} saved new code. ` }), h("button", { type: "button", text: "Load it", onclick: load }));
      }
    };
  }
  /** @type {() => void} */
  let playRefresh = () => {};

  // --- Code ----------------------------------------------------------------------------------

  /** @param {string} gameId */
  function renderCode(gameId) {
    const g = gameById(gameId);
    if (!g) { go({ name: "shelf" }); return; }
    const gutter = h("pre", { class: "gutter", "aria-hidden": "true" });
    const ta = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "code", spellcheck: false, wrap: "off", "aria-label": `Code of ${g.title}`, autocapitalize: "off", autocomplete: "off" }));
    const stage = h("div", { class: "stage small", "aria-label": "Preview" });
    const consoleEl = h("div", { class: "console", role: "log", "aria-live": "polite", "aria-label": "Console" });
    const status = h("span", { class: "save-state", "aria-live": "polite" });
    const saveBtn = h("button", { type: "button", text: "Save", "aria-keyshortcuts": "Control+S" });
    const runBtn = h("button", { type: "button", class: "primary", text: "▶ Run", "aria-keyshortcuts": "Control+Enter" });
    const reference = h("aside", { class: "reference", hidden: true }, [h("pre", { text: referenceText() })]);
    const refBtn = h("button", { type: "button", text: "Reference", "aria-expanded": "false" });
    refBtn.addEventListener("click", () => { reference.hidden = !reference.hidden; refBtn.setAttribute("aria-expanded", String(!reference.hidden)); });

    const lineCount = () => ta.value.split("\n").length;
    const syncGutter = () => {
      const n = lineCount();
      if (gutter.dataset.n !== String(n)) { gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join("\n"); gutter.dataset.n = String(n); }
      gutter.scrollTop = ta.scrollTop;
    };
    ta.addEventListener("scroll", syncGutter);
    const setStatus = () => {
      if (!editing) return;
      status.textContent = editing.dirty ? "Unsaved changes" : `Saved, version ${editing.version}`;
      status.className = `save-state${editing.dirty ? " unsaved" : ""}`;
    };
    ta.addEventListener("input", () => { if (editing) { editing.dirty = ta.value !== editing.source; setStatus(); } syncGutter(); });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        // Tab indents; Escape then Tab leaves the editor (keyboard users are not trapped).
        if (ta.dataset.escaped === "1") { ta.dataset.escaped = ""; return; }
        e.preventDefault();
        const a = ta.selectionStart, b = ta.selectionEnd;
        if (e.shiftKey) {
          const lineStart = ta.value.lastIndexOf("\n", a - 1) + 1;
          if (ta.value.slice(lineStart, lineStart + 2) === "  ") { ta.value = ta.value.slice(0, lineStart) + ta.value.slice(lineStart + 2); ta.selectionStart = ta.selectionEnd = Math.max(lineStart, a - 2); }
        } else {
          ta.value = ta.value.slice(0, a) + "  " + ta.value.slice(b);
          ta.selectionStart = ta.selectionEnd = a + 2;
        }
        ta.dispatchEvent(new Event("input"));
      } else if (e.key === "Escape") ta.dataset.escaped = "1";
      else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
        // Keep the indentation of the line above.
        e.preventDefault();
        const a = ta.selectionStart;
        const lineStart = ta.value.lastIndexOf("\n", a - 1) + 1;
        const indent = /^[ \t]*/.exec(ta.value.slice(lineStart, a))?.[0] ?? "";
        const extra = /[{[(]\s*$/.test(ta.value.slice(lineStart, a)) ? "  " : "";
        ta.setRangeText(`\n${indent}${extra}`, a, ta.selectionEnd, "end");
        ta.dispatchEvent(new Event("input"));
      } else ta.dataset.escaped = "";
    });

    /** @param {number} line */
    const gotoLine = (line) => {
      const lines = ta.value.split("\n");
      const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
      ta.focus();
      ta.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
      ta.scrollTop = Math.max(0, (line - 5) * 18);
      syncGutter();
    };
    /** @param {string} kind @param {string} text @param {number|null} [line] */
    const log = (kind, text, line = null) => {
      const row = h("div", { class: `log ${kind}` }, [h("span", { text })]);
      if (line) row.prepend(h("button", { type: "button", class: "link", text: `line ${line}`, onclick: () => gotoLine(line) }));
      consoleEl.append(row);
      while (consoleEl.childElementCount > 200) consoleEl.firstElementChild?.remove();
      consoleEl.scrollTop = consoleEl.scrollHeight;
    };
    const run = async () => {
      player?.stop();
      player = null;
      consoleEl.replaceChildren();
      try {
        player = await startPlayer(gameId, stage, ta.value, (err) => log("error", String(err?.message ?? err), errorLine(err)), (...a) => log("info", a.map(String).join(" ")));
        log("ok", `Running ${player.game.config.title ?? g.title}: ${player.game.settings.width}×${player.game.settings.height}. Click the game, then use the keys.`);
      } catch (err) {
        stage.replaceChildren(h("p", { class: "muted pad", text: "Fix the error, then Run again." }));
        log("error", String(/** @type {any} */ (err)?.message ?? err), errorLine(err));
      }
    };
    const save = guarded(async () => {
      if (!editing) return;
      saveBtn.disabled = true;
      try {
        const r = await write("saveGame", { gameId, source: ta.value, baseVersion: editing.version });
        editing.version = r.version;
        editing.source = ta.value;
        editing.dirty = false;
        setStatus();
        toast(r.unchanged ? "No changes to save" : `Saved version ${r.version}`);
      } finally { saveBtn.disabled = false; }
    });
    runBtn.addEventListener("click", run);
    saveBtn.addEventListener("click", save);
    // Revert discards local edits and loads the latest saved version (which may be someone else's).
    const revert = twoStep("Revert", "Click again to revert", () => load());
    const onKeys = (/** @type {KeyboardEvent} */ e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
      else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); run(); }
    };
    const section = h("section", { class: "code-view" }, [
      h("div", { class: "toolbar" }, [
        h("button", { type: "button", text: "← Games", onclick: () => go({ name: "shelf" }) }),
        h("h2", { text: g.title }),
        runBtn, saveBtn, revert, status,
        h("span", { class: "spacer" }),
        h("button", { type: "button", text: "Play full size", onclick: () => go({ name: "play", id: gameId }) }),
        refBtn,
      ]),
      h("div", { class: "code-body" }, [
        h("div", { class: "editor" }, [gutter, ta]),
        h("div", { class: "preview" }, [stage, consoleEl]),
        reference,
      ]),
    ]);
    section.addEventListener("keydown", onKeys);
    main.replaceChildren(section);
    async function loadLatest() {
      const full = await call("getGame", gameId);
      editing = { gameId, version: full.version, source: full.source, dirty: false };
      ta.value = full.source;
      syncGutter();
      setStatus();
      run();
    }
    const load = guarded(loadLatest);
    load();
    codeRefresh = () => {
      const now = gameById(gameId);
      if (!now) { toast("This game was deleted."); editing = null; go({ name: "shelf" }); return; }
      if (editing && now.version !== editing.version) {
        if (editing.dirty) {
          status.textContent = `${now.updatedBy.name} saved version ${now.version}; saving yours will be refused`;
          status.className = "save-state unsaved";
        } else load();
      }
    };
  }
  /** @type {() => void} */
  let codeRefresh = () => {};

  // --- Music ---------------------------------------------------------------------------------

  /** @param {string|undefined} tuneId */
  function renderMusic(tuneId) {
    const tunes = view.tunes;
    const current = tunes.find((/** @type {any} */ t) => t.id === tuneId) ?? tunes[0];
    const list = h("nav", { class: "tune-list", "aria-label": "Tunes" }, [
      ...tunes.map((/** @type {any} */ t) => h("button", {
        type: "button", class: `tune-item${t.id === current?.id ? " on" : ""}`, "aria-current": t.id === current?.id ? "true" : undefined,
        onclick: () => go({ name: "music", id: t.id }),
      }, [h("span", { text: t.song.title }), h("small", { text: `${t.song.channels.length} ch · ${t.song.tempo} bpm${t.song.loop ? " · loops" : ""}` })])),
      h("button", { type: "button", class: "primary", text: "+ New tune", onclick: guarded(async () => { const r = await write("createTune", {}); go({ name: "music", id: r.tune.id }); }) }),
    ]);
    const panel = h("div", { class: "composer-panel" });
    const actions = current ? h("div", { class: "row tune-actions" }, [
      h("button", { type: "button", text: "Duplicate", onclick: guarded(async () => { const r = await write("duplicateTune", { tuneId: current.id }); go({ name: "music", id: r.tune.id }); }) }),
      twoStep("Delete tune", "Click again to delete", guarded(async () => { await write("deleteTune", { tuneId: current.id }); go({ name: "music" }); }), { class: "danger" }),
      h("span", { class: "muted", text: `Last saved by ${current.updatedBy.name}, ${when(current.updatedAt)}. Use it in a game with a.music("${current.song.title}").` }),
    ]) : null;
    main.replaceChildren(h("section", { class: "music" }, [list, h("div", { class: "music-main" }, [panel, actions])]));
    if (!current) { panel.append(h("p", { class: "muted pad", text: "No tunes yet. Make one with New tune." })); return; }
    composer = mountComposer(panel, {
      tune: current,
      audio: audioContext,
      canEdit: true,
      onToast: toast,
      onSave: async (song, baseVersion) => {
        const r = await write("saveTune", { tuneId: current.id, song, baseVersion });
        if (r?.error) throw new Error(r.error);
        return r;
      },
    });
  }

  // --- Controls ------------------------------------------------------------------------------

  function renderControls() {
    const p = view.prefs;
    /** @type {string|null} */
    let listening = null;
    const layoutSel = h("div", { class: "layouts", role: "radiogroup", "aria-label": "Key layout" }, Object.keys(LAYOUT_INFO).map((id) => {
      const input = h("input", { type: "radio", name: "layout", value: id, checked: p.layout === id });
      input.addEventListener("change", guarded(async () => { await write("setPrefs", { layout: id }); }));
      return h("label", { class: "layout" }, [input, h("b", { text: id === "auto" ? "Game's own" : id.toUpperCase() }), h("span", { class: "muted", text: LAYOUT_INFO[id] })]);
    }));
    const base = p.layout === "auto" ? "arcade" : p.layout;
    const table = h("table", { class: "keys editable" }, [
      h("thead", {}, [h("tr", {}, [h("th", { text: "Action" }), h("th", { text: "Keys" }), h("th", { text: "" })])]),
      h("tbody", {}, ACTIONS.map((a) => {
        const own = p.custom?.[a];
        const keys = own?.length ? own : LAYOUTS[/** @type {keyof typeof LAYOUTS} */ (base)][/** @type {keyof typeof LAYOUTS.arcade} */ (a)];
        const change = h("button", { type: "button", text: "Change", "aria-label": `Change the key for ${ACTION_INFO[a]}` });
        change.addEventListener("click", () => {
          listening = a;
          change.textContent = "Press a key…";
          change.classList.add("armed");
          change.focus();
        });
        change.addEventListener("keydown", guarded(async (/** @type {KeyboardEvent} */ e) => {
          if (listening !== a) return;
          if (e.key === "Tab") return;
          e.preventDefault();
          listening = null;
          change.classList.remove("armed");
          if (e.key === "Escape") { renderControls(); return; }
          await write("setPrefs", { custom: { ...p.custom, [a]: [e.code] } });
        }));
        return h("tr", {}, [
          h("th", { text: ACTION_INFO[a] }),
          h("td", { text: `${[...new Set(keys.map(keyName))].join(" or ")}${own?.length ? " (yours)" : ""}` }),
          h("td", {}, [change]),
        ]);
      })),
    ]);
    const mute = h("input", { type: "checkbox", checked: p.muted });
    mute.addEventListener("change", guarded(async () => { await write("setPrefs", { muted: mute.checked }); }));
    const vol = h("input", { type: "range", min: 0, max: 1, step: 0.05, value: p.volume, "aria-label": "Volume" });
    vol.addEventListener("change", guarded(async () => { await write("setPrefs", { volume: Number(vol.value) }); }));
    main.replaceChildren(h("section", { class: "controls" }, [
      h("h2", { text: "Your controls" }),
      h("p", { class: "muted", text: "These are yours alone and follow you into every game in this arcade. Escape is kept for leaving full screen, so it cannot be bound." }),
      layoutSel,
      h("h3", { text: p.layout === "auto" ? "Your own keys (games otherwise use their own layout)" : "Keys" }),
      table,
      h("div", { class: "row" }, [twoStep("Reset my keys", "Click again to reset", guarded(async () => { await write("setPrefs", { custom: {} }); }))]),
      h("h3", { text: "Sound" }),
      h("div", { class: "row" }, [h("label", { class: "inline" }, [mute, " Mute"]), h("label", { class: "inline" }, ["Volume ", vol])]),
      h("h3", { text: "Touch screens" }),
      h("p", { class: "muted", text: "On a phone or tablet, on-screen buttons appear under the game: a direction pad, A (fire), B (second button) and Start." }),
    ]));
  }

  // --- Updates from main.js ------------------------------------------------------------------

  return {
    get view() { return view; },
    get awaitRevision() { return awaitRevision; },
    get route() { return route; },
    /** @param {any} next */
    setView(next) {
      if (!next || (view && next.revision < view.revision)) return;
      const first = !view;
      view = next;
      if (first) { renderHeader(); renderMain(); return; }
      renderHeader();
      if (route.name === "shelf") renderShelf();
      else if (route.name === "play") playRefresh();
      else if (route.name === "code") codeRefresh();
      else if (route.name === "music") {
        const t = view.tunes.find((/** @type {any} */ x) => x.id === (route.id ?? composer?.tuneId));
        if (!t) { if (!composer?.dirty) go({ name: "music" }); }
        else if (composer?.dirty || composer?.tuneId === t.id) {
          composer?.update(t);
          // Refresh the list's names without disturbing the open composer.
          const items = main.querySelectorAll(".tune-item");
          if (items.length !== view.tunes.length && !composer?.dirty) { teardown(); renderMusic(route.id); }
        } else { teardown(); renderMusic(route.id); }
      } else if (route.name === "controls") {
        if (!main.contains(document.activeElement) || document.activeElement?.tagName !== "BUTTON" || !document.activeElement?.classList.contains("armed")) renderControls();
      }
    },
    /** @param {string} state */
    setConnection(state) {
      if (state === connection) return;
      connection = state;
      renderHeader();
      banner.hidden = state !== "lost";
      banner.replaceChildren(h("span", { text: "Lost the connection to the arcade. Changes will not save until it is back. " }), h("button", { type: "button", text: "Reload", onclick: opts.onRetry }));
    },
  };
}
