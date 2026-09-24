// The omni-search contract: every shape that crosses a boundary, in one file.
//
// Four boundaries share it, and none of them may invent a shape of its own:
//
//   * Sources -> `SearchService` (service binding, `entrypoint: "SearchService"`, props {source}):
//     `ingest()` pushes documents, deletes and ACL changes; `denseRecall()` is chat's phase-1 fusion.
//   * Browser -> `/gatekeeper/search/api/*` (Access-verified HTTP), for the SPA in app/.
//   * Agent -> `SearchSession` (the Gatekeeper singleton, src/vendor/).
//   * Worker entrypoints and the queue consumer -> the `SearchIndex` Durable Object (RPC).
//
// Plan: docs/plans/omni-search.md. Facts and limits: docs/research/hybrid-search-on-cloudflare.md.
//
// This module is imported by the Worker, the SPA and tests, so it holds types and pure constants
// only: no `cloudflare:*` import and no runtime dependency.

// ---------------------------------------------------------------------------
// Scopes and visibility
// ---------------------------------------------------------------------------

/**
 * Who may see a document.
 *
 *   `all`     every signed-in person of this deployment, and the agent. Public chat channels,
 *             public Context collections.
 *   `scoped`  only the principals listed for the document's scope in the `principals` table
 *             (private channels, DMs), or the agent account named by an `account:<id>` scope.
 */
export type Visibility = "all" | "scoped";

/**
 * A scope is one scalar ACL key per document, `<source>:<id>`. Vectorize can filter a stored scalar
 * against a candidate array (`$in`) but cannot index arrays, so a document carries exactly one.
 *
 * Conventions:
 *   chat:<channelId>          a chat channel, DM or group; members are its principals
 *   context:<collectionId>    a Context Library collection
 *   account:<accountId>       documents a gadget pushed through one agent account's session;
 *                             visible to that account's agent sessions only
 */
export type Scope = string;

/** A person, as the Access `sub` claim names them. Chat uses the same id for its users. */
export type Principal = string;

/** Sources that exist today. `source` is an open string so a new source needs no contract change. */
export const KNOWN_SOURCES = ["chat", "context", "gadget"] as const;

/** Human labels for the facet rail and the agent catalog. */
export const SOURCE_LABELS: Readonly<Record<string, string>> = {
  chat: "Team chat",
  context: "Context Library",
  gadget: "Workspace gadgets",
};

// ---------------------------------------------------------------------------
// Ingest (sources -> SearchService.ingest)
// ---------------------------------------------------------------------------

/** Hard limits, enforced by `ingest()` with a thrown `SearchInputError`. */
export const INGEST_LIMITS = {
  /** Documents (upserts + deletes) per `ingest()` call. */
  maxDocumentsPerBatch: 100,
  /** `IngestDocument.id`, in UTF-8 bytes. Vector ids are hashed, so this is ours, not Vectorize's. */
  maxIdBytes: 512,
  maxTitleChars: 500,
  /** `ScopeDeclaration.label`, in characters. A longer label is truncated, not refused. */
  maxLabelChars: 200,
  /** `IngestDocument.body`, in characters. A longer body is truncated, not refused. */
  maxBodyChars: 256 * 1024,
  /**
   * Principal changes per `ingest()` call, across all scopes. A batch changing a single scope may
   * exceed it (up to `maxPrincipalsPerScope`), so one large private channel is never refused.
   */
  maxPrincipalChanges: 2000,
  maxPrincipalsPerScope: 50_000,
} as const;

/**
 * One document, as a source pushes it. Re-pushing the same `id` updates it; an unchanged body
 * (by hash) with unchanged metadata is a free no-op.
 */
export interface IngestDocument {
  /** `<source>:<externalId>`. Must start with the caller's own source prefix. */
  id: string;
  /** Free-form kind within the source: "message", "doc", "sheet", "slides", "note"... */
  kind: string;
  title: string;
  /** Origin-relative path ("/gatekeeper/chat/c/…") or an absolute https URL. Null when none. */
  url: string | null;
  /** The document's single ACL scope. Must start with the caller's own source prefix. */
  scope: Scope;
  vis: Visibility;
  /** Plain text. Markdown is fine; HTML should be stripped by the source. */
  body: string;
  /** Facets. All optional. */
  workspace?: string | null;
  /** Chat channel id, or any source's sub-container. The label comes from the scope row. */
  channel?: string | null;
  /** The author's principal id, where the source knows it. */
  authorId?: string | null;
  /** The author's display name, used for the `from:` qualifier and the facet label. */
  author?: string | null;
  mime?: string | null;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
}

/** Declares a scope's label and visibility, for facets and for `in:`. */
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
  /**
   * Scopes to drop entirely: every document in them is deleted and their principals forgotten. For
   * a deleted channel.
   */
  dropScopes?: Scope[];
}

export interface IngestResult {
  upserted: number;
  /** Upserts whose body hash and metadata matched what was already stored. */
  unchanged: number;
  deleted: number;
  /** Chunks queued for embedding by this call. */
  queued: number;
}

// ---------------------------------------------------------------------------
// Chat fusion (SearchService.denseRecall)
// ---------------------------------------------------------------------------

/**
 * Chat keeps its own ACL (plan decision 5): it passes the scopes the caller may see, already
 * resolved, and search restricts them further to the binding's own source prefix.
 */
export interface DenseRecallRequest {
  text: string;
  /** e.g. ["chat:C1", "chat:C2"]. Anything outside the binding's source prefix is ignored. */
  scopes: Scope[];
  /** Default 50, max 100. */
  limit?: number;
}

export interface DenseRecallHit {
  /** `<source>:<externalId>`; chat strips the "chat:" prefix to get its message id. */
  documentId: string;
  /** 1-based rank in the dense list, the input to reciprocal rank fusion. */
  rank: number;
  /** Cosine similarity of the best chunk. */
  score: number;
}

export interface DenseRecallResult {
  hits: DenseRecallHit[];
  /** "unavailable" when Workers AI or Vectorize failed; the caller falls back to lexical only. */
  dense: DenseStatus;
}

export type DenseStatus = "ok" | "off" | "unavailable";

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Qualifiers, reusing chat's grammar with omni additions:
 *   in:#name       a scope by label (or `in:chat:C1` by id)
 *   from:name      author display name, case-insensitive; `from:me` for a person
 *   source:chat    kind:doc    workspace:<id>
 *   before:/after:/on:YYYY-MM-DD   by `updatedAt`, UTC
 * Free text is quoted term by term into a safe FTS5 MATCH string; a trailing `*` is a prefix.
 */
export interface OmniQuery {
  text: string;
  in?: Scope[];
  from?: string[];
  source?: string[];
  kind?: string[];
  workspace?: string[];
  /** Inclusive epoch-ms bounds. */
  before?: number;
  after?: number;
}

export const SEARCH_LIMITS = {
  maxQueryChars: 512,
  maxTerms: 16,
  defaultLimit: 20,
  maxLimit: 50,
  /** Candidates per half before fusion. */
  candidatesPerHalf: 100,
  /** Reciprocal rank fusion constant. */
  rrfK: 60,
  /** Top fused hits the optional reranker rescores. */
  rerankTop: 30,
} as const;

export interface SearchRequest {
  q: string;
  limit?: number;
  /** Opaque, from a previous `OmniSearchResult.cursor`. */
  cursor?: string;
  /** Default true. Facet counting costs one aggregate query per field. */
  facets?: boolean;
}

export type FacetField = "source" | "kind" | "scope" | "author" | "workspace" | "month";

export interface FacetValue {
  value: string;
  label: string;
  count: number;
}

export interface Facet {
  field: FacetField;
  values: FacetValue[];
}

export interface OmniHit {
  documentId: string;
  source: string;
  kind: string;
  title: string;
  /** As pushed: origin-relative or absolute. */
  url: string | null;
  /**
   * Safe HTML: text is escaped and the only markup is `<mark>…</mark>` around matched terms. A
   * dense-only hit has no marks, just the opening of its best chunk.
   */
  snippet: string;
  /** Fused score, higher is better. */
  score: number;
  lexicalRank: number | null;
  denseRank: number | null;
  scope: Scope;
  scopeLabel: string | null;
  vis: Visibility;
  workspace: string | null;
  channel: string | null;
  author: string | null;
  mime: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface OmniSearchResult {
  /** What the server actually searched for, so the UI can show it as chips. */
  query: OmniQuery;
  hits: OmniHit[];
  /** Counted over the lexical/qualifier match set the caller may see; empty when not requested. */
  facets: Facet[];
  cursor: string | null;
  dense: DenseStatus;
  tookMs: number;
}

export interface DocumentText {
  documentId: string;
  source: string;
  kind: string;
  title: string;
  url: string | null;
  scope: Scope;
  scopeLabel: string | null;
  author: string | null;
  updatedAt: number;
  /** The full body, capped at `maxOpenChars`. */
  text: string;
  truncated: boolean;
}

export const MAX_OPEN_CHARS = 64 * 1024;

export interface SourceSummary {
  source: string;
  label: string;
  /** Documents this caller can see. */
  documents: number;
  lastUpdatedAt: number | null;
}

export interface IndexStats {
  documents: number;
  deletedDocuments: number;
  chunks: number;
  /** Chunks whose current revision has not been embedded yet. */
  pendingEmbeds: number;
  tombstones: number;
  scopes: number;
  principals: number;
  bySource: { source: string; documents: number }[];
}

// ---------------------------------------------------------------------------
// Callers of the SearchIndex Durable Object
// ---------------------------------------------------------------------------

/**
 * Who is asking. The DO turns this into the ACL: the scope list that pre-filters both halves and the
 * post-filter that runs after fusion.
 *
 *   person     a verified Access `sub`: `vis:"all"` plus every scope listing them in `principals`
 *   delegated  a source that resolved its own ACL (chat, phase 1): exactly `scopes`, restricted to
 *              `<source>:` — never `vis:"all"` from other sources
 *   agent      an agent account: `vis:"all"` plus `account:<accountId>`
 */
export type SearchCaller =
  | { kind: "person"; principal: Principal }
  | { kind: "delegated"; source: string; scopes: Scope[] }
  | { kind: "agent"; accountId: string };

/**
 * The SearchIndex DO's RPC surface (`env.SEARCH_INDEX.get(idFromName(INDEX_NAME))`). The Worker
 * entrypoints, the HTTP handler, the vendor session and the queue consumer all go through it; the
 * queue-consumer methods (`claimChunks`, `markEmbedded`) are not part of this public interface.
 */
export interface SearchIndexApi {
  /** `source` comes from the binding's props, never from the batch. */
  ingest(source: string, batch: IngestBatch): Promise<IngestResult>;
  search(caller: SearchCaller, request: SearchRequest): Promise<OmniSearchResult>;
  denseRecall(caller: SearchCaller & { kind: "delegated" }, request: DenseRecallRequest): Promise<DenseRecallResult>;
  /** Null when the document does not exist, is deleted, or the caller may not see it. */
  open(caller: SearchCaller, documentId: string): Promise<DocumentText | null>;
  sources(caller: SearchCaller): Promise<SourceSummary[]>;
  stats(): Promise<IndexStats>;
  /** Re-queues every chunk whose current revision is not embedded. Returns how many. */
  requeuePending(): Promise<number>;
}

/** The one SearchIndex instance. */
export const INDEX_NAME = "main";

/** Thrown (by message prefix, since RPC loses the class) for caller mistakes. */
export const INPUT_ERROR_PREFIX = "search: invalid input: ";

// ---------------------------------------------------------------------------
// Dense index
// ---------------------------------------------------------------------------

export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
export const EMBED_DIMENSIONS = 768;
/** Fixed for the life of the index: cls and mean embeddings are not interchangeable. */
export const EMBED_POOLING = "cls";
/** Bump with any change to model, pooling or chunking; chunks record it as `embed_revision`. */
export const EMBED_REVISION = 1;
export const RERANK_MODEL = "@cf/baai/bge-reranker-base";

/**
 * The six Vectorize metadata indexes, all strings. They must exist before the first upsert
 * (`pnpm search:provision` creates them); a seventh means a rebuild.
 */
export const VECTOR_METADATA_INDEXES = ["scope", "vis", "source", "kind", "author", "day"] as const;

/** Vector metadata. Chunk text lives in SQL, never here. `day` is a `YYYY-MM` bucket. */
export interface VectorMetadata {
  scope: Scope;
  vis: Visibility;
  source: string;
  kind: string;
  author: string;
  day: string;
}

/** Target chunk size in approximate tokens, with 15% overlap, on paragraph boundaries. */
export const CHUNK_TOKENS = 400;
export const CHUNK_OVERLAP = 0.15;

/** One queue message: chunk ids whose current revision needs an embedding. */
export interface EmbedMessage {
  chunkIds: string[];
}

// ---------------------------------------------------------------------------
// HTTP (browser -> /gatekeeper/search/api/*)
// ---------------------------------------------------------------------------

export const SEARCH_PREFIX = "/gatekeeper/search";
export const API_PREFIX = `${SEARCH_PREFIX}/api`;
export const APP_BASE = `${SEARCH_PREFIX}/`;

/**
 * GET  /api/me                   -> Me
 * GET  /api/search?q=&cursor=&limit=&facets=0   -> OmniSearchResult
 * GET  /api/sources              -> { sources: SourceSummary[] }
 * GET  /api/documents/:id        -> DocumentText   (id URL-encoded; 404 when not visible)
 * GET  /api/admin/stats          -> IndexStats     (admins only, else 403)
 * POST /api/admin/requeue        -> { queued: number } (admins only; Origin-checked)
 *
 * Errors: `{ error: { code, message } }` with 400 invalid_request, 401 unauthenticated,
 * 403 forbidden, 404 not_found, 429 rate_limited, 500 internal.
 */
export interface Me {
  id: Principal;
  email: string;
  isAdmin: boolean;
}

export type ErrorCode =
  | "invalid_request"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "internal";

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string };
}

// ---------------------------------------------------------------------------
// Agent session (src/vendor/)
// ---------------------------------------------------------------------------

/** What a gadget or the agent pushes through `SearchSession.put()`. */
export interface GadgetDocument {
  /** The gadget's own id for the document; stored as `gadget:<accountId>:<externalId>`. */
  externalId: string;
  kind: string;
  title: string;
  body: string;
  url?: string | null;
  workspace?: string | null;
  mime?: string | null;
  /** Epoch ms; defaults to now. */
  updatedAt?: number;
}

export const SESSION_LIMITS = {
  defaultLimit: 10,
  maxLimit: 25,
  maxExternalIdChars: 200,
} as const;
