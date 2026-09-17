// @ts-check
// Multi-user harness for the whiteboard: one in-page fake server (real src/core over an InMemoryRepository) and
// several same-origin iframes, each running the real dist/client.js with its own `gadget` proxy.
//
// Transport model (per pane, in each direction): calls are delivered in order after `latency`
// ms; arguments and results are structured-cloned (so nothing aliases across "the wire");
// RpcTarget instances are passed by reference, wrapped in a stub with dup()/onRpcBroken().
// A killed pane's stubs reject, like a broken RPC connection. A "stale stub" restart makes every
// `gadget` stub handed out so far reject forever, as the real platform does for the iframe after
// a facet restart; only a reload of the pane (which asks for a new stub) recovers.

import { InMemoryRepository } from "../src/core/repository.js";
import { FakeGadget, RPC_METHODS } from "./fake-server.js";
import { newId, COLORS } from "../src/shared/protocol.js";

const params = new URLSearchParams(location.search);

const state = {
  repo: new InMemoryRepository(),
  /** @type {FakeGadget} */
  server: /** @type {any} */ (null),
  generation: 0,
  latency: Number(params.get("latency") || 0),
  /** calls arriving before this time fail, as during a facet restart */
  downUntil: 0,
  restartDowntimeMs: Number(params.get("downtime") || 250),
  /** @type {Map<string, Pane>} */
  panes: new Map(),
  nextPane: 0,
  log: /** @type {string[]} */ ([]),
  calls: 0,
  staleRejections: 0,
  /** @type {{pane: string, at: number, fields: string[]}[]} updatePresence calls, newest last */
  presenceLog: [],
};
const PRESENCE_LOG_MAX = 5000;

function startServer() {
  state.generation++;
  state.server = new FakeGadget(state.repo);
}
startServer();

class ResetError extends Error {
  constructor() { super("Durable Object reset because its code was updated."); }
}

/**
 * Ordered, latency-delayed delivery lane.
 */
class Lane {
  constructor() { this.lastAt = 0; }
  /**
   * @template T
   * @param {() => T|Promise<T>} fn
   * @returns {Promise<T>}
   */
  run(fn) {
    const now = performance.now();
    const at = Math.max(now + state.latency, this.lastAt);
    this.lastAt = at;
    return new Promise((resolve, reject) => {
      const go = () => { try { Promise.resolve(fn()).then(resolve, reject); } catch (e) { reject(e); } };
      if (at - now <= 0) queueMicrotask(go);
      else setTimeout(go, at - now);
    });
  }
}

class Pane {
  /**
   * @param {string} id
   * @param {{exportFormat?: string|null, width?: string}} opts
   */
  constructor(id, opts) {
    this.id = id;
    this.exportFormat = opts.exportFormat ?? null;
    /** what the platform injects as `gadgetViewer`: the signed-in account, never typed in */
    this.viewer = { id: `user-${id.toLowerCase()}`, displayName: opts.name ?? `User ${id}`, role: "build" };
    this.dead = false;
    this.up = new Lane();
    this.down = new Lane();
    /** @type {Set<any>} RpcTargets this pane passed to the server */
    this.targets = new Set();
    /** @type {Set<() => void>} */
    this.brokenHandlers = new Set();
    /** @type {Window|null} */
    this.win = null;
    /** @type {any} the pane realm's RpcTarget class */
    this.RpcTarget = null;
    /** incremented per connect(); stubs with an epoch below `staleBelow` reject forever */
    this.stubEpoch = 0;
    this.staleBelow = 0;
    this.frame = /** @type {HTMLIFrameElement} */ (document.createElement("iframe"));
    // The platform's sandbox minus popups, plus allow-same-origin so this page can reach in.
    // No allow-forms: native form submission is blocked, as on the platform.
    this.frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    this.frame.title = `Pane ${id}`;
    this.frame.dataset.pane = id;
    const q = new URLSearchParams({ pane: id });
    if (this.exportFormat) q.set("export", this.exportFormat);
    this.frame.src = "pane.html?" + q;
    this.wrap = document.createElement("div");
    this.wrap.className = "pane";
    this.wrap.dataset.pane = id;
    const bar = document.createElement("div");
    bar.className = "pane-bar";
    const label = document.createElement("strong");
    label.textContent = `Pane ${id}${this.exportFormat ? ` (export: ${this.exportFormat})` : ""}`;
    const kill = document.createElement("button");
    kill.textContent = "Kill pane";
    kill.title = "Remove the iframe without leaving presence (simulates a crashed tab)";
    kill.dataset.kill = id;
    kill.onclick = () => killPane(id);
    const reload = document.createElement("button");
    reload.textContent = "Reload";
    reload.onclick = () => reloadPane(id);
    bar.append(label, reload, kill);
    this.wrap.append(bar, this.frame);
  }

  /**
   * Clone into the pane's realm so results look native to its code.
   * @param {any} value
   */
  toPane(value) {
    if (value === undefined) return undefined;
    return this.win ? /** @type {any} */ (this.win).structuredClone(value) : structuredClone(value);
  }

  /**
   * Builds the `gadget` global for a pane window.
   * @param {Window} win
   * @param {any} RpcTarget  the pane realm's RpcTarget class
   */
  connect(win, RpcTarget) {
    this.win = win;
    this.RpcTarget = RpcTarget;
    const pane = this;
    const epoch = ++this.stubEpoch;
    return new Proxy({}, {
      get(_, name) {
        if (typeof name !== "string" || name === "then" || !RPC_METHODS.has(name)) return undefined;
        return (/** @type {any[]} */ ...args) => pane.call(name, args, epoch);
      },
    });
  }

  /**
   * @param {string} method
   * @param {any[]} args
   * @param {number} epoch  which connect() handed out the stub making this call
   */
  call(method, args, epoch) {
    const win = /** @type {any} */ (this.win);
    if (this.dead) return new win.Promise(() => {}); // a dead tab's calls go nowhere
    if (epoch < this.staleBelow) {
      state.staleRejections++;
      return win.Promise.reject(new win.Error("RPC session was shut down by disposing the main stub"));
    }
    state.calls++;
    if (method === "updatePresence") {
      state.presenceLog.push({ pane: this.id, at: performance.now(), fields: Object.keys(args[0] ?? {}) });
      if (state.presenceLog.length > PRESENCE_LOG_MAX) state.presenceLog.splice(0, state.presenceLog.length - PRESENCE_LOG_MAX);
    }
    let wireArgs;
    try {
      wireArgs = args.map((a) => this.marshal(a));
    } catch (e) {
      return win.Promise.reject(new win.Error("DataCloneError: " + /** @type {any} */ (e).message));
    }
    const gen = state.generation;
    const result = this.up.run(async () => {
      if (this.dead) return new Promise(() => {});
      if (gen !== state.generation || performance.now() < state.downUntil) throw new ResetError();
      const server = /** @type {any} */ (state.server);
      return server[method](...wireArgs);
    });
    return new win.Promise((/** @type {any} */ resolve, /** @type {any} */ reject) => {
      result.then(
        (value) => { if (!this.dead) resolve(this.toPane(value)); },
        (err) => { if (!this.dead) reject(new win.Error(err?.message ?? String(err))); },
      );
    });
  }

  /** @param {any} arg */
  marshal(arg) {
    const win = /** @type {any} */ (this.win);
    if (arg && typeof arg === "object" && this.RpcTarget && arg instanceof this.RpcTarget) {
      return this.stubFor(arg);
    }
    return arg === undefined ? undefined : structuredClone(arg);
  }

  /** @param {any} target */
  stubFor(target) {
    this.targets.add(target);
    const pane = this;
    const gen = state.generation;
    /** @param {"operation"|"presence"} method @param {any} event */
    const deliver = (method, event) => {
      if (pane.dead) return Promise.reject(new Error("RPC connection broken"));
      const copy = structuredClone(event);
      return pane.down.run(() => {
        if (pane.dead) throw new Error("RPC connection broken");
        if (gen !== state.generation) throw new ResetError();
        return target[method](pane.toPane(copy));
      });
    };
    const stub = {
      operation: (/** @type {any} */ e) => deliver("operation", e),
      presence: (/** @type {any} */ e) => deliver("presence", e),
      dup: () => stub,
      onRpcBroken: (/** @type {() => void} */ fn) => { pane.brokenHandlers.add(fn); },
    };
    return stub;
  }

  kill() {
    // onRpcBroken handlers are deliberately not fired: local workerd doesn't either, so the hub
    // must notice through a failed delivery and clients through stale presence.
    this.dead = true;
    this.wrap.remove();
  }
}

const panesEl = /** @type {HTMLElement} */ (document.getElementById("panes"));

/**
 * @param {{exportFormat?: string|null, name?: string}} [opts]  name: the pane's account display name
 */
function addPane(opts = {}) {
  const id = String.fromCharCode(65 + state.nextPane++);
  const pane = new Pane(id, opts);
  state.panes.set(id, pane);
  panesEl.appendChild(pane.wrap);
  log(`pane ${id} added${opts.exportFormat ? " (export)" : ""}`);
  return id;
}

/** @param {string} id */
function killPane(id) {
  const pane = state.panes.get(id);
  if (!pane) return;
  pane.kill();
  state.panes.delete(id);
  log(`pane ${id} killed (no leave)`);
}

/** @param {string} id */
function reloadPane(id) {
  const pane = state.panes.get(id);
  if (!pane) return;
  pane.targets.clear();
  pane.brokenHandlers.clear();
  pane.frame.src = pane.frame.src;
}

/**
 * Simulates a facet restart: a new core instance over the same repository and a new, empty hub.
 * With `staleStub`, every pane's current `gadget` stub also rejects forever (the real platform's
 * behaviour after a code edit); a pane only recovers by reloading itself.
 * @param {{dispose?: boolean, staleStub?: boolean}} [opts]
 */
function restart({ dispose = false, staleStub = false } = {}) {
  state.downUntil = performance.now() + state.restartDowntimeMs;
  startServer();
  if (staleStub) {
    for (const pane of state.panes.values()) {
      pane.staleBelow = pane.stubEpoch + 1;
      pane.targets.clear();
    }
    log("server restarted (stale stubs: panes must reload)");
    return;
  }
  let disposed = 0;
  if (dispose) {
    for (const pane of state.panes.values()) {
      if (pane.dead) continue;
      for (const target of pane.targets) {
        try { target[Symbol.dispose]?.(); disposed++; } catch (e) { console.error(e); }
      }
      pane.targets.clear();
    }
  }
  log(`server restarted${dispose ? ` (disposed ${disposed} callbacks)` : " (no dispose)"}`);
}

/** @param {number} ms */
function setLatency(ms) {
  state.latency = Math.max(0, Math.min(5000, Number(ms) || 0));
  const slider = /** @type {HTMLInputElement} */ (document.getElementById("latency"));
  slider.value = String(state.latency);
  /** @type {HTMLElement} */ (document.getElementById("latency-value")).textContent = `${state.latency} ms`;
}

/** @param {string} line */
function log(line) {
  const entry = `${new Date().toLocaleTimeString()} ${line}`;
  state.log.push(entry);
  const el = document.getElementById("log");
  if (el) el.textContent = entry;
}

// ---- controls
const slider = /** @type {HTMLInputElement} */ (document.getElementById("latency"));
slider.addEventListener("input", () => setLatency(Number(slider.value)));
setLatency(state.latency);
/** @type {HTMLElement} */ (document.getElementById("restart")).onclick = () => restart({ dispose: false });
/** @type {HTMLElement} */ (document.getElementById("restart-dispose")).onclick = () => restart({ dispose: true });
/** @type {HTMLElement} */ (document.getElementById("restart-stale")).onclick = () => restart({ staleStub: true });
/** @type {HTMLElement} */ (document.getElementById("add-pane")).onclick = () => addPane();
/** @type {HTMLElement} */ (document.getElementById("add-export")).onclick = () => addPane({ exportFormat: "html" });

// ---- API for panes and Playwright
/** @type {any} */ (window).harness = {
  /** @param {string} paneId @param {Window} win @param {any} RpcTarget */
  connect(paneId, win, RpcTarget) {
    const pane = state.panes.get(paneId);
    if (!pane) throw new Error("unknown pane " + paneId);
    // Fetched fresh per pane load, so a rebuild is picked up by "Reload".
    const clientSource = fetch("../dist/client.js", { cache: "no-store" }).then((r) => {
      if (!r.ok) throw new Error("dist/client.js missing: run node scripts/build.mjs");
      return r.text();
    });
    return { gadget: pane.connect(win, RpcTarget), viewer: pane.viewer, exportFormat: pane.exportFormat, clientSource };
  },
  getBoard: () => state.server.getBoard(),
  getHistory: (/** @type {number} */ n) => state.server.getHistory(n),
  subscribers: () => state.server.hub.list(),
  apply: (/** @type {any} */ req) => state.server.applyOperation(req),
  /** Calls any RPC method directly, as a "third user" (e.g. the chat agent). */
  rpc: (/** @type {string} */ method, /** @type {any[]} */ ...args) => /** @type {any} */ (state.server)[method](...args),
  restart,
  setLatency,
  addPane,
  killPane,
  reloadPane,
  panes: () => [...state.panes.values()].filter((p) => !p.exportFormat).map((p) => p.id),
  paneInfo: () => [...state.panes.values()].map((p) => ({ id: p.id, exportFormat: p.exportFormat })),
  get latency() { return state.latency; },
  get generation() { return state.generation; },
  get calls() { return state.calls; },
  get staleRejections() { return state.staleRejections; },
  /** @param {string} id how many times the pane has loaded (asked for a stub) */
  paneLoads: (id) => state.panes.get(id)?.stubEpoch ?? 0,
  get log() { return [...state.log]; },
  /** updatePresence calls so far, optionally only one pane's: [{pane, at, fields}] */
  presenceLog: (/** @type {string|undefined} */ paneId) => state.presenceLog.filter((e) => !paneId || e.pane === paneId),
  clearPresenceLog: () => { state.presenceLog.length = 0; },
  seed,
  repo: state.repo,
};

/**
 * Creates `n` objects through the real core (as the chat agent would): a grid of sticky notes and
 * shapes, and a connector between every tenth pair. Returns the created ids.
 * @param {number} n
 */
async function seed(n) {
  const count = Math.max(0, Math.min(5000, Math.floor(Number(n) || 0)));
  const palette = Object.values(COLORS);
  /** @type {any[]} */
  const ops = [];
  /** @type {string[]} */
  const ids = [];
  const columns = Math.ceil(Math.sqrt(count));
  let made = 0;
  let prev = /** @type {string|null} */ (null);
  for (let i = 0; made < count; i++) {
    const id = newId("object");
    const col = i % columns, row = Math.floor(i / columns);
    const type = i % 5 === 3 ? "rect" : i % 5 === 4 ? "ellipse" : "sticky";
    ops.push({ op: "create", object: {
      id, type, x: col * 260, y: row * 260, text: `${type} ${i + 1}`,
      style: type === "sticky" ? { fill: palette[i % 8] } : undefined,
    } });
    ids.push(id);
    made++;
    if (prev && i % 10 === 9 && made < count) {
      const cid = newId("object");
      ops.push({ op: "create", object: { id: cid, type: "connector", from: prev, to: id } });
      ids.push(cid);
      made++;
    }
    prev = id;
  }
  for (let i = 0; i < ops.length; i += 500) {
    const result = await state.server.applyOperation({ by: "Seed", senderId: "harness-seed", objectOps: ops.slice(i, i + 500) });
    if (result?.errors?.length) console.warn("seed errors", result.errors.slice(0, 3));
  }
  log(`seeded ${ids.length} objects`);
  return ids;
}

if (params.get("seed")) await seed(Number(params.get("seed")));

const paneCount = Math.max(1, Math.min(4, Number(params.get("panes") || 2)));
// ?names=Alice,Bob sets the panes' account names (default "User A", "User B", ...).
const paneNames = (params.get("names") ?? "").split(",").map((n) => n.trim());
for (let i = 0; i < paneCount; i++) addPane({ name: paneNames[i] || undefined });
if (params.get("export")) addPane({ exportFormat: params.get("export") });
/** @type {any} */ (window).harness.ready = true;
