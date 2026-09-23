// @ts-check
// Client entry point. Runs in the gadget's sandboxed iframe, which has no HTML of its own. The
// platform provides `gadget` (RPC stub to the Gadget Durable Object, plus host-owned `$…`
// methods such as `$createViewerAssertion`) as a module-scope binding in a prefix it prepends to
// this file, NOT as a property of globalThis, so it is read behind a `typeof` guard.

import { createBoardApp } from "./ui/app.js";

/* global gadget */
// @ts-ignore provided by the platform prefix
const platformGadget = typeof gadget !== "undefined" ? gadget : undefined;

document.documentElement.lang = "en";
document.title = "Project board";
const root = document.createElement("div");
root.style.height = "100%";
document.body.append(root);

if (!platformGadget) {
  root.textContent = "This board runs inside a Cloudflare OS Workshop.";
} else {
  createBoardApp({ gadget: platformGadget, root });
}
