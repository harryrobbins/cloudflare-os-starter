/** Privileged deployment job. Installs schema and login roles; creates no tenants or demo data. */
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { migrate } from '../scripts/migrate.ts';
import { getRuntimeProfile } from '@records/model/bundled';
const secret = async (name:string) => (await readFile(`/run/secrets/${name}`,'utf8')).replace(/\r?\n$/,'');
const host=process.env.RECORDS_DATABASE_HOST ?? 'db';
const sql=postgres({host,port:5432,database:'records',username:'postgres',password:await secret('postgres_password'),max:1,onnotice:()=>{}});
try {
 await migrate(sql);
 await sql.begin(async tx=>{
  for(const name of ['authenticator','gateway','listener']) await tx`select set_config(${`records.deploy.${name}`},${await secret(`${name}_password`)},true)`;
  await tx.unsafe(`DO $$ BEGIN
   EXECUTE format('ALTER ROLE records_authenticator LOGIN NOINHERIT PASSWORD %L',current_setting('records.deploy.authenticator'));
   EXECUTE format('ALTER ROLE records_gateway LOGIN PASSWORD %L',current_setting('records.deploy.gateway'));
   IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='records_listener') THEN CREATE ROLE records_listener LOGIN; END IF;
   EXECUTE format('ALTER ROLE records_listener PASSWORD %L',current_setting('records.deploy.listener'));
  END $$`);
  for(const module of ['work','messaging']) {
   const profile=getRuntimeProfile(module)!;
   // Preserve module registration; add the checked-in executable profile only.
   await tx`update records_private.modules set manifest=jsonb_set(manifest,'{profile}',${tx.json(JSON.parse(JSON.stringify(profile)))}) where id=${module} and api_major=1`;
  }
 });
 console.log('Schema and login configuration applied. No tenants, grants or demo records created.');
} finally {await sql.end();}
