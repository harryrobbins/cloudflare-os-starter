// Every recipe in src/SKILL.md, run verbatim as the in-Workshop agent would (an executeCode body
// with `env.WorkBoard`), against the same gadget server and seeded datastore the harness serves.
// Also checks the data dictionary is current and the README links the skill.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FakeRecords } from "./fake-records.js";
import { createFakeJev } from "./fake-jev.js";
import { SEED_PEOPLE, seedWork } from "../harness/seed.js";
import { createGadgetApi } from "../src/server/api.js";
import { memoryStorage } from "../src/server/documents.js";
import { withDictionary } from "../scripts/skill-dictionary.mjs";

const SKILL = readFileSync(new URL("../src/SKILL.md", import.meta.url), "utf8");
const README = readFileSync(new URL("../src/README.md", import.meta.url), "utf8");
const NOW = Date.parse("2026-09-26T12:00:00Z");
const AsyncFunction = /** @type {any} */ (async function () {}).constructor;

/** The recipes: every js block whose first line is "// Recipe: <name>". */
export function recipes(text = SKILL) {
  return [...text.matchAll(/```js\n\/\/ Recipe: ([^\n]+)\n([\s\S]*?)```/g)].map((m) => ({ name: m[1].trim(), code: m[2] }));
}

/** @param {{ jev?: boolean }} [o] */
async function board(o = {}) {
  const fake = new FakeRecords({ now: () => NOW });
  seedWork(fake, { items: 300, now: NOW });
  const env = { RECORDS: fake.session(), ...(o.jev === false ? {} : { JEV: createFakeJev() }) };
  const api = createGadgetApi({ getEnv: () => env, storage: memoryStorage(), now: () => NOW });
  for (const p of SEED_PEOPLE) await api.rememberViewer(p);
  // What the agent sees: plain JSON over RPC (structured clone), not live objects.
  const WorkBoard = new Proxy({}, { get: (_t, m) => async (/** @type {any[]} */ ...args) => structuredClone(await /** @type {any} */ (api)[m](...structuredClone(args))) });
  return { api, env: { WorkBoard }, fake };
}
/** @param {{ code: string }} r @param {any} env */
const run = (r, env) => new AsyncFunction("env", r.code)(env);

describe("SKILL.md", () => {
  it("has the eight recipes the brief asks for", () => {
    expect(recipes().map((r) => r.name)).toEqual([
      "blocking the current cycle", "who is overloaded", "burndown for a named cycle", "custom chart from a dataset",
      "check WQL before using it", "triage with proposals", "break an item into sub-issues", "re-prioritise a cycle",
    ]);
  });

  it("documents every dataset (the dictionary is generated and current) and README links it", () => {
    expect(withDictionary(SKILL)).toBe(SKILL);
    expect(README).toMatch(/\[SKILL\.md\]\(SKILL\.md\)/);
  });

  it("every WQL example in the table parses and runs", async () => {
    const { api } = await board();
    const table = SKILL.slice(SKILL.indexOf("| Request | WQL |"), SKILL.indexOf("\n\n", SKILL.indexOf("| Request | WQL |")));
    const rows = [...table.matchAll(/^\| [^|]+ \| `([^`]+)` \|$/gm)].map((m) => m[1]);
    expect(rows.length).toBe(10);
    for (const q of rows) {
      const d = await api.describeQuery(q);
      expect(d.errors, q).toEqual([]);
      await api.query(q);
    }
  });
});

describe("recipes run verbatim", () => {
  const byName = Object.fromEntries(recipes().map((r) => [r.name, r]));

  it("what's blocking the current cycle", async () => {
    const { env } = await board();
    const out = await run(byName["blocking the current cycle"], env);
    expect(out.answer).toMatch(/blocked|Nothing/);
    expect(Array.isArray(out.blockers)).toBe(true);
    for (const b of out.blockers) expect(b.key).toMatch(/^TW-\d+$/);
  });

  it("who is overloaded", async () => {
    const { env } = await board();
    const out = await run(byName["who is overloaded"], env);
    expect(out.summary).toMatch(/has the most/);
    expect(out.everyone.length).toBeGreaterThan(1);
    expect(out.everyone.every((p) => !p.person.includes("@"))).toBe(true);
  });

  it("burndown for a named cycle saves a valid report", async () => {
    const { env, api } = await board();
    const out = await run(byName["burndown for a named cycle"], env);
    expect(out.summary).toMatch(/Cycle \d+|Scope/);
    const saved = (await api.listReports()).find((r) => r.id === out.saved);
    expect(saved?.dataset).toBe("cycle_burndown");
    const data = await api.insights({ reports: [{ id: saved.id, dataset: saved.dataset, params: saved.params }] });
    expect(data.results[saved.id].error).toBeNull();
  });

  it("custom chart from a dataset validates and saves", async () => {
    const { env, api } = await board();
    const out = await run(byName["custom chart from a dataset"], env);
    expect(out).toMatchObject({ saved: "open-by-priority-and-state", version: 1 });
    expect((await api.listReports()).some((r) => r.id === out.saved)).toBe(true);
  });

  it("check WQL before using it", async () => {
    const { env } = await board();
    const out = await run(byName["check WQL before using it"], env);
    expect(out.understood_as).toMatch(/Grace Hopper/);
    expect(typeof out.total).toBe("number");
  });

  for (const jev of [true, false]) {
    it(`triage with proposals (${jev ? "with" : "without"} Jev)`, async () => {
      const { env, api, fake } = await board({ jev });
      const out = await run(byName["triage with proposals"], env);
      expect(out.proposal).toMatch(/^p-/);
      expect(out.changes.length).toBeGreaterThan(5);
      const p = await api.getProposal(out.proposal);
      expect(p.proposed_by.kind).toBe("agent");
      const triaged = [...fake.rows.values()].filter((r) => r.entity === "work_item" && r.data.state === "triage" && !r.data.archived).length;
      expect(p.changes.length).toBe(Math.min(20, triaged));
    });
  }

  it("break an item into sub-issues", async () => {
    const { env, api } = await board();
    const out = await run(byName["break an item into sub-issues"], env);
    const p = await api.getProposal(out.proposal);
    expect(p.changes).toHaveLength(4);
    expect(p.changes.every((c) => c.command === "work.create" && c.text.startsWith("New sub-issue under TW-"))).toBe(true);
  });

  it("re-prioritise a cycle", async () => {
    const { env, api } = await board();
    const out = await run(byName["re-prioritise a cycle"], env);
    if (typeof out === "string") { expect(out).toMatch(/already match/); return; }
    const p = await api.getProposal(out.proposal);
    expect(p.changes.every((c) => c.command === "work.update" && /priority/.test(c.text))).toBe(true);
  });
});
