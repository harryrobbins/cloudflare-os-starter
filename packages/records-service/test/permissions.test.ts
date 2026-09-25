import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { publish, setAttribution, setRole } from '../scripts/manage.ts';
// @ts-ignore Embedded database helper is intentionally shared with the JavaScript integration suite.
import { startDatabase } from './database-helpers.mjs';
import type { Sql } from 'postgres';

const people = fileURLToPath(new URL('../../records-model/examples/people/', import.meta.url));
const inventory = fileURLToPath(new URL('../../records-model/examples/inventory/', import.meta.url));

async function tenant(sql: Sql, module: string, scopes: string[]) {
  const org = randomUUID(), principal = randomUUID(), datastore = randomUUID(), binding = randomUUID();
  await sql`insert into records_private.organisations(id,name) values(${org},'permissions test')`;
  await sql`insert into records_private.principals(id) values(${principal})`;
  await sql`insert into records_private.memberships(org_id,id) values(${org},${principal})`;
  await sql`insert into records_private.datastores(id,org_id,module_id,api_major) values(${datastore},${org},${module},1)`;
  await sql`insert into records_private.bindings(id,datastore_id,principal_id,scopes) values(${binding},${datastore},${principal},${scopes})`;
  const claims = (actor?: string) => ({ iss: 'records-gateway', aud: 'records', sub: principal, org_id: org, datastore_id: datastore, binding_id: binding, scope: scopes, exp: Math.floor(Date.now() / 1000) + 300, ...(actor ? { act: { sub: actor } } : {}) });
  const as = <T>(actor: string | undefined, run: (tx: any) => Promise<T>) => sql.begin(async tx => {
    await tx.unsafe('set local role records_runtime');
    await tx`select set_config('request.jwt.claims',${JSON.stringify(claims(actor))},true)`;
    return run(tx);
  }) as Promise<T>;
  const command = (actor: string | undefined, name: string, input: unknown, key: string, revision: number | null = null) =>
    as(actor, async tx => (await tx`select records_api.execute_command(${datastore}::uuid,${module},1,${name},${tx.json(input)},${key},${revision}::bigint) result`)[0].result);
  const read = (actor: string | undefined) => as(actor, async tx => (await tx`select records_api.read_records(${datastore}::uuid,${module},1) result`)[0].result);
  const snapshot = (actor: string | undefined) => as(actor, async tx => (await tx`select records_api.snapshot_records(${datastore}::uuid,${module},1) result`)[0].result);
  const changes = (actor: string | undefined, epoch: number | null = null) => as(actor, async tx => (await tx`select records_api.pull_changes(${datastore}::uuid,0,500,${epoch}::bigint) result`)[0].result);
  return { datastore, binding, principal, command, read, snapshot, changes, as };
}

test('actor attribution: namespace-bound delegation, server-set stamps and append-only journal', async () => {
  const db = await startDatabase(); const sql: Sql = db.sql;
  try {
    const t = await tenant(sql, 'work', ['work.read', 'work.write']);
    // No attribution grant: naming an actor is refused, acting as the principal is not.
    await assert.rejects(t.command('test:ada', 'work.create', { title: 'A' }, 'k1'), (e: any) => e.code === 'PT403');
    const own = await t.command(undefined, 'work.create', { title: 'A' }, 'k1');
    assert.equal(own.record.created_by, `records:principal:${t.principal}`);
    await setAttribution(sql, t.binding, 'test');
    await assert.rejects(t.command('other:ada', 'work.create', { title: 'B' }, 'k2'), (e: any) => e.code === 'PT403');
    const created = await t.command('test:ada', 'work.create', { title: 'B', created_by: 'test:mallory' } as never, 'k3').catch((e: any) => e.code);
    assert.equal(created, 'PT400', 'attribution columns are not client input');
    const byAda = await t.command('test:ada', 'work.create', { title: 'B' }, 'k3');
    assert.equal(byAda.record.created_by, 'test:ada');
    // The actor is part of the idempotency digest: a replay by someone else cannot re-attribute.
    await assert.rejects(t.command('test:bob', 'work.create', { title: 'B' }, 'k3'), (e: any) => e.code === 'PT409');
    assert.deepEqual(await t.command('test:ada', 'work.create', { title: 'B' }, 'k3'), byAda);
    const edited = await t.command('test:bob', 'work.update', { id: byAda.record.id, title: 'B2' }, 'k4', byAda.seq);
    assert.equal(edited.record.created_by, 'test:ada'); assert.equal(edited.record.updated_by, 'test:bob');
    const page = await t.read(undefined);
    const record = page.records.find((r: any) => r.id === byAda.record.id);
    assert.equal(record.created_by, 'test:ada'); assert.equal(record.updated_by, 'test:bob'); assert.equal(record.data.title, 'B2');
    const feed = await t.changes(undefined);
    assert.deepEqual(feed.changes.map((c: any) => c.actor), [`records:principal:${t.principal}`, 'test:ada', 'test:bob']);
    await assert.rejects(sql`update records_private.journal set actor='test:mallory'`, (e: any) => e.code === '42501');
    await assert.rejects(sql`delete from records_private.journal`, (e: any) => e.code === '42501');
    await assert.rejects(sql`truncate records_private.journal`, (e: any) => e.code === '42501');
    // Runtime reaches neither storage nor the journal, only presentation views through RPCs.
    await assert.rejects(t.as(undefined, tx => tx`select * from records_work.items`), (e: any) => e.code === '42501');
    await assert.rejects(t.as(undefined, tx => tx`select * from records_private.journal`), (e: any) => e.code === '42501');
    assert.equal((await t.as(undefined, async (tx: any) => (await tx`select count(*)::int n from present_work_v1.work_item`)[0].n)), 2);
    // Revoking the grant takes effect on the next request.
    await setAttribution(sql, t.binding, null);
    await assert.rejects(t.read('test:ada'), (e: any) => e.code === 'PT403');
  } finally { await db.stop(); }
});

test('people module: owner-only edits, restricted fields, history rules, transfer and role revocation', async () => {
  const db = await startDatabase(); const sql: Sql = db.sql;
  try {
    await publish(sql, people);
    const t = await tenant(sql, 'people', ['people.read', 'people.write']);
    await setAttribution(sql, t.binding, 'test');
    await setRole(sql, 'grant', t.datastore, 'test:carol', 'admin');
    const ada = await t.command('test:ada', 'people.create', { name: 'Ada', email: 'ada@example.com', owner: 'test:bob' }, 'c1').catch((e: any) => e.code);
    assert.equal(ada, 'PT400', 'owner is not client input');
    const made = await t.command('test:ada', 'people.create', { name: 'Ada', job_title: 'Engineer', email: 'ada@example.com' }, 'c1');
    assert.equal(made.record.owner, 'test:ada');
    const id = made.record.id;
    const visible = async (actor: string) => (await t.read(actor)).records.find((r: any) => r.id === id);

    // Read rules: restricted fields are absent for other readers, present for owner and admin.
    assert.equal((await visible('test:bob')).data.email, undefined);
    assert.equal((await visible('test:bob')).data.job_title, 'Engineer');
    assert.equal((await visible('test:ada')).data.email, 'ada@example.com');
    assert.equal((await visible('test:carol')).data.email, 'ada@example.com');
    assert.equal((await t.snapshot('test:bob')).records[0].data.email, undefined);
    assert.equal((await t.snapshot('test:ada')).records[0].data.email, 'ada@example.com');
    // The principal acting as itself is neither owner nor admin.
    assert.equal((await visible(undefined as never)).data.email, undefined);

    // Write rules: non-owners are refused, including a replay of the owner's key or an altered one.
    await assert.rejects(t.command('test:bob', 'people.update', { id, name: 'Bob was here' }, 'u1', made.seq), (e: any) => e.code === 'PT403');
    await assert.rejects(t.command('test:bob', 'people.create', { name: 'Ada', job_title: 'Engineer', email: 'ada@example.com' }, 'c1'), (e: any) => e.code === 'PT409');
    const updated = await t.command('test:ada', 'people.update', { id, telephone: '+44 1' }, 'u2', made.seq);
    assert.equal(updated.record.updated_by, 'test:ada');
    const byAdmin = await t.command('test:carol', 'people.update', { id, job_title: 'Principal engineer' }, 'u3', updated.seq);
    assert.equal(byAdmin.record.owner, 'test:ada'); assert.equal(byAdmin.record.updated_by, 'test:carol');
    await assert.rejects(t.command('test:ada', 'people.update', { id, owner: 'test:bob' } as never, 'u4', byAdmin.seq), (e: any) => e.code === 'PT400');

    // History rules: only the owner at each change, and admins; others see gaps.
    assert.equal((await t.changes('test:bob')).changes.length, 0);
    assert.equal((await t.changes('test:bob')).cursor, byAdmin.seq, 'the cursor still advances past hidden changes');
    assert.equal((await t.changes('test:ada')).changes.length, 3);
    assert.equal((await t.changes('test:carol')).changes.length, 3);

    // Transfer: journalled, bumps the epoch, and moves the restricted fields to the new owner.
    const epoch = (await t.changes('test:ada')).permission_epoch;
    await assert.rejects(t.command('test:bob', 'people.transfer', { id, owner: 'test:bob' }, 't0', byAdmin.seq), (e: any) => e.code === 'PT403');
    const moved = await t.command('test:ada', 'people.transfer', { id, owner: 'test:bob' }, 't1', byAdmin.seq);
    assert.equal(moved.record.owner, 'test:bob'); assert.ok(moved.permission_epoch > epoch);
    await assert.rejects(t.changes('test:ada', epoch), (e: any) => e.code === 'PT409');
    assert.equal((await visible('test:bob')).data.email, 'ada@example.com');
    assert.equal((await visible('test:ada')).data.email, undefined);
    assert.equal((await t.changes('test:bob')).changes.length, 1);
    assert.equal((await t.changes('test:ada')).changes.length, 3);

    // Revoking a role takes effect on the next request and resets caches.
    const before = (await t.changes('test:carol')).permission_epoch;
    await setRole(sql, 'revoke', t.datastore, 'test:carol', 'admin');
    await assert.rejects(t.changes('test:carol', before), (e: any) => e.code === 'PT409');
    assert.equal((await visible('test:carol')).data.email, undefined);
    assert.equal((await t.changes('test:carol')).changes.length, 0);
    await assert.rejects(t.command('test:carol', 'people.update', { id, name: 'Nope' }, 'u5', moved.seq), (e: any) => e.code === 'PT403');

    // Ownership never changes outside a transfer, even for trusted operator SQL.
    await assert.rejects(sql`update records_people.profiles set owner='test:mallory'`, (e: any) => e.code === 'PT403');
  } finally { await db.stop(); }
});

test('publication refuses storage and presentation layouts that bypass Postgres rules', async () => {
  const db = await startDatabase(); const sql: Sql = db.sql;
  try {
    await publish(sql, inventory);
    const errors = async () => (await sql`select records_private.publication_errors('inventory',1) e`)[0].e as string[];
    assert.deepEqual(await errors(), []);
    const expectError = async (breakIt: string, pattern: RegExp) => {
      await sql.begin(async tx => {
        await tx.unsafe(breakIt);
        const found = (await tx`select records_private.publication_errors('inventory',1) e`)[0].e as string[];
        assert.ok(found.some(e => pattern.test(e)), `${breakIt} → ${found.join('; ')}`);
        throw new Error('rollback');
      }).catch((e: Error) => { if (e.message !== 'rollback') throw e; });
    };
    await expectError('ALTER TABLE records_inventory.assets NO FORCE ROW LEVEL SECURITY', /RLS must be enabled and forced/);
    await expectError('DROP POLICY tenant ON records_inventory.assets', /restrictive tenant policy/);
    await expectError('GRANT SELECT ON records_inventory.assets TO records_runtime', /client role records_runtime/);
    await expectError('GRANT SELECT (label) ON records_inventory.assets TO records_runtime', /client role records_runtime/);
    await expectError('ALTER VIEW present_inventory_v1.asset RESET (security_barrier)', /security_barrier view/);
    await expectError('ALTER VIEW present_inventory_v1.asset OWNER TO postgres', /owned by records_presenter/);
    await expectError('ALTER FUNCTION records_inventory.apply(uuid,text,jsonb,bigint,bigint) OWNER TO postgres', /records_commander/);
    await expectError('ALTER FUNCTION records_inventory.apply(uuid,text,jsonb,bigint,bigint) SECURITY INVOKER', /SECURITY DEFINER/);
    await expectError('DELETE FROM records_private.presentations WHERE module_id=\'inventory\'', /no presentation view/);
    await expectError('ALTER ROLE records_presenter BYPASSRLS', /must not bypass RLS/);
  } finally { await db.stop(); }
});
