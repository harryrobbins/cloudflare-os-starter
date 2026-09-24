// `ContextFeed`: the Durable Object that owns the Context Library feed (`./context.ts`).
//
// Why a Durable Object: the feed's Context account is a capability, not a credential. The stub
// `GatekeeperVendor.createAccount()` returns can be kept only in Durable Object storage
// (`allow_irrevocable_stub_storage`), and minting a fresh account per run would leave an orphaned
// account behind every time. So the account is minted once, on the first sync, and persisted here.
// The manifest of what was pushed lives in the same object's SQLite, so reruns fetch only documents
// whose `lastUpdated` moved.
//
// One instance, `CONTEXT_FEED_NAME`. Driven by either:
//   * a cron trigger: `scheduled()` calls `stub.sync()`; or
//   * its own alarm: call `stub.schedule(ms)` once (e.g. from an admin endpoint); `alarm()` syncs and
//     re-arms. `schedule(null)` stops it.

import { DurableObject } from "cloudflare:workers";

import { INDEX_NAME, type IngestBatch, type IngestResult } from "../shared/contract.js";
import {
  CONTEXT_SOURCE,
  contextScope,
  openContextSource,
  syncContext,
  type ContextAccountLike,
  type ContextFeedStore,
  type ContextSyncOptions,
  type ContextSyncReport,
  type ContextVendorLike,
  type PushedCollection,
  type PushedDocument,
} from "./context.js";

export const CONTEXT_FEED_NAME = "main";

/** The bindings this object uses. A subset of the Worker's env; see the integration checklist. */
export interface ContextFeedEnv {
  /** cfos-context, `entrypoint: "GatekeeperVendor"`, `props: {sharingDomain}` (same as the Workshop's). */
  readonly GATEKEEPER_CONTEXT: ContextVendorLike;
  readonly SEARCH_INDEX: DurableObjectNamespace;
}

const ACCOUNT_KEY = "account";
const INTERVAL_KEY = "intervalMs";
const LAST_REPORT_KEY = "lastReport";

/** Floor for the self-scheduled interval, so a mistake cannot hammer the Library. */
const MIN_INTERVAL_MS = 60_000;

export class SqlContextFeedStore implements ContextFeedStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS context_collections (
      collection_id TEXT PRIMARY KEY,
      label TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS context_documents (
      collection_id TEXT NOT NULL,
      path TEXT NOT NULL,
      last_updated INTEGER NOT NULL,
      hash TEXT NOT NULL,
      PRIMARY KEY (collection_id, path)
    )`);
  }

  listCollections(): PushedCollection[] {
    return this.sql
      .exec<{ collection_id: string; label: string }>("SELECT collection_id, label FROM context_collections")
      .toArray()
      .map((r) => ({ collectionId: r.collection_id, label: r.label }));
  }
  putCollection(row: PushedCollection): void {
    this.sql.exec(
      "INSERT INTO context_collections (collection_id, label) VALUES (?, ?) " +
        "ON CONFLICT (collection_id) DO UPDATE SET label = excluded.label",
      row.collectionId, row.label);
  }
  deleteCollection(collectionId: string): void {
    this.sql.exec("DELETE FROM context_documents WHERE collection_id = ?", collectionId);
    this.sql.exec("DELETE FROM context_collections WHERE collection_id = ?", collectionId);
  }
  listDocuments(collectionId: string): PushedDocument[] {
    return this.sql
      .exec<{ path: string; last_updated: number; hash: string }>(
        "SELECT path, last_updated, hash FROM context_documents WHERE collection_id = ?", collectionId)
      .toArray()
      .map((r) => ({ collectionId, path: r.path, lastUpdated: r.last_updated, hash: r.hash }));
  }
  putDocument(row: PushedDocument): void {
    this.sql.exec(
      "INSERT INTO context_documents (collection_id, path, last_updated, hash) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT (collection_id, path) DO UPDATE SET last_updated = excluded.last_updated, hash = excluded.hash",
      row.collectionId, row.path, row.lastUpdated, row.hash);
  }
  deleteDocument(collectionId: string, path: string): void {
    this.sql.exec("DELETE FROM context_documents WHERE collection_id = ? AND path = ?", collectionId, path);
  }
  clear(): void {
    this.sql.exec("DELETE FROM context_documents");
    this.sql.exec("DELETE FROM context_collections");
  }
}

export class ContextFeed extends DurableObject<ContextFeedEnv> {
  readonly #store: SqlContextFeedStore;
  #running?: Promise<ContextSyncReport>;
  #minting?: Promise<ContextAccountLike>;

  constructor(ctx: DurableObjectState, env: ContextFeedEnv) {
    super(ctx, env);
    this.#store = new SqlContextFeedStore(ctx.storage.sql);
  }

  /** The feed's own Context account: minted on first use, then reused for the life of the object. */
  #account(): Promise<ContextAccountLike> {
    const stored = this.ctx.storage.kv.get<ContextAccountLike>(ACCOUNT_KEY);
    if (stored) return Promise.resolve(stored);
    // createAccount() is a cross-Worker await, which opens the input gate; without this memo two
    // overlapping first syncs would each mint (and one would orphan) an account.
    return (this.#minting ??= (async () => {
      try {
        const account = await this.env.GATEKEEPER_CONTEXT.createAccount();
        this.ctx.storage.kv.put(ACCOUNT_KEY, account);
        return account;
      } finally {
        this.#minting = undefined;
      }
    })());
  }

  #ingest(batch: IngestBatch): Promise<IngestResult> {
    const index = this.env.SEARCH_INDEX.get(this.env.SEARCH_INDEX.idFromName(INDEX_NAME)) as unknown as {
      ingest(source: string, batch: IngestBatch): Promise<IngestResult>;
    };
    return index.ingest(CONTEXT_SOURCE, batch);
  }

  /** One pass; concurrent callers share the pass in flight. */
  sync(options?: Pick<ContextSyncOptions, "maxReadsPerRun">): Promise<ContextSyncReport> {
    return (this.#running ??= (async () => {
      try {
        const account = await this.#account();
        using session = await openContextSource(account);
        const report = await syncContext(session.source, this.#store, (b) => this.#ingest(b), options);
        this.ctx.storage.kv.put(LAST_REPORT_KEY, { at: Date.now(), ...report });
        return report;
      } finally {
        this.#running = undefined;
      }
    })());
  }

  /** The last completed pass, for an admin/stats endpoint. */
  lastReport(): (ContextSyncReport & { at: number }) | null {
    return this.ctx.storage.kv.get<ContextSyncReport & { at: number }>(LAST_REPORT_KEY) ?? null;
  }

  /** Self-schedule with the object's alarm instead of (or as well as) a cron. Null stops it. */
  async schedule(intervalMs: number | null): Promise<void> {
    if (intervalMs === null) {
      this.ctx.storage.kv.delete(INTERVAL_KEY);
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const interval = Math.max(MIN_INTERVAL_MS, Math.floor(intervalMs));
    this.ctx.storage.kv.put(INTERVAL_KEY, interval);
    await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  override async alarm(): Promise<void> {
    const interval = this.ctx.storage.kv.get<number>(INTERVAL_KEY);
    try {
      const report = await this.sync();
      // A backlog capped by maxReadsPerRun continues soon rather than after a full interval.
      if (interval && report.more) {
        await this.ctx.storage.setAlarm(Date.now() + MIN_INTERVAL_MS);
        return;
      }
    } catch (error) {
      console.error("context feed: sync failed", error);
    }
    if (interval) await this.ctx.storage.setAlarm(Date.now() + interval);
  }

  /**
   * Forget everything pushed and drop every Context scope from the index; the next sync re-pushes
   * from scratch. Keeps the account.
   */
  async reset(): Promise<void> {
    const scopes = this.#store.listCollections().map((c) => contextScope(c.collectionId));
    if (scopes.length > 0) await this.#ingest({ dropScopes: scopes });
    this.#store.clear();
  }
}
