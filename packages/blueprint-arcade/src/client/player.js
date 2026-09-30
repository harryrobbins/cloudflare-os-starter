// @ts-check
// Runs a cartridge in the page: imports its source as a data: module (the gadget CSP allows
// script-src data:, and has no 'unsafe-eval'), starts the engine, feeds it keys and touch buttons,
// steps it at 60 Hz and paints its framebuffer onto a canvas scaled to fit.

import { startGame, STEP } from "../engine/index.js";
import { Audio } from "../engine/audio.js";
import { ACTIONS, resolveLayout } from "../engine/input.js";

/** @type {any} */
let sharedContext = null;
/** One AudioContext for the page, made on first use (browsers allow sound after a click or key). */
export function audioContext() {
  if (sharedContext) return sharedContext;
  try {
    const AC = /** @type {any} */ (globalThis).AudioContext ?? /** @type {any} */ (globalThis).webkitAudioContext;
    sharedContext = AC ? new AC() : null;
  } catch { sharedContext = null; }
  return sharedContext;
}

let importCount = 0;

/**
 * Imports cartridge source as a module. A syntax error from import() carries no position, so on
 * one the source is parsed again as an inline module script, whose error event does have the
 * line and column.
 * @param {string} source @param {string} name
 */
export async function importSource(source, name) {
  const tag = `cart-${name.replace(/[^\w-]+/g, "-").slice(0, 40)}-${++importCount}.js`;
  try {
    return await import(/* @vite-ignore */ "data:text/javascript;charset=utf-8," + encodeURIComponent(`${source}\n//# sourceURL=${tag}`));
  } catch (e) {
    if (e instanceof SyntaxError) {
      const where = await locateSyntaxError(source);
      if (where) {
        const err = new SyntaxError(`${e.message} (line ${where.line}, column ${where.column})`);
        /** @type {any} */ (err).line = where.line;
        throw err;
      }
    }
    throw e;
  }
}

/** @param {string} source @returns {Promise<{line: number, column: number}|null>} */
function locateSyntaxError(source) {
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.type = "module";
    let settled = false;
    /** @param {ErrorEvent} ev */
    const onError = (ev) => {
      if (settled || !(ev.error instanceof SyntaxError || /SyntaxError/.test(ev.message))) return;
      settled = true;
      ev.preventDefault();
      resolve({ line: ev.lineno, column: ev.colno });
    };
    addEventListener("error", onError, true);
    script.textContent = source;
    const finish = () => {
      removeEventListener("error", onError, true);
      script.remove();
      if (!settled) { settled = true; resolve(null); }
    };
    // Chrome reports the parse error while appending; others may report it a little later.
    try { document.head.append(script); } catch { /* reported through the error event */ }
    setTimeout(finish, settled ? 0 : 500);
  });
}

/** The line in the cartridge an error came from, from its stack. @param {any} err */
export function errorLine(err) {
  if (typeof err?.line === "number") return err.line;
  const m = /cart-[^\s:()]*\.js:(\d+):(\d+)/.exec(String(err?.stack ?? ""));
  return m ? Number(m[1]) : null;
}

/**
 * @typedef {object} PlayerHost
 * @property {{id: string, name: string}} player
 * @property {() => {layout: string, custom: Record<string, string[]>, muted: boolean, volume: number}} prefs
 * @property {(n: number, detail?: string) => Promise<any>} submitScore
 * @property {() => {name: string, score: number}[]} scores
 * @property {(name: string) => any} tune
 * @property {(...args: any[]) => void} [log]
 * @property {(err: any) => void} onError
 */

/**
 * Mounts a player into `el` and runs `source`. Returns a controller; stop() ends it.
 * @param {HTMLElement} el @param {string} source @param {string} name @param {PlayerHost} host
 */
export async function mountPlayer(el, source, name, host) {
  el.replaceChildren();
  el.classList.add("player");
  const mod = await importSource(source, name);
  const ctx = audioContext();
  const audio = new Audio({ context: ctx });
  const prefs = host.prefs();
  audio.setMuted(prefs.muted);
  audio.setVolume(prefs.volume);
  const game = startGame(mod, {
    audio,
    player: host.player,
    submitScore: host.submitScore,
    scores: host.scores,
    tune: host.tune,
    log: host.log,
    layout: (preset) => layoutFor(host.prefs(), preset),
  });

  const { width: W, height: H, pixelAspect } = game.settings;
  const screen = document.createElement("canvas");
  screen.width = W;
  screen.height = H;
  const view = document.createElement("canvas");
  view.className = "screen";
  view.tabIndex = 0;
  view.setAttribute("role", "img");
  view.setAttribute("aria-label", `${game.config.title ?? name}: game screen. Click, then play with the keyboard.`);
  const crt = document.createElement("div");
  crt.className = game.config.crt === false ? "crt-off" : "crt";
  const frame = document.createElement("div");
  frame.className = "screen-frame";
  frame.append(view, crt);
  el.append(frame);
  const sctx = /** @type {CanvasRenderingContext2D} */ (screen.getContext("2d"));
  const image = sctx.createImageData(W, H);
  const vctx = /** @type {CanvasRenderingContext2D} */ (view.getContext("2d"));

  // Fill the frame: whole-number scales from 3x up keep every pixel the same size; below that a
  // fractional scale in quarter steps wastes less of the screen.
  const fit = () => {
    const box = el.getBoundingClientRect();
    const logicalW = W * pixelAspect;
    let scale = Math.min((box.width - 8) / logicalW, (box.height - 8) / H);
    scale = scale >= 3 ? Math.floor(scale) : Math.floor(scale * 4) / 4;
    scale = Math.max(0.5, scale || 1);
    const dpr = globalThis.devicePixelRatio || 1;
    view.style.width = `${Math.round(logicalW * scale)}px`;
    view.style.height = `${Math.round(H * scale)}px`;
    view.width = Math.round(logicalW * scale * dpr);
    view.height = Math.round(H * scale * dpr);
    frame.style.width = view.style.width;
    frame.style.height = view.style.height;
  };
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(fit) : null;
  ro?.observe(el);
  fit();

  const isTyping = (/** @type {EventTarget|null} */ t) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
  const bound = () => new Set(Object.values(game.input.layout).flat());
  /** @param {KeyboardEvent} e */
  const onDown = (e) => {
    if (isTyping(e.target) || e.key === "Escape" || e.ctrlKey || e.metaKey || e.altKey) return;
    audio.resume();
    game.input.keydown(e.code, e.key);
    if (bound().has(e.code) || e.code.startsWith("Arrow") || e.code === "Space" || game.config.typing) e.preventDefault();
  };
  /** @param {KeyboardEvent} e */
  const onUp = (e) => { game.input.keyup(e.code); };
  const onBlur = () => game.input.releaseAll();
  addEventListener("keydown", onDown);
  addEventListener("keyup", onUp);
  addEventListener("blur", onBlur);
  view.addEventListener("pointerdown", () => { view.focus(); audio.resume(); });

  // On-screen buttons for touch screens.
  const touch = document.createElement("div");
  touch.className = "touch";
  const pad = document.createElement("div");
  pad.className = "touch-pad";
  const buttons = document.createElement("div");
  buttons.className = "touch-buttons";
  const labels = /** @type {Record<string, string>} */ ({ up: "▲", left: "◀", right: "▶", down: "▼", fire: "A", alt: "B", start: "Start" });
  for (const action of ["up", "left", "right", "down", "fire", "alt", "start"]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `touch-${action}`;
    b.textContent = labels[action];
    b.setAttribute("aria-label", action);
    const on = (/** @type {PointerEvent} */ e) => { e.preventDefault(); audio.resume(); game.input.setTouch(action, true); };
    const off = (/** @type {PointerEvent} */ e) => { e.preventDefault(); game.input.setTouch(action, false); };
    b.addEventListener("pointerdown", on);
    b.addEventListener("pointerup", off);
    b.addEventListener("pointercancel", off);
    b.addEventListener("pointerleave", off);
    (["fire", "alt", "start"].includes(action) ? buttons : pad).append(b);
  }
  touch.append(pad, buttons);
  el.append(touch);

  let running = true;
  let last = performance.now();
  let acc = 0;
  let raf = 0;
  let steps = 0;
  const paint = () => {
    game.screen.toRgba(image.data, game.state.frame * STEP);
    sctx.putImageData(image, 0, 0);
    vctx.imageSmoothingEnabled = false;
    vctx.drawImage(screen, 0, 0, view.width, view.height);
  };
  const tick = (/** @type {number} */ now) => {
    if (!running) return;
    acc = Math.min(acc + (now - last) / 1000, STEP * 5);
    last = now;
    try {
      let stepped = false;
      while (acc >= STEP) { game.step(); acc -= STEP; stepped = true; steps++; }
      if (stepped) { game.draw(); paint(); }
    } catch (err) {
      running = false;
      audio.stopAll();
      host.onError(err);
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  try { game.draw(); paint(); } catch (err) { running = false; host.onError(err); }
  if (running) raf = requestAnimationFrame(tick);
  view.focus({ preventScroll: true });

  return {
    game,
    audio,
    canvas: view,
    get steps() { return steps; },
    get running() { return running; },
    /** Re-reads layout and sound preferences. */
    applyPrefs() {
      const p = host.prefs();
      audio.setMuted(p.muted);
      audio.setVolume(p.volume);
      game.input.setLayout(layoutFor(p, game.config.controls ?? "arcade"));
    },
    focus() { view.focus({ preventScroll: true }); },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      removeEventListener("keydown", onDown);
      removeEventListener("keyup", onUp);
      removeEventListener("blur", onBlur);
      ro?.disconnect();
      game.stop();
    },
  };
}

/**
 * The key layout for a player: their chosen preset ("auto" follows the game's own), then any
 * per-action keys they set.
 * @param {{layout: string, custom: Record<string, string[]>}} prefs @param {string} gamePreset
 */
export function layoutFor(prefs, gamePreset) {
  return resolveLayout(!prefs.layout || prefs.layout === "auto" ? gamePreset : prefs.layout, prefs.custom);
}

export { ACTIONS };
