// `pnpm search:provision` -- creates the omni-search Worker's out-of-band resources, which
// `wrangler deploy` cannot: the Vectorize index (768 dimensions, cosine), its six string metadata
// indexes, and the embed queue with its dead-letter queue. Names come from deployment.jsonc.
//
// Dry by default: it reads the account (read-only wrangler commands), prints the plan, and changes
// nothing. `--yes` runs the plan, then reads the account again and verifies the result -- the same
// verification `pnpm check` and `pnpm deploy` run before building anything.
//
// Idempotent: a resource that already exists with the right shape is left alone. One that exists
// with the wrong shape (an index's dimensions or metric, a metadata index's type) cannot be changed
// in place, so it is reported and nothing at all is created.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readDeployment, searchNames } from "./deploy.ts";
import {
  describeAction,
  planSearchProvisioning,
  readSearchState,
  searchProblems,
  searchProblemsMessage,
  searchResourceSpec,
  wranglerArgs,
  wranglerRunner,
} from "./search-resources.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const usage = `Usage: pnpm search:provision [--yes]

Creates what the omni-search Worker needs and wrangler deploy cannot create: the Vectorize index,
its metadata indexes, and the embed queue and dead-letter queue named by deployment.jsonc.

  (no flags)  Read the account and print the plan. Changes nothing.
  --yes       Run the plan, then verify the result.`;

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage);
    return;
  }
  const unknown = argv.filter((arg) => arg !== "--yes");
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(" ")}\n\n${usage}`);
  const apply = argv.includes("--yes");

  const config = await readDeployment(join(root, "deployment.jsonc"));
  if (config.search?.enabled !== true) {
    throw new Error(
      "search.enabled is not true in deployment.jsonc, so there is nothing to provision. Enable " +
      "the search block first: the resource names derive from it and from workers.search.name.");
  }
  const spec = searchResourceSpec(searchNames(config));
  const read = wranglerRunner(root, config.accountId);

  console.log(
    `Account ${config.accountId}\n` +
    `  Vectorize index  ${spec.index} (${spec.dimensions} dimensions, ${spec.metric})\n` +
    `  metadata indexes ${spec.metadataIndexes.join(", ")} (string)\n` +
    `  queues           ${spec.embedQueue}, dead-letter ${spec.deadLetterQueue}\n\n` +
    "Reading current state (read-only)...");
  const state = await readSearchState(spec, read, { vectorCount: true });
  const plan = planSearchProvisioning(spec, state);

  for (const warning of plan.warnings) console.warn(`\nWarning: ${warning}`);
  if (plan.conflicts.length) {
    throw new Error(
      "Cannot provision; nothing was created:\n" +
      plan.conflicts.map((conflict) => `  - ${conflict}`).join("\n"));
  }
  if (!plan.actions.length) {
    console.log("\nNothing to do: every omni-search resource exists with the expected shape.");
    return;
  }

  const env = `CLOUDFLARE_ACCOUNT_ID=${config.accountId}`;
  console.log(`\n${apply ? "Creating" : "Would create"}:`);
  for (const action of plan.actions) {
    console.log(`  - ${describeAction(action)}\n      ${env} pnpm exec wrangler ${wranglerArgs(action).join(" ")}`);
  }
  if (!apply) {
    console.log("\nDry run: nothing was changed. Re-run with --yes to create these.");
    return;
  }

  // Serial, and stop at the first failure: the plan is ordered, and a partial run is safe to
  // resume because a re-run plans only what is still missing.
  const mutate = wranglerRunner(root, config.accountId, true);
  for (const action of plan.actions) {
    const args = wranglerArgs(action);
    console.log(`\n> wrangler ${args.join(" ")}`);
    const result = await mutate(args);
    if (result.status !== 0) {
      throw new Error(
        `wrangler ${args.join(" ")} failed (exit ${result.status}); its output is above. Re-run ` +
        "pnpm search:provision to see what is still missing.");
    }
  }

  // Vectorize reads can lag a moment behind its writes, so a failure here says so rather than
  // suggesting the creations did not happen.
  const after = await readSearchState(spec, read);
  const problems = searchProblems(spec, after);
  if (problems.length) {
    throw new Error(
      `${searchProblemsMessage(problems)}\n(Vectorize can take a few seconds to report a new ` +
      "index or metadata index; re-run pnpm search:provision to check again.)");
  }
  console.log("\nDone: every omni-search resource exists with the expected shape.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`\nsearch:provision failed. ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
