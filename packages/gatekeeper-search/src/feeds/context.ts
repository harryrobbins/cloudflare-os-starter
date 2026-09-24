// The Context Library feed: a periodic pull of the deployment's PUBLIC Context collections into the
// SearchIndex, with source "context".
//
// Route 1 of docs/plans/omni-search.md ("The Context Library"), no fork. The search Worker binds
// cfos-context with `entrypoint: "GatekeeperVendor"` and `props: {sharingDomain}` -- the same binding
// the Workshop has -- mints itself one Context account with `createAccount()` and keeps that account
// stub in Durable Object storage (`allow_irrevocable_stub_storage`). A freshly minted account owns no
// private collections, so what it can read is exactly the sharing domain's public collections
// (`loadEnabledContextCollections`: own private + domain public). Verified (spike 5) against the real
// gatekeeper-context Worker under `wrangler dev`: a foreign Worker's minted account, and the stored
// account stub after a restart, list the domain's public collections and none of any account's
// private ones, and `ContextFeed` below pushed exactly those documents.
//
// It reads through the account's management API (`startAppUi({isAdmin: false})` -> `ContextApi`)
// rather than the agent singleton, because that API is the one that says, per collection, whether it
// is public (`EnabledCollectionInfo.source`) and, per document, when it last changed
// (`ContextDocumentSummary.lastUpdated`). The singleton's `list()`/`read()` also works across the
// binding (the returned `DurableObjectClass` runs as a facet of a non-Workshop Durable Object), but it
// carries neither field, so every rerun would have to read every body, and the public/private
// distinction would rest on the account owning nothing. With `isAdmin: false` the API can write only
// collections this account owns, and it owns none; this module never calls a write.
//
// Private collections are never indexed: only `source === "public"` collections are read, and a
// previously indexed collection that stops being listed as public has its scope dropped.
//
// This module has no `cloudflare:*` import so it can be tested with plain fakes. The Durable Object
// that holds the account stub and the manifest is `./context-feed-do.ts`.

import {
  INGEST_LIMITS,
  type IngestBatch,
  type IngestDocument,
  type IngestResult,
  type ScopeDeclaration,
} from "../shared/contract.js";

export const CONTEXT_SOURCE = "context";

/**
 * Where a Context document opens. The Library's UI is the Workshop's app page for the "context"
 * vendor (`workshop-frontend/src/routes/gatekeepers_.$appId.tsx`); it is a sandboxed iframe with no
 * per-document route, so every document links to the Library as a whole.
 */
export const CONTEXT_LIBRARY_URL = "/gatekeepers/context";

// ---------------------------------------------------------------------------
// What the feed reads (the Context Library side)
// ---------------------------------------------------------------------------

export interface FeedCollection {
  id: string;
  title: string;
  visibility: "public" | "private";
}

export interface FeedDocumentSummary {
  path: string;
  name: string;
  description: string;
  contentType: string;
  skillName?: string;
  /** Epoch ms. */
  lastUpdated: number;
}

export interface FeedDocument extends FeedDocumentSummary {
  /** Literal text for text content types; base64 for binary ones. */
  body: string;
}

export interface ContextFeedSource {
  listCollections(): Promise<FeedCollection[]>;
  listDocuments(collectionId: string): Promise<FeedDocumentSummary[]>;
  getDocument(collectionId: string, path: string): Promise<FeedDocument | null>;
}

/** The slice of cfos-context's `ContextApi` (context-types.ts) the feed uses. Read methods only. */
export interface ContextApiLike {
  listEnabledContextCollections(): Promise<
    { id: string; title: string; source: "private" | "public"; lastUpdated: Date | string | number }[]
  >;
  listContextDocuments(collectionId: string, prefix?: string): Promise<
    {
      path: string;
      name: string;
      description: string;
      contentType: string;
      skillName?: string;
      lastUpdated: Date | string | number;
    }[]
  >;
  getContextDocument(collectionId: string, path: string): Promise<
    {
      path: string;
      name: string;
      description: string;
      contentType: string;
      body: string;
      skillName?: string;
      lastUpdated: Date | string | number;
    } | null
  >;
}

/** The account stub `GatekeeperVendor.createAccount()` returns, as far as the feed uses it. */
export interface ContextAccountLike {
  startAppUi(context: { isAdmin: boolean }): Promise<{ iframeHtml?: string; ui: ContextApiLike }>;
}

/** `env.GATEKEEPER_CONTEXT` bound with `entrypoint: "GatekeeperVendor"`. */
export interface ContextVendorLike {
  createAccount(): Promise<ContextAccountLike>;
}

function epochMs(value: Date | string | number): number {
  if (typeof value === "number") return value;
  const ms = (value instanceof Date ? value : new Date(value)).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** Adapts the management API. The caller owns (and disposes) `ui`. */
export function contextApiSource(ui: ContextApiLike): ContextFeedSource {
  return {
    async listCollections() {
      const enabled = await ui.listEnabledContextCollections();
      return enabled.map((c) => ({ id: c.id, title: c.title, visibility: c.source }));
    },
    async listDocuments(collectionId) {
      const docs = await ui.listContextDocuments(collectionId);
      return docs.map((d) => ({
        path: d.path,
        name: d.name,
        description: d.description,
        contentType: d.contentType,
        ...(d.skillName ? { skillName: d.skillName } : {}),
        lastUpdated: epochMs(d.lastUpdated),
      }));
    },
    async getDocument(collectionId, path) {
      const d = await ui.getContextDocument(collectionId, path);
      if (!d) return null;
      return {
        path: d.path,
        name: d.name,
        description: d.description,
        contentType: d.contentType,
        body: d.body,
        ...(d.skillName ? { skillName: d.skillName } : {}),
        lastUpdated: epochMs(d.lastUpdated),
      };
    },
  };
}

/**
 * Opens a read session on the feed's account. `isAdmin: false` is the least privilege the API has:
 * public collections become read-only to it. Dispose the result when the run is over.
 */
export async function openContextSource(
  account: ContextAccountLike,
): Promise<{ source: ContextFeedSource } & Disposable> {
  const frame = await account.startAppUi({ isAdmin: false });
  const ui = frame.ui;
  return {
    source: contextApiSource(ui),
    [Symbol.dispose]() {
      (ui as { [Symbol.dispose]?(): void })[Symbol.dispose]?.();
    },
  };
}

// ---------------------------------------------------------------------------
// What the feed remembers (so reruns are cheap)
// ---------------------------------------------------------------------------

export interface PushedCollection {
  collectionId: string;
  /** The scope label last declared. */
  label: string;
}

export interface PushedDocument {
  collectionId: string;
  path: string;
  /** The Library's `lastUpdated` when last seen, epoch ms. */
  lastUpdated: number;
  /** Hash of the IngestDocument last pushed (timestamps excluded). */
  hash: string;
}

export interface ContextFeedStore {
  listCollections(): PushedCollection[];
  putCollection(row: PushedCollection): void;
  /** Forgets the collection and every document under it. */
  deleteCollection(collectionId: string): void;
  listDocuments(collectionId: string): PushedDocument[];
  putDocument(row: PushedDocument): void;
  deleteDocument(collectionId: string, path: string): void;
}

/** In-memory store, for tests and for a dry run. */
export class MemoryContextFeedStore implements ContextFeedStore {
  readonly collections = new Map<string, PushedCollection>();
  readonly documents = new Map<string, Map<string, PushedDocument>>();

  listCollections(): PushedCollection[] {
    return [...this.collections.values()];
  }
  putCollection(row: PushedCollection): void {
    this.collections.set(row.collectionId, { ...row });
  }
  deleteCollection(collectionId: string): void {
    this.collections.delete(collectionId);
    this.documents.delete(collectionId);
  }
  listDocuments(collectionId: string): PushedDocument[] {
    return [...(this.documents.get(collectionId)?.values() ?? [])];
  }
  putDocument(row: PushedDocument): void {
    let docs = this.documents.get(row.collectionId);
    if (!docs) this.documents.set(row.collectionId, (docs = new Map()));
    docs.set(row.path, { ...row });
  }
  deleteDocument(collectionId: string, path: string): void {
    this.documents.get(collectionId)?.delete(path);
  }
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

export function contextScope(collectionId: string): string {
  return `${CONTEXT_SOURCE}:${collectionId}`;
}

const utf8 = new TextEncoder();

/**
 * `context:<collectionId>:<path>`. A path long enough to break the index's id limit is replaced by a
 * digest of itself, which is stable, so updates and deletes still land on the same row.
 */
export async function contextDocumentId(collectionId: string, path: string): Promise<string> {
  const id = `${CONTEXT_SOURCE}:${collectionId}:${path}`;
  if (utf8.encode(id).length <= INGEST_LIMITS.maxIdBytes) return id;
  return `${CONTEXT_SOURCE}:${collectionId}:#${await sha256Hex(path)}`;
}

/** Text content types, mirroring gatekeeper-context's `isTextContentType`. */
export function isTextContentType(contentType: string): boolean {
  const type = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (type.startsWith("text/")) return true;
  return (
    type === "application/json" ||
    type === "application/yaml" ||
    type === "application/x-yaml" ||
    type === "application/xml"
  );
}

function kindOf(doc: FeedDocumentSummary): string {
  if (doc.skillName) return "skill";
  return isTextContentType(doc.contentType) ? "doc" : "file";
}

/**
 * The document as the index gets it. Binary documents (images, PDFs) are searchable by name,
 * path and description only: their base64 body is never indexed.
 */
export async function toIngestDocument(
  collection: FeedCollection,
  doc: FeedDocument,
): Promise<IngestDocument> {
  const text = isTextContentType(doc.contentType);
  const header = [doc.path, doc.description].filter((part) => part && part.trim()).join("\n");
  const body = text ? (doc.description ? `${doc.description}\n\n${doc.body}` : doc.body) : header;
  return {
    id: await contextDocumentId(collection.id, doc.path),
    kind: kindOf(doc),
    title: (doc.skillName ?? doc.name ?? doc.path).slice(0, INGEST_LIMITS.maxTitleChars),
    url: CONTEXT_LIBRARY_URL,
    scope: contextScope(collection.id),
    vis: "all",
    body,
    channel: collection.id,
    mime: doc.contentType,
    createdAt: doc.lastUpdated,
    updatedAt: doc.lastUpdated,
  };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Everything the index stores except the timestamps, so a touch without an edit is not a push. */
export function hashIngestDocument(doc: IngestDocument): Promise<string> {
  const { createdAt: _c, updatedAt: _u, ...rest } = doc;
  return sha256Hex(JSON.stringify(rest, Object.keys(rest).sort()));
}

// ---------------------------------------------------------------------------
// The sync
// ---------------------------------------------------------------------------

export type Ingest = (batch: IngestBatch) => Promise<IngestResult>;

export interface ContextSyncOptions {
  /** Bodies fetched per run at most; the rest are picked up by the next run. Default 500. */
  maxReadsPerRun?: number;
  /** Upserts + deletes per ingest call. Default and cap: `INGEST_LIMITS.maxDocumentsPerBatch`. */
  batchSize?: number;
  /** Parallel `getDocument` calls. Default 6. */
  readConcurrency?: number;
  /** Log sink for per-collection failures. Default: console.warn. */
  warn?: (message: string, detail?: unknown) => void;
}

export interface ContextSyncReport {
  collections: number;
  /** Documents listed across all public collections. */
  documents: number;
  /** Bodies fetched this run. */
  read: number;
  /** Documents pushed as upserts. */
  pushed: number;
  /** Fetched but byte-identical (by hash) to what was last pushed. */
  unchanged: number;
  deleted: number;
  /** Collections whose scope was dropped (deleted, or no longer public). */
  droppedCollections: number;
  /** Collections skipped this run because listing them failed; their index rows are kept. */
  failedCollections: string[];
  /** True when `maxReadsPerRun` stopped the run early; run again to continue. */
  more: boolean;
}

interface PendingUpsert {
  doc: IngestDocument;
  row: PushedDocument;
}

/**
 * One pass. Safe to rerun at any time and idempotent: a pass that changes nothing in the Library
 * lists every public collection once and fetches no bodies. The store is written only after the
 * ingest call carrying the change has succeeded, so a failed run is simply retried by the next one.
 */
export async function syncContext(
  source: ContextFeedSource,
  store: ContextFeedStore,
  ingest: Ingest,
  options: ContextSyncOptions = {},
): Promise<ContextSyncReport> {
  const maxReads = options.maxReadsPerRun ?? 500;
  const batchSize = Math.max(1, Math.min(options.batchSize ?? INGEST_LIMITS.maxDocumentsPerBatch,
    INGEST_LIMITS.maxDocumentsPerBatch));
  const concurrency = Math.max(1, options.readConcurrency ?? 6);
  const warn = options.warn ?? ((message, detail) => console.warn(message, detail));

  const report: ContextSyncReport = {
    collections: 0, documents: 0, read: 0, pushed: 0, unchanged: 0, deleted: 0,
    droppedCollections: 0, failedCollections: [], more: false,
  };

  // If this throws, nothing is known about what exists, so nothing is dropped.
  const listed = await source.listCollections();
  const publicCollections = listed.filter((c) => c.visibility === "public");
  report.collections = publicCollections.length;
  const publicIds = new Set(publicCollections.map((c) => c.id));

  // Collections we indexed that are gone or no longer public: drop the whole scope first, so a
  // collection turned private stops being searchable before anything else happens.
  const known = new Map(store.listCollections().map((c) => [c.collectionId, c]));
  const gone = [...known.keys()].filter((id) => !publicIds.has(id));
  if (gone.length > 0) {
    await ingest({ dropScopes: gone.map(contextScope) });
    for (const id of gone) store.deleteCollection(id);
    report.droppedCollections = gone.length;
  }

  // Scope labels: declared once, and again only when a collection is renamed.
  const scopes: ScopeDeclaration[] = [];
  for (const c of publicCollections) {
    if (known.get(c.id)?.label !== c.title) {
      scopes.push({ scope: contextScope(c.id), label: c.title, vis: "all" });
    }
  }

  let upserts: PendingUpsert[] = [];
  let deletes: { collectionId: string; path: string; id: string }[] = [];
  let reads = 0;

  const flush = async (force: boolean): Promise<void> => {
    while (
      scopes.length > 0 || upserts.length + deletes.length >= batchSize ||
      (force && upserts.length + deletes.length > 0)
    ) {
      const takeDeletes = deletes.slice(0, batchSize);
      const takeUpserts = upserts.slice(0, batchSize - takeDeletes.length);
      const declared = scopes.splice(0, scopes.length);
      const batch: IngestBatch = {};
      if (declared.length > 0) batch.scopes = declared;
      if (takeUpserts.length > 0) batch.upserts = takeUpserts.map((u) => u.doc);
      if (takeDeletes.length > 0) batch.deletes = takeDeletes.map((d) => d.id);
      await ingest(batch);
      for (const c of publicCollections) {
        if (declared.some((s) => s.scope === contextScope(c.id))) {
          store.putCollection({ collectionId: c.id, label: c.title });
        }
      }
      for (const u of takeUpserts) store.putDocument(u.row);
      for (const d of takeDeletes) store.deleteDocument(d.collectionId, d.path);
      report.pushed += takeUpserts.length;
      report.deleted += takeDeletes.length;
      upserts = upserts.slice(takeUpserts.length);
      deletes = deletes.slice(takeDeletes.length);
    }
  };

  for (const collection of publicCollections) {
    let docs: FeedDocumentSummary[];
    try {
      docs = await source.listDocuments(collection.id);
    } catch (error) {
      // Keep what is indexed; a transient failure must not look like an emptied collection.
      warn("context feed: listing a collection failed", { collectionId: collection.id, error });
      report.failedCollections.push(collection.id);
      continue;
    }
    report.documents += docs.length;

    const pushed = new Map(store.listDocuments(collection.id).map((d) => [d.path, d]));
    const listedPaths = new Set(docs.map((d) => d.path));
    for (const [path] of pushed) {
      if (!listedPaths.has(path)) {
        deletes.push({ collectionId: collection.id, path, id: await contextDocumentId(collection.id, path) });
      }
    }

    const stale = docs.filter((d) => pushed.get(d.path)?.lastUpdated !== d.lastUpdated);
    const budget = Math.max(0, maxReads - reads);
    if (stale.length > budget) report.more = true;
    const toRead = stale.slice(0, budget);
    reads += toRead.length;

    const fetched = await mapWithConcurrency(toRead, concurrency, async (summary) => {
      try {
        return await source.getDocument(collection.id, summary.path);
      } catch (error) {
        warn("context feed: reading a document failed", { collectionId: collection.id, path: summary.path, error });
        return undefined;
      }
    });
    report.read += toRead.length;

    for (let i = 0; i < toRead.length; i++) {
      const doc = fetched[i];
      const summary = toRead[i]!;
      if (doc === undefined) continue; // read failed: retried next run
      if (doc === null) {
        // Deleted between list and read.
        if (pushed.has(summary.path)) {
          deletes.push({ collectionId: collection.id, path: summary.path, id: await contextDocumentId(collection.id, summary.path) });
        }
        continue;
      }
      const ingestDoc = await toIngestDocument(collection, doc);
      const hash = await hashIngestDocument(ingestDoc);
      const row: PushedDocument = { collectionId: collection.id, path: doc.path, lastUpdated: summary.lastUpdated, hash };
      if (pushed.get(doc.path)?.hash === hash) {
        store.putDocument(row); // touched, not edited
        report.unchanged++;
      } else {
        upserts.push({ doc: ingestDoc, row });
      }
    }
    await flush(false);
  }

  // Also declares the scopes of public collections that have no documents yet.
  await flush(true);
  return report;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
