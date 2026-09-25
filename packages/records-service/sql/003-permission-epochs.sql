BEGIN;
ALTER TABLE records_private.service_credentials ADD COLUMN expires_at timestamptz;
-- An internal token lives at most the gateway TTL after credential revocation; bindings
-- and membership revocation take effect on the next SQL authorization immediately.
CREATE FUNCTION records_private.bump_permission_epoch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_TABLE_NAME='bindings' THEN
  UPDATE records_private.datastores SET permission_epoch=permission_epoch+1 WHERE id=OLD.datastore_id;
 ELSIF TG_TABLE_NAME='memberships' THEN
  UPDATE records_private.datastores SET permission_epoch=permission_epoch+1 WHERE org_id=OLD.org_id;
 ELSIF TG_TABLE_NAME='principals' THEN
  UPDATE records_private.datastores SET permission_epoch=permission_epoch+1 WHERE id IN (SELECT datastore_id FROM records_private.bindings WHERE principal_id=OLD.id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bindings_epoch AFTER UPDATE OR DELETE ON records_private.bindings FOR EACH ROW EXECUTE FUNCTION records_private.bump_permission_epoch();
CREATE TRIGGER memberships_epoch AFTER UPDATE OR DELETE ON records_private.memberships FOR EACH ROW EXECUTE FUNCTION records_private.bump_permission_epoch();
CREATE TRIGGER principals_epoch AFTER UPDATE OR DELETE ON records_private.principals FOR EACH ROW EXECUTE FUNCTION records_private.bump_permission_epoch();
COMMIT;
