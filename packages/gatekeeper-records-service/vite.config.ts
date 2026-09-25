// Vite+ per-package settings: declares the `test` task that `vp run` executes (the `build` script
// stays in package.json, as in gatekeeper-procgen).
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
