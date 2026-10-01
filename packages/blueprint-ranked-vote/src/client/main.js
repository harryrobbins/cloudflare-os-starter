// @ts-check
// Runs inside the gadget's sandboxed iframe, which has no HTML of its own. Provided by the platform:
// `gadget` (RPC stub to the Gadget Durable Object), `gadgetViewer` (the signed-in account) and
// `RpcTarget`, declared as module-scope bindings in a prefix the platform prepends (NOT properties
// of globalThis), so they are read as free identifiers behind `typeof` guards.
//
// This file is the main view: the adapt block, then the page it composes. The engine (sections,
// drag and drop, live sync, styles) is in client.lib.js, bundled from
// packages/blueprint-ranked-vote/src/client/{app,connect,styles}.js.

import { mountApp, h } from "./app.js";
import { connectVote } from "./connect.js";
import { injectStyles } from "./styles.js";

/* global gadget, gadgetViewer, RpcTarget */
// @ts-ignore provided by the platform prefix
const platformGadget = typeof gadget !== "undefined" ? gadget : undefined;
// @ts-ignore provided by the platform prefix
const platformRpcTarget = typeof RpcTarget !== "undefined" ? RpcTarget : Object;
// @ts-ignore provided by the platform prefix: {id, displayName, role} of the signed-in user
const platformViewer = typeof gadgetViewer !== "undefined" ? gadgetViewer : undefined;

// ===== Adapt this gadget =====================================================
// Settings and extension points, honoured by client.lib.js. Change these rather than the library.
// README.md ("Adapting this gadget") documents every field and the `app` handle.
const adapt = {
  title: "Ranked vote",          // the page title
  labels: {                      // button and heading text
    reveal: "Reveal", undoReveal: "Undo Reveal", propose: "Propose an option",
    ranking: "Your ranking", results: "Results", fields: "Fields", activity: "Activity",
  },
  // Which sections show, in which column and order. Built in: results, add (the propose form),
  // ranking, ready (Reveal and voters), fields, activity. Add a panel's name to show it.
  layout: {
    main: ["results", "add", "ranking"],
    side: ["ready", "fields", "activity"],
  },
  // Extra sections: name -> (app) => Node | string | array, redrawn after every change. Build
  // nodes with h(tag, props, children), e.g. h("h2", { text: "Hello" }).
  panels: {},
  showRoundTable: true,          // the results table, one column per round
  showRoundStory: true,          // the round-by-round explanation under it
  styles: "",                    // extra CSS, applied after the built-in styles
  // Extra commands, shown as buttons in a toolbar under the question:
  // { id, label, title?, run(app) }. run may be async; a thrown error shows as a message.
  actions: [
  ],
  onReady(app) {},               // called once, when the first view has arrived, with the app handle
};
// ==============================================================================

/** The signed-in account. Every change is attributed to it; nobody is asked for a name. */
function account() {
  const v = platformViewer;
  const id = typeof v?.id === "string" && v.id.trim() ? v.id.trim() : "";
  const name = typeof v?.displayName === "string" && v.displayName.trim() ? v.displayName.trim() : id;
  return id ? { id, name } : null;
}

if (!document.documentElement.lang) document.documentElement.lang = "en";
if (!document.head.querySelector("meta[name=viewport]")) {
  document.head.append(Object.assign(document.createElement("meta"), { name: "viewport", content: "width=device-width, initial-scale=1" }));
}
document.title = adapt.title;
injectStyles(adapt.styles);
const root = document.createElement("div");
document.body.appendChild(root);

const me = account();
if (!platformGadget) {
  root.textContent = "This page runs inside a Cloudflare OS gadget.";
} else if (!me) {
  root.textContent = "This vote needs to know who you are, and the platform did not say. Reload the page, or update Cloudflare OS.";
} else {
  const connection = connectVote({ gadget: platformGadget, RpcTarget: platformRpcTarget, me });
  const controller = mountApp(root, { me, call: connection.call, onRetry: connection.retry, adapt });
  connection.start(controller);
  /** @type {any} */ (globalThis).rankedVote = { app: controller.app };
}
