import { mountAdapt } from "../../../../scripts/blueprint-adapt/client.mjs";
// @ts-check
// Client entry point. Runs inside the gadget's sandboxed iframe, which has no HTML of its own.
// Provided by the platform: `gadget` (RPC stub to the Gadget Durable Object), `gadgetViewer` (the
// signed-in account; our fork's patch) and `RpcTarget`, declared as module-scope bindings in a
// prefix the platform prepends to this file (NOT properties of globalThis). All are read as free
// identifiers behind `typeof` guards.
//
// Sync: subscribe() hands the server an RpcTarget whose update(view) receives this viewer's view
// (the shelf, tunes and their own preferences) after every change. A heartbeat (ping) every 10 s, retried once after 2 s, re-subscribes when the server has restarted
// and forgotten us. After a facet restart the platform never replaces this frame's `gadget` stub,
// so when calls keep failing the frame reloads itself (at most 3 times a minute, counted in
// window.name, which survives the reload). Nothing is held only on the client: every change is
// sent straight away, so a reload loses nothing.

import { mountApp } from "./app.js";
import { injectStyles } from "./styles.js";

/* global gadget, gadgetViewer, RpcTarget */
// @ts-ignore provided by the platform prefix
const platformGadget = typeof gadget !== "undefined" ? gadget : undefined;
// @ts-ignore provided by the platform prefix
const platformRpcTarget = typeof RpcTarget !== "undefined" ? RpcTarget : Object;
// @ts-ignore provided by the platform prefix: {id, displayName, role} of the signed-in user
const platformViewer = typeof gadgetViewer !== "undefined" ? gadgetViewer : undefined;

// ===== Adapt this gadget =====================================================
// README.md ("Adapting this gadget") documents each setting and the app handle.
const adapt = {
  title: 'Arcade',
  actionLabel: "Extra actions",
  styles: "",
  actions: [],
  onReady(app) {},
};
// ============================================================================

const WINDOW_NAME_PREFIX = "arcade:";
const MAX_AUTO_RELOADS = 3;
const AUTO_RELOAD_WINDOW_MS = 60_000;
const PING_MS = 10_000;
const RETRY_MS = 2_000;

/** @returns {number[]} */
function recentReloads() {
  try {
    const raw = window.name;
    if (!raw.startsWith(WINDOW_NAME_PREFIX)) return [];
    const list = JSON.parse(raw.slice(WINDOW_NAME_PREFIX.length))?.reloads;
    return Array.isArray(list) ? list.filter((t) => typeof t === "number" && Date.now() - t < AUTO_RELOAD_WINDOW_MS) : [];
  } catch { return []; }
}

function reloadFrame() {
  const list = recentReloads();
  if (list.length >= MAX_AUTO_RELOADS) return false;
  try { window.name = WINDOW_NAME_PREFIX + JSON.stringify({ reloads: [...list, Date.now()] }); } catch { /* ignore */ }
  setTimeout(() => location.reload(), 300);
  return true;
}

/** The signed-in account. Every change is attributed to it; nobody is asked for a name. */
function account() {
  const v = platformViewer;
  const id = typeof v?.id === "string" && v.id.trim() ? v.id.trim() : "";
  const name = typeof v?.displayName === "string" && v.displayName.trim() ? v.displayName.trim() : id;
  return id ? { id, name } : null;
}

function randomId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

if (!document.documentElement.lang) document.documentElement.lang = "en";
if (!document.head.querySelector("meta[name=viewport]")) {
  document.head.append(Object.assign(document.createElement("meta"), { name: "viewport", content: "width=device-width, initial-scale=1" }));
}
document.title = "Arcade";
injectStyles();
const root = document.createElement("div");
document.body.appendChild(root);

const me = account();
if (!platformGadget) {
  root.textContent = "This page runs inside a Cloudflare OS gadget.";
} else if (!me) {
  root.textContent = "The arcade needs to know who you are, and the platform did not say. Reload the page, or update Cloudflare OS.";
} else {
  const g = /** @type {any} */ (platformGadget);
  const clientId = randomId();
  let failures = 0;

  /** @param {string} method @param {any[]} args */
  const call = async (method, ...args) => {
    let r;
    try {
      r = await g[method](...args);
      failures = 0;
    } catch (e) {
      noteFailure();
      throw e;
    }
    // A refusal by the arcade's rules, e.g. a stale save.
    if (r && typeof r.error === "string") throw new Error(r.error);
    return r;
  };

  const app = mountApp(root, { me, call, onRetry: () => { if (!reloadFrame()) location.reload(); } });

  class Listener extends platformRpcTarget {
    /** @param {any} view */
    update(view) { app.setView(view); }
  }
  const listener = new Listener();

  async function subscribe() {
    const view = await g.subscribe(listener, { clientId, viewerId: me.id });
    app.setView(view);
    app.setConnection("live");
    failures = 0;
    if (!adaptMounted) { adaptMounted = true; await mountAdapt(adapt, { gadget: platformGadget, methods: ["getView", "getTemplates", "getGame", "createGame", "saveGame", "updateGame", "createTune", "getTune", "setTitle"], refresh: async () => app.setView(await g.getView(me.id)) }); }
  }

  function noteFailure() {
    failures++;
    if (failures >= 2) {
      app.setConnection("lost");
      if (failures === 2) reloadFrame();
    }
  }

  async function ping() {
    try {
      const r = await g.ping(clientId, me.id);
      failures = 0;
      if (!r.subscribed) await subscribe();
      else {
        app.setConnection("live");
        if (app.view && r.revision > app.view.revision) app.setView(await g.getView(me.id));
      }
    } catch {
      noteFailure();
      if (failures === 1) setTimeout(ping, RETRY_MS);
    }
  }

  let adaptMounted = false;
  subscribe().catch(() => { noteFailure(); setTimeout(ping, 2000); });
  setInterval(ping, PING_MS);
  // A write whose broadcast has not arrived within a second fetches the view directly.
  setInterval(() => {
    const v = app.view;
    if (v && v.revision < app.awaitRevision) g.getView(me.id).then((/** @type {any} */ view) => app.setView(view), () => {});
  }, 1000);
  addEventListener("pagehide", () => { try { Promise.resolve(g.unsubscribe(clientId)).catch(() => {}); } catch { /* ignore */ } });
  /** @type {any} */ (globalThis).arcade = { app };
}
