import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSite } from '../src/site.ts';

test('website serves exact static assets, indexes, comparison and HEAD; never API or private files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'records-site-test-'));
  try {
    await mkdir(join(root, 'docs')); await mkdir(join(root, 'archive')); await mkdir(join(root, '.git')); await mkdir(join(root, 'v1'));
    for (const [name, value] of Object.entries({ 'index.html': '<h1>Records</h1>', 'docs/index.html': 'Docs', 'compare.html': 'Compare', 'archive/old.html': 'Old', 'site.js': 'console.log("site")', 'styles.css': 'body{}', 'architecture-plan.md': '# Architecture', 'blueprint-adaptation-plan.md': '# Adaptation', 'explorer-blueprint-plan.md': '# Explorer', '.env': 'SECRET', 'credentials.pem': 'PRIVATE KEY', 'private.json': '{"secret":true}', 'README.md': 'internal', '.git/config': 'private', 'v1/index.html': 'Fake API' })) await writeFile(join(root, name), value);
    await symlink(join(root, '.env'), join(root, 'leak.html')); await symlink(join(root, 'docs'), join(root, 'linked'));
    const site = await loadSite(root);
    const get = (path: string, method = 'GET') => site(new Request(`http://records.example${path}`, { method }));
    assert.match(await get('/')!.text(), /Records/); assert.equal(await get('/docs/')!.text(), 'Docs');
    assert.equal(get('/docs')!.status, 308); assert.equal(get('/docs?from=home')!.headers.get('location'), '/docs/?from=home');
    assert.equal(await get('/compare.html')!.text(), 'Compare'); assert.equal(await get('/archive/old.html')!.text(), 'Old');
    assert.equal(get('/site.js')!.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(get('/architecture-plan.md')!.headers.get('content-type'), 'text/markdown; charset=utf-8');
    assert.equal(await get('/blueprint-adaptation-plan.md')!.text(), '# Adaptation');
    assert.equal(await get('/explorer-blueprint-plan.md')!.text(), '# Explorer');
    const head = get('/', 'HEAD')!; assert.equal(await head.text(), ''); assert.equal(head.headers.get('content-length'), String('<h1>Records</h1>'.length));
    assert.equal(get('/', 'POST')!.status, 405); assert.equal(get('/', 'POST')!.headers.get('allow'), 'GET, HEAD');
    for (const path of ['/.env', '/credentials.pem', '/private.json', '/README.md', '/.git/config', '/leak.html', '/linked/', '/missing', '/docs/missing', '/..%2f.env', '/%2eenv', '/v1', '/v1/', '/v1/index.html', '/v1/models/work', '/healthz']) assert.equal(get(path), null, path);
    // Runtime asset replacement cannot redirect requests into the filesystem after startup.
    await rm(join(root, 'index.html')); await symlink(join(root, '.env'), join(root, 'index.html'));
    assert.match(await get('/')!.text(), /Records/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('site configuration rejects a symlink root and missing index', async () => {
  const root = await mkdtemp(join(tmpdir(), 'records-site-invalid-'));
  try {
    await mkdir(join(root, 'empty')); await symlink(join(root, 'empty'), join(root, 'link'));
    await assert.rejects(loadSite(join(root, 'link')), /real directory/);
    await assert.rejects(loadSite(join(root, 'empty')), /index.html/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
