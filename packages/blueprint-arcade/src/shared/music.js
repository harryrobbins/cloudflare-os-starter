// @ts-check
// Console music: a small Music Macro Language (MML) dialect, a pure-JS chip synth, and WAV and
// MIDI encoders. Shared by the browser (games, sound effects, the composer) and the gadget server
// (WAV and MIDI exports), so a tune sounds the same everywhere and needs no audio API to render.
//
// A song is {title, tempo, loop, channels: [{name, wave, volume, env, mml}]}, up to MAX_CHANNELS
// channels, like a BBC Micro's SN76489 (three tone channels and a noise channel) or a NES APU.
// The MML dialect is documented in src/README.md ("Composing music"); in short:
//
//   c d e f g a b   notes; + or # sharp, - flat; then an optional length (1 2 4 8 16 32 64) and dots
//   r               rest (takes a length too);  &  tie into the next note (no re-attack)
//   o4 > <          set octave (0-8), up one, down one;  l8  default length;  v12  volume 0-15
//   q6              gate: a note sounds for q/8 of its length (1-8, default 7)
//   @square         change wave (square pulse25 pulse12 triangle saw sine noise periodic)
//   [ ... ]3        repeat the bracketed part 3 times (nestable);  | and spaces are ignored
//   ; comment       to the end of the line

export const WAVES = ["square", "pulse25", "pulse12", "triangle", "saw", "sine", "noise", "periodic"];
export const ENVELOPES = {
  organ: { a: 0.005, d: 0.05, s: 0.85, r: 0.04 },
  pluck: { a: 0.002, d: 0.18, s: 0.25, r: 0.08 },
  pad: { a: 0.12, d: 0.3, s: 0.7, r: 0.35 },
  perc: { a: 0.001, d: 0.09, s: 0, r: 0.03 },
  bell: { a: 0.002, d: 0.6, s: 0.15, r: 0.5 },
};
export const MAX_CHANNELS = 4;
export const MAX_MML = 12_000;
export const MAX_BEATS = 4_000;
export const MAX_RENDER_SECONDS = 240;

const NOTE_OFFSETS = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/**
 * @typedef {{beat: number, beats: number, gate: number, midi: number, vol: number, wave: string,
 *   rest?: boolean, from: number, to: number}} NoteEvent
 *   beat/beats: position and length in quarter notes; gate: sounding fraction; from/to: source span
 * @typedef {{name?: string, wave?: string, volume?: number, env?: string|{a:number,d:number,s:number,r:number}, mml?: string}} Channel
 * @typedef {{title?: string, tempo?: number, loop?: boolean, channels?: Channel[]}} Song
 */

/** @param {number} midi */
export function midiToHz(midi) { return 440 * 2 ** ((midi - 69) / 12); }

/**
 * Parses one channel's MML into note events. Never throws: problems come back as `errors` with
 * the character offset, and parsing carries on after them.
 * @param {string} mml @param {{wave?: string, volume?: number}} [defaults]
 */
export function parseMml(mml, defaults = {}) {
  const src = String(mml ?? "").slice(0, MAX_MML);
  /** @type {NoteEvent[]} */
  const events = [];
  /** @type {{at: number, message: string}[]} */
  const errors = [];
  let octave = 4;
  let length = 4;
  let volume = clampInt(defaults.volume ?? 12, 0, 15);
  let gate = 7;
  let wave = WAVES.includes(defaults.wave ?? "") ? /** @type {string} */ (defaults.wave) : "square";
  let beat = 0;
  let tie = false;
  let steps = 0;

  /** @param {number} i */
  const readInt = (i) => {
    let j = i;
    while (j < src.length && src[j] >= "0" && src[j] <= "9") j++;
    return { value: j > i ? Number(src.slice(i, j)) : null, next: j };
  };
  /** Length digits then dots; returns quarter-note beats. @param {number} i */
  const readLength = (i) => {
    const { value, next } = readInt(i);
    let n = value ?? length;
    let j = next;
    if (![1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64].includes(n)) {
      errors.push({ at: i, message: `length ${n} is not one of 1 2 4 8 16 32 64 (or 3 6 12 24 48 for triplets)` });
      n = length;
    }
    let beats = 4 / n;
    let add = beats / 2;
    while (src[j] === ".") { beats += add; add /= 2; j++; }
    return { beats, next: j };
  };

  /** @param {number} start @param {number} end @param {number} depth */
  const run = (start, end, depth) => {
    let i = start;
    while (i < end) {
      if (++steps > 200_000) { errors.push({ at: i, message: "too many notes (check your [ ] repeats)" }); return; }
      if (beat > MAX_BEATS) { errors.push({ at: i, message: `longer than ${MAX_BEATS} beats` }); return; }
      const ch = src[i].toLowerCase();
      if (" \t\r\n|".includes(ch)) { i++; continue; }
      if (ch === ";") { while (i < end && src[i] !== "\n") i++; continue; }
      if (ch in NOTE_OFFSETS || ch === "r") {
        const from = i;
        let j = i + 1;
        let semis = 0;
        while (src[j] === "+" || src[j] === "#" || src[j] === "-") { semis += src[j] === "-" ? -1 : 1; j++; }
        const { beats, next } = readLength(j);
        j = next;
        let tieNext = false;
        while (src[j] === " ") j++;
        if (src[j] === "&") { tieNext = true; j++; }
        if (ch === "r") {
          beat += beats;
          tie = false;
        } else {
          const midi = 12 * (octave + 1) + NOTE_OFFSETS[/** @type {keyof typeof NOTE_OFFSETS} */ (ch)] + semis;
          const prev = events.at(-1);
          if (tie && prev && !prev.rest && prev.midi === midi && Math.abs(prev.beat + prev.beats - beat) < 1e-9) {
            prev.beats += beats;
            prev.gate = tieNext ? 1 : gate / 8;
            prev.to = j;
          } else {
            events.push({ beat, beats, gate: tieNext ? 1 : gate / 8, midi, vol: volume / 15, wave, from, to: j });
          }
          beat += beats;
          tie = tieNext;
        }
        i = j;
        continue;
      }
      if (ch === "o") {
        const { value, next } = readInt(i + 1);
        if (value === null || value > 8) errors.push({ at: i, message: "o needs an octave from 0 to 8" });
        else octave = value;
        i = next; continue;
      }
      if (ch === ">") { octave = Math.min(8, octave + 1); i++; continue; }
      if (ch === "<") { octave = Math.max(0, octave - 1); i++; continue; }
      if (ch === "l") {
        const { value, next } = readInt(i + 1);
        if (value === null || ![1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64].includes(value)) errors.push({ at: i, message: "l needs a length such as 4, 8 or 16" });
        else length = value;
        i = next; continue;
      }
      if (ch === "v") {
        const { value, next } = readInt(i + 1);
        if (value === null || value > 15) errors.push({ at: i, message: "v needs a volume from 0 to 15" });
        else volume = value;
        i = next; continue;
      }
      if (ch === "q") {
        const { value, next } = readInt(i + 1);
        if (value === null || value < 1 || value > 8) errors.push({ at: i, message: "q needs a gate from 1 to 8" });
        else gate = value;
        i = next; continue;
      }
      if (ch === "@") {
        let j = i + 1;
        while (j < end && /[a-z0-9]/i.test(src[j])) j++;
        const name = src.slice(i + 1, j).toLowerCase();
        if (WAVES.includes(name)) wave = name;
        else errors.push({ at: i, message: `unknown wave @${name}; try ${WAVES.join(", ")}` });
        i = j; continue;
      }
      if (ch === "[") {
        const close = matchBracket(src, i, end);
        if (close < 0) { errors.push({ at: i, message: "[ has no matching ]" }); return; }
        const { value, next } = readInt(close + 1);
        const times = value ?? 2;
        if (times < 1 || times > 64) errors.push({ at: close, message: "repeat count must be 1 to 64" });
        if (depth > 8) { errors.push({ at: i, message: "repeats nested too deeply" }); return; }
        for (let k = 0; k < Math.min(Math.max(times, 1), 64); k++) run(i + 1, close, depth + 1);
        i = next; continue;
      }
      if (ch === "]") { errors.push({ at: i, message: "] without a matching [" }); i++; continue; }
      if (ch === "t") { errors.push({ at: i, message: "set the tempo in the song's settings, not with t" }); i = readInt(i + 1).next; continue; }
      errors.push({ at: i, message: `unexpected "${src[i]}"` });
      i++;
    }
  };
  run(0, src.length, 0);
  return { events, beats: beat, errors };
}

/** @param {string} src @param {number} open @param {number} end */
function matchBracket(src, open, end) {
  let depth = 0;
  for (let i = open; i < end; i++) {
    if (src[i] === ";") { while (i < end && src[i] !== "\n") i++; continue; }
    if (src[i] === "[") depth++;
    else if (src[i] === "]" && --depth === 0) return i;
  }
  return -1;
}

/** @param {number} n @param {number} lo @param {number} hi */
function clampInt(n, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(Number(n) || 0))); }

/** @param {Channel["env"]} env */
export function envelopeOf(env) {
  if (env && typeof env === "object") {
    return { a: clamp(env.a, 0, 2), d: clamp(env.d, 0, 4), s: clamp(env.s, 0, 1), r: clamp(env.r, 0, 4) };
  }
  return ENVELOPES[/** @type {keyof typeof ENVELOPES} */ (env)] ?? ENVELOPES.organ;
}

/** @param {any} n @param {number} lo @param {number} hi */
function clamp(n, lo, hi) { const x = Number(n); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : lo; }

/**
 * Parses every channel. `seconds` is the length of the longest channel.
 * @param {Song} song
 */
export function compileSong(song) {
  const tempo = clamp(song?.tempo ?? 120, 30, 400);
  const channels = (Array.isArray(song?.channels) ? song.channels : []).slice(0, MAX_CHANNELS).map((c, index) => {
    const parsed = parseMml(c?.mml ?? "", { wave: c?.wave, volume: 15 });
    return {
      index,
      name: String(c?.name ?? `Channel ${index + 1}`),
      volume: clamp(c?.volume ?? 12, 0, 15) / 15,
      env: envelopeOf(c?.env),
      ...parsed,
    };
  });
  const beats = Math.max(0, ...channels.map((c) => c.beats));
  return { tempo, loop: Boolean(song?.loop), channels, beats, seconds: (beats * 60) / tempo };
}

// --- Synthesis -----------------------------------------------------------------------------

/**
 * One voice: fills `out` from sample `start` with a note of `seconds` (gate) then its release.
 * @param {Float32Array} out @param {number} sampleRate @param {number} start
 * @param {{hz: number, toHz?: number, seconds: number, vol: number, wave: string, env: {a:number,d:number,s:number,r:number}}} v
 */
export function synthVoice(out, sampleRate, start, v) {
  const { a, d, s, r } = v.env;
  const total = Math.ceil((v.seconds + r) * sampleRate);
  const end = Math.min(out.length, start + total);
  const gateEnd = v.seconds;
  let phase = 0;
  let lfsr = 0x4000;
  let noiseOut = 1;
  let noisePhase = 0;
  const periodic = v.wave === "periodic";
  // Level at the moment the gate closes, so release starts from wherever the envelope was.
  const levelAt = (/** @type {number} */ t) => (t < a ? t / a : t < a + d ? 1 - (1 - s) * ((t - a) / d) : s);
  const releaseFrom = levelAt(gateEnd);
  for (let i = Math.max(0, start), n = i - start; i < end; i++, n++) {
    const t = n / sampleRate;
    const env = t < gateEnd ? levelAt(t) : releaseFrom * Math.max(0, 1 - (t - gateEnd) / (r || 1e-4));
    if (env <= 0 && t >= gateEnd) break;
    const hz = v.toHz ? v.hz + (v.toHz - v.hz) * Math.min(1, t / Math.max(v.seconds, 1e-4)) : v.hz;
    let sample;
    if (v.wave === "noise" || periodic) {
      // A 15-bit LFSR clocked at the note's frequency times 8: white noise, or with `periodic` the
      // short-period buzz the SN76489 makes (feedback from one tap only).
      noisePhase += (hz * 8) / sampleRate;
      while (noisePhase >= 1) {
        noisePhase -= 1;
        const bit = periodic ? lfsr & 1 : (lfsr ^ (lfsr >> 1)) & 1;
        lfsr = (lfsr >> 1) | (bit << 14);
        if (periodic && lfsr === 0) lfsr = 0x4000;
        noiseOut = lfsr & 1 ? 1 : -1;
      }
      sample = noiseOut;
    } else {
      phase += hz / sampleRate;
      phase -= Math.floor(phase);
      switch (v.wave) {
        case "pulse25": sample = phase < 0.25 ? 1 : -1; break;
        case "pulse12": sample = phase < 0.125 ? 1 : -1; break;
        // Stepped to 16 levels, like the NES triangle channel.
        case "triangle": sample = Math.round((phase < 0.5 ? phase * 4 - 1 : 3 - phase * 4) * 7.5) / 7.5; break;
        case "saw": sample = phase * 2 - 1; break;
        case "sine": sample = Math.sin(phase * 2 * Math.PI); break;
        default: sample = phase < 0.5 ? 1 : -1;
      }
    }
    out[i] += sample * env * v.vol;
  }
}

/**
 * Renders a whole song to mono samples in [-1, 1]. `loops` plays a looping song that many times.
 * @param {Song} song @param {{sampleRate?: number, maxSeconds?: number, loops?: number}} [opts]
 */
export function renderSong(song, opts = {}) {
  const sampleRate = opts.sampleRate ?? 44_100;
  const compiled = compileSong(song);
  const loops = compiled.loop ? Math.max(1, opts.loops ?? 1) : 1;
  const spb = 60 / compiled.tempo;
  const tail = Math.max(0.05, ...compiled.channels.map((c) => c.env.r));
  const seconds = Math.min(opts.maxSeconds ?? MAX_RENDER_SECONDS, compiled.seconds * loops + tail);
  const out = new Float32Array(Math.max(1, Math.ceil(seconds * sampleRate)));
  const mix = 0.8 / Math.max(2, compiled.channels.length);
  for (let loop = 0; loop < loops; loop++) {
    const offset = loop * compiled.seconds;
    for (const ch of compiled.channels) {
      for (const e of ch.events) {
        const start = Math.round((offset + e.beat * spb) * sampleRate);
        if (start >= out.length) break;
        synthVoice(out, sampleRate, start, {
          hz: midiToHz(e.midi), seconds: e.beats * spb * e.gate, vol: e.vol * ch.volume * mix, wave: e.wave, env: ch.env,
        });
      }
    }
  }
  softClip(out);
  return { samples: out, sampleRate, seconds: compiled.seconds, compiled };
}

/** @param {Float32Array} out */
function softClip(out) {
  // A one-pole low-pass at about 9 kHz takes the edge off naive square waves, then clip softly.
  let y = 0;
  for (let i = 0; i < out.length; i++) {
    y += 0.72 * (out[i] - y);
    out[i] = Math.tanh(y * 1.2);
  }
}

// --- Sound effects -------------------------------------------------------------------------

/**
 * @typedef {{wave?: string, hz?: number, toHz?: number, seconds?: number, vol?: number, env?: string|object}} Blip
 * @typedef {Blip | Blip[] | {mml: string, tempo?: number, wave?: string, env?: string}} SfxSpec
 */
export const SFX_PRESETS = /** @type {Record<string, SfxSpec>} */ ({
  laser: { wave: "square", hz: 1400, toHz: 180, seconds: 0.14, vol: 0.5, env: "perc" },
  shoot: { wave: "pulse25", hz: 900, toHz: 300, seconds: 0.08, vol: 0.45, env: "perc" },
  explode: { wave: "noise", hz: 900, toHz: 60, seconds: 0.5, vol: 0.9, env: { a: 0.001, d: 0.45, s: 0, r: 0.1 } },
  bang: { wave: "noise", hz: 1800, toHz: 300, seconds: 0.18, vol: 0.8, env: "perc" },
  thrust: { wave: "noise", hz: 180, seconds: 0.09, vol: 0.35, env: "organ" },
  jump: { wave: "square", hz: 260, toHz: 720, seconds: 0.16, vol: 0.4, env: "pluck" },
  coin: { mml: "o6 l32 b > e4", tempo: 150, wave: "square", env: "pluck" },
  powerup: { mml: "o4 l32 c e g > c e g > c", tempo: 140, wave: "pulse25", env: "organ" },
  hit: { wave: "saw", hz: 220, toHz: 70, seconds: 0.18, vol: 0.6, env: "perc" },
  blip: { wave: "square", hz: 1320, seconds: 0.04, vol: 0.35, env: "perc" },
  select: { mml: "o5 l32 g > c", tempo: 150, wave: "square", env: "pluck" },
  correct: { mml: "o5 l16 c e g > c8", tempo: 160, wave: "pulse25", env: "organ" },
  wrong: { mml: "o3 l8 d- c4", tempo: 120, wave: "saw", env: "organ" },
  lose: { mml: "o4 l8 g f+ f e2", tempo: 110, wave: "square", env: "organ" },
  win: { mml: "o5 l16 c c c8 < g+8 a+8 > c8. < a+16 > c2", tempo: 150, wave: "pulse25", env: "organ" },
  step: { wave: "triangle", hz: 110, seconds: 0.06, vol: 0.7, env: "perc" },
  lock: { wave: "noise", hz: 3000, toHz: 800, seconds: 0.06, vol: 0.45, env: "perc" },
  line: { mml: "o5 l32 c e g > c e", tempo: 180, wave: "pulse12", env: "organ" },
  tick: { wave: "pulse12", hz: 2400, seconds: 0.015, vol: 0.3, env: "perc" },
  march1: { wave: "triangle", hz: 98, seconds: 0.09, vol: 0.9, env: "perc" },
  march2: { wave: "triangle", hz: 87, seconds: 0.09, vol: 0.9, env: "perc" },
  march3: { wave: "triangle", hz: 78, seconds: 0.09, vol: 0.9, env: "perc" },
  march4: { wave: "triangle", hz: 73, seconds: 0.09, vol: 0.9, env: "perc" },
  ufo: { mml: "[o6 l32 @square c e g e]4", tempo: 120, wave: "square", env: "organ" },
});

/**
 * Renders a sound effect: a preset name, a blip ({wave, hz, toHz, seconds, vol, env}), a list of
 * blips played one after another, or {mml, tempo, wave, env}.
 * @param {SfxSpec|string} spec @param {number} [sampleRate]
 */
export function renderSfx(spec, sampleRate = 44_100) {
  const s = typeof spec === "string" ? SFX_PRESETS[spec] : spec;
  if (!s) throw new Error(`Unknown sound "${spec}". Presets: ${Object.keys(SFX_PRESETS).join(", ")}`);
  if ("mml" in s && typeof s.mml === "string") {
    return renderSong({ tempo: s.tempo ?? 120, channels: [{ mml: s.mml, wave: s.wave ?? "square", env: s.env ?? "pluck", volume: 13 }] }, { sampleRate, maxSeconds: 8 }).samples;
  }
  const blips = /** @type {Blip[]} */ (Array.isArray(s) ? s : [s]);
  const total = blips.reduce((n, b) => n + clamp(b.seconds ?? 0.1, 0.005, 4) + envelopeOf(/** @type {any} */ (b.env)).r, 0);
  const out = new Float32Array(Math.ceil(Math.min(total, 8) * sampleRate) + 1);
  let at = 0;
  for (const b of blips) {
    const seconds = clamp(b.seconds ?? 0.1, 0.005, 4);
    const env = envelopeOf(/** @type {any} */ (b.env ?? "perc"));
    synthVoice(out, sampleRate, Math.round(at * sampleRate), {
      hz: clamp(b.hz ?? 440, 10, 12_000), toHz: b.toHz === undefined ? undefined : clamp(b.toHz, 10, 12_000),
      seconds, vol: clamp(b.vol ?? 0.5, 0, 1), wave: WAVES.includes(b.wave ?? "") ? /** @type {string} */ (b.wave) : "square", env,
    });
    at += seconds;
  }
  softClip(out);
  return out;
}

/**
 * The BBC Micro's SOUND channel, amplitude, pitch, duration as a blip.
 * channel 0 is noise (pitch 0-7: 0-3 periodic, 4-7 white; low bits pick high/mid/low), 1-3 are tone.
 * amplitude -15 (loudest) to 0 (silent); pitch 0-255 in quarter semitones, 53 = middle C;
 * duration in twentieths of a second.
 * @param {number} channel @param {number} amplitude @param {number} pitch @param {number} duration
 * @returns {Blip}
 */
export function bbcSound(channel, amplitude, pitch, duration) {
  const vol = clamp(-amplitude, 0, 15) / 15;
  const seconds = clamp(duration, 1, 254) / 20;
  if (clampInt(channel, 0, 3) === 0) {
    const p = clampInt(pitch, 0, 7);
    const hz = [6000, 3000, 1500, 750][p & 3] / 8;
    return { wave: p < 4 ? "periodic" : "noise", hz, seconds, vol, env: "organ" };
  }
  return { wave: "square", hz: 261.63 * 2 ** ((clampInt(pitch, 0, 255) - 53) / 48), seconds, vol: vol * 0.6, env: "organ" };
}

// --- Encoders ------------------------------------------------------------------------------

/** 16-bit mono PCM WAV. @param {Float32Array} samples @param {number} sampleRate */
export function encodeWav(samples, sampleRate) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(bytes.buffer);
  const str = (/** @type {number} */ at, /** @type {string} */ s) => { for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i); };
  str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  return bytes;
}

const GM_PROGRAM = { square: 80, pulse25: 80, pulse12: 80, triangle: 73, saw: 81, sine: 79 };

/**
 * A type-1 Standard MIDI File: a tempo track, then one track per channel. Noise and periodic notes
 * go to the General MIDI drum channel (high notes as a closed hi-hat, low as a snare or kick).
 * @param {Song} song
 */
export function encodeMidi(song) {
  const compiled = compileSong(song);
  const PPQ = 480;
  /** @param {number} n */
  const vlq = (n) => {
    const out = [n & 0x7f];
    while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
    return out;
  };
  /** @param {number[]} data */
  const chunk = (data) => [0x4d, 0x54, 0x72, 0x6b, (data.length >>> 24) & 255, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255, ...data];
  const usPerBeat = Math.round(60_000_000 / compiled.tempo);
  const title = [...new TextEncoder().encode(String(song?.title ?? "Tune").slice(0, 100))];
  const tracks = [chunk([0, 0xff, 0x03, ...vlq(title.length), ...title, 0, 0xff, 0x51, 3, (usPerBeat >> 16) & 255, (usPerBeat >> 8) & 255, usPerBeat & 255, 0, 0xff, 0x2f, 0])];
  compiled.channels.forEach((ch, index) => {
    /** @type {{tick: number, bytes: number[]}[]} */
    const evs = [];
    const melodic = index % 9;
    for (const e of ch.events) {
      const drum = e.wave === "noise" || e.wave === "periodic";
      const status = drum ? 9 : melodic;
      const key = drum ? (e.midi >= 72 ? 42 : e.midi >= 55 ? 38 : 36) : Math.max(0, Math.min(127, e.midi));
      const vel = Math.max(1, Math.round(e.vol * ch.volume * 127));
      const on = Math.round(e.beat * PPQ);
      const off = on + Math.max(1, Math.round(e.beats * e.gate * PPQ));
      evs.push({ tick: on, bytes: [0x90 | status, key, vel] }, { tick: off, bytes: [0x80 | status, key, 0] });
    }
    evs.sort((x, y) => x.tick - y.tick || (x.bytes[0] & 0xf0) - (y.bytes[0] & 0xf0));
    const firstWave = ch.events[0]?.wave ?? "square";
    const program = GM_PROGRAM[/** @type {keyof typeof GM_PROGRAM} */ (firstWave)] ?? 80;
    const name = [...new TextEncoder().encode(ch.name.slice(0, 60))];
    const data = [0, 0xff, 0x03, ...vlq(name.length), ...name, 0, 0xc0 | melodic, program];
    let last = 0;
    for (const e of evs) { data.push(...vlq(e.tick - last), ...e.bytes); last = e.tick; }
    data.push(0, 0xff, 0x2f, 0);
    tracks.push(chunk(data));
  });
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, (PPQ >> 8) & 255, PPQ & 255];
  return new Uint8Array([...header, ...tracks.flat()]);
}
