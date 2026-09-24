// Icon packs at runtime: registry lookup and stable ids, search, placement, the shared renderer
// (board and SVG export draw the same geometry, inside the object's box), recolouring, protocol
// validation and stored size.
import { describe, expect, it } from "vitest";
import {
  PACKS, allIcons, getIcon, iconDefaults, iconPaths, iconPlacement, iconSummary, iconTextBox, parseCompiledPath,
  resolveIcon, searchIcons, sizeFor,
} from "../../src/shared/icons/registry.js";
import { ICON_PACKS } from "../../src/shared/generated/icon-packs.js";
import { boardToSvg, objectNode, serialize } from "../../src/shared/render.js";
import {
  LIMITS, OBJECT_TYPES, ROTATABLE, cleanObjectPatch, normalizeNewObject, storedBytes,
} from "../../src/shared/protocol.js";
import { boardBounds, pointInObjectBox, textLayout } from "../../src/shared/geometry.js";

const oid = (n) => "o_" + n.toString(16).padStart(12, "0");
/** A stored icon object. */
function iconObject(packId, iconId, fields = {}) {
  const e = getIcon(packId, iconId);
  const d = e ? iconDefaults(e) : { w: 96, h: 96, style: {} };
  return {
    ...normalizeNewObject({ id: oid(1), type: "icon", packId, iconId, w: d.w, h: d.h, style: d.style, ...fields }),
    z: "a0", version: 1, createdAt: 0, updatedAt: 0, createdBy: "t",
  };
}
const board = (list) => ({
  schemaVersion: 1, revision: 1, title: "Icons", background: "dots", lastModified: 0,
  objects: Object.fromEntries(list.map((o) => [o.id, o])),
});
/** Every coordinate pair in path data. */
const points = (d) => {
  const n = (d.match(/-?(?:[0-9]+\.?[0-9]*|\.[0-9]+)/g) ?? []).map(Number);
  const out = [];
  for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]);
  return out;
};

describe("registry", () => {
  it("resolves stable ids in every accepted form, and nothing else", () => {
    const db = getIcon("tabler.1", "database");
    expect(db).toMatchObject({ packId: "tabler.1", id: "database", kind: "glyph", label: "Database" });
    expect(resolveIcon("tabler.1/database")).toBe(db);
    expect(resolveIcon({ packId: "tabler.1", iconId: "database" })).toBe(db);
    // A bare id resolves in pack order: the core stencil comes first.
    expect(resolveIcon("database")).toBe(getIcon("core.1", "database"));
    expect(resolveIcon({ iconId: "server-2" })).toBe(getIcon("tabler.1", "server-2"));
    for (const bad of ["tabler.1/nope", "nope", "TABLER.1/database", "tabler/database", "../database", null, 42, {}]) {
      expect(resolveIcon(bad), String(bad)).toBeNull();
    }
    expect(getIcon("tabler.1", "__proto__")).toBeNull();
    expect(getIcon("constructor", "x")).toBeNull();
  });

  it("keeps every published id: pack ids are versioned and icon ids unique per pack", () => {
    for (const p of PACKS) {
      expect(p.id).toMatch(/^[a-z][a-z0-9-]*\.[0-9]+$/);
      expect(new Set(p.icons.map((i) => i.id)).size).toBe(p.icons.length);
    }
    expect(allIcons()).toHaveLength(PACKS.reduce((n, p) => n + p.icons.length, 0));
  });

  it("ships only inert geometry: M/L/C/Z path data, known paint roles, finite view boxes", () => {
    for (const pack of ICON_PACKS) {
      for (const icon of pack.icons) {
        expect(Object.keys(icon).sort()).toEqual(expect.arrayContaining(["category", "id", "label", "shapes", "tags", "vb"]));
        expect(icon.vb.every((v) => v > 0 && v <= 1024)).toBe(true);
        for (const [paint, d] of icon.shapes) {
          expect(["ni", "fi", "in", "fn", "ii"]).toContain(paint);
          const { cmds, nums } = parseCompiledPath(d);
          expect(cmds.length).toBeGreaterThan(0);
          expect(nums.every(Number.isFinite)).toBe(true);
        }
      }
    }
    expect(() => parseCompiledPath("M0 0L1")).toThrow();
    expect(() => parseCompiledPath("M0 0 A1 1 0 0 0 2 2")).toThrow();
    expect(() => parseCompiledPath("<script>")).toThrow();
    expect(() => parseCompiledPath("L0 0")).toThrow();
  });

  it("summarises icons for callers with ids, labels, tags and aspect ratio (no geometry)", () => {
    const s = iconSummary(getIcon("core.1", "decision"));
    expect(s).toEqual({
      packId: "core.1", iconId: "decision", label: "Decision", category: "flowchart", categoryLabel: "Flowchart",
      tags: expect.arrayContaining(["diamond"]), kind: "stencil", aspect: 1.6, text: true,
    });
    expect(iconSummary(getIcon("tabler.1", "user")).text).toBe(false);
  });

  it("gives defaults: stencils at their own size, glyphs 96 on the long side", () => {
    expect(iconDefaults(getIcon("core.1", "decision"))).toMatchObject({ w: 160, h: 100, style: { fill: "#ffffff" } });
    expect(iconDefaults(getIcon("tabler.1", "user"))).toMatchObject({ w: 96, h: 96, style: { fill: "none", strokeWidth: 2 } });
    expect(sizeFor(getIcon("core.1", "decision"), 80)).toEqual({ w: 80, h: 50 });
  });
});

describe("search", () => {
  const ids = (list) => list.map((e) => `${e.packId}/${e.id}`);

  it("ranks exact ids, then label words, then tags, then fuzzy matches", () => {
    expect(ids(searchIcons("database")).slice(0, 2)).toEqual(expect.arrayContaining(["core.1/database", "tabler.1/database"]));
    expect(ids(searchIcons("person"))).toEqual(expect.arrayContaining(["core.1/actor"]));
    expect(ids(searchIcons("db")).slice(0, 3)).toContain("core.1/database");
    expect(ids(searchIcons("diamond"))[0]).toBe("core.1/decision");
    expect(ids(searchIcons("srvr"))).toEqual(expect.arrayContaining(["tabler.1/server"])); // letters in order
    // Every word must match.
    expect(ids(searchIcons("cloud upload"))[0]).toBe("tabler.1/cloud-upload");
    expect(searchIcons("zzzz qqqq")).toEqual([]);
  });

  it("filters by pack and category, lists everything for an empty query, and clamps the limit", () => {
    expect(searchIcons("", { limit: 500 })).toHaveLength(allIcons().length);
    expect(searchIcons("").length).toBe(20);
    expect(searchIcons("", { limit: 0 })).toHaveLength(1);
    expect(searchIcons("", { limit: 1e9 }).length).toBeLessThanOrEqual(500);
    expect(searchIcons("user", { packId: "core.1" }).every((e) => e.packId === "core.1")).toBe(true);
    const net = searchIcons("", { packId: "tabler.1", category: "network", limit: 500 });
    expect(net.length).toBeGreaterThan(10);
    expect(net.every((e) => e.category === "network")).toBe(true);
    expect(searchIcons({ toString: () => "x" })).toHaveLength(20); // non-string query: list
    expect(searchIcons("a".repeat(10_000))).toEqual([]);
  });
});

describe("rendering", () => {
  it("draws glyphs centred at their aspect ratio and stencils stretched, from the same compiled geometry", () => {
    const glyph = getIcon("tabler.1", "user");
    expect(iconPlacement(glyph, { x: 0, y: 0, w: 200, h: 100 })).toEqual({ x: 50, y: 0, w: 100, h: 100, sx: 100 / 24, sy: 100 / 24 });
    const stencil = getIcon("core.1", "decision");
    expect(iconPlacement(stencil, { x: 10, y: 20, w: 320, h: 100 })).toMatchObject({ x: 10, y: 20, sx: 2, sy: 1 });
  });

  it("keeps every icon's geometry inside its object box, so export bounds match the board", () => {
    for (const e of allIcons()) {
      const o = iconObject(e.packId, e.id, { x: 100, y: -50, w: 150, h: 90 });
      const node = objectNode(o, () => undefined);
      const paths = node.children.filter((c) => c.tag === "path");
      expect(paths.length, e.id).toBeGreaterThan(0);
      // Compiled geometry may reach COMPILER_LIMITS.margin outside the view box; shipped icons stay
      // within their view box plus a hair, so the object box is their bounds.
      const slack = 0.02 * Math.max(o.w, o.h);
      for (const p of paths) {
        for (const [x, y] of points(p.attrs.d)) {
          expect(x, e.id).toBeGreaterThanOrEqual(o.x - slack);
          expect(x, e.id).toBeLessThanOrEqual(o.x + o.w + slack);
          expect(y, e.id).toBeGreaterThanOrEqual(o.y - slack);
          expect(y, e.id).toBeLessThanOrEqual(o.y + o.h + slack);
        }
      }
    }
  });

  it("serialises the same nodes on the board and in the SVG export", () => {
    const a = iconObject("tabler.1", "cloud", { x: 0, y: 0, rot: 30 });
    const b = { ...iconObject("core.1", "decision", { x: 200, y: 0, text: "Ship it?" }), id: oid(2) };
    const svg = boardToSvg(board([a, b]));
    expect(svg).toContain(serialize(/** @type {any} */ (objectNode(a, () => undefined))));
    expect(svg).toContain(serialize(/** @type {any} */ (objectNode(b, () => undefined))));
    expect(svg).toContain("rotate(30 48 48)");
    expect(svg).toContain("Ship it?");
    expect(svg).not.toMatch(/<script|href=|url\(|<image|<use|on[a-z]+=/i);
    // The export's view box covers both icons.
    const [vx, vy, vw, vh] = svg.match(/viewBox="([^"]+)"/)[1].split(" ").map(Number);
    const bounds = boardBounds(board([a, b]).objects);
    expect(vx).toBeLessThanOrEqual(bounds.x);
    expect(vy).toBeLessThanOrEqual(bounds.y);
    expect(vx + vw).toBeGreaterThanOrEqual(bounds.x + bounds.w);
    expect(vy + vh).toBeGreaterThanOrEqual(bounds.y + bounds.h);
  });

  it("recolours through paint roles without touching the geometry", () => {
    const base = iconObject("core.1", "server");
    const recoloured = { ...base, style: { ...base.style, fill: "#b5d8ff", stroke: "#dc2626", strokeWidth: 4 } };
    const n1 = objectNode(base, () => undefined), n2 = objectNode(recoloured, () => undefined);
    const d = (n) => n.children.map((c) => c.attrs.d);
    expect(d(n2)).toEqual(d(n1));
    const body = n2.children[0].attrs;
    expect(body).toMatchObject({ fill: "#b5d8ff", stroke: "#dc2626", "stroke-width": "4" });
    // Ink marks (the server's lights) follow the line colour.
    expect(n2.children.some((c) => c.attrs.fill === "#dc2626" && c.attrs.stroke === "none")).toBe(true);
  });

  it("scales a glyph's line width with the icon and draws a tile for a fill colour", () => {
    const o = iconObject("tabler.1", "user", { w: 48, h: 48 });
    const n = objectNode(o, () => undefined);
    expect(n.children[0].attrs["stroke-width"]).toBe("4"); // 2 icon units at 2x
    const tiled = objectNode({ ...o, style: { ...o.style, fill: "#fff3a0", stroke: "none" } }, () => undefined);
    expect(tiled.children[0]).toMatchObject({ tag: "rect", attrs: { fill: "#fff3a0" } });
    expect(tiled.children[1].attrs.stroke).toBe("#1f2937"); // an invisible glyph falls back to ink
  });

  it("draws an unknown icon as a placeholder and never throws", () => {
    const o = { ...iconObject("tabler.1", "user"), iconId: "gone-forever" };
    const n = objectNode(o, () => undefined);
    expect(n.children).toHaveLength(1);
    expect(n.children[0].attrs["data-missing-icon"]).toBe("1");
    // An object type this build does not know (a future type) renders as an empty group.
    expect(objectNode({ ...o, type: /** @type {any} */ ("hologram") }, () => undefined).children).toEqual([]);
  });

  it("lays text out in a stencil's text box and never for glyphs", () => {
    const d = iconObject("core.1", "decision", { x: 0, y: 0, w: 160, h: 100, text: "Yes?" });
    const box = iconTextBox(d);
    for (const [k, v] of Object.entries({ x: 35.2, y: 22, w: 89.6, h: 56 })) expect(box[k]).toBeCloseTo(v, 6);
    const layout = textLayout(d);
    expect(layout.x).toBeGreaterThan(35);
    expect(layout.lines).toEqual(["Yes?"]);
    expect(objectNode(d, () => undefined).children.some((c) => c.tag === "text")).toBe(true);
    const g = { ...iconObject("tabler.1", "user"), text: "ignored" };
    expect(iconTextBox(g)).toBeNull();
    expect(objectNode(g, () => undefined).children.some((c) => c.tag === "text")).toBe(false);
  });

  it("hits icons by their box and rotates them", () => {
    const o = iconObject("tabler.1", "user", { x: 0, y: 0, w: 100, h: 100 });
    expect(pointInObjectBox(o, { x: 5, y: 5 })).toBe(true);
    expect(pointInObjectBox(o, { x: 105, y: 5 })).toBe(false);
    expect(ROTATABLE).toContain("icon");
  });

  it("parses each icon's paths once", () => {
    const e = getIcon("tabler.1", "database");
    expect(iconPaths(e)).toBe(iconPaths(e));
  });
});

describe("protocol", () => {
  it("adds icon as an object type with validated pack and icon ids", () => {
    expect(OBJECT_TYPES).toContain("icon");
    const o = normalizeNewObject({ id: oid(3), type: "icon", packId: "tabler.1", iconId: "user", x: 1, y: 2 });
    expect(o).toMatchObject({ type: "icon", packId: "tabler.1", iconId: "user", w: 96, h: 96, text: "", frameId: null });
    const bad = normalizeNewObject({ id: oid(3), type: "icon", packId: "Tabler", iconId: "../x" });
    expect(bad).toMatchObject({ packId: "", iconId: "" });
    expect(cleanObjectPatch({ packId: "core.1", iconId: "decision", points: [0, 0, 1, 1] }, "icon"))
      .toEqual({ packId: "core.1", iconId: "decision" });
    expect(cleanObjectPatch({ packId: "x".repeat(40) + ".1", iconId: "a".repeat(65) }, "icon")).toEqual({});
    expect(cleanObjectPatch({ packId: "core.1" }, "sticky")).toEqual({});
  });

  it("stores an icon in far less than the per-object budget: geometry is never stored", () => {
    const o = iconObject("tabler.1", "topology-star-3");
    const bytes = storedBytes(o);
    expect(bytes).toBeLessThan(600);
    expect(JSON.stringify(o)).not.toMatch(/M[0-9]/);
    const full = iconObject("core.1", "note", { text: "x".repeat(LIMITS.text) });
    expect(storedBytes(full)).toBeLessThan(LIMITS.objectBytes);
  });
});
