-- Presentation-schema contract: attribution, forced tenant RLS, a commander-owned handler and
-- 1:1 presentation views. Publication refuses the module without these.
ALTER TABLE records_inventory.assets ADD COLUMN created_by text, ADD COLUMN updated_by text;
UPDATE records_inventory.assets a SET
 created_by=coalesce((SELECT j.actor FROM records_private.journal j WHERE j.datastore_id=a.datastore_id AND j.record_id=a.id ORDER BY j.seq LIMIT 1),'records:unknown'),
 updated_by=coalesce((SELECT j.actor FROM records_private.journal j WHERE j.datastore_id=a.datastore_id AND j.record_id=a.id ORDER BY j.seq DESC LIMIT 1),'records:unknown');
ALTER TABLE records_inventory.assets ALTER COLUMN created_by SET NOT NULL, ALTER COLUMN updated_by SET NOT NULL;
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON records_inventory.assets FOR EACH ROW EXECUTE FUNCTION records.stamp_row();

DROP POLICY tenant_assets ON records_inventory.assets;
SELECT records_private.isolate('records_inventory.assets');
CREATE POLICY members ON records_inventory.assets TO records_presenter, records_commander USING (true) WITH CHECK (true);
GRANT USAGE ON SCHEMA records_inventory TO records_presenter, records_commander;
GRANT SELECT ON records_inventory.assets TO records_presenter;
GRANT SELECT, INSERT ON records_inventory.assets TO records_commander;

CREATE OR REPLACE FUNCTION records_inventory.apply(target uuid,operation text,input jsonb,expected bigint,revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
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
 INSERT INTO records_inventory.assets(datastore_id,id,label,serial,revision) VALUES(target,coalesce((input->>'id')::uuid,gen_random_uuid()),input->>'label',input->>'serial',revision) RETURNING * INTO asset;
 RETURN jsonb_build_object('id',asset.id,'entity','asset','created_by',asset.created_by,'updated_by',asset.updated_by,'data',jsonb_build_object('label',asset.label,'serial',asset.serial));
EXCEPTION WHEN check_violation OR not_null_violation OR invalid_text_representation THEN
 RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid inventory fields';
 WHEN unique_violation THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Asset already registered';
END $$;
ALTER FUNCTION records_inventory.apply(uuid,text,jsonb,bigint,bigint) OWNER TO records_commander;

SELECT records_private.present_table('inventory',1,'asset','records_inventory.assets');
SELECT records_private.present_history('inventory',1);
