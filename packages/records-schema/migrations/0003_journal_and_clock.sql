-- Journal and per-datastore clock (canonical plan §3, Phase 1). Additive: existing registry rows
-- get a clock, and any existing module rows get a synthetic `create` journal entry so the journal
-- is complete from the start.
--
-- Every change to a journaled current-state row (projects, issues, comments) is recorded as an
-- immutable journal entry in the same transaction, and the row's `last_seq` names that entry:
--
--   * records.datastore_clock  one row per datastore. A write transaction takes it LAST with
--                              `UPDATE … SET seq = seq + 1 RETURNING seq`; the row lock serialises
--                              commits within one datastore, so `seq` is gapless and in commit
--                              order. A rolled-back transaction rolls its increment back too.
--   * records.journal          append-only, partitioned monthly by occurred_at. The app role may
--                              INSERT and SELECT only; a trigger refuses UPDATE and DELETE for every
--                              role except the table owner.
--   * journal presence         a DEFERRABLE INITIALLY DEFERRED constraint trigger on each journaled
--                              table fails the COMMIT if a written row has no journal entry for
--                              (datastore_id, last_seq, id); a BEFORE UPDATE trigger refuses a
--                              content change that does not advance last_seq. No code path,
--                              including future ones, can change current state silently.
--
-- Also here: `jira_id` identity columns for the later Jira surface (numeric ids beside keys), and
-- `records.client_mutations` for sync push (last processed mutation per client).

-- ---------------------------------------------------------------------------------------------
-- uuidv7 for SQL-side backfill. PostgreSQL 17 has no uuidv7(); the service generates its own.

CREATE FUNCTION records.uuid_v7() RETURNS uuid
  LANGUAGE sql VOLATILE PARALLEL SAFE AS $$
    SELECT encode(
      set_bit(set_bit(
        overlay(uuid_send(gen_random_uuid())
                placing substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
                FROM 1 FOR 6),
        52, 1), 53, 1), 'hex')::uuid
  $$;
REVOKE ALL ON FUNCTION records.uuid_v7() FROM PUBLIC;

-- The principal a transaction acts for, set transaction-locally by the service like org_id.
CREATE FUNCTION records.current_principal() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('records.principal_id', true), '')::uuid $$;
REVOKE ALL ON FUNCTION records.current_principal() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION records.current_principal() TO records_app;

-- ---------------------------------------------------------------------------------------------
-- The clock

CREATE TABLE records.datastore_clock (
  org_id        uuid NOT NULL,
  datastore_id  uuid NOT NULL PRIMARY KEY,
  seq           bigint NOT NULL DEFAULT 0 CHECK (seq >= 0),
  FOREIGN KEY (org_id, datastore_id) REFERENCES records.datastores(org_id, id)
);
CREATE TRIGGER datastore_clock_tenant BEFORE UPDATE ON records.datastore_clock
  FOR EACH ROW EXECUTE FUNCTION records.forbid_tenant_key_change();

INSERT INTO records.datastore_clock (org_id, datastore_id) SELECT org_id, id FROM records.datastores;

-- Every new datastore gets its clock in the creating transaction. SECURITY DEFINER because the app
-- role has no INSERT on the clock: it can only advance an existing one.
CREATE FUNCTION records.create_datastore_clock() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, records AS $$
BEGIN
  INSERT INTO records.datastore_clock (org_id, datastore_id) VALUES (NEW.org_id, NEW.id);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION records.create_datastore_clock() FROM PUBLIC;
CREATE TRIGGER datastores_clock AFTER INSERT ON records.datastores
  FOR EACH ROW EXECUTE FUNCTION records.create_datastore_clock();

ALTER TABLE records.datastore_clock ENABLE ROW LEVEL SECURITY;
-- Tenant scoping here; 0004 adds the principal checks.
CREATE POLICY app_read ON records.datastore_clock FOR SELECT TO records_app
  USING (org_id = records.current_org() AND datastore_id = records.current_datastore());
CREATE POLICY app_advance ON records.datastore_clock FOR UPDATE TO records_app
  USING (org_id = records.current_org() AND datastore_id = records.current_datastore())
  WITH CHECK (org_id = records.current_org() AND datastore_id = records.current_datastore());
GRANT SELECT, UPDATE (seq) ON records.datastore_clock TO records_app;

-- ---------------------------------------------------------------------------------------------
-- The journal

CREATE TABLE records.journal (
  org_id        uuid        NOT NULL,
  datastore_id  uuid        NOT NULL,
  seq           bigint      NOT NULL CHECK (seq >= 1),        -- from the clock; one per transaction
  ordinal       smallint    NOT NULL CHECK (ordinal >= 0),    -- position within the transaction
  change_id     uuid        NOT NULL,                         -- uuidv7
  command       text        NOT NULL CHECK (command ~ '^[a-z]+\.[A-Za-z]+$'),
  command_id    uuid        NOT NULL,
  entity_type   text        NOT NULL CHECK (entity_type ~ '^[a-z_]{1,40}$'),
  entity_id     uuid        NOT NULL,
  entity_rev    int         NOT NULL CHECK (entity_rev >= 1),
  op            text        NOT NULL CHECK (op IN ('create', 'update', 'archive', 'restore', 'redact')),
  after         jsonb       NOT NULL CHECK (jsonb_typeof(after) = 'object'),
  before        jsonb                CHECK (before IS NULL OR jsonb_typeof(before) = 'object'),
  actor_id      uuid        NOT NULL,
  act_id        uuid,
  via           text        NOT NULL CHECK (via IN ('gadget', 'http', 'sync', 'jira', 'management', 'system')),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  -- Partitioned-table keys must include the partition key. The (datastore_id, seq) prefix of this
  -- index is the B-tree the changes feed reads.
  PRIMARY KEY (datastore_id, seq, ordinal, occurred_at)
) PARTITION BY RANGE (occurred_at);
COMMENT ON TABLE records.journal IS 'Immutable change journal; current tables are a cache of it.';

-- Entity history (`…/history`) and the journal-presence check look entries up by entity.
CREATE INDEX journal_entity ON records.journal (datastore_id, entity_id, seq);
CREATE INDEX journal_occurred_brin ON records.journal USING brin (occurred_at);

-- Rows outside every monthly partition land here, so a lapsed maintenance job never fails a write.
CREATE TABLE records.journal_default PARTITION OF records.journal DEFAULT;
ALTER TABLE records.journal_default ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE records.journal_default IS 'records:journal-partition';

-- Append-only. The app role holds no UPDATE or DELETE privilege at all; this trigger also refuses
-- them to any other role that is ever granted them. Only the table owner (the migration owner) is
-- exempt, for the audited redaction procedure and partition maintenance.
CREATE FUNCTION records.journal_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = TG_RELID) THEN
    RAISE EXCEPTION 'the journal is append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END
$$;
REVOKE ALL ON FUNCTION records.journal_append_only() FROM PUBLIC;
CREATE TRIGGER journal_append_only BEFORE UPDATE OR DELETE ON records.journal
  FOR EACH ROW EXECUTE FUNCTION records.journal_append_only();
CREATE TRIGGER journal_no_truncate BEFORE TRUNCATE ON records.journal
  FOR EACH STATEMENT EXECUTE FUNCTION records.journal_append_only();

-- Monthly partitions from the current month to `p_months_ahead` months ahead (UTC). Idempotent;
-- returns how many it created. Run by the migration and then by a maintenance job as the publisher
-- role. If rows for a new month already sit in the default partition (maintenance lapsed), they are
-- moved into the new partition in the same transaction.
CREATE FUNCTION records.ensure_journal_partitions(p_months_ahead int DEFAULT 3) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, records SET timezone = 'UTC' AS $$
DECLARE
  first_month timestamptz := date_trunc('month', now());
  lo timestamptz;
  hi timestamptz;
  part text;
  created int := 0;
BEGIN
  IF p_months_ahead IS NULL OR p_months_ahead < 0 OR p_months_ahead > 24 THEN
    RAISE EXCEPTION 'months ahead must be between 0 and 24' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOR i IN 0 .. p_months_ahead LOOP
    lo := first_month + make_interval(months => i);
    hi := lo + interval '1 month';
    part := 'journal_' || to_char(lo, 'YYYY"m"MM');
    CONTINUE WHEN to_regclass('records.' || quote_ident(part)) IS NOT NULL;
    IF EXISTS (SELECT 1 FROM records.journal_default WHERE occurred_at >= lo AND occurred_at < hi) THEN
      ALTER TABLE records.journal DETACH PARTITION records.journal_default;
      EXECUTE format('CREATE TABLE records.%I PARTITION OF records.journal FOR VALUES FROM (%L) TO (%L)', part, lo, hi);
      INSERT INTO records.journal SELECT * FROM records.journal_default WHERE occurred_at >= lo AND occurred_at < hi;
      DELETE FROM records.journal_default WHERE occurred_at >= lo AND occurred_at < hi;
      ALTER TABLE records.journal ATTACH PARTITION records.journal_default DEFAULT;
    ELSE
      EXECUTE format('CREATE TABLE records.%I PARTITION OF records.journal FOR VALUES FROM (%L) TO (%L)', part, lo, hi);
    END IF;
    -- Partitions are reached only through the parent (whose policies apply); RLS on the partition
    -- itself denies any direct access.
    EXECUTE format('ALTER TABLE records.%I ENABLE ROW LEVEL SECURITY', part);
    EXECUTE format('COMMENT ON TABLE records.%I IS %L', part, 'records:journal-partition');
    created := created + 1;
  END LOOP;
  RETURN created;
END
$$;
REVOKE ALL ON FUNCTION records.ensure_journal_partitions(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION records.ensure_journal_partitions(int) TO records_publisher;
SELECT records.ensure_journal_partitions(3);

ALTER TABLE records.journal ENABLE ROW LEVEL SECURITY;
-- Tenant scoping here; 0004 adds the principal checks.
CREATE POLICY app_read ON records.journal FOR SELECT TO records_app
  USING (org_id = records.current_org() AND datastore_id = records.current_datastore());
CREATE POLICY app_append ON records.journal FOR INSERT TO records_app
  WITH CHECK (org_id = records.current_org() AND datastore_id = records.current_datastore());
GRANT SELECT, INSERT ON records.journal TO records_app;

-- ---------------------------------------------------------------------------------------------
-- last_seq on journaled tables, with a backfilled `create` entry for any existing row

ALTER TABLE projects.projects ADD COLUMN last_seq bigint;
ALTER TABLE projects.issues ADD COLUMN last_seq bigint;
ALTER TABLE projects.comments ADD COLUMN last_seq bigint;

DO $$
DECLARE
  r record;
  s bigint;
BEGIN
  FOR r IN
    SELECT * FROM (
      SELECT p.org_id, p.datastore_id, 'project' AS entity_type, p.id, p.revision, p.created_by AS actor, p.created_at, 0 AS rank,
             jsonb_build_object('key', p.key, 'name', p.name, 'description', p.description) AS after
        FROM projects.projects p
      UNION ALL
      SELECT i.org_id, i.datastore_id, 'issue', i.id, i.revision, i.created_by, i.created_at, 1,
             jsonb_build_object('projectId', i.project_id, 'number', i.number, 'key', p.key || '-' || i.number,
                                'title', i.title, 'description', i.description, 'state', i.state, 'priority', i.priority,
                                'assigneeId', i.assignee_id, 'customFields', i.custom_fields)
        FROM projects.issues i JOIN projects.projects p ON p.id = i.project_id
      UNION ALL
      SELECT c.org_id, c.datastore_id, 'comment', c.id, 1, c.author_id, c.created_at, 2,
             jsonb_build_object('issueId', c.issue_id, 'body', c.body, 'authorId', c.author_id)
        FROM projects.comments c
    ) x ORDER BY datastore_id, rank, created_at, id
  LOOP
    UPDATE records.datastore_clock SET seq = seq + 1 WHERE datastore_id = r.datastore_id RETURNING seq INTO s;
    INSERT INTO records.journal (org_id, datastore_id, seq, ordinal, change_id, command, command_id, entity_type, entity_id,
                                 entity_rev, op, after, before, actor_id, act_id, via)
    VALUES (r.org_id, r.datastore_id, s, 0, records.uuid_v7(), 'system.backfill', records.uuid_v7(), r.entity_type, r.id,
            r.revision, 'create', r.after, NULL, r.actor, NULL, 'system');
    IF r.entity_type = 'project' THEN
      UPDATE projects.projects SET last_seq = s WHERE id = r.id;
    ELSIF r.entity_type = 'issue' THEN
      UPDATE projects.issues SET last_seq = s WHERE id = r.id;
    ELSE
      UPDATE projects.comments SET last_seq = s WHERE id = r.id;
    END IF;
  END LOOP;
END
$$;

ALTER TABLE projects.projects ALTER COLUMN last_seq SET NOT NULL;
ALTER TABLE projects.issues ALTER COLUMN last_seq SET NOT NULL;
ALTER TABLE projects.comments ALTER COLUMN last_seq SET NOT NULL;
GRANT UPDATE (last_seq) ON projects.projects, projects.issues TO records_app;

-- A content change must advance last_seq. TG_ARGV names bookkeeping columns that may change
-- without a journal entry (a project's issue-number allocator). The triggers are named so they fire
-- after the `*_tenant` immutability triggers (same-event triggers fire in name order).
CREATE FUNCTION records.require_seq_advance() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.last_seq IS NOT DISTINCT FROM OLD.last_seq
     AND (to_jsonb(NEW) - coalesce(TG_ARGV, '{}'::text[])) IS DISTINCT FROM (to_jsonb(OLD) - coalesce(TG_ARGV, '{}'::text[])) THEN
    RAISE EXCEPTION 'a change to %.% must advance last_seq and be journaled', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION records.require_seq_advance() FROM PUBLIC;

-- Checked at COMMIT: the row's (datastore_id, last_seq, id) must have a journal entry. SECURITY
-- DEFINER so the check sees entries the writer itself may not be permitted to read back (a
-- create-only binding writes entries it cannot SELECT).
CREATE FUNCTION records.require_journal_entry() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, records AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM records.journal j
                  WHERE j.datastore_id = NEW.datastore_id AND j.seq = NEW.last_seq AND j.entity_id = NEW.id) THEN
    RAISE EXCEPTION 'no journal entry for %.% % at seq %', TG_TABLE_SCHEMA, TG_TABLE_NAME, NEW.id, NEW.last_seq
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION records.require_journal_entry() FROM PUBLIC;

CREATE TRIGGER projects_unjournaled_change BEFORE UPDATE ON projects.projects
  FOR EACH ROW EXECUTE FUNCTION records.require_seq_advance('next_issue_number');
CREATE TRIGGER issues_unjournaled_change BEFORE UPDATE ON projects.issues
  FOR EACH ROW EXECUTE FUNCTION records.require_seq_advance();
CREATE TRIGGER comments_unjournaled_change BEFORE UPDATE ON projects.comments
  FOR EACH ROW EXECUTE FUNCTION records.require_seq_advance();

CREATE CONSTRAINT TRIGGER projects_journaled AFTER INSERT OR UPDATE ON projects.projects
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION records.require_journal_entry();
CREATE CONSTRAINT TRIGGER issues_journaled AFTER INSERT OR UPDATE ON projects.issues
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION records.require_journal_entry();
CREATE CONSTRAINT TRIGGER comments_journaled AFTER INSERT OR UPDATE ON projects.comments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION records.require_journal_entry();

-- ---------------------------------------------------------------------------------------------
-- Numeric identifiers for the Jira surface (canonical plan §7, "Identifiers"). Identity columns:
-- existing rows are numbered now, the app role needs no sequence privilege, and cannot choose one.

ALTER TABLE projects.projects ADD COLUMN jira_id bigint GENERATED ALWAYS AS IDENTITY UNIQUE;
ALTER TABLE projects.issues ADD COLUMN jira_id bigint GENERATED ALWAYS AS IDENTITY UNIQUE;
ALTER TABLE projects.comments ADD COLUMN jira_id bigint GENERATED ALWAYS AS IDENTITY UNIQUE;
ALTER TABLE projects.workflow_states ADD COLUMN jira_id bigint GENERATED ALWAYS AS IDENTITY UNIQUE;

-- ---------------------------------------------------------------------------------------------
-- Sync: the last mutation processed per client (canonical plan §6). A client group belongs to one
-- principal; its rows are visible only within that principal's own transactions.

CREATE TABLE records.client_mutations (
  org_id            uuid NOT NULL,
  datastore_id      uuid NOT NULL,
  client_group_id   text NOT NULL CHECK (client_group_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  client_id         text NOT NULL CHECK (client_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  principal_id      uuid NOT NULL,
  last_mutation_id  bigint NOT NULL DEFAULT 0 CHECK (last_mutation_id >= 0),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (datastore_id, client_group_id, client_id),
  FOREIGN KEY (org_id, datastore_id) REFERENCES records.datastores(org_id, id),
  FOREIGN KEY (org_id, principal_id) REFERENCES records.principals(org_id, id)
);
CREATE TRIGGER client_mutations_tenant BEFORE UPDATE ON records.client_mutations
  FOR EACH ROW EXECUTE FUNCTION records.forbid_tenant_key_change();
ALTER TABLE records.client_mutations ENABLE ROW LEVEL SECURITY;
CREATE POLICY app_own ON records.client_mutations TO records_app
  USING (org_id = records.current_org() AND datastore_id = records.current_datastore()
         AND principal_id = records.current_principal())
  WITH CHECK (org_id = records.current_org() AND datastore_id = records.current_datastore()
              AND principal_id = records.current_principal());
GRANT SELECT, INSERT ON records.client_mutations TO records_app;
GRANT UPDATE (last_mutation_id, updated_at) ON records.client_mutations TO records_app;
