-- Jira-compatible surface (canonical plan §7, Phase 5).
--
-- 1. Custom field definitions get a numeric Jira id: the <n> in `customfield_<n>`. An identity
--    column, as for the other jira_id columns (0003): assigned once per definition, never reused
--    (a sequence does not hand a value out twice, even after a delete or a rollback), and not
--    choosable by the app role. It starts at 10000, Jira's own convention for custom fields, so a
--    client configuration that names `customfield_10003` keeps working.
--
-- 2. An index for the issue search's default order, `created desc` with the ID as tiebreaker.
--    The search compares instants at millisecond precision (the precision of the DTOs, which the
--    reference semantics in @records/contracts compare), so it orders by the timestamp truncated
--    to milliseconds in UTC. The expression is immutable (explicit zone), so it can be indexed,
--    and the keyset condition `(expr, id) < ($1, $2)` walks this index.

ALTER TABLE projects.custom_fields
  ADD COLUMN jira_id bigint GENERATED ALWAYS AS IDENTITY (START WITH 10000) UNIQUE;

CREATE INDEX issues_created_ms ON projects.issues
  (datastore_id, (date_trunc('milliseconds', created_at AT TIME ZONE 'UTC')) DESC, id);
