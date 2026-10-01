import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { loadFormat, loadEvals, runEval } from './blueprint-evals/run.mjs';
import { loadGadget, requireFromBlueprints, MemoryStorage } from './blueprint-evals/node-gadget.mjs';
import { executeCode } from './blueprint-evals/agent.mjs';
import { projectsEnvironment, recordsEnvironment, workEnvironment, syntheticEnvironment, diagramEnvironment, pythonEnvironment } from './blueprint-evals/fixtures.mjs';

const formats = ['board','arcade','network-map','mermaid2','procgen-explorer','tessera','notebook','records-explorer','project-board','project-report','work-board'];
const environments: Record<string, () => any> = {
  'mermaid2': diagramEnvironment, 'procgen-explorer': syntheticEnvironment, 'tessera': syntheticEnvironment,
  'notebook': pythonEnvironment, 'records-explorer': recordsEnvironment, 'work-board': workEnvironment,
  'project-board': projectsEnvironment, 'project-report': projectsEnvironment,
};
let instance: any;
const browser = async () => instance ??= await requireFromBlueprints('playwright').chromium.launch({ headless: true });
after(async () => { await instance?.close(); });

for (const format of formats) {
  test(`${format}: shipped entry contract and every operation example`, async () => {
    const loaded = await loadFormat(format);
    for (const name of ['client.js', 'server.js', 'client.lib.js', 'server.lib.js']) assert.ok(loaded.files[name], name);
    for (const name of ['client.js', 'server.js']) {
      assert.ok(Buffer.byteLength(loaded.files[name]) <= 65536, `${name} budget`);
      assert.match(loaded.files[name], /^\/\/.*gadget/);
    }
    assert.match(loaded.files['client.js'], /const adapt = \{/);
    assert.ok(!loaded.files['evals.mjs'], 'evals must not ship');
    const runtime = await loadGadget(loaded.files, { env: environments[format]?.() ?? {} });
    try {
      const description = runtime.gadget.describeGadget();
      assert.equal(description.contract, 1);
      assert.equal(description.gadget, format);
      assert.ok(JSON.stringify(description).length < 24000, 'describeBinding budget');
      for (const operation of description.operations) {
        assert.equal(typeof runtime.gadget[operation.name], 'function', operation.name);
        const result = await executeCode(operation.example.replace("await env.", "console.log(await env.").replace(/;$/, ");"), { Blueprint: runtime.gadget });
        assert.ok(result.ok, `${operation.name}: ${result.output}`);
        assert.ok(!/"errors":\[\{/.test(result.output), `${operation.name} returned validation errors: ${result.output}`);
      }
    } finally { await runtime.dispose(); }
  });
  test(`${format}: every reference use and adaptation runs against the archive`, async () => {
    const loaded = await loadFormat(format);
    for (const ev of await loadEvals(format)) {
      const result = await runEval({ ev, format: loaded, llm: null, browser });
      assert.deepEqual(result.problems, [], ev.id);
    }
  });
}

test('synchronous KV shares state with async storage and rolls back a transaction', async () => {
  const s = new MemoryStorage();
  s.kv.put('cell', { source: 'saved' });
  assert.deepEqual(await s.get('cell'), { source: 'saved' });
  assert.throws(() => s.transactionSync(() => { s.kv.put('cell', { source: 'bad' }); throw new Error('refused'); }));
  assert.deepEqual(s.kv.get('cell'), { source: 'saved' });
});

test('adapt controls ignore invalid actions, run callbacks once and keep errors visible', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = (await readFile(new URL('./blueprint-adapt/client.mjs', import.meta.url), 'utf8')).replace('export function', 'function');
  const page = await (await browser()).newPage();
  try {
    await page.setContent('<html><head></head><body></body></html>');
    await page.addScriptTag({ content: source + `
      globalThis.readyCalls = 0;
      globalThis.actionCalls = 0;
      mountAdapt({
        title: 'Custom view', actionLabel: 'Custom commands', unknown: true,
        styles: 'body { color: rgb(1, 2, 3); }',
        actions: [null, { id: 'broken', label: 'Invalid' },
          { id: 'hello', label: 'Run', async run(app) { await app.read(); globalThis.actionCalls++; app.notify('Done'); } },
          { id: 'hello', label: 'Duplicate', run() {} },
          { id: 'fail', label: 'Fail', run() { throw new Error('Action failed'); } }],
        onReady(app) { globalThis.readyCalls++; app.notify('Ready'); }
      }, { gadget: { read() { return 7; } }, methods: ['read'] });
    ` });
    await page.getByText('Ready', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button').count(), 2);
    assert.equal(await page.title(), 'Custom view');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await page.getByText('Done', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await page.getByRole('button', { name: 'Fail', exact: true }).click();
    await page.getByText('Action failed', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => (globalThis as any).readyCalls), 1);
    assert.equal(await page.evaluate(() => (globalThis as any).actionCalls), 2);
    assert.equal(await page.evaluate(() => (globalThis as any).getComputedStyle((globalThis as any).document.body).color), 'rgb(1, 2, 3)');
  } finally { await page.close(); }
});
