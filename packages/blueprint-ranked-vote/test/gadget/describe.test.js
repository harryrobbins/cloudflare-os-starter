// The Gadget class in Node: describeGadget() is well formed, every example runs as written against
// the real operation and satisfies its input schema, and the use evals' references pass their checks.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Gadget } from "../../src/server/index.js";
import evals from "../../src/evals.mjs";
import { MemoryStorage } from "../support/memory-storage.js";

const alice = { id: "alice@x", name: "Alice" };
const bob = { id: "bob@x", name: "Bob" };

const fresh = () => /** @type {any} */ (new Gadget(/** @type {any} */ ({ storage: new MemoryStorage() }), {}));

/** Options (Quill is the Assistant's), two fields, and ballots from Alice and Bob, nobody ready. */
async function seeded() {
  const g = fresh();
  const r = await g.setUpVote({ by: alice, question: "Name?", fields: [{ label: "Proposed URL", kind: "url" }], options: ["Hoarse", "Lumen"] });
  expect(r.error).toBeUndefined();
  const q = await g.proposeOptions({ options: ["Quill"] });
  const ids = [...r.added, ...q.added].map((o) => o.id);
  await g.saveRanking({ by: alice, ranking: ids });
  await g.saveRanking({ by: bob, ranking: ids.toReversed() });
  return g;
}

/** A small JSON Schema check: type, required, properties, items, enum, oneOf and bounds. */
function validate(schema, value, path = "input") {
  if (!schema) return [];
  if (schema.oneOf) {
    return schema.oneOf.some((s) => validate(s, value, path).length === 0) ? [] : [`${path}: matches none of oneOf`];
  }
  const problems = [];
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${path}: ${JSON.stringify(value)} not in ${schema.enum}`);
  const type = schema.type;
  const is = { string: typeof value === "string", integer: Number.isInteger(value), number: typeof value === "number", boolean: typeof value === "boolean", array: Array.isArray(value), object: value !== null && typeof value === "object" && !Array.isArray(value) };
  if (type && !is[type]) return [`${path}: expected ${type}, got ${JSON.stringify(value)}`];
  if (type === "string" && schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${path}: longer than ${schema.maxLength}`);
  if ((type === "integer" || type === "number") && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) problems.push(`${path}: out of range`);
  if (type === "array") {
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${path}: more than ${schema.maxItems} items`);
    value.forEach((x, i) => problems.push(...validate(schema.items, x, `${path}[${i}]`)));
  }
  if (type === "object") {
    for (const k of schema.required ?? []) if (!(k in value)) problems.push(`${path}: missing ${k}`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) problems.push(...validate(schema.properties[k], v, `${path}.${k}`));
      else if (schema.properties && !schema.additionalProperties) problems.push(`${path}: unexpected property ${k}`);
      else if (typeof schema.additionalProperties === "object") problems.push(...validate(schema.additionalProperties, v, `${path}.${k}`));
    }
  }
  return problems;
}

/** Runs an example's code with env.Vote bound to `gadget`, recording each call. */
async function runExample(example, gadget) {
  const calls = [];
  const Vote = new Proxy({}, { get: (_, name) => (...args) => { calls.push({ name, args }); return gadget[name](...args); } });
  // eslint-disable-next-line no-new-func
  const result = await new Function("env", `return (async () => (${example}))();`)({ Vote });
  return { calls, result };
}

describe("describeGadget()", () => {
  const d = fresh().describeGadget();

  it("is well formed and bounded", () => {
    expect(d).toMatchObject({ gadget: "format.ranked-vote", contract: 1 });
    expect(typeof d.summary).toBe("string");
    expect(d.operations.length).toBeGreaterThan(5);
    expect(d.operations.length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(d, null, 2).length).toBeLessThan(24_000);
    expect(Object.keys(d.adapt).toSorted()).toEqual(["client", "readme", "server"]);
    const names = d.operations.map((o) => o.name);
    expect(new Set(names).size).toBe(names.length);
    for (const op of d.operations) {
      expect(typeof Gadget.prototype[op.name], op.name).toBe("function");
      for (const key of ["description", "example", "returns"]) expect(typeof op[key], `${op.name}.${key}`).toBe("string");
      expect(op.input && typeof op.input === "object", `${op.name}.input`).toBe(true);
      expect(op.example, op.name).toMatch(new RegExp(`^await env\\.Vote\\.${op.name}\\(`));
    }
    // Convenience verbs first; people's own ballot operations are never offered.
    expect(names.slice(0, 4)).toEqual(["setUpVote", "proposeOptions", "fillInOption", "getResult"]);
    expect(names).not.toContain("saveRanking");
    expect(names).not.toContain("setReady");
  });

  for (const op of d.operations) {
    it(`example for ${op.name} satisfies its input and is accepted`, async () => {
      const g = await seeded();
      const { calls, result } = await runExample(op.example, g);
      expect(calls.map((c) => c.name)).toEqual([op.name]);
      const [arg] = calls[0].args;
      expect(validate(op.input, arg ?? {})).toEqual([]);
      expect(result?.error, JSON.stringify(result)).toBeUndefined();
    });
  }
});

describe("convenience verbs", () => {
  it("setUpVote validates everything before writing", async () => {
    const g = fresh();
    const bad = await g.setUpVote({ question: "Name?", fields: [{ label: "Proposed URL", kind: "url" }], options: ["One", { title: "Two", values: { "Proposd URL": "x" } }] });
    expect(bad.error).toMatch(/No field called “Proposd URL”/);
    const v = await g.getView("");
    expect(v.question).toBe("What should we call it?");
    expect(v.options).toEqual([]);
    expect(v.fields.map((f) => f.label)).toEqual(["Description"]);
    expect((await g.setUpVote({ options: ["One", "one"] })).error).toMatch(/listed twice/);
    expect((await g.setUpVote({ fields: [{ label: "X", kind: "number" }] })).error).toMatch(/kind/);
  });

  it("sets up, skips duplicates, fills in by label and reads the result by title", async () => {
    const g = fresh();
    const r = await g.setUpVote({
      question: "Offsite?", minVoters: 3,
      fields: [{ label: "Cost per head", kind: "text" }],
      options: [{ title: "Lake District", description: "Hills", values: { "Cost per head": "£200" } }, "Brighton"],
    });
    expect(r).toMatchObject({ question: "Offsite?", minVoters: 3, skipped: [] });
    expect(r.added.map((o) => o.title)).toEqual(["Lake District", "Brighton"]);
    const again = await g.proposeOptions({ options: ["brighton", "Cotswolds"] });
    expect(again.skipped).toEqual(["brighton"]);
    expect(again.added.map((o) => o.title)).toEqual(["Cotswolds"]);
    expect((await g.fillInOption({ option: "cotswolds", values: { "cost per head": "£150" } })).error).toBeUndefined();
    expect((await g.fillInOption({ option: "Cotswolds", values: { Price: "£1" } })).error).toMatch(/No field/);
    const v = await g.getView("");
    const field = v.fields.find((f) => f.label === "Cost per head");
    expect(v.options.map((o) => [o.title, o.values[field.id], o.by.name])).toEqual([
      ["Lake District", "£200", "Assistant"], ["Brighton", undefined, "Assistant"], ["Cotswolds", "£150", "Assistant"],
    ]);
    expect(v.options[0].values.description).toBe("Hills");

    const ids = v.options.map((o) => o.id);
    await g.setReady({ by: alice, ready: true, ranking: ids });
    await g.setReady({ by: bob, ready: true, ranking: ids.toReversed() });
    let res = await g.getResult();
    expect(res).toMatchObject({ phase: "open", votersNeeded: 1, waitingOn: [], latestCount: null });
    await g.setMinVoters({ minVoters: 2 });
    res = await g.getResult();
    expect(res.phase).toBe("closed");
    expect(res.latestCount.current).toBe(true);
    expect(res.latestCount.voters).toEqual(["Alice", "Bob"]);
    expect(Object.keys(res.latestCount.rounds[0].votes).toSorted()).toEqual(["Brighton", "Cotswolds", "Lake District"]);
    expect(JSON.stringify(res)).not.toMatch(/ranking/);
  });

  it("the Assistant never votes, and anyone may tidy the Assistant's options", async () => {
    const g = fresh();
    const { added } = await g.proposeOptions({ options: ["One", "Two"] });
    const ids = added.map((o) => o.id);
    expect((await g.saveRanking({ ranking: ids })).error).toMatch(/assistant cannot/);
    expect((await g.setReady({ ready: true, ranking: ids })).error).toMatch(/assistant cannot/);
    expect((await g.updateOption({ by: alice, optionId: "One", title: "Uno" })).error).toBeUndefined();
    expect((await g.withdrawOption({ by: bob, optionId: "Two" })).error).toBeUndefined();
    const own = await g.addOption({ by: alice, title: "Alice's" });
    expect((await g.withdrawOption({ optionId: own.option.id })).error).toMatch(/Only Alice/);
    expect((await g.getView("")).options.map((o) => o.title)).toEqual(["Uno", "Alice's"]);
  });
});

describe("evals", () => {
  const src = readFileSync(new URL("../../src/client/main.js", import.meta.url), "utf8");

  it("has use and adapt evals with references", () => {
    expect(evals.filter((e) => e.kind === "use").length).toBeGreaterThanOrEqual(2);
    expect(evals.filter((e) => e.kind === "adapt").length).toBeGreaterThanOrEqual(1);
    for (const e of evals) {
      expect(e.id).toMatch(/^[a-z0-9-]+$/);
      expect(typeof e.prompt).toBe("string");
      expect(typeof e.check).toBe("function");
      expect(e.reference?.code ?? e.reference?.edits).toBeTruthy();
    }
  });

  for (const e of evals.filter((x) => x.kind === "use")) {
    it(`${e.id}: the reference passes the check`, async () => {
      const t = { gadget: fresh(), files: {}, binding: "Vote" };
      await e.setup?.(t);
      // eslint-disable-next-line no-new-func
      await new Function("env", `return (async () => {\n${e.reference.code}\n})();`)({ Vote: t.gadget });
      expect(await e.check(t)).toEqual([]);
    });
    it(`${e.id}: an untouched vote fails the check`, async () => {
      const t = { gadget: fresh(), files: {}, binding: "Vote" };
      await e.setup?.(t);
      expect((await e.check(t)).length).toBeGreaterThan(0);
    });
  }

  for (const e of evals.filter((x) => x.kind === "adapt")) {
    it(`${e.id}: every reference edit finds its text exactly once in client.js`, () => {
      for (const edit of e.reference.edits) {
        expect(edit.file).toBe("client.js");
        expect(src.split(edit.find).length - 1).toBe(1);
      }
    });
  }
});
