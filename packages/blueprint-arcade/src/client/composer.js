// @ts-check
// The Music tab's composer: song settings, up to four channels of MML with live error checking,
// a piano roll with a playhead, an on-screen and computer-keyboard piano that writes notes at the
// cursor, and playback through the same synth games and exports use.

import { ENVELOPES, MAX_CHANNELS, WAVES, compileSong, midiToHz, renderSfx, renderSong } from "../shared/music.js";
import { h } from "./dom.js";

const CHANNEL_COLOURS = ["#ffd166", "#06d6a0", "#4cc9f0", "#ef476f"];
const LENGTHS = [1, 2, 4, 8, 16, 32];
const NOTE_NAMES = ["c", "c+", "d", "d+", "e", "f", "f+", "g", "g+", "a", "a+", "b"];
// Tracker-style computer keyboard piano: bottom row is the lower octave, top row the upper.
const PIANO_KEYS = /** @type {Record<string, number>} */ ({
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11, Comma: 12,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23, KeyI: 24,
});

/**
 * The octave in force at `pos` in some MML: follows o, > and <, ignoring comments.
 * @param {string} mml @param {number} pos
 */
export function octaveAt(mml, pos) {
  let octave = 4;
  for (let i = 0; i < Math.min(pos, mml.length); i++) {
    const ch = mml[i].toLowerCase();
    if (ch === ";") { while (i < pos && mml[i] !== "\n") i++; continue; }
    if (ch === ">") octave = Math.min(8, octave + 1);
    else if (ch === "<") octave = Math.max(0, octave - 1);
    else if (ch === "o" && /\d/.test(mml[i + 1] ?? "")) octave = Number(mml[i + 1]);
  }
  return octave;
}

/**
 * The text to insert at the cursor for a note: octave changes first when needed.
 * @param {number} midi @param {number} currentOctave @param {number} length
 */
export function noteText(midi, currentOctave, length) {
  const octave = Math.floor(midi / 12) - 1;
  const name = NOTE_NAMES[midi % 12];
  let prefix = "";
  const diff = octave - currentOctave;
  if (diff === 1) prefix = "> ";
  else if (diff === -1) prefix = "< ";
  else if (diff !== 0) prefix = `o${octave} `;
  return { text: `${prefix}${name}${length} `, octave };
}

/**
 * @param {HTMLElement} el
 * @param {{
 *   tune: any, audio: () => any, canEdit: boolean,
 *   onSave: (song: any, baseVersion: number) => Promise<any>, onToast: (msg: string, kind?: string) => void,
 * }} opts
 */
export function mountComposer(el, opts) {
  let tune = opts.tune;
  let song = structuredClone(tune.song);
  let baseVersion = tune.version;
  let dirty = false;
  let activeChannel = 0;
  let noteLength = 8;
  let pianoOctave = 4;
  /** @type {Set<number>} */
  const muted = new Set();
  /** @type {{src: any, started: number, seconds: number, loop: boolean}|null} */
  let playing = null;
  let raf = 0;

  el.replaceChildren();
  el.classList.add("composer");

  const status = h("span", { class: "save-state", "aria-live": "polite" });
  const title = h("input", { class: "tune-title", value: song.title, "aria-label": "Tune title", maxLength: 60 });
  const tempo = h("input", { type: "number", min: 30, max: 400, value: song.tempo, "aria-label": "Tempo in beats a minute", class: "tempo" });
  const loop = h("input", { type: "checkbox", checked: song.loop, "aria-label": "Loop" });
  const playBtn = h("button", { type: "button", class: "primary", text: "▶ Play", "aria-keyshortcuts": "Control+Enter" });
  const saveBtn = h("button", { type: "button", text: "Save", "aria-keyshortcuts": "Control+S" });
  const length = h("span", { class: "muted" });
  const roll = h("canvas", { class: "roll", height: 150, "aria-label": "Piano roll of every channel", role: "img" });
  const channelsEl = h("div", { class: "channels" });
  const addChannel = h("button", { type: "button", text: "+ Channel" });

  for (const input of [title, tempo, loop]) input.addEventListener("input", () => { readHeader(); changed(); });

  el.append(
    h("div", { class: "composer-bar" }, [
      title,
      h("label", { class: "inline" }, ["Tempo ", tempo]),
      h("label", { class: "inline" }, [loop, " Loop"]),
      playBtn, saveBtn, length, status,
    ]),
    roll,
    channelsEl,
    h("div", { class: "row" }, [addChannel]),
    pianoPanel(),
    h("details", { class: "help" }, [
      h("summary", { text: "How to write notes (MML), use tunes in games, and export" }),
      h("div", { class: "help-body" }, [
        h("p", { text: "Notes: c d e f g a b, with + or # for sharp and - for flat, then a length (1 whole, 2 half, 4 quarter, 8, 16, 32) and dots. r is a rest. & ties into the next note." }),
        h("p", { text: "o4 sets the octave, > and < go up and down one. l8 sets the default length, v12 the volume (0-15), q6 the gate (how much of each note sounds, 1-8). @noise, @square, @pulse25, @pulse12, @triangle, @saw, @sine and @periodic change the wave. [c d e]3 repeats. ; starts a comment. | is a bar line and is ignored." }),
        h("p", { text: "On the noise channel, the note sets the pitch of the hiss: o7 c is a hi-hat, o5 c a snare, o3 c a kick." }),
        h("p", { text: "In a game: a.music(\"Tune title\") plays a tune (looping if it loops), a.stopMusic() stops it." }),
        h("p", { text: "To download a tune as WAV audio or a MIDI file, use Export in the gadget's menu." }),
      ]),
    ]),
  );

  function readHeader() {
    song.title = title.value.trim() || "Untitled";
    song.tempo = Math.max(30, Math.min(400, Number(tempo.value) || 120));
    song.loop = loop.checked;
  }

  function changed() {
    dirty = true;
    status.textContent = "Unsaved changes";
    status.className = "save-state unsaved";
    refresh();
  }

  function renderChannels() {
    channelsEl.replaceChildren(...song.channels.map((/** @type {any} */ c, /** @type {number} */ i) => channelEditor(c, i)));
    addChannel.disabled = song.channels.length >= MAX_CHANNELS || !opts.canEdit;
    refresh();
  }

  /** @param {any} c @param {number} i */
  function channelEditor(c, i) {
    const name = h("input", { value: c.name, "aria-label": `Channel ${i + 1} name`, maxLength: 30, class: "ch-name" });
    const wave = h("select", { "aria-label": `Channel ${i + 1} wave` }, WAVES.map((w) => h("option", { value: w, text: w, selected: c.wave === w })));
    const env = h("select", { "aria-label": `Channel ${i + 1} envelope` }, Object.keys(ENVELOPES).map((e) => h("option", { value: e, text: e, selected: c.env === e })));
    if (typeof c.env === "object") env.append(h("option", { value: "custom", text: "custom", selected: true }));
    const vol = h("input", { type: "range", min: 0, max: 15, value: c.volume, "aria-label": `Channel ${i + 1} volume` });
    const mute = h("input", { type: "checkbox", checked: muted.has(i), "aria-label": `Mute channel ${i + 1} while listening` });
    const text = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "mml", spellcheck: false, rows: 4, "aria-label": `Channel ${i + 1} notes (MML)`, value: c.mml, dataset: { channel: String(i) } }));
    const errors = h("ul", { class: "mml-errors", "aria-live": "polite" });
    const remove = h("button", { type: "button", class: "icon", text: "✕", title: "Remove channel", "aria-label": `Remove channel ${i + 1}`, disabled: song.channels.length <= 1 || !opts.canEdit });
    name.addEventListener("input", () => { c.name = name.value; changed(); });
    wave.addEventListener("change", () => { c.wave = wave.value; changed(); });
    env.addEventListener("change", () => { if (env.value !== "custom") c.env = env.value; changed(); });
    vol.addEventListener("input", () => { c.volume = Number(vol.value); changed(); });
    mute.addEventListener("change", () => { if (mute.checked) muted.add(i); else muted.delete(i); if (playing) play(); });
    text.addEventListener("input", () => { c.mml = text.value; changed(); });
    text.addEventListener("focus", () => { activeChannel = i; markActive(); });
    text.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey) { e.preventDefault(); insertAt(text, "  "); }
    });
    remove.addEventListener("click", () => { song.channels.splice(i, 1); muted.clear(); activeChannel = 0; renderChannels(); changed(); });
    return h("section", { class: "channel", dataset: { index: String(i) }, style: `--ch:${CHANNEL_COLOURS[i]}` }, [
      h("div", { class: "channel-head" }, [
        h("span", { class: "swatch", "aria-hidden": "true" }), name, wave, env,
        h("label", { class: "inline" }, ["Vol ", vol]), h("label", { class: "inline" }, [mute, " Mute"]), remove,
      ]),
      text, errors,
    ]);
  }

  function markActive() {
    for (const s of channelsEl.querySelectorAll(".channel")) s.classList.toggle("active", Number(/** @type {HTMLElement} */ (s).dataset.index) === activeChannel);
  }

  /** @param {HTMLTextAreaElement} ta @param {string} s */
  function insertAt(ta, s) {
    const a = ta.selectionStart, b = ta.selectionEnd;
    ta.value = ta.value.slice(0, a) + s + ta.value.slice(b);
    ta.selectionStart = ta.selectionEnd = a + s.length;
    ta.dispatchEvent(new Event("input"));
  }

  /** Re-parses, shows errors, redraws the piano roll. */
  function refresh() {
    const compiled = compileSong(song);
    length.textContent = `${compiled.beats} beats, ${compiled.seconds.toFixed(1)} s`;
    compiled.channels.forEach((ch, i) => {
      const list = channelsEl.querySelector(`.channel[data-index="${i}"] .mml-errors`);
      if (!list) return;
      const mml = song.channels[i].mml;
      list.replaceChildren(...ch.errors.slice(0, 5).map((e) => {
        const line = mml.slice(0, e.at).split("\n").length;
        return h("li", { text: `Line ${line}: ${e.message}` });
      }));
    });
    drawRoll(compiled, playing ? position() : -1);
    markActive();
  }

  /** @param {ReturnType<typeof compileSong>} compiled @param {number} at seconds */
  function drawRoll(compiled, at) {
    const dpr = globalThis.devicePixelRatio || 1;
    const w = Math.max(200, roll.clientWidth || 600);
    const hgt = 150;
    if (roll.width !== Math.round(w * dpr)) { roll.width = Math.round(w * dpr); roll.height = Math.round(hgt * dpr); }
    const g = /** @type {CanvasRenderingContext2D} */ (roll.getContext("2d"));
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#0b0d12";
    g.fillRect(0, 0, w, hgt);
    const beats = Math.max(4, compiled.beats);
    const tonal = compiled.channels.flatMap((c) => c.events.filter((e) => e.wave !== "noise" && e.wave !== "periodic").map((e) => e.midi));
    const lo = Math.min(48, ...tonal) - 1, hi = Math.max(84, ...tonal) + 1;
    const x = (/** @type {number} */ b) => (b / beats) * w;
    const y = (/** @type {number} */ m) => hgt - 14 - ((m - lo) / (hi - lo)) * (hgt - 20);
    g.strokeStyle = "#1c2230";
    for (let b = 0; b <= beats; b += 4) { g.beginPath(); g.moveTo(x(b) + 0.5, 0); g.lineTo(x(b) + 0.5, hgt); g.stroke(); }
    compiled.channels.forEach((ch, i) => {
      g.fillStyle = CHANNEL_COLOURS[i];
      g.globalAlpha = muted.has(i) ? 0.2 : 0.9;
      for (const e of ch.events) {
        const drum = e.wave === "noise" || e.wave === "periodic";
        g.fillRect(x(e.beat), drum ? hgt - 10 : y(e.midi) - 2, Math.max(1.5, x(e.beats * e.gate) - 0.5), drum ? 8 : 4);
      }
    });
    g.globalAlpha = 1;
    if (at >= 0) {
      const px = x((at * compiled.tempo) / 60);
      g.fillStyle = "#ffffff";
      g.fillRect(px, 0, 2, hgt);
    }
  }

  function position() {
    const ctx = opts.audio();
    if (!playing || !ctx) return -1;
    const t = ctx.currentTime - playing.started;
    return playing.loop ? t % playing.seconds : t;
  }

  function stop() {
    try { playing?.src.stop(); } catch { /* ignore */ }
    playing = null;
    cancelAnimationFrame(raf);
    playBtn.textContent = "▶ Play";
    refresh();
  }

  function play() {
    const ctx = opts.audio();
    if (!ctx) { opts.onToast("This browser has no Web Audio, so tunes cannot play here.", "error"); return; }
    try { playing?.src.stop(); } catch { /* ignore */ }
    ctx.resume?.();
    const listen = { ...song, channels: song.channels.map((/** @type {any} */ c, /** @type {number} */ i) => (muted.has(i) ? { ...c, volume: 0 } : c)) };
    const { samples, seconds } = renderSong({ ...listen, loop: false }, { sampleRate: ctx.sampleRate });
    const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buf.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = song.loop;
    if (song.loop) { src.loopStart = 0; src.loopEnd = seconds; }
    src.connect(ctx.destination);
    src.start();
    playing = { src, started: ctx.currentTime, seconds: Math.max(0.01, seconds), loop: song.loop };
    src.addEventListener("ended", () => { if (playing?.src === src) stop(); });
    playBtn.textContent = "■ Stop";
    const frame = () => { if (!playing) return; drawRoll(compileSong(song), position()); raf = requestAnimationFrame(frame); };
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  }

  playBtn.addEventListener("click", () => { if (playing) stop(); else play(); });

  async function save() {
    if (!opts.canEdit) return;
    readHeader();
    saveBtn.disabled = true;
    status.textContent = "Saving…";
    try {
      const r = await opts.onSave(song, baseVersion);
      baseVersion = r.version;
      dirty = false;
      status.textContent = "Saved";
      status.className = "save-state";
    } catch (e) {
      status.textContent = "Not saved";
      status.className = "save-state unsaved";
      opts.onToast(String(/** @type {any} */ (e)?.message ?? e), "error");
    } finally {
      saveBtn.disabled = false;
    }
  }
  saveBtn.addEventListener("click", save);
  addChannel.addEventListener("click", () => {
    if (song.channels.length >= MAX_CHANNELS) return;
    song.channels.push({ name: `Channel ${song.channels.length + 1}`, wave: "square", volume: 10, env: "organ", mml: "o4 l8 " });
    renderChannels();
    changed();
  });

  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); if (playing) stop(); else play(); }
  };
  el.addEventListener("keydown", onKey);

  /** The piano: click a key, or focus the panel and play the computer keyboard. */
  function pianoPanel() {
    const lengthSel = h("select", { "aria-label": "Length of inserted notes" }, LENGTHS.map((n) => h("option", { value: n, text: `1/${n}`, selected: n === noteLength })));
    lengthSel.addEventListener("change", () => { noteLength = Number(lengthSel.value); });
    const octaveLabel = h("span", { class: "octave", text: `Octave ${pianoOctave}` });
    const down = h("button", { type: "button", class: "icon", text: "−", "aria-label": "Piano octave down" });
    const up = h("button", { type: "button", class: "icon", text: "+", "aria-label": "Piano octave up" });
    const setOct = (/** @type {number} */ o) => { pianoOctave = Math.max(1, Math.min(7, o)); octaveLabel.textContent = `Octave ${pianoOctave}`; drawKeys(); };
    down.addEventListener("click", () => setOct(pianoOctave - 1));
    up.addEventListener("click", () => setOct(pianoOctave + 1));
    const rest = h("button", { type: "button", text: "Rest" });
    rest.addEventListener("click", () => insertNote(null));
    const keys = h("div", { class: "piano-keys", tabIndex: 0, role: "group", "aria-label": "Piano. Focus it and play: Z S X D C V G B H N J M for the lower octave, Q 2 W 3 E R 5 T 6 Y 7 U I for the upper, Space for a rest." });
    const drawKeys = () => {
      keys.replaceChildren();
      for (let n = 0; n < 25; n++) {
        const midi = 12 * (pianoOctave + 1) + n;
        const black = [1, 3, 6, 8, 10].includes(n % 12);
        const k = h("button", { type: "button", tabIndex: -1, class: black ? "key black" : "key white", "aria-label": `${NOTE_NAMES[midi % 12].replace("+", " sharp").toUpperCase()}${Math.floor(midi / 12) - 1}`, dataset: { midi: String(midi) } });
        k.addEventListener("pointerdown", (e) => { e.preventDefault(); insertNote(midi); k.classList.add("down"); setTimeout(() => k.classList.remove("down"), 150); });
        keys.append(k);
      }
    };
    drawKeys();
    keys.addEventListener("keydown", (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === "Space") { e.preventDefault(); insertNote(null); return; }
      const n = PIANO_KEYS[e.code];
      if (n === undefined || e.repeat) return;
      e.preventDefault();
      const midi = 12 * (pianoOctave + 1) + n;
      insertNote(midi);
      const k = keys.querySelector(`[data-midi="${midi}"]`);
      k?.classList.add("down");
      setTimeout(() => k?.classList.remove("down"), 150);
    });
    return h("div", { class: "piano" }, [
      h("div", { class: "row" }, [
        h("strong", { text: "Piano" }),
        h("span", { class: "muted", text: "writes into the highlighted channel at its cursor" }),
        h("label", { class: "inline" }, ["Length ", lengthSel]), down, octaveLabel, up, rest,
      ]),
      keys,
    ]);
  }

  /** @param {number|null} midi a note, or null for a rest */
  function insertNote(midi) {
    if (!opts.canEdit) return;
    const ta = /** @type {HTMLTextAreaElement|null} */ (channelsEl.querySelector(`.channel[data-index="${activeChannel}"] textarea`));
    if (!ta) return;
    if (midi === null) { insertAt(ta, `r${noteLength} `); return; }
    const c = song.channels[activeChannel];
    const { text } = noteText(midi, octaveAt(ta.value, ta.selectionStart), noteLength);
    insertAt(ta, text);
    const ctx = opts.audio();
    if (ctx) {
      ctx.resume?.();
      const samples = renderSfx({ wave: c.wave, hz: midiToHz(midi), seconds: 0.25, vol: 0.5, env: typeof c.env === "string" ? c.env : "organ" }, ctx.sampleRate);
      const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      buf.getChannelData(0).set(samples);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start();
    }
  }

  if (!opts.canEdit) {
    for (const input of el.querySelectorAll("input, select, textarea")) /** @type {HTMLInputElement} */ (input).disabled = true;
    saveBtn.disabled = true;
  }
  renderChannels();
  status.textContent = `Version ${baseVersion}`;

  return {
    get dirty() { return dirty; },
    get tuneId() { return tune.id; },
    /** A newer saved version arrived: take it unless there are unsaved edits. @param {any} next */
    update(next) {
      if (next.version === baseVersion) return;
      if (dirty) {
        status.textContent = `${next.updatedBy?.name ?? "Someone"} saved a newer version`;
        status.className = "save-state unsaved";
        return;
      }
      tune = next;
      song = structuredClone(next.song);
      baseVersion = next.version;
      title.value = song.title; tempo.value = String(song.tempo); loop.checked = song.loop;
      renderChannels();
      status.textContent = `Version ${baseVersion}`;
    },
    destroy() { stop(); el.removeEventListener("keydown", onKey); },
  };
}
