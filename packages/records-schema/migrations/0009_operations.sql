-- Operations (canonical plan §8, Phase 6): redaction, journal archival bookkeeping and the analytics
-- contract. Per-datastore restore needs no schema: it replays the journal as `system` commands
-- through the ordinary tables (packages/records-core/src/ops). Runbook:
-- docs/plans/external_datastores/records-operations.md.
--
-- Everything operator-only lives in the `records_ops` schema, which no runtime role can even see:
--
--   records_ops.redact(...)          the one sanctioned exception to journal immutability
--   records_ops.redactions           ledger of redactions, so a restore from an older branch
--                                    re-applies them instead of bringing the text back
--   records_ops.journal_archives     ledger of journal partitions exported and detached
--   records_ops.analytics_logins     which principal each analytics login reads as
--
-- The journal's append-only trigger (0003) exempted the table owner outright. It is tightened here:
-- the owner may still DELETE and TRUNCATE (partition maintenance and retention), but an UPDATE is
-- refused to every role, the owner included, unless it runs inside records_ops.redact, which sets
-- `records.journal_redaction` around its journal UPDATE, and changes only `after` and `before`. Any role
-- can set that setting; it only matters for the owner, who could drop the trigger anyway. The
-- guard stops accidents and every non-owner path, not a malicious owner.

CREATE SCHEMA records_ops;
REVOKE ALL ON SCHEMA records_ops FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- 1. Append-only journal, tightened for the owner; journal presence, relaxed for retention

CREATE OR REPLACE FUNCTION records.journal_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = TG_RELID) THEN
    IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
      RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NULL END;
    END IF;
    IF TG_OP = 'UPDATE' AND current_setting('records.journal_redaction', true) = 'on'
       AND (to_jsonb(NEW) - 'after' - 'before') = (to_jsonb(OLD) - 'after' - 'before') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'the journal is append-only' USING ERRCODE = 'insufficient_privilege';
END
$$;

-- Journal presence (0003) is checked on every INSERT and UPDATE of a journaled row. An UPDATE that
-- keeps last_seq changes no content (require_seq_advance guarantees it: only bookkeeping columns
-- such as a project's issue-number allocator), so it needs no new entry. Checking the old entry
-- anyway broke retention: once a row's last entry is archived, allocating an issue number in its
-- project failed. Now only a row whose last_seq is new must name an existing entry.
CREATE OR REPLACE FUNCTION records.require_journal_entry() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, records AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.last_seq IS NOT DISTINCT FROM OLD.last_seq THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM records.journal j
                  WHERE j.datastore_id = NEW.datastore_id AND j.seq = NEW.last_seq AND j.entity_id = NEW.id) THEN
    RAISE EXCEPTION 'no journal entry for %.% % at seq %', TG_TABLE_SCHEMA, TG_TABLE_NAME, NEW.id, NEW.last_seq
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. Redaction (plan §8, "Erasure")

-- Fields that may be redacted, per journaled entity type: free text only. Keys, numbers, states and
-- principal IDs are not personal free text and are never overwritten.
CREATE FUNCTION records_ops.redactable_fields(p_entity_type text) RETURNS text[]
  LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE p_entity_type
      WHEN 'project' THEN ARRAY['name', 'description']
      WHEN 'issue'   THEN ARRAY['title', 'description']
      WHEN 'comment' THEN ARRAY['body']
    END
  $$;

-- `j` with each of `keys` it already has replaced by `marker`.
CREATE FUNCTION records_ops.mask_keys(j jsonb, keys text[], marker text) RETURNS jsonb
  LANGUAGE sql IMMUTABLE AS $$
    SELECT j || coalesce((SELECT jsonb_object_agg(k, to_jsonb(marker)) FROM unnest(keys) AS k WHERE j ? k), '{}'::jsonb)
  $$;

-- Walk a saved command outcome (an idempotency row) and mask `keys` in every object whose "id" is
-- `p_id`: the record DTOs a replay would return.
CREATE FUNCTION records_ops.mask_record(j jsonb, p_id text, keys text[], marker text) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  r jsonb := '{}'::jsonb;
  k text;
  v jsonb;
BEGIN
  IF jsonb_typeof(j) = 'object' THEN
    FOR k, v IN SELECT e.key, e.value FROM jsonb_each(j) AS e LOOP
      r := r || jsonb_build_object(k, records_ops.mask_record(v, p_id, keys, marker));
    END LOOP;
    IF r->>'id' = p_id THEN
      r := records_ops.mask_keys(r, keys, marker);
    END IF;
    RETURN r;
  ELSIF jsonb_typeof(j) = 'array' THEN
    RETURN coalesce((SELECT jsonb_agg(records_ops.mask_record(e, p_id, keys, marker) ORDER BY o)
                       FROM jsonb_array_elements(j) WITH ORDINALITY AS t(e, o)), '[]'::jsonb);
  END IF;
  RETURN j;
END
$$;

CREATE TABLE records_ops.redactions (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL,
  datastore_id  uuid NOT NULL,
  entity_type   text NOT NULL,
  entity_id     uuid NOT NULL,
  fields        text[] NOT NULL,
  marker        text NOT NULL,
  seq           bigint NOT NULL,
  reason        text NOT NULL,
  actor_id      uuid NOT NULL,
  redacted_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, datastore_id) REFERENCES records.datastores(org_id, id),
  FOREIGN KEY (org_id, actor_id) REFERENCES records.principals(org_id, id)
);
CREATE INDEX redactions_datastore ON records_ops.redactions (datastore_id, entity_id);
ALTER TABLE records_ops.redactions ENABLE ROW LEVEL SECURITY;

-- Overwrite the named free-text fields of one record with `p_marker`: in the current row, in every
-- past journal entry's `after` and `before`, and in saved idempotency outcomes. Then journal a
-- `redact` entry (after = the masked fields, before = null), record an audit event and a ledger row,
-- and emit an outbox event for issues so clients refetch. One transaction; the row is locked before
-- the clock, as every command does. Executable only by the owner (EXECUTE is granted to nobody).
CREATE FUNCTION records_ops.redact(
  p_datastore uuid, p_entity_type text, p_entity_id uuid, p_fields text[], p_reason text, p_actor uuid,
  p_marker text DEFAULT '[redacted]'
) RETURNS TABLE (seq bigint, journal_entries int, idempotency_rows int)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, records AS $$
#variable_conflict use_column
DECLARE
  v_allowed text[] := records_ops.redactable_fields(p_entity_type);
  v_fields text[];
  v_org uuid;
  v_rev int;
  v_seq bigint;
  v_entries int;
  v_idem int;
  v_after jsonb;
BEGIN
  IF v_allowed IS NULL THEN
    RAISE EXCEPTION 'unknown entity type %', p_entity_type USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_fields := ARRAY(SELECT DISTINCT f FROM unnest(p_fields) AS f ORDER BY f);
  IF cardinality(v_fields) = 0 OR NOT (v_fields <@ v_allowed) THEN
    RAISE EXCEPTION 'fields must be a non-empty subset of %', v_allowed USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 OR length(p_reason) > 500 THEN
    RAISE EXCEPTION 'a reason of 3 to 500 characters is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_marker IS NULL OR length(p_marker) NOT BETWEEN 1 AND 40 THEN
    RAISE EXCEPTION 'the marker must be 1 to 40 characters' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT d.org_id INTO v_org FROM records.datastores d WHERE d.id = p_datastore;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'unknown datastore %', p_datastore USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM records.principals p WHERE p.id = p_actor AND p.org_id = v_org) THEN
    RAISE EXCEPTION 'the actor must be a principal of the datastore''s organisation' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_entity_type = 'project' THEN
    SELECT x.revision INTO v_rev FROM projects.projects x WHERE x.datastore_id = p_datastore AND x.id = p_entity_id FOR UPDATE;
  ELSIF p_entity_type = 'issue' THEN
    SELECT x.revision INTO v_rev FROM projects.issues x WHERE x.datastore_id = p_datastore AND x.id = p_entity_id FOR UPDATE;
  ELSE
    SELECT 1 INTO v_rev FROM projects.comments x WHERE x.datastore_id = p_datastore AND x.id = p_entity_id FOR UPDATE;
  END IF;
  IF v_rev IS NULL THEN
    RAISE EXCEPTION 'no % % in datastore %', p_entity_type, p_entity_id, p_datastore USING ERRCODE = 'no_data_found';
  END IF;

  -- Past entries first, so the redact entry written below is not itself rewritten. The trigger's
  -- exemption is switched on around this one statement: set_config, not a function-level SET clause,
  -- because attaching a custom setting to a function needs superuser on managed Postgres (Neon).
  PERFORM set_config('records.journal_redaction', 'on', true);
  UPDATE records.journal j
     SET after = records_ops.mask_keys(j.after, v_fields, p_marker),
         before = CASE WHEN j.before IS NULL THEN NULL ELSE records_ops.mask_keys(j.before, v_fields, p_marker) END
   WHERE j.datastore_id = p_datastore AND j.entity_id = p_entity_id
     AND (j.after ?| v_fields OR coalesce(j.before ?| v_fields, false));
  GET DIAGNOSTICS v_entries = ROW_COUNT;
  PERFORM set_config('records.journal_redaction', 'off', true);

  UPDATE records.idempotency_keys k
     SET outcome = records_ops.mask_record(k.outcome, p_entity_id::text, v_fields, p_marker)
   WHERE k.datastore_id = p_datastore AND strpos(k.outcome::text, p_entity_id::text) > 0;
  GET DIAGNOSTICS v_idem = ROW_COUNT;

  INSERT INTO records.audit_events (org_id, id, datastore_id, operation, actor_principal_id, via, target_type, target_id, summary, detail)
  VALUES (v_org, gen_random_uuid(), p_datastore, 'redact', p_actor, 'system', p_entity_type, p_entity_id,
          format('Redacted %s fields: %s', p_entity_type, array_to_string(v_fields, ', ')),
          jsonb_build_object('fields', to_jsonb(v_fields), 'reason', p_reason, 'journalEntries', v_entries, 'idempotencyRows', v_idem));
  IF p_entity_type = 'issue' THEN
    INSERT INTO records.outbox (event_id, org_id, datastore_id, event_type, entity_type, entity_id, revision)
    VALUES (gen_random_uuid(), v_org, p_datastore, 'issue.updated', 'issue', p_entity_id, v_rev + 1);
  END IF;

  -- The clock last, as in every command.
  UPDATE records.datastore_clock c SET seq = c.seq + 1 WHERE c.datastore_id = p_datastore RETURNING c.seq INTO v_seq;

  IF p_entity_type = 'project' THEN
    UPDATE projects.projects x
       SET name = CASE WHEN 'name' = ANY (v_fields) THEN p_marker ELSE x.name END,
           description = CASE WHEN 'description' = ANY (v_fields) THEN p_marker ELSE x.description END,
           revision = x.revision + 1, last_seq = v_seq, updated_by = p_actor, updated_at = now()
     WHERE x.datastore_id = p_datastore AND x.id = p_entity_id;
  ELSIF p_entity_type = 'issue' THEN
    UPDATE projects.issues x
       SET title = CASE WHEN 'title' = ANY (v_fields) THEN p_marker ELSE x.title END,
           description = CASE WHEN 'description' = ANY (v_fields) THEN p_marker ELSE x.description END,
           revision = x.revision + 1, last_seq = v_seq, updated_by = p_actor, updated_at = now()
     WHERE x.datastore_id = p_datastore AND x.id = p_entity_id;
  ELSE
    -- Comments carry no revision: their journal entity_rev stays 1.
    UPDATE projects.comments x SET body = p_marker, last_seq = v_seq
     WHERE x.datastore_id = p_datastore AND x.id = p_entity_id;
  END IF;

  v_after := (SELECT jsonb_object_agg(f, to_jsonb(p_marker)) FROM unnest(v_fields) AS f);
  INSERT INTO records.journal (org_id, datastore_id, seq, ordinal, change_id, command, command_id, entity_type, entity_id,
                               entity_rev, op, after, before, actor_id, act_id, via)
  VALUES (v_org, p_datastore, v_seq, 0, records.uuid_v7(), 'system.redact', records.uuid_v7(), p_entity_type, p_entity_id,
          CASE WHEN p_entity_type = 'comment' THEN 1 ELSE v_rev + 1 END, 'redact', v_after, NULL, p_actor, NULL, 'system');

  INSERT INTO records_ops.redactions (id, org_id, datastore_id, entity_type, entity_id, fields, marker, seq, reason, actor_id)
  VALUES (gen_random_uuid(), v_org, p_datastore, p_entity_type, p_entity_id, v_fields, p_marker, v_seq, p_reason, p_actor);

  RETURN QUERY SELECT v_seq, v_entries, v_idem;
END
$$;
REVOKE ALL ON FUNCTION records_ops.redact(uuid, text, uuid, text[], text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION records_ops.redactable_fields(text), records_ops.mask_keys(jsonb, text[], text),
                       records_ops.mask_record(jsonb, text, text[], text) FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- 3. Journal archival ledger (plan §8, "Retention"). The export and detach are driven from the
-- operator CLI (archive-journal), which writes one row per partition it removed.

CREATE TABLE records_ops.journal_archives (
  partition     text PRIMARY KEY,
  range_from    timestamptz NOT NULL,
  range_to      timestamptz NOT NULL,
  row_count     bigint NOT NULL,
  -- {datastore_id: [min seq, max seq]} of the archived rows: what a later restore would need.
  seq_ranges    jsonb NOT NULL,
  location      text NOT NULL,
  sha256        text,
  dropped       boolean NOT NULL,
  archived_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE records_ops.journal_archives ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------------------------
-- 4. Analytics contract, v1 (plan §8, "Analytics")
--
-- Read-only views in `analytics`, named with a version suffix; a breaking change adds _v2 beside
-- _v1. They are security_invoker, so the base tables' row-level security applies to whoever reads
-- them. The records_analytics group role gets its own read policies, keyed to the LOGIN it
-- connected as (session_user, which the session cannot change without superuser) through
-- records_ops.analytics_logins, never to a setting the session could forge. An analytics login
-- therefore sees exactly the datastores its mapped principal may read (issues.read), and nothing
-- if it is unmapped, disabled or has no membership. It is SELECT-only, on the columns the views use.

DO $$
BEGIN
  CREATE ROLE records_analytics NOLOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE;
EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
END
$$;

CREATE TABLE records_ops.analytics_logins (
  login         name PRIMARY KEY,
  org_id        uuid NOT NULL,
  principal_id  uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, principal_id) REFERENCES records.principals(org_id, id)
);
ALTER TABLE records_ops.analytics_logins ENABLE ROW LEVEL SECURITY;

CREATE SCHEMA analytics;
REVOKE ALL ON SCHEMA analytics FROM PUBLIC;
GRANT USAGE ON SCHEMA analytics TO records_analytics;

-- The datastores the connected analytics login's principal may read. PL/pgSQL for plan caching
-- (see records.can_any); policies wrap it in (SELECT …) so it runs once per statement.
CREATE FUNCTION analytics.readable_datastores() RETURNS uuid[]
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, records AS $$
BEGIN
  RETURN coalesce((
    SELECT array_agg(DISTINCT m.datastore_id)
      FROM records_ops.analytics_logins l
      JOIN records.principals p
        ON p.id = l.principal_id AND p.org_id = l.org_id AND p.status = 'active' AND (p.expires_at IS NULL OR p.expires_at > now())
      JOIN records.memberships m ON m.org_id = l.org_id AND m.principal_id = l.principal_id
      JOIN records.role_permissions rp ON rp.role = m.role AND rp.permission = 'issues.read'
     WHERE l.login = session_user), '{}'::uuid[]);
END
$$;
REVOKE ALL ON FUNCTION analytics.readable_datastores() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION analytics.readable_datastores() TO records_analytics;

CREATE POLICY analytics_read ON records.datastores FOR SELECT TO records_analytics
  USING (id = ANY ((SELECT analytics.readable_datastores())::uuid[]));
CREATE POLICY analytics_read ON projects.projects FOR SELECT TO records_analytics
  USING (datastore_id = ANY ((SELECT analytics.readable_datastores())::uuid[]));
CREATE POLICY analytics_read ON projects.issues FOR SELECT TO records_analytics
  USING (datastore_id = ANY ((SELECT analytics.readable_datastores())::uuid[]));
CREATE POLICY analytics_read ON projects.comments FOR SELECT TO records_analytics
  USING (datastore_id = ANY ((SELECT analytics.readable_datastores())::uuid[]));
CREATE POLICY analytics_read ON projects.workflow_states FOR SELECT TO records_analytics
  USING (datastore_id = ANY ((SELECT analytics.readable_datastores())::uuid[]));
CREATE POLICY analytics_read ON records.journal FOR SELECT TO records_analytics
  USING (datastore_id = ANY ((SELECT analytics.readable_datastores())::uuid[]));

-- Column privileges: what the views read, nothing more (no journal bodies, no credentials).
GRANT SELECT (org_id, id, name, module_id, lifecycle, created_at) ON records.datastores TO records_analytics;
GRANT SELECT (org_id, datastore_id, id, key, name, description, created_at, updated_at) ON projects.projects TO records_analytics;
GRANT SELECT (org_id, datastore_id, id, project_id, number, title, state, priority, assignee_id, revision, created_by,
              created_at, updated_at) ON projects.issues TO records_analytics;
GRANT SELECT (datastore_id, issue_id) ON projects.comments TO records_analytics;
GRANT SELECT (datastore_id, key, name, category) ON projects.workflow_states TO records_analytics;
GRANT SELECT (org_id, datastore_id, seq, entity_type, op, via, actor_id, occurred_at) ON records.journal TO records_analytics;

CREATE VIEW analytics.datastores_v1 WITH (security_invoker = true) AS
  SELECT d.org_id, d.id AS datastore_id, d.name, d.module_id, d.lifecycle, d.created_at
    FROM records.datastores d;

CREATE VIEW analytics.projects_v1 WITH (security_invoker = true) AS
  SELECT p.org_id, p.datastore_id, p.id AS project_id, p.key AS project_key, p.name, p.description, p.created_at, p.updated_at
    FROM projects.projects p;

CREATE VIEW analytics.issues_v1 WITH (security_invoker = true) AS
  SELECT i.org_id, i.datastore_id, i.id AS issue_id, i.project_id, p.key AS project_key, p.key || '-' || i.number AS issue_key,
         i.number, i.title, i.state, s.name AS state_name, s.category AS state_category, i.priority, i.assignee_id,
         i.revision, i.created_by, i.created_at, i.updated_at,
         (SELECT count(*) FROM projects.comments c WHERE c.datastore_id = i.datastore_id AND c.issue_id = i.id) AS comment_count
    FROM projects.issues i
    JOIN projects.projects p ON p.id = i.project_id
    JOIN projects.workflow_states s ON s.datastore_id = i.datastore_id AND s.key = i.state;

-- One row per datastore, UTC day, entity type, operation and channel, from the journal.
CREATE VIEW analytics.daily_activity_v1 WITH (security_invoker = true) AS
  SELECT j.org_id, j.datastore_id, (j.occurred_at AT TIME ZONE 'UTC')::date AS day, j.entity_type, j.op, j.via,
         count(*) AS changes, count(DISTINCT j.seq) AS transactions, count(DISTINCT j.actor_id) AS actors
    FROM records.journal j
   GROUP BY 1, 2, 3, 4, 5, 6;

COMMENT ON SCHEMA analytics IS 'Records analytics contract. Views are versioned (_v1); never change a published view incompatibly.';
COMMENT ON VIEW analytics.datastores_v1 IS 'analytics contract v1';
COMMENT ON VIEW analytics.projects_v1 IS 'analytics contract v1';
COMMENT ON VIEW analytics.issues_v1 IS 'analytics contract v1';
COMMENT ON VIEW analytics.daily_activity_v1 IS 'analytics contract v1';
GRANT SELECT ON analytics.datastores_v1, analytics.projects_v1, analytics.issues_v1, analytics.daily_activity_v1 TO records_analytics;
