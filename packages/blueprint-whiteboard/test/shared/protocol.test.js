import { serialize } from "node:v8";
import { describe, expect, it } from "vitest";
import {
  LIMITS, isAcceptableOrderKey, isOrderKey, TYPE_DEFAULTS, cleanColor, cleanNumber, cleanObjectPatch, cleanPoints, cleanPresence, cleanRotation,
  cleanStylePatch, compareObjects, effectiveFrameId, isId, isSession, newId, newSession, normalizeNewObject,
  storedBytes,
} from "../../src/shared/protocol.js";

const oid = (n) => "o_" + n.toString(16).padStart(12, "0");

describe("ids and tokens", () => {
  it("generates object and history ids that validate by kind", () => {
    const o = newId("object"), h = newId("history");
    expect(isId(o)).toBe(true);
    expect(isId(h, "history")).toBe(true);
    expect(isId(h)).toBe(false);
    expect(isId("o_1234")).toBe(false);
    expect(isId("o_" + "G".repeat(12))).toBe(false);
    expect(isSession(newSession())).toBe(true);
    expect(isSession("0a".repeat(15))).toBe(false);
  });
});

describe("numbers", () => {
  it("clamps, rounds and rejects non-finite values", () => {
    expect(cleanNumber(1.23456, 0, 10)).toBe(1.23);
    expect(cleanNumber(99, 0, 10)).toBe(10);
    expect(cleanNumber(NaN, 0, 10)).toBeNull();
    expect(cleanNumber(Infinity, 0, 10)).toBeNull();
    expect(cleanNumber("5", 0, 10)).toBeNull();
    expect(Object.is(cleanNumber(-0.001, -1, 1), 0)).toBe(true);
  });
  it("normalises rotation into [0, 360)", () => {
    expect(cleanRotation(-90)).toBe(270);
    expect(cleanRotation(360)).toBe(0);
    expect(cleanRotation(719.99)).toBe(0);
    expect(cleanRotation(45.26)).toBe(45.3);
    expect(cleanRotation(null)).toBeNull();
  });
});

describe("styles and colours", () => {
  it("keeps only valid keys and allows none where it makes sense", () => {
    expect(cleanColor("#ABCDEF")).toBe("#abcdef");
    expect(cleanColor("none")).toBeNull();
    expect(cleanColor("none", true)).toBe("none");
    expect(cleanColor("red")).toBeNull();
    const s = cleanStylePatch({ fill: "none", stroke: "#000000", strokeWidth: 999, fontSize: 3, align: "justify", arrowEnd: "arrow", evil: 1 }, "rect");
    expect(s).toEqual({ fill: "none", stroke: "#000000", strokeWidth: LIMITS.strokeWidth, fontSize: LIMITS.fontSizeMin });
    expect(cleanStylePatch({ arrowEnd: "arrow", arrowStart: "bogus" }, "connector")).toEqual({ arrowEnd: "arrow" });
    expect(cleanStylePatch({ textColor: "none" }, "text")).toEqual({});
  });
});

describe("patches", () => {
  it("allows only the fields the type can change", () => {
    const p = cleanObjectPatch({ x: 5, rot: 30, from: oid(1), points: [0, 0, 1, 1], type: "rect", version: 9 }, "frame");
    expect(p).toEqual({ x: 5 });
    const c = cleanObjectPatch({ x: 5, from: oid(1), to: "nope", routing: "elbow", fromSide: "left", text: "a\nb" }, "connector");
    expect(c).toEqual({ from: oid(1), routing: "elbow", fromSide: "left", text: "a b" });
  });
  it("cleans text per type", () => {
    expect(cleanObjectPatch({ text: "x".repeat(LIMITS.text + 10) }, "sticky").text).toHaveLength(LIMITS.text);
    expect(cleanObjectPatch({ text: "Name\nline" }, "frame").text).toBe("Name line");
    expect(cleanObjectPatch({ text: "a\r\nb" + String.fromCharCode(0, 0x202e) }, "text").text).toBe("a\nb");
  });
  it("drops invalid values rather than defaulting them", () => {
    expect(cleanObjectPatch({ w: "big", z: "not a key!", frameId: 7 }, "sticky")).toEqual({});
    expect(cleanObjectPatch({ frameId: null }, "sticky")).toEqual({ frameId: null });
    expect(cleanObjectPatch({ w: 0 }, "sticky")).toEqual({ w: LIMITS.sizeMin });
  });
  it("ignores prototype keys", () => {
    const raw = JSON.parse('{"__proto__": {"x": 1}, "constructor": 1, "y": 2}');
    expect(cleanObjectPatch(raw, "rect")).toEqual({ y: 2 });
  });
});

describe("points", () => {
  it("clamps to [0, 1], rounds, caps and rejects junk", () => {
    expect(cleanPoints([0, 0, 1.5, -1, 0.123456, 0.5])).toEqual([0, 0, 1, 0, 0.1235, 0.5]);
    expect(cleanPoints([0, 0])).toBeNull();
    expect(cleanPoints([0, 0, "a", 1])).toBeNull();
    expect(cleanPoints(new Array((LIMITS.penPoints + 5) * 2).fill(0.5))).toHaveLength(LIMITS.penPoints * 2);
  });
});

describe("normalizeNewObject", () => {
  it("fills defaults per type", () => {
    const o = normalizeNewObject({ id: oid(1), type: "sticky" });
    expect(o).toMatchObject({ w: 200, h: 200, rot: 0, z: "", frameId: null, text: "" });
    expect(o.style).toEqual(TYPE_DEFAULTS.sticky.style);
    expect(o.style).not.toBe(TYPE_DEFAULTS.sticky.style);
  });
  it("forces connector geometry and frame membership rules", () => {
    const c = normalizeNewObject({ id: oid(2), type: "connector", x: 50, from: oid(1), to: oid(3), frameId: oid(4) });
    expect(c).toMatchObject({ x: 0, y: 0, w: 1, h: 1, frameId: null, from: oid(1), to: oid(3), fromSide: "auto", routing: "straight" });
    expect(normalizeNewObject({ id: oid(3), type: "frame", frameId: oid(4), rot: 20 })).toMatchObject({ frameId: null, rot: 0 });
    expect(normalizeNewObject({ id: oid(3), type: "pen" }).points).toEqual([]);
  });
  it("rejects bad ids and types", () => {
    expect(normalizeNewObject({ id: "x", type: "sticky" })).toBeNull();
    expect(normalizeNewObject({ id: oid(1), type: "image" })).toBeNull();
    expect(normalizeNewObject(null)).toBeNull();
  });
  it("never lets rotation through for non-rotatable types", () => {
    for (const type of ["frame", "pen"]) expect(normalizeNewObject({ id: oid(1), type, rot: 45 }).rot).toBe(0);
    expect(normalizeNewObject({ id: oid(1), type: "rect", rot: 45 }).rot).toBe(45);
  });
});

describe("stacking and frames", () => {
  it("puts frames below everything, then z, then id", () => {
    const list = [
      { id: oid(3), type: "sticky", z: "a0" }, { id: oid(1), type: "frame", z: "b0" },
      { id: oid(2), type: "sticky", z: "a0" }, { id: oid(4), type: "rect", z: "Z0" },
    ].sort(compareObjects);
    expect(list.map((o) => o.id)).toEqual([oid(1), oid(4), oid(2), oid(3)]);
  });
  it("reads a dangling frameId as null", () => {
    const objects = { [oid(1)]: { id: oid(1), type: "frame" }, [oid(2)]: { id: oid(2), type: "rect" } };
    expect(effectiveFrameId({ frameId: oid(1) }, objects)).toBe(oid(1));
    expect(effectiveFrameId({ frameId: oid(2) }, objects)).toBeNull();
    expect(effectiveFrameId({ frameId: oid(9) }, objects)).toBeNull();
    expect(effectiveFrameId({ frameId: null }, objects)).toBeNull();
  });
});

describe("presence", () => {
  it("keeps previous fields, clears with null and caps arrays", () => {
    const first = cleanPresence({ name: "Ann", cursor: { x: 1, y: 2 }, selection: [oid(1), "bad", oid(1)] }, "c1", null);
    expect(first).toMatchObject({ clientId: "c1", name: "Ann", cursor: { x: 1, y: 2 }, selection: [oid(1)], transforms: [], stroke: null });
    const next = cleanPresence({ cursor: null, editingId: oid(2) }, "c1", first);
    expect(next).toMatchObject({ name: "Ann", cursor: null, selection: [oid(1)], editingId: oid(2) });
    const many = cleanPresence({ transforms: Array.from({ length: 500 }, (_, i) => ({ id: oid(i + 1), x: 0, y: 0, w: 10, h: 10 })) }, "c1", null);
    expect(many.transforms).toHaveLength(LIMITS.presenceTransforms);
    const stroke = cleanPresence({ stroke: { points: new Array(5000).fill(3), color: "red", width: 999 } }, "c1", null).stroke;
    expect(stroke.points).toHaveLength(LIMITS.presenceStrokePoints * 2);
    expect(stroke).toMatchObject({ color: "#1f2937", width: LIMITS.strokeWidth });
    expect(cleanPresence({ stroke: { points: [1, "x", 3, 4] } }, "c1", null).stroke).toBeNull();
    expect(cleanPresence({ viewport: { x: 0, y: 0, w: "wide", h: 10 } }, "c1", null).viewport).toBeNull();
  });
  it("tolerates garbage", () => {
    for (const raw of [null, 5, "x", [], { cursor: "x", selection: "y", transforms: {}, stroke: [] }]) {
      expect(() => cleanPresence(raw, "c", null)).not.toThrow();
    }
  });
});

describe("storedBytes", () => {
  it("counts two bytes per unit beyond Latin-1", () => {
    expect(storedBytes({ a: "abc" })).toBeGreaterThanOrEqual(JSON.stringify({ a: "abc" }).length);
    const wide = { a: "日本語テキスト".repeat(100) };
    expect(storedBytes(wide)).toBeGreaterThanOrEqual(wide.a.length * 2);
  });

  it("is an upper bound of both the UTF-8 JSON and the V8 serialisation", () => {
    let seed = 11;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const leaves = [0, 1, -1, 0.5, 0.1429, 1e6, 2 ** 31, -999999.99, 1700000000000.5, 1.2345678901234567e-300,
      true, false, null, "", "a", "é", "日本", "\u{1F600}", 'q"\\n', "x".repeat(300), "é".repeat(200), "日".repeat(300)];
    const gen = (depth) => {
      const r = rand();
      if (depth > 3 || r < 0.5) return pick(leaves);
      if (r < 0.75) {
        const holey = new Array(Math.floor(rand() * (depth ? 8 : 400)));
        for (let i = 0; i < holey.length; i++) holey[i] = gen(depth + 1);
        return holey;
      }
      const o = {};
      for (let i = 0; i < rand() * 12; i++) o[pick(["k", "é", "日本", "points"]) + i] = gen(depth + 1);
      return o;
    };
    for (let i = 0; i < 1500; i++) {
      const v = gen(0);
      const bytes = storedBytes(v);
      expect(bytes).toBeGreaterThanOrEqual(serialize(v).length);
      expect(bytes).toBeGreaterThanOrEqual(new TextEncoder().encode(JSON.stringify(v)).length);
    }
    // Doubles in a holey array cost V8 about 13 bytes each, against 4 to 7 in JSON.
    const points = new Array(4000);
    for (let i = 0; i < points.length; i++) points[i] = 0.1429;
    expect(storedBytes(points)).toBeGreaterThanOrEqual(serialize(points).length);
  });
});

describe("isAcceptableOrderKey", () => {
  it("accepts ordinary keys up to orderKeyAccept chars with an integer head from B to y", () => {
    for (const k of ["a0", "a1", "Zz", "b0V", "a0" + "V".repeat(LIMITS.orderKeyAccept - 2), "y" + "z".repeat(25), "B" + "0".repeat(24) + "1"]) {
      expect(isOrderKey(k)).toBe(true);
      expect(isAcceptableOrderKey(k)).toBe(true);
    }
    for (const k of ["a0" + "V".repeat(LIMITS.orderKeyAccept - 1), "z".repeat(27), "z" + "0".repeat(26), "A1" + "0".repeat(25), "A0" + "0".repeat(25) + "1", "", "not valid", 5]) {
      expect(isAcceptableOrderKey(k)).toBe(false);
    }
  });
});
