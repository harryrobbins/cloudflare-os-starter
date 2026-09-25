-- Stage 2: the presentation schema. Storage tables have RLS enabled and FORCED and no client grants.
-- Views in present_<module>_v<major>, owned by records_presenter (NOBYPASSRLS, owns no table), are
-- the only readable surface; command handlers run as records_commander (NOBYPASSRLS, owns no
-- table). Postgres therefore applies storage policies to every read and every command.
BEGIN;
CREATE ROLE records_presenter NOLOGIN NOINHERIT NOBYPASSRLS;
CREATE ROLE records_commander NOLOGIN NOINHERIT NOBYPASSRLS;
GRANT USAGE ON SCHEMA records TO records_presenter, records_commander;
GRANT EXECUTE ON FUNCTION records.current_datastore(), records.actor() TO records_presenter, records_commander;
GRANT EXECUTE ON FUNCTION records.note_permission_change() TO records_commander;

-- Registry of presentation views per module/API major.
CREATE TABLE records_private.presentations(module_id text,api_major int,entity text,view regclass NOT NULL,PRIMARY KEY(module_id,api_major,entity),FOREIGN KEY(module_id,api_major) REFERENCES records_private.modules DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE records_private.presentation_history(module_id text,api_major int,view regclass NOT NULL,PRIMARY KEY(module_id,api_major),FOREIGN KEY(module_id,api_major) REFERENCES records_private.modules DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE IF NOT EXISTS records_private.module_migrations(module_id text,api_major int,id text,checksum text,PRIMARY KEY(module_id,api_major,id));

-- Module-migration helpers. They apply the standard owner/barrier/grant; publication re-checks.
CREATE FUNCTION records_private.presentation_schema(module_id text,api_major int) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE name text:=format('present_%s_v%s',module_id,api_major);
BEGIN
 IF module_id !~ '^[a-z][a-z0-9_]{0,40}$' OR api_major NOT BETWEEN 1 AND 9999 THEN RAISE EXCEPTION 'Invalid presentation schema name'; END IF;
 EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I',name);
 EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC',name);
 EXECUTE format('GRANT USAGE ON SCHEMA %I TO records_runtime',name);
 RETURN name;
END $$;
CREATE FUNCTION records_private.adopt_view(view regclass) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 EXECUTE format('ALTER VIEW %s OWNER TO records_presenter',view);
 EXECUTE format('ALTER VIEW %s SET (security_barrier=true)',view);
 EXECUTE format('REVOKE ALL ON %s FROM PUBLIC',view);
 EXECUTE format('GRANT SELECT ON %s TO records_runtime',view);
END $$;
CREATE FUNCTION records_private.register_presentation(module_id text,api_major int,entity text,view regclass) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 PERFORM records_private.adopt_view(view);
 INSERT INTO records_private.presentations VALUES(module_id,api_major,entity,view) ON CONFLICT ON CONSTRAINT presentations_pkey DO UPDATE SET view=excluded.view;
END $$;
CREATE FUNCTION records_private.register_history(module_id text,api_major int,view regclass) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 PERFORM records_private.adopt_view(view);
 INSERT INTO records_private.presentation_history VALUES(module_id,api_major,view) ON CONFLICT ON CONSTRAINT presentation_history_pkey DO UPDATE SET view=excluded.view;
END $$;
-- A 1:1 view of a storage table. Columns datastore_id, id, revision, created_by and updated_by
-- (and owner, when present) are record metadata; every other column is a data field.
CREATE FUNCTION records_private.present_table(module_id text,api_major int,entity text,source regclass) RETURNS regclass LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE schema_name text:=records_private.presentation_schema(module_id,api_major); columns text; view regclass;
BEGIN
 SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) INTO columns FROM pg_attribute WHERE attrelid=source AND attnum>0 AND NOT attisdropped;
 EXECUTE format('CREATE OR REPLACE VIEW %I.%I WITH (security_barrier) AS SELECT %s FROM %s',schema_name,entity,columns,source);
 view:=format('%I.%I',schema_name,entity)::regclass;
 PERFORM records_private.register_presentation(module_id,api_major,entity,view);
 RETURN view;
END $$;
-- History visible to every reader of the datastore. Rule-bearing modules write their own view.
CREATE FUNCTION records_private.present_history(module_id text,api_major int) RETURNS regclass LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE schema_name text:=records_private.presentation_schema(module_id,api_major); view regclass;
BEGIN
 EXECUTE format('CREATE OR REPLACE VIEW %I.history WITH (security_barrier) AS SELECT j.datastore_id,j.seq,j.ordinal,j.entity,j.record_id,j.revision,j.actor,j.created_at,j.data FROM records_private.journal j',schema_name);
 view:=format('%I.history',schema_name)::regclass;
 PERFORM records_private.register_history(module_id,api_major,view);
 RETURN view;
END $$;

-- Tenant isolation is RESTRICTIVE so module rules (permissive) can only narrow it.
CREATE FUNCTION records_private.isolate(target regclass) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',target);
 EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY',target);
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=target AND attname='datastore_id' AND NOT attisdropped) AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=target AND polname='tenant') THEN
  EXECUTE format('CREATE POLICY tenant ON %s AS RESTRICTIVE FOR ALL USING (datastore_id=records.current_datastore()) WITH CHECK (datastore_id=records.current_datastore())',target);
 END IF;
END $$;
DROP POLICY tenant_records ON records_private.records;
DROP POLICY tenant_journal ON records_private.journal;
DROP POLICY tenant_items ON records_work.items;
DROP POLICY tenant_messages ON records_messaging.messages;
SELECT records_private.isolate(c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind IN ('r','p') AND n.nspname IN ('records_private','records_work','records_messaging');

-- Journal: read only by presentation history views.
GRANT USAGE ON SCHEMA records_private TO records_presenter;
GRANT SELECT ON records_private.journal TO records_presenter;
CREATE POLICY present ON records_private.journal FOR SELECT TO records_presenter USING (true);

-- Bundled modules: no row rules beyond tenant isolation.
GRANT USAGE ON SCHEMA records_work, records_messaging TO records_presenter, records_commander;
GRANT SELECT ON records_work.items, records_messaging.messages TO records_presenter;
GRANT SELECT, INSERT, UPDATE ON records_work.items, records_messaging.messages TO records_commander;
CREATE POLICY members ON records_work.items TO records_presenter, records_commander USING (true) WITH CHECK (true);
CREATE POLICY members ON records_messaging.messages TO records_presenter, records_commander USING (true) WITH CHECK (true);
ALTER FUNCTION records_work.apply(uuid,text,jsonb,bigint,bigint) SECURITY DEFINER;
ALTER FUNCTION records_work.apply(uuid,text,jsonb,bigint,bigint) OWNER TO records_commander;
ALTER FUNCTION records_messaging.apply(uuid,text,jsonb,bigint,bigint) SECURITY DEFINER;
ALTER FUNCTION records_messaging.apply(uuid,text,jsonb,bigint,bigint) OWNER TO records_commander;
SELECT records_private.present_table('work',1,'work_item','records_work.items');
SELECT records_private.present_history('work',1);
SELECT records_private.present_table('messaging',1,'message','records_messaging.messages');
SELECT records_private.present_history('messaging',1);

-- Read path. Definer helpers authorize and name the views; the invoker functions below read those
-- views as records_runtime, which holds no storage grant at all.
CREATE FUNCTION records.read_plan(target uuid,module_id text,api_major int,whole_datastore boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,records_private AS $$
DECLARE ds records_private.datastores; views jsonb; history text;
BEGIN
 PERFORM records_private.authorize(target);
 SELECT * INTO ds FROM records_private.datastores d WHERE d.id=target;
 IF whole_datastore THEN module_id:=ds.module_id; api_major:=ds.api_major; END IF;
 PERFORM records_private.authorize(target,module_id||'.read');
 IF ds.module_id IS DISTINCT FROM module_id OR ds.api_major IS DISTINCT FROM api_major THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Module unavailable'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('entity',p.entity,'view',p.view::text) ORDER BY p.entity),'[]') INTO views FROM records_private.presentations p WHERE p.module_id=ds.module_id AND p.api_major=ds.api_major;
 SELECT h.view::text INTO history FROM records_private.presentation_history h WHERE h.module_id=ds.module_id AND h.api_major=ds.api_major;
 IF jsonb_array_length(views)=0 OR history IS NULL THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Module unavailable'; END IF;
 RETURN jsonb_build_object('views',views,'history',history,'permission_epoch',ds.permission_epoch);
END $$;
-- Counter and epoch of the caller's own datastore; STABLE, so it shares the reading statement's snapshot.
CREATE FUNCTION records.datastore_state() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('seq',d.seq,'permission_epoch',d.permission_epoch) FROM records_private.datastores d WHERE d.id=records.current_datastore()
$$;
-- One presented row as a record: metadata at the top level, other columns as data. Masked
-- (NULL) fields are absent, as the profile allows for restricted fields.
-- Rows are limited before they are shaped: a security_barrier view keeps ORDER BY/LIMIT above
-- it, so shaping inside the same query level would build JSON for every row first.
-- Builds each view's record expression from its columns, so rows are shaped by plain
-- jsonb_build_object (as fast as the old projection) rather than generic per-row reshaping.
CREATE FUNCTION records.record_expression(entity text,view regclass) RETURNS text LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE meta text[]:='{}'; scalars text[]:='{}'; nested text:=''; col record;
BEGIN
 FOR col IN SELECT attname,atttypid FROM pg_attribute WHERE attrelid=view AND attnum>0 AND NOT attisdropped ORDER BY attnum LOOP
  IF col.attname='datastore_id' THEN CONTINUE;
  ELSIF col.attname IN ('id','revision','created_by','updated_by','owner') THEN meta:=meta||format('%L,v.%I',col.attname,col.attname);
  -- jsonb_strip_nulls is recursive, so JSON columns are dropped only when NULL themselves.
  ELSIF col.atttypid IN ('jsonb'::regtype,'json'::regtype) THEN nested:=nested||format('||CASE WHEN v.%1$I IS NULL THEN ''{}''::jsonb ELSE jsonb_build_object(%2$L,v.%1$I) END',col.attname,col.attname);
  ELSE scalars:=scalars||format('%L,v.%I',col.attname,col.attname);
  END IF;
 END LOOP;
 RETURN format('(jsonb_strip_nulls(jsonb_build_object(''entity'',%L,%s))||jsonb_build_object(''data'',jsonb_strip_nulls(jsonb_build_object(%s))%s))',entity,array_to_string(meta,','),array_to_string(scalars,','),nested);
END $$;
CREATE FUNCTION records.entity_union(views jsonb,filters text,per_branch_limit text) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT string_agg(format('(SELECT v.id,%s record FROM (SELECT * FROM %s v WHERE v.datastore_id=$1 %s ORDER BY v.id LIMIT %s) v)',records.record_expression(x->>'entity',(x->>'view')::regclass),x->>'view',filters,per_branch_limit),' UNION ALL ')
 FROM jsonb_array_elements(views) x
$$;
GRANT EXECUTE ON FUNCTION records.read_plan(uuid,text,int,boolean), records.datastore_state(), records.record_expression(text,regclass), records.entity_union(jsonb,text,text) TO records_runtime;

CREATE OR REPLACE FUNCTION records_api.read_records(datastore_id uuid,module_id text,api_major int,entity text DEFAULT NULL,record_id uuid DEFAULT NULL,limit_count int DEFAULT 100,after_id uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE plan jsonb; views jsonb; result jsonb;
BEGIN
 plan:=records.read_plan(datastore_id,module_id,api_major);
 IF limit_count IS NULL OR limit_count NOT BETWEEN 1 AND 500 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid page size'; END IF;
 SELECT coalesce(jsonb_agg(x),'[]') INTO views FROM jsonb_array_elements(plan->'views') x WHERE entity IS NULL OR x->>'entity'=entity;
 IF jsonb_array_length(views)=0 THEN RETURN jsonb_build_object('records','[]'::jsonb)||records.datastore_state(); END IF;
 EXECUTE format('SELECT jsonb_build_object(''records'',coalesce((SELECT jsonb_agg(u.record ORDER BY u.id) FROM (SELECT * FROM (%s) b ORDER BY b.id LIMIT $4) u),''[]''::jsonb))||records.datastore_state()',
  records.entity_union(views,'AND ($2::uuid IS NULL OR v.id=$2) AND ($3::uuid IS NULL OR v.id>$3)','$4'))
  INTO result USING datastore_id,record_id,after_id,limit_count;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION records_api.snapshot_records(datastore_id uuid,module_id text,api_major int,limit_count int DEFAULT 1000) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE plan jsonb; result jsonb; row_count int;
BEGIN
 plan:=records.read_plan(datastore_id,module_id,api_major);
 IF limit_count IS NULL OR limit_count NOT BETWEEN 1 AND 5000 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid snapshot limit'; END IF;
 -- Counter and records are read in ONE statement snapshot. Fail closed instead of
 -- returning a page falsely presented as a complete sync bootstrap.
 EXECUTE format('SELECT jsonb_build_object(''records'',coalesce(jsonb_agg(u.record ORDER BY u.id),''[]''::jsonb),''complete'',true)||records.datastore_state(),count(*)::int FROM (SELECT * FROM (%s) b ORDER BY b.id LIMIT $2) u',
  records.entity_union(plan->'views','','$2'))
  INTO result,row_count USING datastore_id,limit_count+1;
 IF row_count>limit_count THEN RAISE SQLSTATE 'PT413' USING MESSAGE='Datastore exceeds bounded snapshot; export workflow required'; END IF;
 RETURN result;
END $$;

-- Readers filtered by a history rule see sequence gaps. The cursor still advances past rows
-- they may not see: to the last visible row of a full page, else to the datastore counter.
CREATE OR REPLACE FUNCTION records_api.pull_changes(datastore_id uuid,after_seq bigint DEFAULT 0,limit_count int DEFAULT 100,permission_epoch bigint DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE plan jsonb; result jsonb;
BEGIN
 plan:=records.read_plan(datastore_id,NULL,NULL,true);
 IF permission_epoch IS NOT NULL AND permission_epoch<>(plan->>'permission_epoch')::bigint THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Permission epoch changed; reset cache'; END IF;
 IF after_seq IS NULL OR after_seq<0 OR limit_count IS NULL OR limit_count NOT BETWEEN 1 AND 500 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid cursor'; END IF;
 EXECUTE format('SELECT CASE WHEN $2>(s->>''seq'')::bigint THEN NULL ELSE jsonb_build_object(''changes'',coalesce(jsonb_agg(to_jsonb(r)-''datastore_id''-''created_at'' ORDER BY r.seq,r.ordinal) FILTER (WHERE r.seq IS NOT NULL),''[]''::jsonb),''cursor'',CASE WHEN count(r.seq)=$3 THEN max(r.seq) ELSE (s->>''seq'')::bigint END,''permission_epoch'',s->''permission_epoch'') END
  FROM (SELECT records.datastore_state() s) st LEFT JOIN LATERAL (SELECT * FROM %s h WHERE h.datastore_id=$1 AND h.seq>$2 AND h.seq<=(st.s->>''seq'')::bigint ORDER BY h.seq,h.ordinal LIMIT $3) r ON true GROUP BY st.s',plan->>'history')
  INTO result USING datastore_id,after_seq,limit_count;
 IF result IS NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid cursor'; END IF;
 RETURN result;
END $$;

-- Publication checks: refuse any storage, presentation or command layout that would let a client
-- (or an owner-bypass) sidestep Postgres-enforced rules.
CREATE FUNCTION records_private.publication_errors(target_module text,target_major int) RETURNS text[] LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE errors text[]:='{}'; t record; e text; v regclass; expected text:=format('present_%s_v%s',target_module,target_major); m jsonb; client text;
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('records_presenter','records_commander') AND (rolsuper OR rolbypassrls)) THEN errors:=errors||'presenter/commander must not bypass RLS'::text; END IF;
 FOR t IN SELECT c.oid,c.oid::regclass::text name,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) owner,c.relacl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema','public') AND n.nspname NOT LIKE 'pg\_%' AND n.nspname NOT LIKE 'present\_%' LOOP
  IF NOT (t.relrowsecurity AND t.relforcerowsecurity) THEN errors:=errors||format('%s: RLS must be enabled and forced',t.name); END IF;
  IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=t.oid AND attname='datastore_id' AND NOT attisdropped) AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=t.oid AND NOT polpermissive AND polcmd='*' AND pg_get_expr(polqual,polrelid) LIKE '%records.current_datastore()%') THEN
   errors:=errors||format('%s: restrictive tenant policy required',t.name);
  END IF;
  IF t.owner IN ('records_presenter','records_commander') THEN errors:=errors||format('%s: owned by presenter or commander',t.name); END IF;
  FOREACH client IN ARRAY ARRAY['records_runtime','records_gateway','records_authenticator'] LOOP
   IF has_table_privilege(client,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(client,t.oid,'SELECT,INSERT,UPDATE,REFERENCES') THEN errors:=errors||format('%s: client role %s has storage access',t.name,client); END IF;
  END LOOP;
 END LOOP;
 SELECT manifest INTO m FROM records_private.modules WHERE id=target_module AND api_major=target_major;
 IF m IS NULL THEN RETURN errors||'module is not registered'::text; END IF;
 FOR e IN SELECT jsonb_array_elements_text(m->'entities') LOOP
  SELECT p.view INTO v FROM records_private.presentations p WHERE p.module_id=target_module AND p.api_major=target_major AND p.entity=e;
  IF v IS NULL THEN errors:=errors||format('entity %s has no presentation view',e); END IF;
 END LOOP;
 FOR v IN SELECT p.view FROM records_private.presentations p WHERE p.module_id=target_module AND p.api_major=target_major UNION ALL SELECT h.view FROM records_private.presentation_history h WHERE h.module_id=target_module AND h.api_major=target_major LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=v AND c.relkind='v' AND n.nspname=expected AND pg_get_userbyid(c.relowner)='records_presenter' AND 'security_barrier=true'=ANY(coalesce(c.reloptions,'{}'))) THEN
   errors:=errors||format('%s: presentation must be a security_barrier view in %s owned by records_presenter',v,expected);
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM records_private.presentation_history h WHERE h.module_id=target_module AND h.api_major=target_major) THEN errors:=errors||'history view missing'::text; END IF;
 FOR t IN SELECT x.command,p.prosecdef,pg_get_userbyid(p.proowner) owner,p.proconfig FROM records_private.commands x JOIN pg_proc p ON p.oid=x.handler::oid WHERE x.module_id=target_module AND x.api_major=target_major LOOP
  IF NOT t.prosecdef OR t.owner<>'records_commander' OR NOT EXISTS(SELECT 1 FROM unnest(coalesce(t.proconfig,'{}')) s WHERE s LIKE 'search\_path=%') THEN
   errors:=errors||format('command %s: handler must be SECURITY DEFINER, owned by records_commander, with a fixed search_path',t.command);
  END IF;
 END LOOP;
 RETURN errors;
END $$;
DO $$ DECLARE problems text[]; BEGIN
 problems:=records_private.publication_errors('work',1)||records_private.publication_errors('messaging',1);
 IF cardinality(problems)>0 THEN RAISE EXCEPTION 'Publication checks failed: %',array_to_string(problems,'; '); END IF;
END $$;
COMMIT;
