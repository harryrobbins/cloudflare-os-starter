// @ts-check
// A minimal DOM for running the canvas (createCanvas, ObjectLayer) in Node: enough elements,
// attributes, classes, events and tree operations for the controller to build and patch its SVG,
// plus counters. Not a browser: no layout (clientWidth/Height are settable fields), no CSS.
//
// installFakeDom() puts `document`, `window`, `requestAnimationFrame` and friends on globalThis
// and returns {flushFrames, restore, ...}; frames run only when the test flushes them.

class FakeClassList {
  /** @param {FakeElement} el */
  constructor(el) { this.el = el; }
  get #set() { return new Set(String(this.el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean)); }
  /** @param {Set<string>} s */
  #write(s) { this.el.setAttribute("class", [...s].join(" ")); }
  /** @param {...string} names */
  add(...names) { const s = this.#set; for (const n of names) s.add(n); this.#write(s); }
  /** @param {...string} names */
  remove(...names) { const s = this.#set; for (const n of names) s.delete(n); this.#write(s); }
  /** @param {string} name */
  contains(name) { return this.#set.has(name); }
  /** @param {string} name @param {boolean} [force] */
  toggle(name, force) {
    const on = force ?? !this.contains(name);
    if (on) this.add(name); else this.remove(name);
    return on;
  }
}

export class FakeElement {
  /** @param {string} tag @param {FakeDocument} doc @param {string|null} [ns] */
  constructor(tag, doc, ns = null) {
    this.tagName = tag;
    this.localName = tag;
    this.namespaceURI = ns;
    this.ownerDocument = doc;
    /** @type {Map<string, string>} */
    this.attributes = new Map();
    /** @type {FakeElement[]} */
    this.childNodes = [];
    /** @type {FakeElement|null} */
    this.parentNode = null;
    /** @type {Record<string, string>} */
    this.dataset = {};
    /** @type {Record<string, any>} */
    this.style = { setProperty() {}, removeProperty() {} };
    this.classList = new FakeClassList(this);
    this._text = "";
    this.clientWidth = 0;
    this.clientHeight = 0;
    this.tabIndex = -1;
    this.hidden = false;
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
    doc.created++;
  }

  get className() { return this.getAttribute("class") ?? ""; }
  set className(v) { this.setAttribute("class", v); }
  get children() { return this.childNodes; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling() {
    const p = this.parentNode;
    if (!p) return null;
    return p.childNodes[p.childNodes.indexOf(this) + 1] ?? null;
  }
  get isConnected() {
    /** @type {FakeElement|null} */
    let n = this;
    while (n) { if (n === this.ownerDocument.body) return true; n = n.parentNode; }
    return false;
  }
  get textContent() { return this._text + this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v) { this.#detachAll(); this._text = String(v ?? ""); }

  /** @param {string} k @param {any} v */
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  /** @param {string} k */
  getAttribute(k) { return this.attributes.has(k) ? /** @type {string} */ (this.attributes.get(k)) : null; }
  /** @param {string} k */
  hasAttribute(k) { return this.attributes.has(k); }
  /** @param {string} k */
  removeAttribute(k) { this.attributes.delete(k); }

  /** @param {FakeElement} child */
  appendChild(child) { return this.insertBefore(child, null); }
  /** @param {...any} nodes */
  append(...nodes) { for (const n of nodes) this.appendChild(this.#node(n)); }
  /** @param {...any} nodes */
  replaceChildren(...nodes) { this.#detachAll(); this._text = ""; this.append(...nodes); }
  /** @param {FakeElement} child @param {FakeElement|null} ref */
  insertBefore(child, ref) {
    if (child === ref) return child;
    child.remove();
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(child); else this.childNodes.splice(i, 0, child);
    child.parentNode = this;
    this.ownerDocument.inserts++;
    return child;
  }
  /** @param {FakeElement} child */
  removeChild(child) { child.remove(); return child; }
  remove() {
    const p = this.parentNode;
    if (!p) return;
    p.childNodes.splice(p.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
  /** @param {any} other */
  contains(other) {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  /** @param {string} _sel */
  closest(_sel) { return null; }
  /** @param {string} _sel */
  querySelector(_sel) { return null; }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  getBoundingClientRect() {
    return { left: 0, top: 0, x: 0, y: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight };
  }
  /** @param {string} type @param {Function} fn */
  addEventListener(type, fn) {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }
  /** @param {string} type @param {Function} fn */
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  /** @param {any} event */
  dispatchEvent(event) {
    for (const fn of this.listeners.get(event.type) ?? []) fn(event);
    return true;
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  setSelectionRange() {}
  select() {}

  /** Elements under this one (inclusive) matching `pred`. @param {(el: FakeElement) => boolean} pred */
  count(pred) {
    let n = pred(this) ? 1 : 0;
    for (const c of this.childNodes) n += c.count(pred);
    return n;
  }
  /** Total elements under this one, inclusive. */
  get size() { return this.count(() => true); }

  /** @param {any} n */
  #node(n) {
    if (n instanceof FakeElement) return n;
    const t = new FakeElement("#text", this.ownerDocument);
    t._text = String(n);
    return t;
  }
  #detachAll() {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
  }
}

export class FakeDocument {
  constructor() {
    this.created = 0;
    this.inserts = 0;
    this.body = new FakeElement("body", this);
    this.head = new FakeElement("head", this);
    /** @type {FakeElement} */
    this.activeElement = this.body;
    this.hidden = false;
    this.visibilityState = "visible";
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
  }
  /** @param {string} tag */
  createElement(tag) { return new FakeElement(tag, this); }
  /** @param {string} ns @param {string} tag */
  createElementNS(ns, tag) { return new FakeElement(tag, this, ns); }
  /** @param {string} text */
  createTextNode(text) { const t = new FakeElement("#text", this); t._text = String(text); return t; }
  addEventListener() {}
  removeEventListener() {}
  querySelector() { return null; }
}

/**
 * Installs the fake DOM globally. Frames queued with requestAnimationFrame run on flushFrames().
 * @returns {{document: FakeDocument, window: any, flushFrames: (max?: number) => number, restore: () => void}}
 */
export function installFakeDom() {
  const doc = new FakeDocument();
  /** @type {Map<number, Function>} */
  const frames = new Map();
  let nextFrame = 0;
  let now = 0;
  /** @type {Map<string, Set<Function>>} */
  const winListeners = new Map();
  const win = {
    document: doc,
    devicePixelRatio: 1,
    /** @param {string} type @param {Function} fn */
    addEventListener(type, fn) {
      let set = winListeners.get(type);
      if (!set) winListeners.set(type, (set = new Set()));
      set.add(fn);
    },
    /** @param {string} type @param {Function} fn */
    removeEventListener(type, fn) { winListeners.get(type)?.delete(fn); },
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  };
  const g = /** @type {any} */ (globalThis);
  const saved = {
    document: g.document, window: g.window, requestAnimationFrame: g.requestAnimationFrame,
    cancelAnimationFrame: g.cancelAnimationFrame, matchMedia: g.matchMedia,
  };
  g.document = doc;
  g.window = win;
  g.matchMedia = win.matchMedia;
  g.requestAnimationFrame = (/** @type {Function} */ fn) => { frames.set(++nextFrame, fn); return nextFrame; };
  g.cancelAnimationFrame = (/** @type {number} */ id) => { frames.delete(id); };
  return {
    document: doc,
    window: win,
    flushFrames(max = 50) {
      let ran = 0;
      while (frames.size && ran < max) {
        const batch = [...frames.values()];
        frames.clear();
        now = performance.now() + 60_000; // far enough ahead that camera animations finish in one frame
        for (const fn of batch) fn(now);
        ran++;
      }
      return ran;
    },
    restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete g[k]; else g[k] = v;
      }
    },
  };
}
