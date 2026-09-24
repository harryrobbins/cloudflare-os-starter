// @ts-check
// Ranked Vote gadget server: the `Gadget` Durable Object (RPC surface in src/README.md) and the
// `ExportHandler`. Rules live in src/core/vote.js, persistence and fan-out in src/core/store.js;
// this file only wires them to the platform.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { VoteService } from "../core/store.js";

const BATCH = 128;

/** Durable Object storage behind the Repository seam; a write is one transaction. */
class DoRepository {
  /** @param {any} storage */
  constructor(storage) { this.storage = storage; }
  /** @param {string[]} keys */
  get(keys) { return this.storage.get(keys); }
  /** @param {string} prefix */
  list(prefix) { return this.storage.list({ prefix }); }
  /** @param {Record<string, any>} puts @param {string[]} deletes */
  async write(puts, deletes) {
    const entries = Object.entries(puts);
    await this.storage.transaction(async (/** @type {any} */ txn) => {
      for (let i = 0; i < deletes.length; i += BATCH) await txn.delete(deletes.slice(i, i + BATCH));
      for (let i = 0; i < entries.length; i += BATCH) await txn.put(Object.fromEntries(entries.slice(i, i + BATCH)));
    });
  }
}

export class Gadget extends DurableObject {
  /** @param {DurableObjectState} ctx @param {unknown} env */
  constructor(ctx, env) {
    super(ctx, /** @type {any} */ (env));
    this.service = new VoteService(new DoRepository(ctx.storage));
  }

  // --- Reads ---------------------------------------------------------------------------------

  /** Everything `voterId` may see: options, fields, who is ready, their own ballot, results. @param {string} voterId */
  getView(voterId) { return this.service.view(voterId); }

  /** Question, options with fields, voters and every count, as Markdown. Never includes ballots. */
  getSummaryMarkdown() { return this.service.markdown(); }

  // --- Writes (every args object carries by = {id, name} of the signed-in account) -----------

  /** @param {any} args {by, question} */
  setQuestion(args) { return this.service.write("setQuestion", args); }
  /** @param {any} args {by, label, kind: "text"|"long"|"url"} */
  addField(args) { return this.service.write("addField", args); }
  /** @param {any} args {by, fieldId} */
  removeField(args) { return this.service.write("removeField", args); }
  /** @param {any} args {by, title, values?: {fieldId: string}} */
  addOption(args) { return this.service.write("addOption", args); }
  /** @param {any} args {by, optionId, title?, values?} */
  updateOption(args) { return this.service.write("updateOption", args); }
  /** @param {any} args {by, optionId} */
  withdrawOption(args) { return this.service.write("withdrawOption", args); }
  /** @param {any} args {by, ranking: optionId[]} */
  saveRanking(args) { return this.service.write("saveRanking", args); }
  /** @param {any} args {by, ready: boolean, ranking?} */
  setReady(args) { return this.service.write("setReady", args); }
  /** @param {any} args {by, voterId} */
  removeBallot(args) { return this.service.write("removeBallot", args); }
  /** @param {any} args {by, minVoters} the count waits for at least this many ballots */
  setMinVoters(args) { return this.service.write("setMinVoters", args); }
  /** @param {any} args {by} */
  reopen(args) { return this.service.write("reopen", args); }

  // --- Live updates --------------------------------------------------------------------------

  /**
   * Keeps `callback` (an RpcTarget with update(view)), duplicated so it outlives this call, and
   * returns the current view. update(view) is then called after every change.
   * @param {any} callback @param {any} client {clientId, voterId}
   */
  subscribe(callback, client) {
    const stub = typeof callback?.dup === "function" ? callback.dup() : callback;
    return this.service.subscribe(stub, client);
  }

  /** @param {string} clientId */
  unsubscribe(clientId) { this.service.unsubscribe(clientId); }

  /** @param {string} clientId @param {string} voterId */
  ping(clientId, voterId) { return this.service.ping(clientId, voterId); }
}

export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(/** @type {any} */ _gadget) {
    return [{ id: "summary", label: "Options and results (Markdown)", mode: "server", contentType: "text/markdown", fileExtension: ".md" }];
  }

  /** @param {any} gadget @param {string} id */
  async export(gadget, id) {
    if (id !== "summary") throw new Error(`Unknown export format: ${id}`);
    return new Response(await gadget.getSummaryMarkdown()).body;
  }
}
