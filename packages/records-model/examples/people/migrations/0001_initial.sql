-- A rule-bearing module: people edit their own profile; contact details and history are visible
-- only to the profile's owner and datastore admins. Postgres enforces every rule below.
CREATE SCHEMA records_people;
REVOKE ALL ON SCHEMA records_people FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA records_people REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE TABLE records_people.profiles (
 datastore_id uuid REFERENCES records_private.datastores,
 id uuid NOT NULL,
 owner text NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 job_title text CHECK(length(job_title) BETWEEN 1 AND 200),
 email text CHECK(length(email) BETWEEN 3 AND 320),
 telephone text CHECK(length(telephone) BETWEEN 1 AND 50),
 revision bigint NOT NULL,
 created_by text NOT NULL,
 updated_by text NOT NULL,
 PRIMARY KEY(datastore_id,id)
);
CREATE INDEX profiles_owner ON records_people.profiles(datastore_id,owner);
-- Sets created_by/updated_by/owner from records.actor(); refuses owner changes outside transfer.
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON records_people.profiles FOR EACH ROW EXECUTE FUNCTION records.stamp_row();

-- Write rules: RLS policies checked on every command, because handlers run as records_commander.
SELECT records_private.isolate('records_people.profiles');
CREATE POLICY readable ON records_people.profiles FOR SELECT TO records_presenter, records_commander USING (true);
CREATE POLICY create_own ON records_people.profiles FOR INSERT TO records_commander WITH CHECK (owner=records.actor());
CREATE POLICY edit_own ON records_people.profiles FOR UPDATE TO records_commander
 USING (owner=records.actor() OR records.has_role('admin')) WITH CHECK (true);
GRANT USAGE ON SCHEMA records_people TO records_presenter, records_commander;
GRANT SELECT ON records_people.profiles TO records_presenter;
GRANT SELECT, INSERT, UPDATE ON records_people.profiles TO records_commander;

CREATE FUNCTION records_people.apply(target uuid,operation text,input jsonb,expected bigint,revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE profile records_people.profiles; identifier uuid;
BEGIN
 IF jsonb_typeof(input)<>'object'
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(input) k WHERE k <> ALL(CASE WHEN operation='people.transfer' THEN ARRAY['id','owner'] ELSE ARRAY['id','name','job_title','email','telephone'] END))
 OR EXISTS(SELECT 1 FROM jsonb_each(input) e WHERE jsonb_typeof(e.value)<>'string') THEN
  RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid profile fields';
 END IF;
 identifier:=coalesce((input->>'id')::uuid,gen_random_uuid());
 IF operation='people.create' THEN
  IF expected IS NOT NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Create cannot have revision'; END IF;
  INSERT INTO records_people.profiles(datastore_id,id,owner,name,job_title,email,telephone,revision,created_by,updated_by)
   VALUES(target,identifier,'',input->>'name',input->>'job_title',input->>'email',input->>'telephone',revision,'','') RETURNING * INTO profile;
 ELSE
  IF expected IS NULL THEN RAISE SQLSTATE 'PT428' USING MESSAGE='Revision required'; END IF;
  -- FOR UPDATE applies the UPDATE policy: a readable row that is not lockable is refused.
  SELECT * INTO profile FROM records_people.profiles p WHERE p.datastore_id=target AND p.id=identifier FOR UPDATE;
  IF NOT FOUND THEN
   IF EXISTS(SELECT 1 FROM records_people.profiles p WHERE p.datastore_id=target AND p.id=identifier) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='Only the owner or an admin may change this profile'; END IF;
   RAISE SQLSTATE 'PT404' USING MESSAGE='Record unavailable';
  END IF;
  IF profile.revision<>expected THEN RAISE SQLSTATE 'PT412' USING MESSAGE='Stale revision'; END IF;
  IF operation='people.transfer' THEN
   IF (input->>'owner') !~ '^[a-z][a-z0-9-]{0,39}:[!-~]{1,255}$' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid owner'; END IF;
   PERFORM set_config('records.ownership_transfer',input->>'owner',true);
   UPDATE records_people.profiles p SET owner=input->>'owner',revision=apply.revision WHERE p.datastore_id=target AND p.id=identifier RETURNING * INTO profile;
   PERFORM set_config('records.ownership_transfer','',true);
  ELSIF operation='people.update' THEN
   UPDATE records_people.profiles p SET name=coalesce(input->>'name',p.name),
    job_title=CASE WHEN input ? 'job_title' THEN nullif(input->>'job_title','') ELSE p.job_title END,
    email=CASE WHEN input ? 'email' THEN nullif(input->>'email','') ELSE p.email END,
    telephone=CASE WHEN input ? 'telephone' THEN nullif(input->>'telephone','') ELSE p.telephone END,
    revision=apply.revision WHERE p.datastore_id=target AND p.id=identifier RETURNING * INTO profile;
  ELSE RAISE SQLSTATE 'PT400' USING MESSAGE='Unsupported people operation';
  END IF;
 END IF;
 RETURN jsonb_build_object('id',profile.id,'entity','profile','owner',profile.owner,'created_by',profile.created_by,'updated_by',profile.updated_by,
  'data',jsonb_strip_nulls(jsonb_build_object('name',profile.name,'job_title',profile.job_title,'email',profile.email,'telephone',profile.telephone)));
EXCEPTION WHEN check_violation OR not_null_violation OR invalid_text_representation THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid profile fields';
 WHEN unique_violation THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Record already exists';
END $$;
ALTER FUNCTION records_people.apply(uuid,text,jsonb,bigint,bigint) OWNER TO records_commander;

-- Read rules: restricted fields appear only for the owner or an admin, and are otherwise absent.
SELECT records_private.presentation_schema('people',1);
CREATE VIEW present_people_v1.profile WITH (security_barrier) AS
 SELECT p.datastore_id,p.id,p.revision,p.created_by,p.updated_by,p.owner,p.name,p.job_title,
  CASE WHEN p.owner=records.actor() OR records.has_role('admin') THEN p.email END AS email,
  CASE WHEN p.owner=records.actor() OR records.has_role('admin') THEN p.telephone END AS telephone
 FROM records_people.profiles p;
SELECT records_private.register_presentation('people',1,'profile','present_people_v1.profile');
-- History rule: only the owner at the time of each change, and admins. Those are exactly the
-- readers allowed the restricted fields, so the stored data needs no further mask.
CREATE VIEW present_people_v1.history WITH (security_barrier) AS
 SELECT j.datastore_id,j.seq,j.ordinal,j.entity,j.record_id,j.revision,j.actor,j.created_at,j.data
 FROM records_private.journal j
 WHERE j.owner_at_change=records.actor() OR records.has_role('admin');
SELECT records_private.register_history('people',1,'present_people_v1.history');
