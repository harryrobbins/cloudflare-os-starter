// The harness parent page: plays the Workshop's GadgetUI (sandboxed frames and their capnweb
// handshakes) and the gadget's Durable Object (the real core, changesets and hub) in one page.
// serve.mjs bundles this file with esbuild on request.
//
// Query: ?panes=N (1-3) frames on the same facet; ?latency=MS added to every facet call;
// ?blank=1 starts a never-initialised map without the demo; ?cspProbe=0 removes the CSP probe.
//
// Test hooks on window.harness: ready, violations, logs, map (the core), storage, restartFacet()
// (a new facet over the same storage; every old stub fails from then on, as on the platform after
// a code edit), reloadPane(i), setLatency(ms), dropNextCalls(n).

import { RpcTarget, newMessagePortRpcSession } from "capnweb";
import CAPNWEB_BUNDLE from "capnweb?raw";
import { createNetworkMap } from "../src/core/network-map.js";
import { createChangesets } from "../src/core/changesets.js";
import { Hub } from "../src/core/hub.js";
import { InMemoryRepository } from "../src/core/repository.js";

const params = new URLSearchParams(location.search);
const STORAGE_KEY = "network-map-harness-storage";

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
// them. It runs before the module and does not touch any global the gadget sees. ?cspProbe=0
// removes it for a byte-identical platform document.
// ?nowebgl=1: WebGL is unavailable in the frame (tests the list fallback). Classic inline script,
// allowed by the same CSP; runs before the module.
const NO_WEBGL = params.get('nowebgl') === '1' ? `<script>{const g=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(t,...a){return /webgl/i.test(t)?null:g.call(this,t,...a)}}</script>` : ''
const CSP_PROBE = NO_WEBGL + (params.get('cspProbe') === '0' ? '' : `<script>document.addEventListener('securitypolicyviolation', e => window.parent.postMessage({ type: 'harness-csp', directive: e.effectiveDirective, blocked: String(e.blockedURI).slice(0, 120), sample: e.sample, source: e.sourceFile, line: e.lineNumber }, '*'))</script>`)

// ---------------------------------------------------------------------------------------------
// The facet: the real core over storage that survives a pane reload, a facet restart and, through
// sessionStorage, a reload of this page.

class SessionRepository extends InMemoryRepository {
  constructor() {
    super();
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
      if (saved) this.kv = new Map(saved);
    } catch { /* fresh */ }
  }
  async commit(commit) {
    await super.commit(commit);
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...this.kv])); } catch { /* quota: memory only */ }
  }
  clear() { this.kv.clear(); try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ } }
}

const storage = new SessionRepository();
let latency = Number(params.get("latency") || 0);
let dropCalls = 0;
let facetGeneration = 0;
/** @type {{map: any, changesets: any, hub: Hub, generation: number}} */
let facet = makeFacet();

function makeFacet() {
  const hub = new Hub();
  const map = createNetworkMap(storage, { onEvent: (event) => hub.broadcast(event), seedDemo: params.get("blank") !== "1" });
  return { map, changesets: createChangesets(map), hub, generation: ++facetGeneration };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The Durable Object's RPC surface (src/server/index.js), served over a frame's MessagePort. */
class GadgetFacet extends RpcTarget {
  constructor() {
    super();
    this.generation = facet.generation;
  }
  async #call(fn) {
    if (this.generation !== facet.generation) throw new Error("Gadget restarted due to code update."); // the platform's message (overseer.ts)
    if (latency) await sleep(latency);
    if (dropCalls > 0) { dropCalls--; throw new Error("Network connection lost (harness)"); }
    return fn(facet);
  }
  describeMap() { return this.#call((f) => f.map.describeMap()); }
  findElements(filter) { return this.#call((f) => f.map.findElements(filter)); }
  getNeighbourhood(args) { return this.#call((f) => f.map.getNeighbourhood(args)); }
  getMapMarkdown(args) { return this.#call((f) => f.map.getMapMarkdown(args)); }
  getHistory(limit) { return this.#call((f) => f.map.getHistory(limit)); }
  openSnapshot() { return this.#call((f) => f.map.openSnapshot()); }
  snapshotPage(token, cursor) { return this.#call((f) => f.map.snapshotPage(token, cursor)); }
  applyOperation(request) { return this.#call(async (f) => (await f.map.applyOperation(request)).result); }
  undo(args) { return this.#call(async (f) => (await f.map.undo(args)).result); }
  undoGroup(args) { return this.#call((f) => f.changesets.undoGroup(args)); }
  createChangeset(args) { return this.#call((f) => f.changesets.createChangeset(args)); }
  addChangesetItems(args) { return this.#call((f) => f.changesets.addChangesetItems(args)); }
  finalizeChangeset(args) { return this.#call((f) => f.changesets.finalizeChangeset(args)); }
  getChangeset(args) { return this.#call((f) => f.changesets.getChangeset(args)); }
  setDecisions(args) { return this.#call((f) => f.changesets.setDecisions(args)); }
  acceptChangeset(args) { return this.#call((f) => f.changesets.acceptChangeset(args)); }
  resumeChangeset(args) { return this.#call((f) => f.changesets.resumeChangeset(args)); }
  rejectChangeset(args) { return this.#call((f) => f.changesets.rejectChangeset(args)); }
  listChangesets() { return this.#call((f) => f.changesets.listChangesets()); }
  subscribe(callback, client) {
    return this.#call(async (f) => {
      const stub = typeof callback?.dup === "function" ? callback.dup() : callback;
      let session;
      try {
        ({ session } = f.hub.add(stub, client));
      } catch (e) {
        if (stub !== callback) { try { stub?.[Symbol.dispose]?.(); } catch { /* ignore */ } }
        throw e;
      }
      return { ...(await f.map.openSnapshot()), session };
    });
  }
  updatePresence(presence) {
    return this.#call(async (f) => {
      const { known } = f.hub.updatePresence(presence);
      return { known, revision: f.map.revisionNow() ?? await f.map.getRevision() };
    });
  }
  leavePresence(clientId, session) { return this.#call((f) => f.hub.leave(clientId, session)); }
}

// ---------------------------------------------------------------------------------------------
// Panes: GadgetUI's iframe and handshake, once per pane.

const names = ["Ada Lovelace", "Grace Hopper", "Alan Turing"];
const violations = [];
const logs = [];
const panesEl = document.getElementById("panes");
const count = Math.max(1, Math.min(3, Number(params.get("panes") || 1)));
let html = null;
/** @type {{iframe: HTMLIFrameElement|null, session: any, viewer: any, generation: number}[]} */
const panes = Array.from({ length: count }, (_, i) => ({ iframe: null, session: null, viewer: { id: `user${i + 1}@example.com`, displayName: names[i], role: "build" }, generation: 0 }));

window.addEventListener("message", (event) => {
  const pane = panes.find((p) => p.iframe && event.source === p.iframe.contentWindow);
  if (!pane || event.origin !== "null") return;
  if (event.data === "handshake" && event.ports?.[0]) {
    pane.session?.[Symbol.dispose]?.();
    pane.session = newMessagePortRpcSession(event.ports[0], new GadgetFacet());
    window.harness.handshakes++;
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
  iframe.title = `Gadget UI ${i + 1}`;
  iframe.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
  iframe.srcdoc = createSandboxedHtml(html, pane.viewer);
  if (pane.iframe) pane.iframe.replaceWith(iframe);
  else panesEl.append(iframe);
  pane.iframe = iframe;
}

async function start() {
  const response = await fetch("/dist/client.js", { cache: "no-store" });
  if (!response.ok) throw new Error(`dist/client.js: HTTP ${response.status} (run node scripts/build.mjs)`);
  html = await response.text();
  for (let i = 0; i < panes.length; i++) mountPane(i);
  document.getElementById("status").textContent = `${panes.length} pane(s)${latency ? `, ${latency} ms` : ""}`;
  window.harness.ready = true;
}

window.harness = {
  ready: false,
  handshakes: 0,
  violations,
  logs,
  storage,
  get map() { return facet.map; },
  get changesets() { return facet.changesets; },
  /** A new facet over the same storage; old stubs fail from now on. */
  restartFacet() { facet = makeFacet(); return facet.generation; },
  /** A pane reload: a fresh frame (and RPC session) over the same facet. */
  reloadPane(i = 0) { mountPane(i); return panes[i].generation; },
  setLatency(ms) { latency = ms; },
  dropNextCalls(n) { dropCalls = n; },
  resetStorage() { storage.clear(); },
};

document.getElementById("restart").addEventListener("click", () => window.harness.restartFacet());
document.getElementById("reset").addEventListener("click", () => { storage.clear(); location.reload(); });
start().catch((error) => { console.error(error); document.getElementById("status").textContent = String(error); });
