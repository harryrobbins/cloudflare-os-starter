import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';

export const migrations=['001-core.sql','002-modules.sql','003-permission-epochs.sql','004-snapshot-and-rpc-validation.sql','005-public-model.sql','006-describe-qualification.sql','007-actor-attribution.sql','008-presentation-schema.sql','009-actor-roles.sql','010-work-planning.sql'];

export async function startDatabase({until}={}) {
 const dir=await mkdtemp(join(tmpdir(),'records-new-pg-'));
 const port=await new Promise(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const pg=new EmbeddedPostgres({databaseDir:dir,user:'postgres',password:'test-only',port,persistent:false,onLog:()=>{},onError:()=>{}});
 await pg.initialise(); await pg.start();
 const sql=postgres(`postgres://postgres:test-only@127.0.0.1:${port}/postgres`,{max:20,onnotice:()=>{}});
 const apply=async names=>{ const migration=await sql.reserve(); try { for(const name of names) await migration.unsafe(await readFile(new URL(`../sql/${name}`,import.meta.url),'utf8')); } finally { migration.release(); } };
 // `until` stops before that migration, so a test can seed data and then apply the rest.
 const stop=until?migrations.indexOf(until):migrations.length;
 try { await apply(migrations.slice(0,stop)); } catch(e) { console.error(e); await sql.end();await pg.stop();throw e; }
 return {sql,port,async migrateRest(){await apply(migrations.slice(stop));},async stop(){await sql.end();await pg.stop();await rm(dir,{recursive:true,force:true});}};
}
