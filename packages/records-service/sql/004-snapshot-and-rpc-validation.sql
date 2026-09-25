-- Harden direct RPC argument validation and provide an atomic bounded sync bootstrap.
BEGIN;

CREATE OR REPLACE FUNCTION records_api.execute_command(datastore_id uuid,module_id text,api_major int,command text,input jsonb,idempotency_key text,expected_revision bigint DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,records_private AS $$
DECLARE c jsonb; ds records_private.datastores; cmd records_private.commands; old records_private.idempotency; dig bytea; result jsonb; record jsonb; next_seq bigint; function_name text;
BEGIN
 c:=records_private.authorize(datastore_id);
 SELECT * INTO ds FROM records_private.datastores d WHERE d.id=datastore_id FOR UPDATE;
 IF ds.module_id IS DISTINCT FROM module_id OR ds.api_major IS DISTINCT FROM api_major THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Module unavailable'; END IF;
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

CREATE OR REPLACE FUNCTION records_api.read_records(datastore_id uuid,module_id text,api_major int,entity text DEFAULT NULL,record_id uuid DEFAULT NULL,limit_count int DEFAULT 100,after_id uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,records_private AS $$
DECLARE ds records_private.datastores; result jsonb;
BEGIN
 PERFORM records_private.authorize(datastore_id,module_id||'.read');
 SELECT * INTO ds FROM records_private.datastores d WHERE d.id=datastore_id;
 IF ds.module_id IS DISTINCT FROM module_id OR ds.api_major IS DISTINCT FROM api_major THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Module unavailable'; END IF;
 IF limit_count IS NULL OR limit_count NOT BETWEEN 1 AND 500 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid page size'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) INTO result FROM (SELECT x.id,x.entity,x.revision,x.data FROM records_private.records x WHERE x.datastore_id=read_records.datastore_id AND (read_records.entity IS NULL OR x.entity=read_records.entity) AND (record_id IS NULL OR x.id=record_id) AND (after_id IS NULL OR x.id>after_id) ORDER BY x.id LIMIT limit_count) r;
 RETURN jsonb_build_object('records',result,'permission_epoch',ds.permission_epoch,'seq',ds.seq);
END $$;

CREATE OR REPLACE FUNCTION records_api.pull_changes(datastore_id uuid,after_seq bigint DEFAULT 0,limit_count int DEFAULT 100,permission_epoch bigint DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,records_private AS $$
DECLARE ds records_private.datastores; result jsonb; cursor_seq bigint;
BEGIN
 PERFORM records_private.authorize(datastore_id);
 SELECT * INTO ds FROM records_private.datastores d WHERE d.id=datastore_id;
 PERFORM records_private.authorize(datastore_id,ds.module_id||'.read');
 IF permission_epoch IS NOT NULL AND permission_epoch<>ds.permission_epoch THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Permission epoch changed; reset cache'; END IF;
 IF after_seq IS NULL OR after_seq<0 OR after_seq>ds.seq OR limit_count IS NULL OR limit_count NOT BETWEEN 1 AND 500 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid cursor'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb),coalesce(max(r.seq),after_seq) INTO result,cursor_seq FROM (SELECT j.seq,j.ordinal,j.entity,j.record_id,j.revision,j.data FROM records_private.journal j WHERE j.datastore_id=pull_changes.datastore_id AND j.seq>after_seq ORDER BY j.seq,j.ordinal LIMIT limit_count) r;
 RETURN jsonb_build_object('changes',result,'cursor',cursor_seq,'permission_epoch',ds.permission_epoch);
END $$;

CREATE FUNCTION records_api.snapshot_records(datastore_id uuid,module_id text,api_major int,limit_count int DEFAULT 1000) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,records_private AS $$
DECLARE result jsonb; row_count int; ds records_private.datastores;
BEGIN
 PERFORM records_private.authorize(datastore_id);
 SELECT * INTO ds FROM records_private.datastores d WHERE d.id=datastore_id;
 IF ds.module_id IS DISTINCT FROM module_id OR ds.api_major IS DISTINCT FROM api_major THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Module unavailable'; END IF;
 PERFORM records_private.authorize(datastore_id,module_id||'.read');
 IF limit_count IS NULL OR limit_count NOT BETWEEN 1 AND 5000 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid snapshot limit'; END IF;
 -- Counter and records are read in ONE statement snapshot. Fail closed instead of
 -- returning a page falsely presented as a complete sync bootstrap.
 SELECT jsonb_build_object('records',r.rows,'seq',d.seq,'permission_epoch',d.permission_epoch,'complete',true),r.count INTO result,row_count
 FROM records_private.datastores d CROSS JOIN LATERAL (
  SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) rows,count(*)::int count
  FROM (SELECT p.id,p.entity,p.revision,p.data FROM records_private.records p WHERE p.datastore_id=d.id ORDER BY p.id LIMIT limit_count+1) x
 ) r WHERE d.id=datastore_id;
 IF row_count>limit_count THEN RAISE SQLSTATE 'PT413' USING MESSAGE='Datastore exceeds bounded snapshot; export workflow required'; END IF;
 RETURN result;
END $$;
GRANT EXECUTE ON FUNCTION records_api.snapshot_records(uuid,text,int,int) TO records_runtime;
COMMIT;
