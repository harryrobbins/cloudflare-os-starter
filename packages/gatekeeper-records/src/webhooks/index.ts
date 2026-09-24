// Worker entry for outbound webhooks: open the two database clients, run one delivery pass, close.
// Called from the Queue consumer (for the datastores in the batch) and the cron (all datastores).

import { pruneWebhookDeliveries, webhookLag } from "@records/core";

import { closeQuietly, publisherDatabase, recordsService } from "../runtime.js";
import { deliverWebhooks, type WebhookRunOptions, type WebhookRunResult } from "./deliver.js";

export { deliverWebhooks, type WebhookDeps, type WebhookRunOptions, type WebhookRunResult } from "./deliver.js";
export { verifyRecordsSignature } from "./sign.js";

type Env = Pick<Cloudflare.Env, "HYPERDRIVE" | "HYPERDRIVE_PUBLISHER" | "PUBLIC_BASE_URL">;

export async function runWebhooks(env: Env, opts: WebhookRunOptions = {}): Promise<WebhookRunResult> {
  const publisher = publisherDatabase(env);
  const service = recordsService(env);
  try {
    return await deliverWebhooks({ publisher, service, publicBaseUrl: env.PUBLIC_BASE_URL }, opts);
  } finally {
    await Promise.all([closeQuietly(publisher), closeQuietly(service.db)]);
  }
}

/** Hourly maintenance: prune settled deliveries and report the backlog. */
export async function webhookMaintenance(env: Pick<Cloudflare.Env, "HYPERDRIVE_PUBLISHER">, prune: boolean) {
  const db = publisherDatabase(env);
  try {
    const pruned = prune ? await pruneWebhookDeliveries(db) : null;
    return { ...(await webhookLag(db)), pruned };
  } finally {
    await closeQuietly(db);
  }
}
