import { describe, expect, it } from "vitest";
import { buildTriageRequest, overlap, readSuggestions, similarItems, suggestionsToChanges, tokens } from "../../src/shared/insights/triage.js";
import { FakeRecords } from "../fake-records.js";
import { buildIndex } from "../../src/shared/model/index.js";

const ADA = "cloudflare-os:ada@example.com";
function board() {
  const fake = new FakeRecords({ now: () => Date.parse("2026-09-26T12:00:00Z") });
  for (const [key, name, description] of [["bug", "Bug", "Something is broken"], ["docs", "Docs", "Documentation"], ["perf", "Performance", "Speed"]]) fake.run("work.label.create", { key, name, description }, { actor: ADA });
  fake.run("work.create", { title: "Login redirect loops on Safari", state: "todo", priority: 3 }, { actor: ADA });
  fake.run("work.create", { title: "Login redirect loops in Safari after reset", state: "triage", description: "Users are stuck on the login page." }, { actor: ADA });
  fake.run("work.create", { title: "Write the onboarding guide", state: "backlog", labels: ["docs"] }, { actor: ADA });
  return buildIndex(fake.rows.values(), { planning: true, keyPrefix: "WRK" });
}

const sug = (/** @type {any} */ x) => ({ key: "WRK-2", confidence: "95% likely", probability: 0.95, preselect: true, id: x.field, ...x });

describe("triage request", () => {
  it("finds similar open items by word overlap", () => {
    const ix = board();
    expect(overlap(tokens("Login redirect loops"), tokens("login redirect"))).toBeCloseTo(2 / 3);
    const two = /** @type {any} */ (ix.byNumber.get(2));
    expect(similarItems(ix, two).map((s) => s.item.key)).toEqual(["WRK-1"]);
  });

  it("asks priority, state, one question per candidate label, and duplicate among similar items", () => {
    const ix = board();
    const item = /** @type {any} */ (ix.byNumber.get(2));
    const { request, meta } = buildTriageRequest(ix, item);
    expect(Object.keys(request.questions)).toEqual(["priority", "state", "label_0", "label_1", "label_2", "duplicate"]);
    expect(request.questions.priority.criteria).toHaveProperty("urgent");
    expect(Object.values(request.questions.state.criteria)).toEqual(expect.arrayContaining([expect.stringMatching(/^Backlog: /), expect.stringMatching(/^Canceled: /)]));
    expect(request.questions.duplicate.criteria.d0).toMatch(/WRK-1/);
    expect(request.state.item).toMatchObject({ key: "WRK-2", state: "Triage", priority: "No priority" });
    expect(meta.similar).toEqual(["WRK-1"]);
    expect(meta.labels.toSorted()).toEqual(["bug", "docs", "perf"]);
    expect(meta.labels[0]).toBe("docs"); // used on the board already
  });

  it("reads bands: ≥0.9 preselected, 0.5–0.9 shown, <0.5 hidden; unchanged values are not suggested", () => {
    const ix = board();
    const item = /** @type {any} */ (ix.byNumber.get(2));
    const { meta } = buildTriageRequest(ix, item);
    const todo = meta.candidates.indexOf("todo");
    const { suggestions, hidden } = readSuggestions(ix, item, meta, {
      priority: { type: "choice", choice: "high", probabilities: { high: 0.93, medium: 0.07 }, confidence: 0.86 },
      state: { type: "choice", choice: `s${todo}`, probabilities: { [`s${todo}`]: 0.7 }, confidence: 0.4 },
      [`label_${meta.labels.indexOf("bug")}`]: { type: "noul", noul: 0.95 }, [`label_${meta.labels.indexOf("docs")}`]: { type: "noul", noul: 0.2 },
      [`label_${meta.labels.indexOf("perf")}`]: { type: "noul", noul: 0.49 },
      duplicate: { type: "choice", choice: "d0", probabilities: { d0: 0.55, none: 0.45 }, confidence: 0.1 },
    });
    expect(suggestions.map((s) => [s.text, s.preselect, s.confidence])).toEqual([
      ["Add label Bug", true, "95% likely"], ["Priority No priority → High", true, "93% likely"],
      ["State Triage → Todo", false, "70% likely"], ["Duplicate of WRK-1", false, "55% likely"],
    ]);
    expect(hidden).toBe(2);
    const same = readSuggestions(ix, item, meta, { priority: { type: "choice", choice: "none", probabilities: { none: 0.99 } } });
    expect(same.suggestions).toEqual([]);
  });

  it("turns chosen suggestions into one update per item plus a duplicates relation", () => {
    expect(suggestionsToChanges([
      sug({ field: "priority", value: "high", text: "Priority → High" }), sug({ field: "label", value: "Bug", text: "Add label Bug" }),
      sug({ field: "label", value: "Docs", text: "Add label Docs" }), sug({ field: "duplicate", value: "WRK-1", text: "Duplicate of WRK-1" }),
    ])).toEqual([
      { command: "work.update", input: { id: "WRK-2", priority: "high", labels_add: ["Bug", "Docs"] }, reason: "Jev: Priority → High (95% likely); Add label Bug (95% likely); Add label Docs (95% likely)" },
      { command: "work.relation.create", input: { from: "WRK-2", to: "WRK-1", kind: "duplicates" }, reason: "Jev: Duplicate of WRK-1 (95% likely)" },
    ]);
  });
});
