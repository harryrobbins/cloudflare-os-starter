// `SearchSession`: what the agent (and a gadget's server code) can do with the omni-search index.
//
// Reads are observations: the index is queried first, so the description can say what was found, and
// `authorizeObservation()` is awaited before a single row is returned. `put()` and `remove()` change
// the index, so they are actions: submitted to the queue, performed only when `applyAction()` arrives,
// and marked auto-approvable so a person can opt in once instead of approving every save.
//
// The caller is `{kind: "agent", accountId: partition}`, where the partition is a random id this
// workspace's facet minted for itself (gatekeeper.ts). The index grants such a caller `vis:"all"`
// plus `account:<partition>`, so a gadget's pushes are findable from its own workspace and nowhere
// else: not by other workspaces of the same owner, and never by people in the search app.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ActionKind, ApprovalQueue, ObservationAuthorizer } from "@gadgets/workshop-shared/gatekeeper";

import {
  SESSION_LIMITS,
  SOURCE_LABELS,
  type DocumentText,
  type IngestBatch,
  type IngestDocument,
  type OmniHit,
  type OmniQuery,
  type SearchCaller,
  type SearchIndexApi,
} from "../shared/contract.js";
import type {
  IndexableDocument,
  SearchAnswer,
  SearchDocument,
  SearchFacet,
  SearchHit,
  SearchSession,
} from "./types.js";

/** The one action kind this gatekeeper submits. Auto-approvable: it only affects this workspace's own results. */
export const SEARCH_INDEX_ACTION: ActionKind = {
  tag: "search.index",
  label: "Index workspace content for search",
};

/** The slice of the index a session uses, so a test can supply a fake. */
export type SessionIndex = Pick<SearchIndexApi, "search" | "open" | "sources" | "ingest">;

/** The slice of the approval queue a session needs. */
export type SearchApprovalQueue = Pick<ApprovalQueue, "authorizeObservation" | "submitAction"> &
  Partial<{ [Symbol.dispose](): void }>;

/** An index change submitted for approval, kept until `applyAction()` or `rejectAction()`. */
export type PendingIndexChange =
  | { readonly op: "put"; readonly document: IngestDocument; readonly submittedAt: number }
  | { readonly op: "remove"; readonly documentId: string; readonly submittedAt: number };

/** Where pending and applied changes live between RPC calls (the facet's KV in production). */
export interface SearchActionStore {
  nextActionId(): number;
  putPending(action: number, change: PendingIndexChange): void;
  getPending(action: number): PendingIndexChange | undefined;
  deletePending(action: number): void;
  putApplied(action: number, change: PendingIndexChange): void;
  getApplied(action: number): PendingIndexChange | undefined;
  deleteApplied(action: number): void;
}

export type SearchSessionDependencies = {
  readonly approvalQueue: SearchApprovalQueue;
  readonly index: SessionIndex;
  readonly actions: Pick<SearchActionStore, "nextActionId" | "putPending" | "deletePending">;
  /** This workspace's partition: the `accountId` of the agent caller. */
  readonly partition: string;
  /** For turning origin-relative document urls into links a person can open. */
  readonly publicBaseUrl: string;
  readonly now?: () => number;
};

/** The gadget source's scope for one partition. */
export function partitionScope(partition: string): string {
  return `account:${partition}`;
}

/** The document id a gadget's `externalId` is stored under. */
export function gadgetDocumentId(partition: string, externalId: string): string {
  return `gadget:${partition}:${externalId}`;
}

@validateRpc()
export class SearchSessionImpl extends RpcTarget implements SearchSession {
  readonly #approvalQueue: SearchApprovalQueue;
  readonly #index: SessionIndex;
  readonly #actions: SearchSessionDependencies["actions"];
  readonly #partition: string;
  readonly #publicBaseUrl: string;
  readonly #now: () => number;

  constructor(dependencies: SearchSessionDependencies) {
    super();
    this.#approvalQueue = dependencies.approvalQueue;
    this.#index = dependencies.index;
    this.#actions = dependencies.actions;
    this.#partition = dependencies.partition;
    this.#publicBaseUrl = dependencies.publicBaseUrl;
    this.#now = dependencies.now ?? Date.now;
  }

  async search(query: string, options?: { limit?: number; cursor?: string }): Promise<SearchAnswer> {
    return runSearch(this.#index, this.#caller(), this.#approvalQueue, this.#publicBaseUrl, query, options);
  }

  async facets(query: string): Promise<SearchFacet[]> {
    const result = await this.#index.search(this.#caller(), { q: query, limit: 1, facets: true });
    await this.#approvalQueue.authorizeObservation({
      title: "Count search matches",
      description:
        `Count documents matching \`${oneLine(query)}\` in this deployment's omni-search index, by ` +
        "source, kind, container, author, workspace and month. Only deployment-public content and " +
        "documents this workspace indexed are counted.",
    });
    return result.facets;
  }

  async open(documentId: string): Promise<SearchDocument | null> {
    const document = await this.#index.open(this.#caller(), documentId);
    if (document === null) return null;
    await this.#approvalQueue.authorizeObservation({
      title: `Read "${oneLine(document.title)}"`,
      description:
        `Read the full text of "${oneLine(document.title)}" (${describeSource(document.source)}` +
        `${document.scopeLabel ? `, ${document.scopeLabel}` : ""}) from this deployment's ` +
        "omni-search index.",
    });
    return toSearchDocument(document, this.#publicBaseUrl);
  }

  async cite(documentId: string): Promise<{ title: string; url: string | null }> {
    const document = await this.#index.open(this.#caller(), documentId);
    if (document === null) throw new Error(`No document ${documentId} is visible to this workspace.`);
    await this.#approvalQueue.authorizeObservation({
      title: `Cite "${oneLine(document.title)}"`,
      description: `Look up the title and link of "${oneLine(document.title)}" for a citation.`,
    });
    return { title: document.title, url: absoluteUrl(document.url, this.#publicBaseUrl) };
  }

  async put(document: IndexableDocument): Promise<void> {
    const prepared = prepareGadgetDocument(document, this.#partition, this.#now());
    const action = this.#actions.nextActionId();
    const change: PendingIndexChange = { op: "put", document: prepared, submittedAt: this.#now() };
    this.#actions.putPending(action, change);
    try {
      await this.#approvalQueue.submitAction(action, {
        title: `Index "${oneLine(prepared.title)}" for search`,
        description:
          `Add the ${prepared.kind} "${oneLine(prepared.title)}" (${prepared.body.length} characters) ` +
          "to this deployment's omni-search index, so that searches from **this workspace** can find " +
          "it. People searching elsewhere, and other workspaces, never see it. Reverting removes it " +
          "from the index again.",
        implementsRevert: true,
        autoApprovable: true,
        actionKind: SEARCH_INDEX_ACTION,
      });
    } catch (error) {
      this.#actions.deletePending(action);
      throw error;
    }
  }

  async remove(externalId: string): Promise<void> {
    const documentId = gadgetDocumentId(this.#partition, checkExternalId(externalId));
    const action = this.#actions.nextActionId();
    this.#actions.putPending(action, { op: "remove", documentId, submittedAt: this.#now() });
    try {
      await this.#approvalQueue.submitAction(action, {
        title: `Remove "${oneLine(externalId)}" from search`,
        description:
          `Remove the document \`${oneLine(externalId)}\` that this workspace indexed from the ` +
          "omni-search index.",
        implementsRevert: false,
        autoApprovable: true,
        actionKind: SEARCH_INDEX_ACTION,
      });
    } catch (error) {
      this.#actions.deletePending(action);
      throw error;
    }
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]?.();
  }

  #caller(): SearchCaller {
    return { kind: "agent", accountId: this.#partition };
  }
}

// ---------------------------------------------------------------------------
// Shared by the session and the `/find` slash command
// ---------------------------------------------------------------------------

export async function runSearch(
  index: Pick<SearchIndexApi, "search">,
  caller: SearchCaller,
  authorizer: Pick<ObservationAuthorizer, "authorizeObservation">,
  publicBaseUrl: string,
  query: string,
  options?: { limit?: number; cursor?: string },
): Promise<SearchAnswer> {
  const limit = boundedLimit(options?.limit);
  const result = await index.search(caller, {
    q: query,
    limit,
    facets: false,
    ...(options?.cursor === undefined ? {} : { cursor: options.cursor }),
  });
  const hits = result.hits.map((hit) => toSearchHit(hit, publicBaseUrl));
  const sources = [...new Set(hits.map((hit) => describeSource(hit.source)))];
  await authorizer.authorizeObservation({
    title: `Search for "${oneLine(query)}"`,
    description:
      `Search this deployment's omni-search index for \`${oneLine(query)}\` and read the titles and ` +
      `excerpts of ${hits.length} result${hits.length === 1 ? "" : "s"}` +
      `${sources.length > 0 ? ` from ${sources.join(", ")}` : ""}. Only deployment-public content ` +
      "and documents this workspace indexed are searched.",
  });
  return {
    hits,
    cursor: result.cursor,
    interpreted: describeQuery(result.query),
    semantic: result.dense === "ok",
  };
}

export function boundedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return SESSION_LIMITS.defaultLimit;
  return Math.max(1, Math.min(SESSION_LIMITS.maxLimit, Math.floor(limit)));
}

export function toSearchHit(hit: OmniHit, publicBaseUrl: string): SearchHit {
  return {
    documentId: hit.documentId,
    source: hit.source,
    kind: hit.kind,
    title: hit.title,
    url: absoluteUrl(hit.url, publicBaseUrl),
    excerpt: plainSnippet(hit.snippet),
    container: hit.scopeLabel,
    author: hit.author,
    updatedAt: hit.updatedAt,
    matchedBy:
      hit.lexicalRank !== null && hit.denseRank !== null
        ? "both"
        : hit.denseRank !== null
          ? "meaning"
          : "words",
  };
}

function toSearchDocument(document: DocumentText, publicBaseUrl: string): SearchDocument {
  return {
    documentId: document.documentId,
    source: document.source,
    kind: document.kind,
    title: document.title,
    url: absoluteUrl(document.url, publicBaseUrl),
    container: document.scopeLabel,
    author: document.author,
    updatedAt: document.updatedAt,
    text: document.text,
    truncated: document.truncated,
  };
}

/** The server's snippet is escaped HTML with `<mark>` only; the agent wants plain text. */
export function plainSnippet(snippet: string): string {
  return snippet
    .replace(/<\/?mark>/gu, "")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&#x27;/gu, "'")
    .replace(/&amp;/gu, "&");
}

/** Origin-relative urls become absolute under the deployment; anything else passes if it is http(s). */
export function absoluteUrl(url: string | null, publicBaseUrl: string): string | null {
  if (url === null || url.length === 0) return null;
  try {
    const resolved = new URL(url, publicBaseUrl);
    return resolved.protocol === "https:" || resolved.protocol === "http:" ? resolved.toString() : null;
  } catch {
    return null;
  }
}

/** Renders the parsed query back into the qualifier syntax. */
export function describeQuery(query: OmniQuery): string {
  const parts: string[] = [];
  if (query.text.length > 0) parts.push(query.text);
  for (const scope of query.in ?? []) parts.push(`in:${scope}`);
  for (const name of query.from ?? []) parts.push(`from:${name}`);
  for (const source of query.source ?? []) parts.push(`source:${source}`);
  for (const kind of query.kind ?? []) parts.push(`kind:${kind}`);
  for (const workspace of query.workspace ?? []) parts.push(`workspace:${workspace}`);
  if (query.after !== undefined) parts.push(`after:${isoDay(query.after)}`);
  if (query.before !== undefined) parts.push(`before:${isoDay(query.before)}`);
  return parts.join(" ");
}

export function describeSource(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

function isoDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function checkExternalId(externalId: string): string {
  if (typeof externalId !== "string" || externalId.length === 0) {
    throw new Error("externalId must be a non-empty string.");
  }
  if (externalId.length > SESSION_LIMITS.maxExternalIdChars) {
    throw new Error(`externalId is at most ${SESSION_LIMITS.maxExternalIdChars} characters.`);
  }
  return externalId;
}

/** Validates a gadget's document and maps it onto the index's ingest shape. */
export function prepareGadgetDocument(
  document: IndexableDocument,
  partition: string,
  now: number,
): IngestDocument {
  if (document === null || typeof document !== "object") throw new Error("put() needs a document.");
  const externalId = checkExternalId(document.externalId);
  for (const field of ["kind", "title", "body"] as const) {
    if (typeof document[field] !== "string") throw new Error(`${field} must be a string.`);
  }
  if (document.kind.trim().length === 0) throw new Error("kind must not be empty.");
  const updatedAt =
    typeof document.updatedAt === "number" && Number.isFinite(document.updatedAt) ? document.updatedAt : now;
  return {
    id: gadgetDocumentId(partition, externalId),
    kind: document.kind.trim().slice(0, 40),
    title: document.title.trim().length > 0 ? document.title : externalId,
    url: typeof document.url === "string" ? document.url : null,
    scope: partitionScope(partition),
    vis: "scoped",
    body: document.body,
    workspace: typeof document.workspace === "string" ? document.workspace : null,
    mime: typeof document.mime === "string" ? document.mime : null,
    createdAt: updatedAt,
    updatedAt,
  };
}

/** The ingest batch that performs an approved change. */
export function batchFor(change: PendingIndexChange, partition: string): IngestBatch {
  if (change.op === "remove") return { deletes: [change.documentId] };
  return {
    scopes: [{ scope: partitionScope(partition), label: "This workspace", vis: "scoped" }],
    upserts: [change.document],
  };
}
