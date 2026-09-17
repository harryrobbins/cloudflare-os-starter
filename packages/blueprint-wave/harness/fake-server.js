// @ts-check
// The Gadget RPC surface over the REAL Wave rules (src/core/wave.js) and subscriber hub
// (src/core/hub.js), running in the browser. Mirrors src/server/index.js method for method, minus
// the Durable Object, the platform's Y.Doc cache bits and the `env.Model` adapter: the model here
// is a `createFakeModel` instance (harness/fake-model.js) or null, swapped at any time through
// `setModel`, and read by the core per askAgent, so `capabilities.model` follows it.
//
// Binary on the wire is base64 (src/shared/protocol.js), so the harness' structured clone of
// arguments and results passes every update, state vector and relative position through as a
// plain string; nothing here special-cases typed arrays.

import { createWave } from "../src/core/wave.js";
import { Hub } from "../src/core/hub.js";

/** @typedef {import("./fake-model.js").FakeModel} FakeModel */

export class FakeGadget {
  /**
   * @param {import("../src/core/repository.js").Repository} repo
   * @param {{hub?: ConstructorParameters<typeof Hub>[0], model?: FakeModel|null,
   *   timers?: any, now?: () => number}} [options]
   */
  constructor(repo, { hub, model = null, timers, now } = {}) {
    this.hub = new Hub(hub);
    /** @type {FakeModel|null} */
    this.model = model;
    // Events are handed to the hub inside the core's queue, right after each commit, so
    // deliveries start in seq order; delivery itself is not awaited (hub deliveries never reject).
    this.wave = createWave(repo, {
      onEvent: (event) => { this.hub.broadcast(event); },
      onText: (events) => { this.hub.broadcastText(events); },
      // Evaluated per askAgent, like a binding added in Connections after the instance started.
      model: () => this.model,
      ...(timers ? { timers } : {}),
      ...(now ? { now } : {}),
    });
  }

  /** @param {FakeModel|null} model */
  setModel(model) { this.model = model; }

  // --- Reads ---------------------------------------------------------------------------------

  getWave() { return this.wave.getWave(); }
  /** @param {any} args {rootId} */
  getThread(args) { return this.wave.getThread(args); }
  /** @param {any} [args] {sinceSeq?, threadId?} */
  getWaveMarkdown(args) { return this.wave.getWaveMarkdown(args ?? {}); }
  /** @param {any} args {blipId, stateVector?} */
  openBlip(args) { return this.wave.openBlip(args); }
  /** @param {any} args {afterSeq, limit?} */
  getChanges(args) { return this.wave.getChanges(args); }
  /** @param {any} args {blipId, fromSeq?, toSeq?} */
  getPlayback(args) { return this.wave.getPlayback(args); }
  /** @param {any} args {runId} */
  getRun(args) { return this.wave.getRun(args); }
  /** @param {any} [args] {decisions?} */
  exportMarkdown(args) { return this.wave.exportMarkdown(args ?? {}); }

  // --- Text ----------------------------------------------------------------------------------

  /** @param {any} args PushTextRequest */
  pushText(args) { return this.wave.pushText(args); }

  // --- Structure and content -----------------------------------------------------------------

  /** @param {any} request OperationRequest */
  applyOperation(request) { return this.wave.applyOperation(request); }
  /** @param {any} args ReplyRequest */
  reply(args) { return this.wave.reply(args); }
  /** @param {any} args ProposeRequest */
  propose(args) { return this.wave.propose(args); }
  /** @param {any} args ReviewProposalRequest */
  reviewProposal(args) { return this.wave.reviewProposal(args); }
  /** @param {any} args RecordDecisionRequest */
  recordDecision(args) { return this.wave.recordDecision(args); }
  /** @param {any} args AskAgentRequest */
  askAgent(args) { return this.wave.askAgent(args); }
  /** @param {any} args CancelRunRequest */
  cancelRun(args) { return this.wave.cancelRun(args); }

  // --- Live updates and presence -------------------------------------------------------------

  /**
   * Keeps `callback` (duplicated, so it outlives this call) and returns the current snapshot plus
   * the subscription's `session`. The subscriber is registered before the snapshot is read, so no
   * event is missed. Throws "clientId in use" or "wave is full"; the dup is disposed then.
   * @param {any} callback RpcTarget with operation(event), text(events) and presence(events)
   * @param {any} client {clientId, name, color, session?}
   */
  async subscribe(callback, client) {
    const stub = typeof callback?.dup === "function" ? callback.dup() : callback;
    let session;
    try {
      ({ session } = this.hub.add(stub, client));
    } catch (e) {
      if (stub !== callback) {
        try { stub?.[Symbol.dispose]?.(); } catch { /* ignore */ }
      }
      throw e;
    }
    return { ...(await this.wave.getWave()), session };
  }

  /** @param {any} presence PresenceUpdate */
  async updatePresence(presence) {
    const { known } = this.hub.updatePresence(presence);
    return { known, seq: this.wave.seqNow() ?? await this.wave.getSeq() };
  }

  /** @param {string} clientId @param {string} session */
  leavePresence(clientId, session) { this.hub.leave(clientId, session); }

  /** Resolves once the core's queue, its dispatcher and the hub are idle. */
  async settled() {
    await this.wave.settled();
    await this.hub.settled();
  }
}

/** Method names a pane's `gadget` proxy may call: the README's RPC surface plus the live trio. */
export const RPC_METHODS = new Set([
  "getWave", "getThread", "getWaveMarkdown", "openBlip", "getChanges", "getPlayback", "getRun",
  "exportMarkdown", "pushText", "applyOperation", "reply", "propose", "reviewProposal",
  "recordDecision", "askAgent", "cancelRun", "subscribe", "updatePresence", "leavePresence",
]);
