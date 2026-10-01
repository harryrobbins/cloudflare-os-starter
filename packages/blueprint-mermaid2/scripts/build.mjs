import * as esbuild from "esbuild";
import { buildClientEntry, buildServerEntry } from "../../../scripts/gadget-entry.mjs";
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
await mkdir(dist, { recursive: true });
await buildServerEntry({ esbuild, entry: join(root, "src/server/index.js"), outDir: dist,
    banner: "// MermaiD2 gadget server: readable RPC surface. Source: packages/blueprint-mermaid2/src/server.",
    library: { absWorkingDir: root } });
await buildClientEntry({ esbuild, entry: join(root, "src/client/main.js"), outDir: dist,
    banner: "// MermaiD2 gadget client: readable view and adapt block. Source: packages/blueprint-mermaid2/src/client.",
    library: { absWorkingDir: root, minify: true, loader: { ".css": "text" } } });
await copyFile(join(root, 'src/README.md'), join(dist, 'README.md'));
await copyFile(join(root, 'LICENSE.txt'), join(dist, 'LICENSE.txt'));
await mkdir(join(dist, 'skills'), { recursive: true });
for (const id of ['mermaid2-connector','mermaid2-blueprint','d2-authoring']) {
  await mkdir(join(dist, 'skills', id), { recursive: true });
  await copyFile(join(root, '../gatekeeper-mermaid2/skills', id, 'SKILL.md'), join(dist, 'skills', id, 'SKILL.md'));
}
