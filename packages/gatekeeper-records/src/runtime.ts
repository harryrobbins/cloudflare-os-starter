// Database handles. Workers forbid sharing I/O objects (sockets) between requests or between
// Durable Objects, so there is no isolate-wide cache: each Durable Object instance, entrypoint call
// or HTTP request opens its own small postgres.js client over Hyperdrive, which does the pooling.
// Idle sockets close themselves after a few seconds; HTTP handlers also end theirs explicitly.

import type { Db } from "./db/context.js";
import { connect, RecordsService } from "./domain/service.js";

export function recordsService(env: Pick<Cloudflare.Env, "HYPERDRIVE">): RecordsService {
  return new RecordsService(connect(env.HYPERDRIVE.connectionString, { max: 3 }));
}

export function publisherDatabase(env: Pick<Cloudflare.Env, "HYPERDRIVE_PUBLISHER">): Db {
  return connect(env.HYPERDRIVE_PUBLISHER.connectionString, { max: 2 });
}

/** Close a client without failing the caller. */
export async function closeQuietly(db: Db): Promise<void> {
  try {
    await db.end({ timeout: 5 });
  } catch {
    // already closed
  }
}

/** Where the machine API lives, for display. */
export function apiBase(env: Pick<Cloudflare.Env, "PUBLIC_BASE_URL">): string {
  try {
    return new URL("/gatekeeper/records/v1", env.PUBLIC_BASE_URL).toString();
  } catch {
    return "/gatekeeper/records/v1";
  }
}
