import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecordsOsBridge, recordsOsIntentDigest, type StoredAction, type RecordsOsHost } from '../src/cloudflare-os.ts';
import { RecordsClient } from '../src/client.ts';

function fixture() {
  const stored = new Map<number, StoredAction>(); let serial = 0; let writes = 0; let revoked = false;
  const observations: { excludeObservers?: string[] }[] = []; const submitted: number[] = [];
  const client = new RecordsClient({ url: 'http://records', datastore: 'datastore', token: () => 'never-visible-to-gadget', fetch: async (url) => {
    if (String(url).endsWith('/describe')) return Response.json({ modules: [{ id: 'work', api_majors: [1], scopes: ['work.read', 'work.write'] }], granted_scopes: ['work.read', 'work.write'] });
    if (String(url).includes('/rpc/')) { writes++; return Response.json({ record: { title: 'result' } }); }
    return Response.json({ records: [] });
  } });
  const host: RecordsOsHost = {
    datastore: 'datastore', binding: 'binding', requirement: { moduleId: 'work', apiMajor: 1, scopes: ['work.read', 'work.write'] },
    queue: {
      consumeViewerAssertion: async (assertion, digest) => { if (assertion !== digest || !/^[0-9a-f]{64}$/.test(digest)) throw new Error('Intent mismatch'); return { id: 'viewer', displayName: 'Alice' }; },
      authorizeObservation: async description => { observations.push(description); },
      submitAction: async action => { submitted.push(action); },
    },
    // Test double only. Production construction requires an injected durable host store.
    pending: { allocate: async action => { stored.set(++serial, structuredClone(action)); return serial; }, get: async id => structuredClone(stored.get(id)), settle: async (id, outcome) => { stored.get(id)!.outcome = structuredClone(outcome); } },
    readClient: async () => client,
    resolveViewer: async () => revoked ? null : ({ principal: 'principal', client }),
    observers: async () => [{ observerId: 'observer-allowed', principal: 'reader' }, { observerId: 'observer-denied', principal: 'revoked' }],
    canRead: async principal => principal === 'reader',
  };
  const bridge = new RecordsOsBridge(host);
  const assertion = (input: unknown) => recordsOsIntentDigest({ datastore: host.datastore, binding: host.binding, moduleId: 'work', apiMajor: 1, command: 'work.create', input, expectedRevision: null, idempotencyKey: 'os-1' });
  return { bridge, session: bridge.session(), host, stored, submitted, observations, assertion, writes: () => writes, revoke: () => { revoked = true; } };
}
test('real queue lifecycle persists submission, executes only through apply callback, observes outcome', async () => {
  const f = fixture(); const input = { title: 'Approved' };
  const result = await f.session.command('work.create', input, { viewerAssertion: await f.assertion(input), idempotencyKey: 'os-1' });
  assert.deepEqual(result, { status: 'pending', actionId: 1 }); assert.equal(f.writes(), 0); assert.deepEqual(f.submitted, [1]);
  assert.equal('applyAction' in f.session, false); assert.equal('host' in f.session, false);
  await f.bridge.applyAction(1); assert.equal(f.writes(), 1);
  await f.bridge.applyAction(1); assert.equal(f.writes(), 1);
  assert.equal((await f.session.getOutcome(1)).status, 'applied');
  assert.deepEqual(f.observations.at(-1)?.excludeObservers, ['observer-denied']);
});
test('every read goes through observation authorization and excludes revoked observers', async () => {
  const f = fixture(); await f.session.describe(); await f.session.records(); await f.session.snapshot(); await f.session.changes();
  assert.equal(f.observations.length, 4);
  for (const observation of f.observations) assert.deepEqual(observation.excludeObservers, ['observer-denied']);
  f.host.queue.authorizeObservation = async () => { throw new Error('Sharing denied'); };
  await assert.rejects(f.session.records(), /Sharing denied/);
});
test('altered intent is rejected before queue submission and stored mutation is rejected at apply', async () => {
  const f = fixture(); const input = { title: 'Original' }; const viewerAssertion = await f.assertion(input);
  await assert.rejects(f.session.command('work.create', { title: 'Changed' }, { viewerAssertion, idempotencyKey: 'os-1' }), /Intent mismatch/);
  assert.equal(f.submitted.length, 0);
  await f.session.command('work.create', input, { viewerAssertion, idempotencyKey: 'os-1' });
  (f.stored.get(1)!.intent.input as { title: string }).title = 'Mutated after approval';
  await assert.rejects(f.bridge.applyAction(1), /does not match approval/); assert.equal(f.writes(), 0);
});
test('revocation between submission and application prevents write; rejection never executes', async () => {
  const f = fixture(); const input = { title: 'Original' };
  await f.session.command('work.create', input, { viewerAssertion: await f.assertion(input), idempotencyKey: 'os-1' });
  f.revoke(); await assert.rejects(f.bridge.applyAction(1), /revoked/); assert.equal(f.writes(), 0);
  assert.equal(f.stored.get(1)?.outcome?.status, 'rejected');
  const other = fixture(); await other.session.command('work.create', input, { viewerAssertion: await other.assertion(input), idempotencyKey: 'os-1' });
  await other.bridge.rejectAction(1); await other.bridge.applyAction(1); assert.equal(other.writes(), 0);
});
