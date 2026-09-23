// The Durable Object the platform loads as this gadget's facet. It is the only file that imports
// `cloudflare:workers`; all logic lives in core.js so tests and the browser harness run it as-is.
import { DurableObject } from 'cloudflare:workers'
import { createCore } from './core.js'

export class Gadget extends DurableObject {
  #core
  constructor(ctx, env) { super(ctx, env); this.#core = createCore({ env, storage: ctx.storage }) }
  getState() { return this.#core.getState() }
  setState(state) { return this.#core.setState(state) }
  listSources() { return this.#core.listSources() }
  loadTable(sourceId, table, options) { return this.#core.loadTable(sourceId, table, options) }
}
