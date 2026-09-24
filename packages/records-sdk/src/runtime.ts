// The hand-written half of the TypeScript SDK: transport, retries and errors. The generated client
// (src/generated/client.ts) describes each operation; this file decides how to call it, from the
// operation's `x-records-*` extensions in the OpenAPI document (canonical plan §7):
//
//   * Idempotency keys are sent automatically on every keyed mutation (`idempotency: "key"`): one key
//     per logical call, reused on every retry of that call, so a retry replays rather than repeats.
//   * Only idempotent calls are retried: reads ("safe"), keyed mutations ("key") and sync push
//     ("natural", idempotent by client and mutation id). An operation with no idempotency guarantee
//     would never be retried (the current API has none).
//   * Retried on network errors, 429, 502, 503 and 504, honouring Retry-After (seconds or an HTTP
//     date), otherwise exponential backoff with full jitter.
//   * 412 surfaces as RevisionConflictError with `currentRevision` from the ETag; every other problem
//     document as RecordsApiError with its stable `code`.

export type Idempotency = "safe" | "key" | "natural";
export type Pagination =
  | { style: "cursor"; cursorParam: string; nextField: string; itemsField: string }
  | { style: "seq"; afterParam: string; nextField: string; itemsField: string; headField: string };

export type OperationSpec = {
  readonly method: string;
  readonly path: string;
  readonly idempotency: Idempotency;
  readonly ifMatch: boolean;
  readonly pagination: Pagination | null;
};

/** A revision number, or the ETag string (`"r3"`) as read. */
export type IfMatch = number | string;

export type CallOptions = { signal?: AbortSignal; headers?: Record<string, string> };
export type WriteOptions = CallOptions & { idempotencyKey?: string };

export type RetryPolicy = {
  /** Retries after the first attempt (default 3). */
  maxRetries: number;
  /** First backoff step in ms (default 250); doubles per attempt, full jitter. */
  baseDelayMs: number;
  /** Upper bound for any single wait, including Retry-After (default 30 s). */
  maxDelayMs: number;
};

export type RecordsClientOptions = {
  /** Service origin, e.g. `https://records.example.com`. */
  baseUrl: string;
  /** The datastore the credential is bound to. */
  datastoreId: string;
  /** `rk1_…` credential or a delegated token (sent as `Authorization: Bearer`). */
  credential: string;
  /** Access assertion for the API audience (`Cf-Access-Jwt-Assertion`), when required. */
  accessAssertion?: string | (() => string | Promise<string>);
  /** Extra headers on every request (e.g. Access service-token headers at the edge). */
  headers?: Record<string, string>;
  retry?: Partial<RetryPolicy>;
  /** Fetch implementation (default: global fetch). */
  fetch?: (request: Request) => Promise<Response>;
  /** Waits between retries (tests inject a fake). */
  sleep?: (ms: number) => Promise<void>;
  /** Idempotency-key factory (default: crypto.randomUUID). */
  idempotencyKey?: () => string;
};

export type Problem = { type: string; title: string; status: number; code: string; detail?: string; issues?: { path: string; message: string }[] };

/** A problem document from the API (or a non-JSON error response). */
export class RecordsApiError extends Error {
  override name = "RecordsApiError";
  readonly status: number;
  readonly code: string;
  readonly problem: Problem | null;
  readonly headers: Headers;

  constructor(status: number, problem: Problem | null, headers: Headers) {
    super(problem ? `${problem.code}: ${problem.detail ?? problem.title}` : `HTTP ${status}`);
    this.status = status;
    this.code = problem?.code ?? `http_${status}`;
    this.problem = problem;
    this.headers = headers;
  }
}

/** 412: the record changed since it was read. Re-read (or use `currentRevision`), merge, retry. */
export class RevisionConflictError extends RecordsApiError {
  override name = "RevisionConflictError";
  /** The record's current revision, from the response's ETag (null when absent). */
  readonly currentRevision: number | null;

  constructor(status: number, problem: Problem | null, headers: Headers) {
    super(status, problem, headers);
    this.currentRevision = revisionOf(headers.get("etag"));
  }
}

/** The request never produced a response (after retries, when the call was retryable). */
export class RecordsNetworkError extends Error {
  override name = "RecordsNetworkError";
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

export function revisionOf(etag: string | null): number | null {
  const m = etag ? /^(?:W\/)?"r(\d+)"$/.exec(etag.trim()) : null;
  return m ? Number(m[1]) : null;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/** Retry-After as milliseconds: delta-seconds or an HTTP date. Null when absent or malformed. */
export function retryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class BaseClient {
  readonly baseUrl: string;
  readonly datastoreId: string;
  readonly #opts: RecordsClientOptions;
  readonly #retry: RetryPolicy;

  constructor(opts: RecordsClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.datastoreId = opts.datastoreId;
    this.#opts = opts;
    this.#retry = { maxRetries: 3, baseDelayMs: 250, maxDelayMs: 30_000, ...opts.retry };
  }

  protected async call<T>(
    op: OperationSpec,
    pathParams: Record<string, string>,
    query: Record<string, unknown> | undefined,
    body: unknown,
    options: WriteOptions & { ifMatch?: IfMatch },
  ): Promise<T> {
    const response = await this.send(op, pathParams, query, body, options);
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  /** Walk every page of a paginated operation, yielding items. */
  protected async *paginate<T>(op: OperationSpec, pathParams: Record<string, string>, query: Record<string, unknown>, options: CallOptions): AsyncGenerator<T> {
    const p = op.pagination;
    if (!p) throw new Error("not a paginated operation");
    let q: Record<string, unknown> = { ...query };
    for (;;) {
      const page = await this.call<Record<string, unknown>>(op, pathParams, q, undefined, options);
      const items = (page[p.itemsField] ?? []) as T[];
      for (const item of items) yield item;
      const next = page[p.nextField];
      if (p.style === "cursor") {
        if (typeof next !== "string" || !next) return;
        q = { ...q, [p.cursorParam]: next };
      } else {
        // `seq` style: stop when a page brings nothing new (caught up with the head).
        if (items.length === 0 || next === q[p.afterParam]) return;
        q = { ...q, [p.afterParam]: next };
      }
    }
  }

  protected url(op: OperationSpec, pathParams: Record<string, string>, query?: Record<string, unknown>): string {
    const path = op.path.replace(/\{(\w+)\}/g, (_, name: string) => {
      const value = name === "datastoreId" ? this.datastoreId : pathParams[name];
      if (value === undefined) throw new Error(`missing path parameter ${name}`);
      return encodeURIComponent(value);
    });
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    return url.toString();
  }

  protected async send(
    op: OperationSpec,
    pathParams: Record<string, string>,
    query: Record<string, unknown> | undefined,
    body: unknown,
    options: WriteOptions & { ifMatch?: IfMatch },
  ): Promise<Response> {
    const url = this.url(op, pathParams, query);
    const headers: Record<string, string> = { accept: "application/json", ...this.#opts.headers, ...options.headers };
    headers.authorization = `Bearer ${this.#opts.credential}`;
    const assertion = typeof this.#opts.accessAssertion === "function" ? await this.#opts.accessAssertion() : this.#opts.accessAssertion;
    if (assertion) headers["cf-access-jwt-assertion"] = assertion;
    if (op.idempotency === "key") headers["idempotency-key"] = options.idempotencyKey ?? (this.#opts.idempotencyKey ?? (() => crypto.randomUUID()))();
    if (op.ifMatch) {
      if (options.ifMatch === undefined) throw new TypeError("This operation needs ifMatch: the revision (or ETag) you last read.");
      headers["if-match"] = typeof options.ifMatch === "number" ? `"r${options.ifMatch}"` : options.ifMatch;
    }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) headers["content-type"] = "application/json";

    const retryable = op.idempotency === "safe" || op.idempotency === "key" || op.idempotency === "natural";
    const doFetch = this.#opts.fetch ?? ((r: Request) => fetch(r));
    const sleep = this.#opts.sleep ?? defaultSleep;
    for (let attempt = 0; ; attempt++) {
      const canRetry = retryable && attempt < this.#retry.maxRetries;
      let response: Response;
      try {
        response = await doFetch(new Request(url, { method: op.method, headers, ...(payload !== undefined ? { body: payload } : {}), ...(options.signal ? { signal: options.signal } : {}) }));
      } catch (err) {
        if (options.signal?.aborted) throw err;
        if (!canRetry) throw new RecordsNetworkError(err instanceof Error ? err.message : String(err), err);
        await sleep(this.#backoff(attempt));
        continue;
      }
      if (response.ok) return response;
      if (canRetry && RETRYABLE_STATUS.has(response.status)) {
        const wait = retryAfterMs(response.headers.get("retry-after"));
        await response.body?.cancel().catch(() => {});
        await sleep(Math.min(wait ?? this.#backoff(attempt), this.#retry.maxDelayMs));
        continue;
      }
      throw await errorFrom(response);
    }
  }

  #backoff(attempt: number): number {
    return Math.random() * Math.min(this.#retry.maxDelayMs, this.#retry.baseDelayMs * 2 ** attempt);
  }
}

async function errorFrom(response: Response): Promise<RecordsApiError> {
  let problem: Problem | null = null;
  try {
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as Problem) : null;
    if (parsed && typeof parsed === "object" && typeof parsed.code === "string") problem = parsed;
  } catch {
    // not a problem document
  }
  return response.status === 412 ? new RevisionConflictError(response.status, problem, response.headers) : new RecordsApiError(response.status, problem, response.headers);
}
