// The browser's view of `/gatekeeper/search/api/*` (contract.ts, "HTTP"). Every request goes through
// `request()`, which turns any failure into an `ApiError` with a contract `ErrorCode`, so components
// never inspect a Response.

import {
  API_PREFIX,
  type DocumentText,
  type ErrorCode,
  type IndexStats,
  type Me,
  type OmniSearchResult,
  type SearchRequest,
  type SourceSummary,
} from "../contract.js";

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    /** HTTP status; 0 for a network failure. */
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface SearchApi {
  me(signal?: AbortSignal): Promise<Me>;
  search(request: SearchRequest, signal?: AbortSignal): Promise<OmniSearchResult>;
  sources(signal?: AbortSignal): Promise<SourceSummary[]>;
  document(id: string, signal?: AbortSignal): Promise<DocumentText>;
  stats(signal?: AbortSignal): Promise<IndexStats>;
  requeue(): Promise<number>;
}

const STATUS_CODES: Readonly<Record<number, ErrorCode>> = {
  400: "invalid_request",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  429: "rate_limited",
};

const KNOWN_CODES = new Set<string>([
  "invalid_request",
  "unauthenticated",
  "forbidden",
  "not_found",
  "rate_limited",
  "internal",
]);

function codeFor(code: unknown, status: number): ErrorCode {
  if (typeof code === "string" && KNOWN_CODES.has(code)) return code as ErrorCode;
  return STATUS_CODES[status] ?? "internal";
}

/** Builds `?a=1&b=2`, skipping undefined values. */
export function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered.length > 0 ? `?${rendered}` : "";
}

export interface HttpApiOptions {
  fetch?: typeof fetch;
  /** Defaults to the contract's `API_PREFIX`. */
  base?: string;
}

export function createHttpApi(options: HttpApiOptions = {}): SearchApi {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const base = options.base ?? API_PREFIX;

  async function request<T>(method: "GET" | "POST", path: string, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: { accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        // Access sign-in is a redirect to another origin; follow it and a fetch fails with a
        // TypeError that looks like being offline. `manual` turns it into an opaque redirect we can
        // recognise as "signed out".
        redirect: "manual",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
      throw new ApiError("internal", "The network is unavailable. Check your connection and try again.", 0);
    }

    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      throw new ApiError("unauthenticated", "Your session has expired.", 401);
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }

    if (!response.ok) {
      const envelope =
        typeof parsed === "object" && parsed !== null && "error" in parsed
          ? (parsed as { error?: { code?: unknown; message?: unknown } }).error
          : undefined;
      const message =
        typeof envelope?.message === "string" && envelope.message.length > 0
          ? envelope.message
          : `Request failed (${response.status}).`;
      throw new ApiError(codeFor(envelope?.code, response.status), message, response.status);
    }
    if (parsed === undefined) {
      throw new ApiError("internal", "The server sent an unreadable response.", response.status);
    }
    return parsed as T;
  }

  return {
    me: (signal) => request<Me>("GET", "/me", signal),
    search: (req, signal) =>
      request<OmniSearchResult>(
        "GET",
        `/search${queryString({
          q: req.q,
          cursor: req.cursor,
          limit: req.limit,
          facets: req.facets === false ? 0 : 1,
        })}`,
        signal,
      ),
    sources: async (signal) =>
      (await request<{ sources: SourceSummary[] }>("GET", "/sources", signal)).sources,
    document: (id, signal) => request<DocumentText>("GET", `/documents/${encodeURIComponent(id)}`, signal),
    stats: (signal) => request<IndexStats>("GET", "/admin/stats", signal),
    requeue: async () => (await request<{ queued: number }>("POST", "/admin/requeue")).queued,
  };
}

/** A short, human message for an error, with the code-specific wording the UI uses everywhere. */
export function describeError(error: unknown): { message: string; signIn: boolean } {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "unauthenticated":
        return { message: "Your session has expired.", signIn: true };
      case "forbidden":
        return { message: error.message || "You don't have access to that.", signIn: false };
      case "rate_limited":
        return { message: "Too many searches at once. Wait a moment and try again.", signIn: false };
      default:
        return { message: error.message, signIn: false };
    }
  }
  return { message: error instanceof Error ? error.message : "Something went wrong.", signIn: false };
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
