// Builds the effects check page (`e2e/effects-check.mjs`) the same way the app is built: `?url`
// assets hashed, module workers, no inlining.
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  worker: { format: "es" },
  build: { outDir: process.env.EFFECTS_OUT ?? "dist", emptyOutDir: true, assetsInlineLimit: 0 },
});
