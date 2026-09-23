// Privacy-gated web search and fetch. Every query and URL passes the gate in classifier/ before
// it leaves: pattern-proven identifiers and secrets are refused without Jev ever seeing them, Jev
// decides the rest, and anything Jev is unsure about waits for the user's explicit approval.
// Plan: docs/plans/web-search-gatekeeper.md

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ActionKind,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { detect, redact, type DetectorConfig } from "./classifier/detectors.js";
import { normalize } from "./classifier/normalize.js";
import { checkQuery, checkUrl, refusalMessage, type GateDecision } from "./classifier/gate.js";
import { fetchPage, parseFetchUrl, type FetchedPage } from "./fetch-page.js";
import { openRouterSearch, type SearchResult } from "./search.js";
import type {
  WebFetchResponse,
  WebGateCheck,
  WebPending,
  WebResult,
  WebSearchResponse,
  WebSearchSession,
} from "./types.js";
import TYPES_CODE from "./types-code.js";

const ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='none' stroke='currentColor' stroke-width='16'><circle cx='112' cy='112' r='72'/><path d='m164 164 52 52'/><path d='M112 76v28l20 14'/></svg>",
    ),
};

/** Recent queries shown to Jev so data split across several queries can be spotted. */
const RECENT_WINDOW_MS = 15 * 60 * 1000;
const RECENT_LIMIT = 10;
const AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RETAINED_RESULTS = 100;

type PendingRequest =
  | { kind: "search"; query: string; count?: number }
  | { kind: "fetch"; url: string; raw?: boolean; unchecked?: true };

type StoredResult =
  | { status: "ok"; results?: SearchResult[]; page?: FetchedPage }
  | { status: "rejected" }
  | { status: "failed"; message: string };

type ObservationQueue = Pick<ApprovalQueue, "authorizeObservation" | "submitAction"> &
  Partial<{ [Symbol.dispose](): void }>;

export function describeWebSearchVendor(): VendorDescription {
  return {
    displayName: "Web Search",
    url: "https://openrouter.ai/docs/guides/community/jev",
    logo: ICON,
    color: "#e9f7ef",
    tagline: "Web search and page fetches that keep private data in",
    description:
      "Searches the web and fetches pages for the agent. Every query and URL is checked first: " +
      "personal data, identifiers and secrets are refused, and anything uncertain waits for your approval.",
    autoProvisionsAccount: true,
    providesAuth: false,
  };
}

export function describeWebSearchAccount(): AccountDescription {
  return { displayName: "Web Search", avatar: ICON, singleton: { tsType: "WebSearchSession" } };
}

/** What the session needs from its Durable Object; narrow so tests can supply a fake. */
export interface WebSearchBackend {
  gate(request: PendingRequest): Promise<GateDecision>;
  run(request: PendingRequest): Promise<StoredResult & { status: "ok" }>;
  /** `decision` is null for an unchecked fetch, which skips the gate and always asks the user. */
  stagePending(request: PendingRequest, decision: GateDecision | null): number;
  unstagePending(action: number): void;
  readResult(action: number): WebResult;
}

@validateRpc()
export class WebSearchSessionImpl extends RpcTarget implements WebSearchSession {
  readonly #queue: ObservationQueue;
  readonly #backend: WebSearchBackend;

  constructor(queue: ObservationQueue, backend: WebSearchBackend) {
    super();
    this.#queue = queue;
    this.#backend = backend;
  }

  async search(query: string, options?: { count?: number }): Promise<WebSearchResponse> {
    let request: PendingRequest = { kind: "search", query, count: options?.count };
    let decision = await this.#backend.gate(request);
    if (decision.outcome === "block") throw new Error(refusalMessage(decision, "query"));
    if (decision.outcome === "review") return this.#submit({ ...request, query: decision.text }, decision);

    // Authorize before the query leaves: if the observation is refused, nothing is sent.
    await this.#queue.authorizeObservation({
      title: `Web search: ${truncate(decision.text, 80)}`,
      description: `Searched the web for \`${decision.text}\`. The privacy gate cleared it automatically.`,
    });
    let result = await this.#backend.run({ ...request, query: decision.text });
    return { status: "ok", results: result.results ?? [] };
  }

  async fetchPage(url: string, options?: { raw?: boolean }): Promise<WebFetchResponse> {
    let request: PendingRequest = { kind: "fetch", url, raw: options?.raw };
    let decision = await this.#backend.gate(request);
    if (decision.outcome === "block") throw new Error(refusalMessage(decision, "URL"));
    if (decision.outcome === "review") return this.#submit(request, decision);

    let host = new URL(decision.text).host;
    await this.#queue.authorizeObservation({
      title: `Websafe fetch: ${host}`,
      description: `GET \`${decision.text}\`. The privacy gate cleared the URL automatically.`,
    });
    let result = await this.#backend.run(request);
    return { status: "ok", page: result.page! };
  }

  async fetchUnchecked(url: string, options?: { raw?: boolean }): Promise<WebPending> {
    let parsed = parseFetchUrl(url);
    let request: PendingRequest = { kind: "fetch", url: parsed.href, raw: options?.raw, unchecked: true };
    let action = this.#backend.stagePending(request, null);
    try {
      await this.#queue.submitAction(action, {
        title: `UNSAFE web fetch: ${truncate(parsed.host, 60)}`,
        description:
          `The agent wants to fetch this URL **without the privacy check**:\n\n\`${parsed.href}\`\n\n` +
          `Anything in the address (host name, path or parameters) is sent to that site and to DNS. ` +
          `Approve only if it contains no personal data, identifiers or secrets.`,
        implementsRevert: false,
        awaitDecision: true,
        actionKind: ACTION_KINDS.unchecked,
      });
    } catch (error) {
      this.#backend.unstagePending(action);
      throw error;
    }
    return { status: "pending", action, reasons: ["unchecked"] };
  }

  async getResult(action: number): Promise<WebResult> {
    let result = this.#backend.readResult(action);
    if (result.status === "ok") {
      await this.#queue.authorizeObservation({
        title: `Read approved web result #${action}`,
        description: `Returned the result of approved request #${action}.`,
      });
    }
    return result;
  }

  async check(input: { query: string } | { url: string }): Promise<WebGateCheck> {
    let request: PendingRequest = "url" in input
      ? { kind: "fetch", url: input.url }
      : { kind: "search", query: input.query };
    let decision = await this.#backend.gate(request);
    return { outcome: decision.outcome, reasons: decision.reasons };
  }

  async #submit(request: PendingRequest, decision: GateDecision): Promise<{ status: "pending"; action: number; reasons: string[] }> {
    let action = this.#backend.stagePending(request, decision);
    let what = request.kind === "search" ? "search the web for" : "fetch";
    let shown = request.kind === "search" ? request.query : request.url;
    let why = decision.reasons.map(r => r.replace(/_/g, " ")).join(", ") || "uncertain";
    let scores = decision.jev
      ? Object.entries(decision.jev.scores).map(([k, v]) => `${k.replace(/_/g, " ")} ${v.toFixed(2)}`).join(" · ")
      : "not consulted";
    try {
      await this.#queue.submitAction(action, {
        title: request.kind === "search" ? `Web search: ${truncate(shown, 80)}` : `Websafe fetch: ${truncate(shown, 80)}`,
        description:
          `The agent wants to ${what}:\n\n\`${shown}\`\n\n` +
          `The privacy gate was not sure this is safe to send outside the organisation (${why}). ` +
          `Approve only if it contains no personal data, identifiers or secrets.\n\n` +
          `**Classifier scores (probability):** ${scores}`,
        implementsRevert: false,
        awaitDecision: true,
        actionKind: ACTION_KINDS[request.kind],
      });
    } catch (error) {
      this.#backend.unstagePending(action);
      throw error;
    }
    return { status: "pending", action, reasons: decision.reasons };
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]?.();
  }
}

const ACTION_KINDS: Record<PendingRequest["kind"] | "unchecked", ActionKind> = {
  search: { tag: "websearch.search", label: "Uncertain web searches" },
  fetch: { tag: "websearch.fetch", label: "Uncertain web fetches" },
  unchecked: { tag: "websearch.unchecked", label: "Unchecked (unsafe) web fetches" },
};

@validateRpc()
export class WebSearchGatekeeper extends DurableObject<Cloudflare.Env> implements Gatekeeper<WebSearchSession>, WebSearchBackend {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL,
        outcome TEXT NOT NULL, reasons TEXT NOT NULL, redacted TEXT NOT NULL,
        jev_id TEXT, jev_model TEXT, jev_scores TEXT, cost REAL, note TEXT);
      CREATE TABLE IF NOT EXISTS recent (at INTEGER NOT NULL, text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pending (action INTEGER PRIMARY KEY, request TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS results (action INTEGER PRIMARY KEY, result TEXT NOT NULL, at INTEGER NOT NULL);
    `);
  }

  async describe(): Promise<ResourceDescription> {
    return {
      url: "websearch://web",
      title: "Web search",
      snippet: "Privacy-gated web search and page fetches.",
      suggestedBindingName: "WEBSEARCH",
      tsType: "WebSearchSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    // Uncertain requests exist precisely so that a human decides; never auto-approvable.
    return [];
  }

  async startSession(queue: RpcStub<ApprovalQueue>): Promise<WebSearchSession> {
    return new WebSearchSessionImpl(queue.dup(), this);
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  async applyAction(action: number): Promise<void> {
    let row = this.ctx.storage.sql.exec<{ request: string }>("SELECT request FROM pending WHERE action = ?", action).toArray()[0];
    if (!row) throw new Error(`No pending web request #${action}.`);
    let request = JSON.parse(row.request) as PendingRequest;
    let result: StoredResult;
    try {
      result = await this.run(request);
    } catch (error) {
      result = { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
    this.#storeResult(action, result);
  }

  async rejectAction(action: number): Promise<void> {
    this.#storeResult(action, { status: "rejected" });
  }

  async revertAction(_action: number): Promise<{ message: string }> {
    return { message: "A web request that has been sent cannot be recalled." };
  }

  // ---- WebSearchBackend ----

  async gate(request: PendingRequest): Promise<GateDecision> {
    let ctx = {
      apiKey: this.env.OPENROUTER_API_KEY,
      detectors: this.#detectorConfig(),
      recentQueries: this.#recent(),
    };
    let decision: GateDecision;
    if (request.kind === "search") {
      decision = await checkQuery(String(request.query), ctx);
    } else {
      let url: URL;
      try {
        url = parseFetchUrl(String(request.url));
      } catch (error) {
        this.#audit("fetch", { outcome: "block", reasons: ["invalid_url"], redacted: "[invalid URL]" });
        throw error;
      }
      decision = await checkUrl(url, ctx);
    }
    this.#audit(request.kind, {
      outcome: decision.outcome,
      reasons: decision.reasons,
      // A blocked request is never stored verbatim.
      redacted: decision.outcome === "block" ? decision.redacted : decision.text,
      jev: decision.jev,
      note: decision.error,
    });
    if (decision.outcome !== "block") this.#remember(decision.text);
    return decision;
  }

  async run(request: PendingRequest): Promise<{ status: "ok"; results?: SearchResult[]; page?: FetchedPage }> {
    if (request.kind === "fetch") {
      return { status: "ok", page: await fetchPage(this.env.AI, parseFetchUrl(request.url), request.raw) };
    }
    let outcome = await openRouterSearch(this.env.OPENROUTER_API_KEY, request.query, { count: request.count });
    let faithful = outcome.executedQueries.length === 1 && outcome.executedQueries[0] === request.query;
    if (!faithful) {
      // Not a leak (the search model saw nothing but the approved query), but a sign it is misbehaving.
      console.warn(JSON.stringify({
        event: "websearch.search.executed_query_mismatch",
        searches: outcome.executedQueries.length,
      }));
    }
    this.#audit("search.sent", {
      outcome: "allow",
      reasons: faithful ? [] : ["executed_query_mismatch"],
      redacted: request.query,
      cost: outcome.cost,
      note: faithful ? undefined : `executed ${JSON.stringify(outcome.executedQueries).slice(0, 500)}`,
    });
    return { status: "ok", results: outcome.results };
  }

  stagePending(request: PendingRequest, decision: GateDecision | null): number {
    if (!decision) {
      // Unchecked requests bypass gate(), so audit them here; the URL is shown to the user in the
      // approval card, but stored redacted in case they reject it.
      let n = normalize(request.kind === "fetch" ? request.url : request.query);
      this.#audit("fetch.unchecked", { outcome: "review", reasons: ["unchecked"], redacted: redact(n.text, detect(n, this.#detectorConfig())) });
    }
    let next = (this.ctx.storage.kv.get<number>("nextAction") ?? 0) + 1;
    this.ctx.storage.kv.put("nextAction", next);
    this.ctx.storage.sql.exec("INSERT INTO pending (action, request, at) VALUES (?, ?, ?)", next, JSON.stringify(request), Date.now());
    return next;
  }

  unstagePending(action: number): void {
    this.ctx.storage.sql.exec("DELETE FROM pending WHERE action = ?", action);
  }

  readResult(action: number): WebResult {
    let row = this.ctx.storage.sql.exec<{ result: string }>("SELECT result FROM results WHERE action = ?", action).toArray()[0];
    if (row) return JSON.parse(row.result) as WebResult;
    let pending = this.ctx.storage.sql.exec("SELECT 1 FROM pending WHERE action = ?", action).toArray().length > 0;
    if (pending) return { status: "pending" };
    throw new Error(`No web request #${action}.`);
  }

  // ---- storage ----

  #storeResult(action: number, result: StoredResult): void {
    this.ctx.storage.sql.exec("DELETE FROM pending WHERE action = ?", action);
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO results (action, result, at) VALUES (?, ?, ?)", action, JSON.stringify(result), Date.now());
    this.ctx.storage.sql.exec("DELETE FROM results WHERE action <= ?", action - MAX_RETAINED_RESULTS);
  }

  #recent(): string[] {
    let since = Date.now() - RECENT_WINDOW_MS;
    this.ctx.storage.sql.exec("DELETE FROM recent WHERE at < ?", since);
    return this.ctx.storage.sql
      .exec<{ text: string }>("SELECT text FROM recent ORDER BY at DESC LIMIT ?", RECENT_LIMIT)
      .toArray().map(r => r.text).reverse();
  }

  #remember(text: string): void {
    this.ctx.storage.sql.exec("INSERT INTO recent (at, text) VALUES (?, ?)", Date.now(), text);
  }

  #audit(kind: string, entry: {
    outcome: string; reasons: string[]; redacted: string;
    jev?: GateDecision["jev"]; cost?: number | null; note?: string;
  }): void {
    let now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO decisions (at, kind, outcome, reasons, redacted, jev_id, jev_model, jev_scores, cost, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      now, kind, entry.outcome, entry.reasons.join(","), entry.redacted.slice(0, 2048),
      entry.jev?.id ?? null, entry.jev?.model ?? null,
      entry.jev ? JSON.stringify(entry.jev.scores) : null,
      entry.cost ?? entry.jev?.cost ?? null, entry.note ?? null,
    );
    this.ctx.storage.sql.exec("DELETE FROM decisions WHERE at < ?", now - AUDIT_RETENTION_MS);
  }

  #detectorConfig(): DetectorConfig {
    let list = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
    return {
      blockedTerms: list(this.env.BLOCKED_TERMS),
      privateDomains: list(this.env.PRIVATE_DOMAINS),
      publicHosts: list(this.env.PUBLIC_HOSTS),
    };
  }
}

@validateRpc()
export class WebSearchAccount extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return describeWebSearchAccount();
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<WebSearchSession>>> {
    return this.ctx.exports.WebSearchGatekeeper({});
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  getGatekeeperClassFor(_url: string): never {
    throw new Error("Web Search has no URL-addressed resources.");
  }

  startResourceConfigurator(_pattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Web Search has no URL-addressed resources.");
  }

  async ensureResources(_patterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("Web Search has no credentials to reconnect.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.WebSearchVerifier({});
  }
}

@validateRpc()
export class WebSearchVerifier extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return describeWebSearchVendor();
  }

  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.WebSearchAccount({});
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Web Search is auto-provisioned and has no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
