import { mountAdapt } from "../../../../scripts/blueprint-adapt/client.mjs";
// Client entry. The platform prepends a prefix defining `gadget` (RPC stub to the Gadget Durable
// Object) as a module-scope binding, not a global, so it is read behind a `typeof` guard.
import css from './style.css'
import { createExplorer } from './app.js'

/* global gadget */
// @ts-ignore provided by the platform prefix
const platformGadget = typeof gadget !== 'undefined' ? gadget : undefined
// ===== Adapt this gadget =====================================================
// README.md ("Adapting this gadget") documents each setting and the app handle.
const adapt = {
  title: 'Records Explorer',
  actionLabel: "Extra actions",
  styles: "",
  actions: [],
  onReady(app) {},
};
// ============================================================================

const style = document.createElement('style'); style.textContent = css; document.head.append(style)
document.documentElement.lang = 'en'
document.title = 'Records Explorer'
const root = document.createElement('main'); root.id = 'root'; document.body.append(root)
if (!platformGadget) root.textContent = 'This explorer runs inside a Cloudflare OS Workshop.'
else { const app = createExplorer({ gadget: platformGadget, root });
  await mountAdapt(adapt, { gadget: platformGadget, methods: ["getSetup", "connection", "describe", "model", "records", "changes", "getState", "setState"], ready: app.ready, refresh: () => app.refresh() }); }
