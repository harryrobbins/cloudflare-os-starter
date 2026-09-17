import { build } from 'esbuild'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(pkg, 'dist')
const common = { bundle: true, format: 'esm', target: 'es2022', minify: false, legalComments: 'none', charset: 'utf8', logLevel: 'warning' }

export async function buildGadget(outDir = dist) {
  await mkdir(outDir, { recursive: true })
  await build({ ...common, entryPoints: [join(pkg, 'src/server/index.js')], outfile: join(outDir, 'server.js'), platform: 'neutral', external: ['cloudflare:workers'], banner: { js: '// Synthetic Data Explorer server. Edit packages/blueprint-procgen-explorer.' } })
  await build({ ...common, entryPoints: [join(pkg, 'src/client/main.js')], outfile: join(outDir, 'client.js'), platform: 'browser', loader: { '.css': 'text' }, banner: { js: '// Synthetic Data Explorer client. Edit packages/blueprint-procgen-explorer.' } })
  await copyFile(join(pkg, 'src/README.md'), join(outDir, 'README.md'))
  return outDir
}

if (import.meta.url === `file://${process.argv[1]}`) await buildGadget()
