// Build config for the omni-search SPA, modelled on packages/gatekeeper-chat/app/vite.config.ts.
//
//   base    every asset URL is absolute under `/gatekeeper/search/`, the prefix the Worker's ASSETS
//           binding serves the app from.
//   outDir  `app/dist`, which wrangler.jsonc's `assets.directory` points at.
//
// `VITE_SEARCH_MOCK=1` swaps the HTTP client for an in-memory fake (`src/mock/`) so the UI can be
// developed and screenshot without the Worker. `__SEARCH_MOCK__` is a build-time constant, so a
// production build folds `if (__SEARCH_MOCK__)` to `if (false)` and drops the fake with it.
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { defineConfig } from "vite";

import { APP_BASE } from "../src/shared/contract.js";

export default defineConfig(() => {
  const mock = process.env.VITE_SEARCH_MOCK === "1";
  return {
    root: import.meta.dirname,
    base: APP_BASE,
    plugins: [react(), tailwind()],
    define: {
      __SEARCH_MOCK__: JSON.stringify(mock),
    },
    server: {
      // Source only. Watching the package root would recurse into node_modules and .wrangler, which
      // on WSL2 turns every save into a CPU storm. Polling is never enabled: the tree is on the
      // Linux filesystem, where inotify works.
      watch: { ignored: ["**/node_modules/**", "**/.wrangler/**", "**/dist/**"] },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      // No inlined data: URIs for scripts or styles; everything is a hashed file under the CSP.
      assetsInlineLimit: 0,
    },
  };
});
