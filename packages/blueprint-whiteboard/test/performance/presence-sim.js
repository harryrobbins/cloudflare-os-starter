// @ts-check
// Presence traffic simulation: N viewers on one board, through the real hub (src/core/hub.js) with
// a simulated clock, counting what crosses the Durable Object boundary. Each viewer behaves like
// the current client (src/client/sync/store.js): an active viewer (moving its pointer) sends at
// most one updatePresence per PRESENCE_SEND_MS; every viewer heartbeats every PRESENCE_HEARTBEAT_MS.
// The hub coalesces, rate-limits and fans out as in production; deliveries settle at once (a fast
// network), so this is the hub's own cost, not backpressure.
//
// Counted (per simulated second, after everyone has joined):
//   inbound   updatePresence calls into the hub
//   outbound  presence() deliveries (RPC calls to subscribers), events carried, and estimated bytes
//             (the hub's own presenceBytes estimate of each event's JSON)

import { Hub, presenceBytes } from "../../src/core/hub.js";
import { PRESENCE_HEARTBEAT_MS, PRESENCE_SEND_MS } from "../../src/shared/protocol.js";

/**
 * @param {{viewers: number, activeShare?: number, seconds?: number, warmupMs?: number}} opts
 */
export async function simulatePresence({ viewers, activeShare = 0.2, seconds = 5, warmupMs = 1000 }) {
  /** @type {{at: number, seq: number, fn: () => void}[]} */
  let queue = [];
  let seq = 0;
  let now = 0;
  const push = (/** @type {number} */ at, /** @type {() => void} */ fn) => {
    const item = { at, seq: ++seq, fn };
    queue.push(item);
    return item;
  };
  const timers = {
    setTimeout: (/** @type {() => void} */ fn, /** @type {number} */ ms) => push(now + Math.max(0, ms), fn),
    clearTimeout: (/** @type {any} */ item) => { if (item) item.fn = () => {}; },
  };
  const hub = new Hub({ now: () => now, timers });
  const counters = { inbound: 0, deliveries: 0, events: 0, bytes: 0, warmupEvents: 0, maxEvents: 0 };
  let measuring = false;
  const end = warmupMs + seconds * 1000;

  /** @type {{clientId: string, session: string}[]} */
  const clients = [];
  for (let i = 0; i < viewers; i++) {
    const stub = {
      presence(/** @type {any[]} */ events) {
        if (measuring) {
          counters.deliveries++;
          counters.events += events.length;
          counters.maxEvents = Math.max(counters.maxEvents, events.length);
          for (const e of events) counters.bytes += presenceBytes(e);
        } else counters.warmupEvents += events.length;
        return Promise.resolve();
      },
      operation() { return Promise.resolve(); },
    };
    const clientId = `sim-${i}`;
    const { session } = hub.add(stub, { clientId, name: `Viewer ${i + 1}`, color: "#2563eb" });
    clients.push({ clientId, session });
  }
  const active = activeShare > 0 ? Math.max(1, Math.round(viewers * activeShare)) : 0;
  clients.forEach((c, i) => {
    const vp = { x: i * 50, y: 0, w: 1400, h: 900 };
    const send = (/** @type {any} */ fields) => {
      if (measuring) counters.inbound++;
      hub.updatePresence({ clientId: c.clientId, session: c.session, ...fields });
    };
    // Heartbeat, staggered.
    const beat = () => { send({}); push(now + PRESENCE_HEARTBEAT_MS, beat); };
    push((i * 997) % PRESENCE_HEARTBEAT_MS, beat);
    if (i < active) {
      let step = 0;
      const move = () => {
        step++;
        send({ cursor: { x: vp.x + (step * 7) % vp.w, y: vp.y + (step * 5) % vp.h }, viewport: vp });
        push(now + PRESENCE_SEND_MS, move);
      };
      push(i % PRESENCE_SEND_MS, move);
    }
  });
  push(warmupMs, () => { measuring = true; });

  while (queue.length) {
    queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const at = queue[0].at;
    if (at > end) break;
    now = at;
    const due = [];
    while (queue.length && queue[0].at === at) due.push(/** @type {any} */ (queue.shift()));
    for (const item of due) item.fn();
    // Let deliveries settle (resolved promises) before the clock moves on.
    for (let k = 0; k < 4; k++) await null;
  }
  queue = [];
  const s = seconds;
  return {
    viewers, active, seconds,
    inboundPerSecond: round(counters.inbound / s),
    deliveriesPerSecond: round(counters.deliveries / s),
    eventsPerSecond: round(counters.events / s),
    bytesPerSecond: Math.round(counters.bytes / s),
    perViewer: {
      deliveriesPerSecond: round(counters.deliveries / s / Math.max(1, viewers)),
      bytesPerSecond: Math.round(counters.bytes / s / Math.max(1, viewers)),
    },
    maxEventsPerDelivery: counters.maxEvents,
    warmupEvents: counters.warmupEvents,
  };
}

/** @param {number} v */
function round(v) {
  return Math.round(v * 10) / 10;
}
