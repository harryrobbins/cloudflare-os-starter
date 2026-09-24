// Vite+ per-package settings, modeled on packages/blueprint-ranked-vote/vite.config.ts: declares the
// `test` task that `vp run` executes. The last two steps fail the run when formats/project-board.gadget
// no longer matches the source.
const vitestScratch = [
  { pattern: '!**/node_modules/.vite/**', base: 'workspace' },
  { pattern: '!**/node_modules/.vite-temp/**', base: 'workspace' },
  { pattern: '!**/.wrangler/**', base: 'workspace' },
] as const

export default {
  run: {
    tasks: {
      test: {
        command: 'vitest run && node scripts/build.mjs && node scripts/pack-gadget.mjs --check ../../formats',
        input: [{ auto: true }, ...vitestScratch],
        output: [{ auto: true }, ...vitestScratch],
      },
    },
  },
}
