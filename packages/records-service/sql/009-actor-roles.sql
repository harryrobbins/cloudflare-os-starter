-- Stage 3 core: roles are keyed by actor identity per datastore and live here, never in a token,
-- so revoking one takes effect on the next request. Only operator/admin tooling writes them.
BEGIN;
CREATE TABLE records_private.actor_roles(
 datastore_id uuid REFERENCES records_private.datastores,
 actor text CHECK (actor ~ '^[a-z][a-z0-9-]{0,39}:[!-~]{1,255}$'),
 role text CHECK (role ~ '^[a-z][a-z0-9_.-]{0,62}$'),
 granted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(datastore_id,actor,role));
SELECT records_private.isolate('records_private.actor_roles');

CREATE FUNCTION records.has_role(role text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM records_private.actor_roles r WHERE r.datastore_id=records.current_datastore() AND r.actor=records.actor() AND r.role=has_role.role)
$$;
GRANT EXECUTE ON FUNCTION records.has_role(text) TO records_runtime, records_presenter, records_commander;

-- Any role change resets client caches for that datastore.
CREATE FUNCTION records_private.bump_role_epoch() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN UPDATE records_private.datastores SET permission_epoch=permission_epoch+1 WHERE id=OLD.datastore_id; END IF;
 IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND NEW.datastore_id<>OLD.datastore_id) THEN UPDATE records_private.datastores SET permission_epoch=permission_epoch+1 WHERE id=NEW.datastore_id; END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER actor_roles_epoch AFTER INSERT OR UPDATE OR DELETE ON records_private.actor_roles FOR EACH ROW EXECUTE FUNCTION records_private.bump_role_epoch();
-- Attribution grants change who a binding may name, so they reset caches too (via bindings_epoch).
COMMIT;
