const vitestScratch = [
  { pattern: '!**/node_modules/.vite/**', base: 'workspace' },
  { pattern: '!**/node_modules/.vite-temp/**', base: 'workspace' },
] as const

export default {
  run: {
    tasks: {
      test: {
        command: 'vitest run && node scripts/build.mjs && node scripts/pack-gadget.mjs --check',
        input: [{ auto: true }, ...vitestScratch],
        output: [{ auto: true }, ...vitestScratch],
      },
    },
  },
}
