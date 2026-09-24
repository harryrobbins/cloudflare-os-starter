-- Row-level security by principal (canonical plan §5, Phase 2, database half).
--
-- Until now RLS scoped module rows to the organisation and datastore the trusted service chose, and
-- the service alone decided membership. This moves membership into the database as a second line:
-- every projects.* row, the journal and the clock also require that the transaction's principal
-- holds the right permission on the datastore. An application bug that skips authorize(), or sets
-- another datastore, still cannot read or write rows the principal has no grant for.
--
-- Trusted context (all transaction-local, set by withContext with bound parameters):
--   records.org_id        organisation (0001)
--   records.datastore_id  datastore (0001)
--   records.principal_id  the principal whose rights apply
--   records.scopes        narrowing scopes: '*' = none (the principal acting directly as themself);
--                         otherwise a comma-separated list such as 'projects.read,issues.read';
--                         '' or unset = nothing. Scopes only ever narrow the role.
--   records.binding_id    optional binding/credential the call is made through. When set, its
--                         stored scopes narrow further and it must be active and belong to the
--                         datastore, so a revoked binding stops working in SQL too.
--
-- effective = role_permissions(membership role) ∩ scopes ∩ binding scopes ∩ the permission asked
--
-- One narrow exception, for provisioning: the principal that created a datastore holds the owner's
-- permissions on it for the rest of the creating transaction only (the datastore row was inserted
-- by this very transaction and its created_at is this transaction's start). That is how
-- createDatastore seeds the workflow and journals an initial project for an owner other than the
-- data administrator creating it, without weakening any policy. It needs unnarrowed scopes and no
-- binding.

-- ---------------------------------------------------------------------------------------------
-- Role → permission matrix, mirroring ROLE_PERMISSIONS in @records/contracts (a test compares).

CREATE TABLE records.role_permissions (
  role        text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'reader')),
  permission  text NOT NULL CHECK (permission ~ '^[a-z]+\.[a-z_]+$'),
  PRIMARY KEY (role, permission)
);
COMMENT ON TABLE records.role_permissions IS 'records:module-global';
INSERT INTO records.role_permissions (role, permission)
SELECT r.role, p.permission
  FROM (VALUES ('reader', 1), ('editor', 2), ('admin', 3), ('owner', 4)) AS r(role, rank)
  JOIN (VALUES
    ('projects.read', 1), ('issues.read', 1),
    ('issues.create', 2), ('issues.edit', 2), ('issues.transition', 2), ('comments.create', 2),
    ('projects.manage', 3), ('members.manage', 3), ('bindings.manage', 3), ('credentials.manage', 3),
    ('audit.read', 3), ('export.run', 3),
    ('lifecycle.manage', 4), ('ownership.transfer', 4), ('datastore.purge', 4)
  ) AS p(permission, rank) ON p.rank <= r.rank;
GRANT SELECT ON records.role_permissions TO records_app;

CREATE FUNCTION records.current_binding() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('records.binding_id', true), '')::uuid $$;
REVOKE ALL ON FUNCTION records.current_binding() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION records.current_binding() TO records_app;

-- Does the transaction's principal hold ANY of `perms` on datastore `ds`? SECURITY DEFINER so the
-- answer does not depend on the caller's own grants or registry RLS; it therefore checks the
-- organisation itself. STABLE: policies wrap it in (SELECT …) so it runs once per statement.
-- PL/pgSQL rather than SQL: a SECURITY DEFINER function is never inlined, and PostgreSQL 17
-- re-plans a non-inlined SQL function's body on every call, whereas PL/pgSQL caches its plans for
-- the session (the Phase 0 clock spike measured the difference).
CREATE FUNCTION records.can_any(ds uuid, perms text[]) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, records AS $$
DECLARE
  v_org uuid := records.current_org();
  v_principal uuid := records.current_principal();
  v_binding uuid := records.current_binding();
  v_scopes text := coalesce(current_setting('records.scopes', true), '');
BEGIN
  IF ds IS NULL OR v_org IS NULL OR v_principal IS NULL OR v_scopes = '' THEN
    RETURN false;
  END IF;
  IF EXISTS (
       SELECT 1
         FROM records.memberships m
         JOIN records.principals p
           ON p.id = m.principal_id AND p.status = 'active' AND (p.expires_at IS NULL OR p.expires_at > now())
         JOIN records.role_permissions rp
           ON rp.role = m.role AND rp.permission = ANY (perms)
        WHERE m.org_id = v_org AND m.datastore_id = ds AND m.principal_id = v_principal
          AND (v_scopes = '*' OR rp.permission = ANY (string_to_array(v_scopes, ',')))
          AND (v_binding IS NULL OR EXISTS (
                SELECT 1 FROM records.bindings b
                 WHERE b.id = v_binding AND b.org_id = v_org AND b.datastore_id = ds
                   AND b.status = 'active' AND rp.permission = ANY (b.scopes)))) THEN
    RETURN true;
  END IF;
  -- Provisioning: the creator, within the creating transaction only (see the header).
  RETURN v_scopes = '*' AND v_binding IS NULL AND EXISTS (
    SELECT 1 FROM records.datastores d
     WHERE d.id = ds AND d.org_id = v_org AND d.created_by = v_principal
       AND d.created_at = now()
       AND d.xmin = pg_current_xact_id_if_assigned()::xid
       AND EXISTS (SELECT 1 FROM records.role_permissions rp WHERE rp.role = 'owner' AND rp.permission = ANY (perms)));
END
$$;

CREATE FUNCTION records.can(ds uuid, perm text) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT records.can_any(ds, ARRAY[perm]) $$;

REVOKE ALL ON FUNCTION records.can_any(uuid, text[]), records.can(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION records.can_any(uuid, text[]), records.can(uuid, text) TO records_app;

-- ---------------------------------------------------------------------------------------------
-- Policies. Each table keeps the tenant rule as a RESTRICTIVE policy (every row must satisfy it)
-- and gains permissive per-command principal policies (at least one must pass).
--
-- Reads are admitted for the permissions whose commands must read those rows: PostgreSQL applies
-- SELECT policies to UPDATE … WHERE, SELECT … FOR UPDATE and RETURNING, so a create-only binding
-- has to see the project it allocates an issue number from. The split between "may list issues"
-- and "may only create them" for pure reads stays with authorize(); RLS guarantees membership,
-- datastore and a relevant permission.
--
--   table                         SELECT                          INSERT            UPDATE
--   workflow_states/transitions,  any record permission           projects.manage   projects.manage
--   custom_fields
--   projects                      any record permission           projects.manage   projects.manage | issues.create
--                                                                                   (issue numbers)
--   issues                        issues.read | issues.create |   issues.create     issues.edit |
--                                 issues.edit | issues.transition                   issues.transition
--                                 | comments.create
--   comments                      issues.read | comments.create   comments.create   (none granted)
--   records.journal               issues.read                     any write permission
--   records.datastore_clock       tenant only (the head is not    -                 any write permission
--                                 record content)

DO $$
DECLARE
  t text;
  tenant text := 'org_id = records.current_org() AND datastore_id = records.current_datastore()';
BEGIN
  FOREACH t IN ARRAY ARRAY['workflow_states', 'workflow_transitions', 'custom_fields', 'projects', 'issues', 'comments'] LOOP
    EXECUTE format('DROP POLICY app_datastore ON projects.%I', t);
    EXECUTE format('CREATE POLICY tenant ON projects.%I AS RESTRICTIVE TO records_app USING (%s) WITH CHECK (%s)', t, tenant, tenant);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['journal', 'datastore_clock'] LOOP
    EXECUTE format('CREATE POLICY tenant ON records.%I AS RESTRICTIVE TO records_app USING (%s) WITH CHECK (%s)', t, tenant, tenant);
  END LOOP;
END
$$;

-- Structure: needed by every record command.
CREATE POLICY member_read ON projects.workflow_states FOR SELECT TO records_app
  USING ((SELECT records.can_any(records.current_datastore(), '{projects.read,issues.read,issues.create,issues.edit,issues.transition,comments.create}')));
CREATE POLICY member_insert ON projects.workflow_states FOR INSERT TO records_app
  WITH CHECK ((SELECT records.can(records.current_datastore(), 'projects.manage')));
CREATE POLICY member_update ON projects.workflow_states FOR UPDATE TO records_app
  USING ((SELECT records.can(records.current_datastore(), 'projects.manage')))
  WITH CHECK ((SELECT records.can(records.current_datastore(), 'projects.manage')));

CREATE POLICY member_read ON projects.workflow_transitions FOR SELECT TO records_app
  USING ((SELECT records.can_any(records.current_datastore(), '{projects.read,issues.read,issues.create,issues.edit,issues.transition,comments.create}')));
CREATE POLICY member_insert ON projects.workflow_transitions FOR INSERT TO records_app
  WITH CHECK ((SELECT records.can(records.current_datastore(), 'projects.manage')));
CREATE POLICY member_update ON projects.workflow_transitions FOR UPDATE TO records_app
  USING ((SELECT records.can(records.current_datastore(), 'projects.manage')))
  WITH CHECK ((SELECT records.can(records.current_datastore(), 'projects.manage')));

CREATE POLICY member_read ON projects.custom_fields FOR SELECT TO records_app
  USING ((SELECT records.can_any(records.current_datastore(), '{projects.read,issues.read,issues.create,issues.edit,issues.transition,comments.create}')));
CREATE POLICY member_insert ON projects.custom_fields FOR INSERT TO records_app
  WITH CHECK ((SELECT records.can(records.current_datastore(), 'projects.manage')));
CREATE POLICY member_update ON projects.custom_fields FOR UPDATE TO records_app
  USING ((SELECT records.can(records.current_datastore(), 'projects.manage')))
  WITH CHECK ((SELECT records.can(records.current_datastore(), 'projects.manage')));

CREATE POLICY member_read ON projects.projects FOR SELECT TO records_app
  USING ((SELECT records.can_any(records.current_datastore(), '{projects.read,issues.read,issues.create,issues.edit,issues.transition,comments.create}')));
CREATE POLICY member_insert ON projects.projects FOR INSERT TO records_app
  WITH CHECK ((SELECT records.can(records.current_datastore(), 'projects.manage')));
CREATE POLICY member_update ON projects.projects FOR UPDATE TO records_app
  USING ((SELECT records.can_any(records.current_datastore(), '{projects.manage,issues.create}')))
  WITH CHECK ((SELECT records.can_any(records.current_datastore(), '{projects.manage,issues.create}')));

CREATE POLICY member_read ON projects.issues FOR SELECT TO records_app
  USING ((SELECT records.can_any(records.current_datastore(), '{issues.read,issues.create,issues.edit,issues.transition,comments.create}')));
CREATE POLICY member_insert ON projects.issues FOR INSERT TO records_app
  WITH CHECK ((SELECT records.can(records.current_datastore(), 'issues.create')));
CREATE POLICY member_update ON projects.issues FOR UPDATE TO records_app
  USING ((SELECT records.can_any(records.current_datastore(), '{issues.edit,issues.transition}')))
  WITH CHECK ((SELECT records.can_any(records.current_datastore(), '{issues.edit,issues.transition}')));

CREATE POLICY member_read ON projects.comments FOR SELECT TO records_app
  USING ((SELECT records.can_any(records.current_datastore(), '{issues.read,comments.create}')));
CREATE POLICY member_insert ON projects.comments FOR INSERT TO records_app
  WITH CHECK ((SELECT records.can(records.current_datastore(), 'comments.create')));

-- The journal: reading history or changes needs issues.read; appending needs a write permission.
DROP POLICY app_read ON records.journal;
DROP POLICY app_append ON records.journal;
CREATE POLICY member_read ON records.journal FOR SELECT TO records_app
  USING ((SELECT records.can(records.current_datastore(), 'issues.read')));
CREATE POLICY member_append ON records.journal FOR INSERT TO records_app
  WITH CHECK ((SELECT records.can_any(records.current_datastore(), '{projects.manage,issues.create,issues.edit,issues.transition,comments.create}')));

-- The clock: anyone in the datastore context may read the head; only a writer may advance it.
DROP POLICY app_advance ON records.datastore_clock;
CREATE POLICY member_advance ON records.datastore_clock FOR UPDATE TO records_app
  USING ((SELECT records.can_any(records.current_datastore(), '{projects.manage,issues.create,issues.edit,issues.transition,comments.create}')))
  WITH CHECK ((SELECT records.can_any(records.current_datastore(), '{projects.manage,issues.create,issues.edit,issues.transition,comments.create}')));

-- ---------------------------------------------------------------------------------------------
-- Trusted token issuers (canonical plan §5, "Who can call"), matching TrustedIssuerSchema in
-- @records/contracts. Service configuration, not tenant data: operators manage it as the migration
-- owner; the service only reads it.

CREATE TABLE records.trusted_issuers (
  issuer      text PRIMARY KEY CHECK (issuer ~ '^https?://'),
  kind        text NOT NULL CHECK (kind IN ('delegated', 'access_saas', 'access')),
  audiences   text[] NOT NULL CHECK (cardinality(audiences) >= 1 AND array_position(audiences, '') IS NULL),
  jwks_url    text NOT NULL CHECK (jwks_url ~ '^https?://'),
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE records.trusted_issuers IS 'records:module-global';
GRANT SELECT ON records.trusted_issuers TO records_app;
