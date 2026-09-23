// @ts-check
// Every Records write from this board goes through here.
//
//   1. The input is built once and frozen as plain JSON (undefined members dropped).
//   2. Its intent digest (records-contracts `intentDigest`) is computed over exactly that input and
//      a fresh idempotency key.
//   3. The host mints a one-use viewer assertion for that digest: `$createViewerAssertion`.
//   4. The same input object and `{ idempotencyKey, viewerAssertion }` go to the gadget server,
//      which passes them to RECORDS unchanged.
//
// A write is only "applied" when Records says so. "pending" is polled with `getWriteOutcome`.
// When the call itself fails in transit the outcome is "unknown": a timeout does not prove failure,
// so "Check again" resubmits the SAME input and key under a new assertion, and Records replays the
// saved outcome if the first attempt landed. Nothing is ever retried automatically, and nothing is
// queued offline.

import { intentDigest } from "../../../records-contracts/src/caller.ts";
import { BINDING_NAME, errorCode, errorDetail } from "../shared/records.js";

/**
 * @typedef {"createIssue"|"editIssue"|"transitionIssue"|"addComment"} WriteOperation
 * @typedef {"saving"|"pending"|"applied"|"conflict"|"rejected"|"unknown"} WriteStatus
 * @typedef {{
 *   id: string, operation: WriteOperation, input: any, idempotencyKey: string, label: string,
 *   issueId: string|null, status: WriteStatus, actionId: number|null, code: string|null,
 *   message: string, record: any, currentRevision: number|null, checkFailed: boolean,
 *   startedAt: number, settledAt: number|null,
 * }} WriteEntry
 */

/** Codes that prove a call was refused, not lost in transit. */
const DEFINITE_REJECTIONS = new Set([
  "forbidden", "unauthenticated", "not_found", "validation_failed", "idempotency_conflict",
  "datastore_archived", "duplicate", "payload_too_large", "not_connected", "revision_required",
]);

/** Deep copy as plain JSON with undefined members dropped, so digest and wire agree. */
export function plainInput(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Turns a thrown error from a write call into an outcome-shaped value.
 * @param {unknown} err
 */
export function outcomeFromError(err) {
  const code = errorCode(err);
  const message = errorDetail(err) || "The write could not be sent.";
  if (code === "revision_conflict" || code === "workflow_conflict") return { status: "conflict", code, message };
  if (code && DEFINITE_REJECTIONS.has(code)) return { status: "rejected", code, message };
  return { status: "unknown", code: code ?? "transport", message };
}

/**
 * Submits one write. Resolves to a RecordsWriteOutcome, or `{status:"unknown"}` when the call was
 * lost in transit, or a local `rejected` when no assertion could be obtained.
 * @param {any} gadget
 * @param {WriteOperation} operation
 * @param {any} input exactly what is sent; must already be plain JSON
 * @param {string} idempotencyKey
 */
export async function submitWrite(gadget, operation, input, idempotencyKey) {
  const digest = await intentDigest({ operation, input, idempotencyKey });
  let viewerAssertion;
  try {
    viewerAssertion = await gadget.$createViewerAssertion(BINDING_NAME, digest);
  } catch (err) {
    return {
      status: "rejected", code: "assertion_failed",
      message: `The Workshop could not confirm this change came from you (${errorDetail(err) || "no reason given"}). Nothing was saved.`,
    };
  }
  if (typeof viewerAssertion !== "string" || !viewerAssertion) {
    return {
      status: "rejected", code: "assertion_unavailable",
      message: "The Workshop did not confirm this change came from you, so it was not sent. Only signed-in viewers can change records.",
    };
  }
  try {
    return await gadget[operation](input, { idempotencyKey, viewerAssertion });
  } catch (err) {
    return outcomeFromError(err);
  }
}

/**
 * Tracks writes and their outcomes, polling pending approvals.
 * @param {{
 *   gadget: any,
 *   onUpdate?: (entry: WriteEntry) => void,
 *   onApplied?: (entry: WriteEntry) => void,
 *   persist?: (pending: {actionId: number, idempotencyKey: string, operation: string, label: string, issueId: string|null}[]) => void,
 *   randomUUID?: () => string,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (handle: any) => void,
 * }} options
 */
export function createWriteTracker(options) {
  const { gadget } = options;
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));
  /** @type {Map<string, WriteEntry>} */
  const entries = new Map();
  /** @type {Map<string, any>} */
  const timers = new Map();
  let seq = 0;

  function notify(/** @type {WriteEntry} */ entry) {
    options.onUpdate?.(entry);
    if (entry.status === "applied") options.onApplied?.(entry);
  }

  function persist() {
    options.persist?.([...entries.values()]
      .filter((e) => e.status === "pending" && e.actionId !== null)
      .map((e) => ({ actionId: /** @type {number} */ (e.actionId), idempotencyKey: e.idempotencyKey,
        operation: e.operation, label: e.label, issueId: e.issueId })));
  }

  /** @param {WriteEntry} entry @param {any} outcome */
  function settle(entry, outcome) {
    const status = outcome?.status;
    entry.checkFailed = false;
    entry.code = null;
    entry.message = "";
    if (status === "applied") {
      entry.status = "applied";
      entry.record = outcome.record;
      entry.settledAt = now();
    } else if (status === "pending") {
      entry.status = "pending";
      entry.actionId = outcome.actionId;
      schedulePoll(entry);
    } else if (status === "conflict") {
      entry.status = "conflict";
      entry.code = outcome.code ?? "revision_conflict";
      entry.message = outcome.message ?? "";
      entry.currentRevision = typeof outcome.currentRevision === "number" ? outcome.currentRevision : null;
      entry.settledAt = now();
    } else if (status === "rejected") {
      entry.status = "rejected";
      entry.code = outcome.code ?? "rejected";
      entry.message = outcome.message ?? "";
      entry.settledAt = now();
    } else {
      entry.status = "unknown";
      entry.code = outcome?.code ?? "transport";
      entry.message = outcome?.message ?? "No answer from the Records service.";
    }
    if (entry.status !== "pending") cancelPoll(entry);
    persist();
    notify(entry);
  }

  function cancelPoll(/** @type {WriteEntry} */ entry) {
    const handle = timers.get(entry.id);
    if (handle !== undefined) clearTimer(handle);
    timers.delete(entry.id);
  }

  /** Every 5 s for the first minute, then every 20 s. */
  function schedulePoll(/** @type {WriteEntry} */ entry) {
    cancelPoll(entry);
    const delay = now() - entry.startedAt < 60_000 ? 5_000 : 20_000;
    timers.set(entry.id, setTimer(() => { timers.delete(entry.id); void checkPending(entry); }, delay));
  }

  /** @param {WriteEntry} entry */
  async function checkPending(entry) {
    if (entry.status !== "pending" || entry.actionId === null) return;
    let outcome;
    try {
      outcome = await gadget.getWriteOutcome(entry.actionId);
    } catch {
      entry.checkFailed = true;
      notify(entry);
      schedulePoll(entry);
      return;
    }
    if (entries.get(entry.id) !== entry) return;
    settle(entry, outcome);
  }

  /** @param {WriteEntry} entry */
  async function send(entry) {
    entry.status = "saving";
    entry.checkFailed = false;
    notify(entry);
    const outcome = await submitWrite(gadget, entry.operation, entry.input, entry.idempotencyKey);
    if (entries.get(entry.id) !== entry) return entry;
    settle(entry, outcome);
    return entry;
  }

  return {
    /** @returns {WriteEntry[]} */
    list() { return [...entries.values()]; },
    /** @param {string} id */
    get(id) { return entries.get(id); },

    /**
     * @param {WriteOperation} operation
     * @param {any} input
     * @param {{label: string, issueId?: string|null}} meta
     */
    start(operation, input, meta) {
      /** @type {WriteEntry} */
      const entry = {
        id: `w${++seq}`, operation, input: plainInput(input), idempotencyKey: randomUUID(),
        label: meta.label, issueId: meta.issueId ?? null, status: "saving", actionId: null, code: null,
        message: "", record: null, currentRevision: null, checkFailed: false, startedAt: now(), settledAt: null,
      };
      entries.set(entry.id, entry);
      return send(entry);
    },

    /** Resubmits an "unknown" write with the same input and key. */
    checkAgain(/** @type {string} */ id) {
      const entry = entries.get(id);
      if (!entry || entry.status !== "unknown") return Promise.resolve(entry);
      return send(entry);
    },

    /** Checks a pending approval now. */
    refreshPending(/** @type {string} */ id) {
      const entry = entries.get(id);
      if (!entry) return Promise.resolve();
      cancelPoll(entry);
      return checkPending(entry);
    },

    /** Re-adopts pending approvals remembered across a reload. */
    restore(/** @type {any[]} */ saved) {
      for (const s of Array.isArray(saved) ? saved : []) {
        if (typeof s?.actionId !== "number" || typeof s.idempotencyKey !== "string") continue;
        if ([...entries.values()].some((e) => e.actionId === s.actionId)) continue;
        /** @type {WriteEntry} */
        const entry = {
          id: `w${++seq}`, operation: s.operation, input: null, idempotencyKey: s.idempotencyKey,
          label: typeof s.label === "string" ? s.label : "Earlier change", issueId: s.issueId ?? null,
          status: "pending", actionId: s.actionId, code: null, message: "", record: null,
          currentRevision: null, checkFailed: false, startedAt: now(), settledAt: null,
        };
        entries.set(entry.id, entry);
        notify(entry);
        void checkPending(entry);
      }
    },

    dismiss(/** @type {string} */ id) {
      const entry = entries.get(id);
      if (!entry) return;
      cancelPoll(entry);
      entries.delete(id);
      persist();
    },

    dispose() {
      for (const handle of timers.values()) clearTimer(handle);
      timers.clear();
    },
  };
}
