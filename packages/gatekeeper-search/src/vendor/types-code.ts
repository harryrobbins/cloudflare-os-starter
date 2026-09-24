// The agent-facing declarations, as a string, for `getTypeScriptTypes()`.
//
// A hand-kept mirror of `./types.d.ts`, byte for byte, as in packages/gatekeeper-chat: a `.d.ts`
// cannot be imported as text without a bundler rule. `__tests__/vendor.test.ts` compares this string
// against the raw file, so the two cannot drift. Only backticks are escaped.

const TYPES_CODE = `/**
 * Omni-search, as the CloudflareOS agent sees it.
 *
 * One index over this deployment's shared content: public team-chat channels, public Context
 * Library collections, and whatever this workspace's gadgets have indexed through \`put()\`. Results
 * are ranked by meaning as well as by words. It is published verbatim by \`getTypeScriptTypes()\`, so
 * every comment here is written for the caller.
 *
 * You see deployment-public content plus documents pushed through your own account. Private
 * channels, direct messages and other people's private documents are never visible here.
 */

/** One search result. */
export interface SearchHit {
  /** Opaque id. Pass it to \`open()\` to read the whole document or to \`cite()\` for a link. */
  readonly documentId: string;
  /** Where it came from: "chat", "context" or "gadget". */
  readonly source: string;
  /** What it is within its source, for example "message", "doc", "sheet" or "slides". */
  readonly kind: string;
  readonly title: string;
  /** An absolute link a person can open, or null when the document has none. */
  readonly url: string | null;
  /** A short plain-text excerpt around the match. */
  readonly excerpt: string;
  /** For example "#general" for a chat channel. */
  readonly container: string | null;
  readonly author: string | null;
  /** Last change, in milliseconds since the epoch. */
  readonly updatedAt: number;
  /** "words", "meaning" or "both": which half of the hybrid index found it. */
  readonly matchedBy: "words" | "meaning" | "both";
}

export interface SearchAnswer {
  readonly hits: SearchHit[];
  /** Pass back as \`cursor\` for the next page; null when there are no more. */
  readonly cursor: string | null;
  /**
   * The qualifiers the index applied, echoed back so you can tell what was searched. Supported:
   * \`in:#channel\`, \`from:name\`, \`source:chat|context|gadget\`, \`kind:doc\`, \`workspace:<id>\`,
   * \`before:YYYY-MM-DD\`, \`after:YYYY-MM-DD\`, \`on:YYYY-MM-DD\`. Everything else is search text.
   */
  readonly interpreted: string;
  /**
   * False when meaning-based search was unavailable and only word matches were returned. Content
   * written in the last few seconds may also be findable by words before it is findable by meaning.
   */
  readonly semantic: boolean;
}

/** A count of matching documents per value of one field, for narrowing a search. */
export interface SearchFacet {
  readonly field: "source" | "kind" | "scope" | "author" | "workspace" | "month";
  readonly values: { readonly value: string; readonly label: string; readonly count: number }[];
}

/** The full text of one document. */
export interface SearchDocument {
  readonly documentId: string;
  readonly source: string;
  readonly kind: string;
  readonly title: string;
  readonly url: string | null;
  readonly container: string | null;
  readonly author: string | null;
  readonly updatedAt: number;
  /** Plain text, at most 64 KiB. */
  readonly text: string;
  /** True when \`text\` was cut at the 64 KiB cap. */
  readonly truncated: boolean;
}

/** A document a gadget indexes so that it becomes findable through this session. */
export interface IndexableDocument {
  /** The gadget's own stable id for the document, at most 200 characters. Re-use it to update. */
  readonly externalId: string;
  /** For example "doc", "sheet", "slides" or "note". */
  readonly kind: string;
  readonly title: string;
  /** Plain text; long bodies are chunked, and anything past 256 KiB is dropped. */
  readonly body: string;
  /** Optional link a person can open. */
  readonly url?: string | null;
  /** Optional workspace id, for the \`workspace:\` qualifier. */
  readonly workspace?: string | null;
  readonly mime?: string | null;
  /** Last change, in milliseconds since the epoch; defaults to now. */
  readonly updatedAt?: number;
}

export interface SearchSession {
  /**
   * Hybrid search. \`query\` is free text plus optional qualifiers (see \`SearchAnswer.interpreted\`).
   * \`limit\` defaults to 10, at most 25.
   */
  search(query: string, options?: { limit?: number; cursor?: string }): Promise<SearchAnswer>;
  /** Counts of matching documents by source, kind, container, author, workspace and month. */
  facets(query: string): Promise<SearchFacet[]>;
  /** The full text of one document from \`search()\`; null when it no longer exists. */
  open(documentId: string): Promise<SearchDocument | null>;
  /** A title and absolute link for citing a document to a person. */
  cite(documentId: string): Promise<{ title: string; url: string | null }>;
  /**
   * Indexes (or re-indexes) a document so later searches through this account find it. Other
   * people's searches never see it. Submitted as an action you may be asked to approve; it becomes
   * searchable a few seconds after it is applied.
   */
  put(document: IndexableDocument): Promise<void>;
  /** Removes a document previously indexed with \`put()\`. Also an action. */
  remove(externalId: string): Promise<void>;
}
`;

export default TYPES_CODE;
