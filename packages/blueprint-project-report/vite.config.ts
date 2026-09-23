// Vite+ per-package settings, modeled on packages/blueprint-kanban/vite.config.ts: declares the
// `test` task that `vp run` executes. Once the coordinator adds this blueprint's archive to
// formats/, append `&& node scripts/build.mjs && node scripts/pack-gadget.mjs --check ../../formats`.
const vitestScratch = [
  { pattern: '!**/node_modules/.vite/**', base: 'workspace' },
  { pattern: '!**/node_modules/.vite-temp/**', base: 'workspace' },
  { pattern: '!**/.wrangler/**', base: 'workspace' },
] as const

export default {
  run: {
    tasks: {
      test: {
        command: 'vitest run',
        input: [{ auto: true }, ...vitestScratch],
        output: [{ auto: true }, ...vitestScratch],
      },
    },
  },
}
