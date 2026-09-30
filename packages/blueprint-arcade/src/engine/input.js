// @ts-check
// Keyboard (and on-screen touch button) input, mapped to named actions.
//
// Games read actions (left right up down fire alt start pause) rather than keys, so a player can
// pick a layout: "arcade" (arrows, Space, X), "bbc" (the Acornsoft Z X : / Return layout), "wasd",
// or their own. Raw keys are there too (a.key("KeyQ")), and typed characters for quiz and
// adventure games (a.typed()). Escape is never bound: the platform uses it to leave full screen.

export const ACTIONS = ["left", "right", "up", "down", "fire", "alt", "start", "pause"];

/** Key layouts: action -> KeyboardEvent.code list. */
export const LAYOUTS = {
  arcade: {
    left: ["ArrowLeft"], right: ["ArrowRight"], up: ["ArrowUp"], down: ["ArrowDown"],
    fire: ["Space", "KeyZ"], alt: ["KeyX", "ShiftLeft"], start: ["Enter"], pause: ["KeyP"],
  },
  bbc: {
    left: ["KeyZ"], right: ["KeyX"], up: ["Semicolon", "Quote"], down: ["Slash"],
    fire: ["Enter", "Space"], alt: ["ShiftLeft", "ShiftRight"], start: ["Space", "Enter"], pause: ["KeyP"],
  },
  wasd: {
    left: ["KeyA"], right: ["KeyD"], up: ["KeyW"], down: ["KeyS"],
    fire: ["KeyJ", "Space"], alt: ["KeyK"], start: ["Enter"], pause: ["KeyP"],
  },
  // Both hands' worth, for games that only need a few actions.
  both: {
    left: ["ArrowLeft", "KeyA", "KeyZ"], right: ["ArrowRight", "KeyD", "KeyX"], up: ["ArrowUp", "KeyW"], down: ["ArrowDown", "KeyS"],
    fire: ["Space", "KeyJ"], alt: ["ShiftLeft", "KeyK"], start: ["Enter"], pause: ["KeyP"],
  },
};

/** Human names for key codes, for help panels. @param {string} code */
export function keyName(code) {
  const names = /** @type {Record<string, string>} */ ({
    ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Space: "Space", Enter: "Return",
    ShiftLeft: "Shift", ShiftRight: "Shift", Semicolon: ";", Quote: "'", Slash: "/", Backspace: "Delete",
    ControlLeft: "Ctrl", ControlRight: "Ctrl", Tab: "Tab", Comma: ",", Period: ".",
  });
  if (names[code]) return names[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

/**
 * @param {string|undefined} preset @param {Record<string, string[]>|undefined} custom
 * @returns {Record<string, string[]>}
 */
export function resolveLayout(preset, custom) {
  const base = LAYOUTS[/** @type {keyof typeof LAYOUTS} */ (preset ?? "arcade")] ?? LAYOUTS.arcade;
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const a of ACTIONS) {
    const own = custom?.[a];
    out[a] = Array.isArray(own) && own.length ? own.filter((k) => typeof k === "string" && k !== "Escape").slice(0, 4) : [...base[/** @type {keyof typeof base} */ (a)]];
  }
  return out;
}

export class Input {
  constructor() {
    /** @type {Set<string>} keys held now */
    this.down = new Set();
    /** @type {Set<string>} keys pressed since the last frame */
    this.pressed = new Set();
    /** @type {Set<string>} keys released since the last frame */
    this.released = new Set();
    /** @type {Set<string>} actions held by touch buttons */
    this.touch = new Set();
    this.touchPressed = new Set();
    this.touchReleased = new Set();
    /** @type {string[]} characters typed since the last frame; "\b" is Backspace, "\n" is Return */
    this.chars = [];
    this.layout = resolveLayout("arcade", undefined);
    /** @type {Map<string, number>} action -> frames held, for key repeat */
    this.held = new Map();
    /** @type {Map<string, number>} frames since pressed, for pressedFrames */
    this.age = new Map();
  }

  /** @param {Record<string, string[]>} layout */
  setLayout(layout) { this.layout = layout; }

  /** @param {string} code @param {string} [key] */
  keydown(code, key) {
    if (!this.down.has(code)) this.pressed.add(code);
    this.down.add(code);
    if (typeof key === "string") {
      if (key.length === 1) this.chars.push(key);
      else if (key === "Backspace") this.chars.push("\b");
      else if (key === "Enter") this.chars.push("\n");
    }
  }

  /** @param {string} code */
  keyup(code) {
    if (this.down.delete(code)) this.released.add(code);
  }

  /** @param {string} action @param {boolean} on */
  setTouch(action, on) {
    if (on && !this.touch.has(action)) this.touchPressed.add(action);
    if (!on && this.touch.has(action)) this.touchReleased.add(action);
    if (on) this.touch.add(action); else this.touch.delete(action);
  }

  releaseAll() {
    for (const k of this.down) this.released.add(k);
    this.down.clear();
    this.touch.clear();
  }

  /** Is the action held? @param {string} action */
  btn(action) {
    if (this.touch.has(action)) return true;
    return (this.layout[action] ?? []).some((k) => this.down.has(k));
  }

  /**
   * Was the action pressed this frame? With `repeat` (frames), also true every `repeat` frames
   * while held after an initial `delay` (frames): the auto-shift of a falling-block game.
   * @param {string} action @param {number} [repeat] @param {number} [delay]
   */
  btnp(action, repeat, delay) {
    const fresh = this.touchPressed.has(action) || (this.layout[action] ?? []).some((k) => this.pressed.has(k));
    if (fresh || !repeat) return fresh;
    const held = this.held.get(action) ?? 0;
    const d = delay ?? repeat * 3;
    return held > d && (held - d) % Math.max(1, repeat) === 0;
  }

  /** Was the action released this frame? @param {string} action */
  btnr(action) { return this.touchReleased.has(action) || (this.layout[action] ?? []).some((k) => this.released.has(k)); }

  /** Raw key by KeyboardEvent.code, e.g. "KeyQ", "Digit1", "Space". @param {string} code */
  key(code) { return this.down.has(code); }
  /** @param {string} code */
  keyp(code) { return this.pressed.has(code); }

  /** Characters typed this frame, oldest first. */
  typed() { return this.chars.slice(); }

  /** Horizontal and vertical direction from the four direction actions, each -1, 0 or 1. */
  axis() {
    return { x: (this.btn("right") ? 1 : 0) - (this.btn("left") ? 1 : 0), y: (this.btn("down") ? 1 : 0) - (this.btn("up") ? 1 : 0) };
  }

  /** Called by the engine after each update. */
  endFrame() {
    for (const a of Object.keys(this.layout)) {
      if (this.btn(a)) this.held.set(a, (this.held.get(a) ?? 0) + 1); else this.held.delete(a);
    }
    this.pressed.clear();
    this.released.clear();
    this.touchPressed.clear();
    this.touchReleased.clear();
    this.chars.length = 0;
  }
}
