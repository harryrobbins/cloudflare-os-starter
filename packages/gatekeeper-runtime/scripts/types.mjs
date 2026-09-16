import { readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
config.main = 'src/index.ts'; delete config.build;
const path = 'wrangler.types.jsonc';
try {
  await writeFile(path, JSON.stringify(config));
  const result = spawnSync('pnpm', ['exec', 'wrangler', 'types', '--config', path], { stdio: 'inherit' });
  if (result.status !== 0) process.exitCode = 1;
  else {
    const types = await readFile('worker-configuration.d.ts', 'utf8');
    await writeFile('worker-configuration.d.ts', types.replace(/[ \t]+$/gm, ''));
  }
} finally { await rm(path, { force: true }); }
