-- Trusted module migration: the publication command wraps this in its transaction.
CREATE SCHEMA records_inventory;
REVOKE ALL ON SCHEMA records_inventory FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA records_inventory REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE TABLE records_inventory.assets (
 datastore_id uuid REFERENCES records_private.datastores,
 id uuid NOT NULL,
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 200),
 serial text NOT NULL CHECK(length(serial) BETWEEN 1 AND 100),
 revision bigint NOT NULL,
 PRIMARY KEY(datastore_id,id), UNIQUE(datastore_id,serial)
);
ALTER TABLE records_inventory.assets ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_assets ON records_inventory.assets
 USING(datastore_id=(records_private.claims()->>'datastore_id')::uuid);
CREATE FUNCTION records_inventory.apply(target uuid,operation text,input jsonb,expected bigint,revision bigint)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE asset records_inventory.assets;
BEGIN
 IF operation<>'inventory.register' OR expected IS NOT NULL THEN
  RAISE SQLSTATE 'PT400' USING MESSAGE='Unsupported inventory operation';
 END IF;
 IF jsonb_typeof(input)<>'object'
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(input) k WHERE k NOT IN ('id','label','serial'))
 OR jsonb_typeof(input->'label') IS DISTINCT FROM 'string'
 OR jsonb_typeof(input->'serial') IS DISTINCT FROM 'string'
 OR (input ? 'id' AND jsonb_typeof(input->'id') IS DISTINCT FROM 'string') THEN
  RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid inventory fields';
 END IF;
 INSERT INTO records_inventory.assets VALUES(target,coalesce((input->>'id')::uuid,gen_random_uuid()),input->>'label',input->>'serial',revision) RETURNING * INTO asset;
 RETURN jsonb_build_object('id',asset.id,'entity','asset','data',jsonb_build_object('label',asset.label,'serial',asset.serial));
EXCEPTION WHEN check_violation OR not_null_violation OR invalid_text_representation THEN
 RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid inventory fields';
 WHEN unique_violation THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Asset already registered';
END $$;
