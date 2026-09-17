// @ts-check
// Wave gadget server: the `Gadget` Durable Object (RPC surface in src/README.md) and the
// `ExportHandler`. The Wave's rules live in src/core/wave.js, subscriber fan-out and presence in
// src/core/hub.js and storage in src/server/do-repository.js; this file only wires them to the
// platform.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { createWave } from "../core/wave.js";
import { Hub } from "../core/hub.js";
import { DoStorageRepository } from "./do-repository.js";

// ---------------------------------------------------------------------------------------------
// Gadget: the Wave's authoritative coordinator
// ---------------------------------------------------------------------------------------------

export class Gadget extends DurableObject {
  #hub = new Hub();
  /** @type {ReturnType<typeof createWave>} */
  #wave;

  /** @param {DurableObjectState} ctx @param {any} env */
  constructor(ctx, env) {
    super(ctx, env);
    // Events are handed to the hub inside the wave's queue, right after each commit, so
    // deliveries start in sequence order. Delivery itself is not awaited: a slow subscriber must
    // not hold up the next commit. Hub deliveries never reject.
    this.#wave = createWave(new DoStorageRepository(ctx.storage), {
      onEvent: (event) => { this.#hub.broadcast(event); },
      onText: (events) => { this.#hub.broadcastText(events); },
      // The aiModel binding exposes run({prompt, systemPrompt}) -> Promise<string>. `env.Model`
      // is undefined until a model is added in Connections; once bound, every property of the
      // stub reads as a function, so the typeof check proves presence only. Evaluated per call so
      // a binding added later is seen. The signal is not forwarded: the binding cannot abort.
      model: () => (typeof env?.Model?.run === "function" ? { run: (/** @type {any} */ args, /** @type {any} */ _o) => env.Model.run(args) } : null),
    });
  }

  // --- Reads ---------------------------------------------------------------------------------

  getWave() {
    return this.#wave.getWave();
  }

  /** @param {any} args {rootId} */
  getThread(args) {
    return this.#wave.getThread(args);
  }

  /** @param {any} [args] {sinceSeq?, threadId?} */
  getWaveMarkdown(args) {
    return this.#wave.getWaveMarkdown(args);
  }

  /** @param {any} args {blipId, stateVector?} */
  openBlip(args) {
    return this.#wave.openBlip(args);
  }

  /** @param {any} args {afterSeq, limit?} */
  getChanges(args) {
    return this.#wave.getChanges(args);
  }

  /** @param {any} args {blipId, fromSeq?, toSeq?} */
  getPlayback(args) {
    return this.#wave.getPlayback(args);
  }

  /** @param {any} args {runId} */
  getRun(args) {
    return this.#wave.getRun(args);
  }

  /** @param {any} [args] {decisions?} */
  exportMarkdown(args) {
    return this.#wave.exportMarkdown(args);
  }

  // --- Text ----------------------------------------------------------------------------------

  /** @param {any} args PushTextRequest */
  pushText(args) {
    return this.#wave.pushText(args);
  }

  // --- Structure and content -----------------------------------------------------------------

  /** @param {any} args OperationRequest */
  applyOperation(args) {
    return this.#wave.applyOperation(args);
  }

  /** @param {any} args ReplyRequest */
  reply(args) {
    return this.#wave.reply(args);
  }

  /** @param {any} args ProposeRequest */
  propose(args) {
    return this.#wave.propose(args);
  }

  /** @param {any} args ReviewProposalRequest */
  reviewProposal(args) {
    return this.#wave.reviewProposal(args);
  }

  /** @param {any} args RecordDecisionRequest */
  recordDecision(args) {
    return this.#wave.recordDecision(args);
  }

  /** @param {any} args AskAgentRequest */
  askAgent(args) {
    return this.#wave.askAgent(args);
  }

  /** @param {any} args CancelRunRequest */
  cancelRun(args) {
    return this.#wave.cancelRun(args);
  }

  // --- Live updates and presence -------------------------------------------------------------

  /**
   * Keeps `callback` (duplicated, so it outlives this call) and returns the current snapshot plus
   * the subscription's `session` token. The subscriber is registered before the snapshot is read,
   * so no event is missed; events at or below the snapshot's seq may also arrive and should be
   * ignored by the client. Throws "clientId in use" (live subscription, other session) or
   * "wave is full" (LIMITS.subscribers); the duplicated stub is disposed in that case.
   * @param {any} callback RpcTarget with operation(event), text(events) and presence(events)
   * @param {any} client {clientId, name, color, session?}
   * @returns {Promise<import("../shared/protocol.js").SubscribeResult>}
   */
  async subscribe(callback, client) {
    const stub = typeof callback?.dup === "function" ? callback.dup() : callback;
    let session;
    try {
      ({ session } = this.#hub.add(stub, client));
    } catch (e) {
      if (stub !== callback) {
        try { stub?.[Symbol.dispose]?.(); } catch { /* ignore */ }
      }
      throw e;
    }
    return { ...(await this.#wave.getWave()), session };
  }

  /**
   * Presence update and heartbeat. `known: false` tells the client this instance has no
   * subscription for it (or the session does not match), so it re-subscribes.
   * @param {any} presence PresenceUpdate
   */
  async updatePresence(presence) {
    const { known } = this.#hub.updatePresence(presence);
    return { known, seq: this.#wave.seqNow() ?? await this.#wave.getSeq() };
  }

  /** @param {string} clientId @param {string} session */
  leavePresence(clientId, session) {
    this.#hub.leave(clientId, session);
  }
}

// ---------------------------------------------------------------------------------------------
// Export formats: Markdown from the server; HTML and PDF rendered by the client in export mode.
// ---------------------------------------------------------------------------------------------

export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(/** @type {any} */ _gadget) {
    return [
      { id: "markdown", label: "Markdown", mode: "server", contentType: "text/markdown", fileExtension: ".md" },
      { id: "html", label: "HTML", mode: "browser", contentType: "text/html", fileExtension: ".html" },
      { id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf", fileExtension: ".pdf" },
    ];
  }

  /** @param {any} gadget @param {string} id */
  async export(gadget, id) {
    if (id !== "markdown") throw new Error(`Unknown server export format: ${id}`);
    /** @type {any} */
    let markdown;
    try {
      markdown = await gadget.exportMarkdown({});
      return new Response(String(markdown)).body;
    } finally {
      try { markdown?.[Symbol.dispose]?.(); } catch { /* ignore */ }
    }
  }
}
