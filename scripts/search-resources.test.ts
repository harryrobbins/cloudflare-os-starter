import assert from "node:assert/strict";
import test from "node:test";
import {
  EMBED_DIMENSIONS,
  VECTOR_METADATA_INDEXES,
} from "../packages/gatekeeper-search/src/shared/contract.ts";
import {
  describeAction,
  isVectorizeNotFound,
  parseWranglerJson,
  planSearchProvisioning,
  queueInfoExists,
  readSearchState,
  searchProblems,
  searchProblemsMessage,
  searchResourceSpec,
  wranglerArgs,
  type SearchState,
  type WranglerResult,
  type WranglerRunner,
} from "./search-resources.ts";

const spec = searchResourceSpec({
  index: "cfos-search",
  embedQueue: "cfos-search-embed",
  deadLetterQueue: "cfos-search-embed-dlq",
});

const allMetadata = VECTOR_METADATA_INDEXES.map((propertyName) => ({ propertyName, indexType: "String" }));

const ready: SearchState = {
  index: { dimensions: 768, metric: "cosine", vectorCount: 0 },
  metadataIndexes: allMetadata,
  queues: { "cfos-search-embed": true, "cfos-search-embed-dlq": true },
};

const empty: SearchState = { index: null, metadataIndexes: [], queues: {} };

test("the spec is the Worker's own contract: 768-dimension cosine and six string metadata indexes", () => {
  assert.equal(spec.dimensions, EMBED_DIMENSIONS);
  assert.equal(spec.dimensions, 768);
  assert.equal(spec.metric, "cosine");
  assert.deepEqual([...spec.metadataIndexes], ["scope", "vis", "source", "kind", "author", "day"]);
});

test("plans every creation, in order, on an empty account", () => {
  const plan = planSearchProvisioning(spec, empty);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.warnings, []);
  assert.deepEqual(plan.actions.map(wranglerArgs), [
    ["vectorize", "create", "cfos-search", "--dimensions", "768", "--metric", "cosine"],
    ...["scope", "vis", "source", "kind", "author", "day"].map((property) =>
      ["vectorize", "create-metadata-index", "cfos-search", "--propertyName", property, "--type", "string"]),
    ["queues", "create", "cfos-search-embed-dlq"],
    ["queues", "create", "cfos-search-embed"],
  ]);
  assert.equal(describeAction(plan.actions[0]!), 'Vectorize index "cfos-search" (768 dimensions, cosine)');
});

test("plans nothing when everything exists with the right shape", () => {
  // Vectorize reports metadata types capitalised ("String"); the comparison ignores case.
  assert.deepEqual(planSearchProvisioning(spec, ready), { actions: [], conflicts: [], warnings: [] });
  assert.deepEqual(searchProblems(spec, ready), []);
});

test("plans only what is missing", () => {
  const plan = planSearchProvisioning(spec, {
    ...ready,
    metadataIndexes: allMetadata.filter(({ propertyName }) => propertyName !== "day"),
    queues: { "cfos-search-embed": true, "cfos-search-embed-dlq": false },
  });
  assert.deepEqual(plan.actions, [
    { kind: "create-metadata-index", index: "cfos-search", propertyName: "day", type: "string" },
    { kind: "create-queue", queue: "cfos-search-embed-dlq" },
  ]);
  assert.deepEqual(plan.warnings, []);
});

test("warns that vectors written before a metadata index exists are not indexed on it", () => {
  const plan = planSearchProvisioning(spec, {
    ...ready,
    index: { dimensions: 768, metric: "cosine", vectorCount: 1200 },
    metadataIndexes: allMetadata.filter(({ propertyName }) => propertyName !== "author"),
  });
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0]!, /1200 vectors.*author.*re-upserted/s);
});

test("refuses, and creates nothing, when an existing resource has the wrong shape", () => {
  for (const index of [
    { dimensions: 384, metric: "cosine" },
    { dimensions: 768, metric: "euclidean" },
  ]) {
    const plan = planSearchProvisioning(spec, { ...empty, index });
    assert.deepEqual(plan.actions, []);
    assert.match(plan.conflicts[0]!, /cannot be changed.*search\.index/s);
  }

  const retyped = planSearchProvisioning(spec, {
    ...ready,
    metadataIndexes: allMetadata.map((m) => m.propertyName === "day" ? { ...m, indexType: "Number" } : m),
    queues: {},
  });
  assert.deepEqual(retyped.actions, []);
  assert.match(retyped.conflicts[0]!, /"day".*Number.*delete-metadata-index cfos-search --propertyName day/s);

  const crowded = planSearchProvisioning(spec, {
    ...ready,
    metadataIndexes: ["a", "b", "c", "d", "e", "f"].map((propertyName) => ({ propertyName, indexType: "String" })),
  });
  assert.deepEqual(crowded.actions, []);
  assert.match(crowded.conflicts[0]!, /12 metadata indexes; Vectorize allows 10/);
});

test("the verification verdict names every problem and the provisioning command", () => {
  const problems = searchProblems(spec, empty);
  assert.equal(problems.length, 9);
  assert.match(problems[0]!, /^missing: Vectorize index "cfos-search"/);
  const message = searchProblemsMessage(problems);
  assert.match(message, /pnpm search:provision --yes/);
  assert.match(message, /queue "cfos-search-embed-dlq"/);
});

// Output shapes of the pinned wrangler (4.124), observed on read-only commands.
const ok = (stdout: string): WranglerResult => ({ status: 0, stdout, stderr: "" });
const notFoundIndex: WranglerResult = {
  status: 1,
  stdout: "",
  stderr:
    "\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1mA request to the Cloudflare " +
    "API (/accounts/x/vectorize/v2/indexes/cfos-search) failed.\u001b[0m\n\n" +
    '  vectorize.index.not_found - Index name "cfos-search" [code: 3000]\n',
};
const queueMissing = (name: string): WranglerResult => ({
  status: 1,
  stdout: "",
  stderr: `✘ [ERROR] Queue "${name}" does not exist. To create it, run: wrangler queues create ${name}\n`,
});
const queueFound = (name: string): WranglerResult => ok(
  " ⛅️ wrangler 4.124.0\n───────\n" +
  `Queue Name: ${name}\nQueue ID: 1651b8105b0c4263abf800e7ede5e2b4\nNumber of Producers: 0\n`);

test("parses wrangler's JSON output, tolerating a notice before it", () => {
  assert.deepEqual(parseWranglerJson('{\n  "name": "x"\n}'), { name: "x" });
  assert.deepEqual(parseWranglerJson('update available 4.137.0\n[\n  {"propertyName": "vis"}\n]'),
    [{ propertyName: "vis" }]);
  assert.throws(() => parseWranglerJson("nothing here"), /no JSON/);
  assert.equal(isVectorizeNotFound(notFoundIndex), true);
  assert.equal(isVectorizeNotFound({ status: 1, stdout: "", stderr: "Authentication error [code: 10000]" }), false);
});

test("reads queue existence from queues info, and treats other failures as errors", () => {
  assert.equal(queueInfoExists("q", queueFound("q")), true);
  assert.equal(queueInfoExists("q", queueMissing("q")), false);
  // A different queue's name in the output is not this queue.
  assert.throws(() => queueInfoExists("q", queueFound("q-dlq")), /queues info q failed/);
  assert.throws(() => queueInfoExists("q", { status: 1, stdout: "", stderr: "Not logged in." }),
    /Not logged in/);
});

function fakeRunner(responses: Record<string, WranglerResult>): WranglerRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const response = responses[args.join(" ")];
    if (!response) throw new Error(`unexpected wrangler ${args.join(" ")}`);
    return response;
  };
  return Object.assign(run, { calls });
}

test("reads the account's state with read-only commands only", async () => {
  const run = fakeRunner({
    "vectorize get cfos-search --json": ok(JSON.stringify({
      name: "cfos-search", config: { dimensions: 768, metric: "cosine" }, created_on: "x",
    })),
    "vectorize list-metadata-index cfos-search --json": ok(JSON.stringify(allMetadata)),
    "vectorize info cfos-search --json": ok(JSON.stringify({ vectorCount: 5, dimensions: 768 })),
    "queues info cfos-search-embed": queueFound("cfos-search-embed"),
    "queues info cfos-search-embed-dlq": queueMissing("cfos-search-embed-dlq"),
  });
  const state = await readSearchState(spec, run, { vectorCount: true });
  assert.deepEqual(state, {
    index: { dimensions: 768, metric: "cosine", vectorCount: 5 },
    metadataIndexes: allMetadata,
    queues: { "cfos-search-embed": true, "cfos-search-embed-dlq": false },
  });
  for (const args of run.calls) {
    assert.ok(["get", "list-metadata-index", "info"].includes(args[1]!), args.join(" "));
  }

  const absent = await readSearchState(spec, fakeRunner({
    "vectorize get cfos-search --json": notFoundIndex,
    "vectorize list-metadata-index cfos-search --json": notFoundIndex,
    "queues info cfos-search-embed": queueMissing("cfos-search-embed"),
    "queues info cfos-search-embed-dlq": queueMissing("cfos-search-embed-dlq"),
  }));
  assert.deepEqual(absent, {
    index: null, metadataIndexes: [],
    queues: { "cfos-search-embed": false, "cfos-search-embed-dlq": false },
  });

  // An auth failure is not "the index is missing".
  await assert.rejects(readSearchState(spec, fakeRunner({
    "vectorize get cfos-search --json": { status: 1, stdout: "", stderr: "Authentication error [code: 10000]" },
    "vectorize list-metadata-index cfos-search --json": notFoundIndex,
    "queues info cfos-search-embed": queueFound("cfos-search-embed"),
    "queues info cfos-search-embed-dlq": queueFound("cfos-search-embed-dlq"),
  })), /vectorize get cfos-search --json failed/);
});
