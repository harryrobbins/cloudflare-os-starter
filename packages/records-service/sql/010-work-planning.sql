-- Work planning model: `work` API v1, additive. Items gain planning fields; projects, cycles,
-- workflow states, labels, relations and comments become entities with their own commands.
-- Every handler is SECURITY DEFINER owned by records_commander, so storage RLS applies to writes.
-- Integrity (same-datastore references, no parent cycles, no overlapping cycles, state/status
-- agreement, gapless numbers) is enforced here; execute_command already holds the datastore row
-- lock, so checks and number assignment are serialized per datastore.
BEGIN;

-- Labels are free text: 1-60 characters, no control characters or surrounding spaces.
CREATE FUNCTION records_work.valid_label(value text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT value IS NOT NULL AND length(value) BETWEEN 1 AND 60 AND value=btrim(value) AND value !~ '[[:cntrl:]]'
$$;
CREATE FUNCTION records_work.valid_labels(labels text[]) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT labels IS NULL OR (array_ndims(labels)=1 AND cardinality(labels) BETWEEN 1 AND 20
  AND NOT EXISTS(SELECT 1 FROM unnest(labels) l WHERE NOT records_work.valid_label(l))
  AND (SELECT count(DISTINCT l) FROM unnest(labels) l)=cardinality(labels))
$$;

CREATE TABLE records_work.workflow_states(
 datastore_id uuid REFERENCES records_private.datastores,
 id uuid,
 key text NOT NULL CONSTRAINT workflow_states_key CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
 name text NOT NULL CONSTRAINT workflow_states_name CHECK (length(name) BETWEEN 1 AND 60),
 kind text NOT NULL CONSTRAINT workflow_states_kind CHECK (kind IN ('triage','backlog','unstarted','started','completed','canceled')),
 category text NOT NULL GENERATED ALWAYS AS (CASE WHEN kind IN ('triage','backlog','unstarted') THEN 'open' WHEN kind='started' THEN 'active' ELSE 'done' END) STORED,
 position integer NOT NULL CONSTRAINT workflow_states_position CHECK (position BETWEEN 0 AND 100000),
 color text CONSTRAINT workflow_states_color CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
 wip_limit integer CONSTRAINT workflow_states_wip_limit CHECK (wip_limit BETWEEN 1 AND 100000),
 revision bigint NOT NULL,
 created_by text NOT NULL,
 updated_by text NOT NULL,
 PRIMARY KEY(datastore_id,id),
 CONSTRAINT workflow_states_unique_key UNIQUE(datastore_id,key));
CREATE TABLE records_work.projects(
 datastore_id uuid REFERENCES records_private.datastores,
 id uuid,
 name text NOT NULL CONSTRAINT projects_name CHECK (length(name) BETWEEN 1 AND 200),
 description text NOT NULL DEFAULT '' CONSTRAINT projects_description CHECK (length(description)<=20000),
 state text NOT NULL DEFAULT 'planned' CONSTRAINT projects_state CHECK (state IN ('planned','active','paused','completed','cancelled')),
 lead text CONSTRAINT projects_lead CHECK (lead ~ '^[a-z][a-z0-9-]{0,39}:[!-~]{1,255}$'),
 start_date date,
 target_date date,
 color text CONSTRAINT projects_color CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
 archived boolean NOT NULL DEFAULT false,
 revision bigint NOT NULL,
 created_by text NOT NULL,
 updated_by text NOT NULL,
 PRIMARY KEY(datastore_id,id),
 CONSTRAINT projects_dates CHECK (target_date>=start_date));
CREATE TABLE records_work.cycles(
 datastore_id uuid REFERENCES records_private.datastores,
 id uuid,
 name text CONSTRAINT cycles_name CHECK (length(name) BETWEEN 1 AND 200),
 number bigint NOT NULL,
 starts_on date NOT NULL,
 ends_on date NOT NULL,
 goal text CONSTRAINT cycles_goal CHECK (length(goal) BETWEEN 1 AND 2000),
 revision bigint NOT NULL,
 created_by text NOT NULL,
 updated_by text NOT NULL,
 PRIMARY KEY(datastore_id,id),
 CONSTRAINT cycles_unique_number UNIQUE(datastore_id,number),
 CONSTRAINT cycles_dates CHECK (ends_on>=starts_on));
CREATE TABLE records_work.labels(
 datastore_id uuid REFERENCES records_private.datastores,
 id uuid,
 key text NOT NULL CONSTRAINT labels_key CHECK (records_work.valid_label(key)),
 name text NOT NULL CONSTRAINT labels_name CHECK (length(name) BETWEEN 1 AND 60),
 color text CONSTRAINT labels_color CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
 description text NOT NULL DEFAULT '' CONSTRAINT labels_description CHECK (length(description)<=2000),
 archived boolean NOT NULL DEFAULT false,
 revision bigint NOT NULL,
 created_by text NOT NULL,
 updated_by text NOT NULL,
 PRIMARY KEY(datastore_id,id),
 CONSTRAINT labels_unique_key UNIQUE(datastore_id,key));

ALTER TABLE records_work.items
 ADD COLUMN number bigint,
 ADD COLUMN state text,
 ADD COLUMN priority smallint CONSTRAINT items_priority CHECK (priority BETWEEN 0 AND 4),
 ADD COLUMN assignee text CONSTRAINT items_assignee CHECK (assignee ~ '^[a-z][a-z0-9-]{0,39}:[!-~]{1,255}$'),
 ADD COLUMN labels text[] CONSTRAINT items_labels CHECK (records_work.valid_labels(labels)),
 ADD COLUMN estimate numeric CONSTRAINT items_estimate CHECK (estimate BETWEEN 0 AND 1000),
 ADD COLUMN start_date date,
 ADD COLUMN due_date date,
 ADD COLUMN parent uuid,
 ADD COLUMN project uuid,
 ADD COLUMN cycle uuid,
 ADD COLUMN rank text CONSTRAINT items_rank CHECK (rank ~ '^[!-~]{1,64}$'),
 ADD COLUMN archived boolean NOT NULL DEFAULT false,
 ADD CONSTRAINT items_dates CHECK (due_date>=start_date),
 ADD CONSTRAINT items_parent_self CHECK (parent<>id),
 ADD CONSTRAINT items_state_fk FOREIGN KEY(datastore_id,state) REFERENCES records_work.workflow_states(datastore_id,key),
 ADD CONSTRAINT items_parent_fk FOREIGN KEY(datastore_id,parent) REFERENCES records_work.items(datastore_id,id),
 ADD CONSTRAINT items_project_fk FOREIGN KEY(datastore_id,project) REFERENCES records_work.projects(datastore_id,id),
 ADD CONSTRAINT items_cycle_fk FOREIGN KEY(datastore_id,cycle) REFERENCES records_work.cycles(datastore_id,id);

CREATE TABLE records_work.relations(
 datastore_id uuid REFERENCES records_private.datastores,
 id uuid,
 "from" uuid NOT NULL,
 "to" uuid NOT NULL,
 kind text NOT NULL CONSTRAINT relations_kind CHECK (kind IN ('blocks','relates','duplicates')),
 active boolean NOT NULL DEFAULT true,
 revision bigint NOT NULL,
 created_by text NOT NULL,
 updated_by text NOT NULL,
 PRIMARY KEY(datastore_id,id),
 CONSTRAINT relations_self CHECK ("from"<>"to"),
 CONSTRAINT relations_from_fk FOREIGN KEY(datastore_id,"from") REFERENCES records_work.items(datastore_id,id),
 CONSTRAINT relations_to_fk FOREIGN KEY(datastore_id,"to") REFERENCES records_work.items(datastore_id,id));
-- One active relation per kind and pair; `relates` is symmetric.
CREATE UNIQUE INDEX relations_active_directed ON records_work.relations(datastore_id,kind,"from","to") WHERE active AND kind<>'relates';
CREATE UNIQUE INDEX relations_active_symmetric ON records_work.relations(datastore_id,least("from","to"),greatest("from","to")) WHERE active AND kind='relates';
CREATE TABLE records_work.comments(
 datastore_id uuid REFERENCES records_private.datastores,
 id uuid,
 item uuid NOT NULL,
 body text NOT NULL CONSTRAINT comments_body CHECK (length(body) BETWEEN 1 AND 20000),
 edited boolean NOT NULL DEFAULT false,
 revision bigint NOT NULL,
 created_by text NOT NULL,
 updated_by text NOT NULL,
 PRIMARY KEY(datastore_id,id),
 CONSTRAINT comments_item_fk FOREIGN KEY(datastore_id,item) REFERENCES records_work.items(datastore_id,id));

CREATE INDEX items_state ON records_work.items(datastore_id,state);
CREATE INDEX items_assignee ON records_work.items(datastore_id,assignee);
CREATE INDEX items_project ON records_work.items(datastore_id,project);
CREATE INDEX items_cycle ON records_work.items(datastore_id,cycle);
CREATE INDEX items_parent ON records_work.items(datastore_id,parent);
CREATE INDEX relations_from ON records_work.relations(datastore_id,"from");
CREATE INDEX relations_to ON records_work.relations(datastore_id,"to");
CREATE INDEX comments_item ON records_work.comments(datastore_id,item);

-- Storage: forced RLS with the restrictive tenant policy; no row rules beyond it in this phase.
SELECT records_private.isolate(t) FROM unnest(ARRAY['records_work.workflow_states','records_work.projects','records_work.cycles','records_work.labels','records_work.relations','records_work.comments']::regclass[]) t;
CREATE POLICY members ON records_work.workflow_states TO records_presenter, records_commander USING (true) WITH CHECK (true);
CREATE POLICY members ON records_work.projects TO records_presenter, records_commander USING (true) WITH CHECK (true);
CREATE POLICY members ON records_work.cycles TO records_presenter, records_commander USING (true) WITH CHECK (true);
CREATE POLICY members ON records_work.labels TO records_presenter, records_commander USING (true) WITH CHECK (true);
CREATE POLICY members ON records_work.relations TO records_presenter, records_commander USING (true) WITH CHECK (true);
CREATE POLICY members ON records_work.comments TO records_presenter, records_commander USING (true) WITH CHECK (true);
GRANT SELECT ON records_work.workflow_states, records_work.projects, records_work.cycles, records_work.labels, records_work.relations, records_work.comments TO records_presenter;
GRANT SELECT, INSERT, UPDATE ON records_work.workflow_states, records_work.projects, records_work.cycles, records_work.labels, records_work.relations, records_work.comments TO records_commander;
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON records_work.workflow_states FOR EACH ROW EXECUTE FUNCTION records.stamp_row();
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON records_work.projects FOR EACH ROW EXECUTE FUNCTION records.stamp_row();
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON records_work.cycles FOR EACH ROW EXECUTE FUNCTION records.stamp_row();
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON records_work.labels FOR EACH ROW EXECUTE FUNCTION records.stamp_row();
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON records_work.relations FOR EACH ROW EXECUTE FUNCTION records.stamp_row();
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON records_work.comments FOR EACH ROW EXECUTE FUNCTION records.stamp_row();

-- Handler helpers. They run as the calling handler (records_commander) unless marked otherwise.
-- `spec` maps each accepted key to its allowed JSON types, e.g. {"title":"string","rank":"string|null"}.
CREATE FUNCTION records_work.valid_input(input jsonb,spec jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_typeof(input)='object' AND NOT EXISTS(SELECT 1 FROM jsonb_each(input) e WHERE NOT (spec ? e.key) OR NOT (jsonb_typeof(e.value)=ANY(string_to_array(spec->>e.key,'|'))))
$$;
CREATE FUNCTION records_work.kind_category(kind text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN kind IN ('triage','backlog','unstarted') THEN 'open' WHEN kind='started' THEN 'active' WHEN kind IN ('completed','canceled') THEN 'done' END
$$;
CREATE FUNCTION records_work.default_kind(category text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE category WHEN 'open' THEN 'unstarted' WHEN 'active' THEN 'started' WHEN 'done' THEN 'completed' END
$$;
CREATE FUNCTION records_work.default_states() RETURNS TABLE(state_key text,state_name text,state_kind text,state_position int,state_color text) LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 VALUES ('triage','Triage','triage',0,'#fc7840'),('backlog','Backlog','backlog',1,'#bec2c8'),('todo','Todo','unstarted',2,'#e2e2e2'),
  ('in_progress','In Progress','started',3,'#f2c94c'),('in_review','In Review','started',4,'#0f7488'),('done','Done','completed',5,'#5e6ad2'),
  ('canceled','Canceled','canceled',6,'#95a2b3')
$$;
-- Handlers return exactly what the presentation view shows: metadata at the top, other columns
-- as data, top-level NULLs absent (nested JSON is left untouched).
CREATE FUNCTION records_work.record(entity text,row_data jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',row_data->'id','entity',entity,'created_by',row_data->'created_by','updated_by',row_data->'updated_by',
  'data',coalesce((SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(row_data-ARRAY['datastore_id','id','revision','created_by','updated_by']) e WHERE jsonb_typeof(e.value)<>'null'),'{}'::jsonb))
$$;
CREATE FUNCTION records_work.to_date(value text) RETURNS date LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
BEGIN
 IF value IS NULL THEN RETURN NULL; END IF;
 IF value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Dates must be YYYY-MM-DD'; END IF;
 RETURN value::date;
EXCEPTION WHEN data_exception THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Dates must be real calendar dates (YYYY-MM-DD)';
END $$;
CREATE FUNCTION records_work.label_array(value jsonb) RETURNS text[] LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE result text[];
BEGIN
 IF value IS NULL OR jsonb_typeof(value)='null' THEN RETURN NULL; END IF;
 IF jsonb_typeof(value)<>'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(value) e WHERE jsonb_typeof(e)<>'string') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Labels must be an array of strings'; END IF;
 result:=ARRAY(SELECT e.value FROM jsonb_array_elements_text(value) WITH ORDINALITY e(value,n) ORDER BY e.n);
 IF cardinality(result)=0 THEN RETURN NULL; END IF;
 IF NOT records_work.valid_labels(result) THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Labels: at most 20, each 1-60 characters without surrounding spaces, no duplicates'; END IF;
 RETURN result;
END $$;
-- Record ids are unique across every work entity of a datastore (reads and the journal key by id).
CREATE FUNCTION records_work.id_taken(target uuid,identifier uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM records_work.items x WHERE x.datastore_id=target AND x.id=identifier)
  OR EXISTS(SELECT 1 FROM records_work.projects x WHERE x.datastore_id=target AND x.id=identifier)
  OR EXISTS(SELECT 1 FROM records_work.cycles x WHERE x.datastore_id=target AND x.id=identifier)
  OR EXISTS(SELECT 1 FROM records_work.workflow_states x WHERE x.datastore_id=target AND x.id=identifier)
  OR EXISTS(SELECT 1 FROM records_work.labels x WHERE x.datastore_id=target AND x.id=identifier)
  OR EXISTS(SELECT 1 FROM records_work.relations x WHERE x.datastore_id=target AND x.id=identifier)
  OR EXISTS(SELECT 1 FROM records_work.comments x WHERE x.datastore_id=target AND x.id=identifier)
$$;
-- Maps storage errors to client messages: PT409 for uniqueness, PT400 otherwise.
CREATE FUNCTION records_work.fail(p_code text,p_constraint text,p_column text,p_fallback text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE v_message text:='{
 "items_priority":"Priority must be an integer from 0 to 4","items_assignee":"Assignee must be an actor id like <namespace>:<id>",
 "items_labels":"Labels: at most 20, each 1-60 characters without surrounding spaces, no duplicates","items_estimate":"Estimate must be a number from 0 to 1000",
 "items_dates":"Due date is before start date","items_rank":"Rank must be 1-64 printable ASCII characters","items_parent_self":"An item cannot be its own parent",
 "items_state_fk":"Unknown workflow state","items_parent_fk":"Unknown parent item","items_project_fk":"Unknown project","items_cycle_fk":"Unknown cycle",
 "items_title_check":"Title must be 1-500 characters","items_status_check":"Status must be open, active or done",
 "projects_name":"Project name must be 1-200 characters","projects_description":"Project description is at most 20000 characters",
 "projects_state":"Project state must be planned, active, paused, completed or cancelled","projects_lead":"Lead must be an actor id like <namespace>:<id>",
 "projects_color":"Colours are #rrggbb","projects_dates":"Target date is before start date",
 "cycles_name":"Cycle name must be 1-200 characters","cycles_goal":"Cycle goal must be 1-2000 characters","cycles_dates":"A cycle cannot end before it starts",
 "workflow_states_key":"Workflow state keys are 1-40 lowercase letters, digits or _, starting with a letter","workflow_states_name":"Workflow state name must be 1-60 characters",
 "workflow_states_kind":"Workflow state kind must be triage, backlog, unstarted, started, completed or canceled","workflow_states_position":"Position must be an integer from 0 to 100000",
 "workflow_states_color":"Colours are #rrggbb","workflow_states_wip_limit":"WIP limit must be an integer from 1 to 100000","workflow_states_unique_key":"Workflow state key already exists",
 "labels_key":"Label keys are 1-60 characters without surrounding spaces","labels_name":"Label name must be 1-60 characters","labels_color":"Colours are #rrggbb",
 "labels_description":"Label description is at most 2000 characters","labels_unique_key":"Label key already exists",
 "relations_kind":"Relation kind must be blocks, relates or duplicates","relations_self":"An item cannot relate to itself","relations_from_fk":"Unknown work item","relations_to_fk":"Unknown work item",
 "relations_active_directed":"Relation already exists","relations_active_symmetric":"Relation already exists",
 "comments_body":"Comment body must be 1-20000 characters","comments_item_fk":"Unknown work item"}'::jsonb->>p_constraint;
BEGIN
 IF p_code='23505' THEN RAISE SQLSTATE 'PT409' USING MESSAGE=coalesce(v_message,'Record already exists'); END IF;
 IF p_code='23502' AND p_column IS NOT NULL AND p_column<>'' THEN RAISE SQLSTATE 'PT400' USING MESSAGE=format('%s: %s is required',p_fallback,p_column); END IF;
 RAISE SQLSTATE 'PT400' USING MESSAGE=coalesce(v_message,p_fallback);
END $$;
-- The state an item lands in: the named state; else its current state when still in the requested
-- status; else the requested (or current) status's default state, preferring the category's
-- default kind (open: unstarted, active: started, done: completed), then position.
CREATE FUNCTION records_work.resolve_state(target uuid,wanted_state text,wanted_status text,current_state text,current_status text) RETURNS records_work.workflow_states LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE s records_work.workflow_states;
BEGIN
 IF wanted_status IS NOT NULL AND wanted_status NOT IN ('open','active','done') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Status must be open, active or done'; END IF;
 IF wanted_state IS NOT NULL THEN
  SELECT * INTO s FROM records_work.workflow_states w WHERE w.datastore_id=target AND w.key=wanted_state;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Unknown workflow state'; END IF;
  IF wanted_status IS NOT NULL AND wanted_status<>s.category THEN RAISE SQLSTATE 'PT400' USING MESSAGE='State and status disagree'; END IF;
  RETURN s;
 END IF;
 IF current_state IS NOT NULL THEN
  SELECT * INTO s FROM records_work.workflow_states w WHERE w.datastore_id=target AND w.key=current_state;
  IF FOUND AND (wanted_status IS NULL OR wanted_status=s.category) THEN RETURN s; END IF;
 END IF;
 SELECT * INTO s FROM records_work.workflow_states w WHERE w.datastore_id=target AND w.category=coalesce(wanted_status,current_status,'open')
  ORDER BY w.kind=records_work.default_kind(w.category) DESC, w.position, w.key LIMIT 1;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT400' USING MESSAGE='No workflow state has that status'; END IF;
 RETURN s;
END $$;
-- Default workflow states, created by the first command in a datastore that has none. The rows
-- join that command's commit in the journal (ordinals 1-7 after the command's own record at 0),
-- so snapshots and change feeds agree. Owner-run: only it writes the journal outside the dispatcher.
CREATE FUNCTION records_work.ensure_states(target uuid,commit_seq bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c jsonb:=records_private.claims(); who text:=records.actor(); ds records_private.datastores; s records_work.workflow_states; shaped jsonb;
BEGIN
 IF EXISTS(SELECT 1 FROM records_work.workflow_states w WHERE w.datastore_id=target) THEN RETURN; END IF;
 SELECT * INTO ds FROM records_private.datastores d WHERE d.id=target;
 IF target IS DISTINCT FROM records.current_datastore() OR who IS NULL OR ds.module_id IS DISTINCT FROM 'work' OR commit_seq IS DISTINCT FROM ds.seq+1 THEN
  RAISE SQLSTATE 'PT403' USING MESSAGE='Access denied';
 END IF;
 FOR s IN INSERT INTO records_work.workflow_states(datastore_id,id,key,name,kind,position,color,revision)
  SELECT target,gen_random_uuid(),x.state_key,x.state_name,x.state_kind,x.state_position,x.state_color,commit_seq FROM records_work.default_states() x RETURNING * LOOP
  shaped:=records_work.record('workflow_state',to_jsonb(s));
  INSERT INTO records_private.records(datastore_id,id,entity,revision,data,created_by,updated_by) VALUES(target,s.id,'workflow_state',commit_seq,shaped->'data',s.created_by,s.updated_by);
  INSERT INTO records_private.journal(datastore_id,seq,ordinal,principal_id,binding_id,entity,record_id,revision,data,created_at,actor,owner_at_change)
   VALUES(target,commit_seq,s.position+1,(c->>'sub')::uuid,(c->>'binding_id')::uuid,'workflow_state',s.id,commit_seq,shaped->'data',now(),who,NULL);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION records_work.valid_label(text), records_work.valid_labels(text[]), records_work.valid_input(jsonb,jsonb), records_work.kind_category(text),
 records_work.default_kind(text), records_work.default_states(), records_work.record(text,jsonb), records_work.to_date(text), records_work.label_array(jsonb),
 records_work.id_taken(uuid,uuid), records_work.fail(text,text,text,text), records_work.resolve_state(uuid,text,text,text,text), records_work.ensure_states(uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION records_work.valid_label(text), records_work.valid_labels(text[]), records_work.valid_input(jsonb,jsonb), records_work.kind_category(text),
 records_work.default_kind(text), records_work.default_states(), records_work.record(text,jsonb), records_work.to_date(text), records_work.label_array(jsonb),
 records_work.id_taken(uuid,uuid), records_work.fail(text,text,text,text), records_work.resolve_state(uuid,text,text,text,text), records_work.ensure_states(uuid,bigint) TO records_commander;

-- work.create / work.update: the v1 fields plus planning fields. `number` is server-assigned;
-- `status` follows the item's workflow state category.
CREATE OR REPLACE FUNCTION records_work.apply(target uuid,operation text,input jsonb,expected bigint,revision bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item records_work.items; identifier uuid; st records_work.workflow_states; v_parent uuid; v_code text; v_constraint text; v_column text;
BEGIN
 IF operation NOT IN ('work.create','work.update') OR NOT records_work.valid_input(input,'{"id":"string","title":"string","status":"string","description":"string","extensions":"object",
  "state":"string","priority":"number|null","assignee":"string|null","labels":"array|null","estimate":"number|null","start_date":"string|null","due_date":"string|null",
  "parent":"string|null","project":"string|null","cycle":"string|null","rank":"string|null","archived":"boolean"}') THEN
  RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid work fields';
 END IF;
 PERFORM records_work.ensure_states(target,apply.revision);
 identifier:=coalesce((input->>'id')::uuid,gen_random_uuid());
 IF operation='work.create' THEN
  IF expected IS NOT NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Create cannot have revision'; END IF;
  IF records_work.id_taken(target,identifier) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Record already exists'; END IF;
 ELSE
  IF expected IS NULL THEN RAISE SQLSTATE 'PT428' USING MESSAGE='Revision required'; END IF;
  SELECT * INTO item FROM records_work.items i WHERE i.datastore_id=target AND i.id=identifier FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Record unavailable'; END IF;
  IF item.revision<>expected THEN RAISE SQLSTATE 'PT412' USING MESSAGE='Stale revision'; END IF;
 END IF;
 st:=records_work.resolve_state(target,input->>'state',input->>'status',item.state,item.status);
 IF input ? 'parent' AND input->>'parent' IS NOT NULL THEN
  v_parent:=(input->>'parent')::uuid;
  IF v_parent=identifier THEN RAISE SQLSTATE 'PT400' USING MESSAGE='An item cannot be its own parent'; END IF;
  IF NOT EXISTS(SELECT 1 FROM records_work.items i WHERE i.datastore_id=target AND i.id=v_parent) THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Unknown parent item'; END IF;
  IF operation='work.update' AND EXISTS(WITH RECURSIVE up(id,parent) AS (
    SELECT i.id,i.parent FROM records_work.items i WHERE i.datastore_id=target AND i.id=v_parent
    UNION SELECT i.id,i.parent FROM records_work.items i JOIN up ON i.datastore_id=target AND i.id=up.parent)
   SELECT 1 FROM up WHERE up.id=identifier) THEN
   RAISE SQLSTATE 'PT409' USING MESSAGE='Parent would create a cycle';
  END IF;
 END IF;
 IF input ? 'project' AND input->>'project' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM records_work.projects p WHERE p.datastore_id=target AND p.id=(input->>'project')::uuid) THEN
  RAISE SQLSTATE 'PT400' USING MESSAGE='Unknown project';
 END IF;
 IF input ? 'cycle' AND input->>'cycle' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM records_work.cycles c WHERE c.datastore_id=target AND c.id=(input->>'cycle')::uuid) THEN
  RAISE SQLSTATE 'PT400' USING MESSAGE='Unknown cycle';
 END IF;
 IF operation='work.create' THEN
  INSERT INTO records_work.items(datastore_id,id,title,status,description,extensions,revision,number,state,priority,assignee,labels,estimate,start_date,due_date,parent,project,cycle,rank,archived)
   VALUES(target,identifier,input->>'title',st.category,coalesce(input->>'description',''),coalesce(input->'extensions','{}'),apply.revision,
    (SELECT coalesce(max(i.number),0)+1 FROM records_work.items i WHERE i.datastore_id=target),
    st.key,(input->>'priority')::smallint,input->>'assignee',records_work.label_array(input->'labels'),(input->>'estimate')::numeric,
    records_work.to_date(input->>'start_date'),records_work.to_date(input->>'due_date'),v_parent,(input->>'project')::uuid,(input->>'cycle')::uuid,
    input->>'rank',coalesce((input->>'archived')::boolean,false))
   RETURNING * INTO item;
 ELSE
  UPDATE records_work.items i SET title=coalesce(input->>'title',i.title),status=st.category,state=st.key,
   description=coalesce(input->>'description',i.description),extensions=coalesce(input->'extensions',i.extensions),
   priority=CASE WHEN input ? 'priority' THEN (input->>'priority')::smallint ELSE i.priority END,
   assignee=CASE WHEN input ? 'assignee' THEN input->>'assignee' ELSE i.assignee END,
   labels=CASE WHEN input ? 'labels' THEN records_work.label_array(input->'labels') ELSE i.labels END,
   estimate=CASE WHEN input ? 'estimate' THEN (input->>'estimate')::numeric ELSE i.estimate END,
   start_date=CASE WHEN input ? 'start_date' THEN records_work.to_date(input->>'start_date') ELSE i.start_date END,
   due_date=CASE WHEN input ? 'due_date' THEN records_work.to_date(input->>'due_date') ELSE i.due_date END,
   parent=CASE WHEN input ? 'parent' THEN v_parent ELSE i.parent END,
   project=CASE WHEN input ? 'project' THEN (input->>'project')::uuid ELSE i.project END,
   cycle=CASE WHEN input ? 'cycle' THEN (input->>'cycle')::uuid ELSE i.cycle END,
   rank=CASE WHEN input ? 'rank' THEN input->>'rank' ELSE i.rank END,
   archived=coalesce((input->>'archived')::boolean,i.archived),
   revision=apply.revision
   WHERE i.datastore_id=target AND i.id=identifier RETURNING * INTO item;
 END IF;
 RETURN records_work.record('work_item',to_jsonb(item));
EXCEPTION WHEN integrity_constraint_violation OR data_exception THEN
 GET STACKED DIAGNOSTICS v_code=RETURNED_SQLSTATE,v_constraint=CONSTRAINT_NAME,v_column=COLUMN_NAME;
 PERFORM records_work.fail(v_code,v_constraint,v_column,'Invalid work fields');
END $$;

CREATE FUNCTION records_work.apply_project(target uuid,operation text,input jsonb,expected bigint,revision bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r records_work.projects; identifier uuid; v_code text; v_constraint text; v_column text;
BEGIN
 IF operation NOT IN ('work.project.create','work.project.update') OR NOT records_work.valid_input(input,'{"id":"string","name":"string","description":"string","state":"string",
  "lead":"string|null","start_date":"string|null","target_date":"string|null","color":"string|null","archived":"boolean"}') THEN
  RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid project fields';
 END IF;
 PERFORM records_work.ensure_states(target,apply_project.revision);
 identifier:=coalesce((input->>'id')::uuid,gen_random_uuid());
 IF operation='work.project.create' THEN
  IF expected IS NOT NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Create cannot have revision'; END IF;
  IF records_work.id_taken(target,identifier) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Record already exists'; END IF;
  INSERT INTO records_work.projects(datastore_id,id,name,description,state,lead,start_date,target_date,color,archived,revision)
   VALUES(target,identifier,input->>'name',coalesce(input->>'description',''),coalesce(input->>'state','planned'),input->>'lead',
    records_work.to_date(input->>'start_date'),records_work.to_date(input->>'target_date'),input->>'color',coalesce((input->>'archived')::boolean,false),apply_project.revision)
   RETURNING * INTO r;
 ELSE
  IF expected IS NULL THEN RAISE SQLSTATE 'PT428' USING MESSAGE='Revision required'; END IF;
  SELECT * INTO r FROM records_work.projects p WHERE p.datastore_id=target AND p.id=identifier FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Record unavailable'; END IF;
  IF r.revision<>expected THEN RAISE SQLSTATE 'PT412' USING MESSAGE='Stale revision'; END IF;
  UPDATE records_work.projects p SET name=coalesce(input->>'name',p.name),description=coalesce(input->>'description',p.description),state=coalesce(input->>'state',p.state),
   lead=CASE WHEN input ? 'lead' THEN input->>'lead' ELSE p.lead END,
   start_date=CASE WHEN input ? 'start_date' THEN records_work.to_date(input->>'start_date') ELSE p.start_date END,
   target_date=CASE WHEN input ? 'target_date' THEN records_work.to_date(input->>'target_date') ELSE p.target_date END,
   color=CASE WHEN input ? 'color' THEN input->>'color' ELSE p.color END,
   archived=coalesce((input->>'archived')::boolean,p.archived),revision=apply_project.revision
   WHERE p.datastore_id=target AND p.id=identifier RETURNING * INTO r;
 END IF;
 RETURN records_work.record('project',to_jsonb(r));
EXCEPTION WHEN integrity_constraint_violation OR data_exception THEN
 GET STACKED DIAGNOSTICS v_code=RETURNED_SQLSTATE,v_constraint=CONSTRAINT_NAME,v_column=COLUMN_NAME;
 PERFORM records_work.fail(v_code,v_constraint,v_column,'Invalid project fields');
END $$;

CREATE FUNCTION records_work.apply_cycle(target uuid,operation text,input jsonb,expected bigint,revision bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r records_work.cycles; identifier uuid; v_start date; v_end date; v_code text; v_constraint text; v_column text;
BEGIN
 IF operation NOT IN ('work.cycle.create','work.cycle.update') OR NOT records_work.valid_input(input,'{"id":"string","name":"string|null","starts_on":"string","ends_on":"string","goal":"string|null"}') THEN
  RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid cycle fields';
 END IF;
 PERFORM records_work.ensure_states(target,apply_cycle.revision);
 identifier:=coalesce((input->>'id')::uuid,gen_random_uuid());
 IF operation='work.cycle.create' THEN
  IF expected IS NOT NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Create cannot have revision'; END IF;
  IF records_work.id_taken(target,identifier) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Record already exists'; END IF;
  IF NOT (input ? 'starts_on' AND input ? 'ends_on') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='A cycle needs starts_on and ends_on'; END IF;
 ELSE
  IF expected IS NULL THEN RAISE SQLSTATE 'PT428' USING MESSAGE='Revision required'; END IF;
  SELECT * INTO r FROM records_work.cycles c WHERE c.datastore_id=target AND c.id=identifier FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Record unavailable'; END IF;
  IF r.revision<>expected THEN RAISE SQLSTATE 'PT412' USING MESSAGE='Stale revision'; END IF;
 END IF;
 v_start:=coalesce(records_work.to_date(input->>'starts_on'),r.starts_on);
 v_end:=coalesce(records_work.to_date(input->>'ends_on'),r.ends_on);
 IF v_end<v_start THEN RAISE SQLSTATE 'PT400' USING MESSAGE='A cycle cannot end before it starts'; END IF;
 IF EXISTS(SELECT 1 FROM records_work.cycles c WHERE c.datastore_id=target AND c.id<>identifier AND daterange(c.starts_on,c.ends_on,'[]') && daterange(v_start,v_end,'[]')) THEN
  RAISE SQLSTATE 'PT409' USING MESSAGE='Cycle dates overlap another cycle';
 END IF;
 IF operation='work.cycle.create' THEN
  INSERT INTO records_work.cycles(datastore_id,id,name,number,starts_on,ends_on,goal,revision)
   VALUES(target,identifier,input->>'name',(SELECT coalesce(max(c.number),0)+1 FROM records_work.cycles c WHERE c.datastore_id=target),v_start,v_end,input->>'goal',apply_cycle.revision)
   RETURNING * INTO r;
 ELSE
  UPDATE records_work.cycles c SET name=CASE WHEN input ? 'name' THEN input->>'name' ELSE c.name END,starts_on=v_start,ends_on=v_end,
   goal=CASE WHEN input ? 'goal' THEN input->>'goal' ELSE c.goal END,revision=apply_cycle.revision
   WHERE c.datastore_id=target AND c.id=identifier RETURNING * INTO r;
 END IF;
 RETURN records_work.record('cycle',to_jsonb(r));
EXCEPTION WHEN integrity_constraint_violation OR data_exception THEN
 GET STACKED DIAGNOSTICS v_code=RETURNED_SQLSTATE,v_constraint=CONSTRAINT_NAME,v_column=COLUMN_NAME;
 PERFORM records_work.fail(v_code,v_constraint,v_column,'Invalid cycle fields');
END $$;

-- Workflow states: `key` is fixed at creation (items reference it); `category` derives from `kind`.
CREATE FUNCTION records_work.apply_state(target uuid,operation text,input jsonb,expected bigint,revision bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r records_work.workflow_states; identifier uuid; v_kind text:=input->>'kind'; v_category text:=input->>'category'; v_code text; v_constraint text; v_column text;
BEGIN
 IF operation NOT IN ('work.state.create','work.state.update') OR NOT records_work.valid_input(input,CASE WHEN operation='work.state.create'
  THEN '{"id":"string","key":"string","name":"string","kind":"string","category":"string","position":"number","color":"string|null","wip_limit":"number|null"}'::jsonb
  ELSE '{"id":"string","name":"string","kind":"string","category":"string","position":"number","color":"string|null","wip_limit":"number|null"}'::jsonb END) THEN
  RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid workflow state fields';
 END IF;
 IF v_category IS NOT NULL AND v_category NOT IN ('open','active','done') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Category must be open, active or done'; END IF;
 IF v_kind IS NOT NULL AND records_work.kind_category(v_kind) IS NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Workflow state kind must be triage, backlog, unstarted, started, completed or canceled'; END IF;
 PERFORM records_work.ensure_states(target,apply_state.revision);
 identifier:=coalesce((input->>'id')::uuid,gen_random_uuid());
 IF operation='work.state.create' THEN
  IF expected IS NOT NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Create cannot have revision'; END IF;
  IF records_work.id_taken(target,identifier) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Record already exists'; END IF;
  IF v_kind IS NULL AND v_category IS NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='A workflow state needs a kind'; END IF;
  v_kind:=coalesce(v_kind,records_work.default_kind(v_category));
 ELSE
  IF expected IS NULL THEN RAISE SQLSTATE 'PT428' USING MESSAGE='Revision required'; END IF;
  SELECT * INTO r FROM records_work.workflow_states w WHERE w.datastore_id=target AND w.id=identifier FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Record unavailable'; END IF;
  IF r.revision<>expected THEN RAISE SQLSTATE 'PT412' USING MESSAGE='Stale revision'; END IF;
  v_kind:=coalesce(v_kind,CASE WHEN v_category IS NULL OR v_category=r.category THEN r.kind ELSE records_work.default_kind(v_category) END);
 END IF;
 IF v_category IS NOT NULL AND records_work.kind_category(v_kind)<>v_category THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Kind and category disagree'; END IF;
 IF operation='work.state.create' THEN
  INSERT INTO records_work.workflow_states(datastore_id,id,key,name,kind,position,color,wip_limit,revision)
   VALUES(target,identifier,input->>'key',input->>'name',v_kind,
    coalesce((input->>'position')::integer,(SELECT coalesce(max(w.position)+1,0) FROM records_work.workflow_states w WHERE w.datastore_id=target)),
    input->>'color',(input->>'wip_limit')::integer,apply_state.revision)
   RETURNING * INTO r;
 ELSE
  -- Items keep status equal to their state's category; a state in use cannot change category.
  IF records_work.kind_category(v_kind)<>r.category AND EXISTS(SELECT 1 FROM records_work.items i WHERE i.datastore_id=target AND i.state=r.key) THEN
   RAISE SQLSTATE 'PT409' USING MESSAGE='Workflow state is in use; its category cannot change';
  END IF;
  UPDATE records_work.workflow_states w SET name=coalesce(input->>'name',w.name),kind=v_kind,position=coalesce((input->>'position')::integer,w.position),
   color=CASE WHEN input ? 'color' THEN input->>'color' ELSE w.color END,
   wip_limit=CASE WHEN input ? 'wip_limit' THEN (input->>'wip_limit')::integer ELSE w.wip_limit END,revision=apply_state.revision
   WHERE w.datastore_id=target AND w.id=identifier RETURNING * INTO r;
 END IF;
 RETURN records_work.record('workflow_state',to_jsonb(r));
EXCEPTION WHEN integrity_constraint_violation OR data_exception THEN
 GET STACKED DIAGNOSTICS v_code=RETURNED_SQLSTATE,v_constraint=CONSTRAINT_NAME,v_column=COLUMN_NAME;
 PERFORM records_work.fail(v_code,v_constraint,v_column,'Invalid workflow state fields');
END $$;

-- Labels: `key` is the text items carry in `labels` and is fixed at creation.
CREATE FUNCTION records_work.apply_label(target uuid,operation text,input jsonb,expected bigint,revision bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r records_work.labels; identifier uuid; v_code text; v_constraint text; v_column text;
BEGIN
 IF operation NOT IN ('work.label.create','work.label.update') OR NOT records_work.valid_input(input,CASE WHEN operation='work.label.create'
  THEN '{"id":"string","key":"string","name":"string","color":"string|null","description":"string","archived":"boolean"}'::jsonb
  ELSE '{"id":"string","name":"string","color":"string|null","description":"string","archived":"boolean"}'::jsonb END) THEN
  RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid label fields';
 END IF;
 PERFORM records_work.ensure_states(target,apply_label.revision);
 identifier:=coalesce((input->>'id')::uuid,gen_random_uuid());
 IF operation='work.label.create' THEN
  IF expected IS NOT NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Create cannot have revision'; END IF;
  IF records_work.id_taken(target,identifier) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Record already exists'; END IF;
  INSERT INTO records_work.labels(datastore_id,id,key,name,color,description,archived,revision)
   VALUES(target,identifier,input->>'key',coalesce(input->>'name',input->>'key'),input->>'color',coalesce(input->>'description',''),coalesce((input->>'archived')::boolean,false),apply_label.revision)
   RETURNING * INTO r;
 ELSE
  IF expected IS NULL THEN RAISE SQLSTATE 'PT428' USING MESSAGE='Revision required'; END IF;
  SELECT * INTO r FROM records_work.labels l WHERE l.datastore_id=target AND l.id=identifier FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Record unavailable'; END IF;
  IF r.revision<>expected THEN RAISE SQLSTATE 'PT412' USING MESSAGE='Stale revision'; END IF;
  UPDATE records_work.labels l SET name=coalesce(input->>'name',l.name),color=CASE WHEN input ? 'color' THEN input->>'color' ELSE l.color END,
   description=coalesce(input->>'description',l.description),archived=coalesce((input->>'archived')::boolean,l.archived),revision=apply_label.revision
   WHERE l.datastore_id=target AND l.id=identifier RETURNING * INTO r;
 END IF;
 RETURN records_work.record('label',to_jsonb(r));
EXCEPTION WHEN integrity_constraint_violation OR data_exception THEN
 GET STACKED DIAGNOSTICS v_code=RETURNED_SQLSTATE,v_constraint=CONSTRAINT_NAME,v_column=COLUMN_NAME;
 PERFORM records_work.fail(v_code,v_constraint,v_column,'Invalid label fields');
END $$;

-- Relations: endpoints and kind are fixed; removal is `active: false` (the journal keeps history).
CREATE FUNCTION records_work.apply_relation(target uuid,operation text,input jsonb,expected bigint,revision bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r records_work.relations; identifier uuid; v_from uuid; v_to uuid; v_kind text; v_active boolean; v_code text; v_constraint text; v_column text;
BEGIN
 IF operation NOT IN ('work.relation.create','work.relation.update') OR NOT records_work.valid_input(input,CASE WHEN operation='work.relation.create'
  THEN '{"id":"string","from":"string","to":"string","kind":"string"}'::jsonb ELSE '{"id":"string","active":"boolean"}'::jsonb END) THEN
  RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid relation fields';
 END IF;
 PERFORM records_work.ensure_states(target,apply_relation.revision);
 identifier:=coalesce((input->>'id')::uuid,gen_random_uuid());
 IF operation='work.relation.create' THEN
  IF expected IS NOT NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Create cannot have revision'; END IF;
  IF records_work.id_taken(target,identifier) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Record already exists'; END IF;
  v_from:=(input->>'from')::uuid; v_to:=(input->>'to')::uuid; v_kind:=input->>'kind';
  IF v_from IS NULL OR v_to IS NULL OR v_kind IS NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='A relation needs from, to and kind'; END IF;
  IF v_kind NOT IN ('blocks','relates','duplicates') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Relation kind must be blocks, relates or duplicates'; END IF;
  IF v_from=v_to THEN RAISE SQLSTATE 'PT400' USING MESSAGE='An item cannot relate to itself'; END IF;
  IF (SELECT count(*) FROM records_work.items i WHERE i.datastore_id=target AND i.id IN (v_from,v_to))<>2 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Unknown work item'; END IF;
 ELSE
  IF expected IS NULL THEN RAISE SQLSTATE 'PT428' USING MESSAGE='Revision required'; END IF;
  SELECT * INTO r FROM records_work.relations x WHERE x.datastore_id=target AND x.id=identifier FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Record unavailable'; END IF;
  IF r.revision<>expected THEN RAISE SQLSTATE 'PT412' USING MESSAGE='Stale revision'; END IF;
  v_from:=r."from"; v_to:=r."to"; v_kind:=r.kind;
 END IF;
 v_active:=coalesce((input->>'active')::boolean,r.active,true);
 IF v_active AND EXISTS(SELECT 1 FROM records_work.relations x WHERE x.datastore_id=target AND x.active AND x.kind=v_kind AND x.id<>identifier
   AND ((x."from"=v_from AND x."to"=v_to) OR (v_kind='relates' AND x."from"=v_to AND x."to"=v_from))) THEN
  RAISE SQLSTATE 'PT409' USING MESSAGE='Relation already exists';
 END IF;
 IF operation='work.relation.create' THEN
  INSERT INTO records_work.relations(datastore_id,id,"from","to",kind,active,revision) VALUES(target,identifier,v_from,v_to,v_kind,true,apply_relation.revision) RETURNING * INTO r;
 ELSE
  UPDATE records_work.relations x SET active=v_active,revision=apply_relation.revision
   WHERE x.datastore_id=target AND x.id=identifier RETURNING * INTO r;
 END IF;
 RETURN records_work.record('relation',to_jsonb(r));
EXCEPTION WHEN integrity_constraint_violation OR data_exception THEN
 GET STACKED DIAGNOSTICS v_code=RETURNED_SQLSTATE,v_constraint=CONSTRAINT_NAME,v_column=COLUMN_NAME;
 PERFORM records_work.fail(v_code,v_constraint,v_column,'Invalid relation fields');
END $$;

-- Comments: Markdown body on one item; `edited` is set by the server when the body changes.
CREATE FUNCTION records_work.apply_comment(target uuid,operation text,input jsonb,expected bigint,revision bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r records_work.comments; identifier uuid; v_code text; v_constraint text; v_column text;
BEGIN
 IF operation NOT IN ('work.comment.create','work.comment.update') OR NOT records_work.valid_input(input,CASE WHEN operation='work.comment.create'
  THEN '{"id":"string","item":"string","body":"string"}'::jsonb ELSE '{"id":"string","body":"string"}'::jsonb END) THEN
  RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid comment fields';
 END IF;
 PERFORM records_work.ensure_states(target,apply_comment.revision);
 identifier:=coalesce((input->>'id')::uuid,gen_random_uuid());
 IF operation='work.comment.create' THEN
  IF expected IS NOT NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Create cannot have revision'; END IF;
  IF records_work.id_taken(target,identifier) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Record already exists'; END IF;
  IF input->>'item' IS NULL OR NOT EXISTS(SELECT 1 FROM records_work.items i WHERE i.datastore_id=target AND i.id=(input->>'item')::uuid) THEN
   RAISE SQLSTATE 'PT400' USING MESSAGE='Unknown work item';
  END IF;
  INSERT INTO records_work.comments(datastore_id,id,item,body,edited,revision) VALUES(target,identifier,(input->>'item')::uuid,input->>'body',false,apply_comment.revision) RETURNING * INTO r;
 ELSE
  IF expected IS NULL THEN RAISE SQLSTATE 'PT428' USING MESSAGE='Revision required'; END IF;
  SELECT * INTO r FROM records_work.comments x WHERE x.datastore_id=target AND x.id=identifier FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Record unavailable'; END IF;
  IF r.revision<>expected THEN RAISE SQLSTATE 'PT412' USING MESSAGE='Stale revision'; END IF;
  UPDATE records_work.comments x SET body=coalesce(input->>'body',x.body),edited=x.edited OR coalesce(input->>'body',x.body)<>x.body,revision=apply_comment.revision
   WHERE x.datastore_id=target AND x.id=identifier RETURNING * INTO r;
 END IF;
 RETURN records_work.record('comment',to_jsonb(r));
EXCEPTION WHEN integrity_constraint_violation OR data_exception THEN
 GET STACKED DIAGNOSTICS v_code=RETURNED_SQLSTATE,v_constraint=CONSTRAINT_NAME,v_column=COLUMN_NAME;
 PERFORM records_work.fail(v_code,v_constraint,v_column,'Invalid comment fields');
END $$;

ALTER FUNCTION records_work.apply(uuid,text,jsonb,bigint,bigint) OWNER TO records_commander;
ALTER FUNCTION records_work.apply_project(uuid,text,jsonb,bigint,bigint) OWNER TO records_commander;
ALTER FUNCTION records_work.apply_cycle(uuid,text,jsonb,bigint,bigint) OWNER TO records_commander;
ALTER FUNCTION records_work.apply_state(uuid,text,jsonb,bigint,bigint) OWNER TO records_commander;
ALTER FUNCTION records_work.apply_label(uuid,text,jsonb,bigint,bigint) OWNER TO records_commander;
ALTER FUNCTION records_work.apply_relation(uuid,text,jsonb,bigint,bigint) OWNER TO records_commander;
ALTER FUNCTION records_work.apply_comment(uuid,text,jsonb,bigint,bigint) OWNER TO records_commander;
REVOKE ALL ON FUNCTION records_work.apply_project(uuid,text,jsonb,bigint,bigint), records_work.apply_cycle(uuid,text,jsonb,bigint,bigint),
 records_work.apply_state(uuid,text,jsonb,bigint,bigint), records_work.apply_label(uuid,text,jsonb,bigint,bigint),
 records_work.apply_relation(uuid,text,jsonb,bigint,bigint), records_work.apply_comment(uuid,text,jsonb,bigint,bigint) FROM PUBLIC;

-- Existing datastores (any command so far): default states, `number` in creation order and
-- `state` from `status`. These writes are not journalled, and attribution is left unchanged; the
-- permission epoch bump makes every synced client discard its cache and take a new snapshot.
INSERT INTO records_work.workflow_states(datastore_id,id,key,name,kind,position,color,revision)
 SELECT d.id,gen_random_uuid(),x.state_key,x.state_name,x.state_kind,x.state_position,x.state_color,d.seq FROM records_private.datastores d CROSS JOIN records_work.default_states() x
 WHERE d.module_id='work' AND d.seq>0 AND NOT EXISTS(SELECT 1 FROM records_work.workflow_states w WHERE w.datastore_id=d.id);
ALTER TABLE records_work.items DISABLE TRIGGER stamp;
UPDATE records_work.items i SET number=n.number,state=CASE i.status WHEN 'open' THEN 'todo' WHEN 'active' THEN 'in_progress' ELSE 'done' END
 FROM (SELECT x.datastore_id,x.id,row_number() OVER (PARTITION BY x.datastore_id ORDER BY (SELECT min(j.seq) FROM records_private.journal j WHERE j.datastore_id=x.datastore_id AND j.record_id=x.id),x.revision,x.id) number FROM records_work.items x) n
 WHERE n.datastore_id=i.datastore_id AND n.id=i.id;
ALTER TABLE records_work.items ENABLE TRIGGER stamp;
UPDATE records_private.datastores SET permission_epoch=permission_epoch+1 WHERE module_id='work' AND seq>0;
ALTER TABLE records_work.items ALTER COLUMN number SET NOT NULL, ADD CONSTRAINT items_unique_number UNIQUE(datastore_id,number);

-- Backstop for every writer, including operator SQL: status is the state's category.
CREATE FUNCTION records_work.check_item_state() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE v_category text;
BEGIN
 IF NEW.state IS NOT NULL THEN
  SELECT w.category INTO v_category FROM records_work.workflow_states w WHERE w.datastore_id=NEW.datastore_id AND w.key=NEW.state;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Unknown workflow state'; END IF;
  IF v_category<>NEW.status THEN RAISE SQLSTATE 'PT400' USING MESSAGE='State and status disagree'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER state_matches_status BEFORE INSERT OR UPDATE OF state,status ON records_work.items FOR EACH ROW EXECUTE FUNCTION records_work.check_item_state();

-- Change pages never split a commit (a first command also journals the seeded states): a page
-- ends with the whole of its last commit, so it can exceed limit_count by that commit's rest.
CREATE OR REPLACE FUNCTION records_api.pull_changes(datastore_id uuid,after_seq bigint DEFAULT 0,limit_count int DEFAULT 100,permission_epoch bigint DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE plan jsonb; result jsonb;
BEGIN
 plan:=records.read_plan(datastore_id,NULL,NULL,true);
 IF permission_epoch IS NOT NULL AND permission_epoch<>(plan->>'permission_epoch')::bigint THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Permission epoch changed; reset cache'; END IF;
 IF after_seq IS NULL OR after_seq<0 OR limit_count IS NULL OR limit_count NOT BETWEEN 1 AND 500 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid cursor'; END IF;
 EXECUTE format('SELECT CASE WHEN $2>(st.s->>''seq'')::bigint THEN NULL ELSE jsonb_build_object(''changes'',coalesce((SELECT jsonb_agg(to_jsonb(r)-''datastore_id''-''created_at'' ORDER BY r.seq,r.ordinal) FROM %1$s r WHERE r.datastore_id=$1 AND r.seq>$2 AND r.seq<=b.last),''[]''::jsonb),''cursor'',CASE WHEN b.n=$3 THEN b.last ELSE (st.s->>''seq'')::bigint END,''permission_epoch'',st.s->''permission_epoch'') END
  FROM (SELECT records.datastore_state() s) st CROSS JOIN LATERAL (SELECT count(*)::int n,max(f.seq) last FROM (SELECT h.seq FROM %1$s h WHERE h.datastore_id=$1 AND h.seq>$2 AND h.seq<=(st.s->>''seq'')::bigint ORDER BY h.seq,h.ordinal LIMIT $3) f) b',plan->>'history')
  INTO result USING datastore_id,after_seq,limit_count;
 IF result IS NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid cursor'; END IF;
 RETURN result;
END $$;

-- Presentation (1:1 views; the work_item view gains the new columns) and registration.
SELECT records_private.present_table('work',1,'work_item','records_work.items');
SELECT records_private.present_table('work',1,'project','records_work.projects');
SELECT records_private.present_table('work',1,'cycle','records_work.cycles');
SELECT records_private.present_table('work',1,'workflow_state','records_work.workflow_states');
SELECT records_private.present_table('work',1,'label','records_work.labels');
SELECT records_private.present_table('work',1,'relation','records_work.relations');
SELECT records_private.present_table('work',1,'comment','records_work.comments');
UPDATE records_private.modules SET manifest=manifest||jsonb_build_object(
 'entities',jsonb_build_array('work_item','project','cycle','workflow_state','label','relation','comment'),
 'commands',jsonb_build_array('work.create','work.update','work.project.create','work.project.update','work.cycle.create','work.cycle.update',
  'work.state.create','work.state.update','work.label.create','work.label.update','work.relation.create','work.relation.update','work.comment.create','work.comment.update'))
 WHERE id='work' AND api_major=1;
INSERT INTO records_private.commands VALUES
 ('work',1,'work.project.create','work.write','records_work.apply_project(uuid,text,jsonb,bigint,bigint)'::regprocedure),
 ('work',1,'work.project.update','work.write','records_work.apply_project(uuid,text,jsonb,bigint,bigint)'::regprocedure),
 ('work',1,'work.cycle.create','work.write','records_work.apply_cycle(uuid,text,jsonb,bigint,bigint)'::regprocedure),
 ('work',1,'work.cycle.update','work.write','records_work.apply_cycle(uuid,text,jsonb,bigint,bigint)'::regprocedure),
 ('work',1,'work.state.create','work.write','records_work.apply_state(uuid,text,jsonb,bigint,bigint)'::regprocedure),
 ('work',1,'work.state.update','work.write','records_work.apply_state(uuid,text,jsonb,bigint,bigint)'::regprocedure),
 ('work',1,'work.label.create','work.write','records_work.apply_label(uuid,text,jsonb,bigint,bigint)'::regprocedure),
 ('work',1,'work.label.update','work.write','records_work.apply_label(uuid,text,jsonb,bigint,bigint)'::regprocedure),
 ('work',1,'work.relation.create','work.write','records_work.apply_relation(uuid,text,jsonb,bigint,bigint)'::regprocedure),
 ('work',1,'work.relation.update','work.write','records_work.apply_relation(uuid,text,jsonb,bigint,bigint)'::regprocedure),
 ('work',1,'work.comment.create','work.write','records_work.apply_comment(uuid,text,jsonb,bigint,bigint)'::regprocedure),
 ('work',1,'work.comment.update','work.write','records_work.apply_comment(uuid,text,jsonb,bigint,bigint)'::regprocedure);
DO $$ DECLARE problems text[]; BEGIN
 problems:=records_private.publication_errors('work',1)||records_private.publication_errors('messaging',1);
 IF cardinality(problems)>0 THEN RAISE EXCEPTION 'Publication checks failed: %',array_to_string(problems,'; '); END IF;
END $$;
COMMIT;
