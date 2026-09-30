// Multi-user harness for Docs with Drawings: the REAL Docs server (src/server/index.js, bundled
// by serve.mjs with "cloudflare:workers" shimmed) over in-memory storage, and one iframe per
// pane running the real built dist/client.js with its own `gadget` proxy.
//
// Transport: every call and callback is asynchronous; arguments and results are structured-
// cloned so nothing aliases across "the wire"; RpcTarget instances cross by reference, wrapped
// in a stub with dup() and [Symbol.dispose](). Errors cross as plain Errors, like Workers RPC.
//
// URL parameters: panes=1..4 (default 2), names=Ann,Bob, export=html (adds an export pane).

import { Gadget } from "./server.js";
import { MemoryStorage } from "./memory-storage.js";

const params = new URLSearchParams(location.search);
const storage = new MemoryStorage();
const server = new Gadget({ storage, id: { toString: () => "harness" } }, {});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function cross(value) {
  try {
    return structuredClone(value);
  } catch (err) {
    throw new Error("harness: value cannot cross RPC: " + err.message);
  }
}

/** A server-side stub for an RpcTarget a pane passed in. */
function stubFor(target) {
  const stub = new Proxy({}, {
    get(_obj, name) {
      if (name === "dup") return () => stub;
      if (name === Symbol.dispose) return () => {};
      if (name === "then") return undefined;
      return async (...args) => {
        await tick();
        const fn = target[name];
        if (typeof fn !== "function") throw new Error(`The RPC receiver does not implement the method "${String(name)}".`);
        return cross(await fn.apply(target, args.map(cross)));
      };
    },
  });
  return stub;
}

/** The `gadget` a pane sees: every method call crosses to the server. */
function gadgetFor(RpcTargetClass) {
  return new Proxy({}, {
    get(_obj, name) {
      if (name === "then" || typeof name === "symbol") return undefined;
      return async (...args) => {
        const wire = args.map((a) => (a instanceof RpcTargetClass ? stubFor(a) : cross(a)));
        await tick();
        const fn = server[name];
        if (typeof fn !== "function" || name === "constructor" || String(name).startsWith("#")) {
          throw new Error(`The RPC receiver does not implement the method "${String(name)}".`);
        }
        try {
          return cross(await fn.apply(server, wire));
        } catch (err) {
          throw new Error(err?.message ?? String(err));
        }
      };
    },
  });
}

const names = (params.get("names") || "").split(",").filter(Boolean);
const count = Math.min(4, Math.max(1, Number(params.get("panes") || 2)));
const panes = new Map();

function addPane(index, exportFormat = null) {
  const id = String(index);
  const name = names[index] || `User ${String.fromCharCode(65 + index)}`;
  const box = document.createElement("div");
  box.className = "pane";
  const label = document.createElement("b");
  label.textContent = exportFormat ? `Export (${exportFormat})` : name;
  const frame = document.createElement("iframe");
  // The platform's sandbox minus popups, plus allow-same-origin so this page can reach in.
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  frame.dataset.pane = id;
  frame.src = `./pane.html?pane=${id}`;
  box.append(label, frame);
  document.getElementById("panes").appendChild(box);
  panes.set(id, { name, exportFormat, frame });
}

window.harness = {
  server,
  storage,
  connect(paneId, _win, RpcTargetClass) {
    const pane = panes.get(paneId);
    const clientSource = fetch("../dist/client.js", { cache: "no-store" }).then((r) => {
      if (!r.ok) throw new Error("build the client first: node scripts/build.mjs");
      return r.text();
    });
    return {
      gadget: gadgetFor(RpcTargetClass),
      viewer: { id: pane.name.toLowerCase().replace(/\W+/g, ""), displayName: pane.name, role: "owner" },
      exportFormat: pane.exportFormat,
      clientSource,
    };
  },
  /** Adds an export-mode pane after the fact (after content exists). */
  addExportPane(format = "html") {
    addPane(panes.size, format);
  },
};

for (let i = 0; i < count; i++) addPane(i);
if (params.get("export")) addPane(count, params.get("export"));
