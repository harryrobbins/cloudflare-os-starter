import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));
// Generate types against source exports, not capnweb-validate's untyped generated code.
config.main = join(root, 'src/index.ts');
config.assets.directory = join(root, 'dist-renderer');
delete config.build;
await mkdir(join(root, '.wrangler'), { recursive: true });
const file = join(root, '.wrangler/types.jsonc');
await writeFile(file, JSON.stringify(config));
try {
  const result = spawnSync('pnpm', ['exec', 'wrangler', 'types', '--config', file], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else {
    const output = join(root, 'worker-configuration.d.ts');
    await writeFile(output, (await readFile(output, 'utf8')).replace(/[ \t]+$/gm, ''));
  }
} finally { await rm(file, { force: true }); }
