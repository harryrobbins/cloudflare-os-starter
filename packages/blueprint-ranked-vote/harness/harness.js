// @ts-check
// Multi-user harness: the real Gadget class (src/server, with `cloudflare:workers` mapped to a
// stand-in by the import map in index.html) over in-memory storage in this page, and one
// same-origin iframe per viewer running the real built client, assembled as the platform does
// (client.lib.js, then client.js). Arguments and results are structured-cloned, as over RPC.
// ?names=Alice,Bob,Cara picks the panes.
//
// "Restart" builds a new Gadget over the same storage and makes every stub handed out so far
// reject forever, as the platform does after a facet restart; panes must reload themselves.

import { Gadget } from "../src/server/index.js";

/** The slice of Durable Object KV storage the Gadget uses. */
class MemoryStorage {
  data = new Map();
  /** @param {string[]} keys */
  async get(keys) { return new Map(keys.filter((k) => this.data.has(k)).map((k) => [k, structuredClone(this.data.get(k))])); }
  /** @param {{prefix?: string}} o */
  async list({ prefix = "" } = {}) { return new Map([...this.data].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])); }
  /** @param {Record<string, any>} entries */
  async put(entries) { for (const [k, v] of Object.entries(entries)) this.data.set(k, structuredClone(v)); }
  /** @param {string[]} keys */
  async delete(keys) { for (const k of keys) this.data.delete(k); }
  /** @param {(txn: MemoryStorage) => Promise<unknown>} fn */
  async transaction(fn) { return fn(this); }
}

const params = new URLSearchParams(location.search);
const names = (params.get("names") || "Alice,Bob,Cara").split(",").map((s) => s.trim()).filter(Boolean);
const storage = new MemoryStorage();
/** @type {any} */
let server = new Gadget(/** @type {any} */ ({ storage }), {});
let generation = 1;
// The platform's client code: the library, then client.js, as one module (gadget-files.ts).
const clientSource = Promise.all(["client.lib.js", "client.js"].map((f) => fetch(`/dist/${f}`, { cache: "no-store" }).then((r) => (r.ok ? r.text() : ""))))
  .then(([lib, client]) => (lib.trim() ? `${lib}\n;\n${client}` : client));

const METHODS = Object.getOwnPropertyNames(Gadget.prototype).filter((m) => m !== "constructor");

/** @param {any} v */
const clone = (v) => (v === undefined ? v : structuredClone(v));

/** @param {string} paneId */
function makeGadget(paneId) {
  const born = generation;
  /** @type {Record<string, Function>} */
  const g = {};
  for (const m of METHODS) {
    g[m] = async (/** @type {any[]} */ ...args) => {
      await new Promise((r) => setTimeout(r, 5));
      if (born !== generation) throw new Error("Durable Object reset because its code was updated.");
      if (m === "subscribe") {
        const [target, client] = args;
        const stub = { update: (/** @type {any} */ view) => { if (born !== generation) throw new Error("gone"); return target.update(clone(view)); } };
        return clone(await server.subscribe(stub, clone(client)));
      }
      return clone(await server[m](...args.map(clone)));
    };
  }
  return g;
}

/** @type {any} */ (window).harness = {
  /** @param {string} paneId */
  connect(paneId) {
    const name = names[Number(paneId)] ?? `User ${paneId}`;
    return { gadget: makeGadget(paneId), viewer: { id: `${name.toLowerCase()}@example.com`, displayName: name, role: "build" }, exportFormat: null, clientSource };
  },
  get gadget() { return server; },
};

const panes = /** @type {HTMLElement} */ (document.getElementById("panes"));
names.forEach((name, i) => {
  const pane = document.createElement("div");
  pane.className = "pane";
  const bar = document.createElement("div");
  bar.className = "pane-bar";
  bar.textContent = name;
  const frame = document.createElement("iframe");
  frame.title = `Pane ${name}`;
  frame.dataset.pane = String(i);
  frame.src = `pane.html?pane=${i}`;
  pane.append(bar, frame);
  panes.append(pane);
});

/** @type {HTMLElement} */ (document.getElementById("restart")).addEventListener("click", () => {
  generation++;
  server = new Gadget(/** @type {any} */ ({ storage }), {});
  /** @type {HTMLElement} */ (document.getElementById("log")).textContent = `restarted (generation ${generation})`;
});
