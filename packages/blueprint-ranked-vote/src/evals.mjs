// Ranked Vote: requests an agent should be able to carry out with this gadget.
// Run: node scripts/blueprint-evals/run.mjs ranked-vote [--eval <id>] [--reference] [--model <m>]
//
// `setup(t)`, where present, seeds the vote before the agent (or the reference) runs: the people's
// own ballots, which no agent may cast. Checks judge outcomes and accept any reasonable route.

const alice = { id: "alice@example.com", name: "Alice" };
const bob = { id: "bob@example.com", name: "Bob" };
const cara = { id: "cara@example.com", name: "Cara" };
const dan = { id: "dan@example.com", name: "Dan" };

const fold = (/** @type {unknown} */ s) => String(s ?? "").toLocaleLowerCase("en").replace(/\s+/g, " ").trim();

/** @param {any} gadget @param {(view: any) => boolean} ok @param {number} ms */
async function waitForView(gadget, ok, ms = 5000) {
  const until = Date.now() + ms;
  let view = await gadget.getView("");
  while (!ok(view) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100));
    view = await gadget.getView("");
  }
  return view;
}

export default [
  {
    id: "set-up-offsite-vote",
    kind: "use",
    prompt: "Set up a vote on where to hold the team offsite: the Lake District, the Cotswolds or Brighton. " +
      "Add a cost per head for each place, and put £180 against the Lake District for now. There are five " +
      "of us, so the count shouldn't run until all five have voted.",
    reference: {
      code: 'return await env.Vote.setUpVote({ question: "Where should we hold the team offsite?", ' +
        'fields: [{ label: "Cost per head" }], ' +
        'options: [{ title: "Lake District", values: { "Cost per head": "£180" } }, "Cotswolds", "Brighton"], minVoters: 5 });',
    },
    /** @param {any} t */
    async check(t) {
      const v = await t.gadget.getView("");
      const problems = [];
      if (!/offsite|where|venue|place|location/i.test(v.question)) problems.push(`the question should be about the offsite, got "${v.question}"`);
      const place = (/** @type {string} */ name) => v.options.find((/** @type {any} */ o) => fold(o.title).replace(/^the /, "").includes(name));
      for (const name of ["lake district", "cotswolds", "brighton"]) if (!place(name)) problems.push(`no option for ${name}`);
      if (v.options.length !== 3) problems.push(`there should be 3 options, got ${JSON.stringify(v.options.map((/** @type {any} */ o) => o.title))}`);
      const field = v.fields.find((/** @type {any} */ f) => /cost|price|per head|£/i.test(f.label));
      if (!field) problems.push(`no cost-per-head field; fields are ${JSON.stringify(v.fields.map((/** @type {any} */ f) => f.label))}`);
      const lakes = place("lake district");
      if (field && lakes && !/180/.test(String(lakes.values[field.id] ?? ""))) problems.push(`the Lake District's ${field.label} should be £180, got "${lakes.values[field.id] ?? ""}"`);
      if (v.minVoters !== 5) problems.push(`the count should wait for 5 voters, but minVoters is ${v.minVoters}`);
      if (v.voters.length) problems.push(`nobody should have voted yet, but ${v.voters.map((/** @type {any} */ x) => x.name).join(", ")} did`);
      return problems;
    },
  },
  {
    id: "remove-away-voter-and-count",
    kind: "use",
    prompt: "Bob's on holiday and he's holding up our company-name vote. Take his ballot out so the count " +
      "can run, and tell me which name won.",
    /** Alice, Cara and Dan have clicked Reveal; Bob ranked but has not. @param {any} t */
    async setup(t) {
      const g = t.gadget;
      const r = await g.setUpVote({ by: alice, question: "What should we call the company?", options: ["Hoarse", "Lumen", "Tessel"] });
      const [h, l, te] = r.added.map((/** @type {any} */ o) => o.id);
      await g.saveRanking({ by: bob, ranking: [te, l, h] });
      await g.setReady({ by: alice, ready: true, ranking: [h, l, te] });
      await g.setReady({ by: cara, ready: true, ranking: [l, h, te] });
      await g.setReady({ by: dan, ready: true, ranking: [h, te, l] });
    },
    reference: {
      code: 'await env.Vote.removeBallot({ voterId: "Bob" });\nreturn (await env.Vote.getResult()).latestCount;',
    },
    /** @param {any} t */
    async check(t) {
      const r = await t.gadget.getResult();
      if (!r.options.length) return ["the vote was empty: this eval's setup(t) did not run before the agent"];
      const problems = [];
      if (r.voters.some((/** @type {any} */ x) => x.name === "Bob")) problems.push("Bob's ballot is still in the vote");
      for (const name of ["Alice", "Cara", "Dan"]) {
        if (!r.voters.some((/** @type {any} */ x) => x.name === name)) problems.push(`${name}'s ballot was removed too`);
      }
      if (!r.latestCount) problems.push(`no count ran (phase ${r.phase}, waiting on ${r.waitingOn.join(", ") || "nobody"})`);
      else if (r.latestCount.winner !== "Hoarse") problems.push(`the count should make Hoarse the winner, got ${r.latestCount.winner}`);
      return problems;
    },
  },
  {
    id: "add-reopen-nominations-button",
    kind: "adapt",
    prompt: "Add a button to the vote that adds \"Re-open nominations\" as an option, so people can rank " +
      "'none of these' above any name they'd rather not win.",
    reference: {
      edits: [{
        file: "client.js",
        find: "  actions: [\n  ],",
        replace: "  actions: [\n" +
          '    { id: "ron", label: "Add Re-open nominations", title: "Rank it above any option you would rather not win",\n' +
          '      run: (app) => app.proposeOption("Re-open nominations") },\n' +
          "  ],",
      }],
    },
    /** @param {any} t */
    async check(t) {
      const page = await t.client();
      const button = page.getByRole("button", { name: /re-?open nominations|\bRON\b|none of (these|the above)/i }).first();
      try {
        await button.waitFor({ state: "visible", timeout: 10_000 });
      } catch {
        return ["no visible button for re-open nominations in the vote"];
      }
      await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 10_000 }).catch(() => {});
      await button.click();
      const isRon = (/** @type {any} */ o) => /re-?open nominations|\bRON\b|none of (these|the above)/i.test(o.title);
      const view = await waitForView(t.gadget, (v) => v.options.some(isRon));
      if (!view.options.some(isRon)) return [`clicking the button added no re-open nominations option; options are ${JSON.stringify(view.options.map((/** @type {any} */ o) => o.title))}`];
      return [];
    },
  },
];
