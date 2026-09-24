// Outbound webhooks (canonical plan §3, §7 "Webhooks", Phase 5), migration 0008.
//
// Two halves, on two database roles:
//
//   WebhookService (records_app)  management: list, create (the signing secret is returned once and
//                                 never again: the app role cannot SELECT it), enable/disable,
//                                 delete, queue a ping, list recent deliveries. Every operation
//                                 needs bindings.manage on the datastore (webhooks are
//                                 integrations; no new permission was added to the contracts), is
//                                 refused to connections and credentials, and is audited.
//
//   delivery state (records_publisher)
//                                 expandWebhookDeliveries: one pending row per (webhook, seq) from
//                                 the webhook's cursor up to the datastore clock (gapless, commit
//                                 ordered, so nothing is skipped); claimWebhookDeliveries: lease
//                                 pending rows (FOR UPDATE SKIP LOCKED); settleWebhookDelivery:
//                                 delivered / skipped / retry with backoff / dead, and the webhook's
//                                 failure counters, auto-disabling after sustained failure.
//
//   readWebhookChange (records_app, as the webhook's creator)
//                                 the journal entries for one seq, read with the creator's RLS after
//                                 re-checking their bindings.manage: a webhook never carries more
//                                 than its creator may read, and stops when they lose the right.
//
// The HTTP delivery itself (payload building, signing, SSRF-guarded fetch) lives in the Worker.

import {
  parseInput,
  RecordsError,
  UuidSchema,
  type CallerContext,
  type JournalEntry,
} from "@records/contracts";
import { z } from "zod";

import { contextOf, withContext, type Db, type Tx } from "../db/context.js";
import { authorize, requireWritable } from "./authorize.js";
import { audit } from "./journal.js";

// ---------------------------------------------------------------------------------------------
// Vocabulary

/** Events a webhook can subscribe to: `<entity>.<created|updated>` from journal entries. */
export const WEBHOOK_EVENTS = ["project.created", "project.updated", "issue.created", "issue.updated", "comment.created"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export const WEBHOOK_FORMATS = ["native", "jira"] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

export const WEBHOOK_LIMITS = {
  /** Webhooks per datastore. */
  perDatastore: 20,
  /** Deliveries created per webhook per expansion run; the next run continues. */
  expandPerWebhook: 500,
  /** Attempts before a delivery is dead-lettered. */
  maxAttempts: 10,
  /**
   * Lease on a claimed delivery; an unsettled one is claimed again after it. Long enough for one
   * webhook's share of a claim batch sent in order (25 × a 10 s timeout).
   */
  leaseSeconds: 300,
  /** Auto-disable: at least this many consecutive failures ... */
  disableAfterFailures: 50,
  /** ... spanning at least this long. */
  disableAfterHours: 24,
} as const;

/** The event a journal entry raises, or null when it raises none. */
export function webhookEventOf(entry: Pick<JournalEntry, "entityType" | "op">): WebhookEvent | null {
  const event = `${entry.entityType}.${entry.op === "create" ? "created" : "updated"}`;
  return (WEBHOOK_EVENTS as readonly string[]).includes(event) ? (event as WebhookEvent) : null;
}

export function matchesWebhook(entry: Pick<JournalEntry, "entityType" | "op">, events: readonly string[]): boolean {
  const event = webhookEventOf(entry);
  return event !== null && events.includes(event);
}

/** Retry backoff after `attempts` failed attempts: 30 s, 1 min, 2 min ... capped at 6 hours. */
export function webhookBackoffSeconds(attempts: number): number {
  return Math.min(6 * 3600, 30 * 2 ** Math.max(0, attempts - 1));
}

// ---------------------------------------------------------------------------------------------
// SSRF guard: the destination must be a public https origin. Checked at creation and again before
// every send. Hostnames are not resolved here (Workers cannot reach private networks anyway); IP
// literals in private, loopback, link-local, shared, documentation and multicast ranges and
// local-only names are refused. The URL parser normalises decimal/hex/octal IPv4 spellings first.

function ipv4Private(host: string): boolean | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function ipv6Hextets(host: string): number[] | null {
  if (!host.includes(":")) return null;
  const [head, tail, ...rest] = host.split("::");
  if (rest.length) return null;
  const parse = (s: string | undefined) => (s ? s.split(":").map((h) => parseInt(h, 16)) : []);
  const a = parse(head);
  const b = parse(tail);
  const fill = tail === undefined ? 0 : 8 - a.length - b.length;
  const all = [...a, ...Array<number>(Math.max(0, fill)).fill(0), ...b];
  return all.length === 8 && all.every((h) => Number.isInteger(h) && h >= 0 && h <= 0xffff) ? all : null;
}

function ipv6Private(h: number[]): boolean {
  const v4 = (hi: number, lo: number) => ipv4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`) === true;
  if (h.slice(0, 5).every((x) => x === 0)) return true; // ::, ::1, IPv4-compatible and IPv4-mapped
  if (h[0] === 0x64 && h[1] === 0xff9b) return v4(h[6]!, h[7]!); // NAT64 of a private address
  const first = h[0]!;
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xffc0) === 0xfec0 || // fec0::/10 site-local
    (first & 0xff00) === 0xff00 || // multicast
    (first === 0x2001 && h[1] === 0x0db8) // documentation
  );
}

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet", ".corp"];

/** Why `raw` may not be a webhook destination, or null when it may. */
export function webhookUrlProblem(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > 2000) return "The URL is too long.";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "That is not a valid URL.";
  }
  if (url.protocol !== "https:") return "Webhook URLs must use https.";
  if (url.username || url.password) return "Webhook URLs must not contain a user name or password.";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return "The URL has no host.";
  if (host.startsWith("[")) {
    const hextets = ipv6Hextets(host.slice(1, -1));
    if (!hextets || ipv6Private(hextets)) return "Webhook URLs must not point at a private, loopback or link-local address.";
    return null;
  }
  const v4 = ipv4Private(host);
  if (v4 === true) return "Webhook URLs must not point at a private, loopback or link-local address.";
  if (v4 === false) return null;
  if (host === "localhost" || !host.includes(".") || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return "Webhook URLs must use a public host name.";
  }
  return null;
}

export function requireWebhookUrl(raw: string): string {
  const problem = webhookUrlProblem(raw);
  if (problem) throw new RecordsError("validation_failed", problem, [{ path: "url", message: problem }]);
  return new URL(raw).toString();
}

// ---------------------------------------------------------------------------------------------
// Management DTOs

export type Webhook = {
  id: string;
  datastoreId: string;
  label: string;
  url: string;
  format: WebhookFormat;
  events: WebhookEvent[];
  status: "active" | "disabled";
  createdBy: string;
  createdAt: string;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  disabledAt: string | null;
  disabledReason: string | null;
};

/** The only time the signing secret is shown. */
export type CreatedWebhook = { webhook: Webhook; secret: string };

export type WebhookDelivery = {
  id: string;
  webhookId: string;
  kind: "change" | "ping";
  seq: number | null;
  state: "pending" | "delivered" | "skipped" | "dead";
  attempts: number;
  lastStatus: number | null;
  lastError: string | null;
  createdAt: string;
  nextAttemptAt: string | null;
  settledAt: string | null;
};

export const CreateWebhookInputSchema = z.strictObject({
  label: z.string().trim().min(1).max(120),
  url: z.string().trim().min(1).max(2000),
  format: z.enum(WEBHOOK_FORMATS).default("native"),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(16).optional(),
});
export type CreateWebhookInput = z.input<typeof CreateWebhookInputSchema>;

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v ? (v as Date).toISOString() : null);

const WEBHOOK_COLUMNS = (tx: Tx) => tx`
  SELECT id, datastore_id, label, url, format, events, status, created_by, created_at, consecutive_failures,
         last_success_at, last_failure_at, last_error, disabled_at, disabled_reason
    FROM records.webhooks`;

function toWebhook(r: Row): Webhook {
  return {
    id: r.id as string,
    datastoreId: r.datastore_id as string,
    label: r.label as string,
    url: r.url as string,
    format: r.format as WebhookFormat,
    events: r.events as WebhookEvent[],
    status: r.status as Webhook["status"],
    createdBy: r.created_by as string,
    createdAt: iso(r.created_at)!,
    consecutiveFailures: r.consecutive_failures as number,
    lastSuccessAt: iso(r.last_success_at),
    lastFailureAt: iso(r.last_failure_at),
    lastError: (r.last_error as string | null) ?? null,
    disabledAt: iso(r.disabled_at),
    disabledReason: (r.disabled_reason as string | null) ?? null,
  };
}

function toDelivery(r: Row): WebhookDelivery {
  return {
    id: r.id as string,
    webhookId: r.webhook_id as string,
    kind: r.kind as WebhookDelivery["kind"],
    seq: r.seq == null ? null : Number(r.seq),
    state: r.state as WebhookDelivery["state"],
    attempts: r.attempts as number,
    lastStatus: (r.last_status as number | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
    createdAt: iso(r.created_at)!,
    nextAttemptAt: r.state === "pending" ? iso(r.available_at) : null,
    settledAt: iso(r.settled_at),
  };
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Audit detail names the destination host only: paths and queries may carry receiver tokens. */
const hostOf = (url: string) => new URL(url).host;

function refuseConnections(caller: CallerContext): void {
  if (caller.bindingId || caller.scopes) throw new RecordsError("forbidden", "Connections and credentials cannot manage webhooks.");
}

export class WebhookService {
  constructor(private readonly db: Db) {}

  async listWebhooks(caller: CallerContext, datastoreId: string): Promise<Webhook[]> {
    return withContext(this.db, contextOf(caller, datastoreId), async (tx) => {
      await authorize(tx, caller, datastoreId, "listBindings");
      const rows = await tx`${WEBHOOK_COLUMNS(tx)} WHERE datastore_id = ${datastoreId} ORDER BY created_at DESC LIMIT 100`;
      return rows.map(toWebhook);
    });
  }

  async createWebhook(caller: CallerContext, datastoreId: string, raw: unknown): Promise<CreatedWebhook> {
    const input = parseInput(CreateWebhookInputSchema, raw);
    const url = requireWebhookUrl(input.url);
    const events = [...new Set(input.events ?? (input.format === "jira" ? ["issue.created", "issue.updated", "comment.created"] : WEBHOOK_EVENTS))];
    return withContext(this.db, contextOf(caller, datastoreId), async (tx) => {
      refuseConnections(caller);
      const access = await authorize(tx, caller, datastoreId, "createBinding", { lock: true });
      requireWritable(access);
      const [count] = await tx`SELECT count(*)::int AS n FROM records.webhooks WHERE datastore_id = ${datastoreId}`;
      if ((count!.n as number) >= WEBHOOK_LIMITS.perDatastore) {
        throw new RecordsError("validation_failed", `A datastore can have at most ${WEBHOOK_LIMITS.perDatastore} webhooks.`);
      }
      const [clock] = await tx`SELECT seq FROM records.datastore_clock WHERE datastore_id = ${datastoreId}`;
      const id = crypto.randomUUID();
      const secret = `whsec_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
      await tx`
        INSERT INTO records.webhooks (org_id, datastore_id, id, label, url, format, events, secret, cursor_seq, created_by)
        VALUES (${caller.orgId}, ${datastoreId}, ${id}, ${input.label}, ${url}, ${input.format}, ${events}, ${secret},
                ${clock ? Number(clock.seq) : 0}, ${caller.principalId})`;
      await audit(tx, caller, {
        datastoreId, operation: "createWebhook", targetType: "webhook", targetId: id, summary: `Added webhook ${input.label}`,
        detail: { host: hostOf(url), format: input.format, events },
      });
      const [row] = await tx`${WEBHOOK_COLUMNS(tx)} WHERE id = ${id}`;
      return { webhook: toWebhook(row!), secret };
    });
  }

  /** Re-enable a disabled webhook (its backlog is then delivered) or disable an active one. */
  async setWebhookEnabled(caller: CallerContext, datastoreId: string, webhookId: string, enabled: boolean): Promise<Webhook> {
    parseInput(UuidSchema, webhookId);
    return withContext(this.db, contextOf(caller, datastoreId), async (tx) => {
      refuseConnections(caller);
      await authorize(tx, caller, datastoreId, "createBinding", { lock: true });
      const [row] = enabled
        ? await tx`
            UPDATE records.webhooks SET status = 'active', disabled_at = NULL, disabled_reason = NULL,
                   consecutive_failures = 0, failing_since = NULL
             WHERE id = ${webhookId} AND datastore_id = ${datastoreId} RETURNING id, label`
        : await tx`
            UPDATE records.webhooks SET status = 'disabled', disabled_at = coalesce(disabled_at, now()),
                   disabled_reason = coalesce(disabled_reason, 'Disabled by a manager.')
             WHERE id = ${webhookId} AND datastore_id = ${datastoreId} RETURNING id, label`;
      if (!row) throw new RecordsError("not_found", "Unknown webhook.");
      await audit(tx, caller, {
        datastoreId, operation: enabled ? "enableWebhook" : "disableWebhook", targetType: "webhook", targetId: webhookId,
        summary: `${enabled ? "Enabled" : "Disabled"} webhook ${row.label as string}`,
      });
      const [after] = await tx`${WEBHOOK_COLUMNS(tx)} WHERE id = ${webhookId}`;
      return toWebhook(after!);
    });
  }

  async deleteWebhook(caller: CallerContext, datastoreId: string, webhookId: string): Promise<void> {
    parseInput(UuidSchema, webhookId);
    return withContext(this.db, contextOf(caller, datastoreId), async (tx) => {
      refuseConnections(caller);
      await authorize(tx, caller, datastoreId, "revokeBinding", { lock: true });
      const [row] = await tx`DELETE FROM records.webhooks WHERE id = ${webhookId} AND datastore_id = ${datastoreId} RETURNING label, url`;
      if (!row) throw new RecordsError("not_found", "Unknown webhook.");
      await audit(tx, caller, {
        datastoreId, operation: "deleteWebhook", targetType: "webhook", targetId: webhookId, summary: `Deleted webhook ${row.label as string}`,
        detail: { host: hostOf(row.url as string) },
      });
    });
  }

  /** Queue a signed ping; the deliverer sends it on its next run. Returns the delivery. */
  async pingWebhook(caller: CallerContext, datastoreId: string, webhookId: string): Promise<WebhookDelivery> {
    parseInput(UuidSchema, webhookId);
    return withContext(this.db, contextOf(caller, datastoreId), async (tx) => {
      refuseConnections(caller);
      await authorize(tx, caller, datastoreId, "createBinding");
      const [hook] = await tx`SELECT label, status FROM records.webhooks WHERE id = ${webhookId} AND datastore_id = ${datastoreId}`;
      if (!hook) throw new RecordsError("not_found", "Unknown webhook.");
      if (hook.status !== "active") throw new RecordsError("validation_failed", "Enable the webhook before testing it.");
      const id = crypto.randomUUID();
      await tx`
        INSERT INTO records.webhook_deliveries (org_id, datastore_id, id, webhook_id, kind, created_by)
        VALUES (${caller.orgId}, ${datastoreId}, ${id}, ${webhookId}, 'ping', ${caller.principalId})`;
      await audit(tx, caller, { datastoreId, operation: "pingWebhook", targetType: "webhook", targetId: webhookId, summary: `Tested webhook ${hook.label as string}` });
      const [row] = await tx`SELECT * FROM records.webhook_deliveries WHERE id = ${id}`;
      return toDelivery(row!);
    });
  }

  async listDeliveries(caller: CallerContext, datastoreId: string, webhookId: string): Promise<WebhookDelivery[]> {
    parseInput(UuidSchema, webhookId);
    return withContext(this.db, contextOf(caller, datastoreId), async (tx) => {
      await authorize(tx, caller, datastoreId, "listBindings");
      const rows = await tx`
        SELECT * FROM records.webhook_deliveries WHERE webhook_id = ${webhookId} AND datastore_id = ${datastoreId}
         ORDER BY created_at DESC, seq DESC NULLS LAST LIMIT 50`;
      return rows.map(toDelivery);
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Delivery state (records_publisher)

export type ClaimedDelivery = {
  id: string;
  orgId: string;
  datastoreId: string;
  webhookId: string;
  kind: "change" | "ping";
  seq: number | null;
  /** Including this one. */
  attempts: number;
  webhook: { label: string; url: string; format: WebhookFormat; events: WebhookEvent[]; secret: string; createdBy: string };
};

export type DeliveryResult =
  | { outcome: "delivered"; status: number }
  | { outcome: "skipped" }
  | { outcome: "failed"; status?: number; error: string }
  /** The delivery can never succeed (creator lost access, URL no longer allowed): dead, and disable. */
  | { outcome: "abandoned"; error: string };

type Scope = { datastoreIds?: readonly string[] };

/**
 * Create pending deliveries for each active webhook from its cursor up to the datastore's clock
 * head (at most `perWebhook` per run), and advance the cursors. Returns how many were created.
 */
export async function expandWebhookDeliveries(db: Db, opts: Scope & { perWebhook?: number } = {}): Promise<number> {
  const per = opts.perWebhook ?? WEBHOOK_LIMITS.expandPerWebhook;
  const only = opts.datastoreIds ? db`AND w.datastore_id = ANY(${[...opts.datastoreIds]}::uuid[])` : db``;
  const [row] = await db`
    WITH targets AS (
      SELECT w.id, w.org_id, w.datastore_id, w.cursor_seq, least(c.seq, w.cursor_seq + ${per}) AS upto
        FROM records.webhooks w JOIN records.datastore_clock c ON c.datastore_id = w.datastore_id
       WHERE w.status = 'active' AND c.seq > w.cursor_seq ${only}
       FOR UPDATE OF w SKIP LOCKED
    ), created AS (
      INSERT INTO records.webhook_deliveries (org_id, datastore_id, id, webhook_id, kind, seq)
      SELECT t.org_id, t.datastore_id, gen_random_uuid(), t.id, 'change', s
        FROM targets t, generate_series(t.cursor_seq + 1, t.upto) AS s
      ON CONFLICT (webhook_id, seq) WHERE kind = 'change' DO NOTHING
      RETURNING 1
    ), advanced AS (
      UPDATE records.webhooks w SET cursor_seq = t.upto FROM targets t WHERE w.id = t.id RETURNING 1
    )
    SELECT (SELECT count(*) FROM created)::int AS created, (SELECT count(*) FROM advanced)::int AS advanced`;
  return Number(row?.created ?? 0);
}

/** Lease up to `batch` due deliveries of active webhooks. */
export async function claimWebhookDeliveries(
  db: Db,
  opts: Scope & { batch?: number; leaseSeconds?: number } = {},
): Promise<{ owner: string; deliveries: ClaimedDelivery[] }> {
  const owner = crypto.randomUUID();
  const only = opts.datastoreIds ? db`AND d.datastore_id = ANY(${[...opts.datastoreIds]}::uuid[])` : db``;
  const rows = await db`
    WITH picked AS (
      SELECT d.id FROM records.webhook_deliveries d JOIN records.webhooks w ON w.id = d.webhook_id
       WHERE d.state = 'pending' AND d.available_at <= now() AND (d.lease_until IS NULL OR d.lease_until < now())
         AND w.status = 'active' ${only}
       ORDER BY d.available_at, d.seq NULLS FIRST
       LIMIT ${opts.batch ?? 25}
       FOR UPDATE OF d SKIP LOCKED
    )
    UPDATE records.webhook_deliveries d
       SET lease_owner = ${owner}, lease_until = now() + make_interval(secs => ${opts.leaseSeconds ?? WEBHOOK_LIMITS.leaseSeconds}),
           attempts = d.attempts + 1
      FROM picked, records.webhooks w
     WHERE d.id = picked.id AND w.id = d.webhook_id
    RETURNING d.id, d.org_id, d.datastore_id, d.webhook_id, d.kind, d.seq, d.attempts,
              w.label, w.url, w.format, w.events, w.secret, w.created_by`;
  return {
    owner,
    deliveries: rows.map((r) => ({
      id: r.id as string,
      orgId: r.org_id as string,
      datastoreId: r.datastore_id as string,
      webhookId: r.webhook_id as string,
      kind: r.kind as ClaimedDelivery["kind"],
      seq: r.seq == null ? null : Number(r.seq),
      attempts: r.attempts as number,
      webhook: {
        label: r.label as string,
        url: r.url as string,
        format: r.format as WebhookFormat,
        events: r.events as WebhookEvent[],
        secret: r.secret as string,
        createdBy: r.created_by as string,
      },
    })),
  };
}

/**
 * Record the result of one attempt, if this publisher still holds the lease. Returns false when the
 * lease was lost (another publisher will settle it). Failures back off and are dead-lettered after
 * `maxAttempts`; a webhook failing for `disableAfterFailures` attempts across `disableAfterHours`
 * is disabled.
 */
export async function settleWebhookDelivery(
  db: Db,
  owner: string,
  delivery: Pick<ClaimedDelivery, "id" | "webhookId" | "attempts">,
  result: DeliveryResult,
  opts: { maxAttempts?: number; disableAfterFailures?: number; disableAfterHours?: number } = {},
): Promise<boolean> {
  const maxAttempts = opts.maxAttempts ?? WEBHOOK_LIMITS.maxAttempts;
  const failures = opts.disableAfterFailures ?? WEBHOOK_LIMITS.disableAfterFailures;
  const hours = opts.disableAfterHours ?? WEBHOOK_LIMITS.disableAfterHours;
  const error = "error" in result ? result.error.slice(0, 500) : null;
  const status = "status" in result && result.status !== undefined ? result.status : null;
  return (await db.begin(async (tx) => {
    const lease = tx`id = ${delivery.id} AND lease_owner = ${owner} AND state = 'pending'`;
    const settled = (state: string) => tx`
      UPDATE records.webhook_deliveries SET state = ${state}, settled_at = now(), lease_owner = NULL, lease_until = NULL,
             last_status = ${status}, last_error = ${error}
       WHERE ${lease}`;
    let changed;
    switch (result.outcome) {
      case "delivered":
        changed = await settled("delivered");
        if (changed.count) {
          await tx`UPDATE records.webhooks SET consecutive_failures = 0, failing_since = NULL, last_success_at = now(), last_error = NULL
                    WHERE id = ${delivery.webhookId}`;
        }
        return changed.count > 0;
      case "skipped":
        return (await settled("skipped")).count > 0;
      case "abandoned":
        changed = await settled("dead");
        if (changed.count) {
          await tx`UPDATE records.webhooks SET status = 'disabled', disabled_at = now(), disabled_reason = ${error},
                          last_failure_at = now(), last_error = ${error}
                    WHERE id = ${delivery.webhookId} AND status = 'active'`;
        }
        return changed.count > 0;
      case "failed": {
        changed = delivery.attempts >= maxAttempts
          ? await settled("dead")
          : await tx`
              UPDATE records.webhook_deliveries SET lease_owner = NULL, lease_until = NULL, last_status = ${status}, last_error = ${error},
                     available_at = now() + make_interval(secs => ${webhookBackoffSeconds(delivery.attempts)})
               WHERE ${lease}`;
        if (!changed.count) return false;
        await tx`
          UPDATE records.webhooks
             SET consecutive_failures = consecutive_failures + 1, failing_since = coalesce(failing_since, now()),
                 last_failure_at = now(), last_error = ${error}
           WHERE id = ${delivery.webhookId}`;
        await tx`
          UPDATE records.webhooks
             SET status = 'disabled', disabled_at = now(),
                 disabled_reason = ${`Disabled after ${failures} or more consecutive failed deliveries over ${hours} hours.`}
           WHERE id = ${delivery.webhookId} AND status = 'active' AND consecutive_failures >= ${failures}
             AND failing_since <= now() - make_interval(hours => ${hours})`;
        return true;
      }
    }
  })) as boolean;
}

/** Delete settled deliveries: delivered and skipped after `days`, dead after `deadDays`. */
export async function pruneWebhookDeliveries(db: Db, days = 7, deadDays = 30): Promise<number> {
  const result = await db`
    DELETE FROM records.webhook_deliveries
     WHERE (state IN ('delivered', 'skipped') AND settled_at < now() - make_interval(days => ${days}))
        OR (state = 'dead' AND settled_at < now() - make_interval(days => ${deadDays}))`;
  return result.count;
}

/** Pending and dead delivery counts, for the tick log. */
export async function webhookLag(db: Db): Promise<{ pending: number; oldestSeconds: number; dead: number; disabled: number }> {
  const [row] = await db`
    SELECT count(*) FILTER (WHERE state = 'pending')::int AS pending,
           coalesce(extract(epoch FROM now() - min(created_at) FILTER (WHERE state = 'pending')), 0)::float AS oldest,
           count(*) FILTER (WHERE state = 'dead')::int AS dead,
           (SELECT count(*) FROM records.webhooks WHERE status = 'disabled')::int AS disabled
      FROM records.webhook_deliveries WHERE state IN ('pending', 'dead')`;
  return { pending: row!.pending as number, oldestSeconds: row!.oldest as number, dead: row!.dead as number, disabled: row!.disabled as number };
}

// ---------------------------------------------------------------------------------------------
// Reading a change as the webhook's creator (records_app)

/** The caller a webhook's reads run as: its creator, acting directly, via the system. */
export function webhookCaller(delivery: Pick<ClaimedDelivery, "orgId" | "webhook">): CallerContext {
  return { orgId: delivery.orgId, principalId: delivery.webhook.createdBy, via: "system" };
}

function toEntry(r: Row): JournalEntry {
  return {
    seq: Number(r.seq),
    ordinal: Number(r.ordinal),
    changeId: r.change_id as string,
    command: r.command as string,
    entityType: r.entity_type as JournalEntry["entityType"],
    entityId: r.entity_id as string,
    entityRev: r.entity_rev as number,
    op: r.op as JournalEntry["op"],
    after: r.after as Record<string, unknown>,
    before: (r.before as Record<string, unknown> | null) ?? null,
    actorId: r.actor_id as string,
    actId: (r.act_id as string | null) ?? null,
    via: r.via as JournalEntry["via"],
    occurredAt: (r.occurred_at as Date).toISOString(),
  };
}

/**
 * The journal entries of one seq, read as the webhook's creator after re-checking that they still
 * hold bindings.manage on the datastore. `lost` when they no longer may (the webhook must stop).
 */
export async function readWebhookChange(
  db: Db,
  delivery: Pick<ClaimedDelivery, "orgId" | "datastoreId" | "webhook">,
  seq: number,
): Promise<{ entries: JournalEntry[] } | { lost: string }> {
  const caller = webhookCaller(delivery);
  try {
    return await withContext(db, contextOf(caller, delivery.datastoreId), async (tx) => {
      await authorize(tx, caller, delivery.datastoreId, "listBindings");
      const rows = await tx`
        SELECT seq, ordinal, change_id, command, entity_type, entity_id, entity_rev, op, after, before, actor_id, act_id, via, occurred_at
          FROM records.journal WHERE datastore_id = ${delivery.datastoreId} AND seq = ${seq} ORDER BY ordinal`;
      return { entries: rows.map(toEntry) };
    }, 3, { readOnly: true });
  } catch (err) {
    if (err instanceof RecordsError && (err.code === "not_found" || err.code === "forbidden")) {
      return { lost: "The person who created this webhook no longer manages integrations on this datastore." };
    }
    throw err;
  }
}
