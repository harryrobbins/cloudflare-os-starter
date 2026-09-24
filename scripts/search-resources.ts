// The omni-search Worker's out-of-band resources: one Vectorize index, its metadata indexes, and the
// embed queue with its dead-letter queue.
//
// None of them can be created by `wrangler deploy`. A Vectorize binding names an index that must
// already exist, and the metadata indexes must exist *before the first upsert* -- a vector written
// earlier is not indexed on a property added later, and re-upserting the corpus is the only repair
// (docs/plans/omni-search.md, "Document model"). So `pnpm search:provision` creates them, and
// `pnpm check` / `pnpm deploy` refuse to continue until they exist with the shape the Worker expects.
//
// Split in two on purpose: `planSearchProvisioning` and `searchProblems` are pure functions from an
// observed state to a plan, which is what the tests exercise; `readSearchState` is the only part that
// talks to Cloudflare, and it only ever runs read-only wrangler commands.

import { spawn } from "node:child_process";
import { pnpmCommand } from "../cloudflare-os/scripts/pnpm-command.ts";
import { resolveBinEntry } from "../cloudflare-os/scripts/bin-entry.ts";
// The Worker's own contract, so the index this script builds and the vectors the Worker writes can
// never disagree about dimensions or the metadata schema. A pure-constants module: no imports.
import {
  EMBED_DIMENSIONS,
  VECTOR_METADATA_INDEXES,
} from "../packages/gatekeeper-search/src/shared/contract.ts";

/** The distance metric bge-base-en-v1.5 embeddings are compared with. Fixed for the index's life. */
export const SEARCH_INDEX_METRIC = "cosine";
/** Vectorize allows this many metadata indexes per index. */
export const MAX_METADATA_INDEXES = 10;

/** The resource names one deployment uses, defaults applied. */
export interface SearchResourceNames {
  index: string;
  embedQueue: string;
  deadLetterQueue: string;
}

/** What the Worker needs to exist: names plus the index's fixed shape. */
export interface SearchResourceSpec extends SearchResourceNames {
  dimensions: number;
  metric: string;
  /** Every one is a `string` metadata index. */
  metadataIndexes: readonly string[];
}

/** {@link SearchResourceSpec} for these names, shape taken from the Worker's contract. */
export function searchResourceSpec(names: SearchResourceNames): SearchResourceSpec {
  return {
    ...names,
    dimensions: EMBED_DIMENSIONS,
    metric: SEARCH_INDEX_METRIC,
    metadataIndexes: VECTOR_METADATA_INDEXES,
  };
}

/** What exists in the account right now, as read by {@link readSearchState}. */
export interface SearchState {
  /** null when the index does not exist. */
  index: { dimensions: number; metric: string; vectorCount?: number } | null;
  /** The index's metadata indexes. Empty when the index does not exist. */
  metadataIndexes: { propertyName: string; indexType: string }[];
  /** Queue name -> whether it exists. */
  queues: Record<string, boolean>;
}

export type SearchAction =
  | { kind: "create-index"; index: string; dimensions: number; metric: string }
  | { kind: "create-metadata-index"; index: string; propertyName: string; type: "string" }
  | { kind: "create-queue"; queue: string };

export interface SearchPlan {
  /** Creations, in the order they must run. Empty when everything is in place. */
  actions: SearchAction[];
  /** States no creation can fix. Non-empty means stop: nothing should be created. */
  conflicts: string[];
  /** Things that will work but that the operator should know about. */
  warnings: string[];
}

/**
 * The creations that take `state` to `spec`. Pure: never mutates, never calls out.
 *
 * Idempotent by construction -- an existing resource with the right shape produces no action -- and
 * refuses rather than repairs anything that already exists with the *wrong* shape: a Vectorize
 * index's dimensions and metric, and a metadata index's type, cannot be changed in place.
 */
export function planSearchProvisioning(spec: SearchResourceSpec, state: SearchState): SearchPlan {
  const actions: SearchAction[] = [];
  const conflicts: string[] = [];
  const warnings: string[] = [];

  if (!state.index) {
    actions.push({
      kind: "create-index", index: spec.index, dimensions: spec.dimensions, metric: spec.metric,
    });
  } else {
    if (state.index.dimensions !== spec.dimensions || state.index.metric !== spec.metric) {
      conflicts.push(
        `Vectorize index "${spec.index}" exists with ${state.index.dimensions} dimensions and ` +
        `metric "${state.index.metric}", but the search Worker writes ${spec.dimensions}-dimension ` +
        `${spec.metric} embeddings. An index's shape cannot be changed: set search.index to a new ` +
        "name and provision that (then backfill), or delete this index deliberately.");
    }
  }

  const existing = new Map(state.metadataIndexes.map((m) => [m.propertyName, m.indexType]));
  const missing: string[] = [];
  for (const property of spec.metadataIndexes) {
    const type = existing.get(property);
    if (type === undefined) {
      missing.push(property);
    } else if (type.toLowerCase() !== "string") {
      conflicts.push(
        `Metadata index "${property}" on "${spec.index}" has type ${type}, not string. A metadata ` +
        `index cannot be retyped: wrangler vectorize delete-metadata-index ${spec.index} ` +
        `--propertyName ${property}, then re-provision and re-upsert the corpus.`);
    }
  }
  if (existing.size + missing.length > MAX_METADATA_INDEXES) {
    conflicts.push(
      `"${spec.index}" would need ${existing.size + missing.length} metadata indexes; Vectorize ` +
      `allows ${MAX_METADATA_INDEXES}. Remove unused ones before provisioning.`);
  }
  for (const property of missing) {
    actions.push({ kind: "create-metadata-index", index: spec.index, propertyName: property, type: "string" });
  }
  if (state.index && missing.length && (state.index.vectorCount ?? 0) > 0) {
    warnings.push(
      `"${spec.index}" already holds ${state.index.vectorCount} vectors. Vectors written before a ` +
      `metadata index exists are not indexed on it, so ${missing.join(", ")} will not filter them ` +
      "until the corpus is re-upserted (a backfill).");
  }

  // The dead-letter queue first: nothing depends on the order today, but the embed queue's consumer
  // names it, so this is the order in which each exists before anything refers to it.
  for (const queue of [spec.deadLetterQueue, spec.embedQueue]) {
    if (!state.queues[queue]) actions.push({ kind: "create-queue", queue });
  }

  return { actions: conflicts.length ? [] : actions, conflicts, warnings };
}

/**
 * Everything that would make the search Worker's deploy wrong, as one line each. Empty means ready.
 * `pnpm check` and `pnpm deploy` use this; it is the plan read as a verdict.
 */
export function searchProblems(spec: SearchResourceSpec, state: SearchState): string[] {
  const plan = planSearchProvisioning(spec, state);
  return [...plan.conflicts, ...plan.actions.map((action) => `missing: ${describeAction(action)}`)];
}

/** The wrangler argv (after `wrangler`) that performs `action`. */
export function wranglerArgs(action: SearchAction): string[] {
  switch (action.kind) {
    case "create-index":
      return ["vectorize", "create", action.index,
        "--dimensions", String(action.dimensions), "--metric", action.metric];
    case "create-metadata-index":
      return ["vectorize", "create-metadata-index", action.index,
        "--propertyName", action.propertyName, "--type", action.type];
    case "create-queue":
      return ["queues", "create", action.queue];
  }
}

/** One human line for `action`. */
export function describeAction(action: SearchAction): string {
  switch (action.kind) {
    case "create-index":
      return `Vectorize index "${action.index}" (${action.dimensions} dimensions, ${action.metric})`;
    case "create-metadata-index":
      return `metadata index "${action.propertyName}" (${action.type}) on "${action.index}"`;
    case "create-queue":
      return `queue "${action.queue}"`;
  }
}

/** The verification failure message, naming the fix. */
export function searchProblemsMessage(problems: string[]): string {
  return (
    "Omni-search resources are not ready (search.enabled is true):\n" +
    problems.map((problem) => `  - ${problem}`).join("\n") +
    "\nwrangler deploy cannot create a Vectorize index or its metadata indexes. Run " +
    "`pnpm search:provision` to review the plan, then `pnpm search:provision --yes` to create " +
    "them; or set search.enabled to false.");
}

// ---------------------------------------------------------------------------
// Reading the account (read-only wrangler commands)
// ---------------------------------------------------------------------------

export interface WranglerResult { status: number; stdout: string; stderr: string }
export type WranglerRunner = (args: string[]) => Promise<WranglerResult>;

// eslint-disable-next-line no-control-regex
const ansi = /\u001b\[[0-9;]*m/g;

function output(result: WranglerResult): string {
  return `${result.stdout}\n${result.stderr}`.replace(ansi, "");
}

function failure(args: string[], result: WranglerResult): Error {
  return new Error(
    `wrangler ${args.join(" ")} failed (exit ${result.status}):\n${output(result).trim()}`);
}

/**
 * The JSON document a `--json` wrangler command printed. Taken from the first `{` or `[` at the
 * start of a line: wrangler suppresses its banner under `--json`, but an update notice or a warning
 * is still free to precede it.
 */
export function parseWranglerJson(stdout: string): unknown {
  const text = stdout.replace(ansi, "");
  const start = text.search(/^[[{]/m);
  if (start < 0) throw new Error(`wrangler printed no JSON:\n${text.trim()}`);
  return JSON.parse(text.slice(start));
}

/** Vectorize's "no such index" (`vectorize.index.not_found`, API code 3000). */
export function isVectorizeNotFound(result: WranglerResult): boolean {
  return /vectorize\.index\.not_found|\[code: 3000\]/.test(output(result));
}

/**
 * Whether `wrangler queues info <name>` found the queue. The pinned wrangler (4.124) has no JSON
 * output for queues: a found queue prints `Queue Name: <name>` and exits 0, a missing one exits 1
 * with `Queue "<name>" does not exist`. Anything else (auth, network) is an error, not an absence.
 */
export function queueInfoExists(name: string, result: WranglerResult): boolean {
  const text = output(result);
  if (result.status === 0 && text.split("\n").some((line) => line.trim() === `Queue Name: ${name}`)) {
    return true;
  }
  if (result.status !== 0 && text.includes(`Queue "${name}" does not exist`)) return false;
  throw failure(["queues", "info", name], result);
}

/**
 * The current state of `spec`'s resources. Runs only read-only commands, in parallel:
 * `vectorize get --json`, `vectorize list-metadata-index --json`, `queues info` per queue, and,
 * with `vectorCount`, `vectorize info --json`.
 */
export async function readSearchState(
  spec: SearchResourceNames,
  run: WranglerRunner,
  options: { vectorCount?: boolean } = {},
): Promise<SearchState> {
  const getArgs = ["vectorize", "get", spec.index, "--json"];
  const metaArgs = ["vectorize", "list-metadata-index", spec.index, "--json"];
  const infoArgs = ["vectorize", "info", spec.index, "--json"];
  const queueNames = [spec.embedQueue, spec.deadLetterQueue];
  const [get, meta, info, ...queueResults] = await Promise.all([
    run(getArgs),
    run(metaArgs),
    options.vectorCount ? run(infoArgs) : Promise.resolve(null),
    ...queueNames.map((queue) => run(["queues", "info", queue])),
  ]);

  const queues = Object.fromEntries(
    queueNames.map((queue, i) => [queue, queueInfoExists(queue, queueResults[i]!)]));

  if (get.status !== 0) {
    if (isVectorizeNotFound(get)) return { index: null, metadataIndexes: [], queues };
    throw failure(getArgs, get);
  }
  const index = parseWranglerJson(get.stdout) as { config?: { dimensions?: number; metric?: string } };
  if (meta.status !== 0) throw failure(metaArgs, meta);
  const metadataIndexes = parseWranglerJson(meta.stdout) as { propertyName: string; indexType: string }[];
  if (!Array.isArray(metadataIndexes)) {
    throw new Error(`wrangler ${metaArgs.join(" ")} did not print a JSON array.`);
  }
  let vectorCount: number | undefined;
  if (info) {
    if (info.status !== 0) throw failure(infoArgs, info);
    vectorCount = (parseWranglerJson(info.stdout) as { vectorCount?: number }).vectorCount;
  }
  return {
    index: {
      dimensions: Number(index.config?.dimensions),
      metric: String(index.config?.metric),
      ...(vectorCount !== undefined ? { vectorCount } : {}),
    },
    metadataIndexes: metadataIndexes.map(({ propertyName, indexType }) => ({ propertyName, indexType })),
    queues,
  };
}

/**
 * A {@link WranglerRunner} over the project-pinned wrangler, pinned to `accountId` the way the
 * generated configs pin theirs (`account_id`), so a stray login default cannot point it elsewhere.
 * Run from `cwd`, which should hold no wrangler config: these are account-level commands.
 */
export function wranglerRunner(cwd: string, accountId: string, inherit = false): WranglerRunner {
  const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId };
  const entry = resolveBinEntry(cwd, "wrangler");
  return (args) => new Promise((resolvePromise, reject) => {
    const [command, argv] = entry
      ? [process.execPath, [entry, ...args]]
      : pnpmCommand(["exec", "wrangler", ...args], env);
    const child = spawn(command, argv, { cwd, env, stdio: inherit ? "inherit" : "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status: status ?? 1, stdout, stderr }));
  });
}
