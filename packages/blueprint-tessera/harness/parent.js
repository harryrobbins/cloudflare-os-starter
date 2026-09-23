// The harness parent page: plays the Workshop's GadgetUI (the sandboxed frame and its capnweb
// handshake) and the gadget's Durable Object (the real src/server/core.js) in one browser page.
// serve.mjs bundles this file with esbuild on request; nothing here is watched.
//
// Query: ?procgen=1 binds a fake PROCGEN session (test/fake-procgen.js over the real generator,
// small profile) into the core's env. Without it the env is empty, as on a fresh gadget.
//
// Test hooks on window.harness: ready, reloadGadget() (a pane reload: new frame, same facet),
// violations (CSP reports from inside the frame), logs (console forwarded by the prefix), core,
// storage.

import { RpcTarget, newMessagePortRpcSession } from 'capnweb'
// Exactly as GadgetUI.tsx:10 does it (Vite ?raw); serve.mjs's esbuild plugin maps it to the
// installed capnweb's dist/index.js, the file Vite resolves for the browser.
import CAPNWEB_BUNDLE from 'capnweb?raw'
import { createCore } from '../src/server/core.js'
import { fakeProcgen } from '../test/fake-procgen.js'

const params = new URLSearchParams(location.search)
const STORAGE_KEY = 'tessera-harness-storage'

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
const CSP_PROBE = params.get('cspProbe') === '0' ? '' : `<script>document.addEventListener('securitypolicyviolation', e => window.parent.postMessage({ type: 'harness-csp', directive: e.effectiveDirective, blocked: String(e.blockedURI).slice(0, 120), sample: e.sample, source: e.sourceFile, line: e.lineNumber }, '*'))</script>`

// ---------------------------------------------------------------------------------------------
// The facet: the real core over storage that survives a pane (iframe) reload and, through
// sessionStorage, a reload of this page too.

function sessionBackedStorage() {
  const read = () => { try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '{}') } catch { return {} } }
  const map = new Map(Object.entries(read()))
  const flush = () => { try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(map))) } catch {} }
  return {
    map,
    async get(key) { return map.has(key) ? structuredClone(map.get(key)) : undefined },
    async put(key, value) { map.set(key, structuredClone(value)); flush() },
    clear() { map.clear(); flush() },
  }
}

const storage = sessionBackedStorage()
const procgen = params.get('procgen') === '1' ? fakeProcgen({ seed: 'harness', profile: 'small' }) : null
const env = procgen ? { PROCGEN: procgen } : {}
const core = createCore({ env, storage })

/** The Durable Object's RPC surface (src/server/index.js), served over the frame's MessagePort. */
class GadgetFacet extends RpcTarget {
  getState() { return core.getState() }
  setState(state) { return core.setState(state) }
  listSources() { return core.listSources() }
  loadTable(sourceId, table, options) { return core.loadTable(sourceId, table, options) }
}

// ---------------------------------------------------------------------------------------------
// The pane: GadgetUI's iframe and handshake (GadgetUI.tsx:337-400 and 508-527).

const viewer = { id: 'harness@example.com', displayName: 'Harness Viewer', role: 'build' }
const violations = []
const logs = []
const pane = document.getElementById('pane')
let iframe = null
let session = null
let html = null
let generation = 0

window.addEventListener('message', event => {
  // As GadgetUI.tsx:343: only our frame, and only from the null (opaque) origin.
  if (!iframe || event.source !== iframe.contentWindow || event.origin !== 'null') return
  if (event.data === 'handshake' && event.ports?.[0]) {
    session?.[Symbol.dispose]?.()
    session = newMessagePortRpcSession(event.ports[0], new GadgetFacet())
    window.harness.handshakes++
  } else if (event.data?.type === 'console') {
    logs.push({ level: event.data.level, message: event.data.message })
    const line = `[gadget ${event.data.level}] ${event.data.message.join(' ')}`
    ;(event.data.level === 'error' ? console.error : console.log)(line)
  } else if (event.data?.type === 'harness-csp') {
    violations.push(event.data)
    console.error(`[gadget CSP violation] ${JSON.stringify(event.data)}`)
  }
})

function mountFrame() {
  session?.[Symbol.dispose]?.()
  session = null
  iframe?.remove()
  iframe = document.createElement('iframe')
  iframe.dataset.generation = String(++generation)
  iframe.title = 'Gadget UI'
  iframe.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox')
  iframe.srcdoc = html
  pane.append(iframe)
  return iframe
}

async function start() {
  const response = await fetch('/dist/client.js', { cache: 'no-store' })
  if (!response.ok) throw new Error(`dist/client.js: HTTP ${response.status} (run node scripts/build.mjs)`)
  html = createSandboxedHtml(await response.text(), viewer)
  mountFrame()
  document.getElementById('status').textContent = procgen ? 'env: PROCGEN (fake, small profile)' : 'env: no bindings'
  window.harness.ready = true
}

window.harness = {
  ready: false,
  handshakes: 0,
  violations,
  logs,
  core,
  storage,
  procgen,
  /** A pane reload: a fresh frame (and RPC session) over the same facet, as GadgetUI's key bump. */
  reloadGadget() { mountFrame(); return generation },
  /** Forget the persisted state (sessionStorage) for a fresh gadget on the next page load. */
  resetStorage() { storage.clear() },
}

document.getElementById('reload').addEventListener('click', () => window.harness.reloadGadget())
document.getElementById('reset').addEventListener('click', () => { storage.clear(); location.reload() })
start().catch(error => { console.error(error); document.getElementById('status').textContent = String(error) })
