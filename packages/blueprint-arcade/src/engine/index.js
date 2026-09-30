// @ts-check
// The arcade engine: runs one game cartridge at a fixed 60 updates a second.
//
// A cartridge is an ES module (see src/README.md, "Writing a game"):
//
//   export const config = { title: "Invaders", mode: "arcade", controls: "arcade", help: ["..."] };
//   export default function game(a) {
//     let x = 100;
//     return {
//       update() { if (a.btn("left")) x--; },
//       draw(g) { g.cls(0); g.sprite(a.sprites.cannon, x, 200, { color: "green" }); },
//     };
//   }
//
// `a` is the API below; `g` is the Screen (gfx.js). The engine knows nothing about the DOM: the
// host (src/client/player.js, or a test) feeds it keys and frames and copies the screen to a canvas.

import { PALETTES, MODES, Screen, makeSprite } from "./gfx.js";
import { Input, resolveLayout } from "./input.js";
import { Audio } from "./audio.js";
import { Timers, makeRng, math, ease, hit, shape, rock, makeParticles, makeGrid, makeWell, makeBag, kicks, TETROMINOES, makeMenu } from "./helpers.js";
import { SPRITES, SHAPES } from "./assets.js";
import { TeletextPage, TT, block } from "./teletext.js";
import { WORDS, PASSAGES, question, rules, textbox, parse, cloze } from "./edu.js";
import { SFX_PRESETS } from "../shared/music.js";

export const STEP = 1 / 60;

/**
 * @typedef {{title?: string, mode?: string, width?: number, height?: number, pixelAspect?: number,
 *   palette?: string|string[], controls?: string, typing?: boolean, help?: string[], crt?: boolean}} GameConfig
 *
 * @typedef {object} Host
 * @property {Audio} [audio]
 * @property {{id: string, name: string}} [player]
 * @property {(n: number, detail?: string) => Promise<any>|void} [submitScore]
 * @property {() => {name: string, score: number}[]} [scores]
 * @property {(name: string) => any} [tune]  a saved song by title or id
 * @property {(layoutPreset: string) => Record<string, string[]>} [layout]
 * @property {(...args: any[]) => void} [log]
 */

/** Screen settings from a cartridge's config. @param {GameConfig} config */
export function screenSettings(config) {
  const mode = MODES[/** @type {keyof typeof MODES} */ (config.mode ?? "default")] ?? MODES.default;
  return {
    width: Math.max(32, Math.min(1024, Math.round(config.width ?? mode.width))),
    height: Math.max(32, Math.min(1024, Math.round(config.height ?? mode.height))),
    pixelAspect: Math.max(0.25, Math.min(4, config.pixelAspect ?? mode.pixelAspect)),
    palette: config.palette ?? mode.palette,
  };
}

/**
 * Starts a cartridge. `mod` is the imported module namespace ({config, default}).
 * @param {any} mod @param {Host} [host]
 */
export function startGame(mod, host = {}) {
  const config = /** @type {GameConfig} */ ({ ...mod?.config });
  if (typeof mod?.default !== "function") throw new Error("A game must `export default function game(a) { ... }`");
  const settings = screenSettings(config);
  const screen = new Screen(settings.width, settings.height, settings.palette);
  const input = new Input();
  input.setLayout(host.layout ? host.layout(config.controls ?? "arcade") : resolveLayout(config.controls, undefined));
  const audio = host.audio ?? new Audio();
  const timers = new Timers();
  const rng = makeRng();
  /** @type {Record<string, any>} */
  const spriteCache = {};
  let shakeFrames = 0, shakeStrength = 0;

  const state = { frame: 0, paused: false, /** @type {any} */ scene: null, /** @type {Error|null} */ crashed: null };

  const sprites = new Proxy(/** @type {Record<string, import("./gfx.js").Sprite>} */ ({}), {
    get(_, name) {
      if (typeof name !== "string") return undefined;
      if (!(name in SPRITES)) throw new Error(`No built-in sprite "${name}". Built-ins: ${Object.keys(SPRITES).join(", ")}`);
      return (spriteCache[name] ??= makeSprite(SPRITES[/** @type {keyof typeof SPRITES} */ (name)]));
    },
    ownKeys: () => Object.keys(SPRITES),
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  });

  const a = {
    config,
    get W() { return screen.W; },
    get H() { return screen.H; },
    /** Updates run so far. */
    get frame() { return state.frame; },
    /** Seconds of game time (frame / 60). */
    get t() { return state.frame * STEP; },
    get paused() { return state.paused; },
    player: host.player ?? { id: "player", name: "Player" },
    g: screen,
    screen,

    // Input
    /** @param {string} action */ btn: (action) => input.btn(action),
    /** @param {string} action @param {number} [repeat] @param {number} [delay] */ btnp: (action, repeat, delay) => input.btnp(action, repeat, delay),
    /** @param {string} action */ btnr: (action) => input.btnr(action),
    /** @param {string} code */ key: (code) => input.key(code),
    /** @param {string} code */ keyp: (code) => input.keyp(code),
    typed: () => input.typed(),
    axis: () => input.axis(),

    // Random and maths
    rnd: rng.rnd, rndi: rng.rndi, chance: rng.chance, pick: rng.pick, shuffle: rng.shuffle, seed: rng.seed,
    ...math,
    ease,
    hit,

    // Art
    /** @param {string[]|string} rows @param {Record<string, any>} [key] */
    sprite: (rows, key) => makeSprite(rows, key, screen),
    sprites,
    shapes: SHAPES,
    shape,
    /** A lumpy rock outline. @param {number} r @param {number} [points] */
    rock: (r, points) => rock(r, () => rng.rnd(), points),
    palettes: PALETTES,
    /** @param {string|string[]} p */ palette: (p) => screen.setPalette(p),

    // Time and effects
    /** @param {number} frames @param {Function} fn */ after: (frames, fn) => timers.after(frames, fn),
    /** @param {number} frames @param {Function} fn */ every: (frames, fn) => timers.every(frames, fn),
    particles: () => makeParticles(() => rng.rnd()),
    /** Shakes the screen for `frames` frames by up to `strength` pixels. @param {number} [frames] @param {number} [strength] */
    shake: (frames = 12, strength = 3) => { shakeFrames = Math.max(shakeFrames, frames); shakeStrength = strength; },
    /** Switches to another {enter?, update, draw} scene. @param {any} s */
    scene: (s) => { state.scene = s; s?.enter?.(); },
    pause: (on = !state.paused) => { state.paused = on; },

    // Sound and music
    /** @param {any} spec a preset name or a blip spec */ sfx: (spec) => audio.sfx(spec),
    sfxNames: Object.keys(SFX_PRESETS),
    /** BBC BASIC SOUND channel, amplitude, pitch, duration. @param {number} ch @param {number} amp @param {number} pitch @param {number} dur */
    sound: (ch, amp, pitch, dur) => audio.sound(ch, amp, pitch, dur),
    /** Plays a tune from the arcade's Music tab by title, or a song object. @param {string|any} song @param {{loop?: boolean}} [opts] */
    music: (song, opts) => {
      const s = typeof song === "string" ? host.tune?.(song) : song;
      if (!s) { a.log(`No tune called "${song}"`); return; }
      if (typeof song === "string" && audio.musicName === song && audio.music) return;
      audio.playSong(s, { ...opts, name: typeof song === "string" ? song : s.title });
    },
    stopMusic: () => audio.stopSong(),

    // Scores: the host attributes them to the signed-in player
    score: {
      /** @param {number} n @param {string} [detail] */
      submit: (n, detail) => host.submitScore?.(Math.round(n), detail),
      table: () => host.scores?.() ?? [],
      get best() { return host.scores?.()[0]?.score ?? 0; },
      /**
       * Draws the table centred on x. `compact` (automatic on screens under 200 pixels wide) fits
       * 160-pixel modes. @param {any} g @param {number} x @param {number} y
       * @param {{rows?: number, color?: any, highlight?: any, compact?: boolean}} [o]
       */
      draw: (g, x, y, o = {}) => {
        const rows = (host.scores?.() ?? []).slice(0, o.rows ?? 8);
        const compact = o.compact ?? screen.W < 200;
        if (!rows.length) { g.text(compact ? "NO SCORES" : "NO SCORES YET", x, y, o.color ?? screen.white, { align: "center" }); return; }
        rows.forEach((r, i) => {
          const nameWidth = compact ? 8 : 12;
          const name = String(r.name).slice(0, nameWidth).toUpperCase().padEnd(nameWidth, " ");
          const line = compact ? `${i + 1} ${name}${String(r.score).padStart(7).slice(-7)}`.slice(0, 19) : `${String(i + 1).padStart(2)} ${name} ${String(r.score).padStart(7)}`;
          g.text(line, x, y + i * 10, r.name === a.player.name ? o.highlight ?? 3 : o.color ?? screen.white, { align: "center" });
        });
      },
    },

    // Genre kits
    grid: makeGrid,
    well: makeWell,
    bag: () => makeBag(() => rng.rnd()),
    kicks,
    tetrominoes: TETROMINOES,
    menu: makeMenu,
    teletext: () => new TeletextPage(),
    tt: { ...TT, block },
    edu: {
      words: WORDS,
      passages: PASSAGES,
      /** @param {{kind?: string, level?: number, table?: number, target?: number}} [o] */
      question: (o = {}) => question(o, rng),
      rules,
      textbox,
      parse,
      cloze,
    },

    /** Prints to the editor's console. @param {...any} args */
    log: (...args) => host.log?.(...args),
  };

  const setup = mod.default(a);
  state.scene = setup && typeof setup === "object" ? setup : null;
  if (!state.scene || typeof state.scene.update !== "function" || typeof state.scene.draw !== "function") {
    throw new Error("game(a) must return { update() {...}, draw(g) {...} }");
  }
  state.scene.enter?.();

  const game = {
    a, config, screen, input, audio, settings, state,
    /** Runs one fixed update. */
    step() {
      if (state.crashed) return;
      try {
        if (!config.typing && input.btnp("pause")) state.paused = !state.paused;
        if (!state.paused) {
          state.scene.update(a);
          timers.tick();
          state.frame++;
          if (shakeFrames > 0) shakeFrames--;
        }
      } catch (e) {
        state.crashed = /** @type {Error} */ (e);
        throw e;
      } finally {
        input.endFrame();
      }
    },
    /** Draws the current scene (and the pause overlay). */
    draw() {
      if (state.crashed) return;
      screen.shakeX = shakeFrames > 0 ? Math.round((rng.rnd() * 2 - 1) * shakeStrength) : 0;
      screen.shakeY = shakeFrames > 0 ? Math.round((rng.rnd() * 2 - 1) * shakeStrength) : 0;
      screen.camera(0, 0);
      try {
        state.scene.draw(screen, a);
      } catch (e) {
        state.crashed = /** @type {Error} */ (e);
        throw e;
      }
      if (state.paused) {
        screen.shakeX = screen.shakeY = 0;
        screen.camera(0, 0);
        const w = 8 * 8 + 16;
        screen.fill(screen.W / 2 - w / 2, screen.H / 2 - 12, w, 22, 0);
        screen.rect(screen.W / 2 - w / 2, screen.H / 2 - 12, w, 22, screen.white);
        screen.text("PAUSED", screen.W / 2, screen.H / 2 - 4, screen.white, { align: "center" });
      }
    },
    /** Runs `n` frames of update and draw: for tests and screenshots. @param {number} n */
    run(n) { for (let i = 0; i < n; i++) { game.step(); game.draw(); } },
    stop() { audio.stopAll(); timers.clear(); },
  };
  return game;
}
