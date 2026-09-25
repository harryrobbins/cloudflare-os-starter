// @ts-check
// Work board gadget server. It holds no records and no state: every read and write goes to the
// Records service through the RECORDS binding (see README.md).

import { DurableObject } from "cloudflare:workers";
import { createRecordsProxy } from "./proxy.js";

export class Gadget extends DurableObject {
  /** @param {DurableObjectState} ctx @param {any} env */
  constructor(ctx, env) {
    super(ctx, env);
    this.proxy = createRecordsProxy(() => this.env);
  }

  getSetup() { return this.proxy.getSetup(); }
  connection() { return this.proxy.connection(); }
  describe() { return this.proxy.describe(); }
  model() { return this.proxy.model(); }
  /** @param {number} [limit] */
  snapshot(limit) { return this.proxy.snapshot(limit); }
  /** @param {number} [after] @param {number} [epoch] */
  changes(after, epoch) { return this.proxy.changes(after, epoch); }
  /** @param {any} [query] */
  records(query) { return this.proxy.records(query); }
  /** @param {string} command @param {any} input @param {any} options */
  command(command, input, options) { return this.proxy.command(command, input, options); }
  /** @param {number} actionId */
  getOutcome(actionId) { return this.proxy.getOutcome(actionId); }
}
