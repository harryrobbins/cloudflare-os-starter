import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

// Operator-only local evaluation: deliberately severs the local LISTEN connection.
// Never run while another notification measurement is active.
test('live local relay reconnect, missed hints, revocation and permission reset', { skip: process.env.RECORDS_RELAY_INTEGRATION !== '1', timeout: 45000 }, async () => {
 const database=process.env.RECORDS_MIGRATION_URL;
 assert(database && new URL(database).hostname==='db','private local Compose database required');
 const sql=postgres(database,{max:2,onnotice:()=>{}});
 const fixture=JSON.parse(await readFile(new URL('../.eval/client.json',import.meta.url),'utf8'));
 const datastore=randomUUID(),binding=randomUUID(),key=`relay_${randomUUID()}_${randomUUID()}`;
 const base=`http://gateway:8788/v1/datastores/${datastore}`;
 const headers={authorization:`Bearer ${key}`,'content-type':'application/json'};
 const controllers:AbortController[]=[];
 try {
  await sql.begin(async tx=>{
   await tx`insert into records_private.datastores(id,org_id,module_id,api_major) values(${datastore},${fixture.orgId},'work',1)`;
   await tx`insert into records_private.bindings(id,datastore_id,principal_id,scopes) values(${binding},${datastore},${fixture.principalId},ARRAY['work.read','work.write'])`;
   await tx`insert into records_private.service_credentials(key_hash,binding_id) values(public.digest(${key},'sha256'),${binding})`;
  });
  const connect=async()=>{
   const controller=new AbortController();controllers.push(controller);
   const response=await fetch(`${base}/events`,{headers,signal:controller.signal});assert.equal(response.status,200);
   const reader=response.body!.getReader();let pending='';const decoder=new TextDecoder();
   const frame=async()=>{for(;;){const end=pending.indexOf('\n\n');if(end>=0){const value=pending.slice(0,end);pending=pending.slice(end+2);return value;}const part=await reader.read();if(part.done)return null;pending+=decoder.decode(part.value,{stream:true});}};
   assert.match((await frame())!,/event: changes/);
   return {controller,frame};
  };
  const command=async(index:number)=>{
   const response=await fetch(`${base}/modules/work/v1/rpc/work.create`,{method:'POST',headers:{...headers,'idempotency-key':`relay-${index}`},body:JSON.stringify({title:`Relay recovery ${index}`})});assert.equal(response.status,200);return response.json();
  };
  const first=await connect();first.controller.abort();
  for(let i=0;i<3;i++)await command(i);
  const recovered=await (await fetch(`${base}/changes?after=0`,{headers})).json();assert.equal(recovered.changes.length,3);assert.equal(recovered.cursor,3);
  const stopped=await sql`select pg_terminate_backend(pid) stopped from pg_stat_activity where usename='records_listener' and datname=current_database() and pid<>pg_backend_pid()`;
  assert(stopped.some(row=>row.stopped),'existing listener backend should have been restarted');
  await new Promise(resolve=>setTimeout(resolve,1500));
  const resumed=await connect();
  const hint=resumed.frame();await command(3);
  const timeout=(ms:number)=>new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('Relay deadline exceeded')),ms);timer.unref();});
  assert.match((await Promise.race([hint,timeout(5000)]))!,/event: changes/);
  const afterRestart=await (await fetch(`${base}/changes?after=3`,{headers})).json();assert.equal(afterRestart.changes.length,1);assert.equal(afterRestart.cursor,4);
  await sql`update records_private.bindings set scopes=ARRAY['work.write'] where id=${binding}`;
  const denied=await fetch(`${base}/changes?after=0`,{headers});assert.equal(denied.status,403);await denied.body?.cancel();
  const deniedStream=await fetch(`${base}/events`,{headers});assert.equal(deniedStream.status,403);await deniedStream.body?.cancel();
  assert.equal(await Promise.race([resumed.frame(),timeout(20000)]),null,'existing stream closes when grants change');
  await sql`update records_private.bindings set scopes=ARRAY['work.read','work.write'] where id=${binding}`;
  const reset=await fetch(`${base}/changes?after=3&epoch=${recovered.permission_epoch}`,{headers});assert.equal(reset.status,409);await reset.body?.cancel();
  await sql`update records_private.service_credentials set expires_at=now()-interval '1 second' where binding_id=${binding}`;
  const expired=await fetch(`${base}/describe`,{headers});assert.equal(expired.status,401);await expired.body?.cancel();
 } finally {for(const controller of controllers)controller.abort();await sql.end();}
});
