// @ts-check
// Keeps the board fresh.
//
// Live mode: once the Records change hook has delivered at least once, the tab asks the gadget
// server every 3 s for change identifiers it logged (a gadget-local read, not a Records read) and
// refetches only what changed, with a full authoritative refresh every 2 minutes as a safety net.
//
// Polling fallback: until the hook is approved and delivering (or when it is never requested), the
// tab re-reads the datastore every 15 s. The Refresh button always does a full read.
//
// Order on start follows the plan: take the change cursor first, then the snapshot, so a change
// landing during the snapshot read is seen on the next tick.

export const LIVE_TICK_MS = 3_000;
export const LIVE_SAFETY_MS = 120_000;
export const POLL_MS = 15_000;

/**
 * @param {{
 *   gadget: any,
 *   onChanges: (changes: {entityType: string, entityId: string, revision: number}[]) => Promise<void>|void,
 *   onRefetchAll: () => Promise<void>|void,
 *   onStatus?: (status: {live: string, lastRefresh: number|null, error: string|null}) => void,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (h: any) => void,
 *   isHidden?: () => boolean,
 * }} options
 */
export function createSync(options) {
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));
  const isHidden = options.isHidden ?? (() => false);
  /** @type {{epoch?: string, seq?: number}} */
  let cursor = {};
  let live = "off";
  let lastFull = /** @type {number|null} */ (null);
  let error = /** @type {string|null} */ (null);
  let timer = /** @type {any} */ (null);
  let running = false;
  let busy = false;

  const status = () => options.onStatus?.({ live, lastRefresh: lastFull, error });

  async function readFeed() {
    const feed = await options.gadget.getChanges(cursor);
    cursor = { epoch: feed.epoch, seq: feed.seq };
    live = feed.live;
    return feed;
  }

  async function full() {
    await options.onRefetchAll();
    lastFull = now();
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const feed = await readFeed();
      const due = lastFull === null || now() - lastFull >= (live === "active" ? LIVE_SAFETY_MS : POLL_MS);
      if (feed.refetchAll || due) await full();
      else if (feed.changes.length) await options.onChanges(feed.changes);
      error = null;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
      status();
    }
  }

  function schedule() {
    if (!running) return;
    clearTimer(timer);
    timer = setTimer(async () => {
      if (!isHidden()) await tick();
      schedule();
    }, live === "active" ? LIVE_TICK_MS : POLL_MS);
  }

  return {
    /** Takes the change cursor, then the first snapshot. */
    async start() {
      running = true;
      try { await readFeed(); } catch { /* feed is optional; polling still works */ }
      await full();
      status();
      schedule();
    },
    /** Full authoritative refresh now (the Refresh button). */
    async refreshNow() {
      try { await readFeed(); } catch { /* ignore */ }
      await full();
      error = null;
      status();
      schedule();
    },
    /** Called when the tab becomes visible again. */
    async wake() {
      await tick();
      schedule();
    },
    /** Ask for the Records change hook. The Workshop owner approves it once. */
    async requestLive() {
      const feed = await options.gadget.requestLiveUpdates();
      live = feed.live;
      status();
      schedule();
    },
    stop() {
      running = false;
      clearTimer(timer);
    },
    get live() { return live; },
    tick,
  };
}
