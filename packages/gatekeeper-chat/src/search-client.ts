// The slice of the omni-search contract chat speaks, copied rather than imported.
//
// SOURCE OF TRUTH: packages/gatekeeper-search/src/shared/contract.ts. Everything below is a verbatim
// subset of it; when the two disagree, the contract wins and this file is the one to fix. Chat takes
// no runtime dependency on another package (docs/plans/omni-search.md, "Query language"), which is
// why the shapes are duplicated here instead of imported across the workspace.
//
// Chat reaches the search Worker through an optional service binding, `SEARCH`, with
// `entrypoint: "SearchService"` and `props: { source: "chat" }` (scripts/deploy.ts generates it when
// search is enabled). Two methods are used: `ingest()` for the live deltas and the backfill
// (src/do/search-sync.ts), and `denseRecall()` for fusion (src/do/search.ts).

/** `all`: every signed-in person. `scoped`: only the principals listed for the document's scope. */
export type Visibility = "all" | "scoped";

/** One scalar ACL key per document, `<source>:<id>`. Chat uses `chat:<channelId>`. */
export type Scope = string;

/** A person, as the Access `sub` claim names them. Chat uses the same id for its users. */
export type Principal = string;

/** Hard limits `ingest()` enforces with a thrown error. */
export const INGEST_LIMITS = {
  /** Documents (upserts + deletes) per `ingest()` call. */
  maxDocumentsPerBatch: 100,
  maxIdBytes: 512,
  maxTitleChars: 500,
  /** A longer body is truncated by search, not refused. */
  maxBodyChars: 256 * 1024,
  /** Principal changes per `ingest()` call, across all scopes. */
  maxPrincipalChanges: 2000,
} as const;

export interface IngestDocument {
  /** `<source>:<externalId>`, so `chat:<messageId>`. */
  id: string;
  kind: string;
  title: string;
  /** Origin-relative path or absolute https URL. Null when none. */
  url: string | null;
  scope: Scope;
  vis: Visibility;
  /** Plain text. */
  body: string;
  workspace?: string | null;
  channel?: string | null;
  authorId?: string | null;
  author?: string | null;
  mime?: string | null;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
}

export interface ScopeDeclaration {
  scope: Scope;
  /** e.g. "#general" or "Jane, Sam". */
  label: string;
  vis: Visibility;
}

/** Membership changes for one scope. `replace` wins over `add`/`remove` when present. */
export interface PrincipalChange {
  scope: Scope;
  replace?: Principal[];
  add?: Principal[];
  remove?: Principal[];
}

export interface IngestBatch {
  upserts?: IngestDocument[];
  /** Document ids. Deleting an unknown id is not an error. */
  deletes?: string[];
  scopes?: ScopeDeclaration[];
  principals?: PrincipalChange[];
  /** Scopes to drop entirely: every document in them is deleted and their principals forgotten. */
  dropScopes?: Scope[];
}

export interface IngestResult {
  upserted: number;
  unchanged: number;
  deleted: number;
  queued: number;
}

export interface DenseRecallRequest {
  text: string;
  /** e.g. ["chat:C1", "chat:C2"]. Anything outside the binding's source prefix is ignored. */
  scopes: Scope[];
  /** Default 50, max 100. */
  limit?: number;
}

export interface DenseRecallHit {
  /** `chat:<messageId>`. */
  documentId: string;
  /** 1-based rank in the dense list. */
  rank: number;
  score: number;
}

export type DenseStatus = "ok" | "off" | "unavailable";

export interface DenseRecallResult {
  hits: DenseRecallHit[];
  /** Anything but "ok" means: fall back to lexical only. */
  dense: DenseStatus;
}

/** Reciprocal rank fusion constant and candidates per half, from the contract's `SEARCH_LIMITS`. */
export const SEARCH_LIMITS = {
  candidatesPerHalf: 100,
  rrfK: 60,
} as const;

/** Thrown (by message prefix, since RPC loses the class) for caller mistakes. */
export const INPUT_ERROR_PREFIX = "search: invalid input: ";

/**
 * The `SearchService` entrypoint as chat calls it. Typed as the two methods chat uses rather than
 * `Service<...>`, the same way `WORKSHOP_GATEWAY` is typed as its contract: the entrypoint class lives
 * in another package and is never imported here.
 */
export interface SearchService {
  ingest(batch: IngestBatch): Promise<IngestResult>;
  denseRecall(request: DenseRecallRequest): Promise<DenseRecallResult>;
}

/** Chat's own prefix on document ids and scopes. */
export const CHAT_SOURCE_PREFIX = "chat:";

export function chatDocumentId(messageId: string): string {
  return `${CHAT_SOURCE_PREFIX}${messageId}`;
}

export function chatScope(channelId: string): Scope {
  return `${CHAT_SOURCE_PREFIX}${channelId}`;
}

/** The message id inside a `chat:<messageId>` document id, or null for anything else. */
export function messageIdOfDocument(documentId: string): string | null {
  if (!documentId.startsWith(CHAT_SOURCE_PREFIX)) return null;
  const id = documentId.slice(CHAT_SOURCE_PREFIX.length);
  return id.length > 0 ? id : null;
}

/** Rejects with a timeout error when `promise` has not settled within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
