BEGIN;
CREATE SCHEMA records_work;
CREATE SCHEMA records_messaging;
REVOKE ALL ON SCHEMA records_work,records_messaging FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA records_work REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA records_messaging REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE TABLE records_work.items(datastore_id uuid REFERENCES records_private.datastores,id uuid,title text NOT NULL CHECK(length(title) BETWEEN 1 AND 500),status text NOT NULL CHECK(status IN ('open','active','done')),description text NOT NULL DEFAULT '',extensions jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(extensions)='object'),revision bigint NOT NULL,PRIMARY KEY(datastore_id,id));
CREATE TABLE records_messaging.messages(datastore_id uuid REFERENCES records_private.datastores,id uuid,channel text NOT NULL CHECK(length(channel) BETWEEN 1 AND 120),body text NOT NULL CHECK(length(body) BETWEEN 1 AND 20000),extensions jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(extensions)='object'),revision bigint NOT NULL,PRIMARY KEY(datastore_id,id));
ALTER TABLE records_work.items ENABLE ROW LEVEL SECURITY;
ALTER TABLE records_messaging.messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_items ON records_work.items USING(datastore_id=(records_private.claims()->>'datastore_id')::uuid);
CREATE POLICY tenant_messages ON records_messaging.messages USING(datastore_id=(records_private.claims()->>'datastore_id')::uuid);
CREATE FUNCTION records_work.apply(target uuid,operation text,input jsonb,expected bigint,revision bigint) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE item records_work.items; identifier uuid;
BEGIN
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(input) k WHERE k NOT IN ('id','title','status','description','extensions')) OR (input ? 'title' AND jsonb_typeof(input->'title')<>'string') OR (input ? 'status' AND jsonb_typeof(input->'status')<>'string') OR (input ? 'description' AND jsonb_typeof(input->'description')<>'string') OR (input ? 'extensions' AND jsonb_typeof(input->'extensions')<>'object') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid work fields'; END IF;
 identifier:=coalesce((input->>'id')::uuid,gen_random_uuid());
 IF operation='work.create' THEN
  IF expected IS NOT NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Create cannot have revision'; END IF;
  INSERT INTO records_work.items VALUES(target,identifier,input->>'title',coalesce(input->>'status','open'),coalesce(input->>'description',''),coalesce(input->'extensions','{}'),revision) RETURNING * INTO item;
 ELSE
  IF expected IS NULL THEN RAISE SQLSTATE 'PT428' USING MESSAGE='Revision required'; END IF;
  SELECT * INTO item FROM records_work.items i WHERE i.datastore_id=target AND i.id=identifier FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Record unavailable'; END IF;
  IF item.revision<>expected THEN RAISE SQLSTATE 'PT412' USING MESSAGE='Stale revision'; END IF;
  UPDATE records_work.items i SET title=coalesce(input->>'title',i.title),status=coalesce(input->>'status',i.status),description=coalesce(input->>'description',i.description),extensions=coalesce(input->'extensions',i.extensions),revision=apply.revision WHERE i.datastore_id=target AND i.id=identifier RETURNING * INTO item;
 END IF;
 RETURN jsonb_build_object('id',item.id,'entity','work_item','data',jsonb_build_object('title',item.title,'status',item.status,'description',item.description,'extensions',item.extensions));
EXCEPTION WHEN check_violation OR not_null_violation OR invalid_text_representation THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid work fields'; WHEN unique_violation THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Record already exists';
END $$;
CREATE FUNCTION records_messaging.apply(target uuid,operation text,input jsonb,expected bigint,revision bigint) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE message records_messaging.messages; identifier uuid;
BEGIN
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(input) k WHERE k NOT IN ('id','channel','body','extensions')) OR (input ? 'channel' AND jsonb_typeof(input->'channel')<>'string') OR (input ? 'body' AND jsonb_typeof(input->'body')<>'string') OR (input ? 'extensions' AND jsonb_typeof(input->'extensions')<>'object') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid messaging fields'; END IF;
 identifier:=coalesce((input->>'id')::uuid,gen_random_uuid());
 IF operation='messaging.send' THEN
  IF expected IS NOT NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Create cannot have revision'; END IF;
  INSERT INTO records_messaging.messages VALUES(target,identifier,input->>'channel',input->>'body',coalesce(input->'extensions','{}'),revision) RETURNING * INTO message;
 ELSE
  IF expected IS NULL THEN RAISE SQLSTATE 'PT428' USING MESSAGE='Revision required'; END IF;
  SELECT * INTO message FROM records_messaging.messages m WHERE m.datastore_id=target AND m.id=identifier FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Record unavailable'; END IF;
  IF message.revision<>expected THEN RAISE SQLSTATE 'PT412' USING MESSAGE='Stale revision'; END IF;
  UPDATE records_messaging.messages m SET channel=coalesce(input->>'channel',m.channel),body=coalesce(input->>'body',m.body),extensions=coalesce(input->'extensions',m.extensions),revision=apply.revision WHERE m.datastore_id=target AND m.id=identifier RETURNING * INTO message;
 END IF;
 RETURN jsonb_build_object('id',message.id,'entity','message','data',jsonb_build_object('channel',message.channel,'body',message.body,'extensions',message.extensions));
EXCEPTION WHEN check_violation OR not_null_violation OR invalid_text_representation THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid messaging fields'; WHEN unique_violation THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Record already exists';
END $$;
INSERT INTO records_private.modules VALUES('work',1,'{"id":"work","api_majors":[1],"scopes":["work.read","work.write"],"entities":["work_item"],"commands":["work.create","work.update"]}'),('messaging',1,'{"id":"messaging","api_majors":[1],"scopes":["messaging.read","messaging.write"],"entities":["message"],"commands":["messaging.send","messaging.edit"]}');
INSERT INTO records_private.commands VALUES('work',1,'work.create','work.write','records_work.apply(uuid,text,jsonb,bigint,bigint)'::regprocedure),('work',1,'work.update','work.write','records_work.apply(uuid,text,jsonb,bigint,bigint)'::regprocedure),('messaging',1,'messaging.send','messaging.write','records_messaging.apply(uuid,text,jsonb,bigint,bigint)'::regprocedure),('messaging',1,'messaging.edit','messaging.write','records_messaging.apply(uuid,text,jsonb,bigint,bigint)'::regprocedure);
COMMIT;
