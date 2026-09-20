// Build config for the chat SPA. Stream B replaces the placeholder entry with React, TanStack
// Router, Tailwind and Kumo; the two settings that matter to the Worker are already final:
//
//   base    every asset URL must be absolute under the router's prefix, because the app is only ever
//           served from `/gatekeeper/chat/` and a permalink such as
//           `/gatekeeper/chat/c/<id>/m/<id>` is several segments deep -- relative URLs would 404.
//   outDir  `app/dist`, which wrangler.jsonc's `assets.directory` points at.
import { defineConfig } from "vite";

import { APP_BASE } from "../src/shared/routes.js";

export default defineConfig({
  root: import.meta.dirname,
  base: APP_BASE,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Keeps the spike assertion about content types honest: one hashed module, no inlining.
    assetsInlineLimit: 0,
  },
});
