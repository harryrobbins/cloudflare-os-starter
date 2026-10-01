// @ts-check
// Multi-user harness: the real ArcadeService (bundled by scripts/build.mjs into
// dist/harness-core.js, with the starter games and tunes) over in-memory storage in this page, and
// one same-origin iframe per player running the real dist/client.js. Arguments and results are
// structured-cloned, as over RPC. ?names=Alice,Bob picks the panes.
//
// "Restart" builds a new service over the same storage and makes every stub handed out so far
// reject forever, as the platform does after a facet restart; panes must reload themselves.

// @ts-ignore built file
import { ArcadeService, InMemoryRepository, TEMPLATES, STARTER_TUNES } from "../dist/harness-core.js";

const params = new URLSearchParams(location.search);
const names = (params.get("names") || "Alice,Bob").split(",").map((s) => s.trim()).filter(Boolean);
const repo = new InMemoryRepository();
const make = () => new ArcadeService(repo, { templates: TEMPLATES, starterTunes: STARTER_TUNES });
let service = make();
let generation = 1;
const clientSource = Promise.all(["client.lib.js", "client.js"].map(file => fetch("/dist/" + file, { cache: "no-store" }).then(r => { if (!r.ok) throw new Error(file + " missing"); return r.text(); }))).then(parts => parts.join("\n;\n"));

const READS = {
  getView: (/** @type {string} */ id) => service.view(id),
  getGame: (/** @type {string} */ id) => service.read((/** @type {any} */ a) => a.getGame(id)),
  getTune: (/** @type {string} */ id) => service.read((/** @type {any} */ a) => a.getTune(id)),
  getTemplates: () => TEMPLATES,
  getSummaryMarkdown: () => service.read((/** @type {any} */ a) => a.summaryMarkdown()),
  ping: (/** @type {string} */ c, /** @type {string} */ v) => service.ping(c, v),
  unsubscribe: (/** @type {string} */ c) => service.unsubscribe(c),
};
const WRITES = ["setTitle", "createGame", "saveGame", "updateGame", "duplicateGame", "resetGame", "deleteGame", "moveGame",
  "submitScore", "clearScores", "createTune", "saveTune", "duplicateTune", "deleteTune", "setPrefs"];

/** @param {any} v */
const clone = (v) => (v === undefined ? v : structuredClone(v));

function makeGadget() {
  const born = generation;
  /** @type {Record<string, Function>} */
  const g = {};
  for (const m of [...Object.keys(READS), ...WRITES, "subscribe"]) {
    g[m] = async (/** @type {any[]} */ ...args) => {
      await new Promise((r) => setTimeout(r, 5));
      if (born !== generation) throw new Error("Durable Object reset because its code was updated.");
      if (m === "subscribe") {
        const [target, client] = args;
        const stub = { update: (/** @type {any} */ view) => { if (born !== generation) throw new Error("gone"); return target.update(clone(view)); } };
        return clone(await service.subscribe(stub, clone(client)));
      }
      const fn = /** @type {any} */ (READS)[m] ?? ((/** @type {any} */ a) => service.write(m, a));
      return clone(await fn(...args.map(clone)));
    };
  }
  return g;
}

/** @type {any} */ (window).harness = {
  /** @param {string} paneId */
  connect(paneId) {
    const name = names[Number(paneId)] ?? `User ${paneId}`;
    return { gadget: makeGadget(), viewer: { id: `${name.toLowerCase()}@example.com`, displayName: name, role: "build" }, exportFormat: null, clientSource };
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
  // The platform's sandbox, plus allow-same-origin so the harness can reach in.
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups");
  frame.src = `pane.html?pane=${i}`;
  pane.append(bar, frame);
  panes.append(pane);
});

/** @type {HTMLElement} */ (document.getElementById("restart")).addEventListener("click", () => {
  generation++;
  service = make();
  /** @type {HTMLElement} */ (document.getElementById("log")).textContent = `restarted (generation ${generation})`;
});
