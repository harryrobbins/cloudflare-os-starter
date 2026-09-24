-- Outbound webhooks (canonical plan §3 "The outbox stays for outbound delivery", §7 "Webhooks",
-- Phase 5 "Jira-shaped webhooks from the outbox").
--
-- Design:
--   * records.webhooks          one subscription on one datastore: an https URL, a payload format
--                               ('native' or 'jira'), an event filter, and the signing secret.
--                               `cursor_seq` is the journal seq up to which the webhook's
--                               deliveries have been created; it starts at the clock head when the
--                               webhook is created, so a webhook hears only later changes.
--   * records.webhook_deliveries one row per (webhook, seq), or a 'ping'. The publisher expands the
--                               clock (seq is gapless and in commit order, so a cursor never skips a
--                               change), then claims pending rows with a lease, delivers them and
--                               settles them: delivered, skipped (nothing matched the filter), or
--                               retried with backoff and dead after N attempts. At-least-once.
--                               The outbox → Queue path triggers delivery; the cron is the backstop.
--
-- The payload itself is never stored: the deliverer reads the journal entries for the seq at send
-- time, as the webhook's creator (their RLS, their bindings.manage re-checked), so a webhook can
-- never carry more than its creator may read, and stops when they lose the right.
--
-- The signing secret. HMAC needs the secret itself, so unlike credentials it cannot be stored as a
-- digest. Encrypting it at rest (envelope key in a Worker secret) is out of scope for now. The
-- trade-off is contained by privileges instead: the app role may INSERT a secret (at creation) but
-- has no SELECT on the column, so no management read, listing or export can return it; only the
-- publisher role reads it, to sign. A database dump or the migration owner still sees it in clear:
-- rotate (delete and recreate) a webhook if the database is ever exposed.

CREATE TABLE records.webhooks (
  org_id                uuid NOT NULL,
  datastore_id          uuid NOT NULL,
  id                    uuid NOT NULL PRIMARY KEY,
  label                 text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  url                   text NOT NULL CHECK (url ~ '^https://[^/?#@\s]+' AND length(url) <= 2000),
  format                text NOT NULL CHECK (format IN ('native', 'jira')),
  events                text[] NOT NULL CHECK (cardinality(events) BETWEEN 1 AND 16),
  secret                text NOT NULL CHECK (length(secret) BETWEEN 32 AND 200),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  cursor_seq            bigint NOT NULL DEFAULT 0 CHECK (cursor_seq >= 0),
  consecutive_failures  int NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  failing_since         timestamptz,
  last_success_at       timestamptz,
  last_failure_at       timestamptz,
  last_error            text CHECK (last_error IS NULL OR length(last_error) <= 500),
  disabled_at           timestamptz,
  disabled_reason       text CHECK (disabled_reason IS NULL OR length(disabled_reason) <= 300),
  created_by            uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, datastore_id, id),
  FOREIGN KEY (org_id, datastore_id) REFERENCES records.datastores(org_id, id),
  FOREIGN KEY (org_id, created_by) REFERENCES records.principals(org_id, id),
  CHECK ((status = 'disabled') = (disabled_at IS NOT NULL))
);
CREATE INDEX webhooks_datastore ON records.webhooks (org_id, datastore_id, created_at DESC);
CREATE INDEX webhooks_active ON records.webhooks (datastore_id) WHERE status = 'active';

CREATE TABLE records.webhook_deliveries (
  org_id        uuid NOT NULL,
  datastore_id  uuid NOT NULL,
  id            uuid NOT NULL PRIMARY KEY,
  webhook_id    uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('change', 'ping')),
  seq           bigint CHECK (seq >= 1),
  state         text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'skipped', 'dead')),
  attempts      int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at  timestamptz NOT NULL DEFAULT now(),
  lease_owner   uuid,
  lease_until   timestamptz,
  last_status   int,
  last_error    text CHECK (last_error IS NULL OR length(last_error) <= 500),
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz,
  FOREIGN KEY (org_id, datastore_id, webhook_id) REFERENCES records.webhooks(org_id, datastore_id, id) ON DELETE CASCADE,
  CHECK ((kind = 'change') = (seq IS NOT NULL))
);
CREATE UNIQUE INDEX webhook_deliveries_seq ON records.webhook_deliveries (webhook_id, seq) WHERE kind = 'change';
CREATE INDEX webhook_deliveries_pending ON records.webhook_deliveries (available_at) WHERE state = 'pending';
CREATE INDEX webhook_deliveries_recent ON records.webhook_deliveries (webhook_id, created_at DESC);
CREATE INDEX webhook_deliveries_settled ON records.webhook_deliveries (settled_at) WHERE state <> 'pending';

CREATE TRIGGER webhooks_tenant BEFORE UPDATE ON records.webhooks
  FOR EACH ROW EXECUTE FUNCTION records.forbid_tenant_key_change();
CREATE TRIGGER webhook_deliveries_tenant BEFORE UPDATE ON records.webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION records.forbid_tenant_key_change();

-- ---------------------------------------------------------------------------------------------
-- Row-level security. For the app role: the tenant rule as a RESTRICTIVE policy, and management
-- only by a principal holding bindings.manage (webhooks are integrations, like bindings and
-- credentials) on the datastore in context. The app role may queue a ping, never a change.

ALTER TABLE records.webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE records.webhook_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant ON records.webhooks AS RESTRICTIVE TO records_app
  USING (org_id = records.current_org() AND datastore_id = records.current_datastore())
  WITH CHECK (org_id = records.current_org() AND datastore_id = records.current_datastore());
CREATE POLICY member_manage ON records.webhooks TO records_app
  USING ((SELECT records.can(records.current_datastore(), 'bindings.manage')))
  WITH CHECK ((SELECT records.can(records.current_datastore(), 'bindings.manage')));

CREATE POLICY tenant ON records.webhook_deliveries AS RESTRICTIVE TO records_app
  USING (org_id = records.current_org() AND datastore_id = records.current_datastore())
  WITH CHECK (org_id = records.current_org() AND datastore_id = records.current_datastore());
CREATE POLICY member_read ON records.webhook_deliveries FOR SELECT TO records_app
  USING ((SELECT records.can(records.current_datastore(), 'bindings.manage')));
CREATE POLICY member_ping ON records.webhook_deliveries FOR INSERT TO records_app
  WITH CHECK (kind = 'ping' AND state = 'pending' AND attempts = 0
              AND (SELECT records.can(records.current_datastore(), 'bindings.manage')));

-- The publisher is cross-tenant by nature, but only for delivery state (as for the outbox).
CREATE POLICY publisher_deliver ON records.webhooks FOR SELECT TO records_publisher USING (true);
CREATE POLICY publisher_settle ON records.webhooks FOR UPDATE TO records_publisher USING (true) WITH CHECK (true);
CREATE POLICY publisher_all ON records.webhook_deliveries TO records_publisher USING (true) WITH CHECK (true);
-- The clock head (not record content) tells the publisher how far to expand each webhook.
CREATE POLICY publisher_head ON records.datastore_clock FOR SELECT TO records_publisher USING (true);

-- ---------------------------------------------------------------------------------------------
-- Privileges. The app role never holds SELECT on `secret`.

GRANT SELECT (org_id, datastore_id, id, label, url, format, events, status, cursor_seq, consecutive_failures, failing_since,
              last_success_at, last_failure_at, last_error, disabled_at, disabled_reason, created_by, created_at)
  ON records.webhooks TO records_app;
GRANT INSERT (org_id, datastore_id, id, label, url, format, events, secret, cursor_seq, created_by)
  ON records.webhooks TO records_app;
GRANT UPDATE (status, disabled_at, disabled_reason, cursor_seq, consecutive_failures, failing_since, last_error)
  ON records.webhooks TO records_app;
GRANT DELETE ON records.webhooks TO records_app;
GRANT SELECT ON records.webhook_deliveries TO records_app;
GRANT INSERT (org_id, datastore_id, id, webhook_id, kind, created_by) ON records.webhook_deliveries TO records_app;

GRANT SELECT ON records.webhooks TO records_publisher;
GRANT UPDATE (status, cursor_seq, consecutive_failures, failing_since, last_success_at, last_failure_at, last_error,
              disabled_at, disabled_reason)
  ON records.webhooks TO records_publisher;
GRANT SELECT, INSERT, DELETE ON records.webhook_deliveries TO records_publisher;
GRANT UPDATE (state, attempts, available_at, lease_owner, lease_until, last_status, last_error, settled_at)
  ON records.webhook_deliveries TO records_publisher;
GRANT SELECT (org_id, datastore_id, seq) ON records.datastore_clock TO records_publisher;
