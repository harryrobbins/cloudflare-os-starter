// @ts-check
// Multi-user harness for the Wave: one in-page fake server (real src/core over an
// InMemoryRepository, with a fake Model binding) and several same-origin iframes, each running
// the real dist/client.js with its own `gadget` proxy.
//
// Transport model (per pane, in each direction): calls are delivered in order after `latency`
// ms; arguments and results are structured-cloned (so nothing aliases across "the wire"). Binary
// is base64 on the Wave's wire (src/shared/protocol.js), so every Yjs update, state vector and
// relative position is a plain string here and needs nothing special. RpcTarget instances are
// passed by reference, wrapped in a stub with dup()/onRpcBroken(). A killed pane's stubs reject,
// like a broken RPC connection. A "stale stub" restart makes every `gadget` stub handed out so far
// reject forever, as the real platform does for the iframe after a facet restart; only a reload of
// the pane (which asks for a new stub) recovers.
//
// Restart semantics: a restart builds a new FakeGadget (new core, new empty hub, same repository)
// and FENCES the old instance's repository: any storage call it still makes (for example the
// commit of a model reply that was in flight) rejects with the Durable Object reset error, as an
// aborted facet's storage would. That is what lets "Restart mid-run" leave a run `unknown`.

import * as Y from "yjs";
import { InMemoryRepository } from "../src/core/repository.js";
import { FakeGadget, RPC_METHODS } from "./fake-server.js";
import { createFakeModel } from "./fake-model.js";
import { LIMITS, decodeBytes, newId } from "../src/shared/protocol.js";

const params = new URLSearchParams(location.search);

/** @typedef {import("./fake-model.js").FakeModelOptions["mode"] | "none"} ModelMode */

const MODEL_MODES = /** @type {const} */ (["ok", "slow", "fail", "garbage", "hang", "none"]);

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
  /** @type {CallRecord[]} every RPC call a pane made, oldest first */
  callLog: [],
  /** The one fake model, kept across restarts and across "none" so its `calls` survive. */
  model: createFakeModel({ mode: "ok" }),
  /** false: the server sees no model (capabilities.model is false on the next subscribe) */
  modelOn: true,
};
const PRESENCE_LOG_MAX = 5000;
const CALL_LOG_MAX = 50_000;

/**
 * @typedef {object} CallRecord
 * @property {string} method
 * @property {string} pane
 * @property {number} bytes     JSON size of the marshalled arguments (a stub counts as {})
 * @property {number} at        performance.now() when the pane called
 * @property {number} wall      Date.now() when the pane called
 * @property {number|null} doneAt  performance.now() when the result was handed back (null: pending)
 * @property {boolean|null} ok  true resolved, false rejected, null pending
 * @property {string} [blipId]  for pushText / openBlip / getPlayback
 */

class ResetError extends Error {
  constructor() { super("Durable Object reset because its code was updated."); }
}

/**
 * A view of the repository that stops working once the server generation moves on, like the
 * storage of an aborted Durable Object.
 * @template {object} T
 * @param {T} repo
 * @param {number} gen
 * @returns {T}
 */
function fencedRepo(repo, gen) {
  return new Proxy(repo, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      return (/** @type {any[]} */ ...args) => {
        if (gen !== state.generation) throw new ResetError();
        return value.apply(target, args);
      };
    },
  });
}

function startServer() {
  state.generation++;
  state.server = new FakeGadget(fencedRepo(state.repo, state.generation), {
    model: state.modelOn ? state.model : null,
  });
}
startServer();

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

/** @param {any[]} args */
function wireBytes(args) {
  try { return JSON.stringify(args).length; } catch { return -1; }
}

class Pane {
  /**
   * @param {string} id
   * @param {{exportFormat?: string|null, width?: string, name?: string}} opts
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
    /** @type {CallRecord} */
    const record = {
      method, pane: this.id, bytes: wireBytes(wireArgs), at: performance.now(), wall: Date.now(), doneAt: null, ok: null,
    };
    const blipId = wireArgs[0]?.blipId;
    if (typeof blipId === "string") record.blipId = blipId;
    state.callLog.push(record);
    if (state.callLog.length > CALL_LOG_MAX) state.callLog.splice(0, state.callLog.length - CALL_LOG_MAX);
    const gen = state.generation;
    const result = this.up.run(async () => {
      if (this.dead) return new Promise(() => {});
      if (gen !== state.generation || performance.now() < state.downUntil) throw new ResetError();
      const server = /** @type {any} */ (state.server);
      return server[method](...wireArgs);
    });
    return new win.Promise((/** @type {any} */ resolve, /** @type {any} */ reject) => {
      result.then(
        (value) => {
          record.doneAt = performance.now(); record.ok = true;
          if (!this.dead) resolve(this.toPane(value));
        },
        (err) => {
          record.doneAt = performance.now(); record.ok = false;
          if (!this.dead) reject(new win.Error(err?.message ?? String(err)));
        },
      );
    });
  }

  /** @param {any} arg */
  marshal(arg) {
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
    /** @param {"operation"|"text"|"presence"} method @param {any} event */
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
      text: (/** @type {any} */ e) => deliver("text", e),
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
 * Simulates a facet restart: a new core instance over the same repository (the old instance's
 * view of it is fenced) and a new, empty hub. With `staleStub`, every pane's current `gadget`
 * stub also rejects forever (the real platform's behaviour after a code edit); a pane only
 * recovers by reloading itself.
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

/**
 * Starts a slow run through the real core (as the chat agent would), waits until it is
 * `running`, then restarts the server while the model call is in flight. The new instance must
 * mark the run `unknown` and nothing may respawn it; the old instance's commit hits the fence.
 * Resolves with the run id.
 * @param {{op?: string, delayMs?: number, staleStub?: boolean, by?: string}} [opts]
 */
async function restartMidRun({ op = "summarise", delayMs = 4000, staleStub = false, by = "Harness" } = {}) {
  setModel("slow", { delayMs });
  const requestId = "midrun-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36);
  const res = await state.server.askAgent({ op, by, senderId: "harness", requestId });
  if (!res || res.error) throw new Error("askAgent failed: " + JSON.stringify(res));
  const runId = res.run.id;
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const r = await state.server.getRun({ runId });
    if (r?.run?.state === "running") break;
    if (r?.run?.state && r.run.state !== "queued") throw new Error(`run ${runId} is ${r.run.state} before the restart`);
    await new Promise((r) => setTimeout(r, 25));
  }
  restart({ staleStub });
  log(`restarted mid-run ${runId}`);
  return runId;
}

/**
 * Switches the fake model's mode, or removes the model ("none": the next subscribe reports
 * capabilities.model false and askAgent answers no_model).
 * @param {ModelMode} mode
 * @param {{delayMs?: number, reply?: string|object}} [extra]
 */
function setModel(mode, extra = {}) {
  if (!MODEL_MODES.includes(/** @type {any} */ (mode))) throw new Error("unknown model mode " + mode);
  if (mode === "none") {
    state.modelOn = false;
  } else {
    state.modelOn = true;
    state.model.setMode(mode, extra);
  }
  state.server.setModel(state.modelOn ? state.model : null);
  const select = /** @type {HTMLSelectElement|null} */ (document.getElementById("model-mode"));
  if (select && select.value !== mode) select.value = mode;
  log(`model: ${mode}${extra.delayMs ? ` (${extra.delayMs} ms)` : ""}`);
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

// ---- server-side text helpers (the parent page has Yjs through the import map in index.html)

/**
 * A fresh Y.Doc holding the blip's current server text.
 * @param {string} blipId
 */
async function serverDoc(blipId) {
  const r = await state.server.openBlip({ blipId });
  if (!r || r.error) throw new Error(`openBlip ${blipId}: ${r?.error ?? "no result"}`);
  const doc = new Y.Doc();
  const bytes = decodeBytes(r.update);
  if (bytes && bytes.length) Y.applyUpdateV2(doc, bytes);
  return { doc, seq: r.seq, textSeq: r.textSeq };
}

/** The blip's text as the server holds it. @param {string} blipId */
async function text(blipId) {
  const { doc } = await serverDoc(blipId);
  return doc.getText("t").toString();
}

/**
 * Where a relative position (base64, as presence carets and paragraph anchors carry it) falls in
 * the blip's current server text; null when it no longer resolves.
 * @param {string} blipId
 * @param {string|null|undefined} relposBase64
 */
async function absoluteIndex(blipId, relposBase64) {
  const bytes = decodeBytes(relposBase64 ?? "");
  if (!bytes || !bytes.length) return null;
  const { doc } = await serverDoc(blipId);
  const rel = Y.decodeRelativePosition(bytes);
  const abs = Y.createAbsolutePositionFromRelativePosition(rel, doc);
  return abs ? abs.index : null;
}

// ---- controls
const slider = /** @type {HTMLInputElement} */ (document.getElementById("latency"));
slider.addEventListener("input", () => setLatency(Number(slider.value)));
setLatency(state.latency);
/** @type {HTMLElement} */ (document.getElementById("restart")).onclick = () => restart({ dispose: false });
/** @type {HTMLElement} */ (document.getElementById("restart-dispose")).onclick = () => restart({ dispose: true });
/** @type {HTMLElement} */ (document.getElementById("restart-stale")).onclick = () => restart({ staleStub: true });
/** @type {HTMLElement} */ (document.getElementById("restart-mid-run")).onclick = () => {
  restartMidRun().catch((e) => { log("restart mid-run failed: " + e.message); console.error(e); });
};
/** @type {HTMLElement} */ (document.getElementById("add-pane")).onclick = () => addPane();
/** @type {HTMLElement} */ (document.getElementById("add-export")).onclick = () => addPane({ exportFormat: "html" });
const modelSelect = /** @type {HTMLSelectElement} */ (document.getElementById("model-mode"));
modelSelect.addEventListener("change", () => setModel(/** @type {ModelMode} */ (modelSelect.value)));
{
  const initial = params.get("model");
  if (initial) setModel(/** @type {ModelMode} */ (initial));
}

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
  getWave: () => state.server.getWave(),
  /** @param {string} rootId */
  getThread: (rootId) => state.server.getThread({ rootId }),
  /** @param {string} runId */
  getRun: (runId) => state.server.getRun({ runId }),
  subscribers: () => state.server.hub.list(),
  /** Calls any RPC method directly, as a "third user" (e.g. the chat agent). */
  rpc: (/** @type {string} */ method, /** @type {any[]} */ ...args) => {
    if (!RPC_METHODS.has(method)) throw new Error("not an RPC method: " + method);
    return /** @type {any} */ (state.server)[method](...args);
  },
  text,
  absoluteIndex,
  settled: () => state.server.settled(),
  restart,
  restartMidRun,
  setLatency,
  setModel,
  get model() { return state.model; },
  get modelOn() { return state.modelOn; },
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
  /**
   * Every RPC call so far as {method, pane, bytes, at, wall, doneAt, ok, blipId?}; filter by
   * pane and/or method. Cleared with clearCallLog().
   * @param {{pane?: string, method?: string, since?: number}} [filter]  since: performance.now() value
   */
  callLog: (filter = {}) => state.callLog.filter((c) =>
    (!filter.pane || c.pane === filter.pane) && (!filter.method || c.method === filter.method) && (!filter.since || c.at >= filter.since)),
  clearCallLog: () => { state.callLog.length = 0; },
  now: () => performance.now(),
  seed,
  repo: state.repo,
};

const WORDS = ("wave blip thread reply brief decision option evidence question summary agent review " +
  "paragraph caret editor history export proposal accept reject rationale dissent next steps").split(" ");

/**
 * Deterministic filler text of about `chars` characters: sentences of common words, a blank line
 * every few sentences so the Markdown renderer makes several paragraphs.
 * @param {number} chars
 * @param {number} seedNo
 */
function fillerText(chars, seedNo) {
  let out = "";
  let i = seedNo * 7;
  let sentence = 0;
  while (out.length < chars) {
    const word = WORDS[i++ % WORDS.length];
    out += (sentence === 0 && (out === "" || out.endsWith("\n\n")) ? word[0].toUpperCase() + word.slice(1) : word);
    sentence++;
    if (sentence >= 9) {
      out += ". ";
      sentence = 0;
      if (i % 4 === 0) out = out.trimEnd() + "\n\n";
    } else {
      out += " ";
    }
  }
  return out.slice(0, chars).trimEnd();
}

/**
 * Creates `blips` root blips (kind note) of about `chars` characters each, through the real core
 * as the chat agent would (applyOperation creates with text). Returns the created ids.
 * @param {{blips?: number, chars?: number}|number} [opts]  a number means {blips: n}
 */
async function seed(opts = {}) {
  const o = typeof opts === "number" ? { blips: opts } : opts;
  const count = Math.max(0, Math.min(LIMITS.blips, Math.floor(Number(o.blips) || 0)));
  const chars = Math.max(0, Math.min(LIMITS.textChars, Math.floor(Number(o.chars ?? 120) || 0)));
  /** @type {string[]} */
  const ids = [];
  const ops = [];
  for (let i = 0; i < count; i++) {
    const id = newId("blip");
    ids.push(id);
    ops.push({ op: "create", blipId: id, parentId: null, kind: "note", text: `Seed ${i + 1}: ${fillerText(chars, i)}` });
  }
  for (let i = 0; i < ops.length; i += LIMITS.opsPerRequest) {
    const result = await state.server.applyOperation({
      by: "Seed", senderId: "harness-seed", requestId: `seed-${Date.now().toString(36)}-${i}`,
      blipOps: ops.slice(i, i + LIMITS.opsPerRequest),
    });
    if (result?.errors?.length) console.warn("seed errors", result.errors.slice(0, 3));
  }
  log(`seeded ${ids.length} blips of ~${chars} chars`);
  return ids;
}

if (params.get("seed")) await seed({ blips: Number(params.get("seed")), chars: Number(params.get("chars") || 120) });

const paneCount = Math.max(1, Math.min(4, Number(params.get("panes") || 2)));
// ?names=Alice,Bob sets the panes' account names (default "User A", "User B", ...).
const paneNames = (params.get("names") ?? "").split(",").map((n) => n.trim());
for (let i = 0; i < paneCount; i++) addPane({ name: paneNames[i] || undefined });
if (params.get("export")) addPane({ exportFormat: params.get("export") });
/** @type {any} */ (window).harness.ready = true;
