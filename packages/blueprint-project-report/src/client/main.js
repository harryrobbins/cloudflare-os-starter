// @ts-check
// Client entry point. The platform provides `gadget` as a module-scope binding in a prefix it
// prepends to this file (not on globalThis), so it is read behind a `typeof` guard.

import { createReportApp } from "./app.js";

/* global gadget */
// @ts-ignore provided by the platform prefix
const platformGadget = typeof gadget !== "undefined" ? gadget : undefined;

document.documentElement.lang = "en";
document.title = "Project report";
const root = document.createElement("div");
document.body.append(root);
if (!platformGadget) root.textContent = "This report runs inside a Cloudflare OS Workshop.";
else createReportApp({ gadget: platformGadget, root });
