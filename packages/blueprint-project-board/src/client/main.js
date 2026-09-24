// @ts-check
// Client entry point. Runs in the gadget's sandboxed iframe, which has no HTML of its own. The
// platform provides `gadget` (RPC stub to the Gadget Durable Object, plus host-owned `$…`
// methods such as `$createViewerAssertion`) and `gadgetViewer` (the signed-in account, used only
// to label local guesses until the server's version arrives) as module-scope bindings in a prefix
// it prepends to this file, NOT as properties of globalThis, so they are read behind `typeof`
// guards.

import { createBoardApp } from "./ui/app.js";

/* global gadget, gadgetViewer */
// @ts-ignore provided by the platform prefix
const platformGadget = typeof gadget !== "undefined" ? gadget : undefined;
// @ts-ignore provided by the platform prefix: {id, displayName, role} of the signed-in user, or null
const platformViewer = typeof gadgetViewer !== "undefined" ? gadgetViewer : null;

document.documentElement.lang = "en";
document.title = "Project board";
const root = document.createElement("div");
root.style.height = "100%";
document.body.append(root);

if (!platformGadget) {
  root.textContent = "This board runs inside a Cloudflare OS Workshop.";
} else {
  createBoardApp({ gadget: platformGadget, root, viewer: platformViewer });
}
