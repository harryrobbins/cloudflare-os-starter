-- New isolated Records service; apply to an empty database, never the legacy runtime.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE ROLE records_runtime NOLOGIN;
CREATE ROLE records_gateway NOLOGIN;
CREATE ROLE records_authenticator NOLOGIN;
GRANT records_runtime TO records_authenticator;
CREATE SCHEMA records_private;
CREATE SCHEMA records_api;
CREATE SCHEMA records;
REVOKE ALL ON SCHEMA records_private FROM PUBLIC;
GRANT USAGE ON SCHEMA records_api TO records_runtime;
GRANT USAGE ON SCHEMA records TO records_gateway;
ALTER DEFAULT PRIVILEGES IN SCHEMA records_private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA records_api REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA records REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE TABLE records_private.organisations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL);
CREATE TABLE records_private.principals(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),active boolean NOT NULL DEFAULT true);
CREATE TABLE records_private.memberships(org_id uuid REFERENCES records_private.organisations,id uuid REFERENCES records_private.principals,active boolean NOT NULL DEFAULT true,PRIMARY KEY(org_id,id));
CREATE TABLE records_private.modules(id text,api_major int CHECK(api_major>0),manifest jsonb NOT NULL,PRIMARY KEY(id,api_major));
CREATE TABLE records_private.datastores(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES records_private.organisations,module_id text NOT NULL,api_major int NOT NULL,seq bigint NOT NULL DEFAULT 0,permission_epoch bigint NOT NULL DEFAULT 1,FOREIGN KEY(module_id,api_major) REFERENCES records_private.modules);
CREATE TABLE records_private.bindings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),datastore_id uuid NOT NULL REFERENCES records_private.datastores,principal_id uuid NOT NULL REFERENCES records_private.principals,scopes text[] NOT NULL,active boolean NOT NULL DEFAULT true);
CREATE TABLE records_private.service_credentials(key_hash bytea PRIMARY KEY,binding_id uuid NOT NULL REFERENCES records_private.bindings,active boolean NOT NULL DEFAULT true);
CREATE TABLE records_private.commands(module_id text,api_major int,command text,required_scope text NOT NULL,handler regprocedure NOT NULL,PRIMARY KEY(module_id,api_major,command),FOREIGN KEY(module_id,api_major) REFERENCES records_private.modules);
-- Generic projection is owned by core; physical typed module tables remain authoritative.
CREATE TABLE records_private.records(datastore_id uuid REFERENCES records_private.datastores,id uuid,entity text NOT NULL,revision bigint NOT NULL,data jsonb NOT NULL,PRIMARY KEY(datastore_id,id));
CREATE TABLE records_private.journal(datastore_id uuid REFERENCES records_private.datastores,seq bigint,ordinal int,principal_id uuid NOT NULL,binding_id uuid NOT NULL,entity text NOT NULL,record_id uuid NOT NULL,revision bigint NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(datastore_id,seq,ordinal));
CREATE TABLE records_private.idempotency(datastore_id uuid,principal_id uuid,binding_id uuid,module_id text,api_major int,command text,key text,digest bytea NOT NULL,result jsonb NOT NULL,PRIMARY KEY(datastore_id,principal_id,binding_id,module_id,api_major,command,key));
CREATE TABLE records_private.outbox(datastore_id uuid,seq bigint,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(datastore_id,seq));
CREATE FUNCTION records_private.claims() RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
CREATE FUNCTION records_private.authorize(target uuid,required_scope text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,records_private AS $$
DECLARE c jsonb:=records_private.claims(); p uuid; o uuid; b uuid; d records_private.datastores; grant_row records_private.bindings;
BEGIN
 IF c->>'iss' IS DISTINCT FROM 'records-gateway' OR c->>'aud' IS DISTINCT FROM 'records' OR jsonb_typeof(c->'scope') IS DISTINCT FROM 'array' OR c->>'exp' IS NULL OR (c->>'exp')::numeric <= extract(epoch FROM clock_timestamp()) THEN RAISE SQLSTATE 'PT401' USING MESSAGE='Invalid identity'; END IF;
 p:=(c->>'sub')::uuid; o:=(c->>'org_id')::uuid; b:=(c->>'binding_id')::uuid;
 IF p IS NULL OR o IS NULL OR b IS NULL OR (c->>'datastore_id')::uuid IS DISTINCT FROM target THEN RAISE SQLSTATE 'PT403' USING MESSAGE='Access denied'; END IF;
 -- Shared locks held to commit prevent concurrent revocation overtaking writes.
 PERFORM 1 FROM records_private.principals WHERE id=p AND active FOR SHARE;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT403' USING MESSAGE='Access denied'; END IF;
 PERFORM 1 FROM records_private.memberships WHERE org_id=o AND id=p AND active FOR SHARE;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT403' USING MESSAGE='Access denied'; END IF;
 SELECT * INTO grant_row FROM records_private.bindings WHERE id=b AND principal_id=p AND datastore_id=target AND active FOR SHARE;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT403' USING MESSAGE='Access denied'; END IF;
 SELECT * INTO d FROM records_private.datastores WHERE id=target AND org_id=o;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT403' USING MESSAGE='Access denied'; END IF;
 IF required_scope IS NOT NULL AND (NOT required_scope=ANY(grant_row.scopes) OR NOT (c->'scope' ? required_scope)) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='Scope denied'; END IF;
 RETURN c;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE SQLSTATE 'PT401' USING MESSAGE='Invalid identity';
END $$;
CREATE FUNCTION records_api.pre_request() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,records_private AS $$ BEGIN PERFORM records_private.authorize((records_private.claims()->>'datastore_id')::uuid); END $$;
CREATE FUNCTION records.authenticate_api_key(key text,target_datastore uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,records_private AS $$
DECLARE result jsonb;
BEGIN
 SELECT jsonb_build_object('subject',p.id,'module_id',d.module_id,'org_id',d.org_id,'datastore_id',d.id,'binding_id',b.id,'scope',to_jsonb(b.scopes),'permission_epoch',d.permission_epoch) INTO result
 FROM records_private.service_credentials k JOIN records_private.bindings b ON b.id=k.binding_id JOIN records_private.principals p ON p.id=b.principal_id JOIN records_private.datastores d ON d.id=b.datastore_id JOIN records_private.memberships m ON m.id=p.id AND m.org_id=d.org_id
 WHERE k.key_hash=public.digest(key,'sha256') AND d.id=target_datastore AND k.active AND (k.expires_at IS NULL OR k.expires_at>now()) AND b.active AND p.active AND m.active;
 IF result IS NULL THEN RAISE SQLSTATE 'PT401' USING MESSAGE='Invalid credential'; END IF;
 RETURN result;
END $$;
CREATE FUNCTION records_api.execute_command(datastore_id uuid,module_id text,api_major int,command text,input jsonb,idempotency_key text,expected_revision bigint DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,records_private AS $$
DECLARE c jsonb; ds records_private.datastores; cmd records_private.commands; old records_private.idempotency; dig bytea; result jsonb; record jsonb; next_seq bigint; function_name text;
BEGIN
 c:=records_private.authorize(datastore_id);
 SELECT * INTO ds FROM records_private.datastores d WHERE d.id=datastore_id FOR UPDATE;
 IF ds.module_id<>module_id OR ds.api_major<>api_major THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Module unavailable'; END IF;
 SELECT * INTO cmd FROM records_private.commands x WHERE x.module_id=execute_command.module_id AND x.api_major=execute_command.api_major AND x.command=execute_command.command;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Command unavailable'; END IF;
 PERFORM records_private.authorize(datastore_id,cmd.required_scope);
 IF idempotency_key IS NULL OR length(idempotency_key) NOT BETWEEN 1 AND 200 OR jsonb_typeof(input) IS DISTINCT FROM 'object' OR octet_length(input::text)>65536 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid command request'; END IF;
 dig:=public.digest(jsonb_build_object('input',input,'revision',expected_revision)::text,'sha256');
 SELECT * INTO old FROM records_private.idempotency i WHERE i.datastore_id=execute_command.datastore_id AND i.principal_id=(c->>'sub')::uuid AND i.binding_id=(c->>'binding_id')::uuid AND i.module_id=execute_command.module_id AND i.api_major=execute_command.api_major AND i.command=execute_command.command AND i.key=idempotency_key;
 IF FOUND THEN IF old.digest<>dig THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Idempotency key reused'; END IF; RETURN old.result; END IF;
 next_seq:=ds.seq+1;
 SELECT format('%I.%I',n.nspname,p.proname) INTO function_name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=cmd.handler::oid;
 EXECUTE format('SELECT %s($1,$2,$3,$4,$5)',function_name) INTO record USING datastore_id,command,input,expected_revision,next_seq;
 INSERT INTO records_private.records VALUES(datastore_id,(record->>'id')::uuid,record->>'entity',next_seq,record->'data') ON CONFLICT ON CONSTRAINT records_pkey DO UPDATE SET revision=excluded.revision,data=excluded.data;
 UPDATE records_private.datastores d SET seq=next_seq WHERE d.id=datastore_id;
 INSERT INTO records_private.journal VALUES(datastore_id,next_seq,0,(c->>'sub')::uuid,(c->>'binding_id')::uuid,record->>'entity',(record->>'id')::uuid,next_seq,record->'data',now());
 INSERT INTO records_private.outbox(datastore_id,seq) VALUES(datastore_id,next_seq);
 result:=jsonb_build_object('record',record||jsonb_build_object('revision',next_seq),'seq',next_seq,'permission_epoch',ds.permission_epoch);
 INSERT INTO records_private.idempotency VALUES(datastore_id,(c->>'sub')::uuid,(c->>'binding_id')::uuid,module_id,api_major,command,idempotency_key,dig,result);
 PERFORM pg_notify('records_changes',jsonb_build_object('datastore_id',datastore_id,'seq',next_seq)::text);
 RETURN result;
END $$;
CREATE FUNCTION records_api.read_records(datastore_id uuid,module_id text,api_major int,entity text DEFAULT NULL,record_id uuid DEFAULT NULL,limit_count int DEFAULT 100,after_id uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,records_private AS $$
DECLARE ds records_private.datastores; result jsonb;
BEGIN
 PERFORM records_private.authorize(datastore_id,module_id||'.read');
 SELECT * INTO ds FROM records_private.datastores d WHERE d.id=datastore_id;
 IF ds.module_id<>module_id OR ds.api_major<>api_major THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Module unavailable'; END IF;
 IF limit_count NOT BETWEEN 1 AND 500 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid page size'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) INTO result FROM (SELECT x.id,x.entity,x.revision,x.data FROM records_private.records x WHERE x.datastore_id=read_records.datastore_id AND (read_records.entity IS NULL OR x.entity=read_records.entity) AND (record_id IS NULL OR x.id=record_id) AND (after_id IS NULL OR x.id>after_id) ORDER BY x.id LIMIT limit_count) r;
 RETURN jsonb_build_object('records',result,'permission_epoch',ds.permission_epoch,'seq',ds.seq);
END $$;
CREATE FUNCTION records_api.pull_changes(datastore_id uuid,after_seq bigint DEFAULT 0,limit_count int DEFAULT 100,permission_epoch bigint DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,records_private AS $$
DECLARE ds records_private.datastores; result jsonb; cursor_seq bigint;
BEGIN
 PERFORM records_private.authorize(datastore_id);
 SELECT * INTO ds FROM records_private.datastores d WHERE d.id=datastore_id;
 PERFORM records_private.authorize(datastore_id,ds.module_id||'.read');
 IF permission_epoch IS NOT NULL AND permission_epoch<>ds.permission_epoch THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Permission epoch changed; reset cache'; END IF;
 IF after_seq<0 OR after_seq>ds.seq OR limit_count NOT BETWEEN 1 AND 500 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid cursor'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb),coalesce(max(r.seq),after_seq) INTO result,cursor_seq FROM (SELECT j.seq,j.ordinal,j.entity,j.record_id,j.revision,j.data FROM records_private.journal j WHERE j.datastore_id=pull_changes.datastore_id AND j.seq>after_seq ORDER BY j.seq,j.ordinal LIMIT limit_count) r;
 RETURN jsonb_build_object('changes',result,'cursor',cursor_seq,'permission_epoch',ds.permission_epoch);
END $$;
CREATE FUNCTION records_api.describe_datastore(datastore_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,records_private AS $$ BEGIN
 PERFORM records_private.authorize(datastore_id);
 RETURN (SELECT jsonb_build_object('id',d.id,'module_id',d.module_id,'api_major',d.api_major,'permission_epoch',d.permission_epoch,'granted_scopes',to_jsonb(b.scopes),'modules',jsonb_build_array(m.manifest)) FROM records_private.datastores d JOIN records_private.modules m ON m.id=d.module_id AND m.api_major=d.api_major JOIN records_private.bindings b ON b.id=(records_private.claims()->>'binding_id')::uuid WHERE d.id=datastore_id);
END $$;
-- Defence in depth on private projections. Runtime receives no table grants.
ALTER TABLE records_private.records ENABLE ROW LEVEL SECURITY;
ALTER TABLE records_private.journal ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_records ON records_private.records USING (datastore_id=(records_private.claims()->>'datastore_id')::uuid);
CREATE POLICY tenant_journal ON records_private.journal USING (datastore_id=(records_private.claims()->>'datastore_id')::uuid);
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA records_api TO records_runtime;
GRANT EXECUTE ON FUNCTION records.authenticate_api_key(text,uuid) TO records_gateway;
COMMIT;
