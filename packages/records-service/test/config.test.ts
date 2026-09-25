import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secretSetting } from '../src/config.ts';

test('file-backed settings reject conflicting sources and malformed secret files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'records-config-'));
  const path = join(dir, 'secret');
  try {
    await writeFile(path, 'fixture\n', { mode: 0o600 });
    assert.equal(await secretSetting('KEY', { KEY_FILE: path }), 'fixture');
    assert.equal(await secretSetting('KEY', { KEY: 'inline-fixture' }), 'inline-fixture');
    assert.equal(await secretSetting('KEY', {}), undefined);
    await assert.rejects(secretSetting('KEY', { KEY: 'inline', KEY_FILE: path }), /only one/);
    await writeFile(path, 'first\nsecond');
    await assert.rejects(secretSetting('KEY', { KEY_FILE: path }), /one nonempty line/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
