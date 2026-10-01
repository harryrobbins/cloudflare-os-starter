// The Durable Object the platform loads as this gadget's facet. It is the only file that imports
// `cloudflare:workers`; all logic lives in core.js so tests and the browser harness run it as-is.
import { DurableObject } from 'cloudflare:workers'
import { createCore } from './core.js'

export class Gadget extends DurableObject {
  /** Bounded, side-effect-free contract for describeBinding. */
  describeGadget() {
    return {
      "gadget": "tessera",
      "contract": 1,
      "summary": "Use the listed domain methods first. Connector calls require the named binding. Omitted author on supported writes is Assistant. Read README.md for the remaining low-level API.",
      "operations": [
        {
          "name": "getState",
          "description": "Read saved mosaic settings.",
          "input": {},
          "example": "await env.Blueprint.getState();",
          "returns": "Gadget state"
        },
        {
          "name": "listSources",
          "description": "Detect connected Synthetic Data sources and list tables; reads are observations.",
          "input": {},
          "example": "await env.Blueprint.listSources();",
          "returns": "Source[]"
        },
        {
          "name": "setState",
          "description": "Replace validated presentation settings. Never stores table rows.",
          "input": {
            "type": "object",
            "properties": {
              "source": {
                "type": "object",
                "properties": {},
                "required": []
              },
              "view": {
                "type": "object",
                "properties": {},
                "required": []
              }
            },
            "required": []
          },
          "example": "await env.Blueprint.setState({ source: { kind: \"demo\", key: \"titanic\" }, view: { layout: \"grid\" } });",
          "returns": "Validated state"
        },
        {
          "name": "loadTable",
          "description": "Read a bounded connector table, cached for the facet lifetime. Positional arguments: sourceId, table, options.",
          "input": {
            "type": "array",
            "prefixItems": [
              {
                "type": "string"
              },
              {
                "type": "string"
              },
              {
                "type": "object",
                "properties": {
                  "maxRows": {
                    "type": "integer",
                    "minimum": 1
                  }
                },
                "required": []
              }
            ]
          },
          "example": "await env.Blueprint.loadTable(\"PROCGEN\", \"orders\", { maxRows: 100 });",
          "returns": "{columns, rows, totalRows, ...}"
        }
      ],
      "adapt": {
        "client": "client.js: adapt block (title, actionLabel, styles, actions, onReady)",
        "server": "server.js: class Gadget",
        "readme": "README.md#adapting-this-gadget"
      }
    };
  }

  #core
  constructor(ctx, env) { super(ctx, env); this.#core = createCore({ env, storage: ctx.storage }) }
  getState() { return this.#core.getState() }
  setState(state) { return this.#core.setState(state) }
  listSources() { return this.#core.listSources() }
  loadTable(sourceId, table, options) { return this.#core.loadTable(sourceId, table, options) }
}
