// @ts-check
// The demo map a new Network Map opens on: a small local food system with element and connection
// types, three custom fields, a reinforcing and a balancing loop, and three views. Ids are fixed,
// so the demo is identical in every new map; "Start blank" (the client) deletes it.

/** @param {string} kind @param {number} n */
const id = (kind, n) => `${kind}_${n.toString(16).padStart(12, "0")}`;

export const DEMO_TITLE = "Local food system (demo)";

/**
 * @returns {{title: string, objects: any[], positions: {id: string, x: number, y: number}[]}}
 */
export function demoMap() {
  const T = {
    actor: id("t", 1), resource: id("t", 2), outcome: id("t", 3),
    supports: id("t", 4), undermines: id("t", 5),
  };
  const F = { sector: id("f", 1), influence: id("f", 2), since: id("f", 3) };
  const types = [
    { id: T.actor, name: "Actor", appliesTo: "element", color: "#4e79a7", shape: "circle" },
    { id: T.resource, name: "Resource", appliesTo: "element", color: "#59a14f", shape: "square" },
    { id: T.outcome, name: "Outcome", appliesTo: "element", color: "#f28e2b", shape: "diamond" },
    { id: T.supports, name: "Supports", appliesTo: "connection", color: "#59a14f" },
    { id: T.undermines, name: "Undermines", appliesTo: "connection", color: "#e15759" },
  ];
  const fields = [
    { id: F.sector, name: "Sector", kind: "choice", appliesTo: "element", choices: ["Public", "Private", "Community"] },
    { id: F.influence, name: "Influence", kind: "number", appliesTo: "element" },
    { id: F.since, name: "Active since", kind: "date", appliesTo: "element" },
  ];
  /** @type {[string, string, string, number, number, number, string?][]} label, type, sector, influence, x, y, description */
  const rows = [
    ["Local farms", "actor", "Private", 4, 0, 0, "Small and mid-size growers within 50 miles."],
    ["Farmers market", "actor", "Community", 3, 220, -80],
    ["School kitchens", "actor", "Public", 3, 260, 160],
    ["Food bank", "actor", "Community", 2, 80, 300],
    ["City council", "actor", "Public", 5, -260, 200, "Sets procurement rules and zoning."],
    ["Supermarkets", "actor", "Private", 5, -220, -200],
    ["Farmland", "resource", "Private", 2, -140, -40],
    ["Cold storage", "resource", "Community", 2, 120, 80],
    ["Volunteers", "resource", "Community", 1, 300, 360],
    ["Farm income", "outcome", "Private", 3, 40, -180],
    ["Fresh food access", "outcome", "Community", 4, 420, 60],
    ["Child nutrition", "outcome", "Public", 3, 460, 240],
    ["Food waste", "outcome", "Community", 2, -40, 180],
    ["Land prices", "outcome", "Private", 3, -340, -60],
    ["Local procurement policy", "resource", "Public", 4, -80, 380],
    ["Community awareness", "outcome", "Community", 2, 520, -100],
  ];
  const elements = rows.map(([label, type, sector, influence, , , description], i) => ({
    id: id("e", i + 1), label, typeId: T[/** @type {keyof typeof T} */ (type)],
    ...(description ? { description } : {}),
    fields: { [F.sector]: sector, [F.influence]: influence, ...(i < 6 ? { [F.since]: `${2008 + i * 2}-04-01` } : {}) },
    ...(i === 1 ? { tags: ["weekly", "outdoor"] } : {}),
  }));
  const E = (/** @type {string} */ label) => /** @type {string} */ (elements.find((e) => e.label === label)?.id);
  /** @type {[string, string, "+"|"-", string?, string?][]} from, to, polarity, direction, label */
  const links = [
    ["Local farms", "Farmers market", "+"],
    ["Farmers market", "Farm income", "+"],
    ["Farm income", "Local farms", "+", "directed", "reinvestment"],
    ["Local farms", "School kitchens", "+"],
    ["School kitchens", "Child nutrition", "+"],
    ["Farmers market", "Fresh food access", "+"],
    ["Fresh food access", "Community awareness", "+"],
    ["Community awareness", "Farmers market", "+", "directed", "footfall"],
    ["Land prices", "Farmland", "-"],
    ["Farmland", "Local farms", "+"],
    ["Local farms", "Land prices", "+", "directed", "demand for land"],
    ["Supermarkets", "Farm income", "-", "directed", "price pressure"],
    ["Supermarkets", "Food waste", "+"],
    ["Food waste", "Food bank", "+", "directed", "surplus donations"],
    ["Food bank", "Fresh food access", "+"],
    ["Volunteers", "Food bank", "+"],
    ["Cold storage", "Food waste", "-"],
    ["Local farms", "Cold storage", "+", "undirected"],
    ["City council", "Local procurement policy", "+"],
    ["Local procurement policy", "School kitchens", "+"],
    ["City council", "Land prices", "-", "directed", "zoning"],
    ["Farmers market", "Supermarkets", "-", "mutual", "competition"],
  ];
  const connections = links.map(([from, to, polarity, direction = "directed", label], i) => ({
    id: id("c", i + 1), from: E(from), to: E(to), direction, polarity,
    typeId: polarity === "-" ? T.undermines : T.supports,
    ...(label ? { label } : {}),
  }));
  const C = (/** @type {string} */ a, /** @type {string} */ b) => /** @type {string} */ (connections.find((c) => c.from === E(a) && c.to === E(b))?.id);
  const loops = [
    {
      id: id("l", 1), label: "Market growth", classification: "R",
      steps: [{ c: C("Local farms", "Farmers market"), fwd: true }, { c: C("Farmers market", "Farm income"), fwd: true }, { c: C("Farm income", "Local farms"), fwd: true }],
      description: "More farms supply the market, which raises farm income, which is reinvested in farming.",
    },
    {
      id: id("l", 2), label: "Land squeeze", classification: "B",
      steps: [{ c: C("Local farms", "Land prices"), fwd: true }, { c: C("Land prices", "Farmland"), fwd: true }, { c: C("Farmland", "Local farms"), fwd: true }],
      description: "Growth raises demand for land and land prices, which limits the farmland available.",
    },
  ];
  const views = [
    { id: id("v", 1), name: "By type", rules: [], layout: { kind: "manual", own: false }, order: 1 },
    {
      id: id("v", 2), name: "Influence", order: 2, layout: { kind: "manual", own: false },
      rules: [
        { name: "Colour by sector", selector: { target: "element", match: "all", where: [] }, set: { color: { byCategory: { k: "field", id: F.sector } } } },
        { name: "Size by influence", selector: { target: "element", match: "all", where: [] }, set: { size: { byNumber: { k: "field", id: F.influence }, range: [4, 16], scale: "linear" } } },
      ],
    },
    {
      id: id("v", 3), name: "Negative links", order: 3, layout: { kind: "manual", own: false },
      rules: [{ name: "Thick negative links", selector: { target: "connection", match: "all", where: [{ subject: { k: "polarity" }, op: "eq", value: "-" }] }, set: { width: { value: 4 } } }],
      showcase: { target: "connection", match: "all", where: [{ subject: { k: "polarity" }, op: "eq", value: "-" }] },
    },
  ];
  const positions = rows.map((r, i) => ({ id: id("e", i + 1), x: r[4], y: r[5] }));
  return { title: DEMO_TITLE, objects: [...types, ...fields, ...views, ...elements, ...connections, ...loops], positions };
}
