import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { parse, type ParseError } from "jsonc-parser";
import {
  aiGatewayPlan, buildCommands, deployOrder, formatBlueprintsPath, generateConfigs, recordsQueues,
  validateConfig,
} from "./deploy.ts";
import type {
  BaseConfigs,
  DeploymentConfig,
  GeneratedConfigs,
  ProdWranglerConfig,
} from "./deployment-config.ts";

const validConfig: DeploymentConfig = {
  accountId: "0123456789abcdef0123456789abcdef",
  publicBaseUrl: null,
  workers: {
    router: { name: "acme-cloudflare-os", route: { customDomain: "os.example.com" } },
    workshop: { name: "acme-cloudflare-os-backend" },
    context: { name: "acme-cloudflare-os-context" },
    scheduler: { name: "acme-cloudflare-os-scheduler" },
    procgen: { name: "acme-cloudflare-os-procgen" },
    customGatekeeper: { name: "acme-cloudflare-os-custom" },
    errorReporter: { name: "acme-cloudflare-os-errors" },
    chat: { name: "acme-cloudflare-os-chat" },
  },
  access: {
    issuer: "https://acme.cloudflareaccess.com",
    audience: "access-audience",
    admins: ["admin@example.com"],
  },
  aiGateway: {
    enabled: true,
    name: "cloudflare-os",
    accountId: null,
    providers: ["anthropic", "cloudflare"],
  },
  context: {
    sharingDomain: null,
    kvNamespaceId: "context-kv-id",
    artifacts: { enabled: true, namespace: "acme-context-collections" },
  },
  customGatekeeper: { name: "Acme", message: "Use the company handbook." },
  errorReporting: { enabled: true, environment: "production", release: "abc123" },
  chat: { enabled: true, filesBucket: "acme-cloudflare-os-chat-files", maxUploadBytes: 10485760 },
  resources: {
    blueprintsKvNamespaceId: "blueprints-kv-id",
    avatarsKvNamespaceId: "avatars-kv-id",
    blueprintContentBucket: "cloudflare-os-blueprints",
  },
  observability: {
    enabled: true,
    headSamplingRate: 0.5,
    logs: { invocationLogs: false },
    traces: { enabled: true, headSamplingRate: 0.25 },
  },
};

/**
 * A copy of {@link validConfig} with `mutate` applied, typed loosely on purpose.
 *
 * Most of these variants assign something `DeploymentConfig` forbids, which is exactly what
 * `validateConfig` exists to catch: `deployment.jsonc` is hand-edited JSONC with no schema behind
 * it, so the type describes the valid shape rather than guaranteeing what is on disk.
 */
function variant(mutate: (config: Record<string, any>) => void): DeploymentConfig {
  const config = structuredClone(validConfig) as Record<string, any>;
  mutate(config);
  return config as DeploymentConfig;
}

// Read from disk rather than inlined, including the Error Reporter's: deploy.ts derives every
// generated config from these files, so a copy here could drift from what actually ships.
async function baseConfigs(): Promise<BaseConfigs> {
  return {
    router: await baseConfig("../cloudflare-os/packages/router/wrangler.jsonc"),
    workshop: await baseConfig("../cloudflare-os/packages/workshop-backend/wrangler.jsonc"),
    context: await baseConfig("../cloudflare-os/packages/gatekeeper-context/wrangler.jsonc"),
    scheduler: await baseConfig("../cloudflare-os/packages/gatekeeper-scheduler/wrangler.jsonc"),
    procgen: await baseConfig("../packages/gatekeeper-procgen/wrangler.jsonc"),
    customGatekeeper: await baseConfig("../packages/custom-gatekeeper/wrangler.jsonc"),
    errorReporter: await baseConfig("../packages/error-reporter/wrangler.jsonc"),
    runtime: await baseConfig("../packages/gatekeeper-runtime/wrangler.jsonc"),
    chat: await chatBaseConfig(),
    webSearch: await baseConfig("../packages/gatekeeper-websearch/wrangler.jsonc"),
    records: await baseConfig("../packages/gatekeeper-records/wrangler.jsonc"),
  };
}

/**
 * The chat package's base config, read from disk like every other one once it exists.
 *
 * It is owned by a separate stream, so until it lands this stands in for it -- with the keys
 * `deploy.ts` and these tests actually read, in the shape its `wrangler.jsonc` declares. A stale
 * stand-in cannot hide a drift for long: the moment the file exists it is what is read, and the
 * assertions below are written against the real one.
 */
async function chatBaseConfig(): Promise<ProdWranglerConfig> {
  const path = "../packages/gatekeeper-chat/wrangler.jsonc";
  if (!existsSync(new URL(path, import.meta.url))) {
    return {
      name: "gatekeeper-chat",
      main: ".wrangler/validate/src/index.ts",
      migrations: [{ tag: "v0", new_sqlite_classes: ["ChatWorkspace"] }],
      assets: { binding: "ASSETS", directory: "./app/dist" },
      vars: { MAX_UPLOAD_BYTES: 1 },
      r2_buckets: [{ binding: "FILES" }],
    };
  }
  return baseConfig(path);
}

// Parsed the way `deploy.ts` parses it, errors included. Swallowing them would let a base config
// that the deploy cannot read still pass these tests on a best-effort parse -- which is how the
// Scheduler's trailing commas hid: nine parse errors, and a config object that still looked usable.
async function baseConfig(path: string): Promise<ProdWranglerConfig> {
  const errors: ParseError[] = [];
  const result = parse(
    await readFile(new URL(path, import.meta.url), "utf8"),
    errors,
    { allowTrailingComma: true },
  ) as ProdWranglerConfig;
  assert.deepEqual(errors, [], `${path} did not parse cleanly`);
  return result;
}

/** The Context data-isolation boundary carried by the Workshop's Gatekeeper binding. */
function sharingDomain(generated: GeneratedConfigs): unknown {
  return generated.workshop.services!
    .find((service) => service.binding === "GATEKEEPER_CONTEXT")!.props!.sharingDomain;
}

test("rejects deployment placeholders", () => {
  assert.throws(
    () => validateConfig(variant((c) => { c.accountId = "<CLOUDFLARE_ACCOUNT_ID>"; })),
    /placeholder/i);
});

test("rejects destructive or malformed deployment values", () => {
  const duplicateWorkers = structuredClone(validConfig);
  duplicateWorkers.workers.context.name = duplicateWorkers.workers.workshop.name;
  assert.throws(() => validateConfig(duplicateWorkers), /unique/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.observability.enabled = "true"; })), /boolean/i);

  assert.throws(
    () => validateConfig(variant((c) => {
      c.workers.router.route.customDomain = "os.example.com/path";
    })), /hostname/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.context.sharingDomain = ""; })),
    /sharingDomain must be null or a non-empty string/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.access.issuer += "/team"; })), /issuer.*origin/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.access.audience = "   "; })), /audience/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.access.audience = " access-audience "; })), /audience/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.access.admins = ["bad-address"]; })), /email/i);

  assert.throws(
    () => validateConfig(variant((c) => {
      c.observability.traces.headSamplingRate = 2;
    })), /sampling/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.context.artifacts.enabled = "true"; })),
    /Artifacts enabled.*boolean/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.context.artifacts = null; })),
    /Artifacts configuration.*object/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.context.artifacts = []; })),
    /Artifacts configuration.*object/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.context.artifacts.namespace = null; })),
    /namespace must be omitted/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.context.artifacts.namespace = "context/collections"; })),
    /namespace must be omitted/i);
});

test("rejects AI Gateway keys that no longer do anything", () => {
  // A silently-ignored workersAi block is how a deploy succeeds with an empty model picker.
  assert.throws(
    () => validateConfig(variant((c) => { c.aiGateway.workersAi = { mode: "gateway" }; })),
    /aiGateway\.workersAi does nothing/i);
  // Even with AI off: the key means the operator believes it still does something.
  assert.throws(
    () => validateConfig(variant((c) => {
      c.aiGateway = { enabled: false, workersAi: { mode: "direct" } };
    })),
    /aiGateway\.workersAi does nothing/i);
});

test("rejects malformed AI Gateway providers and account", () => {
  assert.throws(
    () => validateConfig(variant((c) => { c.aiGateway.providers = []; })),
    /Missing required deployment value: aiGateway.providers/);

  assert.throws(
    () => validateConfig(variant((c) => { c.aiGateway.providers = ["anthropic", "mistral"]; })),
    /providers must be a non-empty subset/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.aiGateway.accountId = "not-an-account"; })),
    /aiGateway.accountId must be null or 32 hexadecimal/i);
});

const openrouterModels = {
  "qwen/qwen3.8-flash": { name: "Qwen 3.8 Flash", contextWindow: 1000000, outputLimit: 131072 },
  "~deepseek/deepseek-flash-latest": { name: "DeepSeek Flash", contextWindow: 1048576 },
};

test("rejects a malformed AI Gateway model allow-list", () => {
  const withModels = (mutate: (c: Record<string, any>) => void) => variant((c) => {
    c.aiGateway.providers = ["cloudflare", "openrouter"];
    c.aiGateway.models = { openrouter: structuredClone(openrouterModels) };
    mutate(c);
  });

  // OpenRouter ships no built-in catalogue, so enabling it with no models is an empty picker.
  assert.throws(
    () => validateConfig(variant((c) => { c.aiGateway.providers = ["cloudflare", "openrouter"]; })),
    /openrouter provider has no built-in models/i);
  assert.throws(
    () => validateConfig(withModels((c) => { c.aiGateway.models.openrouter = {}; })),
    /openrouter provider has no built-in models/i);

  assert.throws(
    () => validateConfig(withModels((c) => { c.aiGateway.models = []; })),
    /aiGateway\.models must be an object/i);
  assert.throws(
    () => validateConfig(withModels((c) => { c.aiGateway.models.mistral = { m: { name: "M", contextWindow: 1 } }; })),
    /unknown provider "mistral"/i);
  // A provider with models but not advertised: the Workshop would never show them.
  assert.throws(
    () => validateConfig(withModels((c) => {
      c.aiGateway.models.anthropic = { "claude-x": { name: "X", contextWindow: 1 } };
    })),
    /"anthropic".*not in aiGateway\.providers/i);
  assert.throws(
    () => validateConfig(withModels((c) => { c.aiGateway.models.openrouter = ["x"]; })),
    /models\.openrouter must be an object/i);
  assert.throws(
    () => validateConfig(withModels((c) => {
      c.aiGateway.models.openrouter[" qwen/qwen3.8-flash"] = { name: "Q", contextWindow: 1 };
    })),
    /model ids must not be blank or padded/i);
  assert.throws(
    () => validateConfig(withModels((c) => {
      c.aiGateway.models.openrouter["qwen/qwen3.8-flash"] = "Qwen";
    })),
    /must be an object with name and contextWindow/i);
  assert.throws(
    () => validateConfig(withModels((c) => {
      c.aiGateway.models.openrouter["qwen/qwen3.8-flash"].name = "";
    })),
    /name must be a non-empty string/i);
  assert.throws(
    () => validateConfig(withModels((c) => {
      c.aiGateway.models.openrouter["qwen/qwen3.8-flash"].contextWindow = "1000000";
    })),
    /contextWindow must be a positive integer/i);
  assert.throws(
    () => validateConfig(withModels((c) => {
      c.aiGateway.models.openrouter["qwen/qwen3.8-flash"].contextWindow = 0;
    })),
    /contextWindow must be a positive integer/i);
  assert.throws(
    () => validateConfig(withModels((c) => {
      c.aiGateway.models.openrouter["qwen/qwen3.8-flash"].outputLimit = -1;
    })),
    /outputLimit must be omitted or a positive integer/i);

  // The valid shape passes, outputLimit present or not.
  assert.equal(validateConfig(withModels(() => {})).aiGateway.providers!.length, 2);
});

test("emits the model allow-list as CF_AI_GATEWAY_EXTRA_MODELS only when it has entries", async () => {
  const bases = await baseConfigs();

  // Absent: no dormant key on the common path.
  assert.equal(
    generateConfigs(validConfig, bases).workshop.vars!.CF_AI_GATEWAY_EXTRA_MODELS, undefined);

  // Present but empty for an enabled provider that has its own catalogue: still omitted.
  const empty = variant((c) => { c.aiGateway.models = { anthropic: {} }; });
  assert.equal(
    generateConfigs(empty, bases).workshop.vars!.CF_AI_GATEWAY_EXTRA_MODELS, undefined);

  const withModels = variant((c) => {
    c.aiGateway.providers = ["cloudflare", "openrouter"];
    c.aiGateway.models = { openrouter: structuredClone(openrouterModels), cloudflare: {} };
  });
  const vars = generateConfigs(withModels, bases).workshop.vars!;
  assert.equal(vars.CF_AI_GATEWAY_PROVIDERS, "cloudflare,openrouter");
  // A JSON object, not a string: the backend reads it structurally, the way ADMINS is an array.
  assert.deepEqual(vars.CF_AI_GATEWAY_EXTRA_MODELS, { openrouter: openrouterModels });
  // OpenRouter rides the Workers AI binding like anthropic/openai, so still no token.
  assert.equal(generateConfigs(withModels, bases).workshop.secrets, undefined);
  assert.equal(aiGatewayPlan(withModels)!.needsToken, false);

  // Dormant when the catalog is off, like every other gateway var.
  const off = variant((c) => {
    c.aiGateway = { enabled: false, models: { openrouter: structuredClone(openrouterModels) } };
  });
  assert.equal(
    generateConfigs(off, bases).workshop.vars!.CF_AI_GATEWAY_EXTRA_MODELS, undefined);
});

test("generates Access-mode Workshop, Context, and custom Gatekeeper configs", async () => {
  const generated = generateConfigs(validConfig, await baseConfigs());
  const vars = generated.workshop.vars!;

  assert.equal(generated.workshop.name, "acme-cloudflare-os-backend");
  assert.deepEqual(vars.ADMINS, ["admin@example.com"]);
  assert.equal(vars.CF_ACCESS_ISS, validConfig.access.issuer);
  assert.equal(vars.CF_ACCESS_AUD, validConfig.access.audience);
  assert.equal(vars.PUBLIC_BASE_URL, "https://os.example.com");
  assert.equal(vars.CF_AI_GATEWAY, "cloudflare-os");
  assert.equal(vars.CF_AI_GATEWAY_PROVIDERS, "anthropic,cloudflare");
  assert.deepEqual(generated.workshop.ai, { binding: "WORKERS_AI" });
  assert.deepEqual(generated.workshop.services, [
    {
      binding: "ERROR_REPORTER",
      service: "acme-cloudflare-os-errors",
      entrypoint: "ErrorReporter",
      props: {
        service: "acme-cloudflare-os-backend",
        environment: "production",
        release: "abc123",
      },
    },
    {
      binding: "GATEKEEPER_CONTEXT",
      service: "acme-cloudflare-os-context",
      entrypoint: "GatekeeperVendor",
      props: { sharingDomain: "https://os.example.com" },
    },
    {
      binding: "GATEKEEPER_SCHEDULER",
      service: "acme-cloudflare-os-scheduler",
      entrypoint: "GatekeeperVendor",
    },
    {
      binding: "GATEKEEPER_PROCGEN",
      service: "acme-cloudflare-os-procgen",
      entrypoint: "GatekeeperVendor",
    },
    {
      binding: "GATEKEEPER_CUSTOM",
      service: "acme-cloudflare-os-custom",
      entrypoint: "GatekeeperVendor",
    },
  ]);
  assert.deepEqual(generated.workshop.kv_namespaces, [
    { binding: "BLUEPRINTS", id: "blueprints-kv-id" },
    { binding: "AVATARS", id: "avatars-kv-id" },
  ]);
  assert.equal(generated.workshop.r2_buckets![0].bucket_name, "cloudflare-os-blueprints");
  assert.equal(generated.context.name, "acme-cloudflare-os-context");
  assert.equal(generated.context.kv_namespaces![0].id, "context-kv-id");
  assert.deepEqual(generated.context.artifacts, [{
    binding: "ARTIFACTS",
    namespace: "acme-context-collections",
  }]);
  assert.equal(generated.customGatekeeper.name, "acme-cloudflare-os-custom");
  assert.deepEqual(generated.customGatekeeper.vars, {
    CUSTOM_NAME: "Acme",
    CUSTOM_MESSAGE: "Use the company handbook.",
  });
  assert.equal(generated.errorReporter!.name, "acme-cloudflare-os-errors");
  assert.deepEqual(generated.workshop.observability!.logs, {
    invocation_logs: false,
  });
  assert.deepEqual(generated.workshop.observability!.traces, {
    enabled: true,
    head_sampling_rate: 0.25,
  });
  assert.equal(generated.workshop.services!.some(
    (service) => service.binding === "FRONTEND_ERROR_REPORTER"), false);
});

test("gives the router the public route, frontend, and HTTP-serving bindings", async () => {
  const bases = await baseConfigs();
  const generated = generateConfigs(validConfig, bases);

  assert.equal(generated.router.name, "acme-cloudflare-os");
  assert.equal(generated.router.workers_dev, false);
  assert.deepEqual(generated.router.routes, [{ pattern: "os.example.com", custom_domain: true }]);
  // No entrypoint on any of the three: the router forwards whole HTTP requests rather than making
  // vendor RPC calls, and the binding name is what selects the /gatekeeper/<name> path.
  assert.deepEqual(generated.router.services, [
    { binding: "WORKSHOP_BACKEND", service: "acme-cloudflare-os-backend" },
    { binding: "GATEKEEPER_CONTEXT", service: "acme-cloudflare-os-context" },
    { binding: "GATEKEEPER_SCHEDULER", service: "acme-cloudflare-os-scheduler" },
    { binding: "GATEKEEPER_CUSTOM", service: "acme-cloudflare-os-custom" },
    { binding: "GATEKEEPER_CHAT", service: "acme-cloudflare-os-chat" },
  ]);
  assert.equal(generated.router.services.some(
    (service) => service.binding === "GATEKEEPER_PROCGEN"), false);
  // Inherited untouched: the base config already carries the ASSETS binding, the SPA fallback, and
  // the /gatekeeper/* prefix an OAuth Gatekeeper redirect needs.
  assert.deepEqual(generated.router.assets, bases.router.assets);
  assert.equal(generated.router.assets!.binding, "ASSETS");
  assert.equal(generated.router.assets!.directory, "../workshop-frontend/dist");
  assert.ok(generated.router.assets!.run_worker_first!.includes("/gatekeeper/*"),
    JSON.stringify(generated.router.assets));
});

/**
 * The hosted deploy preinstalls this one on every fresh instance (`PREINSTALL` in
 * cloudflare-os/scripts/release/manifest-lib.ts), so a starter that skipped it would not be the same
 * topology: a migrated instance would show none of its existing schedules, and the
 * Durable Objects holding them would be orphaned behind a Worker nothing is bound to.
 */
test("deploys the ambient Scheduler Gatekeeper the hosted flow preinstalls", async () => {
  const bases = await baseConfigs();
  const generated = generateConfigs(validConfig, bases);

  assert.equal(generated.scheduler.name, "acme-cloudflare-os-scheduler");
  // Reached by both, for the two different things a Gatekeeper does: vendor RPC from the backend,
  // and whole HTTP requests under /gatekeeper/scheduler from the router.
  assert.deepEqual(
    generated.workshop.services!.find((service) => service.binding === "GATEKEEPER_SCHEDULER"),
    {
      binding: "GATEKEEPER_SCHEDULER",
      service: "acme-cloudflare-os-scheduler",
      entrypoint: "GatekeeperVendor",
    });
  assert.deepEqual(
    generated.router.services!.find((service) => service.binding === "GATEKEEPER_SCHEDULER"),
    { binding: "GATEKEEPER_SCHEDULER", service: "acme-cloudflare-os-scheduler" });

  // Its Durable Object history has to arrive verbatim: those classes are where the schedules live.
  assert.deepEqual(generated.scheduler.migrations, bases.scheduler.migrations);
  assert.ok(generated.scheduler.migrations!.length > 0, "scheduler lost its DO migrations");
  // No configuration surface of its own -- which is what makes it installable with no user input
  // upstream, and deployable here from nothing but a Worker name.
  assert.equal(generated.scheduler.vars, undefined);
  assert.equal(generated.scheduler.kv_namespaces, undefined);
  assert.equal(generated.scheduler.secrets, undefined);

  const builds = buildCommands(validConfig)
    .map(({ args }) => args)
    .filter((args) => args.includes("@gadgets/gatekeeper-scheduler"));
  assert.deepEqual(builds.map((args) => args.at(-1)), ["build:app", "typecheck:app", "tsc"]);
});

test("deploys Synthetic Data privately and binds it only to the Workshop", async () => {
  const bases = await baseConfigs();
  const generated = generateConfigs(validConfig, bases);

  assert.equal(generated.procgen.name, "acme-cloudflare-os-procgen");
  assert.equal(generated.procgen.workers_dev, false);
  assert.equal(generated.procgen.preview_urls, false);
  assert.equal(generated.procgen.routes, undefined);
  assert.equal(generated.procgen.vars, undefined);
  assert.equal(generated.procgen.kv_namespaces, undefined);
  assert.equal(generated.procgen.r2_buckets, undefined);
  assert.equal(generated.procgen.secrets, undefined);
  assert.deepEqual(generated.workshop.services!.find(
    (service) => service.binding === "GATEKEEPER_PROCGEN"), {
    binding: "GATEKEEPER_PROCGEN",
    service: "acme-cloudflare-os-procgen",
    entrypoint: "GatekeeperVendor",
  });
  assert.equal(generated.router.services!.some(
    (service) => service.service === "acme-cloudflare-os-procgen"), false);
  assert.ok(buildCommands(validConfig).some(({ args }) => args.includes("gatekeeper-procgen")));
});

test("deploys web search only when enabled, privately, with its key required", async () => {
  const bases = await baseConfigs();
  const off = generateConfigs(validConfig, bases);
  assert.equal(off.webSearch, undefined);
  assert.equal(off.workshop.services!.some((s) => s.binding === "GATEKEEPER_WEBSEARCH"), false);
  assert.equal(deployOrder(validConfig).includes("webSearch"), false);
  assert.equal(buildCommands(validConfig).some(({ args }) => args.includes("gatekeeper-websearch")), false);

  const config = validateConfig(variant((c) => {
    c.workers.webSearch = { name: "acme-cloudflare-os-websearch" };
    c.webSearch = { enabled: true, blockedTerms: ["project-nightjar"] };
  }));
  const generated = generateConfigs(config, bases);
  const ws = generated.webSearch!;
  assert.equal(ws.name, "acme-cloudflare-os-websearch");
  assert.equal(ws.workers_dev, false);
  assert.equal(ws.preview_urls, false);
  assert.equal(ws.routes, undefined);
  assert.deepEqual(ws.secrets, { required: ["OPENROUTER_API_KEY"] });
  assert.deepEqual(ws.vars, {
    BLOCKED_TERMS: ["0123456789abcdef0123456789abcdef", new URL(validConfig.access.issuer).hostname, "project-nightjar"],
    PRIVATE_DOMAINS: ["example.com"],
    PUBLIC_HOSTS: ["os.example.com"],
  });
  assert.deepEqual(generated.workshop.services!.find((s) => s.binding === "GATEKEEPER_WEBSEARCH"), {
    binding: "GATEKEEPER_WEBSEARCH",
    service: "acme-cloudflare-os-websearch",
    entrypoint: "GatekeeperVendor",
  });
  assert.equal(generated.router.services!.some((s) => s.service === "acme-cloudflare-os-websearch"), false);
  const order = deployOrder(config);
  assert.ok(order.indexOf("webSearch") < order.indexOf("workshop"));
  assert.ok(buildCommands(config).some(({ args }) => args.includes("gatekeeper-websearch")));
});

test("requires a web search Worker name only when web search is enabled", () => {
  assert.throws(() => validateConfig(variant((c) => { c.webSearch = { enabled: true }; })),
    /workers\.webSearch\.name/);
  assert.doesNotThrow(() => validateConfig(variant((c) => {
    c.webSearch = { enabled: false };
    c.workers.webSearch = { name: "<web-search-worker>" };
  })));
  assert.throws(() => validateConfig(variant((c) => {
    c.webSearch = { enabled: true };
    c.workers.webSearch = { name: c.workers.procgen.name };
  })), /must be unique/);
});

test("keeps every Worker behind the router off the public internet", async () => {
  const generated = generateConfigs(validConfig, await baseConfigs());
  const workers = Object.entries(generated) as [string, ProdWranglerConfig][];

  for (const [name, worker] of workers) {
    if (name !== "router") {
      assert.equal(worker.workers_dev, false, `${name} answers on workers.dev`);
      assert.equal(worker.routes, undefined, `${name} carries a public route`);
    }
    // A preview URL is an unauthenticated path around the Access-protected origin.
    assert.equal(worker.preview_urls, false, `${name} leaves preview URLs enabled`);
  }
  // The router serves the frontend, so the backend uploads no assets of its own.
  assert.equal(generated.workshop.assets, undefined);
});

test("scopes PUBLIC_BASE_URL and Context sharing to the public origin", async () => {
  const onWorkersDev = variant((c) => {
    c.workers.router.route = { workersDev: true };
    c.publicBaseUrl = "https://acme-cloudflare-os.acme.workers.dev";
  });

  const derived = generateConfigs(validConfig, await baseConfigs());
  const explicit = generateConfigs(onWorkersDev, await baseConfigs());

  assert.equal(derived.workshop.vars!.PUBLIC_BASE_URL, "https://os.example.com");
  assert.equal(
    explicit.workshop.vars!.PUBLIC_BASE_URL, "https://acme-cloudflare-os.acme.workers.dev");
  assert.equal(explicit.router.workers_dev, true);
  assert.equal(explicit.router.routes, undefined);

  // sharingDomain: null follows the public origin, which is what the hosted deploy sets it to.
  assert.equal(sharingDomain(derived), "https://os.example.com");
  assert.equal(sharingDomain(explicit), "https://acme-cloudflare-os.acme.workers.dev");

  // A pinned literal keeps the boundary stable across a hostname change, so it wins.
  const pinned = generateConfigs(
    variant((c) => { c.context.sharingDomain = "production"; }), await baseConfigs());
  assert.equal(sharingDomain(pinned), "production");
  assert.equal(pinned.workshop.vars!.PUBLIC_BASE_URL, "https://os.example.com");
});

test("rejects a public origin it cannot derive or cannot trust", async () => {
  // Nothing in deployment.jsonc names the account's workers.dev subdomain, and PUBLIC_BASE_URL and
  // the Context sharing boundary both need an origin, so this cannot be left to a fallback.
  assert.throws(
    () => validateConfig(variant((c) => { c.workers.router.route = { workersDev: true }; })),
    /publicBaseUrl is required on a workersDev route/i);

  // Scoping Context data to a hostname the deployment does not answer on hides its collections.
  assert.throws(
    () => validateConfig(variant((c) => { c.publicBaseUrl = "https://other.example.com"; })),
    /does not match workers.router.route.customDomain/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.publicBaseUrl = "https://os.example.com/"; })),
    /HTTPS origin only/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.publicBaseUrl = "http://os.example.com"; })),
    /HTTPS origin only/i);

  assert.throws(
    () => validateConfig(variant((c) => { delete c.publicBaseUrl; })),
    /publicBaseUrl must be present/i);
});

test("rejects a workersDev origin that is not the router's own", async () => {
  const onWorkersDev = (publicBaseUrl: string) => variant((c) => {
    c.workers.router.route = { workersDev: true };
    c.publicBaseUrl = publicBaseUrl;
  });

  // The account's workers.dev subdomain is unknowable here, but the rest of the hostname is not: a
  // typo in the Worker label, or an unrelated host, would silently become both PUBLIC_BASE_URL and
  // the Context isolation boundary.
  assert.throws(
    () => validateConfig(onWorkersDev("https://acme-cloudflare-o.acme.workers.dev")),
    /names Worker "acme-cloudflare-o", but the router is "acme-cloudflare-os"/);

  assert.throws(
    () => validateConfig(onWorkersDev("https://os.example.com")),
    /not a workers.dev origin/i);

  // A deeper name is a preview URL or an unrelated host, not the route wrangler serves.
  assert.throws(
    () => validateConfig(onWorkersDev("https://staging.acme-cloudflare-os.acme.workers.dev")),
    /not a workers.dev origin/i);

  // The shape wrangler actually serves stays valid, whatever the account subdomain is.
  const generated = generateConfigs(
    onWorkersDev("https://acme-cloudflare-os.some-account.workers.dev"), await baseConfigs());
  assert.equal(
    generated.workshop.vars!.PUBLIC_BASE_URL, "https://acme-cloudflare-os.some-account.workers.dev");

  // The rule is scoped to the workersDev route. A custom domain has its own hostname, unrelated to
  // any Worker name, and is checked against `customDomain` instead -- both spellings stay valid.
  assert.equal(
    validateConfig(variant((c) => { c.publicBaseUrl = "https://os.example.com"; })).publicBaseUrl,
    "https://os.example.com");
  assert.equal(validateConfig(validConfig).publicBaseUrl, null);
});

test("routes AI Gateway over the Workers AI binding without an API token", async () => {
  const generated = generateConfigs(validConfig, await baseConfigs());
  const vars = generated.workshop.vars!;

  assert.equal(vars.CF_AI_GATEWAY_ACCOUNT_ID, validConfig.accountId);
  // Absent, not "true": the backend takes the binding whenever it is bound, and the binding is
  // pre-authenticated inside the deployment's own account.
  assert.equal(vars.CF_AI_GATEWAY_USE_BINDING, undefined);
  assert.equal(generated.workshop.secrets, undefined);
  assert.deepEqual(aiGatewayPlan(validConfig), {
    gatewayAccountId: validConfig.accountId,
    crossAccount: false,
    needsToken: false,
    tokenReasons: [],
  });
});

test("requires a token for a gateway in another account", async () => {
  const config = variant((c) => { c.aiGateway.accountId = "fedcba9876543210fedcba9876543210"; });
  const generated = generateConfigs(config, await baseConfigs());
  const vars = generated.workshop.vars!;

  assert.equal(vars.CF_AI_GATEWAY_ACCOUNT_ID, "fedcba9876543210fedcba9876543210");
  assert.equal(vars.CF_AI_GATEWAY_USE_BINDING, "false");
  assert.deepEqual(generated.workshop.secrets, { required: ["CF_AI_GATEWAY_API_TOKEN"] });
  // The Workers AI binding stays bound: webFetch's toMarkdown() runs on it too.
  assert.deepEqual(generated.workshop.ai, { binding: "WORKERS_AI" });
  assert.equal(aiGatewayPlan(config)!.tokenReasons.length, 1);
});

test("treats a differently-cased account ID as the same account", async () => {
  const config = variant((c) => { c.aiGateway.accountId = c.accountId.toUpperCase(); });
  const generated = generateConfigs(config, await baseConfigs());

  // Same account written two ways, which the hex pattern accepts: the binding reaches this gateway,
  // so no CF_AI_GATEWAY_USE_BINDING opt-out and no token.
  assert.equal(generated.workshop.vars!.CF_AI_GATEWAY_ACCOUNT_ID, validConfig.accountId);
  assert.equal(generated.workshop.vars!.CF_AI_GATEWAY_USE_BINDING, undefined);
  assert.equal(generated.workshop.secrets, undefined);
  assert.equal(aiGatewayPlan(config)!.crossAccount, false);
  assert.deepEqual(aiGatewayPlan(config)!.tokenReasons, []);
});

test("requires a token for the google provider", async () => {
  const config = variant((c) => { c.aiGateway.providers = ["cloudflare", "google"]; });
  const generated = generateConfigs(config, await baseConfigs());

  assert.deepEqual(generated.workshop.secrets, { required: ["CF_AI_GATEWAY_API_TOKEN"] });
  // Same account, so the binding still carries every other provider.
  assert.equal(generated.workshop.vars!.CF_AI_GATEWAY_USE_BINDING, undefined);
  assert.match(aiGatewayPlan(config)!.tokenReasons[0], /google/i);
});

test("omits disabled backend error reporting", async () => {
  const config = variant((c) => {
    c.errorReporting = { enabled: false, environment: "<ENVIRONMENT>", release: "<RELEASE>" };
  });

  const generated = generateConfigs(config, await baseConfigs());

  assert.equal(generated.errorReporter, undefined);
  assert.equal(generated.workshop.services!.some(
    (service) => service.binding === "ERROR_REPORTER"), false);
});

test("omits dormant AI Gateway configuration", async () => {
  const config = variant((c) => {
    c.aiGateway = {
      enabled: false,
      name: "<AI_GATEWAY_NAME>",
      accountId: "<AI_GATEWAY_ACCOUNT_ID>",
      providers: [],
    };
  });

  const generated = generateConfigs(config, await baseConfigs());
  const vars = generated.workshop.vars!;

  assert.equal(vars.CF_AI_GATEWAY, undefined);
  assert.equal(vars.CF_AI_GATEWAY_ACCOUNT_ID, undefined);
  assert.equal(vars.CF_AI_GATEWAY_PROVIDERS, undefined);
  assert.equal(generated.workshop.secrets, undefined);
  // Still bound: it is what webFetch's toMarkdown() runs on, independent of the model catalog.
  assert.deepEqual(generated.workshop.ai, { binding: "WORKERS_AI" });
  assert.equal(aiGatewayPlan(config), null);
});

test("uses the default Context Artifacts namespace when omitted", async () => {
  const config = variant((c) => { delete c.context.artifacts.namespace; });

  const generated = generateConfigs(config, await baseConfigs());

  assert.deepEqual(generated.context.artifacts, [{
    binding: "ARTIFACTS",
    namespace: "gatekeeper-context-collections",
  }]);
});

test("omits disabled Context Artifacts configuration", async () => {
  const config = variant((c) => { c.context.artifacts = {}; });
  const bases = await baseConfigs();
  bases.context.artifacts = [{ binding: "ARTIFACTS", namespace: "upstream-default" }];

  const generated = generateConfigs(config, bases);

  assert.equal(generated.context.artifacts, undefined);
});

test("defaults Context Artifacts to disabled when configuration is omitted", async () => {
  const config = variant((c) => { delete c.context.artifacts; });

  const generated = generateConfigs(config, await baseConfigs());

  assert.equal(generated.context.artifacts, undefined);
});

test("generates binding-only storage for automatic provisioning", async () => {
  const config = variant((c) => {
    c.context.kvNamespaceId = null;
    c.resources = {
      blueprintsKvNamespaceId: null,
      avatarsKvNamespaceId: null,
      blueprintContentBucket: null,
    };
  });

  const generated = generateConfigs(config, await baseConfigs());

  assert.deepEqual(generated.workshop.kv_namespaces, [
    { binding: "BLUEPRINTS" },
    { binding: "AVATARS" },
  ]);
  assert.deepEqual(generated.workshop.r2_buckets, [{ binding: "BLUEPRINT_CONTENT" }]);
  assert.deepEqual(generated.context.kv_namespaces, [{ binding: "CONTEXT_COLLECTIONS" }]);
});

/**
 * The equivalent, for this repository, of upstream's `deploy-scripts.test.ts`. That one
 * auto-discovers per-package `deploy` scripts; here deploying is centralised in `deploy.ts`, so the
 * same invariant has to be asserted against the commands it spawns.
 *
 * Both halves are silent failures: a replayed cache hit and a dropped build-time flag each exit
 * zero and each still deploy.
 */
test("never lets a deploy replay a cached build artifact", () => {
  const commands = buildCommands(validConfig);
  assert.ok(commands.length > 0, "expected at least one build command");
  for (const { args } of commands) {
    const command = args.join(" ");
    // A plain `pnpm run <script>` / `pnpm exec <command>` step never touches the Vite+ cache. It
    // is only allowed for the two Gatekeepers' type-check and `tsc` steps, whose package `build`
    // script would otherwise nest a cached `vp run` of its own.
    if (!command.includes("vp run")) {
      assert.ok(args.includes("--filter") && (args.includes("run") || args.includes("exec")),
        `build step neither goes through vp run nor is a pnpm script/exec: ${command}`);
      assert.ok(!args.includes("build"),
        `a package build script may nest a cached vp run; run its parts instead: ${command}`);
      continue;
    }
    assert.ok(command.includes("--no-cache"),
      `build step runs a vp task while deploying without --no-cache: ${command}\n` +
      "Deploys must not replay a cached artifact -- add --no-cache.");
    // Everything after the task specifier is forwarded to the task's own command, so a trailing
    // flag reaches `tsc` as an unknown option instead of reaching vp.
    assert.ok(args.indexOf("--no-cache") < args.indexOf("run") + 4,
      `--no-cache must precede the task name, not follow it: ${command}`);
  }
});

test("rebuilds the Context configurator app rather than replaying it", () => {
  // `gatekeeper-context`'s `build` script spawns `vp run --cache build:app` of its own, which the
  // outer --no-cache does not reach. Without the uncached `build:app` step a deploy ships whatever
  // app.txt the cache last archived, so the `build` script is never run: its other two parts are.
  const context = buildCommands(validConfig)
    .map(({ args }) => args)
    .filter((args) => args.includes("@gadgets/gatekeeper-context"));
  assert.deepEqual(context.map((args) => args.at(-1)), ["build:app", "typecheck:app", "tsc"]);
  assert.deepEqual(context[0]!.at(-2), "--no-cache", context[0]!.join(" "));
  assert.ok(context.every((args) => !args.includes("build")), context.join("\n"));
});

test("passes VITE_CF_ACCESS_MODE explicitly rather than inheriting it", () => {
  const withEnv = buildCommands(validConfig).filter(({ env }) => env);
  assert.deepEqual(withEnv.map(({ env }) => env),
    [{ VITE_CF_ACCESS_MODE: "true", VITE_CHAT_DOCK: "true" }]);
  // It has to reach the frontend, which inlines it into the bundle, and nothing else.
  assert.match(withEnv[0].args.join(" "), /@gadgets\/workshop-frontend/);
});

test("builds the chat dock into the frontend only when chat is deployed", () => {
  // The dock is a fork commit in the submodule (`ChatDock.tsx`), gated on this build-time flag. With
  // no chat Worker there is nothing for its iframe to load, so the flag is absent and the dock, its
  // sidebar and editor triggers and its /chat route are all dropped from the bundle.
  const frontend = (config: DeploymentConfig) => buildCommands(config)
    .find(({ args }) => args.includes("@gadgets/workshop-frontend"))!;

  assert.equal(frontend(validConfig).env?.VITE_CHAT_DOCK, "true");
  const withoutChat = frontend(variant((c) => { c.chat = { enabled: false }; }));
  assert.deepEqual(withoutChat.env, { VITE_CF_ACCESS_MODE: "true" });
  assert.equal(frontend(variant((c) => { delete c.chat; })).env?.VITE_CHAT_DOCK, undefined);
});

test("passes an absolute FORMAT_BLUEPRINTS_DIR to the backend build only when configured", () => {
  const backend = (config: DeploymentConfig) => buildCommands(config)
    .find(({ args }) => args.includes("@gadgets/workshop-backend"))!;

  assert.equal(backend(validConfig).env, undefined);
  assert.equal(backend(variant((c) => { c.formatBlueprintsDir = null; })).env, undefined);

  const env = backend(variant((c) => { c.formatBlueprintsDir = "formats"; })).env;
  assert.equal(env?.FORMAT_BLUEPRINTS_DIR, formatBlueprintsPath("formats"));
  assert.ok(isAbsolute(env!.FORMAT_BLUEPRINTS_DIR), env!.FORMAT_BLUEPRINTS_DIR);
  // Upstream resolves a relative value against its own package; ours means the repository root.
  assert.ok(env!.FORMAT_BLUEPRINTS_DIR.endsWith("/formats"), env!.FORMAT_BLUEPRINTS_DIR);
});

test("rejects a blank or padded formatBlueprintsDir", () => {
  for (const value of ["", "  ", " formats", 42, true]) {
    assert.throws(() => validateConfig(variant((c) => { c.formatBlueprintsDir = value; })),
      /formatBlueprintsDir/, String(value));
  }
  validateConfig(variant((c) => { c.formatBlueprintsDir = "formats"; }));
  validateConfig(variant((c) => { c.formatBlueprintsDir = null; }));
});

test("the repository's formats directory pairs every archive with a sidecar", async () => {
  const dir = formatBlueprintsPath("formats");
  const files = await readdir(dir);
  const archives = files.filter((f) => f.endsWith(".gadget"));
  // Setting the directory replaces upstream's defaults, so they must be carried here.
  for (const name of ["workspace-docs", "workspace-sheets", "workspace-slides", "board", "whiteboard"]) {
    assert.ok(archives.includes(`${name}.gadget`), `formats/${name}.gadget missing`);
  }
  const blueprintIds = new Set<string>();
  for (const archive of archives) {
    const sidecar = JSON.parse(await readFile(join(dir, archive.replace(/\.gadget$/, ".json")), "utf8"));
    assert.match(sidecar.blueprintId, /^[a-zA-Z0-9._-]+$/);
    assert.ok(Number.isInteger(sidecar.revision) && sidecar.revision >= 1, archive);
    // The id is the install key: two formats sharing one would overwrite each other.
    assert.ok(!blueprintIds.has(sidecar.blueprintId), `duplicate blueprintId ${sidecar.blueprintId}`);
    blueprintIds.add(sidecar.blueprintId);
  }
});

test("builds the frontend before the router", () => {
  const order = buildCommands(validConfig).map(({ args }) => args.join(" "));
  const frontend = order.findIndex((command) => command.includes("workshop-frontend"));
  const router = order.findIndex((command) => command.includes("@gadgets/router"));
  // The router deploy picks up ../workshop-frontend/dist as its assets.
  assert.ok(frontend >= 0 && router >= 0 && frontend < router, order.join("\n"));
});

test("skips the Error Reporter build when error reporting is disabled", () => {
  const config = variant((c) => {
    c.errorReporting = { enabled: false, environment: "<ENVIRONMENT>", release: null };
  });
  const commands = buildCommands(config).map(({ args }) => args.join(" "));
  assert.equal(commands.some((command) => command.includes("error-reporter")), false);
});


test("runtime is opt-in, private, bounded, and bound only to Workshop", async () => {
  const bases = await baseConfigs();
  assert.equal(generateConfigs(validConfig, bases).runtime, undefined);
  const config = variant(c => { c.runtime = { enabled: true, workerName: 'acme-notebook-python', maxInstances: 3 }; });
  validateConfig(config);
  const generated = generateConfigs(config, bases);
  assert.equal(generated.runtime!.name, 'acme-notebook-python');
  assert.equal(generated.runtime!.workers_dev, false);
  assert.equal(generated.runtime!.preview_urls, false);
  assert.ok(!generated.runtime!.routes?.length);
  assert.equal(generated.runtime!.containers![0].max_instances, 3);
  assert.ok(generated.workshop.services!.some(s => s.binding === 'GATEKEEPER_RUNTIME' && s.entrypoint === 'GatekeeperVendor'));
  assert.ok(!generated.router.services!.some(s => s.service === 'acme-notebook-python'));
  assert.ok(buildCommands(config).some(c => c.args.includes('gatekeeper-runtime')));
  for (const maxInstances of [0, 21, 1.5]) assert.throws(() => validateConfig(variant(c => { c.runtime = { ...config.runtime, maxInstances }; })), /runtime/);
  assert.throws(() => validateConfig(variant(c => { c.runtime = { ...config.runtime, workerName: c.workers.workshop.name }; })), /unique|distinct|name/i);
});

/**
 * Chat is two bindings on two Workers for two different reasons: the router's plain-fetch one is
 * what makes /gatekeeper/chat a URL at all, and the Workshop's vendor one is the agent's ambient
 * session. Only the first is part of `chat.enabled`.
 */
test("serves chat through the router and provisions its own storage", async () => {
  const bases = await baseConfigs();
  const generated = generateConfigs(validConfig, bases);
  const chat = generated.chat!;

  assert.equal(chat.name, "acme-cloudflare-os-chat");
  assert.equal(chat.workers_dev, false);
  assert.equal(chat.preview_urls, false);
  assert.equal(chat.routes, undefined);
  // The same Access trust boundary and admin list the Workshop gets: chat verifies the assertion
  // itself rather than trusting the router.
  assert.deepEqual(chat.vars, {
    ADMINS: ["admin@example.com"],
    CF_ACCESS_ISS: "https://acme.cloudflareaccess.com",
    CF_ACCESS_AUD: "access-audience",
    PUBLIC_BASE_URL: "https://os.example.com",
    MAX_UPLOAD_BYTES: 10485760,
  });
  // ADMINS in the structured form, not a joined string: the same value the Workshop receives.
  assert.deepEqual(chat.vars!.ADMINS, generated.workshop.vars!.ADMINS);
  assert.deepEqual(chat.r2_buckets, [
    { binding: "FILES", bucket_name: "acme-cloudflare-os-chat-files" },
  ]);
  // Inherited untouched, unlike the Workshop's: chat serves its own SPA behind its own auth check.
  assert.deepEqual(chat.assets, bases.chat!.assets);
  assert.equal(chat.assets!.binding, "ASSETS");
  // The DO the messages live in has to arrive verbatim.
  assert.deepEqual(chat.migrations, bases.chat!.migrations);
  assert.deepEqual(chat.migrations![0].new_sqlite_classes, ["ChatWorkspace"]);

  // No entrypoint on the router binding: the router forwards whole HTTP requests, WebSocket
  // upgrades included, and GATEKEEPER_CHAT is what selects /gatekeeper/chat.
  assert.deepEqual(
    generated.router.services!.find((service) => service.binding === "GATEKEEPER_CHAT"),
    { binding: "GATEKEEPER_CHAT", service: "acme-cloudflare-os-chat" });
  // Agent access is a separate switch, so the vendor binding is absent by default.
  assert.equal(generated.workshop.services!.some(
    (service) => service.binding === "GATEKEEPER_CHAT"), false);

  assert.ok(buildCommands(validConfig).some(({ args }) => args.includes("gatekeeper-chat")));
});

test("binds chat to the Workshop as a vendor only under chat.agentAccess", async () => {
  const bases = await baseConfigs();
  const config = variant((c) => { c.chat.agentAccess = true; });

  const services = generateConfigs(config, bases).workshop.services!;
  assert.deepEqual(services.find((service) => service.binding === "GATEKEEPER_CHAT"), {
    binding: "GATEKEEPER_CHAT",
    service: "acme-cloudflare-os-chat",
    entrypoint: "GatekeeperVendor",
  });
  // The router keeps its plain-fetch binding either way; the two are not alternatives.
  assert.deepEqual(
    generateConfigs(config, bases).router.services!.find((s) => s.binding === "GATEKEEPER_CHAT"),
    { binding: "GATEKEEPER_CHAT", service: "acme-cloudflare-os-chat" });

  // Agent access without a chat Worker to bind is a mistake, not a no-op.
  assert.throws(
    () => validateConfig(variant((c) => { c.chat = { enabled: false, agentAccess: true }; })),
    /agentAccess is true while chat.enabled is false/i);
});

test("generates nothing chat-related when chat is disabled or absent", async () => {
  const bases = await baseConfigs();

  for (const config of [
    variant((c) => { c.chat.enabled = false; }),
    variant((c) => { delete c.chat; delete c.workers.chat; }),
    // A dormant block is not validated, the way a disabled AI Gateway block is not: placeholders and
    // junk in it must not block a deploy that never reads it.
    variant((c) => {
      c.chat = { enabled: false, filesBucket: "", maxUploadBytes: 0 };
      c.workers.chat = { name: "<CHAT_WORKER_NAME>" };
    }),
  ]) {
    const generated = generateConfigs(config, bases);
    assert.equal(generated.chat, undefined);
    assert.equal(generated.router.services!.some((s) => s.binding === "GATEKEEPER_CHAT"), false);
    assert.equal(generated.workshop.services!.some((s) => s.binding === "GATEKEEPER_CHAT"), false);
    assert.equal(buildCommands(config).some(({ args }) => args.includes("gatekeeper-chat")), false);
    assert.equal(deployOrder(config).includes("chat"), false);
  }

  // A disabled chat name is free to collide, because nothing is deployed under it.
  validateConfig(variant((c) => {
    c.chat.enabled = false;
    c.workers.chat.name = c.workers.workshop.name;
  }));
  assert.throws(
    () => validateConfig(variant((c) => { c.workers.chat.name = c.workers.workshop.name; })),
    /unique/i);
  assert.throws(
    () => validateConfig(variant((c) => { delete c.workers.chat; })),
    /Missing required deployment value: workers.chat.name/);
});

test("adopts an existing uploads bucket or leaves it to be provisioned", async () => {
  const bases = await baseConfigs();

  assert.deepEqual(
    generateConfigs(variant((c) => { c.chat.filesBucket = null; }), bases).chat!.r2_buckets,
    [{ binding: "FILES" }]);
  assert.deepEqual(
    generateConfigs(variant((c) => { c.chat.filesBucket = "team-chat-files"; }), bases)
      .chat!.r2_buckets,
    [{ binding: "FILES", bucket_name: "team-chat-files" }]);

  for (const filesBucket of ["", "  ", 42, true]) {
    assert.throws(() => validateConfig(variant((c) => { c.chat.filesBucket = filesBucket; })),
      /chat.filesBucket must be null or an existing R2 bucket name/, String(filesBucket));
  }
});

test("caps a chat upload at what one Worker request body can carry", () => {
  for (const maxUploadBytes of [0, -1, 1.5, "10485760", 100 * 1024 * 1024 + 1]) {
    assert.throws(() => validateConfig(variant((c) => { c.chat.maxUploadBytes = maxUploadBytes; })),
      /chat.maxUploadBytes/, String(maxUploadBytes));
  }
  validateConfig(variant((c) => { c.chat.maxUploadBytes = 100 * 1024 * 1024; }));

  assert.throws(() => validateConfig(variant((c) => { c.chat = { enabled: "true" }; })),
    /chat.enabled must be a boolean/);
  assert.throws(() => validateConfig(variant((c) => { c.chat = []; })),
    /chat must be an object/);
  assert.throws(() => validateConfig(variant((c) => { c.chat.agentAccess = "yes"; })),
    /chat.agentAccess must be a boolean/);
});

/**
 * Chat's dev identity wrapper is switched on by `DEV_IDENTITIES` in its `wrangler.dev.jsonc`. In
 * production that var is an identity bypass sitting behind the Access-protected hostname, so a
 * generated config carrying one -- or any other `DEV_*` value, from any base config -- must not
 * reach a deploy.
 */
test("refuses a production config carrying a dev identity bypass", async () => {
  const bases = await baseConfigs();

  // Caught in the base config, which is the only place it survives: the chat Worker's generated vars
  // are written from deployment.jsonc, so a var read from wrangler.dev.jsonc is overwritten and the
  // result alone would look clean.
  const withDevVar = structuredClone(bases);
  withDevVar.chat!.vars = { ...withDevVar.chat!.vars, DEV_IDENTITIES: "alice@example.com" };
  assert.throws(() => generateConfigs(validConfig, withDevVar),
    /chat: base wrangler.jsonc carries dev-only value\(s\) DEV_IDENTITIES/);

  // Any DEV_* var, on any Worker: the rule is the prefix, not the one name.
  const otherWorker = structuredClone(bases);
  otherWorker.scheduler.vars = { DEV_BYPASS: "1" };
  assert.throws(() => generateConfigs(validConfig, otherWorker), /dev-only value\(s\) DEV_BYPASS/);

  // Including a required secret, which is how a dev signing key would arrive.
  const devSecret = structuredClone(bases);
  devSecret.chat!.secrets = { required: ["DEV_IDENTITY_SECRET"] };
  assert.throws(() => generateConfigs(validConfig, devSecret), /DEV_IDENTITY_SECRET/);

  // And the tell no var would show: chat's dev config differs from its production one in `main`.
  const devEntry = structuredClone(bases);
  devEntry.chat!.main = ".wrangler/validate/src/dev/entry.ts";
  assert.throws(() => generateConfigs(validConfig, devEntry), /dev entry point/);

  // The real base configs carry none, which is the case this guards.
  generateConfigs(validConfig, bases);
});

test("deploys chat after the Workshop it binds, and before the router that binds it", () => {
  const order = deployOrder(validConfig);

  // chat.agentReplies (on by default) binds the Workshop's gateway, so the Workshop goes first.
  assert.ok(order.indexOf("workshop") < order.indexOf("chat"), order.join(" "));
  assert.ok(order.indexOf("chat") < order.indexOf("router"), order.join(" "));
  // The router stays last: it binds every Worker before it.
  assert.equal(order.at(-1), "router");
  // Every Worker is deployed exactly once, and only the ones this deployment enables.
  assert.equal(new Set(order).size, order.length);
  assert.deepEqual(deployOrder(variant((c) => {
    c.chat.enabled = false;
    c.errorReporting = { enabled: false };
  })), ["context", "scheduler", "procgen", "customGatekeeper", "workshop", "router"]);
  assert.deepEqual(order, [
    "errorReporter", "context", "scheduler", "procgen", "customGatekeeper", "workshop", "chat",
    "router",
  ]);
  // agentAccess makes the Workshop bind chat's vendor too. That cycle is only deployable between
  // Workers that already exist, and chat keeps the place it has always had for agentAccess.
  assert.deepEqual(deployOrder(variant((c) => { c.chat.agentAccess = true; })), [
    "errorReporter", "context", "scheduler", "procgen", "customGatekeeper", "chat", "workshop",
    "router",
  ]);
});

test("binds the Workshop's gateway to chat for @agent answers unless agentReplies is false", async () => {
  const bases = await baseConfigs();
  // On by default: the entrypoint and props the Workshop's ExternalMessageGateway requires.
  assert.deepEqual(generateConfigs(validConfig, bases).chat!.services, [{
    binding: "WORKSHOP_GATEWAY",
    service: "acme-cloudflare-os-backend",
    entrypoint: "ExternalMessageGateway",
    props: { source: "chat" },
  }]);
  assert.deepEqual(
    generateConfigs(variant((c) => { c.chat.agentReplies = true; }), bases).chat!.services,
    generateConfigs(validConfig, bases).chat!.services);
  // Off: no binding at all, which is what the chat Worker reads as "replies are turned off".
  assert.equal(generateConfigs(variant((c) => { c.chat.agentReplies = false; }), bases).chat!.services,
    undefined);

  assert.throws(() => validateConfig(variant((c) => { c.chat.agentReplies = "yes"; })),
    /chat.agentReplies must be a boolean/);
  assert.throws(
    () => validateConfig(variant((c) => { c.chat = { enabled: false, agentReplies: true }; })),
    /agentReplies is true while chat.enabled is false/i);
  // Disabled chat with the switch simply absent is the ordinary case, and generates no chat Worker.
  assert.equal(generateConfigs(variant((c) => { c.chat = { enabled: false }; }), bases).chat, undefined);
});

const recordsAppHyperdrive = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const recordsPublisherHyperdrive = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const recordsApiAudience = "c".repeat(64);

/** {@link validConfig} with Records switched on, plus any further `mutate`. */
function recordsVariant(mutate: (config: Record<string, any>) => void = () => {}): DeploymentConfig {
  return variant((c) => {
    c.workers.records = { name: "acme-cloudflare-os-records" };
    c.records = {
      enabled: true,
      hyperdriveId: recordsAppHyperdrive,
      publisherHyperdriveId: recordsPublisherHyperdrive,
      apiAccessAudience: recordsApiAudience,
    };
    mutate(c);
  });
}

test("generates nothing Records-related when Records is disabled or absent", async () => {
  const bases = await baseConfigs();
  for (const config of [
    validConfig,
    variant((c) => { c.records = { enabled: false }; }),
    // Dormant: placeholders and junk in a disabled block are not validated.
    variant((c) => {
      c.workers.records = { name: "<RECORDS_WORKER_NAME>" };
      c.records = {
        enabled: false,
        hyperdriveId: "<RECORDS_APP_HYPERDRIVE_ID>",
        publisherHyperdriveId: "<RECORDS_APP_HYPERDRIVE_ID>",
        apiAccessAudience: "",
      };
    }),
  ]) {
    const generated = generateConfigs(config, bases);
    assert.equal(generated.records, undefined);
    assert.equal(generated.router.services!.some((s) => s.binding === "GATEKEEPER_RECORDS"), false);
    assert.equal(generated.workshop.services!.some((s) => s.binding === "GATEKEEPER_RECORDS"), false);
    assert.equal(Object.values(generated).some((w) => w?.hyperdrive || w?.queues), false);
    assert.equal(deployOrder(config).includes("records"), false);
    assert.equal(buildCommands(config).some(({ args }) => args.includes("gatekeeper-records")), false);
  }
  // A disabled Records name is free to collide, because nothing is deployed under it.
  validateConfig(variant((c) => {
    c.workers.records = { name: c.workers.workshop.name };
    c.records = { enabled: false };
  }));
  assert.throws(
    () => validateConfig(recordsVariant((c) => { c.workers.records.name = c.workers.workshop.name; })),
    /unique/i);
});

test("the repository's deployment.jsonc keeps Records disabled", async () => {
  const errors: ParseError[] = [];
  const config = parse(
    await readFile(new URL("../deployment.jsonc", import.meta.url), "utf8"), errors,
    { allowTrailingComma: true }) as DeploymentConfig;
  assert.deepEqual(errors, []);
  assert.equal(config.records?.enabled, false);
  assert.equal(typeof config.workers.records?.name, "string");
  validateConfig(config);
});

test("generates the Records Worker with both uncached Hyperdrive IDs, its queues and vars", async () => {
  const bases = await baseConfigs();
  const generated = generateConfigs(recordsVariant(), bases);
  const records = generated.records!;
  assert.equal(records.name, "acme-cloudflare-os-records");
  assert.equal(records.account_id, validConfig.accountId);
  assert.equal(records.workers_dev, false);
  assert.equal(records.preview_urls, false);
  assert.equal(records.routes, undefined);
  // Only the IDs: caching must be disabled on both configurations, which lives on the Hyperdrive
  // configuration itself and cannot be expressed (or overridden) here.
  assert.deepEqual(records.hyperdrive, [
    { binding: "HYPERDRIVE", id: recordsAppHyperdrive },
    { binding: "HYPERDRIVE_PUBLISHER", id: recordsPublisherHyperdrive },
  ]);
  assert.deepEqual(records.queues!.producers, [
    { binding: "CHANGES", queue: "acme-cloudflare-os-records-changes" },
  ]);
  assert.equal(records.queues!.consumers!.length, 1);
  assert.deepEqual(records.queues!.consumers![0], {
    ...bases.records!.queues!.consumers![0],
    queue: "acme-cloudflare-os-records-changes",
    dead_letter_queue: "acme-cloudflare-os-records-changes-dlq",
  });
  assert.deepEqual(records.vars, {
    CF_ACCESS_ISS: "https://acme.cloudflareaccess.com",
    CF_ACCESS_AUD: "access-audience",
    RECORDS_API_ACCESS_AUD: recordsApiAudience,
    PUBLIC_BASE_URL: "https://os.example.com",
  });
  // Inherited from the package's wrangler.jsonc.
  assert.deepEqual(records.migrations, bases.records!.migrations);
  assert.deepEqual(records.triggers, bases.records!.triggers);
  assert.deepEqual(records.ratelimits, bases.records!.ratelimits);
  assert.deepEqual(records.build, bases.records!.build);
  assert.equal(records.secrets, undefined);

  const custom = generateConfigs(recordsVariant((c) => {
    c.records.changesQueue = "records-feed";
    c.records.deadLetterQueue = "records-feed-dead";
  }), bases).records!;
  assert.equal(custom.queues!.producers![0].queue, "records-feed");
  assert.equal(custom.queues!.consumers![0].queue, "records-feed");
  assert.equal(custom.queues!.consumers![0].dead_letter_queue, "records-feed-dead");
  assert.deepEqual(recordsQueues(recordsVariant()), {
    changes: "acme-cloudflare-os-records-changes",
    deadLetter: "acme-cloudflare-os-records-changes-dlq",
  });
});

test("never ships the Records Worker's dev-only localConnectionString", async () => {
  const bases = await baseConfigs();
  // The base config does carry them, for wrangler dev.
  assert.ok(bases.records!.hyperdrive!.every((entry) => entry.localConnectionString));
  const generated = generateConfigs(recordsVariant(), bases);
  const text = JSON.stringify(generated);
  assert.equal(text.includes("localConnectionString"), false);
  assert.equal(text.includes("records-test-only"), false);
  assert.equal(text.includes("postgres://"), false);
});

test("serves Records through the router and binds its vendor to the Workshop", async () => {
  const generated = generateConfigs(recordsVariant(), await baseConfigs());
  assert.deepEqual(generated.router.services!.find((s) => s.binding === "GATEKEEPER_RECORDS"), {
    binding: "GATEKEEPER_RECORDS",
    service: "acme-cloudflare-os-records",
  });
  assert.deepEqual(generated.workshop.services!.find((s) => s.binding === "GATEKEEPER_RECORDS"), {
    binding: "GATEKEEPER_RECORDS",
    service: "acme-cloudflare-os-records",
    entrypoint: "GatekeeperVendor",
  });
  // The router remains the sole public entrypoint.
  for (const [name, worker] of Object.entries(generated) as [string, ProdWranglerConfig][]) {
    if (name === "router") continue;
    assert.equal(worker.routes, undefined, `${name} carries a public route`);
    assert.equal(worker.workers_dev, false, `${name} answers on workers.dev`);
  }
});

test("deploys Records before the Workshop and router that bind it, and builds it first", () => {
  const config = recordsVariant();
  const order = deployOrder(config);
  assert.ok(order.indexOf("records") >= 0);
  assert.ok(order.indexOf("records") < order.indexOf("workshop"), order.join(" "));
  assert.ok(order.indexOf("records") < order.indexOf("router"), order.join(" "));
  assert.equal(new Set(order).size, order.length);
  assert.ok(deployOrder(recordsVariant((c) => { c.chat.agentAccess = true; })).indexOf("records") <
    deployOrder(recordsVariant((c) => { c.chat.agentAccess = true; })).indexOf("workshop"));

  const commands = buildCommands(config).map(({ args }) => args.join(" "));
  const app = commands.indexOf("--filter gatekeeper-records exec node build-app.mjs");
  const tsc = commands.findIndex((c) => c.includes("vp run -F gatekeeper-records --no-cache build"));
  assert.ok(app >= 0 && tsc > app, commands.join("\n"));
});

test("rejects missing, malformed or shared Records Hyperdrive IDs and audiences", () => {
  assert.doesNotThrow(() => validateConfig(recordsVariant()));
  for (const [mutate, message] of [
    [(c: Record<string, any>) => { delete c.workers.records; }, /workers\.records\.name/],
    [(c: Record<string, any>) => { delete c.records.hyperdriveId; }, /records\.hyperdriveId/],
    [(c: Record<string, any>) => { c.records.publisherHyperdriveId = ""; }, /records\.publisherHyperdriveId/],
    [(c: Record<string, any>) => { c.records.hyperdriveId = "not-a-hyperdrive-id"; }, /32 hexadecimal/],
    [(c: Record<string, any>) => { c.records.publisherHyperdriveId = "abc"; }, /32 hexadecimal/],
    [(c: Record<string, any>) => { c.records.hyperdriveId = "<RECORDS_APP_HYPERDRIVE_ID>"; }, /placeholder/i],
    [(c: Record<string, any>) => { c.records.publisherHyperdriveId = recordsAppHyperdrive.toUpperCase(); },
      /must be different Hyperdrive configurations/],
    [(c: Record<string, any>) => { delete c.records.apiAccessAudience; }, /records\.apiAccessAudience/],
    [(c: Record<string, any>) => { c.records.apiAccessAudience = "records-audience"; }, /AUD tag/],
    [(c: Record<string, any>) => {
      c.access.audience = recordsApiAudience;
    }, /same as access\.audience/],
    [(c: Record<string, any>) => { c.records.enabled = "yes"; }, /records\.enabled must be a boolean/],
    [(c: Record<string, any>) => { c.records.changesQueue = "Records_Changes"; }, /records\.changesQueue/],
    [(c: Record<string, any>) => { c.records.deadLetterQueue = c.records.changesQueue = "same"; },
      /must be different queues/],
  ] as const) {
    assert.throws(() => validateConfig(recordsVariant(mutate)), message);
  }
});
