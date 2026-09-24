// @ts-check
// Multi-user harness: the real VoteService (src/core) over in-memory storage in this page, and one
// same-origin iframe per viewer running the real dist/client.js. Arguments and results are
// structured-cloned, as over RPC. ?names=Alice,Bob,Cara picks the panes.
//
// "Restart" builds a new service over the same storage and makes every stub handed out so far
// reject forever, as the platform does after a facet restart; panes must reload themselves.

import { InMemoryRepository, VoteService } from "../src/core/store.js";

const params = new URLSearchParams(location.search);
const names = (params.get("names") || "Alice,Bob,Cara").split(",").map((s) => s.trim()).filter(Boolean);
const repo = new InMemoryRepository();
let service = new VoteService(repo);
let generation = 1;
const clientSource = fetch("/dist/client.js", { cache: "no-store" }).then((r) => r.text());

const METHODS = ["getView", "getSummaryMarkdown", "setQuestion", "addField", "removeField", "addOption", "updateOption",
  "withdrawOption", "saveRanking", "setReady", "removeBallot", "setMinVoters", "reopen", "subscribe", "unsubscribe", "ping"];

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
        return clone(await service.subscribe(stub, clone(client)));
      }
      const fn = m.startsWith("get") || m === "ping" || m === "unsubscribe"
        ? /** @type {any} */ ({ getView: (/** @type {string} */ id) => service.view(id), getSummaryMarkdown: () => service.markdown(), ping: (/** @type {string} */ c, /** @type {string} */ v) => service.ping(c, v), unsubscribe: (/** @type {string} */ c) => service.unsubscribe(c) })[m]
        : (/** @type {any} */ a) => service.write(m, a);
      return clone(await fn(...args.map(clone)));
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
  get service() { return service; },
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
  service = new VoteService(repo);
  /** @type {HTMLElement} */ (document.getElementById("log")).textContent = `restarted (generation ${generation})`;
});
