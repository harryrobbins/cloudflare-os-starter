BEGIN;
CREATE OR REPLACE FUNCTION records_api.describe_datastore(datastore_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,records_private AS $$ BEGIN
 PERFORM records_private.authorize(datastore_id);
 RETURN (SELECT jsonb_build_object('id',d.id,'module_id',d.module_id,'api_major',d.api_major,'permission_epoch',d.permission_epoch,'granted_scopes',to_jsonb(b.scopes),'modules',jsonb_build_array(m.manifest)) FROM records_private.datastores d JOIN records_private.modules m ON m.id=d.module_id AND m.api_major=d.api_major JOIN records_private.bindings b ON b.id=(records_private.claims()->>'binding_id')::uuid WHERE d.id=describe_datastore.datastore_id);
END $$;
COMMIT;
