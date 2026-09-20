// Build config for the chat SPA. The two settings the Worker depends on are unchanged from the
// scaffold:
//
//   base    every asset URL must be absolute under the router's prefix, because the app is only ever
//           served from `/gatekeeper/chat/` and a permalink such as
//           `/gatekeeper/chat/c/<id>/m/<id>` is several segments deep -- relative URLs would 404.
//   outDir  `app/dist`, which wrangler.jsonc's `assets.directory` points at.
//
// `VITE_CHAT_MOCK=1` swaps the API client and socket for an in-memory fake (`src/mock/`) so the whole
// UI can be developed and screenshot-tested without the Worker. It is compiled out rather than
// merely unused: `__CHAT_MOCK__` is a constant, so `if (__CHAT_MOCK__)` folds to `if (false)` in a
// production build and Rollup drops the branch together with its dynamic import of the fake.
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { defineConfig } from "vite";

import { APP_BASE } from "../src/shared/routes.js";

export default defineConfig(({ mode }) => {
  const mock = process.env.VITE_CHAT_MOCK === "1";
  return {
    root: import.meta.dirname,
    base: APP_BASE,
    plugins: [react(), tailwind()],
    define: {
      __CHAT_MOCK__: JSON.stringify(mock),
      __DEV_BUILD__: JSON.stringify(mode !== "production"),
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
      // Keeps the spike assertion about content types honest: hashed modules, no inlining.
      assetsInlineLimit: 0,
    },
  };
});
