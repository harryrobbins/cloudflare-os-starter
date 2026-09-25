-- Stage 1: who acted. A binding may name a delegated actor (RFC 8693 `act`) only inside its own
-- attribution namespace; otherwise the actor is the binding's principal. Postgres sets every
-- attribution column from records.actor(); client input never can.
BEGIN;
ALTER TABLE records_private.bindings ADD COLUMN attribution_namespace text
 CHECK (attribution_namespace ~ '^[a-z][a-z0-9-]{0,39}$' AND attribution_namespace <> 'records');

GRANT USAGE ON SCHEMA records TO records_runtime;
CREATE FUNCTION records.current_datastore() RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT (coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'datastore_id')::uuid
$$;
-- NULL outside a request (operator SQL). Validated by records_private.authorize before any use.
CREATE FUNCTION records.actor() RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(c->'act'->>'sub', 'records:principal:'||(c->>'sub'))
 FROM (SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb c) x
$$;
GRANT EXECUTE ON FUNCTION records.current_datastore(), records.actor() TO records_runtime;

CREATE OR REPLACE FUNCTION records_private.authorize(target uuid,required_scope text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,records_private AS $$
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
 -- The actor is only as trustworthy as the binding naming it: namespace-bound and re-checked here.
 IF c ? 'act' AND (jsonb_typeof(c->'act') IS DISTINCT FROM 'object' OR jsonb_typeof(c->'act'->'sub') IS DISTINCT FROM 'string'
   OR grant_row.attribution_namespace IS NULL OR (c->'act'->>'sub') !~ ('^'||grant_row.attribution_namespace||':[!-~]{1,255}$')) THEN
  RAISE SQLSTATE 'PT403' USING MESSAGE='Attribution denied';
 END IF;
 SELECT * INTO d FROM records_private.datastores WHERE id=target AND org_id=o;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT403' USING MESSAGE='Access denied'; END IF;
 IF required_scope IS NOT NULL AND (NOT required_scope=ANY(grant_row.scopes) OR NOT (c->'scope' ? required_scope)) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='Scope denied'; END IF;
 RETURN c;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE SQLSTATE 'PT401' USING MESSAGE='Invalid identity';
END $$;

CREATE OR REPLACE FUNCTION records.authenticate_api_key(key text,target_datastore uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,records_private AS $$
DECLARE result jsonb;
BEGIN
 SELECT jsonb_build_object('subject',p.id,'module_id',d.module_id,'org_id',d.org_id,'datastore_id',d.id,'binding_id',b.id,'scope',to_jsonb(b.scopes),'permission_epoch',d.permission_epoch,'attribution_namespace',b.attribution_namespace) INTO result
 FROM records_private.service_credentials k JOIN records_private.bindings b ON b.id=k.binding_id JOIN records_private.principals p ON p.id=b.principal_id JOIN records_private.datastores d ON d.id=b.datastore_id JOIN records_private.memberships m ON m.id=p.id AND m.org_id=d.org_id
 WHERE k.key_hash=public.digest(key,'sha256') AND d.id=target_datastore AND k.active AND (k.expires_at IS NULL OR k.expires_at>now()) AND b.active AND p.active AND m.active;
 IF result IS NULL THEN RAISE SQLSTATE 'PT401' USING MESSAGE='Invalid credential'; END IF;
 RETURN result;
END $$;

-- Journal attribution. Existing rows were written by their binding's principal.
ALTER TABLE records_private.journal ADD COLUMN actor text, ADD COLUMN owner_at_change text;
UPDATE records_private.journal SET actor='records:principal:'||principal_id;
ALTER TABLE records_private.journal ALTER COLUMN actor SET NOT NULL;
CREATE FUNCTION records_private.journal_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'The Records journal is append-only' USING ERRCODE='insufficient_privilege'; END $$;
CREATE TRIGGER journal_append_only BEFORE UPDATE OR DELETE ON records_private.journal FOR EACH ROW EXECUTE FUNCTION records_private.journal_append_only();
CREATE TRIGGER journal_no_truncate BEFORE TRUNCATE ON records_private.journal FOR EACH STATEMENT EXECUTE FUNCTION records_private.journal_append_only();

-- Server-set attribution for every stamped storage table: created_by, updated_by, and owner when
-- the table has one. Ownership changes only inside a transfer command that names the new owner.
CREATE FUNCTION records.note_permission_change() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 UPDATE records_private.datastores SET permission_epoch=permission_epoch+1 WHERE id=records.current_datastore()
$$;
CREATE FUNCTION records.stamp_row() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE who text:=coalesce(records.actor(),'records:operator:'||session_user); changes jsonb; next jsonb:=to_jsonb(NEW); previous jsonb;
BEGIN
 IF TG_OP='INSERT' THEN
  changes:=jsonb_build_object('created_by',who,'updated_by',who);
  IF next ? 'owner' THEN changes:=changes||jsonb_build_object('owner',who); END IF;
 ELSE
  previous:=to_jsonb(OLD);
  changes:=jsonb_build_object('created_by',previous->'created_by','updated_by',who);
  IF next ? 'owner' AND next->'owner' IS DISTINCT FROM previous->'owner' THEN
   IF current_setting('records.ownership_transfer',true) IS DISTINCT FROM next->>'owner' THEN
    RAISE SQLSTATE 'PT403' USING MESSAGE='Ownership changes only through a transfer command';
   END IF;
   PERFORM records.note_permission_change();
  END IF;
 END IF;
 RETURN jsonb_populate_record(NEW,changes);
END $$;

ALTER TABLE records_work.items ADD COLUMN created_by text, ADD COLUMN updated_by text;
ALTER TABLE records_messaging.messages ADD COLUMN created_by text, ADD COLUMN updated_by text;
ALTER TABLE records_private.records ADD COLUMN created_by text, ADD COLUMN updated_by text;
UPDATE records_work.items i SET
 created_by=coalesce((SELECT j.actor FROM records_private.journal j WHERE j.datastore_id=i.datastore_id AND j.record_id=i.id ORDER BY j.seq LIMIT 1),'records:unknown'),
 updated_by=coalesce((SELECT j.actor FROM records_private.journal j WHERE j.datastore_id=i.datastore_id AND j.record_id=i.id ORDER BY j.seq DESC LIMIT 1),'records:unknown');
UPDATE records_messaging.messages i SET
 created_by=coalesce((SELECT j.actor FROM records_private.journal j WHERE j.datastore_id=i.datastore_id AND j.record_id=i.id ORDER BY j.seq LIMIT 1),'records:unknown'),
 updated_by=coalesce((SELECT j.actor FROM records_private.journal j WHERE j.datastore_id=i.datastore_id AND j.record_id=i.id ORDER BY j.seq DESC LIMIT 1),'records:unknown');
UPDATE records_private.records i SET
 created_by=coalesce((SELECT j.actor FROM records_private.journal j WHERE j.datastore_id=i.datastore_id AND j.record_id=i.id ORDER BY j.seq LIMIT 1),'records:unknown'),
 updated_by=coalesce((SELECT j.actor FROM records_private.journal j WHERE j.datastore_id=i.datastore_id AND j.record_id=i.id ORDER BY j.seq DESC LIMIT 1),'records:unknown');
ALTER TABLE records_work.items ALTER COLUMN created_by SET NOT NULL, ALTER COLUMN updated_by SET NOT NULL;
ALTER TABLE records_messaging.messages ALTER COLUMN created_by SET NOT NULL, ALTER COLUMN updated_by SET NOT NULL;
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON records_work.items FOR EACH ROW EXECUTE FUNCTION records.stamp_row();
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON records_messaging.messages FOR EACH ROW EXECUTE FUNCTION records.stamp_row();

-- Handlers report the stamped attribution (and owner, where a module has one).
CREATE OR REPLACE FUNCTION records_work.apply(target uuid,operation text,input jsonb,expected bigint,revision bigint) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE item records_work.items; identifier uuid;
BEGIN
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(input) k WHERE k NOT IN ('id','title','status','description','extensions')) OR (input ? 'title' AND jsonb_typeof(input->'title')<>'string') OR (input ? 'status' AND jsonb_typeof(input->'status')<>'string') OR (input ? 'description' AND jsonb_typeof(input->'description')<>'string') OR (input ? 'extensions' AND jsonb_typeof(input->'extensions')<>'object') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid work fields'; END IF;
 identifier:=coalesce((input->>'id')::uuid,gen_random_uuid());
 IF operation='work.create' THEN
  IF expected IS NOT NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Create cannot have revision'; END IF;
  INSERT INTO records_work.items(datastore_id,id,title,status,description,extensions,revision) VALUES(target,identifier,input->>'title',coalesce(input->>'status','open'),coalesce(input->>'description',''),coalesce(input->'extensions','{}'),revision) RETURNING * INTO item;
 ELSE
  IF expected IS NULL THEN RAISE SQLSTATE 'PT428' USING MESSAGE='Revision required'; END IF;
  SELECT * INTO item FROM records_work.items i WHERE i.datastore_id=target AND i.id=identifier FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Record unavailable'; END IF;
  IF item.revision<>expected THEN RAISE SQLSTATE 'PT412' USING MESSAGE='Stale revision'; END IF;
  UPDATE records_work.items i SET title=coalesce(input->>'title',i.title),status=coalesce(input->>'status',i.status),description=coalesce(input->>'description',i.description),extensions=coalesce(input->'extensions',i.extensions),revision=apply.revision WHERE i.datastore_id=target AND i.id=identifier RETURNING * INTO item;
 END IF;
 RETURN jsonb_build_object('id',item.id,'entity','work_item','created_by',item.created_by,'updated_by',item.updated_by,'data',jsonb_build_object('title',item.title,'status',item.status,'description',item.description,'extensions',item.extensions));
EXCEPTION WHEN check_violation OR not_null_violation OR invalid_text_representation THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid work fields'; WHEN unique_violation THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Record already exists';
END $$;
CREATE OR REPLACE FUNCTION records_messaging.apply(target uuid,operation text,input jsonb,expected bigint,revision bigint) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE message records_messaging.messages; identifier uuid;
BEGIN
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(input) k WHERE k NOT IN ('id','channel','body','extensions')) OR (input ? 'channel' AND jsonb_typeof(input->'channel')<>'string') OR (input ? 'body' AND jsonb_typeof(input->'body')<>'string') OR (input ? 'extensions' AND jsonb_typeof(input->'extensions')<>'object') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid messaging fields'; END IF;
 identifier:=coalesce((input->>'id')::uuid,gen_random_uuid());
 IF operation='messaging.send' THEN
  IF expected IS NOT NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Create cannot have revision'; END IF;
  INSERT INTO records_messaging.messages(datastore_id,id,channel,body,extensions,revision) VALUES(target,identifier,input->>'channel',input->>'body',coalesce(input->'extensions','{}'),revision) RETURNING * INTO message;
 ELSE
  IF expected IS NULL THEN RAISE SQLSTATE 'PT428' USING MESSAGE='Revision required'; END IF;
  SELECT * INTO message FROM records_messaging.messages m WHERE m.datastore_id=target AND m.id=identifier FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Record unavailable'; END IF;
  IF message.revision<>expected THEN RAISE SQLSTATE 'PT412' USING MESSAGE='Stale revision'; END IF;
  UPDATE records_messaging.messages m SET channel=coalesce(input->>'channel',m.channel),body=coalesce(input->>'body',m.body),extensions=coalesce(input->'extensions',m.extensions),revision=apply.revision WHERE m.datastore_id=target AND m.id=identifier RETURNING * INTO message;
 END IF;
 RETURN jsonb_build_object('id',message.id,'entity','message','created_by',message.created_by,'updated_by',message.updated_by,'data',jsonb_build_object('channel',message.channel,'body',message.body,'extensions',message.extensions));
EXCEPTION WHEN check_violation OR not_null_violation OR invalid_text_representation THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid messaging fields'; WHEN unique_violation THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Record already exists';
END $$;

-- The delegated actor joins the idempotency digest, so a retry cannot re-attribute a change.
-- (The binding's own principal is already part of the idempotency key.) The permission epoch is
-- re-read after the handler because an ownership transfer bumps it.
CREATE OR REPLACE FUNCTION records_api.execute_command(datastore_id uuid,module_id text,api_major int,command text,input jsonb,idempotency_key text,expected_revision bigint DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,records_private AS $$
DECLARE c jsonb; ds records_private.datastores; cmd records_private.commands; old records_private.idempotency; dig bytea; result jsonb; record jsonb; next_seq bigint; function_name text; who text; epoch bigint; attribution jsonb;
BEGIN
 c:=records_private.authorize(datastore_id);
 SELECT * INTO ds FROM records_private.datastores d WHERE d.id=datastore_id FOR UPDATE;
 IF ds.module_id IS DISTINCT FROM module_id OR ds.api_major IS DISTINCT FROM api_major THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Module unavailable'; END IF;
 SELECT * INTO cmd FROM records_private.commands x WHERE x.module_id=execute_command.module_id AND x.api_major=execute_command.api_major AND x.command=execute_command.command;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Command unavailable'; END IF;
 PERFORM records_private.authorize(datastore_id,cmd.required_scope);
 IF idempotency_key IS NULL OR length(idempotency_key) NOT BETWEEN 1 AND 200 OR jsonb_typeof(input) IS DISTINCT FROM 'object' OR octet_length(input::text)>65536 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid command request'; END IF;
 who:=records.actor();
 dig:=public.digest((jsonb_build_object('input',input,'revision',expected_revision)||CASE WHEN c ? 'act' THEN jsonb_build_object('actor',who) ELSE '{}'::jsonb END)::text,'sha256');
 SELECT * INTO old FROM records_private.idempotency i WHERE i.datastore_id=execute_command.datastore_id AND i.principal_id=(c->>'sub')::uuid AND i.binding_id=(c->>'binding_id')::uuid AND i.module_id=execute_command.module_id AND i.api_major=execute_command.api_major AND i.command=execute_command.command AND i.key=idempotency_key;
 IF FOUND THEN IF old.digest<>dig THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Idempotency key reused'; END IF; RETURN old.result; END IF;
 next_seq:=ds.seq+1;
 SELECT format('%I.%I',n.nspname,p.proname) INTO function_name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=cmd.handler::oid;
 EXECUTE format('SELECT %s($1,$2,$3,$4,$5)',function_name) INTO record USING datastore_id,command,input,expected_revision,next_seq;
 attribution:=jsonb_build_object('created_by',coalesce(record->>'created_by',who),'updated_by',who);
 INSERT INTO records_private.records(datastore_id,id,entity,revision,data,created_by,updated_by) VALUES(datastore_id,(record->>'id')::uuid,record->>'entity',next_seq,record->'data',attribution->>'created_by',who)
  ON CONFLICT ON CONSTRAINT records_pkey DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_by=excluded.updated_by;
 UPDATE records_private.datastores d SET seq=next_seq WHERE d.id=datastore_id RETURNING d.permission_epoch INTO epoch;
 INSERT INTO records_private.journal(datastore_id,seq,ordinal,principal_id,binding_id,entity,record_id,revision,data,created_at,actor,owner_at_change)
  VALUES(datastore_id,next_seq,0,(c->>'sub')::uuid,(c->>'binding_id')::uuid,record->>'entity',(record->>'id')::uuid,next_seq,record->'data',now(),who,record->>'owner');
 INSERT INTO records_private.outbox(datastore_id,seq) VALUES(datastore_id,next_seq);
 result:=jsonb_build_object('record',record||attribution||jsonb_build_object('revision',next_seq),'seq',next_seq,'permission_epoch',epoch);
 INSERT INTO records_private.idempotency VALUES(datastore_id,(c->>'sub')::uuid,(c->>'binding_id')::uuid,module_id,api_major,command,idempotency_key,dig,result);
 PERFORM pg_notify('records_changes',jsonb_build_object('datastore_id',datastore_id,'seq',next_seq)::text);
 RETURN result;
END $$;
COMMIT;
