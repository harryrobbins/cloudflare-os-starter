/** Disposable local Compose restore exercise. Never restores into the source database. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const directory = fileURLToPath(new URL('../',import.meta.url));
const compose = ['compose','--project-directory',directory,'--env-file',resolve(directory,'.eval/compose.env'),'-f',resolve(directory,'compose.yaml'),'exec','-T','db'];
function run(args:string[], input?:Buffer):Promise<Buffer> {
 return new Promise((resolve,reject)=>{
  const child=spawn('docker',[...compose,...args],{stdio:['pipe','pipe','pipe']});
  const output:Buffer[]=[]; const errors:Buffer[]=[]; let size=0;
  child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>128*1024*1024){child.kill();reject(new Error('Local rehearsal dump exceeds 128 MiB bound'));}else output.push(chunk);});
  child.stderr.on('data',(chunk:Buffer)=>errors.push(chunk));
  child.on('error',reject);child.on('close',code=>code===0?resolve(Buffer.concat(output)):reject(new Error(`Local database tool exited ${code}: ${Buffer.concat(errors).toString()}`)));
  child.stdin.on('error',()=>{}); child.stdin.end(input);
 });
}
const evidenceSql = `
CREATE TEMP TABLE restore_evidence(name text,rows bigint,digest text);
DO $check$
DECLARE relation record;
BEGIN
 FOR relation IN SELECT schemaname,tablename FROM pg_tables WHERE schemaname LIKE 'records%' OR (schemaname='public' AND tablename='records_service_migrations') ORDER BY schemaname,tablename LOOP
  EXECUTE format('INSERT INTO restore_evidence SELECT %L,count(*),md5(coalesce(string_agg(row_to_json(t)::text,E''\\n'' ORDER BY row_to_json(t)::text),'''')) FROM %I.%I t',relation.schemaname||'.'||relation.tablename,relation.schemaname,relation.tablename);
 END LOOP;
END $check$;
SELECT coalesce(json_agg(restore_evidence ORDER BY name),'[]'::json) FROM restore_evidence;
`;
async function evidence(database:string) {
 const text=(await run(['psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',database],Buffer.from(evidenceSql))).toString().trim();
 return JSON.parse(text) as {name:string;rows:number;digest:string}[];
}
export async function restoreRehearsal() {
 const source='records'; // Fixed local reference-stack database. No external connection URL accepted.
 const target='records_restore_'+randomBytes(8).toString('hex');
 let created=false;
 try {
  const before=await evidence(source);
  if (!before.some(row=>row.name==='public.records_service_migrations')) throw new Error('Source has no new-service migration ledger');
  const dump=await run(['pg_dump','-U','postgres','-d',source,'--format=custom','--no-owner','--no-acl']);
  await run(['createdb','-U','postgres','--template=template0',target]);created=true;
  await run(['pg_restore','-U','postgres','-d',target,'--exit-on-error','--no-owner','--no-acl'],dump);
  const restored=await evidence(target);const after=await evidence(source);
  if (JSON.stringify(before)!==JSON.stringify(after)) throw new Error('Source changed during rehearsal; stop local writers and repeat');
  if (JSON.stringify(before)!==JSON.stringify(restored)) throw new Error('Restored rows/checksums differ from source');
  const report={result:'passed',source:'isolated local Compose records database',restoredDatabase:target,tables:restored.length,rows:restored.reduce((n,t)=>n+t.rows,0),dumpBytes:dump.length,checks:['all Records table row counts and content digests','command journal','core migration ledger','module ledger when installed'],limitations:['local logical restore only','roles already exist in this local Postgres cluster','not a production PITR or cross-cluster credential recovery rehearsal']};
  console.log(JSON.stringify(report,null,2));return report;
 } finally {
  if(created) await run(['dropdb','-U','postgres',target]); // Only the random database created above.
 }
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) await restoreRehearsal();
