// @ts-check
// The connection/save state machine, as pure functions the store, the status UI and main.js share.
// No DOM, no timers of its own (ConnectionAnnouncer takes injectable ones), so it runs in Node tests.
//
// States (ClientState.connection):
//   connecting         no initial snapshot yet
//   live               subscribed, nothing pending: every local change is acknowledged ("Saved")
//   saving             subscribed, with queued or in-flight changes (or a server undo awaiting its result)
//   reconnecting       the subscription or RPC target is being replaced; the queue is kept
//   recovery-required  the automatic recovery budget is exhausted; pending work may exist.
//                      Retries continue: a later success returns to live/saving.
//   read-only          the session lacks edit authority. Defined for Phase 4; never produced yet.
//
// The transport underneath has only three states (`link`): connecting, live, reconnecting. The
// store derives the visible state from the link, the queue and the recovery flag with deriveState.

/** @typedef {import("../store-contract.js").ConnectionState} ConnectionState */
/** @typedef {"connecting"|"live"|"reconnecting"} LinkState */

/** @type {readonly ConnectionState[]} */
export const CONNECTION_STATES = /** @type {const} */ (["connecting", "live", "saving", "reconnecting", "recovery-required", "read-only"]);

/** A change still unacknowledged after this long while the link is live counts as at risk. */
export const SLOW_SAVE_MS = 5000;
/** A reconnect is announced to screen readers only once it has lasted this long. */
export const ANNOUNCE_RECONNECT_AFTER_MS = 1500;
/**
 * Interim (until the host can replace the RPC target): how long main.js holds the recovery screen,
 * with unsaved changes, before it may reload on its own. Reloading loses those changes.
 */
export const TERMINAL_RECOVERY_MS = 5 * 60_000;

/**
 * @param {{link: LinkState, pendingCount: number, busy?: boolean, recoveryRequired?: boolean, readOnly?: boolean}} input
 *   busy: an unacknowledged call outside the queue (a server undo) is outstanding
 * @returns {ConnectionState}
 */
export function deriveState({ link, pendingCount, busy = false, recoveryRequired = false, readOnly = false }) {
  if (link === "live") {
    if (readOnly) return "read-only";
    return pendingCount > 0 || busy ? "saving" : "live";
  }
  if (recoveryRequired) return "recovery-required";
  return link;
}

/**
 * Whether reloading now may lose a change: something is unacknowledged and it is not being saved
 * normally (the link is down, or the oldest change has waited SLOW_SAVE_MS or more).
 * @param {{state: ConnectionState, pendingCount: number, oldestPendingAt: number|null, now: number}} input
 */
export function riskOfLoss({ state, pendingCount, oldestPendingAt, now }) {
  if (pendingCount <= 0) return false;
  if (state !== "saving" && state !== "live") return true;
  return oldestPendingAt !== null && now - oldestPendingAt >= SLOW_SAVE_MS;
}

/** @param {number} n */
export function changesText(n) {
  return `${n} unsaved ${n === 1 ? "change" : "changes"}`;
}

/**
 * What the status chip shows. `label` is short visible text; `detail` a fuller sentence for the
 * chip's accessible description and tooltip (it names the risk when reload may lose a change).
 * @param {{connection: ConnectionState, pendingCount: number, riskOfLoss: boolean}} s
 * @returns {{label: string, detail: string, warn: boolean}}
 */
export function statusText(s) {
  const n = s.pendingCount;
  const loss = s.riskOfLoss && n > 0 ? ` Reloading now would lose ${n === 1 ? "it" : "them"}.` : "";
  switch (s.connection) {
    case "live":
      return { label: "Saved", detail: "Connected. All changes saved.", warn: false };
    case "saving":
      if (s.riskOfLoss) return { label: changesText(n), detail: `Saving is taking longer than usual: ${changesText(n)}.${loss}`, warn: true };
      return { label: "Saving…", detail: n > 1 ? `Saving ${n} changes.` : "Saving.", warn: false };
    case "reconnecting":
      return n
        ? { label: `Reconnecting · ${n} unsaved`, detail: `Reconnecting. ${changesText(n)} will be sent once connected.${loss}`, warn: true }
        : { label: "Reconnecting…", detail: "Reconnecting. All changes saved.", warn: false };
    case "recovery-required":
      return n
        ? { label: `Connection lost · ${n} unsaved`, detail: `Connection lost. ${changesText(n)}.${loss}`, warn: true }
        : { label: "Connection lost", detail: "Connection lost. All changes saved.", warn: true };
    case "read-only":
      return { label: "View only", detail: "You can view this whiteboard but not change it.", warn: false };
    default:
      return { label: "Connecting…", detail: "Connecting to the whiteboard.", warn: false };
  }
}

/**
 * Screen-reader announcements for meaningful transitions only: not live <-> saving (every edit),
 * not each retry, and not a reconnect that is over within ANNOUNCE_RECONNECT_AFTER_MS.
 */
export class ConnectionAnnouncer {
  /**
   * @param {(message: string) => void} announce
   * @param {{setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (id: any) => void}} [timers]
   */
  constructor(announce, timers = /** @type {any} */ (globalThis)) {
    this.announce = announce;
    this.timers = timers;
    /** @type {ConnectionState|null} */
    this.prev = null;
    this.prevRisk = false;
    /** whether a "connection lost/reconnecting" message was spoken for the current outage */
    this.announcedOutage = false;
    /** @type {any} */
    this.timer = null;
    /** @type {{connection: ConnectionState, pendingCount: number, riskOfLoss: boolean}|null} */
    this.latest = null;
  }

  /** @param {{connection: ConnectionState, pendingCount: number, riskOfLoss: boolean}} s */
  update(s) {
    this.latest = s;
    const prev = this.prev;
    const next = s.connection;
    this.prev = next;
    const riskStarted = s.riskOfLoss && !this.prevRisk;
    this.prevRisk = s.riskOfLoss;
    if (prev === null || prev === next) {
      if (riskStarted && next === "saving") {
        this.announce(`Saving is taking longer than usual. ${changesText(s.pendingCount)}; reloading now would lose them.`);
      }
      return;
    }
    const up = next === "live" || next === "saving" || next === "read-only";
    if (up) {
      this.cancel();
      if (this.announcedOutage) {
        this.announcedOutage = false;
        const n = s.pendingCount;
        this.announce(next === "saving" && n ? `Reconnected. Saving ${n} ${n === 1 ? "change" : "changes"}.` : "Reconnected. All changes saved.");
      }
      return;
    }
    if (next === "recovery-required") {
      this.cancel();
      this.announcedOutage = true;
      this.announce(s.pendingCount
        ? `Connection lost. ${changesText(s.pendingCount)}; reloading now would lose them.`
        : "Connection lost. All changes are saved.");
      return;
    }
    if (next === "reconnecting" && !this.announcedOutage && !this.timer) {
      this.timer = this.timers.setTimeout(() => {
        this.timer = null;
        const l = this.latest;
        if (!l || l.connection !== "reconnecting") return;
        this.announcedOutage = true;
        this.announce(l.pendingCount
          ? `Reconnecting. ${changesText(l.pendingCount)} will be sent once connected.`
          : "Reconnecting. All changes are saved.");
      }, ANNOUNCE_RECONNECT_AFTER_MS);
    }
  }

  cancel() {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * Interim policy for main.js when the store reports the connection as unrecoverable (the platform
 * cannot yet replace the iframe's RPC stub, so only a reload of the frame reconnects):
 *   reload  nothing is unacknowledged (or the terminal timeout has passed) and the auto-reload
 *           budget allows it;
 *   hold    changes are unacknowledged: show the recovery screen, never reload on our own;
 *   stop    the auto-reload budget is spent: ask the user to reload.
 * @param {{pendingCount: number, heldForMs: number, recentReloads: number, maxReloads: number}} input
 *   heldForMs: how long the recovery screen has been showing (0 when not yet shown)
 * @returns {"reload"|"hold"|"stop"}
 */
export function recoveryAction({ pendingCount, heldForMs, recentReloads, maxReloads }) {
  if (pendingCount > 0 && heldForMs < TERMINAL_RECOVERY_MS) return "hold";
  return recentReloads >= maxReloads ? "stop" : "reload";
}

/** Identifies a recovery download. */
export const RECOVERY_FORMAT = "whiteboard-recovery";
export const RECOVERY_VERSION = 1;
