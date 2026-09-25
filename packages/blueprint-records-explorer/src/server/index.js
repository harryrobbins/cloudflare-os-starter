// Records Explorer server. It holds no records: every read goes to the Records service through
// the RECORDS binding (the connector authorises each read as an observation). The only state kept
// here is bounded presentation state (selected entity, visible columns, active tab).
import { DurableObject } from 'cloudflare:workers'
import { cursor, explorerState, recordsQuery } from '../shared/validation.js'

const STATE_KEY = 'explorerState'
export class Gadget extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.storage = ctx.storage }
  #session() { if (!this.env.RECORDS) throw new Error('not_connected: Connect a Records datastore using the RECORDS binding.'); return this.env.RECORDS }
  /** Setup summary for the UI. Never throws. */
  async getSetup() {
    if (!this.env.RECORDS) return { connected: false, connection: null, error: null }
    try { return { connected: true, connection: await this.env.RECORDS.connection(), error: null } }
    catch (error) { return { connected: true, connection: null, error: error?.message || String(error) } }
  }
  connection() { return this.#session().connection() }
  describe() { return this.#session().describe() }
  model() { return this.#session().model() }
  records(query) { return this.#session().records(recordsQuery(query)) }
  changes(after, epoch) { return this.#session().changes(cursor(after), cursor(epoch, 'epoch')) }
  async getState() { return (await this.storage.get(STATE_KEY)) ?? {} }
  async setState(state) { const clean = explorerState(state); await this.storage.put(STATE_KEY, clean); return clean }
}
