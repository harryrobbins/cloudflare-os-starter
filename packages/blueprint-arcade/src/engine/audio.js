// @ts-check
// Sound for games and the composer: everything is rendered by the pure synth in shared/music.js to
// sample buffers and played through Web Audio. With no AudioContext (tests, or a browser that
// refuses one), every call is a silent no-op that still validates its arguments.

import { bbcSound, renderSfx, renderSong } from "../shared/music.js";

export class Audio {
  /** @param {{context?: any}} [opts] */
  constructor(opts = {}) {
    /** @type {any} */
    this.ctx = opts.context ?? null;
    this.muted = false;
    this.volume = 0.8;
    /** @type {Map<string, any>} */
    this.cache = new Map();
    /** @type {any} */
    this.music = null;
    this.musicName = "";
    /** @type {any} */
    this.master = null;
    /** @type {any[]} per-BBC-channel current source, so a new SOUND on a channel replaces the old */
    this.channels = [null, null, null, null];
    if (this.ctx) {
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
  }

  get rate() { return this.ctx?.sampleRate ?? 22_050; }

  /** Browsers only start audio after a click or key press; the host calls this on the first one. */
  resume() { try { if (this.ctx?.state === "suspended") this.ctx.resume(); } catch { /* ignore */ } }

  /** @param {boolean} muted */
  setMuted(muted) {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : this.volume;
  }

  /** @param {number} v 0..1 */
  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && !this.muted) this.master.gain.value = this.volume;
  }

  /** @param {Float32Array} samples */
  buffer(samples) {
    const b = this.ctx.createBuffer(1, samples.length, this.rate);
    b.getChannelData(0).set(samples);
    return b;
  }

  /** @param {any} buf @param {{loop?: boolean, gain?: number}} [opts] */
  play(buf, opts = {}) {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = Boolean(opts.loop);
    const g = this.ctx.createGain();
    g.gain.value = opts.gain ?? 1;
    src.connect(g).connect(this.master);
    src.start();
    return src;
  }

  /**
   * Plays a sound effect: a preset name ("laser", "explode", "coin"...), a blip
   * {wave, hz, toHz, seconds, vol, env}, a list of blips, or {mml, tempo}.
   * @param {any} spec
   */
  sfx(spec) {
    const key = typeof spec === "string" ? spec : JSON.stringify(spec);
    let buf = this.cache.get(key);
    if (!buf) {
      const samples = renderSfx(spec, this.rate); // throws on an unknown preset, even when silent
      if (!this.ctx) return;
      buf = this.buffer(samples);
      if (this.cache.size > 200) this.cache.clear();
      this.cache.set(key, buf);
    }
    if (this.ctx && !this.muted) return this.play(buf);
  }

  /** BBC BASIC's SOUND channel, amplitude, pitch, duration. @param {number} ch @param {number} amp @param {number} pitch @param {number} dur */
  sound(ch, amp, pitch, dur) {
    const blip = bbcSound(ch, amp, pitch, dur);
    if (!this.ctx || this.muted) return;
    const c = Math.max(0, Math.min(3, ch | 0));
    try { this.channels[c]?.stop(); } catch { /* already stopped */ }
    this.channels[c] = this.sfx(blip);
  }

  /**
   * Starts a song (stopping the current one). Loops if the song says so, unless opts.loop is set.
   * @param {any} song {title, tempo, loop, channels} @param {{loop?: boolean, name?: string}} [opts]
   */
  playSong(song, opts = {}) {
    this.stopSong();
    const loop = opts.loop ?? Boolean(song?.loop);
    const { samples, seconds } = renderSong({ ...song, loop: false }, { sampleRate: this.rate });
    this.musicName = opts.name ?? song?.title ?? "";
    if (!this.ctx) return { seconds };
    const buf = this.buffer(samples);
    const src = this.play(buf, { loop, gain: 0.8 });
    if (loop) { src.loopStart = 0; src.loopEnd = seconds; }
    this.music = { src, started: this.ctx.currentTime, seconds, loop };
    src.addEventListener("ended", () => { if (this.music?.src === src) { this.music = null; this.musicName = ""; } });
    return { seconds };
  }

  stopSong() {
    try { this.music?.src.stop(); } catch { /* ignore */ }
    this.music = null;
    this.musicName = "";
  }

  /** Seconds into the current song (wrapping when it loops), or -1 when nothing is playing. */
  songPosition() {
    if (!this.music || !this.ctx) return -1;
    const t = this.ctx.currentTime - this.music.started;
    return this.music.loop ? t % this.music.seconds : Math.min(t, this.music.seconds);
  }

  stopAll() {
    this.stopSong();
    for (const s of this.channels) try { s?.stop(); } catch { /* ignore */ }
  }
}
