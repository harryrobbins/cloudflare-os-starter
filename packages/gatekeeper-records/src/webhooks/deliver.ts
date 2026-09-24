// Outbound webhook delivery (canonical plan §3, §7 "Webhooks", §9 "The Queue remains for webhooks").
//
// Triggered from the outbox: the Queue consumer calls deliverWebhooks for the datastores in each
// batch of change events, and the one-minute cron runs it for every datastore as the backstop.
// Each run:
//   1. expand   (publisher role) one pending delivery per (active webhook, new seq), from each
//               webhook's cursor to the datastore clock;
//   2. claim    (publisher role) lease due deliveries, with their webhook's URL and secret;
//   3. build    (app role, as the webhook's creator) read the seq's journal entries after
//               re-checking the creator's bindings.manage, filter by the webhook's events, and build
//               the native body or the Jira-shaped bodies;
//   4. send     SSRF-guarded POST: https only, the URL re-validated before every send, redirects
//               never followed (a 3xx is a failure), a hard timeout, the response body discarded;
//   5. settle   (publisher role) delivered / skipped / retry with backoff / dead after N attempts;
//               sustained failure disables the webhook, and a creator who lost access disables it
//               at once.
//
// Order: each webhook's claimed deliveries are sent one at a time in seq order (webhooks run in
// parallel), so a healthy receiver sees changes in commit order. A retry can reorder; payloads carry
// `seq` (native) or `changelog.id` / `timestamp` (Jira) for receivers that must reorder.
//
// At-least-once: a crash between send and settle re-sends after the lease expires; receivers
// de-duplicate on X-Records-Delivery. Payloads and secrets never reach logs: log lines carry IDs,
// statuses and outcomes only.

import {
  claimWebhookDeliveries,
  expandWebhookDeliveries,
  readWebhookChange,
  settleWebhookDelivery,
  webhookCaller,
  webhookUrlProblem,
  type ClaimedDelivery,
  type Db,
  type DeliveryResult,
  type RecordsService,
} from "@records/core";
import { signWebhook } from "@records/jira";

import { changeRequests, pingBody, type OutboundRequest } from "./payloads.js";
import { signRecordsWebhook } from "./sign.js";

export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_USER_AGENT = "Records-Webhooks/1";

export type WebhookDeps = {
  /** records_publisher: delivery state and signing secrets. */
  publisher: Db;
  /** records_app: journal and record reads, as each webhook's creator. */
  service: RecordsService;
  /** PUBLIC_BASE_URL, for `self` links in Jira payloads. */
  publicBaseUrl: string;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
};

export type WebhookRunOptions = {
  datastoreIds?: readonly string[];
  /** Claim rounds per run (each up to `batch` deliveries). */
  rounds?: number;
  batch?: number;
  concurrency?: number;
  maxAttempts?: number;
};

export type WebhookRunResult = { expanded: number; claimed: number; delivered: number; skipped: number; failed: number; abandoned: number };

type SendResult = { ok: true; status: number } | { ok: false; status?: number; error: string };

/** POST one signed request. Never follows redirects; never reads the response body. */
export async function sendWebhook(
  deps: Pick<WebhookDeps, "fetch" | "now" | "timeoutMs">,
  delivery: Pick<ClaimedDelivery, "id" | "webhook">,
  request: OutboundRequest,
  index = 0,
): Promise<SendResult> {
  const problem = webhookUrlProblem(delivery.webhook.url);
  if (problem) return { ok: false, error: problem };
  const timestamp = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "user-agent": WEBHOOK_USER_AGENT,
    "x-records-delivery": delivery.id,
    "x-records-event": request.event,
    "x-records-timestamp": String(timestamp),
    "x-records-signature": await signRecordsWebhook(delivery.webhook.secret, timestamp, request.body),
  };
  if (delivery.webhook.format === "jira") {
    headers["x-hub-signature"] = await signWebhook(delivery.webhook.secret, request.body);
    headers["x-atlassian-webhook-identifier"] = `${delivery.id}.${index}`;
  }
  const doFetch = deps.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(delivery.webhook.url, {
      method: "POST",
      headers,
      body: request.body,
      redirect: "manual",
      signal: AbortSignal.timeout(deps.timeoutMs ?? WEBHOOK_TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    return { ok: false, error: name === "TimeoutError" || name === "AbortError" ? "The receiver did not answer in time." : "The receiver could not be reached." };
  }
  try {
    await response.body?.cancel();
  } catch {
    // already consumed
  }
  if (response.status >= 200 && response.status < 300) return { ok: true, status: response.status };
  if (response.status >= 300 && response.status < 400) return { ok: false, status: response.status, error: `Redirect (${response.status}) not followed.` };
  return { ok: false, status: response.status, error: `The receiver answered ${response.status}.` };
}

/** Build, send and classify one claimed delivery. */
export async function attemptDelivery(deps: WebhookDeps, delivery: ClaimedDelivery): Promise<DeliveryResult> {
  const problem = webhookUrlProblem(delivery.webhook.url);
  if (problem) return { outcome: "abandoned", error: problem };
  let requests: OutboundRequest[];
  if (delivery.kind === "ping") {
    requests = [{ event: "ping", body: pingBody(delivery, deps.now?.() ?? new Date()) }];
  } else {
    const seq = delivery.seq!;
    const change = await readWebhookChange(deps.service.db, delivery, seq);
    if ("lost" in change) return { outcome: "abandoned", error: change.lost };
    requests = await changeRequests(deps.service, delivery, seq, change.entries, deps.publicBaseUrl, webhookCaller(delivery));
    if (requests.length === 0) return { outcome: "skipped" };
  }
  let status = 0;
  for (const [i, request] of requests.entries()) {
    const sent = await sendWebhook(deps, delivery, request, i);
    if (!sent.ok) return { outcome: "failed", ...(sent.status !== undefined ? { status: sent.status } : {}), error: sent.error };
    status = sent.status;
  }
  return { outcome: "delivered", status };
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

async function deliverOne(deps: WebhookDeps, owner: string, delivery: ClaimedDelivery, opts: WebhookRunOptions, result: WebhookRunResult) {
  let outcome: DeliveryResult;
  try {
    outcome = await attemptDelivery(deps, delivery);
  } catch {
    // A database or build error: retry later like a failed send. The error text is not logged or
    // stored (it could quote record content); the delivery keeps a generic reason.
    outcome = { outcome: "failed", error: "The delivery could not be prepared." };
  }
  await settleWebhookDelivery(deps.publisher, owner, delivery, outcome, opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {});
  result[outcome.outcome]++;
  if (outcome.outcome !== "delivered" && outcome.outcome !== "skipped") {
    console.warn(JSON.stringify({
      event: "records.webhook.attempt_failed", webhookId: delivery.webhookId, deliveryId: delivery.id, kind: delivery.kind,
      attempts: delivery.attempts, outcome: outcome.outcome, status: "status" in outcome ? outcome.status ?? null : null,
    }));
  }
}

export async function deliverWebhooks(deps: WebhookDeps, opts: WebhookRunOptions = {}): Promise<WebhookRunResult> {
  const scope = opts.datastoreIds ? { datastoreIds: opts.datastoreIds } : {};
  const result: WebhookRunResult = { expanded: 0, claimed: 0, delivered: 0, skipped: 0, failed: 0, abandoned: 0 };
  result.expanded = await expandWebhookDeliveries(deps.publisher, scope);
  const batch = opts.batch ?? 25;
  for (let round = 0; round < (opts.rounds ?? 4); round++) {
    const { owner, deliveries } = await claimWebhookDeliveries(deps.publisher, { ...scope, batch });
    result.claimed += deliveries.length;
    // Webhooks in parallel; each webhook's deliveries in seq order (pings first), one at a time.
    const byWebhook = new Map<string, ClaimedDelivery[]>();
    for (const d of deliveries) byWebhook.set(d.webhookId, [...(byWebhook.get(d.webhookId) ?? []), d]);
    const lanes = [...byWebhook.values()].map((lane) => lane.toSorted((a, b) => (a.seq ?? 0) - (b.seq ?? 0)));
    await pool(lanes, opts.concurrency ?? 4, async (lane) => {
      for (const delivery of lane) await deliverOne(deps, owner, delivery, opts, result);
    });
    if (deliveries.length < batch) break;
  }
  return result;
}
