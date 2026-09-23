import { existsSync, readdirSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { pnpmCommand } from "../cloudflare-os/scripts/pnpm-command.ts";
import { resolveBinEntry } from "../cloudflare-os/scripts/bin-entry.ts";
import { AI_GATEWAY_PROVIDERS } from "./deployment-config.ts";
import type {
  AiGatewayModels,
  AiGatewayProvider,
  BaseConfigs,
  BuildCommand,
  DeploymentConfig,
  GeneratedConfigs,
  ProdWranglerConfig,
  RouterRoute,
} from "./deployment-config.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// One deployment per checkout; use separate worktrees for concurrent deploys.
const generatedName = "wrangler.prod.jsonc";
const packageDirs = {
  router: "cloudflare-os/packages/router",
  workshop: "cloudflare-os/packages/workshop-backend",
  context: "cloudflare-os/packages/gatekeeper-context",
  scheduler: "cloudflare-os/packages/gatekeeper-scheduler",
  procgen: "packages/gatekeeper-procgen",
  customGatekeeper: "packages/custom-gatekeeper",
  errorReporter: "packages/error-reporter",
  runtime: "packages/gatekeeper-runtime",
  chat: "packages/gatekeeper-chat",
  webSearch: "packages/gatekeeper-websearch",
  records: "packages/gatekeeper-records",
  jev: "packages/gatekeeper-jev",
} as const;
const generatedPaths = Object.fromEntries(
  Object.entries(packageDirs).map(([name, dir]) => [name, join(root, dir, generatedName)]),
) as Record<keyof typeof packageDirs, string>;
const defaultContextArtifactsNamespace = "gatekeeper-context-collections";
// One chat upload arrives as a single Worker request body, and 100 MiB is what the platform accepts:
// https://developers.cloudflare.com/workers/platform/limits/#request-limits
const maxChatUploadBytes = 100 * 1024 * 1024;
// The chat SPA is uploaded from here through the Worker's own `assets` binding.
const chatAssetsDir = "app/dist";
const accountIdPattern = /^[a-f\d]{32}$/i;
// Hyperdrive configuration IDs have the same shape as account IDs.
const hyperdriveIdPattern = accountIdPattern;
// An Access application's AUD tag: 64 hexadecimal characters.
const accessAudiencePattern = /^[a-f\d]{64}$/i;
// Queue names: lowercase letters, numbers and hyphens, at most 63 characters.
const queueNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const requiredPaths = [
  "accountId",
  "workers.router.name",
  "workers.workshop.name",
  "workers.context.name",
  "workers.scheduler.name",
  "workers.procgen.name",
  "workers.customGatekeeper.name",
  "access.issuer",
  "access.audience",
  "access.admins",
  "aiGateway.enabled",
  "errorReporting.enabled",
  "customGatekeeper.name",
  "customGatekeeper.message",
  "observability.enabled",
  "observability.headSamplingRate",
  "observability.logs.invocationLogs",
  "observability.traces.enabled",
  "observability.traces.headSamplingRate",
];

// `aiGateway.accountId` is deliberately absent: null is its normal value, meaning "the gateway
// lives in the deployment's own account".
const aiGatewayPaths = [
  "aiGateway.name",
  "aiGateway.providers",
];

const errorReportingPaths = [
  "workers.errorReporter.name",
  "errorReporting.environment",
];

const chatPaths = [
  "workers.chat.name",
];

const webSearchPaths = [
  "workers.webSearch.name",
];

const recordsPaths = [
  "workers.records.name",
  "records.hyperdriveId",
  "records.publisherHyperdriveId",
  "records.apiAccessAudience",
];

const jevPaths = [
  "workers.jev.name",
];

const resourcePaths = [
  "context.kvNamespaceId",
  "resources.blueprintsKvNamespaceId",
  "resources.avatarsKvNamespaceId",
  "resources.blueprintContentBucket",
];

function valueAt(object: DeploymentConfig, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (value, key) => (value as Record<string, unknown> | undefined)?.[key], object);
}

/**
 * The deployment's public origin: the address the router answers on.
 *
 * Two things read it, and both are load-bearing in different ways. `PUBLIC_BASE_URL` is what
 * upstream builds absolute links and OAuth redirect URIs from. The Context Gatekeeper's
 * `sharingDomain` prop is a data-isolation boundary, so a value that changes silently hides
 * collections rather than breaking a link.
 *
 * `validateConfig` guarantees that one of the two sources below is present, and that they agree when
 * both are.
 */
export function publicOrigin(config: DeploymentConfig): string {
  const explicit = config.publicBaseUrl;
  if (explicit) return explicit.replace(/\/$/, "");
  return `https://${config.workers.router.route.customDomain!}`;
}

function validatePublicBaseUrl(config: DeploymentConfig, route: RouterRoute): void {
  const value = config.publicBaseUrl;
  if (value === undefined) {
    throw new Error(
      "publicBaseUrl must be present. Use null to derive it from " +
      "workers.router.route.customDomain.");
  }
  if (value === null) {
    if (!route.customDomain) {
      throw new Error(
        "publicBaseUrl is required on a workersDev route. The account's workers.dev subdomain is " +
        "not in deployment.jsonc and wrangler exposes no command to look it up, so there is " +
        "nothing to derive the public origin from -- and PUBLIC_BASE_URL and the Context sharing " +
        "boundary both need one. Set it to https://<router-name>.<subdomain>.workers.dev.");
    }
    return;
  }
  if (typeof value !== "string") {
    throw new Error("publicBaseUrl must be null or a string.");
  }
  let origin: string;
  try {
    origin = new URL(value).origin;
  } catch {
    throw new Error("publicBaseUrl must be an HTTPS origin such as https://os.example.com.");
  }
  if (!value.startsWith("https://") || origin !== value) {
    throw new Error(
      "publicBaseUrl must be an HTTPS origin only, with no path and no trailing slash.");
  }
  if (route.customDomain && value !== `https://${route.customDomain}`) {
    throw new Error(
      `publicBaseUrl (${value}) does not match workers.router.route.customDomain ` +
      `(${route.customDomain}). Context data would then be scoped to a hostname this deployment ` +
      "does not answer on. Leave publicBaseUrl null to derive it from the custom domain.");
  }
  // On a workersDev route there is nothing to cross-check the value against the way a custom domain
  // checks itself, so check its shape instead. The account's workers.dev subdomain is unknowable
  // here, but the rest of the hostname is not: wrangler serves the Worker at
  // <worker-name>.<subdomain>.workers.dev, so anything else is a typo or an unrelated host -- and it
  // would silently become both PUBLIC_BASE_URL and the Context isolation boundary, hiding existing
  // Context data and breaking every absolute link and OAuth redirect the backend builds.
  if (route.workersDev) {
    const labels = new URL(value).host.split(".");
    const [worker, subdomain, ...suffix] = labels;
    const routerName = config.workers.router.name;
    if (labels.length !== 4 || suffix.join(".") !== "workers.dev" ||
        !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(subdomain ?? "")) {
      throw new Error(
        `publicBaseUrl (${value}) is not a workers.dev origin. On a workersDev route it must be ` +
        `https://${routerName}.<subdomain>.workers.dev, where <subdomain> is the account's ` +
        "workers.dev subdomain. It becomes PUBLIC_BASE_URL and the Context sharing boundary, so a " +
        "hostname this deployment does not answer on hides Context data and breaks redirects.");
    }
    if (worker !== routerName) {
      throw new Error(
        `publicBaseUrl (${value}) names Worker "${worker}", but the router is ` +
        `"${routerName}". The router is what answers on the public origin, so this origin belongs ` +
        `to a different Worker. Use https://${routerName}.${subdomain}.workers.dev, or change ` +
        "workers.router.name if the other name is the one you meant.");
    }
  }
}

export function validateConfig(config: DeploymentConfig): DeploymentConfig {
  const activePaths = [
    ...requiredPaths,
    ...(config.aiGateway?.enabled ? aiGatewayPaths : []),
    ...(config.errorReporting?.enabled ? errorReportingPaths : []),
    ...(config.chat?.enabled ? chatPaths : []),
    ...(config.webSearch?.enabled ? webSearchPaths : []),
    ...(config.records?.enabled === true ? recordsPaths : []),
    ...(config.jev?.enabled ? jevPaths : []),
  ];
  for (const path of activePaths) {
    const value = valueAt(config, path);
    if (value === undefined || value === null || value === "" || Array.isArray(value) && !value.length) {
      throw new Error(`Missing required deployment value: ${path}`);
    }
  }

  for (const path of resourcePaths) {
    const value = valueAt(config, path);
    if (value === undefined || value !== null && (typeof value !== "string" || !value)) {
      throw new Error(`Deployment resource must be null or a non-empty string: ${path}`);
    }
  }

  let activeConfig: DeploymentConfig = config.aiGateway.enabled
    ? config
    : { ...config, aiGateway: { enabled: false } };
  if (!config.errorReporting.enabled) {
    activeConfig = {
      ...activeConfig,
      workers: { ...activeConfig.workers, errorReporter: undefined },
      errorReporting: { enabled: false },
    };
  }
  if (!config.chat?.enabled) {
    // Dormant, like a disabled Error Reporter: a placeholder left in a chat block nobody deploys is
    // not a reason to refuse the deploy.
    activeConfig = {
      ...activeConfig,
      workers: { ...activeConfig.workers, chat: undefined },
      chat: undefined,
    };
  }
  if (!config.webSearch?.enabled) {
    activeConfig = {
      ...activeConfig,
      workers: { ...activeConfig.workers, webSearch: undefined },
      webSearch: undefined,
    };
  }
  if (config.records?.enabled !== true) {
    activeConfig = {
      ...activeConfig,
      workers: { ...activeConfig.workers, records: undefined },
      records: undefined,
    };
  }
  if (!config.jev?.enabled) {
    activeConfig = {
      ...activeConfig,
      workers: { ...activeConfig.workers, jev: undefined },
      jev: undefined,
    };
  }
  const placeholder = JSON.stringify(activeConfig).match(/<[^>]+>/)?.[0];
  if (placeholder) throw new Error(`Replace deployment placeholder ${placeholder}.`);

  const stringPaths = activePaths.filter((path) => ![
    "access.admins",
    "aiGateway.enabled",
    "aiGateway.providers",
    "errorReporting.enabled",
    "observability.enabled",
    "observability.headSamplingRate",
    "observability.logs.invocationLogs",
    "observability.traces.enabled",
    "observability.traces.headSamplingRate",
  ].includes(path));
  for (const path of stringPaths) {
    if (typeof valueAt(config, path) !== "string") {
      throw new Error(`Deployment value must be a string: ${path}`);
    }
  }

  if (!accountIdPattern.test(config.accountId)) {
    throw new Error("Cloudflare account IDs must be 32 hexadecimal characters.");
  }
  if (config.runtime !== undefined) {
    const runtime = config.runtime;
    if (!runtime || typeof runtime.enabled !== "boolean" ||
        typeof runtime.workerName !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(runtime.workerName) ||
        !Number.isInteger(runtime.maxInstances) || runtime.maxInstances < 1 || runtime.maxInstances > 20) {
      throw new Error("runtime requires enabled (boolean), workerName, and maxInstances from 1 to 20.");
    }
    if (runtime.enabled && Object.values(config.workers).some(worker => worker?.name === runtime.workerName)) {
      throw new Error("Runtime Worker name must be unique.");
    }
  }
  const workerNames = Object.entries(config.workers)
    .filter(([key]) => key !== "errorReporter" || config.errorReporting.enabled)
    // A dormant chat name may collide with nothing, because no chat Worker is deployed for it.
    .filter(([key]) => key !== "chat" || (config.chat?.enabled ?? false))
    .filter(([key]) => key !== "webSearch" || (config.webSearch?.enabled ?? false))
    .filter(([key]) => key !== "records" || config.records?.enabled === true)
    .filter(([key]) => key !== "jev" || (config.jev?.enabled ?? false))
    .map(([, worker]) => worker!.name);
  if (new Set(workerNames).size !== workerNames.length) {
    throw new Error(
      "Router, Workshop, Context, Scheduler, Synthetic Data, chat, web search, Records, Jev, and " +
      "custom Gatekeeper names must be unique.");
  }
  if (!workerNames.every((name) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name))) {
    throw new Error("Worker names must use lowercase letters, numbers, and hyphens.");
  }

  const route = config.workers.router.route;
  if (!route || Boolean(route.workersDev) === Boolean(route.customDomain)) {
    throw new Error("Set exactly one router route: workersDev or customDomain.");
  }
  if (route.workersDev !== undefined && route.workersDev !== true) {
    throw new Error("Router workersDev must be boolean true when selected.");
  }
  if (route.customDomain !== undefined && typeof route.customDomain !== "string") {
    throw new Error("Router customDomain must be a string.");
  }
  const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (route.customDomain && !hostnamePattern.test(route.customDomain)) {
    throw new Error("Router customDomain must be a lowercase hostname.");
  }

  validatePublicBaseUrl(config, route);

  const sharingDomain = config.context.sharingDomain;
  if (sharingDomain !== null &&
      (typeof sharingDomain !== "string" || !sharingDomain.trim())) {
    throw new Error(
      "context.sharingDomain must be null or a non-empty string. null scopes Context data to the " +
      "deployment's public origin, which is what the hosted deploy does.");
  }

  const issuer = new URL(config.access.issuer);
  if (issuer.protocol !== "https:" ||
      issuer.origin !== config.access.issuer.replace(/\/$/, "")) {
    throw new Error("Cloudflare Access issuer must be an HTTPS origin only.");
  }
  if (!config.access.audience.trim() || config.access.audience !== config.access.audience.trim()) {
    throw new Error("Cloudflare Access audience must not be blank or padded with whitespace.");
  }
  if (!Array.isArray(config.access.admins) ||
      !config.access.admins.every((email) =>
        typeof email === "string" && /^[^@\s]+@[^@\s]+$/.test(email))) {
    throw new Error("Every Access administrator must be an email address.");
  }

  validateAiGateway(config);
  validateChat(config);
  validateRecords(config);

  if (typeof config.errorReporting.enabled !== "boolean") {
    throw new Error("Error reporting enabled must be a boolean.");
  }
  const release = config.errorReporting.release;
  if (release !== null && release !== undefined &&
      (typeof release !== "string" || !release.trim() || release !== release.trim())) {
    throw new Error("Error reporting release must be null or a non-padded string.");
  }

  const artifactsConfig = config.context.artifacts;
  if (artifactsConfig !== undefined &&
      (artifactsConfig === null || typeof artifactsConfig !== "object" ||
       Array.isArray(artifactsConfig))) {
    throw new Error("Context Artifacts configuration must be an object when present.");
  }
  const artifactsEnabled = artifactsConfig?.enabled;
  if (artifactsEnabled !== undefined && typeof artifactsEnabled !== "boolean") {
    throw new Error("Context Artifacts enabled must be a boolean.");
  }
  const artifactsNamespace = artifactsConfig?.namespace;
  if (artifactsNamespace !== undefined &&
      (typeof artifactsNamespace !== "string" ||
       !/^[a-z\d][a-z\d._-]*$/i.test(artifactsNamespace))) {
    throw new Error("Context Artifacts namespace must be omitted or start with a letter or number and use only letters, numbers, dots, underscores, and hyphens.");
  }

  const formatsDir = config.formatBlueprintsDir;
  if (formatsDir !== undefined && formatsDir !== null &&
      (typeof formatsDir !== "string" || !formatsDir.trim() || formatsDir !== formatsDir.trim())) {
    throw new Error(
      "formatBlueprintsDir must be null or a non-padded path to a directory of .gadget/.json " +
      "format pairs, relative to the repository root.");
  }

  const sampling = config.observability.headSamplingRate;
  if (typeof config.observability.enabled !== "boolean") {
    throw new Error("Observability enabled must be a boolean.");
  }
  if (typeof sampling !== "number" || sampling < 0 || sampling > 1) {
    throw new Error("Observability headSamplingRate must be between 0 and 1.");
  }
  if (typeof config.observability.logs.invocationLogs !== "boolean" ||
      typeof config.observability.traces.enabled !== "boolean") {
    throw new Error("Observability log and trace controls must be booleans.");
  }
  const traceSampling = config.observability.traces.headSamplingRate;
  if (typeof traceSampling !== "number" || traceSampling < 0 || traceSampling > 1) {
    throw new Error("Observability trace sampling must be between 0 and 1.");
  }
  return config;
}

/**
 * How the Workshop reaches AI Gateway, derived rather than configured.
 *
 * The Worker cannot discover its own account at runtime, so it cannot tell whether the gateway it
 * is pointed at is one its `WORKERS_AI` binding can reach. This script can: it holds both account
 * IDs. Everything below follows from comparing them.
 */
export interface AiGatewayPlan {
  /** The account owning the gateway, with `aiGateway.accountId: null` resolved. */
  gatewayAccountId: string;
  /** Whether the gateway lives outside the deployment's own account. */
  crossAccount: boolean;
  /** Whether `CF_AI_GATEWAY_API_TOKEN` has to be installed before the Workshop will start a chat. */
  needsToken: boolean;
  /** One sentence per reason a token is needed. Empty when the binding transport covers it all. */
  tokenReasons: string[];
}

/**
 * {@link AiGatewayPlan} for `config`, or null when the deployment advertises no model catalog.
 *
 * Both IDs are lowercased first. `accountIdPattern` accepts either case, so the same account can be
 * written two ways across `accountId` and `aiGateway.accountId`; comparing the raw strings would
 * read that as cross-account and demand a token for a gateway the binding can reach in-account.
 * Lowercase is also the form the dashboard and the API expect, so it is what the vars carry.
 */
export function aiGatewayPlan(config: DeploymentConfig): AiGatewayPlan | null {
  if (!config.aiGateway.enabled) return null;
  const deploymentAccountId = config.accountId.toLowerCase();
  const gatewayAccountId = (config.aiGateway.accountId ?? config.accountId).toLowerCase();
  const crossAccount = gatewayAccountId !== deploymentAccountId;
  const tokenReasons: string[] = [];
  if (crossAccount) {
    tokenReasons.push(
      `aiGateway.accountId (${gatewayAccountId}) is not the deployment account, so the generated ` +
      "config sets CF_AI_GATEWAY_USE_BINDING=false: the Workers AI binding only reaches gateways " +
      "in the Worker's own account. That leaves the HTTPS transport, which needs a Run + Read " +
      "CF_AI_GATEWAY_API_TOKEN. The opt-out is a flag rather than an unbound WORKERS_AI because " +
      "webFetch's toMarkdown() runs on that binding too.");
  }
  if (config.aiGateway.providers?.includes("google")) {
    tokenReasons.push(
      "The google provider needs CF_AI_GATEWAY_API_TOKEN: pi's Google adapter refuses a custom " +
      "fetch, so Google inference cannot ride the Workers AI binding transport.");
  }
  return { gatewayAccountId, crossAccount, needsToken: tokenReasons.length > 0, tokenReasons };
}

/**
 * The deploy-time half of `AiGatewayConfig`'s constructor checks
 * (cloudflare-os/packages/workshop-backend/src/ai-gateway.ts), mirroring `resolveAiGateway()` in
 * cloudflare-os/scripts/preview/staging-config.ts. A configuration the backend would reject belongs
 * in a failed `pnpm check`, not in somebody's first chat.
 */
function validateAiGateway(config: DeploymentConfig): void {
  if (config.aiGateway.workersAi !== undefined) {
    throw new Error(
      "aiGateway.workersAi does nothing: Workers AI rides the same gateway route as every other " +
      "provider. Leaving the key in place deploys a Workshop with an empty model picker. Delete " +
      "it; list \"cloudflare\" in aiGateway.providers to keep Workers AI models.");
  }
  if (typeof config.aiGateway.enabled !== "boolean") {
    throw new Error("AI Gateway enabled must be a boolean.");
  }
  if (!config.aiGateway.enabled) return;

  const providers = config.aiGateway.providers;
  if (!Array.isArray(providers) || providers.length === 0 ||
      !providers.every((provider) => AI_GATEWAY_PROVIDERS.includes(provider))) {
    throw new Error(
      `AI Gateway providers must be a non-empty subset of ${AI_GATEWAY_PROVIDERS.join(", ")}.`);
  }

  const gatewayAccountId = config.aiGateway.accountId;
  if (gatewayAccountId !== undefined && gatewayAccountId !== null &&
      (typeof gatewayAccountId !== "string" || !accountIdPattern.test(gatewayAccountId))) {
    throw new Error(
      "aiGateway.accountId must be null or 32 hexadecimal characters. null reuses the " +
      "deployment's own account, which is what lets the Workers AI binding reach the gateway " +
      "without an API token.");
  }

  validateAiGatewayModels(config);
}

/**
 * The deployment-owned model allow-list. Every entry is checked here because the backend merges
 * it over its catalogue without further validation: a malformed entry would reach the model
 * picker as a model nobody can chat with.
 */
function validateAiGatewayModels(config: DeploymentConfig): void {
  const models = config.aiGateway.models;
  const providers = config.aiGateway.providers!;
  if (models !== undefined) {
    if (models === null || typeof models !== "object" || Array.isArray(models)) {
      throw new Error("aiGateway.models must be an object keyed by provider when present.");
    }
    for (const [provider, entries] of Object.entries(models)) {
      if (!AI_GATEWAY_PROVIDERS.includes(provider as AiGatewayProvider)) {
        throw new Error(
          `aiGateway.models names unknown provider "${provider}". Providers must be one of ` +
          `${AI_GATEWAY_PROVIDERS.join(", ")}.`);
      }
      if (!providers.includes(provider as AiGatewayProvider)) {
        throw new Error(
          `aiGateway.models lists models for "${provider}", but that provider is not in ` +
          "aiGateway.providers. The Workshop only serves models of enabled providers, so these " +
          `would never appear. Add "${provider}" to aiGateway.providers or remove its models.`);
      }
      if (entries === null || typeof entries !== "object" || Array.isArray(entries)) {
        throw new Error(`aiGateway.models.${provider} must be an object keyed by model id.`);
      }
      for (const [modelId, model] of Object.entries(entries)) {
        const where = `aiGateway.models.${provider}["${modelId}"]`;
        if (!modelId.trim() || modelId !== modelId.trim()) {
          throw new Error(`${where}: model ids must not be blank or padded with whitespace.`);
        }
        if (model === null || typeof model !== "object" || Array.isArray(model)) {
          throw new Error(`${where} must be an object with name and contextWindow.`);
        }
        // Hand-edited JSONC: the declared type says what is valid, not what is on disk.
        const { name, contextWindow, outputLimit } = model as unknown as Record<string, unknown>;
        if (typeof name !== "string" || !name.trim()) {
          throw new Error(`${where}.name must be a non-empty string.`);
        }
        if (!Number.isInteger(contextWindow) || (contextWindow as number) <= 0) {
          throw new Error(`${where}.contextWindow must be a positive integer.`);
        }
        if (outputLimit !== undefined &&
            (!Number.isInteger(outputLimit) || (outputLimit as number) <= 0)) {
          throw new Error(`${where}.outputLimit must be omitted or a positive integer.`);
        }
      }
    }
  }
  if (providers.includes("openrouter") &&
      Object.keys(models?.openrouter ?? {}).length === 0) {
    throw new Error(
      "The openrouter provider has no built-in models: list at least one under " +
      "aiGateway.models.openrouter, keyed by OpenRouter model id. Without one the provider " +
      "deploys with nothing in the model picker.");
  }
}

/**
 * The team chat block. Dormant unless enabled, like `aiGateway`: a disabled deployment generates no
 * chat Worker, so nothing else in the block has to be valid.
 */
function validateChat(config: DeploymentConfig): void {
  const chat = config.chat;
  if (chat === undefined) return;
  if (chat === null || typeof chat !== "object" || Array.isArray(chat)) {
    throw new Error('chat must be an object when present. Use { "enabled": false } to turn it off.');
  }
  if (typeof chat.enabled !== "boolean") {
    throw new Error("chat.enabled must be a boolean.");
  }
  if (chat.agentReplies !== undefined && typeof chat.agentReplies !== "boolean") {
    throw new Error("chat.agentReplies must be a boolean when present.");
  }
  if (!chat.enabled) {
    if (chat.agentAccess) {
      throw new Error(
        "chat.agentAccess is true while chat.enabled is false: there would be no chat Worker for " +
        "the Workshop to bind. Enable chat, or drop agentAccess.");
    }
    if (chat.agentReplies) {
      throw new Error(
        "chat.agentReplies is true while chat.enabled is false: there would be no chat Worker to " +
        "answer @agent in. Enable chat, or drop agentReplies.");
    }
    return;
  }
  if (chat.filesBucket !== null &&
      (typeof chat.filesBucket !== "string" || !chat.filesBucket.trim())) {
    throw new Error(
      "chat.filesBucket must be null or an existing R2 bucket name. null lets Wrangler provision " +
      "one and remember it; a name adopts a bucket, which is how uploads survive a rename.");
  }
  if (!Number.isInteger(chat.maxUploadBytes) || chat.maxUploadBytes <= 0 ||
      chat.maxUploadBytes > maxChatUploadBytes) {
    throw new Error(
      `chat.maxUploadBytes must be a positive integer of at most ${maxChatUploadBytes}: one upload ` +
      "arrives as a single Worker request body, and that is the platform's own limit.");
  }
  if (chat.agentAccess !== undefined && typeof chat.agentAccess !== "boolean") {
    throw new Error("chat.agentAccess must be a boolean when present.");
  }
}

/**
 * The Records block. Dormant unless enabled, like chat: a disabled deployment generates no Records
 * Worker, so nothing else in the block has to be valid -- placeholders included.
 *
 * What cannot be checked from here: that both Hyperdrive configurations have query caching
 * DISABLED. Permission and registry reads must be fresh, and a cached read can serve a revoked
 * grant. That is an operator prerequisite (deployment.jsonc) and not something this script can see.
 */
function validateRecords(config: DeploymentConfig): void {
  const records = config.records;
  if (records === undefined) return;
  if (records === null || typeof records !== "object" || Array.isArray(records)) {
    throw new Error('records must be an object when present. Use { "enabled": false } to turn it off.');
  }
  if (typeof records.enabled !== "boolean") {
    throw new Error("records.enabled must be a boolean.");
  }
  if (!records.enabled) return;
  for (const key of ["hyperdriveId", "publisherHyperdriveId"] as const) {
    if (!hyperdriveIdPattern.test(records[key])) {
      throw new Error(
        `records.${key} must be a Hyperdrive configuration ID: 32 hexadecimal characters ` +
        "(wrangler hyperdrive list).");
    }
  }
  if (records.hyperdriveId.toLowerCase() === records.publisherHyperdriveId.toLowerCase()) {
    throw new Error(
      "records.hyperdriveId and records.publisherHyperdriveId must be different Hyperdrive " +
      "configurations: one connects as the runtime application role (records_app), the other as the " +
      "outbox publisher role (records_publisher), and neither role may act as the other.");
  }
  if (!accessAudiencePattern.test(records.apiAccessAudience)) {
    throw new Error(
      "records.apiAccessAudience must be an Access application AUD tag (64 hexadecimal characters): " +
      "the path-specific Access application protecting /gatekeeper/records/v1/*.");
  }
  if (records.apiAccessAudience.toLowerCase() === config.access.audience.toLowerCase()) {
    throw new Error(
      "records.apiAccessAudience is the same as access.audience. The machine API needs its own " +
      "path-specific Access application (service tokens) for /gatekeeper/records/v1/*, separate " +
      "from the one people sign in through.");
  }
  const queues = recordsQueues(config);
  for (const [key, name] of [["changesQueue", queues.changes], ["deadLetterQueue", queues.deadLetter]]) {
    if (typeof name !== "string" || !queueNamePattern.test(name)) {
      throw new Error(
        `records.${key} must be omitted or a queue name of lowercase letters, numbers and hyphens ` +
        "(at most 63 characters).");
    }
  }
  if (queues.changes === queues.deadLetter) {
    throw new Error("records.changesQueue and records.deadLetterQueue must be different queues.");
  }
}

/** The Records change queue and its dead-letter queue, defaults applied. */
export function recordsQueues(config: DeploymentConfig): { changes: string; deadLetter: string } {
  const worker = config.workers.records?.name;
  return {
    changes: config.records?.changesQueue ?? `${worker}-changes`,
    deadLetter: config.records?.deadLetterQueue ?? `${worker}-changes-dlq`,
  };
}

/** `aiGateway.models` with empty providers dropped, or undefined when nothing remains. */
function extraModels(config: DeploymentConfig): AiGatewayModels | undefined {
  const entries = Object.entries(config.aiGateway.models ?? {})
    .filter(([, models]) => models && Object.keys(models).length > 0);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function routeConfig(route: RouterRoute) {
  return route.workersDev
    ? { workers_dev: true, routes: undefined }
    : { workers_dev: false, routes: [{ pattern: route.customDomain!, custom_domain: true }] };
}

function setCommon(
  config: ProdWranglerConfig,
  deployment: DeploymentConfig,
  name: string,
  route: RouterRoute = { workersDev: false },
): void {
  config.account_id = deployment.accountId;
  config.name = name;
  config.workers_dev = route.workersDev;
  delete config.routes;
  if (route.customDomain) Object.assign(config, routeConfig(route));
  // The router is the Access-protected origin, and a preview URL is an unauthenticated path around
  // it. Off on every Worker: the five behind the router have no business being publicly reachable
  // either.
  config.preview_urls = false;
  config.observability = {
    ...config.observability,
    enabled: deployment.observability.enabled,
    head_sampling_rate: deployment.observability.headSamplingRate,
    logs: {
      ...config.observability?.logs,
      invocation_logs: deployment.observability.logs.invocationLogs,
    },
    traces: {
      ...config.observability?.traces,
      enabled: deployment.observability.traces.enabled,
      head_sampling_rate: deployment.observability.traces.headSamplingRate,
    },
  };
}

export function generateConfigs(config: DeploymentConfig, bases: BaseConfigs): GeneratedConfigs {
  validateConfig(config);
  // Before anything is derived from them: a var this script overwrites would otherwise vanish from
  // the result, and with it the evidence that a *dev* base config was read.
  requireNoDevValues(bases, "base wrangler.jsonc");
  const router = structuredClone(bases.router);
  const workshop = structuredClone(bases.workshop);
  const context = structuredClone(bases.context);
  const scheduler = structuredClone(bases.scheduler);
  const procgen = structuredClone(bases.procgen);
  const customGatekeeper = structuredClone(bases.customGatekeeper);
  const errorReporter = config.errorReporting.enabled
    ? structuredClone(bases.errorReporter)
    : undefined;
  const runtime = config.runtime?.enabled ? structuredClone(bases.runtime) : undefined;
  if (config.runtime?.enabled && !runtime) throw new Error("Python runtime base configuration is required.");
  const chat = config.chat?.enabled ? structuredClone(bases.chat) : undefined;
  if (config.chat?.enabled && !chat) throw new Error("Team chat base configuration is required.");
  const webSearch = config.webSearch?.enabled ? structuredClone(bases.webSearch) : undefined;
  if (config.webSearch?.enabled && !webSearch) throw new Error("Web search base configuration is required.");
  const records = config.records?.enabled ? structuredClone(bases.records) : undefined;
  if (config.records?.enabled && !records) throw new Error("Records base configuration is required.");
  const jev = config.jev?.enabled ? structuredClone(bases.jev) : undefined;
  if (config.jev?.enabled && !jev) throw new Error("Jev base configuration is required.");
  const origin = publicOrigin(config);

  setCommon(router, config, config.workers.router.name, config.workers.router.route);
  router.services = [
    { binding: "WORKSHOP_BACKEND", service: config.workers.workshop.name },
    // No entrypoint and no props: the router forwards whole HTTP requests, unlike the backend's
    // vendor-RPC bindings. The binding name is what picks the /gatekeeper/<name> path.
    { binding: "GATEKEEPER_CONTEXT", service: config.workers.context.name },
    { binding: "GATEKEEPER_SCHEDULER", service: config.workers.scheduler.name },
    { binding: "GATEKEEPER_CUSTOM", service: config.workers.customGatekeeper.name },
    // Chat is the one Gatekeeper here that is also a web app: this binding is what routes
    // /gatekeeper/chat -- the SPA, its JSON API, its WebSocket upgrade and its file downloads -- to
    // it. Plain fetch, like the three above.
    ...(config.chat?.enabled
      ? [{ binding: "GATEKEEPER_CHAT", service: config.workers.chat!.name }]
      : []),
    // /gatekeeper/records: the machine API (/v1, behind its own path-specific Access application)
    // and the people connect flow. Plain fetch; the router stays the sole public entrypoint.
    ...(records
      ? [{ binding: "GATEKEEPER_RECORDS", service: config.workers.records!.name }]
      : []),
  ];

  setCommon(workshop, config, config.workers.workshop.name);
  workshop.vars = {
    ADMINS: config.access.admins,
    CF_ACCESS_ISS: config.access.issuer.replace(/\/$/, ""),
    CF_ACCESS_AUD: config.access.audience,
    // Upstream builds OAuth redirect URIs and other absolute links from this. The backend has no
    // public route of its own, so the router's origin is the only correct value.
    PUBLIC_BASE_URL: origin,
  };
  const gateway = aiGatewayPlan(config);
  const models = extraModels(config);
  if (gateway) {
    Object.assign(workshop.vars, {
      CF_AI_GATEWAY: config.aiGateway.name,
      CF_AI_GATEWAY_ACCOUNT_ID: gateway.gatewayAccountId,
      CF_AI_GATEWAY_PROVIDERS: config.aiGateway.providers!.join(","),
      // A JSON object, like ADMINS is an array: wrangler passes structured vars through verbatim.
      // Only when non-empty, so the common no-allow-list deployment carries no dormant key.
      ...(models ? { CF_AI_GATEWAY_EXTRA_MODELS: models } : {}),
      ...(gateway.crossAccount ? { CF_AI_GATEWAY_USE_BINDING: "false" } : {}),
    });
    // Only when a token is genuinely needed. On the common path the WORKERS_AI binding is the
    // transport and is pre-authenticated in-account, so demanding a secret would block a deploy
    // that has everything it needs. Where one IS needed, wrangler refusing to deploy without it is
    // a better check than anything this script could do.
    if (gateway.needsToken) {
      workshop.secrets = {
        required: [...new Set([
          ...(workshop.secrets?.required ?? []),
          "CF_AI_GATEWAY_API_TOKEN",
        ])],
      };
    }
  }
  // Unconditional: as well as being the AI Gateway transport, this binding is what webFetch's
  // toMarkdown() runs on.
  workshop.ai = { binding: "WORKERS_AI" };
  workshop.services = [
    ...(config.errorReporting.enabled ? [{
      binding: "ERROR_REPORTER",
      service: config.workers.errorReporter!.name,
      entrypoint: "ErrorReporter",
      props: {
        service: config.workers.workshop.name,
        environment: config.errorReporting.environment,
        ...(config.errorReporting.release ? { release: config.errorReporting.release } : {}),
      },
    }] : []),
    {
      binding: "GATEKEEPER_CONTEXT",
      service: config.workers.context.name,
      entrypoint: "GatekeeperVendor",
      props: { sharingDomain: config.context.sharingDomain ?? origin },
    },
    // No props: unlike Context, the Scheduler scopes nothing to a domain -- its schedules live in
    // its own `ScheduleDriver`/`SchedulerGatekeeper` Durable Objects, which belong to that Worker's
    // script identity and are reached through `ctx.exports` rather than a binding.
    {
      binding: "GATEKEEPER_SCHEDULER",
      service: config.workers.scheduler.name,
      entrypoint: "GatekeeperVendor",
    },
    {
      binding: "GATEKEEPER_PROCGEN",
      service: config.workers.procgen.name,
      entrypoint: "GatekeeperVendor",
    },
    {
      binding: "GATEKEEPER_CUSTOM",
      service: config.workers.customGatekeeper.name,
      entrypoint: "GatekeeperVendor",
    },
    // The agent-facing half of chat, and the only part of it that is opt-in: `chat.enabled` deploys
    // the app, `chat.agentAccess` hands every workspace an ambient ChatSession. Separate because the
    // app is useful without it, and because this binding names an entrypoint on a Worker deployed
    // moments earlier in the same run -- pointing it at a chat build that does not export
    // `GatekeeperVendor` yet would fail the *Workshop* deploy, for a reason nothing in chat explains.
    ...(config.chat?.enabled && config.chat.agentAccess ? [{
      binding: "GATEKEEPER_CHAT",
      service: config.workers.chat!.name,
      entrypoint: "GatekeeperVendor",
    }] : []),
    // RPC only, like Synthetic Data: agents reach it through the Workshop, never the router.
    ...(webSearch ? [{
      binding: "GATEKEEPER_WEBSEARCH",
      service: config.workers.webSearch!.name,
      entrypoint: "GatekeeperVendor",
    }] : []),
    // No props: the vendor scopes nothing to a domain; datastore scoping is per account binding.
    ...(records ? [{
      binding: "GATEKEEPER_RECORDS",
      service: config.workers.records!.name,
      entrypoint: "GatekeeperVendor",
    }] : []),
    ...(jev ? [{
      binding: "GATEKEEPER_JEV",
      service: config.workers.jev!.name,
      entrypoint: "GatekeeperVendor",
    }] : []),
  ];
  if (runtime && config.runtime) {
    setCommon(runtime, config, config.runtime.workerName);
    runtime.containers = runtime.containers?.map(container => ({ ...container, max_instances: config.runtime!.maxInstances }));
    // RPC only: no Router binding, HTTP ingress or preview URLs for Python execution.
    workshop.services!.push({ binding: "GATEKEEPER_RUNTIME", service: config.runtime.workerName, entrypoint: "GatekeeperVendor" });
  }
  workshop.kv_namespaces = [
    { binding: "BLUEPRINTS", ...(config.resources.blueprintsKvNamespaceId
      ? { id: config.resources.blueprintsKvNamespaceId } : {}) },
    { binding: "AVATARS", ...(config.resources.avatarsKvNamespaceId
      ? { id: config.resources.avatarsKvNamespaceId } : {}) },
  ];
  workshop.r2_buckets = [
    { binding: "BLUEPRINT_CONTENT", ...(config.resources.blueprintContentBucket
      ? { bucket_name: config.resources.blueprintContentBucket } : {}) },
  ];
  // The router serves the frontend, and it is the only Worker with a public route.
  delete workshop.assets;

  setCommon(context, config, config.workers.context.name);
  context.kv_namespaces = [
    { binding: "CONTEXT_COLLECTIONS", ...(config.context.kvNamespaceId
      ? { id: config.context.kvNamespaceId } : {}) },
  ];
  if (config.context.artifacts?.enabled ?? false) {
    context.artifacts = [{
      binding: "ARTIFACTS",
      namespace: config.context.artifacts?.namespace ?? defaultContextArtifactsNamespace,
    }];
  } else {
    delete context.artifacts;
  }

  // Nothing but the common block: the Scheduler takes no vars, no secrets and no storage bindings of
  // its own -- which is what makes it installable with no user interaction upstream, and deployable
  // here without adding a configuration surface for it.
  setCommon(scheduler, config, config.workers.scheduler.name);

  // Synthetic Data is RPC-only. Its configurator iframe is returned over RPC, so exposing the
  // Worker through the Router would add an unnecessary public ingress path.
  setCommon(procgen, config, config.workers.procgen.name);

  setCommon(customGatekeeper, config, config.workers.customGatekeeper.name);
  customGatekeeper.vars = {
    CUSTOM_NAME: config.customGatekeeper.name,
    CUSTOM_MESSAGE: config.customGatekeeper.message,
  };

  if (errorReporter) {
    setCommon(errorReporter, config, config.workers.errorReporter!.name);
  }

  if (chat && config.chat) {
    setCommon(chat, config, config.workers.chat!.name);
    chat.vars = {
      // The same trust boundary the Workshop gets, because chat verifies the Access JWT itself on
      // every request and WebSocket upgrade rather than trusting the router. ADMINS in the same
      // structured form: admin powers come from the deployment, never from a client flag.
      ADMINS: config.access.admins,
      CF_ACCESS_ISS: config.access.issuer.replace(/\/$/, ""),
      CF_ACCESS_AUD: config.access.audience,
      // Chat is reached through the router, so its absolute links and permalinks are the router's
      // origin plus /gatekeeper/chat, not a hostname of its own.
      PUBLIC_BASE_URL: origin,
      // A number, not a string: wrangler passes structured vars through verbatim, as it does ADMINS.
      MAX_UPLOAD_BYTES: config.chat.maxUploadBytes,
    };
    chat.r2_buckets = [
      { binding: "FILES", ...(config.chat.filesBucket
        ? { bucket_name: config.chat.filesBucket } : {}) },
    ];
    // `@agent` answers: the Workshop's ExternalMessageGateway, the same entrypoint-plus-props shape
    // as the Workshop's own ERROR_REPORTER binding. `source` is the gateway's namespace for this
    // caller's keys (its workspaces are named `chat:user:<id>`), so it is fixed here rather than
    // configurable: changing it would orphan every asker's existing "Chat agent" workspace.
    if (agentRepliesEnabled(config)) {
      chat.services = [{
        binding: "WORKSHOP_GATEWAY",
        service: config.workers.workshop.name,
        entrypoint: "ExternalMessageGateway",
        props: { source: "chat" },
      }];
    } else {
      delete chat.services;
    }
    // `assets` is inherited untouched, unlike the Workshop's: chat serves its own SPA from
    // `app/dist` behind its own Access check (`run_worker_first`), and the router only proxies to it.
  }

  if (webSearch && config.webSearch) {
    setCommon(webSearch, config, config.workers.webSearch!.name);
    webSearch.vars = webSearchVars(config, origin);
    // `secrets.required: ["OPENROUTER_API_KEY"]` is inherited from the package's wrangler.jsonc, so
    // wrangler refuses to deploy until the key has been installed with `wrangler secret put`.
  }

  if (records && config.records) {
    setCommon(records, config, config.workers.records!.name);
    records.vars = {
      // The same people trust boundary the Workshop and chat get: the connect flow verifies the
      // Access JWT of the person connecting.
      CF_ACCESS_ISS: config.access.issuer.replace(/\/$/, ""),
      CF_ACCESS_AUD: config.access.audience,
      // The machine API's own, path-specific Access application (service tokens).
      RECORDS_API_ACCESS_AUD: config.records.apiAccessAudience,
      PUBLIC_BASE_URL: origin,
    };
    // Both Hyperdrive configurations must have query caching DISABLED (checked by the operator, not
    // here). Rebuilt from the base bindings so `localConnectionString`, which is for `wrangler dev`
    // against a disposable database only, never reaches a deployed config.
    const hyperdriveIds: Record<string, string> = {
      HYPERDRIVE: config.records.hyperdriveId,
      HYPERDRIVE_PUBLISHER: config.records.publisherHyperdriveId,
    };
    const baseHyperdrive = records.hyperdrive ?? [];
    for (const binding of Object.keys(hyperdriveIds)) {
      if (!baseHyperdrive.some((entry) => entry.binding === binding)) {
        throw new Error(`${packageDirs.records}/wrangler.jsonc declares no ${binding} Hyperdrive binding.`);
      }
    }
    records.hyperdrive = baseHyperdrive.map(({ binding }) => {
      const id = hyperdriveIds[binding];
      if (!id) {
        throw new Error(
          `${packageDirs.records}/wrangler.jsonc declares Hyperdrive binding ${binding}, which ` +
          "deployment.jsonc has no ID for.");
      }
      return { binding, id };
    });
    const queues = recordsQueues(config);
    const baseQueues = records.queues ?? {};
    if (!baseQueues.producers?.length || !baseQueues.consumers?.length) {
      throw new Error(`${packageDirs.records}/wrangler.jsonc must declare a queue producer and consumer.`);
    }
    // One queue: the Worker produces change events and consumes them itself, failing over to the DLQ.
    records.queues = {
      producers: baseQueues.producers.map((producer) => ({ ...producer, queue: queues.changes })),
      consumers: baseQueues.consumers.map((consumer) => ({
        ...consumer,
        queue: queues.changes,
        dead_letter_queue: queues.deadLetter,
      })),
    };
    // Migrations, the cron trigger, the rate limiter and the capnweb-validate build step are
    // inherited from the package's wrangler.jsonc. No secrets: database credentials live in the
    // Hyperdrive configurations.
  }

  if (jev && config.jev) {
    // RPC only, and like web search it inherits `secrets.required: ["OPENROUTER_API_KEY"]`.
    setCommon(jev, config, config.workers.jev!.name);
  }

  const generated: GeneratedConfigs = {
    router, workshop, context, scheduler, procgen, customGatekeeper,
    ...(errorReporter && { errorReporter }),
    ...(runtime && { runtime }),
    ...(chat && { chat }),
    ...(webSearch && { webSearch }),
    ...(records && { records }),
    ...(jev && { jev }),
  };
  requireNoDevValues(generated, "generated production config");
  requireNoLocalConnectionStrings(generated);
  return generated;
}

/**
 * No sign-in bypass in a deployed config.
 *
 * Chat has a dev-only identity wrapper, switched on by `DEV_IDENTITIES` in its `wrangler.dev.jsonc`;
 * in production that var is an identity bypass sitting behind the Access-protected hostname. Applied
 * to the base configs and to the generated ones, because the two catch different mistakes: a `DEV_*`
 * var this script happens to overwrite would disappear from the result, taking with it the only sign
 * that a dev base config was read, while one on a Worker whose vars are inherited only ever shows up
 * in the result. Nothing here is chat-specific: the rule is the prefix, on every Worker.
 */
function requireNoDevValues(configs: BaseConfigs | GeneratedConfigs, where: string): void {
  for (const [name, worker] of
       Object.entries(configs) as [string, ProdWranglerConfig | undefined][]) {
    const offenders = [
      ...Object.keys(worker?.vars ?? {}),
      ...(worker?.secrets?.required ?? []),
    ].filter((key) => key.startsWith("DEV_"));
    if (offenders.length) {
      throw new Error(
        `${name}: ${where} carries dev-only value(s) ${offenders.join(", ")}. DEV_IDENTITIES and ` +
        "anything else DEV_* belongs to wrangler.dev.jsonc only -- in production it is an identity " +
        "bypass behind the Access-protected hostname.");
    }
    // The other half of the same mistake, and the one no var would reveal: chat's dev config differs
    // from its production one mainly in `main`, which boots the dev-identity entry point.
    if (worker?.main?.includes("/dev/")) {
      throw new Error(
        `${name}: ${where} has a dev entry point (main: ${worker.main}). Production must boot the ` +
        "module with no identity bypass in it.");
    }
  }
}

/**
 * A Hyperdrive `localConnectionString` is a dev database URL with a password in it. It belongs to
 * `wrangler dev`; in a deployed config it is at best ignored and at worst a leaked credential.
 */
function requireNoLocalConnectionStrings(configs: GeneratedConfigs): void {
  for (const [name, worker] of Object.entries(configs) as [string, ProdWranglerConfig | undefined][]) {
    if (worker?.hyperdrive?.some((entry) => "localConnectionString" in entry)) {
      throw new Error(
        `${name}: generated production config carries a Hyperdrive localConnectionString, which is ` +
        "for wrangler dev only.");
    }
  }
}

// `--no-cache` goes before the task name. Everything after it is `[ADDITIONAL_ARGS]`, forwarded to
// the task's own command -- `vp run -F x build --no-cache` reaches `tsc` as an unknown option.

/** `vp run --no-cache <task>` for a package in the submodule's workspace. */
function submoduleBuild(pkg: string, task = "build"): string[] {
  return ["--dir", "cloudflare-os", "exec", "vp", "run", "-F", pkg, "--no-cache", task];
}

/** `vp run --no-cache <task>` for a package in this repository's own workspace. */
function ownBuild(pkg: string, task = "build"): string[] {
  return ["exec", "vp", "run", "-F", pkg, "--no-cache", task];
}

/** `pnpm run <script>` in one submodule package. For plain scripts that spawn no `vp` task. */
function submoduleScript(pkg: string, script: string): string[] {
  return ["--dir", "cloudflare-os", "--filter", pkg, "run", script];
}

/** `pnpm exec <command>` in one submodule package. */
function submoduleExec(pkg: string, ...command: string[]): string[] {
  return ["--dir", "cloudflare-os", "--filter", pkg, "exec", ...command];
}

/**
 * The build steps `pnpm check` and `pnpm deploy` run, in order, from the repository root.
 *
 * Every one goes through `vp run` rather than `pnpm --filter <pkg> build`. Two of the three
 * submodule targets have no `build` *script* at all any more -- they have a Vite+ *task*, which
 * `pnpm --filter` cannot see -- and `vp run` runs scripts and tasks alike, so one form covers both.
 *
 * `--no-cache` on every one. A cache hit is only as good as its fingerprint, which is cheap to get
 * wrong on a build you can re-run and expensive on a deploy you cannot; it is upstream's rule for
 * the same reason (cloudflare-os/scripts/deploy-scripts.test.ts). It also restores the full ambient
 * environment, which is the belt to `workshop-frontend`'s `env: ['VITE_*']` braces: under a *cached*
 * `vp` run only declared patterns survive, and an undeclared variable is dropped from the command
 * and from the fingerprint both.
 *
 * The ordering matters at the end: the frontend has to build before the router deploy picks up
 * `../workshop-frontend/dist` as its assets.
 */
export function buildCommands(config: DeploymentConfig): BuildCommand[] {
  return [
    // `gatekeeper-context`'s `build` is a package.json script: `typecheck:app`, then a nested
    // `vp run --cache build:app`, then `tsc`. The outer `--no-cache` does not reach a nested
    // invocation carrying its own flag -- measured: the configurator app replayed from cache. So
    // the script is not run at all; its three parts are, with the app rebuilt from source the way
    // upstream's own `deploy` script does. A cached `vp` run also never starts on hosts whose
    // kernel refuses Vite+'s seccomp-based file tracking (WSL2, at the time of writing).
    { args: submoduleBuild("@gadgets/gatekeeper-context", "build:app") },
    { args: submoduleScript("@gadgets/gatekeeper-context", "typecheck:app") },
    { args: submoduleExec("@gadgets/gatekeeper-context", "tsc") },
    // The Scheduler's `build` is the same three-part script, so it gets the same treatment.
    { args: submoduleBuild("@gadgets/gatekeeper-scheduler", "build:app") },
    { args: submoduleScript("@gadgets/gatekeeper-scheduler", "typecheck:app") },
    { args: submoduleExec("@gadgets/gatekeeper-scheduler", "tsc") },
    { args: ownBuild("gatekeeper-procgen") },
    { args: ownBuild("custom-gatekeeper") },
    ...(config.runtime?.enabled ? [{ args: ownBuild("gatekeeper-runtime") }] : []),
    // Chat's `build` is the Vite build of its SPA into `app/dist`, which its `assets` binding
    // uploads. The Worker half needs no step here: the package's wrangler.jsonc declares the
    // capnweb-validate build as a `build.command`, so wrangler runs it at deploy time, exactly as the
    // custom Gatekeeper's does.
    ...(config.chat?.enabled ? [{ args: ownBuild("gatekeeper-chat") }] : []),
    ...(config.webSearch?.enabled ? [{ args: ownBuild("gatekeeper-websearch") }] : []),
    // Records: its Data management SPA is inlined into src/generated/ by build-app.mjs (a one-shot
    // Vite build, no watch), which the Worker imports -- so it runs first. Then the package's `build`
    // task, a `tsc` type-check. The Worker bundle itself is the capnweb-validate `build.command` in
    // its wrangler.jsonc, which wrangler runs at deploy time.
    ...(config.records?.enabled ? [
      { args: ["--filter", "gatekeeper-records", "exec", "node", "build-app.mjs"] },
      { args: ownBuild("gatekeeper-records") },
    ] : []),
    ...(config.jev?.enabled ? [{ args: ownBuild("gatekeeper-jev") }] : []),
    ...(config.errorReporting.enabled ? [{ args: ownBuild("error-reporter") }] : []),
    // Access mode is a build-time constant in the frontend bundle (`src/useAuth.ts`), so it is set
    // here rather than inherited: a bundle built under a different value is wrong, not just stale.
    // `VITE_CHAT_DOCK` is the same kind of thing for the chat dock (the fork's `ChatDock.tsx`): a flag
    // tied to this deployment's wiring rather than a runtime probe of `/gatekeeper/chat`, so a chat
    // Worker that is briefly down shows an unavailable state instead of making the dock vanish. Off
    // when chat is not deployed, and the dock, its triggers and its route drop out of the bundle.
    {
      args: submoduleBuild("@gadgets/workshop-frontend"),
      env: {
        VITE_CF_ACCESS_MODE: "true",
        ...(config.chat?.enabled ? { VITE_CHAT_DOCK: "true" } : {}),
      },
    },
    { args: submoduleBuild("@gadgets/router") },
    // The backend inlines its bundled format blueprints at build time. Absolute, because upstream
    // resolves a relative FORMAT_BLUEPRINTS_DIR against its own package, not this repository.
    {
      args: submoduleBuild("@gadgets/workshop-backend"),
      ...(config.formatBlueprintsDir && {
        env: { FORMAT_BLUEPRINTS_DIR: formatBlueprintsPath(config.formatBlueprintsDir) },
      }),
    },
  ];
}

/**
 * The web search gate's deployment-specific detector lists: literal strings no query may contain,
 * and private hostname suffixes. JSON arrays, which wrangler passes through as structured vars.
 */
export function webSearchVars(config: DeploymentConfig, origin: string): Record<string, string[]> {
  const publicHost = new URL(origin).hostname;
  const accessHost = new URL(config.access.issuer).hostname;
  const route = config.workers.router.route;
  const parent = route.customDomain?.split(".").slice(1).join(".");
  const derived = parent?.includes(".") ? [parent] : [];
  return {
    BLOCKED_TERMS: [...new Set([config.accountId, accessHost, ...(config.webSearch?.blockedTerms ?? [])])],
    PRIVATE_DOMAINS: config.webSearch?.privateDomains ?? derived,
    PUBLIC_HOSTS: [publicHost],
  };
}

/** `chat.agentReplies`, defaulted: on whenever chat itself is. */
export function agentRepliesEnabled(config: DeploymentConfig): boolean {
  return (config.chat?.enabled ?? false) && config.chat?.agentReplies !== false;
}

/**
 * The Workers to deploy, in order. Data rather than a sequence of calls so the order is testable:
 * every binding points *backwards* in this list, so a deploy that fails part-way leaves the previous
 * Workers bound to what they were bound to before.
 *
 * The router always binds chat, so chat precedes it. Chat and the Workshop can bind each other:
 * chat binds the Workshop's ExternalMessageGateway for `@agent` answers (`chat.agentReplies`, on by
 * default), and the Workshop binds chat's Gatekeeper vendor under `chat.agentAccess` (off by
 * default). With only the first, the Workshop goes first and every binding still points backwards.
 * With both it is a cycle, which the platform accepts between two Workers that already exist; chat
 * then goes first, as it always has for `agentAccess`, and its binding to the Workshop is the one
 * forward edge -- so a *first-ever* deploy with both switched on must be run once with
 * `agentReplies: false` (README, "Agent"): a binding's target has to exist when the Worker holding
 * it is deployed, which is also why `agentAccess` is its own switch.
 */
export function deployOrder(config: DeploymentConfig): (keyof typeof packageDirs)[] {
  const chat = config.chat?.enabled ? ["chat" as const] : [];
  const chatFirst = config.chat?.agentAccess === true;
  return [
    ...(config.errorReporting.enabled ? ["errorReporter" as const] : []),
    "context",
    "scheduler",
    "procgen",
    "customGatekeeper",
    ...(config.runtime?.enabled ? ["runtime" as const] : []),
    ...(config.webSearch?.enabled ? ["webSearch" as const] : []),
    // Records binds nothing; the Workshop (vendor) and the router (/gatekeeper/records) bind it.
    ...(config.records?.enabled ? ["records" as const] : []),
    ...(config.jev?.enabled ? ["jev" as const] : []),
    ...(chatFirst ? chat : []),
    "workshop",
    ...(chatFirst ? [] : chat),
    // Last: it binds every one of the above.
    "router",
  ];
}

/** `formatBlueprintsDir` resolved against the repository root. */
export function formatBlueprintsPath(dir: string): string {
  return resolve(root, dir);
}

/**
 * Upstream's generator only warns on an empty directory and then ships no formats at all, Docs,
 * Sheets and Slides included, because the directory replaces its defaults. Refuse that here.
 */
function requireFormatBlueprints(config: DeploymentConfig): void {
  if (!config.formatBlueprintsDir) return;
  const dir = formatBlueprintsPath(config.formatBlueprintsDir);
  const archives = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".gadget")) : [];
  if (!archives.length) {
    throw new Error(`formatBlueprintsDir ${config.formatBlueprintsDir} holds no .gadget archives.`);
  }
  const missing = archives.filter((f) => !existsSync(join(dir, f.replace(/\.gadget$/, ".json"))));
  if (missing.length) {
    throw new Error(`formatBlueprintsDir: no .json sidecar beside ${missing.join(", ")}.`);
  }
}

/**
 * The chat package has to be on disk before anything can be generated for it: its base
 * `wrangler.jsonc` is where the DO migrations, the `assets` block and the capnweb-validate build step
 * come from. Said in one line here rather than as an ENOENT from the config reader.
 */
function requireChatPackage(config: DeploymentConfig): void {
  if (!config.chat?.enabled) return;
  if (!existsSync(join(root, packageDirs.chat, "wrangler.jsonc"))) {
    throw new Error(
      `chat.enabled is true but ${packageDirs.chat}/wrangler.jsonc is missing. Add the package, or ` +
      "set chat.enabled to false.");
  }
}

/** The Records package's base config has to exist before anything can be generated for it. */
function requireRecordsPackage(config: DeploymentConfig): void {
  if (!config.records?.enabled) return;
  if (!existsSync(join(root, packageDirs.records, "wrangler.jsonc"))) {
    throw new Error(
      `records.enabled is true but ${packageDirs.records}/wrangler.jsonc is missing. Add the ` +
      "package, or set records.enabled to false.");
  }
}

/**
 * The chat SPA, after the build that produces it and only on a real deploy.
 *
 * wrangler uploads `app/dist` through the Worker's `assets` binding and does not mind that it is
 * empty, so a build that never ran deploys an origin answering /gatekeeper/chat/ with nothing. A
 * `--check` dry run uploads no assets, so it does not need the directory to exist.
 */
function requireChatAssets(config: DeploymentConfig): void {
  if (!config.chat?.enabled) return;
  const entry = join(root, packageDirs.chat, chatAssetsDir, "index.html");
  if (!existsSync(entry)) {
    throw new Error(
      `${packageDirs.chat}/${chatAssetsDir}/index.html is missing, so the chat Worker would deploy ` +
      "with no app. Its `build` task must build the SPA into " +
      `${chatAssetsDir} (pnpm --filter gatekeeper-chat build).`);
  }
}

// `allowTrailingComma` because wrangler accepts them and upstream uses them: the Scheduler's base
// config closes `build`, `migrations` and `observability` with one. Without the option every such
// comma is a parse *error*, so the deploy refuses a file wrangler itself reads happily.
const jsoncOptions = { allowTrailingComma: true };

async function readJsonc<T>(path: string): Promise<T> {
  const errors: ParseError[] = [];
  const result = parse(await readFile(path, "utf8"), errors, jsoncOptions) as T;
  if (errors.length) {
    const where = relative(root, path) || path;
    throw new Error(`${where}: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`);
  }
  return result;
}

// Every validateConfig message names a config path, so say which file those paths live in.
async function readDeployment(path: string): Promise<DeploymentConfig> {
  const config = await readJsonc<DeploymentConfig>(path);
  try {
    return validateConfig(config);
  } catch (error) {
    throw new Error(`${relative(root, path)}: ${(error as Error).message}`, { cause: error });
  }
}

function runCommand(
  command: string,
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  label: string,
): void {
  const result = spawnSync(command, argv, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const where = relative(root, cwd) || ".";
    throw new Error(`${where}: ${label} failed. Its output is above.`);
  }
}

// Spawned through pnpmCommand rather than as a bare "pnpm": on Windows the pnpm on PATH is a `.cmd`
// shim Node refuses to spawn without a shell, and `shell: true` would re-split argv and break any
// checkout path containing a space.
function run(args: string[], cwd = root, env: NodeJS.ProcessEnv = process.env): void {
  const [command, argv] = pnpmCommand(args, env);
  runCommand(command, argv, cwd, env, `pnpm ${args.join(" ")}`);
}

/**
 * `wrangler deploy` for one package, spawned as `node <entry>` when the entry point behind the
 * `.bin` shim can be found. That saves the ~0.33s `pnpm exec` costs per call and sidesteps the
 * Windows `.cmd` shim entirely; when it cannot be resolved, the pnpm path is still there.
 */
function deployWorker(dir: string, extraArgs: string[]): void {
  const cwd = join(root, dir);
  const args = ["deploy", "--config", generatedName, ...extraArgs];
  const entry = resolveBinEntry(cwd, "wrangler");
  if (entry) {
    runCommand(process.execPath, [entry, ...args], cwd, process.env, `wrangler ${args.join(" ")}`);
  } else {
    run(["exec", "wrangler", ...args], cwd);
  }
}

function requireSubmodule(): void {
  if (!existsSync(join(root, "cloudflare-os/package.json"))) {
    throw new Error("CloudflareOS submodule is not initialized. Run git submodule update --init.");
  }
}

function build(config: DeploymentConfig): void {
  for (const { args, env } of buildCommands(config)) {
    run(args, root, env ? { ...process.env, ...env } : process.env);
  }
}

// Said once, up front, rather than discovered when the first chat throws.
function reportAiGateway(config: DeploymentConfig): void {
  const gateway = aiGatewayPlan(config);
  if (!gateway) {
    console.warn(
      "\naiGateway.enabled is false: this deployment advertises no model catalog, and each user " +
      "supplies their own model API keys. A Workshop migrated from the hosted deploy will show an " +
      "empty model picker -- see docs/migrate-from-hosted.md.");
    return;
  }
  const models = extraModels(config);
  if (models) {
    const counts = Object.entries(models)
      .map(([provider, entries]) => `${provider}: ${Object.keys(entries!).length}`)
      .join(", ");
    console.warn(
      `\naiGateway.models adds deployment-owned models to the catalog (${counts}). Their ` +
      `provider keys must be stored on the "${config.aiGateway.name}" gateway as BYOK -- see ` +
      "docs/customization.md#ai-models.");
  }
  if (!gateway.needsToken) return;
  // CLOUDFLARE_ACCOUNT_ID pins the account the way the deploys themselves are pinned: every
  // generated config carries `account_id`, but `wrangler secret put` takes only `--name`
  console.warn(
    `\nCF_AI_GATEWAY_API_TOKEN is required by this configuration:\n` +
    gateway.tokenReasons.map((reason) => `  - ${reason}`).join("\n") +
    `\nInstall it before deploying:\n  CLOUDFLARE_ACCOUNT_ID=${config.accountId} ` +
    `pnpm exec wrangler secret put CF_AI_GATEWAY_API_TOKEN ` +
    `--name ${config.workers.workshop.name}\n`);
}

async function main(): Promise<void> {
  requireSubmodule();
  const config = await readDeployment(join(root, "deployment.jsonc"));
  requireFormatBlueprints(config);
  requireChatPackage(config);
  requireRecordsPackage(config);
  const generated = generateConfigs(config, {
    router: await readJsonc(join(root, packageDirs.router, "wrangler.jsonc")),
    workshop: await readJsonc(join(root, packageDirs.workshop, "wrangler.jsonc")),
    context: await readJsonc(join(root, packageDirs.context, "wrangler.jsonc")),
    scheduler: await readJsonc(join(root, packageDirs.scheduler, "wrangler.jsonc")),
    procgen: await readJsonc(join(root, packageDirs.procgen, "wrangler.jsonc")),
    customGatekeeper: await readJsonc(join(root, packageDirs.customGatekeeper, "wrangler.jsonc")),
    errorReporter: await readJsonc(join(root, packageDirs.errorReporter, "wrangler.jsonc")),
    ...(config.runtime?.enabled ? { runtime: await readJsonc(join(root, packageDirs.runtime, "wrangler.jsonc")) } : {}),
    ...(config.chat?.enabled ? { chat: await readJsonc(join(root, packageDirs.chat, "wrangler.jsonc")) } : {}),
    ...(config.webSearch?.enabled
      ? { webSearch: await readJsonc(join(root, packageDirs.webSearch, "wrangler.jsonc")) }
      : {}),
    ...(config.records?.enabled
      ? { records: await readJsonc(join(root, packageDirs.records, "wrangler.jsonc")) }
      : {}),
    ...(config.jev?.enabled ? { jev: await readJsonc(join(root, packageDirs.jev, "wrangler.jsonc")) } : {}),
  });
  reportAiGateway(config);

  try {
    for (const [name, generatedConfig] of Object.entries(generated)) {
      await writeFile(
        generatedPaths[name as keyof typeof generatedPaths],
        JSON.stringify(generatedConfig, null, 2) + "\n");
    }
    const check = process.argv.includes("--check");
    if (check) run(["test"]);
    build(config);
    const deployArgs = check ? ["--dry-run"] : [];
    if (!check) requireChatAssets(config);
    for (const name of deployOrder(config)) {
      deployWorker(packageDirs[name], deployArgs);
    }
  } finally {
    await Promise.all(Object.values(generatedPaths).map((path) => rm(path, { force: true })));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    // One line, no stack: every failure here is a config or subprocess problem, not a script bug.
    console.error(`\nDeploy failed. ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
