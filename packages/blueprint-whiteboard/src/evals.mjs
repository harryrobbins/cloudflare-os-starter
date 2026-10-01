// Whiteboard: requests an agent should be able to carry out with this gadget.
// Run: node scripts/blueprint-evals/run.mjs whiteboard [--eval <id>] [--reference] [--model <m>]
// Package tests (test/core/evals.test.js) run every `use` reference and check the adapt edits apply.

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/** @param {any} o */
const centre = (o) => ({ x: o.x + o.w / 2, y: o.y + o.h / 2 });

/** Every object on the board. @param {any} gadget @returns {Promise<any[]>} */
async function objectsOf(gadget) {
  return Object.values((await gadget.getBoard()).objects);
}

/** Polls `fn` until it returns no problems, or returns its last problems. @param {() => Promise<string[]>} fn */
async function eventually(fn, ms = 8000) {
  const end = Date.now() + ms;
  let problems = await fn();
  while (problems.length && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 150));
    problems = await fn();
  }
  return problems;
}

export default [
  {
    id: "weekday-stickies",
    kind: "use",
    prompt: "Add one post-it note in a different colour for each day of the week, in a row.",
    reference: {
      code: `
const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const colors = ["yellow", "orange", "red", "pink", "purple", "blue", "green"];
const { created, errors } = await env.Whiteboard.addStickies({
  stickies: days.map((text, i) => ({ text, color: colors[i] })), columns: days.length, by: "Assistant",
});
if (errors.length) throw new Error(JSON.stringify(errors));
return created.map((o) => o.id);`,
    },
    /** @param {any} t */
    async check(t) {
      const problems = [];
      const notes = (await objectsOf(t.gadget)).filter((o) => o.type === "sticky");
      if (notes.length !== 7) problems.push(`expected 7 sticky notes, found ${notes.length}`);
      const byDay = DAYS.map((day) => {
        // Full or short names in any case: "Monday", "Mon", "TUES", "Thurs".
        const re = new RegExp(`\\b${day.slice(0, 3)}[a-z]*\\b`, "i");
        const matches = notes.filter((n) => re.test(n.text));
        if (matches.length !== 1) problems.push(`expected one note naming ${day}, found ${matches.length}`);
        return matches[0];
      });
      if (problems.length) return problems;
      const fills = new Set(byDay.map((n) => String(n.style?.fill).toLowerCase()));
      if (fills.size !== 7) problems.push(`expected 7 different colours, found ${fills.size}: ${[...fills].join(", ")}`);
      const cs = byDay.map(centre);
      const tallest = Math.max(...byDay.map((n) => n.h));
      const ys = cs.map((c) => c.y);
      if (Math.max(...ys) - Math.min(...ys) > tallest / 2) problems.push(`not one row: centres range over y ${Math.min(...ys)}..${Math.max(...ys)}`);
      for (let i = 1; i < 7; i++) {
        if (!(cs[i].x > cs[i - 1].x)) problems.push(`${DAYS[i]} is not to the right of ${DAYS[i - 1]}`);
      }
      return problems;
    },
  },

  {
    id: "tea-flow",
    kind: "use",
    prompt: "Draw a simple flow chart for making a cup of tea: boil the kettle, put a tea bag in a mug, pour in the water, " +
      "let it brew, then add milk. Connect each step to the next with an arrow.",
    reference: {
      code: `
const steps = ["Boil the kettle", "Put a tea bag in a mug", "Pour in the water", "Let it brew", "Add milk"];
const ids = steps.map((_, i) => "o_7ea000000" + String(i + 1).padStart(3, "0"));
const { errors } = await env.Whiteboard.addObjects({
  objects: steps.map((text, i) => ({ type: "rect", id: ids[i], x: i * 320, y: 0, w: 240, h: 120, text, color: "blue" })),
  by: "Assistant",
});
if (errors.length) throw new Error(JSON.stringify(errors));
for (let i = 1; i < ids.length; i++) {
  const r = await env.Whiteboard.connectObjects({ from: ids[i - 1], to: ids[i], by: "Assistant" });
  if (r.errors.length) throw new Error(JSON.stringify(r.errors));
}`,
    },
    /** @param {any} t */
    async check(t) {
      const all = await objectsOf(t.gadget);
      const connectors = all.filter((o) => o.type === "connector");
      const nodes = all.filter((o) => o.type !== "connector" && o.type !== "frame");
      // Each object counts for the first step it names, so "Pour the boiling water" is the pour step.
      const steps = [
        { name: "pour", re: /pour/i }, { name: "tea bag", re: /\bbag/i }, { name: "brew", re: /brew|steep|infuse/i },
        { name: "milk", re: /milk/i }, { name: "boil", re: /kettle|boil/i },
      ];
      /** @type {Record<string, Set<string>>} */
      const ids = Object.fromEntries(steps.map((s) => [s.name, new Set()]));
      for (const n of nodes) {
        const step = steps.find((s) => s.re.test(n.text));
        if (step) ids[step.name].add(n.id);
      }
      const order = ["boil", "tea bag", "pour", "brew", "milk"];
      const problems = order.filter((s) => ids[s].size === 0).map((s) => `no object for the "${s}" step`);
      if (problems.length) return problems;
      // An arrow from one step to the next: a connector either way round whose arrowhead points forwards.
      const linked = (/** @type {Set<string>} */ a, /** @type {Set<string>} */ b) => connectors.some((c) =>
        (a.has(c.from) && b.has(c.to) && c.style?.arrowEnd !== "none") || (b.has(c.from) && a.has(c.to) && c.style?.arrowStart === "arrow"));
      for (let i = 1; i < order.length; i++) {
        if (!linked(ids[order[i - 1]], ids[order[i]])) problems.push(`no arrow from the "${order[i - 1]}" step to the "${order[i]}" step`);
      }
      return problems;
    },
  },

  {
    id: "sort-stickies-command",
    kind: "adapt",
    prompt: "Add a command called \"Sort sticky notes\" to the whiteboard's menu that lines all the sticky notes up in a grid, " +
      "in alphabetical order.",
    reference: {
      edits: [{
        file: "client.js",
        find: "  ],\n  onReady(app) {},",
        replace: `    { id: "sort-stickies", label: "Sort sticky notes", title: "Line the sticky notes up in alphabetical order", run(app) {
      const notes = app.findObjects({ type: "sticky" })
        .sort((a, b) => a.text.localeCompare(b.text, undefined, { sensitivity: "base" }));
      app.arrangeGrid({ ids: notes.map((n) => n.id) });
      app.toast(\`Sorted \${notes.length} sticky notes\`);
    } },
  ],
  onReady(app) {},`,
      }],
    },
    /** @param {any} t */
    async check(t) {
      const texts = ["Pear", "apple", "Mango", "banana", "Cherry", "kiwi"];
      const { errors } = await t.gadget.addObjects({
        objects: texts.map((text, i) => ({ type: "sticky", text, x: (i * 437) % 1200, y: (i * 611) % 900 })),
      });
      if (errors.length) return [`could not set up the board: ${JSON.stringify(errors)}`];
      const page = await t.client();
      await page.locator('.conn[data-state="live"]').waitFor({ timeout: 15_000 });
      await page.getByRole("button", { name: "Board menu" }).click();
      const item = page.getByRole("menuitem", { name: /sort sticky notes/i });
      if (!(await item.count())) {
        const labels = await page.getByRole("menuitem").allTextContents();
        return [`the board menu has no "Sort sticky notes" command (it has: ${labels.join(", ")})`];
      }
      await item.first().click();
      const expected = [...texts].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
      return eventually(async () => {
        const notes = (await objectsOf(t.gadget)).filter((o) => o.type === "sticky");
        if (notes.length !== texts.length) return [`expected ${texts.length} sticky notes, found ${notes.length}`];
        // Reading order: rows by centre y (within half a note), then x.
        /** @type {any[][]} */
        const rows = [];
        for (const n of [...notes].sort((a, b) => centre(a).y - centre(b).y)) {
          const row = rows.at(-1);
          if (row && Math.abs(centre(row[0]).y - centre(n).y) <= n.h / 2) row.push(n);
          else rows.push([n]);
        }
        const reading = rows.flatMap((r) => r.sort((a, b) => centre(a).x - centre(b).x)).map((n) => n.text);
        const problems = [];
        if (rows.length < 2 && notes.length > 3) problems.push("not a grid: all the notes are in one row");
        if (rows.slice(0, -1).some((r) => r.length !== rows[0].length)) problems.push("the grid's full rows differ in length");
        if (reading.join("|") !== expected.join("|")) problems.push(`reading order is ${reading.join(", ")}, not ${expected.join(", ")}`);
        const overlap = notes.some((a, i) => notes.some((b, j) => j > i && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));
        if (overlap) problems.push("some notes overlap");
        return problems;
      });
    },
  },
];
