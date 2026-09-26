import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setAttribution } from '../scripts/manage.ts';
// @ts-ignore Embedded database helper is intentionally shared with the JavaScript integration suite.
import { startDatabase } from './database-helpers.mjs';
import type { Sql } from 'postgres';

type Result = { record: { id: string; entity: string; revision: number; created_by: string; updated_by: string; data: Record<string, any> }; seq: number; permission_epoch: number };

async function tenant(sql: Sql, org = randomUUID()) {
  const principal = randomUUID(), datastore = randomUUID(), binding = randomUUID(), scopes = ['work.read', 'work.write'];
  await sql`insert into records_private.organisations(id,name) values(${org},'work planning test') on conflict do nothing`;
  await sql`insert into records_private.principals(id) values(${principal})`;
  await sql`insert into records_private.memberships(org_id,id) values(${org},${principal})`;
  await sql`insert into records_private.datastores(id,org_id,module_id,api_major) values(${datastore},${org},'work',1)`;
  await sql`insert into records_private.bindings(id,datastore_id,principal_id,scopes) values(${binding},${datastore},${principal},${scopes})`;
  // Commands are attributed to delegated test actors, as the cloudflare-os connector does.
  await setAttribution(sql, binding, 'test');
  const claims = (actor?: string) => ({ iss: 'records-gateway', aud: 'records', sub: principal, org_id: org, datastore_id: datastore, binding_id: binding, scope: scopes, exp: Math.floor(Date.now() / 1000) + 300, ...(actor ? { act: { sub: actor } } : {}) });
  const as = <T>(actor: string | undefined, run: (tx: any) => Promise<T>) => sql.begin(async tx => {
    await tx.unsafe('set local role records_runtime');
    await tx`select set_config('request.jwt.claims',${JSON.stringify(claims(actor))},true)`;
    return run(tx);
  }) as Promise<T>;
  let counter = 0;
  const run = (name: string, input: unknown, revision: number | null = null, actor: string | undefined = 'test:ada', key = `k${++counter}`): Promise<Result> =>
    as(actor, async tx => (await tx`select records_api.execute_command(${datastore}::uuid,'work',1,${name},${tx.json(input as never)},${key},${revision}::bigint) result`)[0].result);
  const snapshot = () => as(undefined, async tx => (await tx`select records_api.snapshot_records(${datastore}::uuid,'work',1,5000) result`)[0].result);
  const read = (entity: string | null) => as(undefined, async tx => (await tx`select records_api.read_records(${datastore}::uuid,'work',1,${entity},null,500) result`)[0].result);
  const changes = (after = 0, limit = 500) => as(undefined, async tx => (await tx`select records_api.pull_changes(${datastore}::uuid,${after},${limit}) result`)[0].result);
  return { datastore, binding, principal, org, run, snapshot, read, changes, as };
}

/** Resolves to the SQLSTATE and message of a refused command. */
async function refused(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error: any) { return `${error.code} ${error.message}`; }
  return 'accepted';
}
const expectRefused = async (promise: Promise<unknown>, code: string, message?: RegExp) => {
  const outcome = await refused(promise);
  assert.ok(outcome.startsWith(code + ' '), `expected ${code}, got ${outcome}`);
  if (message) assert.match(outcome, message);
};

test('work planning: default states, every command, and reads that agree with commands', async () => {
  const db = await startDatabase(); const sql: Sql = db.sql;
  try {
    const t = await tenant(sql);
    // The first command seeds the default workflow states inside its own commit.
    const project = await t.run('work.project.create', { name: 'Website relaunch', description: 'New site', state: 'active', lead: 'test:ada', start_date: '2026-09-01', target_date: '2026-12-01', color: '#AA3300' });
    assert.equal(project.record.entity, 'project');
    assert.deepEqual(project.record.data, { name: 'Website relaunch', description: 'New site', state: 'active', lead: 'test:ada', start_date: '2026-09-01', target_date: '2026-12-01', color: '#AA3300', archived: false });
    const first = await t.changes();
    assert.deepEqual(first.changes.map((c: any) => [c.seq, c.ordinal, c.entity]), [[1, 0, 'project'], ...[1, 2, 3, 4, 5, 6, 7].map(n => [1, n, 'workflow_state'])]);
    assert.ok(first.changes.every((c: any) => c.actor === 'test:ada'));
    const states = (await t.read('workflow_state')).records;
    assert.deepEqual(states.map((s: any) => [s.data.key, s.data.kind, s.data.category, s.data.position]).sort((a: any, b: any) => a[3] - b[3]),
      [['triage', 'triage', 'open', 0], ['backlog', 'backlog', 'open', 1], ['todo', 'unstarted', 'open', 2], ['in_progress', 'started', 'active', 3], ['in_review', 'started', 'active', 4], ['done', 'completed', 'done', 5], ['canceled', 'canceled', 'done', 6]]);
    assert.ok(states.every((s: any) => s.created_by === 'test:ada' && s.revision === 1));
    // A one-row page never splits a commit.
    const page = await t.changes(0, 1);
    assert.equal(page.changes.length, 8); assert.equal(page.cursor, 1);

    // v1-shaped input still works and lands in the status's default state.
    const plain = await t.run('work.create', { title: 'Plain' });
    assert.deepEqual(plain.record.data, { title: 'Plain', status: 'open', state: 'todo', description: '', extensions: {}, number: 1, archived: false });
    assert.equal((await t.run('work.create', { title: 'Doing', status: 'active' })).record.data.state, 'in_progress');
    assert.equal((await t.run('work.create', { title: 'Finished', status: 'done' })).record.data.state, 'done');
    const reviewing = await t.run('work.create', { title: 'Review', state: 'in_review' });
    assert.equal(reviewing.record.data.status, 'active'); assert.equal(reviewing.record.data.number, 4);
    assert.equal((await t.run('work.create', { title: 'Consistent', state: 'canceled', status: 'done' })).record.data.state, 'canceled');

    const cycle = await t.run('work.cycle.create', { name: 'Sprint 1', starts_on: '2026-09-07', ends_on: '2026-09-20', goal: 'Ship the beta' });
    assert.deepEqual(cycle.record.data, { name: 'Sprint 1', number: 1, starts_on: '2026-09-07', ends_on: '2026-09-20', goal: 'Ship the beta' });
    const cycle2 = await t.run('work.cycle.create', { starts_on: '2026-09-21', ends_on: '2026-10-04' });
    assert.deepEqual(cycle2.record.data, { number: 2, starts_on: '2026-09-21', ends_on: '2026-10-04' });
    const full = await t.run('work.create', {
      title: 'Full', description: 'All fields', extensions: { customer: 'Acme', nested: { x: null } }, state: 'backlog', priority: 2, assignee: 'test:bob',
      labels: ['bug', 'Needs design'], estimate: 2.5, start_date: '2026-09-08', due_date: '2026-09-18', parent: plain.record.id, project: project.record.id,
      cycle: cycle.record.id, rank: '0|hzzzzz:', archived: false,
    });
    assert.deepEqual(full.record.data, {
      title: 'Full', status: 'open', state: 'backlog', description: 'All fields', extensions: { customer: 'Acme', nested: { x: null } }, number: 6, priority: 2,
      assignee: 'test:bob', labels: ['bug', 'Needs design'], estimate: 2.5, start_date: '2026-09-08', due_date: '2026-09-18', parent: plain.record.id,
      project: project.record.id, cycle: cycle.record.id, rank: '0|hzzzzz:', archived: false,
    });

    // Updates: labels replace, null clears, state/status stay consistent, v1 updates keep the state when they can.
    let item = await t.run('work.update', { id: full.record.id, labels: ['regression'], assignee: null, cycle: cycle2.record.id, state: 'in_review', priority: 0 }, full.seq, 'test:bob');
    assert.deepEqual([item.record.data.labels, item.record.data.assignee, item.record.data.cycle, item.record.data.status, item.record.data.priority], [['regression'], undefined, cycle2.record.id, 'active', 0]);
    assert.equal(item.record.created_by, 'test:ada'); assert.equal(item.record.updated_by, 'test:bob');
    item = await t.run('work.update', { id: full.record.id, status: 'active', title: 'Full!' }, item.seq);
    assert.equal(item.record.data.state, 'in_review', 'a status that matches keeps the state');
    item = await t.run('work.update', { id: full.record.id, status: 'open' }, item.seq);
    assert.equal(item.record.data.state, 'todo');
    item = await t.run('work.update', { id: full.record.id, labels: [], parent: null, project: null, cycle: null, estimate: null, rank: null, start_date: null, due_date: null, archived: true }, item.seq);
    for (const key of ['labels', 'parent', 'project', 'cycle', 'estimate', 'rank', 'start_date', 'due_date']) assert.equal(item.record.data[key], undefined, key);
    assert.equal(item.record.data.archived, true); assert.equal(item.record.data.number, 6, 'number never changes');
    const moved = await t.run('work.update', { id: plain.record.id, parent: reviewing.record.id }, plain.seq);
    assert.equal(moved.record.data.parent, reviewing.record.id);

    const updatedProject = await t.run('work.project.update', { id: project.record.id, state: 'paused', color: null, archived: true }, project.seq);
    assert.deepEqual([updatedProject.record.data.state, updatedProject.record.data.color, updatedProject.record.data.archived, updatedProject.record.data.name], ['paused', undefined, true, 'Website relaunch']);
    const updatedCycle = await t.run('work.cycle.update', { id: cycle.record.id, name: null, goal: 'Beta', ends_on: '2026-09-19' }, cycle.seq);
    assert.deepEqual(updatedCycle.record.data, { number: 1, starts_on: '2026-09-07', ends_on: '2026-09-19', goal: 'Beta' });

    const blocked = await t.run('work.state.create', { key: 'blocked', name: 'Blocked', kind: 'started', color: '#ff0000', wip_limit: 3 });
    assert.deepEqual(blocked.record.data, { key: 'blocked', name: 'Blocked', kind: 'started', category: 'active', position: 7, color: '#ff0000', wip_limit: 3 });
    assert.equal((await t.run('work.state.create', { key: 'icebox', name: 'Icebox', category: 'open', position: 0 })).record.data.kind, 'unstarted');
    const blockedItem = await t.run('work.create', { title: 'Stuck', state: 'blocked' });
    assert.equal(blockedItem.record.data.status, 'active');
    const renamed = await t.run('work.state.update', { id: blocked.record.id, name: 'On hold', kind: 'started', wip_limit: null, position: 5 }, blocked.seq);
    assert.deepEqual([renamed.record.data.name, renamed.record.data.wip_limit, renamed.record.data.position], ['On hold', undefined, 5]);
    // A kind change within the same category is allowed even while the state is in use.
    const done = states.find((s: any) => s.data.key === 'done');
    assert.equal((await t.run('work.state.update', { id: done.id, kind: 'canceled' }, done.revision)).record.data.category, 'done');

    const label = await t.run('work.label.create', { key: 'bug', color: '#d73a4a', description: 'Something is broken' });
    assert.deepEqual(label.record.data, { key: 'bug', name: 'bug', color: '#d73a4a', description: 'Something is broken', archived: false });
    const label2 = await t.run('work.label.update', { id: label.record.id, name: 'Bug', archived: true }, label.seq);
    assert.deepEqual([label2.record.data.name, label2.record.data.archived], ['Bug', true]);

    const blocks = await t.run('work.relation.create', { from: blockedItem.record.id, to: reviewing.record.id, kind: 'blocks' });
    assert.deepEqual(blocks.record.data, { from: blockedItem.record.id, to: reviewing.record.id, kind: 'blocks', active: true });
    const removed = await t.run('work.relation.update', { id: blocks.record.id, active: false }, blocks.seq);
    assert.equal(removed.record.data.active, false);
    const again = await t.run('work.relation.create', { from: blockedItem.record.id, to: reviewing.record.id, kind: 'blocks' });
    assert.equal(again.record.data.active, true, 'a removed relation can be added again');
    await t.run('work.relation.create', { from: reviewing.record.id, to: blockedItem.record.id, kind: 'relates' });

    const comment = await t.run('work.comment.create', { item: reviewing.record.id, body: 'Looks **good**' }, null, 'test:bob');
    assert.deepEqual(comment.record.data, { item: reviewing.record.id, body: 'Looks **good**', edited: false });
    const same = await t.run('work.comment.update', { id: comment.record.id, body: 'Looks **good**' }, comment.seq);
    assert.equal(same.record.data.edited, false, 'an unchanged body is not an edit');
    const edited = await t.run('work.comment.update', { id: comment.record.id, body: 'Looks great' }, same.seq);
    assert.equal(edited.record.data.edited, true); assert.equal(edited.record.created_by, 'test:bob');

    // Snapshot, entity reads and the change feed all present the same records as the commands returned.
    const snap = await t.snapshot();
    const entities = new Set(snap.records.map((r: any) => r.entity));
    assert.deepEqual([...entities].sort(), ['comment', 'cycle', 'label', 'project', 'relation', 'work_item', 'workflow_state']);
    const latest = new Map<string, any>();
    for (const change of (await t.changes()).changes) latest.set(change.record_id, change);
    for (const record of snap.records) {
      const change = latest.get(record.id);
      assert.ok(change, `journalled: ${record.entity} ${record.id}`);
      assert.deepEqual(change.data, record.data, `journal matches snapshot for ${record.entity}`);
      assert.equal(change.revision, record.revision);
    }
    assert.deepEqual(snap.records.find((r: any) => r.id === edited.record.id).data, edited.record.data);
    assert.equal((await t.read('comment')).records.length, 1);
    assert.equal((await t.read('relation')).records.length, 3);
    const described = await t.as(undefined, async (tx: any) => (await tx`select records_api.describe_datastore(${t.datastore}::uuid) result`)[0].result);
    assert.deepEqual(described.modules[0].entities, ['work_item', 'project', 'cycle', 'workflow_state', 'label', 'relation', 'comment']);
    assert.equal(described.modules[0].commands.length, 14);
  } finally { await db.stop(); }
});

test('work planning: integrity rules are refused with the right SQLSTATE', async () => {
  const db = await startDatabase(); const sql: Sql = db.sql;
  try {
    const t = await tenant(sql);
    const other = await tenant(sql, t.org);
    const a = await t.run('work.create', { title: 'A' });
    const b = await t.run('work.create', { title: 'B', parent: a.record.id });
    const c = await t.run('work.create', { title: 'C', parent: b.record.id });
    const foreignItem = await other.run('work.create', { title: 'Elsewhere' });
    const foreignProject = await other.run('work.project.create', { name: 'Elsewhere' });

    // Shapes: unknown keys, server-set fields and wrong types.
    for (const [command, input] of [
      ['work.create', { title: 'X', number: 7 }], ['work.create', { title: 'X', created_by: 'test:eve' }], ['work.create', { title: 'X', surprise: 1 }],
      ['work.create', { title: 'X', state: null }], ['work.create', { title: 'X', archived: null }], ['work.create', { title: 'X', labels: 'bug' }],
      ['work.project.create', { name: 'P', owner: 'test:eve' }], ['work.cycle.create', { starts_on: '2026-01-01', ends_on: '2026-01-02', number: 3 }],
      ['work.state.create', { key: 'k', name: 'K', kind: 'started', category_extra: 1 }], ['work.label.create', { key: 'x', archived: 'no' }],
      ['work.relation.create', { from: a.record.id, to: b.record.id, kind: 'blocks', active: false }], ['work.comment.create', { item: a.record.id, body: 'x', edited: true }],
    ] as const) await expectRefused(t.run(command, input), 'PT400', /Invalid \w+( \w+)? fields/);
    await expectRefused(t.run('work.create', {}), 'PT400', /title is required/);
    await expectRefused(t.run('work.create', { title: 'X' }, 3), 'PT400', /Create cannot have revision/);
    await expectRefused(t.run('work.create', { id: 'not-a-uuid', title: 'X' }), 'PT400');

    // Revisions and missing records behave as in v1, for every entity.
    await expectRefused(t.run('work.update', { id: a.record.id, title: 'A2' }), 'PT428');
    await expectRefused(t.run('work.update', { id: a.record.id, title: 'A2' }, a.seq + 1000), 'PT412');
    await expectRefused(t.run('work.update', { id: randomUUID(), title: 'A2' }, 1), 'PT404');
    await expectRefused(t.run('work.update', { id: foreignItem.record.id, title: 'A2' }, foreignItem.seq), 'PT404');
    const project = await t.run('work.project.create', { name: 'P' });
    await expectRefused(t.run('work.update', { id: project.record.id, title: 'Wrong entity' }, project.seq), 'PT404');
    await expectRefused(t.run('work.project.update', { id: project.record.id, name: 'P2' }), 'PT428');
    await expectRefused(t.run('work.project.update', { id: project.record.id, name: 'P2' }, 1), 'PT412');
    await expectRefused(t.run('work.project.create', { id: a.record.id, name: 'Same id as an item' }), 'PT409', /Record already exists/);

    // Item fields.
    await expectRefused(t.run('work.create', { title: 'X', state: 'nope' }), 'PT400', /Unknown workflow state/);
    await expectRefused(t.run('work.create', { title: 'X', state: 'done', status: 'open' }), 'PT400', /State and status disagree/);
    await expectRefused(t.run('work.create', { title: 'X', status: 'doing' }), 'PT400', /Status must be/);
    await expectRefused(t.run('work.create', { title: 'X', priority: 5 }), 'PT400', /Priority/);
    await expectRefused(t.run('work.create', { title: 'X', priority: 1.5 }), 'PT400');
    await expectRefused(t.run('work.create', { title: 'X', assignee: 'ada' }), 'PT400', /Assignee/);
    await expectRefused(t.run('work.create', { title: 'X', labels: Array.from({ length: 21 }, (_, i) => `l${i}`) }), 'PT400', /Labels/);
    await expectRefused(t.run('work.create', { title: 'X', labels: ['bug', 'bug'] }), 'PT400', /Labels/);
    await expectRefused(t.run('work.create', { title: 'X', labels: ['x'.repeat(61)] }), 'PT400', /Labels/);
    await expectRefused(t.run('work.create', { title: 'X', labels: [' padded'] }), 'PT400', /Labels/);
    await expectRefused(t.run('work.create', { title: 'X', labels: [3] }), 'PT400', /Labels must be an array of strings/);
    await expectRefused(t.run('work.create', { title: 'X', estimate: -1 }), 'PT400', /Estimate/);
    await expectRefused(t.run('work.create', { title: 'X', estimate: 1001 }), 'PT400', /Estimate/);
    await expectRefused(t.run('work.create', { title: 'X', due_date: '26/09/2026' }), 'PT400', /YYYY-MM-DD/);
    await expectRefused(t.run('work.create', { title: 'X', due_date: '2026-02-30' }), 'PT400', /calendar dates/);
    await expectRefused(t.run('work.create', { title: 'X', start_date: '2026-09-10', due_date: '2026-09-01' }), 'PT400', /Due date is before start date/);
    await expectRefused(t.run('work.create', { title: 'X', rank: 'x'.repeat(65) }), 'PT400', /Rank/);
    await expectRefused(t.run('work.create', { title: 'X', title_extra: 1 } as never), 'PT400');
    await expectRefused(t.run('work.create', { title: '' }), 'PT400', /Title/);

    // References must exist in the same datastore; parents never form a cycle.
    await expectRefused(t.run('work.update', { id: a.record.id, parent: a.record.id }, a.seq), 'PT400', /own parent/);
    await expectRefused(t.run('work.update', { id: a.record.id, parent: c.record.id }, a.seq), 'PT409', /cycle/);
    await expectRefused(t.run('work.update', { id: a.record.id, parent: b.record.id }, a.seq), 'PT409', /cycle/);
    await expectRefused(t.run('work.create', { title: 'X', parent: randomUUID() }), 'PT400', /Unknown parent item/);
    await expectRefused(t.run('work.create', { title: 'X', parent: foreignItem.record.id }), 'PT400', /Unknown parent item/);
    await expectRefused(t.run('work.create', { title: 'X', project: foreignProject.record.id }), 'PT400', /Unknown project/);
    await expectRefused(t.run('work.create', { title: 'X', cycle: randomUUID() }), 'PT400', /Unknown cycle/);
    await expectRefused(t.run('work.create', { title: 'X', project: 'not-a-uuid' }), 'PT400');

    // Projects.
    await expectRefused(t.run('work.project.create', {}), 'PT400', /name is required/);
    await expectRefused(t.run('work.project.create', { name: 'P', state: 'done' }), 'PT400', /Project state/);
    await expectRefused(t.run('work.project.create', { name: 'P', color: 'red' }), 'PT400', /Colours/);
    await expectRefused(t.run('work.project.create', { name: 'P', lead: 'nobody' }), 'PT400', /Lead/);
    await expectRefused(t.run('work.project.create', { name: 'P', start_date: '2026-09-10', target_date: '2026-09-01' }), 'PT400', /Target date/);

    // Cycles never overlap (inclusive dates) and never end before they start.
    const sprint = await t.run('work.cycle.create', { starts_on: '2026-09-07', ends_on: '2026-09-20' });
    await expectRefused(t.run('work.cycle.create', { starts_on: '2026-09-20', ends_on: '2026-10-01' }), 'PT409', /overlap/);
    await expectRefused(t.run('work.cycle.create', { starts_on: '2026-09-01', ends_on: '2026-09-30' }), 'PT409', /overlap/);
    await expectRefused(t.run('work.cycle.create', { starts_on: '2026-10-10', ends_on: '2026-10-01' }), 'PT400', /end before it starts/);
    await expectRefused(t.run('work.cycle.create', { starts_on: '2026-10-10' }), 'PT400', /needs starts_on and ends_on/);
    const next = await t.run('work.cycle.create', { starts_on: '2026-09-21', ends_on: '2026-10-04' });
    await expectRefused(t.run('work.cycle.update', { id: next.record.id, starts_on: '2026-09-15' }, next.seq), 'PT409', /overlap/);
    await expectRefused(t.run('work.cycle.update', { id: sprint.record.id, ends_on: '2026-09-01' }, sprint.seq), 'PT400', /end before it starts/);
    assert.equal((await t.run('work.cycle.update', { id: sprint.record.id, ends_on: '2026-09-18' }, sprint.seq)).record.data.ends_on, '2026-09-18', 'a cycle may move within its own dates');

    // Workflow states.
    await expectRefused(t.run('work.state.create', { key: 'todo', name: 'Todo again', kind: 'unstarted' }), 'PT409', /Workflow state key already exists/);
    await expectRefused(t.run('work.state.create', { key: 'qa', name: 'QA', kind: 'started', category: 'done' }), 'PT400', /Kind and category disagree/);
    await expectRefused(t.run('work.state.create', { key: 'qa', name: 'QA', kind: 'doing' }), 'PT400', /kind must be/);
    await expectRefused(t.run('work.state.create', { key: 'qa', name: 'QA', category: 'later' }), 'PT400', /Category must be/);
    await expectRefused(t.run('work.state.create', { key: 'qa', name: 'QA' }), 'PT400', /needs a kind/);
    await expectRefused(t.run('work.state.create', { key: 'Q A', name: 'QA', kind: 'started' }), 'PT400', /keys are/);
    await expectRefused(t.run('work.state.create', { key: 'qa', name: 'QA', kind: 'started', wip_limit: 0 }), 'PT400', /WIP limit/);
    const states = (await t.read('workflow_state')).records;
    const todo = states.find((s: any) => s.data.key === 'todo'), triage = states.find((s: any) => s.data.key === 'triage');
    await expectRefused(t.run('work.state.update', { id: todo.id, key: 'renamed' }, todo.revision), 'PT400', /Invalid workflow state fields/);
    await expectRefused(t.run('work.state.update', { id: todo.id, kind: 'started' }, todo.revision), 'PT409', /in use/);
    assert.equal((await t.run('work.state.update', { id: triage.id, kind: 'started' }, triage.revision)).record.data.category, 'active', 'an unused state may change category');

    // Labels.
    await t.run('work.label.create', { key: 'bug' });
    await expectRefused(t.run('work.label.create', { key: 'bug' }), 'PT409', /Label key already exists/);
    await expectRefused(t.run('work.label.create', { key: '' }), 'PT400', /Label keys/);
    const label = (await t.read('label')).records[0];
    await expectRefused(t.run('work.label.update', { id: label.id, key: 'defect' }, label.revision), 'PT400', /Invalid label fields/);

    // Relations: no self-relations, endpoints in this datastore, one active relation per kind and pair.
    await expectRefused(t.run('work.relation.create', { from: a.record.id, to: a.record.id, kind: 'blocks' }), 'PT400', /relate to itself/);
    await expectRefused(t.run('work.relation.create', { from: a.record.id, to: foreignItem.record.id, kind: 'blocks' }), 'PT400', /Unknown work item/);
    await expectRefused(t.run('work.relation.create', { from: a.record.id, to: b.record.id, kind: 'causes' }), 'PT400', /Relation kind/);
    await expectRefused(t.run('work.relation.create', { from: a.record.id, kind: 'blocks' }), 'PT400', /needs from, to and kind/);
    const blocks = await t.run('work.relation.create', { from: a.record.id, to: b.record.id, kind: 'blocks' });
    await expectRefused(t.run('work.relation.create', { from: a.record.id, to: b.record.id, kind: 'blocks' }), 'PT409', /Relation already exists/);
    await t.run('work.relation.create', { from: b.record.id, to: a.record.id, kind: 'blocks' });
    await t.run('work.relation.create', { from: a.record.id, to: c.record.id, kind: 'relates' });
    await expectRefused(t.run('work.relation.create', { from: c.record.id, to: a.record.id, kind: 'relates' }), 'PT409', /Relation already exists/);
    const off = await t.run('work.relation.update', { id: blocks.record.id, active: false }, blocks.seq);
    await t.run('work.relation.create', { from: a.record.id, to: b.record.id, kind: 'blocks' });
    await expectRefused(t.run('work.relation.update', { id: blocks.record.id, active: true }, off.seq), 'PT409', /Relation already exists/);
    assert.equal((await t.run('work.relation.update', { id: blocks.record.id }, off.seq)).record.data.active, false, 'an inactive relation stays inactive');
    await expectRefused(t.run('work.relation.update', { id: blocks.record.id, to: c.record.id }, off.seq), 'PT400', /Invalid relation fields/);

    // Comments.
    await expectRefused(t.run('work.comment.create', { item: randomUUID(), body: 'Hi' }), 'PT400', /Unknown work item/);
    await expectRefused(t.run('work.comment.create', { item: foreignItem.record.id, body: 'Hi' }), 'PT400', /Unknown work item/);
    await expectRefused(t.run('work.comment.create', { item: a.record.id, body: '' }), 'PT400', /Comment body/);
    await expectRefused(t.run('work.comment.create', { item: a.record.id, body: 'x'.repeat(20001) }), 'PT400', /Comment body/);
    const note = await t.run('work.comment.create', { item: a.record.id, body: 'x'.repeat(20000) });
    await expectRefused(t.run('work.comment.update', { id: note.record.id, item: b.record.id }, note.seq), 'PT400', /Invalid comment fields/);

    // Operator SQL is held to the same status/state agreement.
    await expectRefused(sql`update records_work.items set status='done' where id=${a.record.id}`, 'PT400', /State and status disagree/);
  } finally { await db.stop(); }
});

test('work planning: numbers are gapless and unique under concurrent creates', async () => {
  const db = await startDatabase(); const sql: Sql = db.sql;
  try {
    const t = await tenant(sql);
    const created = await Promise.all(Array.from({ length: 12 }, (_, i) => t.run('work.create', { title: `Parallel ${i}` }, null, 'test:ada', `parallel-${i}`)));
    assert.deepEqual(created.map(r => r.record.data.number).sort((x, y) => x - y), Array.from({ length: 12 }, (_, i) => i + 1));
    assert.ok(created.every(r => r.record.data.number === r.seq), 'numbers follow commit order');
    const cycles = await Promise.all([0, 1, 2].map(i => t.run('work.cycle.create', { starts_on: `2026-0${i + 1}-01`, ends_on: `2026-0${i + 1}-14` }, null, 'test:ada', `cycle-${i}`)));
    assert.deepEqual(cycles.map(r => r.record.data.number).sort(), [1, 2, 3]);
    // Default states were seeded exactly once, by whichever command committed first.
    assert.equal((await t.read('workflow_state')).records.length, 7);
    const overlapping = await Promise.all([0, 1].map(i => refused(t.run('work.cycle.create', { starts_on: '2026-06-01', ends_on: '2026-06-10' }, null, 'test:ada', `overlap-${i}`))));
    assert.deepEqual(overlapping.map(o => o.slice(0, 5)).sort(), ['PT409', 'accep']);
  } finally { await db.stop(); }
});

test('work planning: existing datastores are backfilled by migration 010', async () => {
  const db = await startDatabase({ until: '010-work-planning.sql' }); const sql: Sql = db.sql;
  try {
    const t = await tenant(sql);
    const empty = await tenant(sql, t.org);
    const made: Result[] = [];
    for (const [title, status] of [['First', 'open'], ['Second', 'active'], ['Third', 'done']]) made.push(await t.run('work.create', { title, status }));
    const edited = await t.run('work.update', { id: made[0]!.record.id, title: 'First!' }, made[0]!.seq);
    const storage = async () => [...await sql`select id,created_by,updated_by,revision from records_work.items order by id`].map(row => ({ ...row }));
    const before = await storage();
    const epoch = (await t.changes()).permission_epoch;
    await db.migrateRest();

    const items = (await t.read('work_item')).records;
    const byId = new Map(items.map((r: any) => [r.id, r]));
    assert.deepEqual(made.map(r => [(byId.get(r.record.id) as any).data.number, (byId.get(r.record.id) as any).data.state]), [[1, 'todo'], [2, 'in_progress'], [3, 'done']]);
    assert.deepEqual(await storage(), before, 'attribution and revisions are untouched');
    assert.equal((await t.read('workflow_state')).records.length, 7);
    assert.equal((await t.changes()).permission_epoch, epoch + 1, 'synced clients must take a new snapshot');
    await assert.rejects(t.as(undefined, (tx: any) => tx`select records_api.pull_changes(${t.datastore}::uuid,0,100,${epoch})`), (e: any) => e.code === 'PT409');
    // Later commands neither reseed nor renumber; an edited item keeps its number.
    const fourth = await t.run('work.create', { title: 'Fourth' });
    assert.equal(fourth.record.data.number, 4);
    assert.equal((await t.run('work.update', { id: made[0]!.record.id, title: 'First again' }, edited.seq)).record.data.number, 1);
    assert.equal((await t.read('workflow_state')).records.length, 7);
    assert.equal((await t.changes()).changes.filter((c: any) => c.entity === 'workflow_state').length, 0, 'backfilled states are not journalled');
    // A datastore with no commands yet is seeded by its first command instead.
    assert.equal((await empty.read('workflow_state')).records.length, 0);
    await empty.run('work.create', { title: 'Hello' });
    assert.equal((await empty.read('workflow_state')).records.length, 7);
    assert.equal((await empty.changes()).changes.length, 8);
  } finally { await db.stop(); }
});

test('work planning: runtime cannot touch storage or handlers, and publication checks pass', async () => {
  const db = await startDatabase(); const sql: Sql = db.sql;
  try {
    const t = await tenant(sql);
    const item = await t.run('work.create', { title: 'A' });
    for (const table of ['items', 'projects', 'cycles', 'workflow_states', 'labels', 'relations', 'comments']) {
      await assert.rejects(t.as(undefined, (tx: any) => tx.unsafe(`select * from records_work.${table}`)), (e: any) => e.code === '42501', table);
      await assert.rejects(t.as(undefined, (tx: any) => tx.unsafe(`update records_work.${table} set revision=0`)), (e: any) => e.code === '42501', table);
    }
    for (const call of [
      `select records_work.apply_project('${t.datastore}','work.project.create','{"name":"x"}',null,99)`,
      `select records_work.apply('${t.datastore}','work.create','{"title":"x"}',null,99)`,
      `select records_work.ensure_states('${t.datastore}',99)`,
      `select records_work.resolve_state('${t.datastore}','todo',null,null,null)`,
    ]) await assert.rejects(t.as(undefined, (tx: any) => tx.unsafe(call)), (e: any) => e.code === '42501', call);
    // Presentation views are the readable surface.
    for (const view of ['work_item', 'project', 'cycle', 'workflow_state', 'label', 'relation', 'comment']) {
      await t.as(undefined, (tx: any) => tx.unsafe(`select count(*) from present_work_v1.${view}`));
    }
    assert.equal((await t.as(undefined, async (tx: any) => (await tx`select number from present_work_v1.work_item where id=${item.record.id}`)[0].number)), '1');
    assert.deepEqual((await sql`select records_private.publication_errors('work',1) e`)[0]!.e, []);
    assert.deepEqual((await sql`select records_private.publication_errors('messaging',1) e`)[0]!.e, []);
    const handlers = await sql`select command,p.prosecdef,pg_get_userbyid(p.proowner) owner from records_private.commands x join pg_proc p on p.oid=x.handler::oid where module_id='work' order by command`;
    assert.equal(handlers.length, 14);
    assert.ok(handlers.every(h => h.prosecdef && h.owner === 'records_commander'));
  } finally { await db.stop(); }
});

test('record timestamps: server-set created_at/updated_at on records, created_at on changes, never data', async () => {
  const db = await startDatabase(); const sql: Sql = db.sql;
  try {
    const t = await tenant(sql);
    const made = await t.run('work.create', { title: 'Timed' });
    assert.equal(made.record.data.created_at, undefined, 'timestamps are not data');
    await sql`select pg_sleep(0.02)`;
    await t.run('work.update', { id: made.record.id, title: 'Timed 2' }, made.seq);
    const item = (await t.read('work_item')).records[0];
    assert.ok(Date.parse(item.created_at) < Date.parse(item.updated_at), 'updated_at advances, created_at stays');
    assert.equal(item.data.created_at, undefined);
    const feed = await t.changes();
    assert.ok(feed.changes.every((c: any) => typeof c.created_at === 'string' && !('created_at' in c.data)));
    await assert.rejects(t.run('work.update', { id: made.record.id, created_at: '2020-01-01T00:00:00Z' }, made.seq + 1), (e: any) => e.code === 'PT400');
  } finally { await db.stop(); }
});
