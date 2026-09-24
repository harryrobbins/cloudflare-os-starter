-- Records restore verification: one read-only statement, run against a restored copy (the restore
-- rehearsal) or, read-only, against production. Output rows: check | status | detail, where status
-- is ok, FAIL or info. Any FAIL means the copy is not trustworthy. See
-- docs/plans/external_datastores/records-operations.md, "Restore rehearsal".
--
-- Checks:
--   clock_matches_journal  each datastore's clock equals its highest journal seq
--   journal_gapless        each datastore's retained seqs are contiguous
--   journal_presence       each current row's last_seq names a journal entry (unless archived)
--   journal_rebuild        current content equals the latest journaled value of every field, for
--                          datastores whose journal still starts at seq 1
--   rls_enabled            every table in records and projects has row-level security, bar the
--                          declared module-global ones
WITH
  bounds AS (
    SELECT d.id AS datastore_id, c.seq AS head, min(j.seq) AS lo, max(j.seq) AS hi, count(DISTINCT j.seq) AS n
      FROM records.datastores d
      JOIN records.datastore_clock c ON c.datastore_id = d.id
      LEFT JOIN records.journal j ON j.datastore_id = d.id
     GROUP BY d.id, c.seq),
  complete AS (SELECT datastore_id FROM bounds WHERE lo = 1),
  latest AS (
    SELECT DISTINCT ON (j.entity_id, f.key) j.entity_id, f.key, f.value
      FROM records.journal j CROSS JOIN LATERAL jsonb_each(j.after) AS f
     WHERE j.datastore_id IN (SELECT datastore_id FROM complete)
     ORDER BY j.entity_id, f.key, j.seq DESC, j.ordinal DESC),
  content AS (
    SELECT i.id, i.datastore_id, i.last_seq,
           jsonb_build_object('title', i.title, 'description', i.description, 'state', i.state, 'priority', i.priority,
                              'assigneeId', i.assignee_id, 'customFields', i.custom_fields) AS doc
      FROM projects.issues i
    UNION ALL
    SELECT p.id, p.datastore_id, p.last_seq, jsonb_build_object('name', p.name, 'description', p.description) FROM projects.projects p
    UNION ALL
    SELECT c.id, c.datastore_id, c.last_seq, jsonb_build_object('body', c.body) FROM projects.comments c),
  mismatches AS (
    SELECT cur.id, f.key
      FROM content cur CROSS JOIN LATERAL jsonb_each(cur.doc) AS f
      LEFT JOIN latest l ON l.entity_id = cur.id AND l.key = f.key
     WHERE cur.datastore_id IN (SELECT datastore_id FROM complete)
       AND l.value IS DISTINCT FROM f.value
       -- A field never journaled for this entity (created before the field existed) is not a mismatch.
       AND EXISTS (SELECT 1 FROM latest l2 WHERE l2.entity_id = cur.id)
       AND NOT (l.value IS NULL AND f.value IN ('""'::jsonb, 'null'::jsonb, '{}'::jsonb))),
  missing AS (
    SELECT cur.id FROM content cur JOIN bounds b ON b.datastore_id = cur.datastore_id
     WHERE cur.last_seq >= coalesce(b.lo, cur.last_seq + 1)
       AND NOT EXISTS (SELECT 1 FROM records.journal j
                        WHERE j.datastore_id = cur.datastore_id AND j.seq = cur.last_seq AND j.entity_id = cur.id)),
  unprotected AS (
    SELECT n.nspname || '.' || c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('records', 'projects') AND NOT c.relrowsecurity
       AND coalesce(obj_description(c.oid, 'pg_class'), '') <> 'records:module-global')
SELECT 'migrations' AS check, 'info' AS status,
       (SELECT count(*) || ' applied, last ' || max(id) FROM records_meta.schema_migrations) AS detail
UNION ALL
SELECT 'row_counts', 'info', format('organisations=%s principals=%s datastores=%s memberships=%s projects=%s issues=%s comments=%s journal=%s audit=%s',
       (SELECT count(*) FROM records.organisations), (SELECT count(*) FROM records.principals),
       (SELECT count(*) FROM records.datastores), (SELECT count(*) FROM records.memberships),
       (SELECT count(*) FROM projects.projects), (SELECT count(*) FROM projects.issues), (SELECT count(*) FROM projects.comments),
       (SELECT count(*) FROM records.journal), (SELECT count(*) FROM records.audit_events))
UNION ALL
SELECT 'journal_partitions', 'info', format('%s attached, %s rows in the default partition',
       (SELECT count(*) FROM pg_inherits WHERE inhparent = 'records.journal'::regclass),
       (SELECT count(*) FROM records.journal_default))
UNION ALL
SELECT 'clock_matches_journal', CASE WHEN count(*) = 0 THEN 'ok' ELSE 'FAIL' END,
       coalesce(string_agg(format('%s clock=%s journal max=%s', datastore_id, head, hi), '; '), 'every datastore')
  FROM bounds WHERE hi IS NOT NULL AND hi <> head
UNION ALL
SELECT 'journal_gapless', CASE WHEN count(*) = 0 THEN 'ok' ELSE 'FAIL' END,
       coalesce(string_agg(format('%s has %s seqs in %s..%s', datastore_id, n, lo, hi), '; '), 'every datastore')
  FROM bounds WHERE hi IS NOT NULL AND n <> hi - lo + 1
UNION ALL
SELECT 'journal_presence', CASE WHEN count(*) = 0 THEN 'ok' ELSE 'FAIL' END,
       count(*) || ' current rows without their journal entry'
  FROM missing
UNION ALL
SELECT 'journal_rebuild', CASE WHEN count(*) = 0 THEN 'ok' ELSE 'FAIL' END,
       CASE WHEN count(*) = 0 THEN format('%s datastores rebuilt from seq 1', (SELECT count(*) FROM complete))
            ELSE count(*) || ' field(s) differ, e.g. ' || min(id::text || '.' || key) END
  FROM mismatches
UNION ALL
SELECT 'rls_enabled', CASE WHEN count(*) = 0 THEN 'ok' ELSE 'FAIL' END,
       coalesce(string_agg(name, ', '), 'every tenant table')
  FROM unprotected;
