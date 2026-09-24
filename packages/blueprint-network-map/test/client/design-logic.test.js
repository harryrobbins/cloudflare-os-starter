import { describe, it, expect } from "vitest";
import { buildGraphIndex, cleanRule } from "../../src/shared/rules.js";
import { demoMap } from "../../src/shared/demo.js";
import {
  OP_LABELS, opsForKind, subjectKey, subjectFromKey, subjectKind, subjectLabel, subjectOptions,
  categorySubjectOptions, numberSubjectOptions, valueOptions, conditionFor, withOp,
  emptySelectorState, stateFromSelector, selectorFromState, predicateFromCondition, matchCount,
  emptyDecorationState, stateFromDecoration, decorationFromState, emptyRuleState, stateFromRule,
  ruleFromState, retarget, describeDecoration, describeRule, moveItem, replaceRule, typeUsage,
  fieldUsage, choiceUsage, blockedChoiceRemovals, nextTypeColor, copyLayoutMoves, duplicateView, copyName,
} from "../../src/client/ui/design-logic.js";

const F = { sector: "f_000000000001", influence: "f_000000000002", since: "f_000000000003", flag: "f_00000000000a", tags: "f_00000000000b", note: "f_00000000000c", weight: "f_00000000000d" };
const T = { actor: "t_000000000001", resource: "t_000000000002", outcome: "t_000000000003", supports: "t_000000000004" };

/** The demo map plus a few extra fields covering every field kind. */
function index() {
  const { objects } = demoMap();
  const extra = [
    { id: F.flag, name: "Funded", kind: "bool", appliesTo: "element" },
    { id: F.tags, name: "Themes", kind: "multichoice", appliesTo: "both", choices: ["food", "land"] },
    { id: F.note, name: "Note", kind: "text", appliesTo: "both" },
    { id: F.weight, name: "Weight", kind: "number", appliesTo: "connection" },
  ];
  const g = buildGraphIndex([...objects, ...extra]);
  const e1 = g.elements.get("e_000000000001");
  g.elements.set(e1.id, { ...e1, fields: { ...e1.fields, [F.tags]: ["food"], [F.flag]: true } });
  return g;
}

/** editor state -> rule -> cleanRule -> editor state */
function roundTrip(state, g) {
  const built = ruleFromState(state, g);
  if ("error" in built) throw new Error(built.error);
  const cleaned = cleanRule(JSON.parse(JSON.stringify(built.value)));
  if ("error" in cleaned) throw new Error(cleaned.error);
  expect(cleaned.value).toEqual(built.value);
  return stateFromRule(cleaned.value);
}

const withDeco = (target, patch, extra = {}) => {
  const s = emptyRuleState(target);
  return { ...s, ...extra, deco: { ...s.deco, ...patch } };
};

describe("subjects", () => {
  const g = index();
  it("round-trips subject keys", () => {
    for (const s of [{ k: "label" }, { k: "type" }, { k: "tag" }, { k: "origin" }, { k: "direction" }, { k: "polarity" }, { k: "id" }, { k: "field", id: F.sector }, { k: "metric", id: "indegree" }]) {
      expect(subjectFromKey(subjectKey(s))).toEqual(s);
    }
  });
  it("gives each subject a value kind", () => {
    expect(subjectKind("label", g)).toBe("text");
    expect(subjectKind("tag", g)).toBe("text");
    expect(subjectKind("type", g)).toBe("type");
    expect(subjectKind("origin", g)).toBe("enum");
    expect(subjectKind("polarity", g)).toBe("enum");
    expect(subjectKind("metric:degree", g)).toBe("number");
    expect(subjectKind(`field:${F.influence}`, g)).toBe("number");
    expect(subjectKind(`field:${F.since}`, g)).toBe("date");
    expect(subjectKind(`field:${F.sector}`, g)).toBe("choice");
    expect(subjectKind(`field:${F.tags}`, g)).toBe("choice");
    expect(subjectKind(`field:${F.flag}`, g)).toBe("bool");
    expect(subjectKind(`field:${F.note}`, g)).toBe("text");
    expect(subjectKind("field:f_999999999999", g)).toBe("text");
    expect(subjectLabel("field:f_999999999999", g)).toBe("Missing field");
    expect(subjectLabel("metric:outdegree", g)).toBe("Outgoing connections");
  });
  it("offers only subjects that apply to the target", () => {
    const el = subjectOptions("element", g).map((o) => o.key);
    const co = subjectOptions("connection", g).map((o) => o.key);
    expect(el).toContain("metric:degree");
    expect(el).not.toContain("direction");
    expect(el).toContain(`field:${F.sector}`);
    expect(el).not.toContain(`field:${F.weight}`);
    expect(co).toContain("direction");
    expect(co).toContain("polarity");
    expect(co).not.toContain("metric:degree");
    expect(co).toContain(`field:${F.weight}`);
    expect(co).toContain(`field:${F.tags}`);
    expect(co).not.toContain(`field:${F.sector}`);
    expect(numberSubjectOptions("element", g).map((o) => o.key)).toEqual([`field:${F.influence}`, "metric:degree", "metric:indegree", "metric:outdegree"]);
    expect(numberSubjectOptions("connection", g).map((o) => o.key)).toEqual([`field:${F.weight}`]);
    const cat = categorySubjectOptions("element", g).map((o) => o.key);
    expect(cat).toContain("type");
    expect(cat).toContain(`field:${F.sector}`);
    expect(cat).not.toContain(`field:${F.influence}`);
    expect(cat).not.toContain("label");
  });
  it("lists sensible operators per kind", () => {
    expect(opsForKind("number")).toEqual(["lt", "le", "gt", "ge", "eq", "ne", "exists", "missing"]);
    expect(opsForKind("text")).toEqual(["eq", "ne", "contains", "in", "exists", "missing"]);
    expect(opsForKind("type")).toContain("in");
    expect(opsForKind("type")).not.toContain("lt");
    expect(opsForKind("choice")).not.toContain("contains");
    expect(opsForKind("bool")).not.toContain("in");
    for (const kind of ["number", "date", "text", "type", "choice", "enum", "bool"]) for (const op of opsForKind(kind)) expect(OP_LABELS[op]).toBeTruthy();
  });
  it("offers values for types, choices, booleans and enums", () => {
    expect(valueOptions("type", g, "element").map((o) => o.label)).toEqual(["Actor", "Outcome", "Resource"]);
    expect(valueOptions("type", g, "connection").map((o) => o.label)).toEqual(["Supports", "Undermines"]);
    expect(valueOptions(`field:${F.sector}`, g, "element").map((o) => o.value)).toEqual(["Public", "Private", "Community"]);
    expect(valueOptions(`field:${F.flag}`, g, "element").map((o) => o.value)).toEqual(["true", "false"]);
    expect(valueOptions("polarity", g, "connection").map((o) => o.value)).toEqual(["+", "-", "unknown"]);
    expect(valueOptions("label", g, "element")).toBeNull();
  });
  it("starts a condition with a sensible operator and value", () => {
    expect(conditionFor("label", g, "element")).toEqual({ subject: "label", op: "contains", value: "" });
    expect(conditionFor("metric:degree", g, "element")).toEqual({ subject: "metric:degree", op: "ge", value: "" });
    expect(conditionFor(`field:${F.sector}`, g, "element")).toEqual({ subject: `field:${F.sector}`, op: "eq", value: "Public" });
    expect(conditionFor("type", g, "element").value).toBe(T.actor);
  });
  it("converts values when the operator changes to and from a list", () => {
    const c = { subject: "label", op: "eq", value: "Farm" };
    expect(withOp(c, "in")).toEqual({ subject: "label", op: "in", value: ["Farm"] });
    expect(withOp(withOp(c, "in"), "ne")).toEqual({ subject: "label", op: "ne", value: "Farm" });
    expect(withOp({ subject: "label", op: "eq", value: "" }, "in").value).toEqual([]);
  });
});

describe("selectors", () => {
  const g = index();
  it("builds, validates and counts", () => {
    const state = { target: "element", match: "all", conditions: [{ subject: `field:${F.sector}`, op: "eq", value: "Public" }] };
    const sel = selectorFromState(state, g);
    expect(sel).toEqual({ value: { target: "element", match: "all", where: [{ subject: { k: "field", id: F.sector }, op: "eq", value: "Public" }] } });
    expect(matchCount(sel.value, g)).toBe(4);
    expect(stateFromSelector(sel.value)).toEqual(state);
    expect(matchCount(selectorFromState(emptySelectorState("connection"), g).value, g)).toBe(22);
  });
  it("types numbers, booleans and lists", () => {
    expect(predicateFromCondition({ subject: "metric:degree", op: "ge", value: "3" }, g).value.value).toBe(3);
    expect(predicateFromCondition({ subject: `field:${F.flag}`, op: "eq", value: "true" }, g).value.value).toBe(true);
    expect(predicateFromCondition({ subject: "label", op: "in", value: "a, b ,,c" }, g).value.value).toEqual(["a", "b", "c"]);
    expect(predicateFromCondition({ subject: "polarity", op: "in", value: ["+", "-"] }, g).value.value).toEqual(["+", "-"]);
    expect(predicateFromCondition({ subject: `field:${F.influence}`, op: "in", value: ["1"] }, g).error).toMatch(/does not apply/);
  });
  it("explains bad conditions", () => {
    const bad = (c) => selectorFromState({ target: "element", match: "all", conditions: [c] }, g);
    expect(bad({ subject: "metric:degree", op: "ge", value: "x" }).error).toBe("Condition 1: Connections needs a number");
    expect(bad({ subject: "label", op: "eq", value: " " }).error).toBe("Condition 1: Label needs a value");
    expect(bad({ subject: "type", op: "in", value: [] }).error).toMatch(/at least one value/);
    expect(bad({ subject: "type", op: "lt", value: T.actor }).error).toMatch(/does not apply/);
    expect(bad({ subject: `field:${F.since}`, op: "ge", value: "2020" }).error).toMatch(/date/);
    expect(selectorFromState({ target: "element", match: "all", conditions: Array(17).fill({ subject: "label", op: "exists", value: "" }) }, g).error).toMatch(/At most 16/);
    expect(selectorFromState({ target: "element", match: "all", conditions: [{ subject: "direction", op: "eq", value: "directed" }] }, g).error).toMatch(/connections only/);
  });
  it("matches any", () => {
    const sel = selectorFromState({ target: "element", match: "any", conditions: [{ subject: "type", op: "eq", value: T.outcome }, { subject: "type", op: "eq", value: T.resource }] }, g).value;
    expect(matchCount(sel, g)).toBe(10);
  });
});

describe("rule round trips (editor state -> rule -> cleanRule -> editor state)", () => {
  const g = index();
  const subjectsEl = subjectOptions("element", g).map((o) => o.key);
  const subjectsCo = subjectOptions("connection", g).map((o) => o.key);
  /** A valid condition for every subject and every operator it offers. */
  const conditions = (target, keys) => keys.flatMap((key) => {
    const kind = subjectKind(key, g);
    const opts = valueOptions(key, g, target);
    const sample = opts?.length ? opts[opts.length - 1].value : kind === "number" ? "2.5" : kind === "date" ? "2012-04-01" : "Farm";
    return opsForKind(kind).map((op) => ({ subject: key, op, value: op === "in" ? (opts?.length ? opts.map((o) => o.value) : [sample, kind === "number" ? "7" : "Two"]) : op === "exists" || op === "missing" ? "" : sample }));
  });

  for (const [target, keys] of [["element", subjectsEl], ["connection", subjectsCo]]) {
    it(`every subject and operator for ${target}s`, () => {
      const all = conditions(target, keys);
      for (let i = 0; i < all.length; i += 16) {
        const state = { ...emptyRuleState(target), conditions: all.slice(i, i + 16), match: i % 32 ? "any" : "all", deco: { ...emptyRuleState(target).deco, hidden: "hide" } };
        expect(roundTrip(state, g)).toEqual(state);
      }
    });
  }

  const cases = {
    element: [
      { color: { ...emptyDecorationState("element").color, mode: "fixed", value: "#e15759" } },
      { color: { ...emptyDecorationState("element").color, mode: "category", subject: `field:${F.sector}` } },
      { color: { ...emptyDecorationState("element").color, mode: "category", subject: "type" } },
      { color: { ...emptyDecorationState("element").color, mode: "category", subject: "tag" } },
      { color: { ...emptyDecorationState("element").color, mode: "number", subject: `field:${F.influence}`, from: "#ffffff", to: "#000000" } },
      { color: { ...emptyDecorationState("element").color, mode: "number", subject: "metric:indegree" } },
      { size: { ...emptyDecorationState("element").size, mode: "fixed", value: 12.5 } },
      { size: { ...emptyDecorationState("element").size, mode: "number", subject: `field:${F.influence}`, min: 4, max: 16, scale: "sqrt" } },
      { size: { ...emptyDecorationState("element").size, mode: "number", subject: "metric:degree", min: 2, max: 30, scale: "log" } },
      { shape: "hexagon" },
      { label: "none" }, { label: "label" }, { label: `field:${F.sector}` },
      { hidden: "hide" }, { hidden: "show" },
      { opacity: 0.35 }, { opacity: 0 },
      { border: "#112233" },
    ],
    connection: [
      { color: { ...emptyDecorationState("connection").color, mode: "fixed", value: "#59a14f" } },
      { color: { ...emptyDecorationState("connection").color, mode: "category", subject: "polarity" } },
      { color: { ...emptyDecorationState("connection").color, mode: "number", subject: `field:${F.weight}` } },
      { size: { ...emptyDecorationState("connection").size, mode: "fixed", value: 0.5 } },
      { size: { ...emptyDecorationState("connection").size, mode: "number", subject: `field:${F.weight}`, min: 1, max: 20, scale: "linear" } },
      { arrow: "none" }, { arrow: "auto" }, { curved: "yes" }, { curved: "no" },
      { label: `field:${F.note}` }, { hidden: "show" }, { opacity: 1 },
    ],
  };
  for (const [target, list] of Object.entries(cases)) {
    for (const patch of list) {
      it(`${target} decoration ${JSON.stringify(patch)}`, () => {
        const state = withDeco(target, patch, { name: "My rule", conditions: [{ subject: "type", op: "ne", value: valueOptions("type", g, target)[0].value }] });
        expect(roundTrip(state, g)).toEqual(state);
        const off = { ...state, off: true };
        expect(roundTrip(off, g)).toEqual(off);
      });
    }
  }
  it("every decoration at once", () => {
    const e = withDeco("element", { ...Object.assign({}, ...cases.element.filter((p) => !p.hidden && p.opacity !== 0 && !p.label)), label: "none", hidden: "hide", opacity: 0.5 });
    expect(roundTrip(e, g)).toEqual(e);
    const c = withDeco("connection", { ...Object.assign({}, ...cases.connection), curved: "no" });
    expect(roundTrip(c, g)).toEqual(c);
  });
  it("round-trips the demo's stored rules (rule -> state -> rule)", () => {
    for (const v of demoMap().objects.filter((o) => o.id[0] === "v")) {
      for (const rule of v.rules) {
        const clean = cleanRule(rule).value;
        expect(ruleFromState(stateFromRule(clean), g).value).toEqual(clean);
      }
    }
  });
  it("leaves decorations for the other target out", () => {
    const d = { ...emptyDecorationState("element"), shape: "square", border: "#000000", arrow: "none", curved: "yes" };
    expect(decorationFromState(d, "element")).toEqual({ shape: "square", border: "#000000" });
    expect(decorationFromState(d, "connection")).toEqual({ arrow: "none", curved: true });
  });
  it("refuses empty and out-of-range decorations with a message", () => {
    expect(ruleFromState(emptyRuleState("element"), g).error).toMatch(/at least one thing/);
    expect(ruleFromState(withDeco("element", { size: { ...emptyDecorationState("element").size, mode: "fixed", value: 500 } }), g).error).toBe("Size must be a number from 1 to 100");
    expect(ruleFromState(withDeco("connection", { size: { ...emptyDecorationState("connection").size, mode: "number", subject: `field:${F.weight}`, min: 0, max: 3 } }), g).error).toMatch(/Width range/);
    expect(ruleFromState(withDeco("element", { size: { ...emptyDecorationState("element").size, mode: "number", subject: "label" } }), g).error).toMatch(/number to follow/);
    expect(ruleFromState(withDeco("element", { color: { ...emptyDecorationState("element").color, mode: "fixed", value: "red" } }), g).error).toMatch(/#rrggbb/);
    expect(ruleFromState(withDeco("element", { opacity: 3 }), g).error).toMatch(/Opacity/);
  });
  it("retargets, dropping what does not apply", () => {
    const s = withDeco("element", { shape: "square", border: "#000000", label: `field:${F.sector}`, color: { ...emptyDecorationState("element").color, mode: "category", subject: `field:${F.sector}` } },
      { conditions: [{ subject: "type", op: "exists", value: "" }, { subject: "metric:degree", op: "ge", value: "2" }, { subject: `field:${F.tags}`, op: "exists", value: "" }] });
    const c = retarget(s, "connection", g);
    expect(c.conditions.map((x) => x.subject)).toEqual(["type", `field:${F.tags}`]);
    expect(c.deco.shape).toBe("");
    expect(c.deco.border).toBe("");
    expect(c.deco.label).toBe("");
    expect(c.deco.color.mode).toBe("none");
    expect(retarget(s, "element", g)).toBe(s);
  });
});

describe("summaries", () => {
  const g = index();
  it("describes decorations", () => {
    expect(describeDecoration({ color: { byCategory: { k: "field", id: F.sector } } }, "element", g)).toBe("Colour by Sector");
    expect(describeDecoration({ size: { byNumber: { k: "field", id: F.influence }, range: [4, 16], scale: "linear" } }, "element", g)).toBe("Size 4–16 by Influence");
    expect(describeDecoration({ width: { byNumber: { k: "field", id: F.weight }, range: [1, 6], scale: "log" } }, "connection", g)).toBe("Width 1–6 by Weight (log)");
    expect(describeDecoration({ hidden: true }, "element", g)).toBe("Hide");
    expect(describeDecoration({ color: { value: "#e15759" }, opacity: 0.5, shape: "square" }, "element", g)).toBe("Colour #e15759, Shape square, Opacity 50%");
    expect(describeDecoration({ arrow: "none", curved: true, label: "none" }, "connection", g)).toBe("No label, No arrows, Curved");
    expect(describeDecoration({}, "element", g)).toBe("No changes");
  });
  it("describes rules with their name or effect", () => {
    const rule = { selector: { target: "element", match: "all", where: [{ subject: { k: "type" }, op: "eq", value: T.actor }] }, set: { hidden: true } };
    expect(describeRule(rule, g)).toEqual({ title: "Hide", selector: "Elements where type = Actor", effect: "Hide" });
    expect(describeRule({ ...rule, name: "No actors" }, g).title).toBe("No actors");
  });
});

describe("lists, usage and views", () => {
  const g = index();
  it("moves items", () => {
    expect(moveItem([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
    expect(moveItem([1, 2, 3], 2, 1)).toEqual([1, 3, 2]);
    expect(moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
  });
  it("replaces an edited rule even after a concurrent reorder", () => {
    const a = { name: "a" }, b = { name: "b" }, c = { name: "c" };
    expect(replaceRule([a, b], null, 0, c)).toEqual([a, b, c]);
    expect(replaceRule([b, a], a, 0, c)).toEqual([b, c]);
    expect(replaceRule([b], a, 0, c)).toEqual([c]);
    expect(replaceRule([b], a, 3, c)).toEqual([b, c]);
  });
  it("counts type, field and choice usage", () => {
    const types = typeUsage(g);
    expect(types.get(T.actor)).toBe(6);
    expect(types.get(T.outcome)).toBe(6);
    expect(types.get("t_000000000004")).toBe(17);
    const fields = fieldUsage(g);
    expect(fields.get(F.sector)).toBe(16);
    expect(fields.get(F.since)).toBe(6);
    expect(fields.get(F.note)).toBeUndefined();
    const choices = choiceUsage(F.sector, g);
    expect(choices.get("Public")).toBe(4);
    expect(choiceUsage(F.tags, g).get("food")).toBe(1);
    const sector = g.fields.get(F.sector);
    expect(blockedChoiceRemovals(sector, ["Private", "Community"], g)).toEqual([{ choice: "Public", count: 4 }]);
    expect(blockedChoiceRemovals(sector, ["Public", "Private", "Community", "New"], g)).toEqual([]);
    expect(blockedChoiceRemovals(g.fields.get(F.tags), ["food"], g)).toEqual([]);
  });
  it("picks an unused type colour", () => {
    expect(nextTypeColor(g, "element")).toBe("#e15759");
  });
  it("chunks layout copies and skips unplaced elements", () => {
    const pos = new Map(Array.from({ length: 4500 }, (_, i) => [`e_${String(i).padStart(12, "0")}`, { x: i + 0.4, y: -i, pin: i % 2 === 0 }]));
    const ops = copyLayoutMoves("v_000000000009", [...pos.keys(), "e_ffffffffffff"], (id) => pos.get(id));
    expect(ops.map((o) => o.items.length)).toEqual([2000, 2000, 500]);
    expect(ops[0]).toMatchObject({ op: "move", layout: "v_000000000009" });
    expect(ops[0].items[1]).toEqual({ id: "e_000000000001", x: 1, y: -1, pin: false });
    expect(ops[0].items[0].pin).toBe(true);
  });
  it("duplicates a view's content", () => {
    const v = demoMap().objects.find((o) => o.id === "v_000000000003");
    const copy = duplicateView({ ...v, version: 3, focus: { roots: ["e_000000000001"], depth: 2, direction: "in" } }, "v_00000000000f", copyName(v.name), 9);
    expect(copy).toEqual({ id: "v_00000000000f", name: "Negative links copy", order: 9, rules: v.rules, layout: { kind: "manual", own: false }, showcase: v.showcase, focus: { roots: ["e_000000000001"], depth: 2, direction: "in" } });
    expect(copy.rules).not.toBe(v.rules);
    expect(copyName("x".repeat(80)).length).toBe(80);
  });
});
