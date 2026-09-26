-- Server-set timestamps: records carry created_at/updated_at (set by records.stamp_row() in the
-- same transaction as the journal row), and change entries keep the journal's created_at.
-- Additive: new top-level record metadata and change fields only.
BEGIN;
CREATE OR REPLACE FUNCTION records.stamp_row() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE who text:=coalesce(records.actor(),'records:operator:'||session_user); changes jsonb; next jsonb:=to_jsonb(NEW); previous jsonb;
BEGIN
 IF TG_OP='INSERT' THEN
  changes:=jsonb_build_object('created_by',who,'updated_by',who);
  IF next ? 'owner' THEN changes:=changes||jsonb_build_object('owner',who); END IF;
  IF next ? 'created_at' THEN changes:=changes||jsonb_build_object('created_at',now(),'updated_at',now()); END IF;
 ELSE
  previous:=to_jsonb(OLD);
  changes:=jsonb_build_object('created_by',previous->'created_by','updated_by',who);
  IF next ? 'created_at' THEN changes:=changes||jsonb_build_object('created_at',previous->'created_at','updated_at',now()); END IF;
  IF next ? 'owner' AND next->'owner' IS DISTINCT FROM previous->'owner' THEN
   IF current_setting('records.ownership_transfer',true) IS DISTINCT FROM next->>'owner' THEN
    RAISE SQLSTATE 'PT403' USING MESSAGE='Ownership changes only through a transfer command';
   END IF;
   PERFORM records.note_permission_change();
  END IF;
 END IF;
 RETURN jsonb_populate_record(NEW,changes);
END $$;

ALTER TABLE records_work.items ADD COLUMN created_at timestamptz, ADD COLUMN updated_at timestamptz;
ALTER TABLE records_work.items DISABLE TRIGGER USER; -- backfill must not re-stamp attribution
UPDATE records_work.items x SET created_at=coalesce((SELECT min(j.created_at) FROM records_private.journal j WHERE j.datastore_id=x.datastore_id AND j.record_id=x.id),now()),
 updated_at=coalesce((SELECT max(j.created_at) FROM records_private.journal j WHERE j.datastore_id=x.datastore_id AND j.record_id=x.id),now());
ALTER TABLE records_work.items ENABLE TRIGGER USER;
ALTER TABLE records_work.items ALTER COLUMN created_at SET NOT NULL, ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE records_work.projects ADD COLUMN created_at timestamptz, ADD COLUMN updated_at timestamptz;
ALTER TABLE records_work.projects DISABLE TRIGGER USER; -- backfill must not re-stamp attribution
UPDATE records_work.projects x SET created_at=coalesce((SELECT min(j.created_at) FROM records_private.journal j WHERE j.datastore_id=x.datastore_id AND j.record_id=x.id),now()),
 updated_at=coalesce((SELECT max(j.created_at) FROM records_private.journal j WHERE j.datastore_id=x.datastore_id AND j.record_id=x.id),now());
ALTER TABLE records_work.projects ENABLE TRIGGER USER;
ALTER TABLE records_work.projects ALTER COLUMN created_at SET NOT NULL, ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE records_work.cycles ADD COLUMN created_at timestamptz, ADD COLUMN updated_at timestamptz;
ALTER TABLE records_work.cycles DISABLE TRIGGER USER; -- backfill must not re-stamp attribution
UPDATE records_work.cycles x SET created_at=coalesce((SELECT min(j.created_at) FROM records_private.journal j WHERE j.datastore_id=x.datastore_id AND j.record_id=x.id),now()),
 updated_at=coalesce((SELECT max(j.created_at) FROM records_private.journal j WHERE j.datastore_id=x.datastore_id AND j.record_id=x.id),now());
ALTER TABLE records_work.cycles ENABLE TRIGGER USER;
ALTER TABLE records_work.cycles ALTER COLUMN created_at SET NOT NULL, ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE records_work.workflow_states ADD COLUMN created_at timestamptz, ADD COLUMN updated_at timestamptz;
ALTER TABLE records_work.workflow_states DISABLE TRIGGER USER; -- backfill must not re-stamp attribution
UPDATE records_work.workflow_states x SET created_at=coalesce((SELECT min(j.created_at) FROM records_private.journal j WHERE j.datastore_id=x.datastore_id AND j.record_id=x.id),now()),
 updated_at=coalesce((SELECT max(j.created_at) FROM records_private.journal j WHERE j.datastore_id=x.datastore_id AND j.record_id=x.id),now());
ALTER TABLE records_work.workflow_states ENABLE TRIGGER USER;
ALTER TABLE records_work.workflow_states ALTER COLUMN created_at SET NOT NULL, ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE records_work.labels ADD COLUMN created_at timestamptz, ADD COLUMN updated_at timestamptz;
ALTER TABLE records_work.labels DISABLE TRIGGER USER; -- backfill must not re-stamp attribution
UPDATE records_work.labels x SET created_at=coalesce((SELECT min(j.created_at) FROM records_private.journal j WHERE j.datastore_id=x.datastore_id AND j.record_id=x.id),now()),
 updated_at=coalesce((SELECT max(j.created_at) FROM records_private.journal j WHERE j.datastore_id=x.datastore_id AND j.record_id=x.id),now());
ALTER TABLE records_work.labels ENABLE TRIGGER USER;
ALTER TABLE records_work.labels ALTER COLUMN created_at SET NOT NULL, ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE records_work.relations ADD COLUMN created_at timestamptz, ADD COLUMN updated_at timestamptz;
ALTER TABLE records_work.relations DISABLE TRIGGER USER; -- backfill must not re-stamp attribution
UPDATE records_work.relations x SET created_at=coalesce((SELECT min(j.created_at) FROM records_private.journal j WHERE j.datastore_id=x.datastore_id AND j.record_id=x.id),now()),
 updated_at=coalesce((SELECT max(j.created_at) FROM records_private.journal j WHERE j.datastore_id=x.datastore_id AND j.record_id=x.id),now());
ALTER TABLE records_work.relations ENABLE TRIGGER USER;
ALTER TABLE records_work.relations ALTER COLUMN created_at SET NOT NULL, ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE records_work.comments ADD COLUMN created_at timestamptz, ADD COLUMN updated_at timestamptz;
ALTER TABLE records_work.comments DISABLE TRIGGER USER; -- backfill must not re-stamp attribution
UPDATE records_work.comments x SET created_at=coalesce((SELECT min(j.created_at) FROM records_private.journal j WHERE j.datastore_id=x.datastore_id AND j.record_id=x.id),now()),
 updated_at=coalesce((SELECT max(j.created_at) FROM records_private.journal j WHERE j.datastore_id=x.datastore_id AND j.record_id=x.id),now());
ALTER TABLE records_work.comments ENABLE TRIGGER USER;
ALTER TABLE records_work.comments ALTER COLUMN created_at SET NOT NULL, ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE records_messaging.messages ADD COLUMN created_at timestamptz, ADD COLUMN updated_at timestamptz;
ALTER TABLE records_messaging.messages DISABLE TRIGGER USER; -- backfill must not re-stamp attribution
UPDATE records_messaging.messages x SET created_at=coalesce((SELECT min(j.created_at) FROM records_private.journal j WHERE j.datastore_id=x.datastore_id AND j.record_id=x.id),now()),
 updated_at=coalesce((SELECT max(j.created_at) FROM records_private.journal j WHERE j.datastore_id=x.datastore_id AND j.record_id=x.id),now());
ALTER TABLE records_messaging.messages ENABLE TRIGGER USER;
ALTER TABLE records_messaging.messages ALTER COLUMN created_at SET NOT NULL, ALTER COLUMN updated_at SET NOT NULL;

SELECT records_private.present_table('work',1,'work_item','records_work.items');
SELECT records_private.present_table('work',1,'project','records_work.projects');
SELECT records_private.present_table('work',1,'cycle','records_work.cycles');
SELECT records_private.present_table('work',1,'workflow_state','records_work.workflow_states');
SELECT records_private.present_table('work',1,'label','records_work.labels');
SELECT records_private.present_table('work',1,'relation','records_work.relations');
SELECT records_private.present_table('work',1,'comment','records_work.comments');
SELECT records_private.present_table('messaging',1,'message','records_messaging.messages');

-- Timestamps are record metadata, not data fields, in handler results and journal data too.
CREATE OR REPLACE FUNCTION records_work.record(entity text,row_data jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',row_data->'id','entity',entity,'created_by',row_data->'created_by','updated_by',row_data->'updated_by',
  'data',coalesce((SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(row_data-ARRAY['datastore_id','id','revision','created_by','updated_by','created_at','updated_at']) e WHERE jsonb_typeof(e.value)<>'null'),'{}'::jsonb))
$$;
CREATE OR REPLACE FUNCTION records.record_expression(entity text,view regclass) RETURNS text LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE meta text[]:='{}'; scalars text[]:='{}'; nested text:=''; col record;
BEGIN
 FOR col IN SELECT attname,atttypid FROM pg_attribute WHERE attrelid=view AND attnum>0 AND NOT attisdropped ORDER BY attnum LOOP
  IF col.attname='datastore_id' THEN CONTINUE;
  ELSIF col.attname IN ('id','revision','created_by','updated_by','owner','created_at','updated_at') THEN meta:=meta||format('%L,v.%I',col.attname,col.attname);
  -- jsonb_strip_nulls is recursive, so JSON columns are dropped only when NULL themselves.
  ELSIF col.atttypid IN ('jsonb'::regtype,'json'::regtype) THEN nested:=nested||format('||CASE WHEN v.%1$I IS NULL THEN ''{}''::jsonb ELSE jsonb_build_object(%2$L,v.%1$I) END',col.attname,col.attname);
  ELSE scalars:=scalars||format('%L,v.%I',col.attname,col.attname);
  END IF;
 END LOOP;
 RETURN format('(jsonb_strip_nulls(jsonb_build_object(''entity'',%L,%s))||jsonb_build_object(''data'',jsonb_strip_nulls(jsonb_build_object(%s))%s))',entity,array_to_string(meta,','),array_to_string(scalars,','),nested);
END $$;

CREATE OR REPLACE FUNCTION records_api.pull_changes(datastore_id uuid,after_seq bigint DEFAULT 0,limit_count int DEFAULT 100,permission_epoch bigint DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE plan jsonb; result jsonb;
BEGIN
 plan:=records.read_plan(datastore_id,NULL,NULL,true);
 IF permission_epoch IS NOT NULL AND permission_epoch<>(plan->>'permission_epoch')::bigint THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Permission epoch changed; reset cache'; END IF;
 IF after_seq IS NULL OR after_seq<0 OR limit_count IS NULL OR limit_count NOT BETWEEN 1 AND 500 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid cursor'; END IF;
 EXECUTE format('SELECT CASE WHEN $2>(st.s->>''seq'')::bigint THEN NULL ELSE jsonb_build_object(''changes'',coalesce((SELECT jsonb_agg(to_jsonb(r)-''datastore_id'' ORDER BY r.seq,r.ordinal) FROM %1$s r WHERE r.datastore_id=$1 AND r.seq>$2 AND r.seq<=b.last),''[]''::jsonb),''cursor'',CASE WHEN b.n=$3 THEN b.last ELSE (st.s->>''seq'')::bigint END,''permission_epoch'',st.s->''permission_epoch'') END
  FROM (SELECT records.datastore_state() s) st CROSS JOIN LATERAL (SELECT count(*)::int n,max(f.seq) last FROM (SELECT h.seq FROM %1$s h WHERE h.datastore_id=$1 AND h.seq>$2 AND h.seq<=(st.s->>''seq'')::bigint ORDER BY h.seq,h.ordinal LIMIT $3) f) b',plan->>'history')
  INTO result USING datastore_id,after_seq,limit_count;
 IF result IS NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid cursor'; END IF;
 RETURN result;
END $$;

DO $$ DECLARE problems text[]; BEGIN
 problems:=records_private.publication_errors('work',1)||records_private.publication_errors('messaging',1);
 IF cardinality(problems)>0 THEN RAISE EXCEPTION 'Publication checks failed: %',array_to_string(problems,'; '); END IF;
END $$;
COMMIT;
