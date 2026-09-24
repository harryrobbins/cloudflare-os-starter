// The two shapes `deploy.ts` sits between: `deployment.jsonc` on the way in, and the
// `wrangler.prod.jsonc` files it generates on the way out.
//
// The wrangler side reuses the submodule's own declarations rather than redeclaring them, so a
// base-config change upstream surfaces here as a type error during `pnpm types:scripts` instead of
// as a silently dropped key at deploy time. The imports are type-only, which under
// `verbatimModuleSyntax` erase completely -- `node` never resolves them, so the submodule's
// runtime dependencies are not this script's problem.

import type {
  BindingDecl,
  ObservabilityConfig,
  WranglerConfig,
} from "../cloudflare-os/scripts/release/manifest-lib.ts";

/** A model provider the Workshop can serve through AI Gateway with deployment-managed keys. */
export type AiGatewayProvider = "anthropic" | "openai" | "google" | "cloudflare" | "openrouter";

/** Every provider {@link AiGatewayProvider} allows, for validation and for error messages. */
export const AI_GATEWAY_PROVIDERS: readonly AiGatewayProvider[] =
  ["anthropic", "openai", "google", "cloudflare", "openrouter"];

/** One entry of the deployment-owned model allow-list. Mirrors upstream's `SUGGESTED_MODELS` shape. */
export interface AiGatewayModel {
  /** Display name in the model picker. */
  name: string;
  /** Input context window, in tokens. */
  contextWindow: number;
  /** Output limit, in tokens. Omitted means the provider default. */
  outputLimit?: number;
}

/**
 * Deployment-owned model allow-list, keyed by provider and then by the model id the provider's
 * API takes. Becomes the Workshop's `CF_AI_GATEWAY_EXTRA_MODELS` var, which the pinned fork merges
 * over upstream's built-in `SUGGESTED_MODELS` catalogue. `openrouter` ships with no built-in
 * models, so it is only ever served from here.
 */
export type AiGatewayModels =
  Partial<Record<AiGatewayProvider, Record<string, AiGatewayModel>>>;

/**
 * The public address of the router Worker. Exactly one field is set; `validateConfig` enforces
 * that, since wrangler would otherwise happily deploy both a custom domain and a workers.dev route.
 */
export interface RouterRoute {
  /** Evaluation route on the account's workers.dev subdomain. */
  workersDev?: boolean;
  /** Production hostname in an active Cloudflare zone. Wrangler creates DNS and TLS for it. */
  customDomain?: string;
}

/** Cloudflare Access trust boundary and the `/admin` allowlist. */
export interface AccessConfig {
  /** Access team origin, HTTPS with no path. */
  issuer: string;
  /** The self-hosted Access application's AUD tag. */
  audience: string;
  /** Access-verified emails allowed into `/admin`. */
  admins: string[];
}

/**
 * Deployment-managed model catalog, served through Cloudflare AI Gateway.
 *
 * Transport is derived rather than configured: the Workshop reaches the gateway over its
 * `WORKERS_AI` binding, which is pre-authenticated inside the Worker's own account. Only a gateway
 * in a *different* account, or the `google` provider, needs `CF_AI_GATEWAY_API_TOKEN` -- see
 * `AiGatewayConfig` in cloudflare-os/packages/workshop-backend/src/ai-gateway.ts, whose constructor
 * throws this script mirrors.
 */
export interface AiGatewayConfigInput {
  /** Whether the Workshop advertises a deployment-managed catalog at all. */
  enabled: boolean;
  /** Gateway name. `"default"` is the one Cloudflare creates for an account on first use. */
  name?: string;
  /** Account owning the gateway. `null` reuses the deployment's own `accountId`. */
  accountId?: string | null;
  /** Providers to advertise. Must be non-empty when enabled. */
  providers?: AiGatewayProvider[];
  /**
   * Deployment-owned model allow-list, merged over upstream's catalogue for the providers listed
   * in `providers`. Required for `openrouter`, which has no built-in models; optional for the rest.
   * Model ids are what the provider's API takes; keys never live here, they live on the gateway.
   */
  models?: AiGatewayModels;
  /**
   * No longer configurable: Workers AI rides the same gateway route as every other provider.
   * Declared only so `validateConfig` can reject a leftover key loudly -- silently ignoring one
   * produces a deploy that succeeds with an empty model picker.
   */
  workersAi?: never;
}

/** Context Gatekeeper storage and the sharing boundary its data is scoped to. */
export interface ContextConfig {
  /**
   * Stable label isolating Context data belonging to this deployment. `null` scopes it to the
   * deployment's public origin, which is what the hosted deploy does.
   */
  sharingDomain: string | null;
  /** Existing snapshot KV namespace, or `null` for Wrangler automatic provisioning. */
  kvNamespaceId: string | null;
  /** Optional Git-compatible collection storage. Absent or `{}` means disabled. */
  artifacts?: { enabled?: boolean; namespace?: string };
}

/**
 * Team chat: one Worker serving its own SPA, JSON API and WebSocket at `/gatekeeper/chat/`, with a
 * SQLite Durable Object and an R2 bucket of its own.
 *
 * Absent or disabled generates nothing: no Worker, no bucket, and no `GATEKEEPER_CHAT` binding on
 * the router or the Workshop. Identity is not configured here -- chat verifies the same Access JWT
 * the Workshop does, from the same `access` block.
 */
export interface ChatConfig {
  /** Whether the chat Worker is built, deployed and bound at all. */
  enabled: boolean;
  /**
   * R2 bucket holding uploaded files and thumbnails. `null` requests Wrangler automatic
   * provisioning; a name adopts an existing bucket, which is how uploads survive a rename.
   */
  filesBucket: string | null;
  /** Hard cap on one upload, in bytes. Becomes the chat Worker's `MAX_UPLOAD_BYTES` var. */
  maxUploadBytes: number;
  /**
   * Whether the Workshop binds chat as an agent-facing Gatekeeper vendor, so every workspace gets
   * an ambient `ChatSession`. Off by default, and deliberately separate from `enabled`: the chat app
   * works without it, the vendor entrypoint is a later stream, and a service binding naming an
   * entrypoint the deployed chat Worker does not export is a Workshop deploy that can fail for a
   * reason nothing in chat itself explains.
   */
  agentAccess?: boolean;
  /**
   * Whether `@agent` in chat is answered: the chat Worker binds the Workshop's
   * `ExternalMessageGateway` entrypoint as `WORKSHOP_GATEWAY`, and a question is asked of the
   * asker's own Workshop account and model. Absent means on whenever chat is enabled; `false` leaves
   * the binding out, and chat then shows the Agent as switched off rather than as a member that
   * never answers. Unrelated to `agentAccess`, which is the opposite direction (workspace agents
   * reading chat).
   */
  agentReplies?: boolean;
}

/**
 * Privacy-gated web search and fetch: one RPC-only Gatekeeper Worker bound to the Workshop as
 * `GATEKEEPER_WEBSEARCH`. Every query and URL is checked by pattern detectors and the Jev decision
 * model before it leaves. Needs the `OPENROUTER_API_KEY` secret on its Worker, installed with
 * `wrangler secret put`; wrangler refuses the deploy without it.
 *
 * Absent or disabled generates nothing.
 */
export interface WebSearchConfig {
  /** Whether the web search Worker is built, deployed and bound at all. */
  enabled: boolean;
  /**
   * Extra literal strings no query or URL may contain, on top of the account ID and the Access team
   * domain, which are always included.
   */
  blockedTerms?: string[];
  /**
   * Hostname suffixes that are private. Absent derives the parent domain of the router's custom
   * domain (`cfos.example.com` gives `example.com`); the public origin itself is always allowed.
   */
  privateDomains?: string[];
}

/**
 * Organisation Records: one Worker serving the machine API and the people connect flow under
 * `/gatekeeper/records/` through the router, and bound to the Workshop as a Gatekeeper vendor. Its
 * data lives in an operator-provisioned Postgres database reached through two Hyperdrive
 * configurations; change notifications go through a Queue with a dead-letter queue.
 *
 * Absent or disabled generates nothing: no Worker, and no `GATEKEEPER_RECORDS` binding on the router
 * or the Workshop. Nothing here is provisioned automatically -- see the operator prerequisites in
 * `deployment.jsonc`.
 */
export interface RecordsConfig {
  /** Whether the Records Worker is built, deployed and bound at all. */
  enabled: boolean;
  /**
   * Hyperdrive configuration (32 hex characters) for the runtime application role
   * (`records_app`). Becomes the `HYPERDRIVE` binding. Query caching MUST be disabled on it:
   * permission and registry reads must be fresh.
   */
  hyperdriveId: string;
  /**
   * Hyperdrive configuration for the outbox publisher role (`records_publisher`). Becomes the
   * `HYPERDRIVE_PUBLISHER` binding. Caching disabled, and distinct from `hyperdriveId`.
   */
  publisherHyperdriveId: string;
  /**
   * AUD tag of the separate, path-specific Access application protecting
   * `/gatekeeper/records/v1/*` (service tokens). Becomes `RECORDS_API_ACCESS_AUD`. `null` switches
   * the machine API off (every request refused) until that application exists.
   */
  apiAccessAudience: string | null;
  /** Change-notification queue. Absent means `<workers.records.name>-changes`. */
  changesQueue?: string;
  /** Its dead-letter queue. Absent means `<workers.records.name>-changes-dlq`. */
  deadLetterQueue?: string;
}

/**
 * Jev decisions: one RPC-only Gatekeeper Worker bound to the Workshop as `GATEKEEPER_JEV`, giving
 * agents and Gadgets TypeSafe's Jev decision model over OpenRouter's Decisions API (Jev speaks no
 * chat completions, so it cannot be an AI model). Needs the `OPENROUTER_API_KEY` secret on its
 * Worker, installed with `wrangler secret put`; wrangler refuses the deploy without it.
 *
 * Absent or disabled generates nothing.
 */
export interface JevConfig {
  /** Whether the Jev Worker is built, deployed and bound at all. */
  enabled: boolean;
}

/**
 * Omni-search: one Worker (`packages/gatekeeper-search`) holding a deployment-wide hybrid index --
 * a SQLite Durable Object for the lexical half and facets, a Vectorize index for the dense half, and
 * an embed queue with a dead-letter queue for the work it gives itself. Serves its own SPA and API
 * at `/gatekeeper/search/` through the router.
 *
 * Absent or disabled generates nothing: no Worker, and no `GATEKEEPER_SEARCH` or `SEARCH` binding
 * on the router, the Workshop or chat. The Vectorize index, its metadata indexes and both queues
 * are not provisioned by the deploy: `pnpm search:provision` creates them, and `pnpm check`
 * refuses to continue until they exist with the shape the Worker expects.
 */
export interface SearchConfig {
  /** Whether the search Worker is built, deployed and bound at all. */
  enabled: boolean;
  /**
   * Whether the Workshop binds search as a Gatekeeper vendor, so every workspace gets an ambient
   * `SearchSession`. Public content only in v1: the singleton session carries no identity.
   */
  agentAccess?: boolean;
  /**
   * Whether chat binds search's `SearchService` entrypoint as `SEARCH`, to push its messages into
   * the index and fuse dense recall into chat's own search. Requires `chat.enabled`.
   */
  chatFusion?: boolean;
  /**
   * Whether search binds cfos-context's GatekeeperVendor (with the Workshop's own sharing domain)
   * and indexes the Context Library's public collections every 15 minutes. Default true. The
   * Context vendor trusts the `isAdmin` flag its caller passes, so this binding extends trust to
   * the search Worker; its feed only ever passes `isAdmin: false`.
   */
  contextFeed?: boolean;
  /** Vectorize index name. Absent means `<workers.search.name>`. */
  index?: string;
  /** Whether the bge-reranker-base pass runs over the fused top 30. Becomes `RERANK` ("1"/"0"). */
  rerank?: boolean;
  /** Embed queue. Absent means `<workers.search.name>-embed`. */
  embedQueue?: string;
  /** Its dead-letter queue. Absent means `<workers.search.name>-embed-dlq`. */
  deadLetterQueue?: string;
}

/** Worker telemetry. Maps onto wrangler's `observability` block. */
export interface DeploymentObservabilityConfig {
  enabled: boolean;
  headSamplingRate: number;
  logs: { invocationLogs: boolean };
  traces: { enabled: boolean; headSamplingRate: number };
}

/**
 * `deployment.jsonc`, parsed.
 *
 * This describes the *valid* shape. The file is hand-edited JSONC with no schema behind it, so
 * every field is still checked at runtime by `validateConfig` -- the type is what makes the
 * generation code readable, not a guarantee about what is on disk.
 */
export interface DeploymentConfig {
  /** Cloudflare account owning every Worker and provisioned resource. 32 hex characters. */
  accountId: string;
  /**
   * The deployment's public origin: HTTPS, no path, no trailing slash. `null` derives it from
   * `workers.router.route.customDomain`, and is invalid on a workers.dev route -- the account's
   * workers.dev subdomain is not in this file and wrangler exposes no way to look it up.
   */
  publicBaseUrl: string | null;
  /** Permanent Worker service identities. Each must be unique within the account. */
  workers: {
    /** Owns the public route, serves the frontend, and proxies to every other Worker. */
    router: { name: string; route: RouterRoute };
    workshop: { name: string };
    context: { name: string };
    scheduler: { name: string };
    /** Credential-free deterministic synthetic datasets. */
    procgen: { name: string };
    customGatekeeper: { name: string };
    /** Only required when `errorReporting.enabled`. */
    errorReporter?: { name: string };
    /** Team chat. Only required when `chat.enabled`. */
    chat?: { name: string };
    /** Privacy-gated web search. Only required when `webSearch.enabled`. */
    webSearch?: { name: string };
    /** Organisation Records. Only required when `records.enabled`. */
    records?: { name: string };
    /** Jev decisions. Only required when `jev.enabled`. */
    jev?: { name: string };
    /** Omni-search. Only required when `search.enabled`. */
    search?: { name: string };
  };
  /** Optional private Python execution service; disabled unless explicitly enabled. */
  runtime?: { enabled: boolean; workerName: string; maxInstances: number };
  access: AccessConfig;
  aiGateway: AiGatewayConfigInput;
  context: ContextConfig;
  /** Display text the example custom Gatekeeper serves to agents. */
  customGatekeeper: { name: string; message: string };
  /** Private explicit-issue destination. */
  errorReporting: { enabled: boolean; environment?: string; release?: string | null };
  /** Team chat. Absent means disabled, as does `enabled: false`. */
  chat?: ChatConfig;
  /** Privacy-gated web search. Absent means disabled, as does `enabled: false`. */
  webSearch?: WebSearchConfig;
  /** Organisation Records. Absent means disabled, as does `enabled: false`. */
  records?: RecordsConfig;
  /** Jev decisions. Absent means disabled, as does `enabled: false`. */
  jev?: JevConfig;
  /** Omni-search. Absent means disabled, as does `enabled: false`. */
  search?: SearchConfig;
  /** Workshop KV/R2. `null` requests Wrangler automatic provisioning. */
  resources: {
    blueprintsKvNamespaceId: string | null;
    avatarsKvNamespaceId: string | null;
    blueprintContentBucket: string | null;
  };
  observability: DeploymentObservabilityConfig;
  /**
   * Directory of bundled format blueprints (`<name>.gadget` + `<name>.json`), relative to the
   * repository root. Replaces upstream's default set, so it must carry any defaults to keep.
   * `null` or absent ships upstream's formats.
   */
  formatBlueprintsDir?: string | null;
}

/**
 * `ObservabilityConfig` plus the traces block. Upstream's type does not declare it, though the
 * backend's own `wrangler.jsonc` sets it and this script writes it for every Worker.
 */
export interface ProdObservabilityConfig extends ObservabilityConfig {
  traces?: { enabled?: boolean; head_sampling_rate?: number };
}

/**
 * A generated `wrangler.prod.jsonc`: the subset of wrangler config upstream's `WranglerConfig`
 * declares, plus the keys this script writes that it does not.
 *
 * Four keys are replaced rather than added to. Upstream's observability type is deliberately closed
 * and has no `traces`; its `artifacts` is a single `BindingDecl`, while wrangler takes an array and
 * the Context Gatekeeper's entry carries a `namespace`; and its KV/R2 bindings are bare
 * `BindingDecl`s, because the release manifest replaces every id with a placeholder while a
 * generated config either names the resource or leaves it for automatic provisioning.
 *
 * `assets` is *not* redeclared -- upstream's is already the shape written here.
 */
export type ProdWranglerConfig =
  Omit<WranglerConfig, "observability" | "artifacts" | "kv_namespaces" | "r2_buckets">
  & {
    /** Container images attached to this Worker. */
    containers?: { class_name: string; image: string; instance_type: string; max_instances: number }[];
    /** KV bindings. `id` absent requests Wrangler automatic provisioning. */
    kv_namespaces?: (BindingDecl & { id?: string })[];
    /** R2 bindings. `bucket_name` absent requests Wrangler automatic provisioning. */
    r2_buckets?: (BindingDecl & { bucket_name?: string })[];
    /** The deployment's account, pinned so a stray `CLOUDFLARE_ACCOUNT_ID` cannot redirect it. */
    account_id?: string;
    /** Whether the Worker answers on the account's workers.dev subdomain. */
    workers_dev?: boolean;
    /** Custom-domain routes. Wrangler creates DNS and TLS for each. */
    routes?: { pattern: string; custom_domain: boolean }[];
    /** Turned off on every Worker: a preview URL is an unauthenticated path around Access. */
    preview_urls?: boolean;
    observability?: ProdObservabilityConfig;
    /** Workers AI. Both the AI Gateway transport and what webFetch's `toMarkdown()` runs on. */
    ai?: BindingDecl;
    /** Secrets wrangler refuses to deploy without. Emitted only when one is genuinely needed. */
    secrets?: { required: string[] };
    /** Artifacts namespaces. An array, unlike upstream's single-binding declaration. */
    artifacts?: { binding: string; namespace: string }[];
    /**
     * Hyperdrive bindings. `localConnectionString` is for `wrangler dev` only and never appears in a
     * generated config.
     */
    hyperdrive?: { binding: string; id: string; localConnectionString?: string }[];
    /** Queue producers and consumers. */
    queues?: {
      producers?: { binding: string; queue: string }[];
      consumers?: {
        queue: string;
        max_batch_size?: number;
        max_batch_timeout?: number;
        max_retries?: number;
        dead_letter_queue?: string;
      }[];
    };
    /** Cron triggers. */
    triggers?: { crons: string[] };
    /** Vectorize bindings. The index itself is provisioned outside wrangler deploy. */
    vectorize?: { binding: string; index_name: string }[];
    /** Rate limiting bindings. */
    ratelimits?: { name: string; namespace_id: string; simple: { limit: number; period: number } }[];
  };

/** The generated configs, keyed as `deployment.jsonc` keys them. */
export interface GeneratedConfigs {
  /** Present only when Python execution is enabled. */
  runtime?: ProdWranglerConfig;
  router: ProdWranglerConfig;
  workshop: ProdWranglerConfig;
  context: ProdWranglerConfig;
  scheduler: ProdWranglerConfig;
  procgen: ProdWranglerConfig;
  customGatekeeper: ProdWranglerConfig;
  /** Absent when `errorReporting.enabled` is false. */
  errorReporter?: ProdWranglerConfig;
  /** Absent when `chat.enabled` is false or the block is missing. */
  chat?: ProdWranglerConfig;
  /** Absent when `webSearch.enabled` is false or the block is missing. */
  webSearch?: ProdWranglerConfig;
  /** Absent when `records.enabled` is false or the block is missing. */
  records?: ProdWranglerConfig;
  /** Absent when `jev.enabled` is false or the block is missing. */
  jev?: ProdWranglerConfig;
  /** Absent when `search.enabled` is false or the block is missing. */
  search?: ProdWranglerConfig;
}

/** The upstream base configs the generated ones are derived from. */
export interface BaseConfigs {
  /** Python runner base; required only when execution is enabled. */
  runtime?: ProdWranglerConfig;
  router: ProdWranglerConfig;
  workshop: ProdWranglerConfig;
  context: ProdWranglerConfig;
  scheduler: ProdWranglerConfig;
  procgen: ProdWranglerConfig;
  customGatekeeper: ProdWranglerConfig;
  errorReporter: ProdWranglerConfig;
  /** Team chat base; required only when chat is enabled. */
  chat?: ProdWranglerConfig;
  /** Web search base; required only when web search is enabled. */
  webSearch?: ProdWranglerConfig;
  /** Records base; required only when Records is enabled. */
  records?: ProdWranglerConfig;
  /** Jev base; required only when Jev is enabled. */
  jev?: ProdWranglerConfig;
  /** Search base; required only when search is enabled. */
  search?: ProdWranglerConfig;
}

/** One build step `deploy.ts` runs before deploying. See `buildCommands`. */
export interface BuildCommand {
  /** Arguments passed to `pnpm`, from the repository root. */
  args: string[];
  /**
   * Variables set on top of the ambient environment for this step alone. Explicit rather than
   * inherited: a build-time flag that arrives by inheritance is one a cached `vp` run would strip.
   */
  env?: Record<string, string>;
}
