// Records Explorer server. It holds no records: every read goes to the Records service through
// the RECORDS binding (the connector authorises each read as an observation). The only state kept
// here is bounded presentation state (selected entity, visible columns, active tab).
import { DurableObject } from 'cloudflare:workers'
import { cursor, explorerState, recordsQuery } from '../shared/validation.js'

const STATE_KEY = 'explorerState'
export class Gadget extends DurableObject {
  /** Bounded, side-effect-free contract for describeBinding. */
  describeGadget() {
    return {
      "gadget": "records-explorer",
      "contract": 1,
      "summary": "Use the listed domain methods first. Connector calls require the named binding. Omitted author on supported writes is Assistant. Read README.md for the remaining low-level API.",
      "operations": [
        {
          "name": "getSetup",
          "description": "Describe connection health without throwing for a missing connector.",
          "input": {},
          "example": "await env.Blueprint.getSetup();",
          "returns": "{connected, connection, error}"
        },
        {
          "name": "model",
          "description": "Read the Records model and field definitions. Requires RECORDS.",
          "input": {},
          "example": "await env.Blueprint.model();",
          "returns": "Model"
        },
        {
          "name": "records",
          "description": "Read records; validates entity/id/after/limit before delegating. Connector reads are observations.",
          "input": {
            "type": "object",
            "properties": {
              "entity": {
                "type": "string"
              },
              "limit": {
                "type": "integer",
                "minimum": 1
              },
              "id": {
                "type": "string"
              },
              "after": {
                "type": "string"
              }
            },
            "required": []
          },
          "example": "await env.Blueprint.records({ entity: \"work_item\", limit: 20 });",
          "returns": "{records, next_cursor, seq, permission_epoch}"
        },
        {
          "name": "getState",
          "description": "Read gadget-local presentation state.",
          "input": {},
          "example": "await env.Blueprint.getState();",
          "returns": "{entity?, tab?, columns?}"
        },
        {
          "name": "setState",
          "description": "Replace validated presentation state. Does not write business records.",
          "input": {
            "type": "object",
            "properties": {
              "entity": {
                "type": "string"
              },
              "tab": {
                "enum": [
                  "records",
                  "model",
                  "activity",
                  "connection"
                ]
              },
              "columns": {
                "type": "object",
                "properties": {},
                "required": []
              }
            },
            "required": []
          },
          "example": "await env.Blueprint.setState({ entity: \"work_item\", tab: \"model\" });",
          "returns": "Validated state"
        }
      ],
      "adapt": {
        "client": "client.js: adapt block (title, actionLabel, styles, actions, onReady)",
        "server": "server.js: class Gadget",
        "readme": "README.md#adapting-this-gadget"
      }
    };
  }

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
