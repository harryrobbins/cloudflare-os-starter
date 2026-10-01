import { DurableObject } from 'cloudflare:workers'
import { aggregateRequest, explorerState, name, queryRequest } from '../shared/validation.js'

const STATE_KEY = 'explorerState'
export class Gadget extends DurableObject {
  /** Bounded, side-effect-free contract for describeBinding. */
  describeGadget() {
    return {
      "gadget": "procgen-explorer",
      "contract": 1,
      "summary": "Use the listed domain methods first. Connector calls require the named binding. Omitted author on supported writes is Assistant. Read README.md for the remaining low-level API.",
      "operations": [
        {
          "name": "describeDataset",
          "description": "Describe the connected PROCGEN dataset; connector reads are observations.",
          "input": {},
          "example": "await env.Blueprint.describeDataset();",
          "returns": "Dataset description"
        },
        {
          "name": "listCollections",
          "description": "List the available collection names and counts.",
          "input": {},
          "example": "await env.Blueprint.listCollections();",
          "returns": "Collection[]"
        },
        {
          "name": "query",
          "description": "Read a bounded page; validates all query fields before delegating.",
          "input": {
            "type": "object",
            "properties": {
              "collection": {
                "type": "string"
              },
              "limit": {
                "type": "integer",
                "minimum": 1
              },
              "fields": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "predicates": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {},
                  "required": []
                }
              },
              "cursor": {
                "type": "string"
              }
            },
            "required": [
              "collection"
            ]
          },
          "example": "await env.Blueprint.query({ collection: \"orders\", limit: 10 });",
          "returns": "{records, schema, nextCursor}"
        },
        {
          "name": "aggregate",
          "description": "Compute named metrics over the collection; validates before delegating.",
          "input": {
            "type": "object",
            "properties": {
              "collection": {
                "type": "string"
              },
              "metrics": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "name": {
                      "type": "string"
                    },
                    "function": {
                      "enum": [
                        "count",
                        "sum",
                        "min",
                        "max",
                        "avg"
                      ]
                    },
                    "field": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "name",
                    "function"
                  ]
                }
              },
              "groupBy": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            },
            "required": [
              "collection",
              "metrics"
            ]
          },
          "example": "await env.Blueprint.aggregate({ collection: \"orders\", metrics: [{ name: \"total\", function: \"count\" }] });",
          "returns": "Aggregate result"
        },
        {
          "name": "getState",
          "description": "Read gadget-local presentation state.",
          "input": {},
          "example": "await env.Blueprint.getState();",
          "returns": "Explorer state"
        },
        {
          "name": "setState",
          "description": "Replace presentation state; validates everything before writing. Does not change synthetic records.",
          "input": {
            "type": "object",
            "properties": {
              "collection": {
                "type": "string"
              },
              "cursorHistory": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "query": {
                "type": "object",
                "properties": {},
                "required": []
              }
            },
            "required": []
          },
          "example": "await env.Blueprint.setState({ collection: \"orders\", cursorHistory: [] });",
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
