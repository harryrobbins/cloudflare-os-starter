import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { migrate } from './migrate.ts';
import { getRuntimeProfile } from '@records/model/bundled';

const sql = postgres(process.env.RECORDS_MIGRATION_URL!, { max: 1, onnotice: () => {} });
try {
  await migrate(sql);
  // All names fixed; local random hex passwords are quoted by the driver, never logged.
  await sql`SELECT set_config('records.local_postgrest_password', ${process.env.POSTGREST_PASSWORD!}, false)`;
  await sql`SELECT set_config('records.local_gateway_password', ${process.env.GATEWAY_PASSWORD!}, false)`;
  await sql`SELECT set_config('records.local_listener_password', ${process.env.LISTENER_PASSWORD!}, false)`;
  await sql.unsafe(`DO $$ BEGIN
    EXECUTE format('ALTER ROLE records_authenticator LOGIN NOINHERIT PASSWORD %L', current_setting('records.local_postgrest_password'));
    EXECUTE format('ALTER ROLE records_gateway LOGIN PASSWORD %L', current_setting('records.local_gateway_password'));
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='records_listener') THEN CREATE ROLE records_listener LOGIN; END IF;
    EXECUTE format('ALTER ROLE records_listener PASSWORD %L', current_setting('records.local_listener_password'));
  END $$`);
  const client = JSON.parse(await readFile(new URL('../.eval/client.json', import.meta.url), 'utf8'));
  await sql.begin(async tx => {
    await tx`INSERT INTO records_private.organisations(id,name) VALUES(${client.orgId},'Local Records evaluation') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO records_private.principals(id) VALUES(${client.principalId}) ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO records_private.memberships(org_id,id) VALUES(${client.orgId},${client.principalId}) ON CONFLICT DO NOTHING`;
    for (const module of ['work', 'messaging']) {
      const c = client[module];
      const profile = getRuntimeProfile(module)!;
      const manifest = {id:module,version:'0.1.0',api_majors:[1],scopes:[`${module}.read`,`${module}.write`],entities:Object.keys(profile.entities),commands:module==='work'?['work.create','work.update']:['messaging.send','messaging.edit'],profile};
      await tx`UPDATE records_private.modules SET manifest=${tx.json(JSON.parse(JSON.stringify(manifest)))} WHERE id=${module} AND api_major=1`; 
      await tx`INSERT INTO records_private.datastores(id,org_id,module_id,api_major) VALUES(${c.datastoreId},${client.orgId},${module},1) ON CONFLICT DO NOTHING`;
      await tx`INSERT INTO records_private.bindings(id,datastore_id,principal_id,scopes) VALUES(${c.bindingId},${c.datastoreId},${client.principalId},${[`${module}.read`, `${module}.write`]}) ON CONFLICT DO NOTHING`;
      await tx`INSERT INTO records_private.service_credentials(key_hash,binding_id) VALUES(public.digest(${c.key},'sha256'),${c.bindingId}) ON CONFLICT DO NOTHING`;
    }
  });
  console.log('New-service migrations and isolated local work/messaging datastores ready.');
} finally { await sql.end(); }
