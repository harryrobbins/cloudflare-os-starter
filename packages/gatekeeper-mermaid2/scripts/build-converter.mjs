import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { catalog } from '../src/catalog.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const generated = join(root, 'src/generated');
mkdirSync(generated, { recursive: true });
// The converter is an embedded WASM asset; release provenance is recorded by the wrapper.
// Disable optional VCS stamping so Go does not mistake a linked worktree for its parent directory.
const result = spawnSync('go', ['build', '-buildvcs=false', '-trimpath', '-o', join(generated, 'converter.wasm'), '.'], {
  cwd: join(root, 'converter'),
  env: { ...process.env, GOOS: 'js', GOARCH: 'wasm' },
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const examples = spawnSync('go', ['run', '-buildvcs=false', './cmd/examples'], {
  cwd: join(root, 'converter'), input: JSON.stringify(catalog), encoding: 'utf8',
  maxBuffer: 2 * 1024 * 1024,
});
if (examples.status !== 0) throw new Error(examples.stderr || 'Could not generate D2 examples.');
writeFileSync(join(generated, 'examples.json'), examples.stdout);
const goroot = spawnSync('go', ['env', 'GOROOT'], {
  cwd: join(root, 'converter'), encoding: 'utf8',
});
if (goroot.status !== 0) throw new Error(goroot.stderr || 'Could not locate the Go WASM runtime.');
const runtime = ['lib/wasm/wasm_exec.js', 'misc/wasm/wasm_exec.js']
  .map((path) => join(goroot.stdout.trim(), path)).find(existsSync);
if (!runtime) throw new Error('Could not find wasm_exec.js in GOROOT.');
copyFileSync(runtime, join(generated, 'wasm_exec.js'));
const notices = join(root, 'public/licenses');
// Go's module cache files are read-only; replacing the generated directory also
// makes repeated builds work after copyFile preserves those file permissions.
rmSync(notices, { recursive: true, force: true });
mkdirSync(notices, { recursive: true });
copyFileSync(join(goroot.stdout.trim(), 'LICENSE'), join(notices, 'Go.txt'));
for (const filename of ['LICENSE.txt', 'THIRD_PARTY_NOTICES.txt']) {
  copyFileSync(join(root, 'node_modules/@d2lang/d2', filename), join(notices, `D2-${filename}`));
}
// Retain notices for all Go modules linked into the converter, including the
// converter library's older D2 dependency. Pin/source information accompanies them.
const modules = spawnSync('go', ['list', '-buildvcs=false', '-deps', '-json', '.'], {
  cwd: join(root, 'converter'), encoding: 'utf8',
  env: { ...process.env, GOOS: 'js', GOARCH: 'wasm' }, maxBuffer: 16 * 1024 * 1024,
});
if (modules.status !== 0) throw new Error(modules.stderr || 'Could not collect Go dependency notices.');
const packages = JSON.parse(`[${modules.stdout.trim().replace(/}\s*{/g, '},{')}]`);
const moduleList = new Map(packages.filter((entry) => entry.Module).map((entry) => [entry.Module.Path, entry.Module]));
const noticeIndex = [];
for (const dependency of moduleList.values()) {
  if (!dependency.Dir || dependency.Main) continue;
  const name = `${dependency.Path.replaceAll('/', '_')}@${dependency.Version}`;
  noticeIndex.push(`${dependency.Path} ${dependency.Version}\nhttps://pkg.go.dev/${dependency.Path}@${dependency.Version}`);
  for (const filename of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'LICENCE', 'COPYING', 'THIRD_PARTY_NOTICES.txt']) {
    const file = join(dependency.Dir, filename);
    if (existsSync(file)) copyFileSync(file, join(notices, `${name}-${filename}`));
  }
}
writeFileSync(join(notices, 'Go-dependencies.txt'), noticeIndex.join('\n\n') + '\n');
console.log('Mermaid converter built.');
