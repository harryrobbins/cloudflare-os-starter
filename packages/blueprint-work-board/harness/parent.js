// @ts-check
// The Work Board harness parent page: plays the Workshop's GadgetUI (sandboxed frames and their
// capnweb handshakes) and the gadget's Durable Object (the real src/server/api.js over in-memory
// storage) in one page, with the Records connector and service played by test/fake-records.js
// (the migration-010 contract). serve.mjs bundles this file with esbuild on request.
//
// Query: ?panes=1|2, ?seed=<items> (default 300; 0 = empty), ?approval=auto|manual (default
// auto), ?v1=1 (datastore without migration 010), ?access=read, ?latency=<ms>, ?timestamps=0 (no record
// extra: record and journal times, which the real service strips),
// ?now=<ISO> (fake clock base), ?anon=1 (pane 0 has no signed-in viewer), ?cspProbe=0.
// Test hooks on window.harness (see README.md).

import { RpcTarget, newMessagePortRpcSession } from "capnweb";
import CAPNWEB_BUNDLE from "capnweb?raw";
import { FakeRecords } from "../test/fake-records.js";
import { createGadgetApi, RPC_METHODS } from "../src/server/api.js";
import { memoryStorage } from "../src/server/documents.js";
import { SEED_PEOPLE, mulberry32, seedWork } from "./seed.js";
import { createFakeJev } from "../test/fake-jev.js";

const params = new URLSearchParams(location.search);

// ---------------------------------------------------------------------------------------------
// Copied from cloudflare-os/packages/workshop-frontend/src/GadgetUI.tsx:14-118 (capnweb 0.11.1,
// the catalog version both workspaces pin). Keep it verbatim so the frame behaves as on the
// platform; only the TypeScript annotations are dropped.

// btoa() below requires this to stay ASCII; capnweb's build enforces ASCII-only dist bundles
// since 0.11.1.
let CAPNWEB_BUNDLE_ANNOTATED = `//# sourceURL=jsrpc.js\n${CAPNWEB_BUNDLE}`

let INJECTED_CODE_PREFIX = encodeURIComponent(String.raw`//# sourceURL=client.js
import { RpcTarget, RpcStub, newMessagePortRpcSession } from "data:text/javascript;charset=utf-8;base64,${btoa(CAPNWEB_BUNDLE_ANNOTATED)}";

let gadget;  // RPC stub to the gadget's server-side Durable Object.
{
  let {port1, port2} = new MessageChannel();
  window.parent.postMessage("handshake", "*", [port2]);
  gadget = newMessagePortRpcSession(port1);
}

// Monkey-patch console to forward logs to the parent frame.
for (let level of ['debug', 'info', 'log', 'warn', 'error']) {
  let original = console[level];
  console[level] = (...args) => {
    original.apply(console, args);
    try {
      let message = args.map(arg => {
        if (typeof arg === 'string') return arg;
        try { return JSON.stringify(arg); }
        catch { return String(arg); }
      });
      window.parent.postMessage({ type: 'console', level, message }, '*');
    } catch {};
  };
}

// Allow user-activated target=_blank links, but block programmatic popups.
const blockedOpen = () => {
  console.error('window.open() is disabled in Gadget UIs. Use a link with target="_blank" instead.');
  return null;
};
window.open = blockedOpen;
globalThis.open = blockedOpen;
try {
  Window.prototype.open = blockedOpen;
} catch {}

// Forward Escape key presses to the parent frame. The sandboxed iframe captures keydown events
// when it has focus, so the parent never sees them. The workshop UI uses Escape to exit fullscreen
// gadget mode, so forward it explicitly.
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    window.parent.postMessage({ type: 'escape' }, '*');
  }
}, true);

window.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }

  const anchor = event.target.closest('a[href][target]');
  if (!anchor || anchor.target.toLowerCase() !== '_blank') {
    return;
  }

  const rel = new Set((anchor.getAttribute('rel') || '').split(/\s+/).filter(Boolean));
  rel.add('noopener');
  anchor.setAttribute('rel', Array.from(rel).join(' '));
}, true);

// Capture unhandled exceptions and promise rejections.
window.addEventListener('error', (event) => {
  window.parent.postMessage({
    type: 'console',
    level: 'error',
    message: ['Uncaught', event.error?.stack || event.message],
  }, '*');
});
window.addEventListener('unhandledrejection', (event) => {
  let reason = event.reason;
  window.parent.postMessage({
    type: 'console',
    level: 'error',
    message: ['Unhandled promise rejection:', reason?.stack || String(reason)],
  }, '*');
});

`);

const createSandboxedHtml = (jsCode, viewer) => {
  // `gadgetViewer` joins `gadget` as a module-scope binding: who is signed in, or null if unknown.
  let viewerCode = encodeURIComponent(
      `const gadgetViewer = Object.freeze(${JSON.stringify(viewer)});\n`)
  return `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'none'; script-src data: 'unsafe-inline'; style-src data: 'unsafe-inline'; img-src data:; media-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none';">
  ${CSP_PROBE}
</head>
<body>
    <script type="module" src="data:text/javascript;charset=utf-8,${INJECTED_CODE_PREFIX}${viewerCode}${encodeURIComponent(jsCode)}"></script>
</body>
</html>`.trim()
}
// End of the GadgetUI.tsx copy, except ${CSP_PROBE} above.
// ---------------------------------------------------------------------------------------------

// The one harness-only addition to the frame: a classic inline script (allowed by the same CSP's
// 'unsafe-inline') that reports securitypolicyviolation events to the parent, so tests can fail on
// them. It runs before the module and touches no global the gadget sees. ?cspProbe=0 removes it.
const CSP_PROBE = params.get('cspProbe') === '0' ? '' : `<script>document.addEventListener('securitypolicyviolation', e => window.parent.postMessage({ type: 'harness-csp', directive: e.effectiveDirective, blocked: String(e.blockedURI).slice(0, 120), sample: e.sample, source: e.sourceFile, line: e.lineNumber }, '*'))</script>`

// ---------------------------------------------------------------------------------------------
// The datastore (fake Records service + connector) and the facet (the gadget server).

const DAY = 86_400_000;
const pageStart = Date.now();
const nowParam = params.get("now");
const clockBase = nowParam && !Number.isNaN(Date.parse(nowParam)) ? Date.parse(nowParam) : pageStart;
/** The fake clock: real time, shifted so the page starts at `now=` when given. */
const clock = () => clockBase + (Date.now() - pageStart);
const planning = params.get("v1") !== "1";
const seedCount = Math.max(0, Math.min(4000, Number(params.get("seed") ?? 300) || 0));

const fake = new FakeRecords({
  planning,
  access: params.get("access") === "read" ? "read" : "write",
  approval: params.get("approval") === "manual" ? "manual" : "auto",
  // Records and change entries carry timestamps; ?timestamps=0 reproduces a service without them.
  timestamps: params.get("timestamps") !== "0",
  now: clock,
});

const seedStarted = performance.now();
if (seedCount && planning) seedWork(fake, { items: seedCount, now: clockBase });
else if (seedCount) seedV1(seedCount);
const seedMs = Math.round(performance.now() - seedStarted);

/** A datastore without migration 010: only title, description and status. @param {number} n */
function seedV1(n) {
  const rng = mulberry32(42);
  const original = fake.now;
  let t = clockBase - 30 * DAY;
  fake.now = () => t;
  const words = ["Fix login redirect", "Write onboarding guide", "Speed up search", "Add CSV export", "Review pricing copy", "Plan Q4 roadmap", "Audit permissions", "Refresh screenshots"];
  try {
    for (let i = 0; i < n; i++) {
      t += (30 * DAY / n) * (0.5 + rng());
      t = Math.min(t, clockBase - 60_000);
      const who = `cloudflare-os:${SEED_PEOPLE[Math.floor(rng() * SEED_PEOPLE.length)].id}`;
      const r = rng();
      fake.run("work.create", { title: `${words[i % words.length]} ${i + 1}`, status: r < 0.5 ? "open" : r < 0.75 ? "active" : "done", ...(rng() < 0.4 ? { description: "Details to follow." } : {}) }, { actor: who });
    }
  } finally {
    fake.now = original;
  }
}

const storage = memoryStorage();
const session = fake.session();
let latency = Number(params.get("latency") || 0);
let dropCalls = 0;
let facetGeneration = 0;
/** @type {{ api: ReturnType<typeof createGadgetApi>, generation: number }} */
let facet = makeFacet();
// The seeded colleagues have used the board before, so the people document knows their names
// (?people=0 starts without them: everyone but the viewer shows as an account).
if (params.get("people") !== "0" && planning) {
  void Promise.all(SEED_PEOPLE.map((p) => facet.api.rememberViewer(p)))
    .then(() => facet.api.setPersonAlias("records:operator:seed", "Records setup"));
}

// The optional Jev decisions connector (JEV): a deterministic fake; ?jev=0 leaves it unconnected.
const jev = params.get("jev") === "0" ? null : createFakeJev({ delayMs: 150 });

function makeFacet() {
  return { api: createGadgetApi({ getEnv: () => ({ RECORDS: session, ...(jev ? { JEV: jev } : {}) }), storage, now: clock }), generation: ++facetGeneration };
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One facet call as a pane makes it: fails on a stale stub, waits `latency`, may be dropped.
 * @param {GadgetFacet} target @param {(api: any) => any} fn
 */
async function facetCall(target, fn) {
  if (target.generation !== facet.generation) throw new Error("Gadget restarted due to code update."); // the platform's message (overseer.ts)
  if (latency) await sleep(latency);
  if (dropCalls > 0) { dropCalls--; throw new Error("Network connection lost (harness)"); }
  const result = await fn(facet.api);
  if (latency) await sleep(latency);
  return result;
}

/** The Durable Object's RPC surface (src/server/index.js) plus the host-owned `$` methods. */
class GadgetFacet extends RpcTarget {
  /** @param {Pane} pane */
  constructor(pane) {
    super();
    this.generation = facet.generation;
    this.pane = pane;
  }
  /** Host-owned: a one-use viewer assertion over `digest`, as the Workshop mints it. @param {string} binding @param {string} digest */
  $createViewerAssertion(binding, digest) {
    return facetCall(this, () => {
      if (!this.pane.viewer) throw new Error("forbidden: Only signed-in viewers can request changes.");
      return fake.createViewerAssertion(this.pane.viewer.id, binding, digest);
    });
  }
}
for (const name of RPC_METHODS) {
  Object.defineProperty(GadgetFacet.prototype, name, {
    value: function (/** @type {any[]} */ ...args) { return facetCall(this, (api) => api[name](...args)); },
    writable: true, configurable: true,
  });
}

// ---------------------------------------------------------------------------------------------
// Panes: GadgetUI's iframe and handshake, once per pane.

/** @typedef {{ iframe: HTMLIFrameElement|null, session: any, viewer: any, generation: number, loads: number }} Pane */

const VIEWERS = [
  { id: "ada@example.com", displayName: "Ada Lovelace", role: "build" },
  { id: "grace@example.com", displayName: "Grace Hopper", role: "use" },
];
/** @type {any[]} */ const violations = [];
/** @type {any[]} */ const logs = [];
const panesEl = /** @type {HTMLElement} */ (document.getElementById("panes"));
const count = Math.max(1, Math.min(2, Number(params.get("panes") || 1)));
/** @type {string|null} */
let html = null;
/** @type {Pane[]} */
const panes = Array.from({ length: count }, (_, i) => ({
  iframe: null, session: null, generation: 0, loads: 0,
  viewer: i === 0 && params.get("anon") === "1" ? null : VIEWERS[i],
}));

window.addEventListener("message", (event) => {
  const pane = panes.find((p) => p.iframe && event.source === p.iframe.contentWindow);
  if (!pane || event.origin !== "null") return;
  if (event.data === "handshake" && event.ports?.[0]) {
    pane.session?.[Symbol.dispose]?.();
    pane.session = newMessagePortRpcSession(event.ports[0], new GadgetFacet(pane));
    pane.loads++;
    harness.handshakes++;
  } else if (event.data?.type === "console") {
    logs.push({ pane: panes.indexOf(pane), level: event.data.level, message: event.data.message });
    (event.data.level === "error" ? console.error : console.log)(`[pane ${panes.indexOf(pane)} ${event.data.level}] ${event.data.message.join(" ")}`);
  } else if (event.data?.type === "harness-csp") {
    violations.push(event.data);
    console.error(`[CSP violation] ${JSON.stringify(event.data)}`);
  }
});

/** @param {number} i */
function mountPane(i) {
  const pane = panes[i];
  pane.session?.[Symbol.dispose]?.();
  pane.session = null;
  const iframe = document.createElement("iframe");
  iframe.dataset.pane = String(i);
  iframe.dataset.generation = String(++pane.generation);
  iframe.title = `Gadget UI ${i + 1} (${pane.viewer?.displayName ?? "not signed in"})`;
  iframe.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
  iframe.srcdoc = createSandboxedHtml(/** @type {string} */ (html), pane.viewer);
  if (pane.iframe) pane.iframe.replaceWith(iframe);
  else panesEl.append(iframe);
  pane.iframe = iframe;
}

// ---------------------------------------------------------------------------------------------
// Controls and test hooks.

/** Someone else (Linus, through another client) changes a random item. */
function external() {
  const items = [...fake.rows.values()].filter((r) => r.entity === "work_item" && !r.data.archived);
  if (!items.length) return null;
  const row = items[Math.floor(Math.random() * items.length)];
  /** @type {Record<string, any>} */
  let patch;
  if (planning) {
    const states = [...fake.rows.values()].filter((r) => r.entity === "workflow_state" && r.data.key !== row.data.state);
    patch = Math.random() < 0.5 && states.length ? { state: states[Math.floor(Math.random() * states.length)].data.key } : { priority: 1 + Math.floor(Math.random() * 4) };
  } else {
    patch = { status: row.data.status === "done" ? "open" : row.data.status === "open" ? "active" : "done" };
  }
  const record = fake.run("work.update", { id: row.id, ...patch }, { actor: "cloudflare-os:linus@example.com", revision: row.revision });
  return { id: row.id, number: record.data.number ?? null, patch };
}

const harness = {
  ready: false,
  handshakes: 0,
  seedMs,
  violations,
  logs,
  fake,
  jev,
  storage,
  viewers: VIEWERS,
  get api() { return facet.api; },
  get generation() { return facet.generation; },
  approveAll() { return fake.approveAll(); },
  /** @param {number} id */ approve(id) { return fake.approve(id); },
  /** @param {number} id @param {string} [reason] */ reject(id, reason) { return fake.reject(id, reason); },
  rejectOldest() { const a = fake.pendingActions()[0]; if (a) fake.reject(a.id); return a?.id ?? null; },
  pending() { return fake.pendingActions().map((a) => ({ id: a.id, command: a.command, input: a.input, actor: a.actor })); },
  /** @param {"auto"|"manual"} mode */ setApproval(mode) { fake.setApproval(mode); syncControls(); },
  external,
  bumpEpoch() { fake.setEpoch(fake.epoch + 1); return fake.epoch; },
  /** @param {number} ms */ setLatency(ms) { latency = ms; syncControls(); },
  /** A new facet over the same storage and datastore; every old stub fails from now on. */
  restartFacet() { facet = makeFacet(); return facet.generation; },
  /** A pane reload: a fresh frame (and RPC session) over the same facet. @param {number} [i] */
  reloadPane(i = 0) { mountPane(i); return panes[i].generation; },
  /** @param {number} n */ dropNextCalls(n) { dropCalls = n; },
  /** Calls the gadget server directly, as the in-Workshop agent would. @param {string} method @param {...any} args */
  rpc(method, ...args) {
    const api = /** @type {any} */ (facet.api);
    if (typeof api[method] !== "function") throw new Error(`No RPC method ${method}`);
    return api[method](...args);
  },
  /** @param {number} i */ paneLoads(i) { return panes[i]?.loads ?? 0; },
};
/** @type {any} */ (window).harness = harness;

const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));
function syncControls() {
  $("approval").value = fake.approval;
  $("latency").value = String(latency);
  $("latency-value").textContent = `${latency} ms`;
}
$("approval").addEventListener("change", (/** @type {Event} */ e) => harness.setApproval(/** @type {any} */ (e.target).value));
$("approve-all").addEventListener("click", () => harness.approveAll());
$("reject-oldest").addEventListener("click", () => harness.rejectOldest());
$("external").addEventListener("click", () => { const r = external(); status(r ? `Linus changed #${r.number ?? r.id.slice(-4)}: ${JSON.stringify(r.patch)}` : "no items"); });
$("epoch").addEventListener("click", () => status(`permission epoch ${harness.bumpEpoch()}`));
$("latency").addEventListener("input", (/** @type {Event} */ e) => harness.setLatency(Number(/** @type {any} */ (e.target).value)));
$("restart").addEventListener("click", () => status(`facet generation ${harness.restartFacet()}`));
for (let i = 0; i < count; i++) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = `Reload pane ${i + 1}`;
  b.addEventListener("click", () => harness.reloadPane(i));
  $("reloads").append(b);
}
/** @param {string} text */
function status(text) { $("log").textContent = text; }
setInterval(() => {
  $("pending").textContent = `${fake.pendingActions().length} pending · seq ${fake.seq} · epoch ${fake.epoch}`;
}, 300);
syncControls();

async function start() {
  const response = await fetch("/dist/client.js", { cache: "no-store" });
  if (!response.ok) throw new Error(`dist/client.js: HTTP ${response.status} (run node scripts/build.mjs)`);
  html = await response.text();
  for (let i = 0; i < panes.length; i++) mountPane(i);
  status(`${panes.length} pane(s) · ${planning ? "work v1 + planning (010)" : "work v1 only"} · ${fake.rows.size} records seeded in ${seedMs} ms · ${fake.approval} approval${latency ? ` · ${latency} ms` : ""}`);
  harness.ready = true;
}
start().catch((error) => { console.error(error); status(String(error)); });
