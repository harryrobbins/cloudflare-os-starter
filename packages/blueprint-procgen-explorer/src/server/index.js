import { DurableObject } from 'cloudflare:workers'
import { aggregateRequest, explorerState, name, queryRequest } from '../shared/validation.js'

const STATE_KEY = 'explorerState'
export class Gadget extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.storage = ctx.storage }
  #session() { if (!this.env.PROCGEN) throw new Error('Connect a Synthetic Data resource using the PROCGEN binding.'); return this.env.PROCGEN }
  describeDataset() { return this.#session().describeDataset() }
  listCollections() { return this.#session().listCollections() }
  describeCollection(collection) { return this.#session().describeCollection(name(collection, 'collection')) }
  query(request) { return this.#session().query(queryRequest(request)) }
  aggregate(request) { return this.#session().aggregate(aggregateRequest(request)) }
  getRecord(collection, id) { if (typeof id !== 'string' || !id || id.length > 256) throw new Error('Invalid record id.'); return this.#session().getRecord(name(collection, 'collection'), id) }
  async getState() { return (await this.storage.get(STATE_KEY)) ?? { cursorHistory: [] } }
  async setState(state) { const clean = explorerState(state); await this.storage.put(STATE_KEY, clean); return clean }
}
