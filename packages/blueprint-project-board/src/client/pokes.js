// @ts-check
// Delivers Records pokes to the SyncClient.
//
// Records pokes the gadget server's persistent hook after each commit; the server keeps the latest
// head (src/server/pokes.js). A gadget server cannot call into the iframe unprompted, so each tab
// asks it `getPokes()` (a gadget-local read, not a Records read):
//
//   requested or live: every LIVE_TICK_MS; a newer head, or a legacy nudge, pokes the SyncClient,
//                      which pulls by seq from its cookie.
//   off (never requested): every POLL_MS.
//   Until the hook has delivered at least once ("active"), the channel also pulls every POLL_MS,
//   so the board still refreshes on its own.
//
// The SyncClient's own safety pull (see app.js) covers pokes lost in between. Hidden tabs skip
// ticks and catch up when shown again.

export const LIVE_TICK_MS = 3_000;
export const POLL_MS = 15_000;

/**
 * @param {{
 *   gadget: any,
 *   pollMs?: number,
 *   liveTickMs?: number,
 *   onStatus?: (s: {live: "off"|"requested"|"active", error: string|null}) => void,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (h: any) => void,
 *   isHidden?: () => boolean,
 *   now?: () => number,
 * }} options
 */
export function createPokeChannel(options) {
  const pollMs = options.pollMs ?? POLL_MS;
  const liveTickMs = options.liveTickMs ?? LIVE_TICK_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));
  const isHidden = options.isHidden ?? (() => false);
  const now = options.now ?? (() => Date.now());
  let lastFallbackPull = now();
  /** @type {"off"|"requested"|"active"} */
  let live = "off";
  let head = /** @type {number|null} */ (null);
  let nudges = /** @type {number|null} */ (null);
  let error = /** @type {string|null} */ (null);
  let timer = /** @type {any} */ (null);
  /** @type {((head: number) => void)|null} */
  let handler = null;
  let busy = false;

  const status = () => options.onStatus?.({ live, error });

  function fallbackPull() {
    if (now() - lastFallbackPull < pollMs) return;
    lastFallbackPull = now();
    handler?.(Number.POSITIVE_INFINITY);
  }

  /** Reads the gadget's poke log and pokes the client when it moved (or always when not live). */
  async function tick() {
    if (busy || !handler) return;
    busy = true;
    try {
      const s = await options.gadget.getPokes();
      live = s.live;
      error = null;
      const moved = typeof s.head === "number" && (head === null || s.head > head);
      const nudged = nudges !== null && s.nudges !== nudges;
      if (typeof s.head === "number") head = s.head;
      nudges = s.nudges;
      if (nudged) handler?.(Number.POSITIVE_INFINITY);
      else if (moved) handler?.(/** @type {number} */ (head));
      else if (live !== "active") fallbackPull();
    } catch (err) {
      // The poke log is optional: without it, pull on the slow cadence.
      error = err instanceof Error ? err.message : String(err);
      fallbackPull();
    } finally {
      busy = false;
      status();
    }
  }

  function schedule() {
    clearTimer(timer);
    if (!handler) return;
    timer = setTimer(async () => {
      if (!isHidden()) await tick();
      schedule();
    }, live === "off" ? pollMs : liveTickMs);
  }

  return {
    /** The SyncClient's `onPoke` option. Returns the unsubscribe. @param {(head: number) => void} h */
    subscribe(h) {
      handler = h;
      // Learn the current head without pulling: SyncClient.start() does the first pull itself.
      void Promise.resolve().then(() => options.gadget.getPokes()).then((/** @type {any} */ s) => {
        live = s.live;
        if (typeof s.head === "number") head = s.head;
        nudges = s.nudges;
        status();
        schedule();
      }, () => schedule());
      return () => { handler = null; clearTimer(timer); };
    },
    /** Tab became visible again: check now. */
    async wake() {
      await tick();
      schedule();
    },
    /** Ask Records for the poke hook. The Workshop owner approves it once. */
    async requestLive() {
      const s = await options.gadget.requestLiveUpdates();
      live = s.live;
      status();
      schedule();
    },
    get live() { return live; },
    tick,
  };
}
