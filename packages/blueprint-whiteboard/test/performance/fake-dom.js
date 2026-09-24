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
    /** data-* attributes, as in the DOM. @type {Record<string, string>} */
    this.dataset = new Proxy({}, {
      get: (_t, k) => (typeof k === "string" ? this.getAttribute(dataAttr(k)) ?? undefined : undefined),
      set: (_t, k, v) => { this.setAttribute(dataAttr(String(k)), v); return true; },
      deleteProperty: (_t, k) => { this.removeAttribute(dataAttr(String(k))); return true; },
      has: (_t, k) => typeof k === "string" && this.hasAttribute(dataAttr(k)),
      ownKeys: () => [...this.attributes.keys()].filter((a) => a.startsWith("data-")).map(camel),
      getOwnPropertyDescriptor: (_t, k) => (typeof k === "string" && this.hasAttribute(dataAttr(k))
        ? { enumerable: true, configurable: true, value: this.getAttribute(dataAttr(k)) } : undefined),
    });
    this.scrollTop = 0;
    this.offsetHeight = 0;
    /** @type {Record<string, any>} */
    this.style = { setProperty() {}, removeProperty() {} };
    this.classList = new FakeClassList(this);
    this._text = "";
    this.clientWidth = 0;
    this.clientHeight = 0;
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
    this.#blurIfInside();
  }
  /** A removed subtree loses focus to <body>, as in the DOM. */
  #blurIfInside() {
    const doc = this.ownerDocument;
    if (doc.activeElement !== doc.body && this.contains(doc.activeElement)) doc.activeElement = doc.body;
  }
  /** @param {any} other */
  contains(other) {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  get disabled() { return this.hasAttribute("disabled"); }
  set disabled(v) { if (v) this.setAttribute("disabled", ""); else this.removeAttribute("disabled"); }
  get tabIndex() { const v = this.getAttribute("tabindex"); return v === null ? -1 : Number(v); }
  set tabIndex(v) { this.setAttribute("tabindex", String(v)); }
  /** Simple selectors only: tag, .class, [attr], [attr="v"], compounds, and descendant chains. @param {string} sel */
  matches(sel) {
    const parts = sel.trim().split(/\s+/);
    if (!matchCompound(this, /** @type {string} */ (parts.pop()))) return false;
    /** @type {FakeElement|null} */
    let n = this.parentNode;
    while (parts.length && n) {
      if (matchCompound(n, parts[parts.length - 1])) parts.pop();
      n = n.parentNode;
    }
    return parts.length === 0;
  }
  /** @param {string} sel @returns {FakeElement|null} */
  closest(sel) {
    for (/** @type {FakeElement|null} */ let n = this; n; n = n.parentNode) if (n.tagName !== "#text" && n.matches(sel)) return n;
    return null;
  }
  /** @param {string} sel @returns {FakeElement[]} */
  querySelectorAll(sel) {
    /** @type {FakeElement[]} */
    const out = [];
    const walk = (/** @type {FakeElement} */ n) => {
      for (const c of n.childNodes) {
        if (c.tagName !== "#text" && c.matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  /** @param {string} sel */
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  focus() {
    if (!this.isConnected || this.disabled) return;
    const doc = this.ownerDocument;
    if (doc.activeElement === this) return;
    doc.activeElement = this;
    // focusin bubbles.
    const event = { type: "focusin", target: this };
    for (/** @type {FakeElement|null} */ let n = this; n; n = n.parentNode) {
      for (const fn of n.listeners.get("focusin") ?? []) fn(event);
    }
  }
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
    const doc = this.ownerDocument;
    const lost = doc.activeElement !== doc.body && this.childNodes.some((c) => c.contains(doc.activeElement));
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (lost) doc.activeElement = doc.body;
  }
}

/** @param {string} k camelCase dataset key */
function dataAttr(k) {
  return "data-" + k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
}
/** @param {string} a data-* attribute */
function camel(a) {
  return a.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
}
/** @param {FakeElement} el @param {string} compound */
function matchCompound(el, compound) {
  const re = /([.#]?[\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
  let m;
  while ((m = re.exec(compound))) {
    if (m[1]) {
      const t = m[1];
      if (t[0] === ".") { if (!el.classList.contains(t.slice(1))) return false; }
      else if (t[0] === "#") { if (el.getAttribute("id") !== t.slice(1)) return false; }
      else if (el.tagName.toLowerCase() !== t.toLowerCase()) return false;
    } else if (m[3] !== undefined ? el.getAttribute(m[2]) !== m[3] : !el.hasAttribute(m[2])) return false;
  }
  return true;
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
  /** @param {string} sel */
  querySelector(sel) { return this.body.querySelector(sel); }
  /** @param {string} sel */
  querySelectorAll(sel) { return this.body.querySelectorAll(sel); }
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
    cancelAnimationFrame: g.cancelAnimationFrame, matchMedia: g.matchMedia, Node: g.Node,
  };
  g.Node = FakeElement;
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
