-- Records registry and security schema.
--
-- Privilege model (plan §7, "Database rules"):
--   * The role running migrations owns every object. It is never a runtime credential.
--   * records_app       runtime service role: DML only, no DDL, no BYPASSRLS, never an owner.
--   * records_publisher outbox publisher/maintenance: reads and settles outbox rows, prunes
--                       expired idempotency rows; nothing else.
-- Both are NOLOGIN group roles. Operators create LOGIN users and GRANT membership, so rotating a
-- password never needs a migration.
--
-- Tenant isolation: every tenant table carries an immutable org_id, and RLS policies compare it
-- with the transaction-local setting records.org_id. Module tables additionally compare
-- datastore_id with records.datastore_id. RLS backs up the service's own predicates; it does not
-- defend against a compromised service that can set these settings.

-- Roles are cluster-wide, so databases sharing a cluster (e.g. dev and test) share them. The
-- exception handlers tolerate a concurrent migration creating the same role.
DO $$
BEGIN
  BEGIN
    CREATE ROLE records_app NOLOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END;
  BEGIN
    CREATE ROLE records_publisher NOLOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END;
END
$$;

CREATE SCHEMA records;
REVOKE ALL ON SCHEMA records FROM PUBLIC;
GRANT USAGE ON SCHEMA records TO records_app, records_publisher;

-- Transaction-local trusted context. NULL (not an error) when unset, so policies deny by default.
CREATE FUNCTION records.current_org() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('records.org_id', true), '')::uuid $$;
CREATE FUNCTION records.current_datastore() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('records.datastore_id', true), '')::uuid $$;
REVOKE ALL ON FUNCTION records.current_org(), records.current_datastore() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION records.current_org(), records.current_datastore() TO records_app, records_publisher;

-- Rejects any UPDATE that changes a tenant key. Attached to every tenant table.
CREATE FUNCTION records.forbid_tenant_key_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION 'org_id is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF to_jsonb(NEW) ? 'datastore_id' AND (to_jsonb(NEW)->>'datastore_id') IS DISTINCT FROM (to_jsonb(OLD)->>'datastore_id') THEN
    RAISE EXCEPTION 'datastore_id is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- Module-global (not tenant-scoped): which modules this database has installed. Classified
-- explicitly so isolation tests do not mistake it for an unprotected tenant table.
CREATE TABLE records.module_installations (
  module_id     text PRIMARY KEY,
  version       text NOT NULL,
  api_versions  int[] NOT NULL,
  features      text[] NOT NULL,
  installed_at  timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE records.module_installations IS 'records:module-global';
GRANT SELECT ON records.module_installations TO records_app;

CREATE TABLE records.organisations (
  id          uuid PRIMARY KEY,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE records.organisations IS 'records:tenant-root';

CREATE TABLE records.principals (
  org_id              uuid NOT NULL REFERENCES records.organisations(id),
  id                  uuid NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('human', 'service')),
  display_name        text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  email               text,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  owner_principal_id  uuid,
  expires_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, owner_principal_id) REFERENCES records.principals(org_id, id),
  CHECK ((kind = 'service') = (owner_principal_id IS NOT NULL))
);

-- Verified external identity → principal. `subject` is the Workshop account e-mail verbatim, as
-- the Workshop keys accounts by it (see docs/research/organisation-datastores-decisions.md).
CREATE TABLE records.identity_mappings (
  issuer        text NOT NULL,
  subject       text NOT NULL,
  org_id        uuid NOT NULL,
  principal_id  uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject),
  FOREIGN KEY (org_id, principal_id) REFERENCES records.principals(org_id, id)
);

CREATE TABLE records.org_roles (
  org_id        uuid NOT NULL,
  principal_id  uuid NOT NULL,
  role          text NOT NULL CHECK (role IN ('data_admin')),
  granted_by    uuid,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, principal_id, role),
  FOREIGN KEY (org_id, principal_id) REFERENCES records.principals(org_id, id)
);

CREATE TABLE records.datastores (
  org_id              uuid NOT NULL,
  id                  uuid NOT NULL PRIMARY KEY,
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description         text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  module_id           text NOT NULL REFERENCES records.module_installations(module_id),
  api_major           int NOT NULL,
  lifecycle           text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'archived')),
  owner_principal_id  uuid NOT NULL,
  owner_team          text,
  retention_policy    text NOT NULL,
  discovery           text NOT NULL DEFAULT 'members' CHECK (discovery IN ('members', 'organisation')),
  environment         text NOT NULL DEFAULT 'default',
  placement           text NOT NULL DEFAULT 'shared',
  revision            int NOT NULL DEFAULT 1,
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id) REFERENCES records.organisations(id),
  FOREIGN KEY (org_id, owner_principal_id) REFERENCES records.principals(org_id, id),
  FOREIGN KEY (org_id, created_by) REFERENCES records.principals(org_id, id)
);
CREATE INDEX datastores_org_name ON records.datastores (org_id, lower(name), id);

CREATE TABLE records.memberships (
  org_id        uuid NOT NULL,
  datastore_id  uuid NOT NULL,
  principal_id  uuid NOT NULL,
  role          text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'reader')),
  granted_by    uuid NOT NULL,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (datastore_id, principal_id),
  FOREIGN KEY (org_id, datastore_id) REFERENCES records.datastores(org_id, id),
  FOREIGN KEY (org_id, principal_id) REFERENCES records.principals(org_id, id)
);
CREATE INDEX memberships_principal ON records.memberships (org_id, principal_id);
-- Exactly one owner membership per datastore, mirroring datastores.owner_principal_id.
CREATE UNIQUE INDEX memberships_one_owner ON records.memberships (datastore_id) WHERE role = 'owner';

CREATE TABLE records.bindings (
  org_id        uuid NOT NULL,
  datastore_id  uuid NOT NULL,
  id            uuid NOT NULL PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('gadget', 'service')),
  label         text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  principal_id  uuid NOT NULL,
  scopes        text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 16),
  -- The Workshop connector account a gadget binding was made through, so removing that
  -- connection revokes its bindings (never the data).
  connection_id text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  revoked_by    uuid,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, datastore_id) REFERENCES records.datastores(org_id, id),
  FOREIGN KEY (org_id, principal_id) REFERENCES records.principals(org_id, id),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX bindings_datastore ON records.bindings (org_id, datastore_id, status);
CREATE INDEX bindings_connection ON records.bindings (connection_id) WHERE status = 'active';

-- Only a SHA-256 digest of each secret is stored.
CREATE TABLE records.credentials (
  org_id        uuid NOT NULL,
  id            uuid NOT NULL PRIMARY KEY,
  binding_id    uuid NOT NULL,
  owner_principal_id uuid NOT NULL,
  digest        bytea NOT NULL CHECK (length(digest) = 32),
  prefix        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  FOREIGN KEY (org_id, binding_id) REFERENCES records.bindings(org_id, id),
  FOREIGN KEY (org_id, owner_principal_id) REFERENCES records.principals(org_id, id)
);

-- Append-only for the application role.
CREATE TABLE records.audit_events (
  org_id                  uuid NOT NULL,
  id                      uuid NOT NULL PRIMARY KEY,
  seq                     bigint GENERATED ALWAYS AS IDENTITY,
  datastore_id            uuid,
  operation               text NOT NULL,
  actor_principal_id      uuid NOT NULL,
  initiator_principal_id  uuid,
  binding_id              uuid,
  via                     text NOT NULL CHECK (via IN ('gadget', 'http', 'management', 'system')),
  target_type             text,
  target_id               uuid,
  summary                 text NOT NULL,
  detail                  jsonb NOT NULL DEFAULT '{}',
  at                      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, actor_principal_id) REFERENCES records.principals(org_id, id)
);
CREATE INDEX audit_datastore ON records.audit_events (org_id, datastore_id, seq DESC);

CREATE TABLE records.idempotency_keys (
  org_id          uuid NOT NULL,
  datastore_id    uuid NOT NULL,
  principal_id    uuid NOT NULL,
  operation       text NOT NULL,
  key             text NOT NULL,
  request_digest  text NOT NULL,
  outcome         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, datastore_id, principal_id, operation, key)
);
CREATE INDEX idempotency_age ON records.idempotency_keys (created_at);

-- Pending change events. Not ordered by allocation: the publisher claims pending rows with a lease,
-- so a transaction that commits late is still published (decisions record §7).
CREATE TABLE records.outbox (
  event_id      uuid PRIMARY KEY,
  org_id        uuid NOT NULL,
  datastore_id  uuid NOT NULL,
  event_type    text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     uuid NOT NULL,
  revision      int NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  state         text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'published', 'dead')),
  attempts      int NOT NULL DEFAULT 0,
  available_at  timestamptz NOT NULL DEFAULT now(),
  lease_owner   uuid,
  lease_until   timestamptz,
  published_at  timestamptz,
  last_error    text
);
CREATE INDEX outbox_pending ON records.outbox (available_at) WHERE state = 'pending';
CREATE INDEX outbox_published ON records.outbox (published_at) WHERE state = 'published';

-- Immutable tenant keys.
CREATE TRIGGER principals_tenant BEFORE UPDATE ON records.principals FOR EACH ROW EXECUTE FUNCTION records.forbid_tenant_key_change();
CREATE TRIGGER datastores_tenant BEFORE UPDATE ON records.datastores FOR EACH ROW EXECUTE FUNCTION records.forbid_tenant_key_change();
CREATE TRIGGER memberships_tenant BEFORE UPDATE ON records.memberships FOR EACH ROW EXECUTE FUNCTION records.forbid_tenant_key_change();
CREATE TRIGGER bindings_tenant BEFORE UPDATE ON records.bindings FOR EACH ROW EXECUTE FUNCTION records.forbid_tenant_key_change();
CREATE TRIGGER credentials_tenant BEFORE UPDATE ON records.credentials FOR EACH ROW EXECUTE FUNCTION records.forbid_tenant_key_change();
CREATE TRIGGER outbox_tenant BEFORE UPDATE ON records.outbox FOR EACH ROW EXECUTE FUNCTION records.forbid_tenant_key_change();

-- Row-level security: default deny, then org-scoped policies for the application role.
ALTER TABLE records.organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE records.principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE records.identity_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE records.org_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE records.datastores ENABLE ROW LEVEL SECURITY;
ALTER TABLE records.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE records.bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE records.credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE records.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE records.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE records.outbox ENABLE ROW LEVEL SECURITY;

CREATE POLICY app_org ON records.organisations TO records_app USING (id = records.current_org());
CREATE POLICY app_org ON records.principals TO records_app
  USING (org_id = records.current_org()) WITH CHECK (org_id = records.current_org());
CREATE POLICY app_org ON records.identity_mappings TO records_app
  USING (org_id = records.current_org()) WITH CHECK (org_id = records.current_org());
CREATE POLICY app_org ON records.org_roles TO records_app
  USING (org_id = records.current_org()) WITH CHECK (org_id = records.current_org());
CREATE POLICY app_org ON records.datastores TO records_app
  USING (org_id = records.current_org()) WITH CHECK (org_id = records.current_org());
CREATE POLICY app_org ON records.memberships TO records_app
  USING (org_id = records.current_org()) WITH CHECK (org_id = records.current_org());
CREATE POLICY app_org ON records.bindings TO records_app
  USING (org_id = records.current_org()) WITH CHECK (org_id = records.current_org());
CREATE POLICY app_org ON records.credentials TO records_app
  USING (org_id = records.current_org()) WITH CHECK (org_id = records.current_org());
CREATE POLICY app_read ON records.audit_events FOR SELECT TO records_app USING (org_id = records.current_org());
CREATE POLICY app_append ON records.audit_events FOR INSERT TO records_app WITH CHECK (org_id = records.current_org());
CREATE POLICY app_org ON records.idempotency_keys TO records_app
  USING (org_id = records.current_org() AND datastore_id = records.current_datastore())
  WITH CHECK (org_id = records.current_org() AND datastore_id = records.current_datastore());
CREATE POLICY app_append ON records.outbox FOR INSERT TO records_app
  WITH CHECK (org_id = records.current_org() AND datastore_id = records.current_datastore());

-- The publisher is cross-tenant by nature, but only for delivery state.
CREATE POLICY publisher_all ON records.outbox TO records_publisher USING (true) WITH CHECK (true);
CREATE POLICY publisher_prune ON records.idempotency_keys FOR DELETE TO records_publisher
  USING (created_at < now() - interval '7 days');
CREATE POLICY publisher_prune_select ON records.idempotency_keys FOR SELECT TO records_publisher
  USING (created_at < now() - interval '7 days');

GRANT SELECT ON records.organisations TO records_app;
GRANT SELECT, INSERT ON records.principals TO records_app;
GRANT UPDATE (display_name, email, status, expires_at) ON records.principals TO records_app;
GRANT SELECT, INSERT ON records.identity_mappings TO records_app;
GRANT SELECT, INSERT, DELETE ON records.org_roles TO records_app;
GRANT SELECT, INSERT ON records.datastores TO records_app;
GRANT UPDATE (name, description, lifecycle, owner_principal_id, owner_team, retention_policy, discovery, revision, updated_at)
  ON records.datastores TO records_app;
GRANT SELECT, INSERT, DELETE ON records.memberships TO records_app;
GRANT UPDATE (role, granted_by, granted_at) ON records.memberships TO records_app;
GRANT SELECT, INSERT ON records.bindings TO records_app;
GRANT UPDATE (status, revoked_at, revoked_by) ON records.bindings TO records_app;
GRANT SELECT, INSERT ON records.credentials TO records_app;
GRANT UPDATE (revoked_at, last_used_at) ON records.credentials TO records_app;
GRANT SELECT, INSERT ON records.audit_events TO records_app;
GRANT SELECT, INSERT ON records.idempotency_keys TO records_app;
GRANT INSERT ON records.outbox TO records_app;
GRANT SELECT, DELETE ON records.idempotency_keys TO records_publisher;
GRANT SELECT, DELETE ON records.outbox TO records_publisher;
GRANT UPDATE (state, attempts, available_at, lease_owner, lease_until, published_at, last_error)
  ON records.outbox TO records_publisher;

-- Pre-tenant lookups. The only SECURITY DEFINER functions: each returns the minimum needed to
-- establish context, with a pinned search_path, and is executable only by the app role.

-- Resolve a verified identity to its principal (Access-verified connect flow, viewer assertions).
CREATE FUNCTION records.resolve_identity(p_issuer text, p_subject text)
  RETURNS TABLE (org_id uuid, principal_id uuid, status text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, records
  AS $$
    SELECT m.org_id, m.principal_id, p.status
      FROM records.identity_mappings m
      JOIN records.principals p ON p.id = m.principal_id AND p.org_id = m.org_id
     WHERE m.issuer = p_issuer AND m.subject = p_subject
  $$;

-- Resolve a credential ID to the material needed to verify it. Digest comparison happens in the
-- service, in constant time.
CREATE FUNCTION records.resolve_credential(p_id uuid)
  RETURNS TABLE (org_id uuid, binding_id uuid, digest bytea, expires_at timestamptz, revoked_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, records
  AS $$
    SELECT c.org_id, c.binding_id, c.digest, c.expires_at, c.revoked_at
      FROM records.credentials c WHERE c.id = p_id
  $$;

REVOKE ALL ON FUNCTION records.resolve_identity(text, text), records.resolve_credential(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION records.resolve_identity(text, text), records.resolve_credential(uuid) TO records_app;
