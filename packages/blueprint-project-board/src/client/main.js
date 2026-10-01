import { mountAdapt } from "../../../../scripts/blueprint-adapt/client.mjs";
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

// ===== Adapt this gadget =====================================================
// README.md ("Adapting this gadget") documents each setting and the app handle.
const adapt = {
  title: 'Project Board',
  actionLabel: "Extra actions",
  styles: "",
  actions: [],
  onReady(app) {},
};
// ============================================================================

document.documentElement.lang = "en";
document.title = "Project board";
const root = document.createElement("div");
root.style.height = "100%";
document.body.append(root);

if (!platformGadget) {
  root.textContent = "This board runs inside a Cloudflare OS Workshop.";
} else {
  const app = createBoardApp({ gadget: platformGadget, root, viewer: platformViewer });
  await mountAdapt(adapt, { gadget: platformGadget, methods: ["getSetup", "listProjects", "getWorkflow", "listAssignees", "listIssues", "getIssue", "listComments"], ready: app.ready, refresh: () => app.refresh() });
}
