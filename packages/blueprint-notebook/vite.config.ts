// Vite+ per-package settings, modeled on packages/custom-gatekeeper/vite.config.ts. `vitest.config.ts`
// (node: core/client/tools) and `vitest.workers.config.ts` (workerd: server) are vitest's own configs;
// this file only declares the `test` task that `vp run` executes. It is a task rather than a script
// because every `vitest run` rewrites scratch paths it reads back, and vp declines to cache such a task.

// Written and read back by every vitest run, so without these almost nothing caches. Workspace-wide
// because tracking reaches past the package that owns the task. See
// cloudflare-os/scripts/vitest-task-vite-config.ts for the full accounting of each path.
const vitestScratch = [
  { pattern: '!**/node_modules/.vite/**', base: 'workspace' },
  { pattern: '!**/node_modules/.vite-temp/**', base: 'workspace' },
  { pattern: '!**/.wrangler/**', base: 'workspace' },
] as const

export default {
  run: {
    tasks: {
      test: {
        // The last two steps fail the run when formats/notebook.gadget no longer matches the source.
        command: 'vitest run && vitest run --config vitest.workers.config.ts && node scripts/build.mjs && node scripts/pack-gadget.mjs --check',
        input: [{ auto: true }, ...vitestScratch],
        output: [{ auto: true }, ...vitestScratch],
      },
    },
  },
}
