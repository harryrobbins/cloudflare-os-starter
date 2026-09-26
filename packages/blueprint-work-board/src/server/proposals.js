// @ts-check
// Proposals: changes the agent (or Jev triage, or a person) suggests, stored as `proposal:<id>`
// until a person applies them. Agents cannot write to Records; a proposal is a list of exact
// commands with reasons that the board shows in its Proposals tray. Applying runs each command
// through the person's own viewer assertion, so Records attributes the change to them; the
// proposal records who proposed it and who applied it.
//
// Changes are validated against the datastore when proposed (item existence, revisions, values)
// and again on refresh, which rebases stale changes onto the items' current revisions.

import { normaliseChange } from "../shared/insights/changes.js";
import { deleteLarge, getLarge, listLarge, putLarge } from "./large.js";

export const PROPOSAL_LIMITS = Object.freeze({ changes: 200, bytes: 128 * 1024, title: 200, reason: 2000, proposals: 200 });
const ID = /^p-[a-z0-9]{4,40}$/;
const OUTCOMES = new Set(["sent", "pending", "applied", "conflict", "rejected", "skipped", "noop"]);

/** @param {string} message */
const invalid = (message) => new Error(`invalid_request: ${message}`);
/** @param {unknown} v */
const bytes = (v) => new TextEncoder().encode(JSON.stringify(v)).byteLength;
/** @param {unknown} v @param {number} max @param {string} what */
function text(v, max, what) {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw invalid(`${what} is text.`);
  const t = v.trim();
  if (t.length > max) throw invalid(`${what} can be at most ${max} characters.`);
  return t;
}

/**
 * @typedef {{ kind: "agent"|"viewer"|"jev", actor: string|null, name: string }} Proposer
 * @typedef {{ status: string, message?: string, actionId?: number|null, at: string, by: string|null }} Outcome
 * @typedef {import("../shared/insights/changes.js").NormalisedChange & { n: number, reason: string, intent: Record<string, unknown>, stale?: boolean,
 *   outcome: Outcome|null }} ProposalChange
 * @typedef {{ id: string, title: string, reason: string, proposed_by: Proposer, created_at: string, updated_at: string,
 *   status: "open"|"applied"|"partial"|"withdrawn", changes: ProposalChange[], applied_by: { actor: string|null, name: string }|null,
 *   applied_at: string|null, withdrawn_by?: string|null, version: number }} Proposal
 */

/** @param {Proposal} p */
function settle(p) {
  const live = p.changes.filter((c) => !c.noop);
  const done = live.filter((c) => c.outcome && ["sent", "pending", "applied"].includes(c.outcome.status));
  const touched = live.filter((c) => c.outcome);
  if (p.status === "withdrawn") return;
  p.status = !touched.length ? "open" : done.length === live.length ? "applied" : "partial";
}

/**
 * @param {{ queries: ReturnType<typeof import("./query.js").createQueryCache>, storage: import("./large.js").Storage, now?: () => number,
 *   random?: () => number }} options
 */
export function createProposals({ queries, storage, now = () => Date.now(), random = Math.random }) {
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve();
  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  const serial = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

  async function context() {
    const ix = await queries.refresh();
    return { ix, ctx: { today: new Date(now()).toISOString().slice(0, 10), planning: ix.planning } };
  }

  /** @param {unknown} id @returns {Promise<Proposal>} */
  async function load(id) {
    if (typeof id !== "string" || !ID.test(id)) throw invalid("Unknown proposal id.");
    const p = await getLarge(storage, `proposal:${id}`);
    if (!p) throw new Error(`not_found: No proposal ${id}.`);
    return p;
  }

  /** @param {Proposal} p */
  async function save(p) {
    if (bytes(p) > PROPOSAL_LIMITS.bytes) throw invalid(`The proposal is larger than ${PROPOSAL_LIMITS.bytes / 1024} KiB; split it into smaller proposals.`);
    await putLarge(storage, `proposal:${p.id}`, p);
    return p;
  }

  return {
    /**
     * Stores a proposal. `changes`: [{ command, input, revision?, reason? }] with friendly values
     * (keys, names). Returns the stored proposal with each change's exact command and readable diff.
     * @param {unknown} changes
     * @param {{ title?: string, reason?: string, by?: { kind?: string, actor?: string|null, name?: string }|string, viewer?: { id?: string, displayName?: string }|null }} [opts]
     */
    propose(changes, opts = {}) {
      return serial(async () => {
        if (!Array.isArray(changes) || !changes.length) throw invalid("propose needs a non-empty list of changes: [{ command, input, reason }].");
        if (changes.length > PROPOSAL_LIMITS.changes) throw invalid(`A proposal can hold at most ${PROPOSAL_LIMITS.changes} changes.`);
        if (bytes(changes) > PROPOSAL_LIMITS.bytes) throw invalid(`The changes are larger than ${PROPOSAL_LIMITS.bytes / 1024} KiB.`);
        const o = opts && typeof opts === "object" ? opts : {};
        const title = text(o.title, PROPOSAL_LIMITS.title, "title") || `${changes.length} proposed ${changes.length === 1 ? "change" : "changes"}`;
        const reason = text(o.reason, PROPOSAL_LIMITS.reason, "reason");
        const { ix, ctx } = await context();
        /** @type {ProposalChange[]} */
        const normalised = changes.map((c, i) => {
          try {
            const n = normaliseChange(ix, c, ctx);
            return { ...n, n: i + 1, reason: text(/** @type {any} */ (c).reason, 1000, `changes[${i}].reason`), intent: structuredClone(/** @type {any} */ (c).input), outcome: null };
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            const code = /^([a-z_]+):/.exec(m)?.[1] ?? "invalid_request";
            throw new Error(`${code}: changes[${i}]: ${m.replace(/^[a-z_]+:\s*/, "")}`, { cause: err });
          }
        });
        const viewer = o.viewer && typeof o.viewer.id === "string" ? o.viewer : null;
        const by = typeof o.by === "string" ? { name: o.by } : o.by ?? {};
        /** @type {Proposer} */
        const proposedBy = viewer
          ? { kind: by.kind === "jev" ? "jev" : "viewer", actor: `cloudflare-os:${viewer.id}`, name: text(by.name, 80, "by.name") || String(viewer.displayName ?? viewer.id) }
          : { kind: by.kind === "jev" ? "jev" : "agent", actor: null, name: text(by.name, 80, "by.name") || "Workshop agent" };
        const existing = /** @type {Proposal[]} */ (await listLarge(storage, "proposal:"));
        if (existing.length >= PROPOSAL_LIMITS.proposals) {
          const closed = existing.filter((p) => p.status !== "open").toSorted((a, b) => a.updated_at.localeCompare(b.updated_at));
          if (!closed.length) throw invalid(`There are already ${PROPOSAL_LIMITS.proposals} open proposals; apply or withdraw some first.`);
          for (const p of closed.slice(0, existing.length - PROPOSAL_LIMITS.proposals + 1)) await deleteLarge(storage, `proposal:${p.id}`);
        }
        const at = new Date(now()).toISOString();
        /** @type {Proposal} */
        const p = {
          id: `p-${Math.floor(now()).toString(36)}${Math.floor(random() * 36 ** 4).toString(36).padStart(4, "0")}`, title, reason, proposed_by: proposedBy,
          created_at: at, updated_at: at, status: "open", changes: normalised, applied_by: null, applied_at: null, version: 1,
        };
        return save(p);
      });
    },

    /** Proposals, newest first. @param {{ status?: string }} [opts] status: open (default: open and partial), all, or one status */
    async listProposals(opts = {}) {
      const status = typeof opts?.status === "string" ? opts.status : "active";
      const all = /** @type {Proposal[]} */ (await listLarge(storage, "proposal:")).toSorted((a, b) => b.created_at.localeCompare(a.created_at));
      if (status === "all") return all;
      if (status === "active") return all.filter((p) => p.status === "open" || p.status === "partial");
      return all.filter((p) => p.status === status);
    },

    /** @param {unknown} id */
    getProposal: (id) => load(id),

    /** Withdraws (closes) a proposal without applying it. @param {unknown} id @param {{ actor?: string|null }} [opts] */
    withdrawProposal(id, opts = {}) {
      return serial(async () => {
        const p = await load(id);
        p.status = "withdrawn";
        p.updated_at = new Date(now()).toISOString();
        p.withdrawn_by = typeof opts?.actor === "string" ? opts.actor : null;
        p.version++;
        return save(p);
      });
    },

    /**
     * Re-validates every change not yet applied against the datastore as it is now: a change whose
     * item moved on is rebased onto the current revision (its diff recomputed from the original
     * intent), one that no longer makes sense is marked with the reason.
     * @param {unknown} id
     */
    refreshProposal(id) {
      return serial(async () => {
        const p = await load(id);
        const { ix, ctx } = await context();
        for (const c of p.changes) {
          if (c.outcome && ["sent", "pending", "applied"].includes(c.outcome.status)) continue;
          try {
            const n = normaliseChange(ix, { command: c.command, input: c.intent }, ctx);
            Object.assign(c, n, { stale: false, error: undefined });
            if (c.outcome && c.outcome.status === "conflict") c.outcome = null;
          } catch (err) {
            /** @type {any} */ (c).error = err instanceof Error ? err.message.replace(/^[a-z_]+:\s*/, "") : String(err);
          }
        }
        p.updated_at = new Date(now()).toISOString();
        p.version++;
        settle(p);
        return save(p);
      });
    },

    /**
     * Records what happened when a person applied changes (the board calls this; attribution of the
     * Records commands themselves comes from the viewer assertions).
     * @param {unknown} id @param {unknown} outcomes [{ n, status, message?, actionId? }]
     * @param {{ viewer?: { id?: string, displayName?: string }|null }} [opts]
     */
    recordProposalOutcome(id, outcomes, opts = {}) {
      return serial(async () => {
        const p = await load(id);
        if (!Array.isArray(outcomes) || outcomes.length > PROPOSAL_LIMITS.changes) throw invalid("outcomes is a list of { n, status }.");
        const viewer = opts?.viewer && typeof opts.viewer.id === "string" ? opts.viewer : null;
        const by = viewer ? String(viewer.displayName ?? viewer.id).slice(0, 80) : null;
        const at = new Date(now()).toISOString();
        for (const o of outcomes) {
          const c = p.changes.find((x) => x.n === o?.n);
          if (!c || typeof o.status !== "string" || !OUTCOMES.has(o.status)) throw invalid(`Unknown change or status: ${JSON.stringify(o).slice(0, 80)}.`);
          c.outcome = { status: o.status, message: typeof o.message === "string" ? o.message.slice(0, 500) : "", actionId: Number.isInteger(o.actionId) ? o.actionId : null, at, by };
        }
        if (viewer && !p.applied_by) { p.applied_by = { actor: `cloudflare-os:${viewer.id}`, name: /** @type {string} */ (by) }; p.applied_at = at; }
        p.updated_at = at;
        p.version++;
        settle(p);
        return save(p);
      });
    },
  };
}
