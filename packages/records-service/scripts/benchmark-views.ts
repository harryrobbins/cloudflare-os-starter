// Compares presentation-view reads (RLS, security_barrier views, invoker functions) with the
// pre-presentation read of the generic projection, on embedded Postgres. Local evidence only.
//   node scripts/benchmark-views.ts [records=5000] [iterations=200]
import { randomUUID } from 'node:crypto';
// @ts-ignore Shared JavaScript test helper.
import { startDatabase } from '../test/database-helpers.mjs';

const count = Number(process.argv[2] ?? 5000), iterations = Number(process.argv[3] ?? 200);
const db = await startDatabase(); const sql = db.sql;
try {
  const org = randomUUID(), principal = randomUUID(), datastore = randomUUID(), binding = randomUUID();
  await sql`insert into records_private.organisations(id,name) values(${org},'benchmark')`;
  await sql`insert into records_private.principals(id) values(${principal})`;
  await sql`insert into records_private.memberships(org_id,id) values(${org},${principal})`;
  await sql`insert into records_private.datastores(id,org_id,module_id,api_major,seq) values(${datastore},${org},'work',1,${count})`;
  await sql`insert into records_private.bindings(id,datastore_id,principal_id,scopes) values(${binding},${datastore},${principal},ARRAY['work.read','work.write'])`;
  await sql`insert into records_work.items(datastore_id,id,title,status,revision) select ${datastore},gen_random_uuid(),'Item '||n,'open',n from generate_series(1,${count}) n`;
  await sql`insert into records_private.records(datastore_id,id,entity,revision,data,created_by,updated_by) select datastore_id,id,'work_item',revision,jsonb_build_object('title',title,'status',status,'description',description,'extensions',extensions),created_by,updated_by from records_work.items`;
  await sql`analyze`;
  const claims = JSON.stringify({ iss: 'records-gateway', aud: 'records', sub: principal, org_id: org, datastore_id: datastore, binding_id: binding, scope: ['work.read', 'work.write'], exp: Math.floor(Date.now() / 1000) + 3600 });
  const time = async (label: string, role: string, query: (tx: any) => Promise<unknown>) => {
    const samples: number[] = [];
    for (let i = 0; i < iterations + 10; i++) {
      const start = performance.now();
      await sql.begin(async (tx: any) => { await tx.unsafe(`set local role ${role}`); await tx`select set_config('request.jwt.claims',${claims},true)`; await query(tx); });
      if (i >= 10) samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const at = (p: number) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))]!.toFixed(3);
    console.log(`${label.padEnd(44)} p50 ${at(0.5)} ms  p95 ${at(0.95)} ms`);
  };
  console.log(`${count} work items, ${iterations} iterations each (transaction incl. role and claims setup)`);
  // The pre-presentation read_records body: an owner-run read of the generic projection.
  await time('page of 100, projection (before)', 'postgres', tx => tx`select coalesce(jsonb_agg(to_jsonb(r)),'[]') from (select x.id,x.entity,x.revision,x.data from records_private.records x where x.datastore_id=${datastore} order by x.id limit 100) r`);
  await time('page of 100, presentation view (read_records)', 'records_runtime', tx => tx`select records_api.read_records(${datastore}::uuid,'work',1,null,null,100)`);
  await time(`snapshot of ${count}, projection (before)`, 'postgres', tx => tx`select coalesce(jsonb_agg(to_jsonb(r)),'[]') from (select p.id,p.entity,p.revision,p.data from records_private.records p where p.datastore_id=${datastore} order by p.id limit ${count + 1}) r`);
  await time(`snapshot of ${count}, presentation view`, 'records_runtime', tx => tx`select records_api.snapshot_records(${datastore}::uuid,'work',1,${count})`);
} finally { await db.stop(); }
