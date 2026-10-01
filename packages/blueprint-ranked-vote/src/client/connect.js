// @ts-check
// Keeps a mounted vote in sync with the Gadget Durable Object.
//
// subscribe() hands the server an RpcTarget whose update(view) receives this viewer's view after
// every change. A heartbeat (ping) every 10 s, retried once after 2 s, re-subscribes when the
// server has restarted and forgotten us. After a facet restart the platform never replaces this
// frame's `gadget` stub, so when calls keep failing the frame reloads itself (at most 3 times a
// minute, counted in window.name, which survives the reload). Nothing is held only on the client:
// every change is sent straight away, so a reload loses nothing.

const WINDOW_NAME_PREFIX = "ranked-vote:";
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

function randomId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The RPC side of a vote: `call` for writes and reads, `retry` for the Reconnect button, and
 * `start(controller)` to subscribe once the view is mounted.
 * @param {{gadget: any, RpcTarget: any, me: {id: string, name: string}}} o
 */
export function connectVote({ gadget: g, RpcTarget, me }) {
  const clientId = randomId();
  let failures = 0;
  /** @type {any} */
  let controller = null;

  function noteFailure() {
    failures++;
    if (failures >= 2) {
      controller?.setConnection("lost");
      if (failures === 2) reloadFrame();
    }
  }

  /** Calls a gadget method; a refusal by the vote's rules ({error}) rejects with its message. @param {string} method @param {any} args */
  async function call(method, args) {
    let r;
    try {
      r = await g[method](args);
      failures = 0;
    } catch (e) {
      noteFailure();
      throw e;
    }
    if (r && typeof r.error === "string") throw new Error(r.error);
    return r;
  }

  const retry = () => { if (!reloadFrame()) location.reload(); };

  /** @param {{setView(v: any): void, setConnection(s: string): void, view: any, awaitRevision: number}} c */
  function start(c) {
    controller = c;
    class Listener extends RpcTarget {
      /** @param {any} view */
      update(view) { c.setView(view); }
    }
    const listener = new Listener();

    async function subscribe() {
      const view = await g.subscribe(listener, { clientId, voterId: me.id });
      c.setView(view);
      c.setConnection("live");
      failures = 0;
    }

    async function ping() {
      try {
        const r = await g.ping(clientId, me.id);
        failures = 0;
        if (!r.subscribed) await subscribe();
        else { c.setView(r.view); c.setConnection("live"); }
      } catch {
        noteFailure();
        if (failures === 1) setTimeout(ping, RETRY_MS);
      }
    }

    subscribe().catch(() => { noteFailure(); setTimeout(ping, RETRY_MS); });
    setInterval(ping, PING_MS);
    // A write whose broadcast has not arrived within a second fetches the view directly.
    setInterval(() => {
      const v = c.view;
      if (v && v.revision < c.awaitRevision) g.getView(me.id).then((/** @type {any} */ view) => c.setView(view), () => {});
    }, 1000);
    addEventListener("pagehide", () => { try { g.unsubscribe(clientId); } catch { /* ignore */ } });
  }

  return { call, retry, start };
}
