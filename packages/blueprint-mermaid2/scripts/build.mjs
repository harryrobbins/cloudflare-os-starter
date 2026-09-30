import { build } from 'esbuild';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
await mkdir(dist, { recursive: true });
await build({ entryPoints: [join(root, 'src/server/index.js')], outfile: join(dist, 'server.js'), bundle: true, format: 'esm', target: 'es2022', platform: 'neutral', external: ['cloudflare:workers'] });
await build({ entryPoints: [join(root, 'src/client/main.js')], outfile: join(dist, 'client.js'), bundle: true, format: 'esm', target: 'es2022', minify: true, define: { MERMAID2_CSS: JSON.stringify(await readFile(join(root, 'src/client/style.css'), 'utf8')) } });
await copyFile(join(root, 'src/README.md'), join(dist, 'README.md'));
await copyFile(join(root, 'LICENSE.txt'), join(dist, 'LICENSE.txt'));
await mkdir(join(dist, 'skills'), { recursive: true });
for (const id of ['mermaid2-connector','mermaid2-blueprint','d2-authoring']) {
  await mkdir(join(dist, 'skills', id), { recursive: true });
  await copyFile(join(root, '../gatekeeper-mermaid2/skills', id, 'SKILL.md'), join(dist, 'skills', id, 'SKILL.md'));
}
