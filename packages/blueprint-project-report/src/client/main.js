import { mountAdapt } from "../../../../scripts/blueprint-adapt/client.mjs";
// @ts-check
// Client entry point. The platform provides `gadget` as a module-scope binding in a prefix it
// prepends to this file (not on globalThis), so it is read behind a `typeof` guard.

import { createReportApp } from "./app.js";

/* global gadget */
// @ts-ignore provided by the platform prefix
const platformGadget = typeof gadget !== "undefined" ? gadget : undefined;

// ===== Adapt this gadget =====================================================
// README.md ("Adapting this gadget") documents each setting and the app handle.
const adapt = {
  title: 'Project Report',
  actionLabel: "Extra actions",
  styles: "",
  actions: [],
  onReady(app) {},
};
// ============================================================================

document.documentElement.lang = "en";
document.title = "Project report";
const root = document.createElement("div");
document.body.append(root);
if (!platformGadget) root.textContent = "This report runs inside a Cloudflare OS Workshop.";
else { const app = createReportApp({ gadget: platformGadget, root });
  await mountAdapt(adapt, { gadget: platformGadget, methods: ["getSetup", "listProjects", "getWorkflow", "listIssues", "exportCsv"], ready: app.ready, refresh: () => app.refresh() }); }
