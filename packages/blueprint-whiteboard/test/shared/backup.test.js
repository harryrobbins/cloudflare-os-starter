// The portable board format: writing, migrations, validation of untrusted documents, id and
// reference remapping, caps, and plain text as sticky notes.
import { describe, expect, it } from "vitest";
import { LIMITS, TYPE_DEFAULTS, isId, newId } from "../../src/shared/protocol.js";
import {
  BACKUP_FORMAT, BACKUP_LIMITS, BACKUP_VERSION, CLIPBOARD_MIME, MIGRATIONS, buildBackup, buildClipboard,
  entriesBounds, importOffset, migrateBackup, offsetToCenter, parseBackup, planCreates, plainTextOf, textToEntries,
  toPortable,
} from "../../src/shared/backup.js";

let seq = 0;
function obj(type, fields = {}) {
  const d = TYPE_DEFAULTS[type];
  return {
    id: fields.id ?? "o_" + (++seq).toString(16).padStart(12, "0"), type, x: 0, y: 0, w: d.w, h: d.h, rot: 0, z: "a" + seq,
    frameId: null, text: "", style: { ...d.style }, version: 3, createdAt: 1, updatedAt: 2, createdBy: "Ada", ...fields,
  };
}
const board = (...list) => Object.fromEntries(list.map((o) => [o.id, o]));

describe("writing", () => {
  it("exports title, background and objects only, bottom to top, with no attribution, versions or order keys", () => {
    const f = obj("frame", { text: "F", z: "a5" });
    const a = obj("sticky", { text: "a", frameId: f.id, z: "a2" });
    const b = obj("rect", { text: "b", z: "a1" });
    const c = obj("connector", { from: a.id, to: b.id, fromSide: "auto", toSide: "left", routing: "elbow" });
    const doc = buildBackup({ title: "T", background: "grid", objects: board(a, b, c, f) }, { now: 0 });
    expect(doc).toMatchObject({ format: BACKUP_FORMAT, version: BACKUP_VERSION, title: "T", background: "grid", exportedAt: "1970-01-01T00:00:00.000Z" });
    expect(doc.objects.map((o) => o.id)).toEqual([f.id, b.id, a.id, c.id]);
    const text = JSON.stringify(doc);
    for (const key of ["createdBy", "version\":3", "createdAt", "updatedAt", "\"z\"", "Ada"]) expect(text).not.toContain(key);
    expect(doc.objects[2].frameId).toBe(f.id);
    expect(doc.objects[3]).toMatchObject({ from: a.id, to: b.id, toSide: "left", routing: "elbow" });
  });

  it("copies connectors only with both ends and frameIds only with their frame", () => {
    const f = obj("frame");
    const a = obj("sticky", { frameId: f.id, x: 10, y: 20 });
    const b = obj("sticky", { x: 300, y: 400 });
    const c = obj("connector", { from: a.id, to: b.id });
    const all = board(f, a, b, c);
    const one = toPortable([a, c], all);
    expect(one.map((o) => o.id)).toEqual([a.id]);
    expect(one[0].frameId).toBeNull();
    const clip = buildClipboard([a, b, c], all);
    expect(clip.objects).toHaveLength(3);
    expect(clip.origin).toEqual({ x: 10, y: 20 });
    expect(CLIPBOARD_MIME).toBe("application/vnd.cloudflare-os-whiteboard+json;version=1");
    expect(plainTextOf([{ ...one[0], text: "x" }, { ...one[0], text: "" }])).toBe("x");
  });
});

describe("migrations", () => {
  it("reads a getBoard() snapshot as version 0, ordered by z", () => {
    const a = obj("sticky", { text: "top", z: "a9" });
    const b = obj("sticky", { text: "bottom", z: "a1" });
    const snapshot = { schemaVersion: 1, revision: 7, title: "Old", background: "plain", lastModified: 5, objects: board(a, b) };
    const m = migrateBackup(snapshot);
    expect(m.from).toBe(0);
    expect(m.doc.version).toBe(1);
    const parsed = parseBackup(JSON.stringify(snapshot));
    expect(parsed.fromVersion).toBe(0);
    expect(parsed.title).toBe("Old");
    expect(parsed.background).toBe("plain");
    expect(parsed.entries.map((e) => e.object.text)).toEqual(["bottom", "top"]);
    expect(Object.keys(MIGRATIONS).map(Number)).toEqual([0]);
  });

  it("refuses newer versions, other formats and non-documents", () => {
    expect(parseBackup({ format: BACKUP_FORMAT, version: 99, objects: [] }).error).toMatch(/newer/);
    expect(parseBackup({ format: "something-else", version: 1, objects: [] }).error).toMatch(/not a whiteboard/);
    expect(parseBackup("[1,2]").error).toMatch(/not a whiteboard/);
    expect(parseBackup("nope").error).toMatch(/not valid JSON/);
    expect(parseBackup({ version: 1 }).error).toMatch(/no objects/);
    expect(parseBackup("x".repeat(BACKUP_LIMITS.textChars + 1)).error).toMatch(/too large/);
  });
});

describe("reading untrusted documents", () => {
  it("drops unknown and untrusted fields, clamps values, truncates text", () => {
    const parsed = parseBackup({
      version: 1,
      objects: [{
        id: "a", type: "sticky", x: 5e9, y: -3, w: 0, h: 300, rot: 725, text: "t".repeat(LIMITS.text + 50),
        style: { fill: "#ABCDEF", stroke: "javascript:alert(1)", onclick: "x" },
        version: 999, createdBy: "Mallory", createdAt: 1, z: "zzzz", __proto__: { polluted: true }, html: "<b>x</b>",
      }],
    });
    expect(parsed.skipped).toBe(0);
    const o = parsed.entries[0].object;
    expect(o).toMatchObject({ type: "sticky", x: LIMITS.coord, y: -3, w: LIMITS.sizeMin, h: 300, rot: 5 });
    expect(o.text).toHaveLength(LIMITS.text);
    expect(o.style.fill).toBe("#abcdef");
    expect(o.style.stroke).toBe(TYPE_DEFAULTS.sticky.style.stroke);
    for (const key of ["version", "createdBy", "createdAt", "z", "html", "id", "polluted"]) expect(o).not.toHaveProperty(key);
    expect({}.polluted).toBeUndefined();
  });

  it("reports invalid objects, duplicate ids, dangling connectors and pens without points", () => {
    const parsed = parseBackup({
      version: 1,
      objects: [
        { id: "a", type: "sticky" },
        { id: "a", type: "rect" },
        { id: "b", type: "hexagon" },
        "nope",
        { id: "p", type: "pen", points: [0, 0] },
        { id: "c1", type: "connector", from: "a", to: "zz" },
        { id: "c2", type: "connector", from: "a", to: "c1" },
        { id: "c3", type: "connector", from: "a", to: "a" },
        { id: "r", type: "rect", frameId: "a" },
      ],
    });
    expect(parsed.entries.map((e) => e.ref)).toEqual(["a", "r"]);
    expect(parsed.entries[1].frameRef).toBeNull(); // "a" is not a frame
    expect(parsed.skipped).toBe(7);
    expect(parsed.errors.join("\n")).toMatch(/duplicate id/);
    expect(parsed.errors.join("\n")).toMatch(/unknown type/);
    expect(parsed.errors.join("\n")).toMatch(/not both in the backup/);
    expect(parsed.counts).toEqual({ sticky: 1, rect: 1 });
  });

  it("caps the number of objects and of error messages", () => {
    const objects = Array.from({ length: BACKUP_LIMITS.objects + 30 }, (_, i) => ({ id: `s${i}`, type: "sticky" }));
    const parsed = parseBackup({ version: 1, objects });
    expect(parsed.entries).toHaveLength(BACKUP_LIMITS.objects);
    expect(parsed.skipped).toBe(30);
    expect(parsed.errors).toHaveLength(BACKUP_LIMITS.errors);
  });
});

describe("placing", () => {
  const doc = {
    version: 1,
    objects: [
      { id: "s", type: "sticky", x: 100, y: 100, frameId: "f", text: "in frame" },
      { id: "f", type: "frame", x: 0, y: 0, w: 500, h: 500, text: "F" },
      { id: "t", type: "text", x: 600, y: 0, text: "outside" },
      { id: "c", type: "connector", from: "s", to: "t" },
    ],
  };

  it("regenerates every id and remaps references; frames first, connectors last", () => {
    const parsed = parseBackup(doc);
    const { creates, idMap } = planCreates(parsed.entries, { newId: () => newId("object"), dx: 10, dy: -10 });
    expect(creates.map((c) => c.type)).toEqual(["frame", "sticky", "text", "connector"]);
    expect(creates.every((c) => isId(c.id) && !["s", "f", "t", "c"].includes(c.id))).toBe(true);
    expect(new Set(creates.map((c) => c.id)).size).toBe(4);
    const [frame, sticky, text, conn] = creates;
    expect(sticky.frameId).toBe(frame.id);
    expect(text.frameId).toBeNull();
    expect(conn).toMatchObject({ from: sticky.id, to: text.id });
    expect(sticky).toMatchObject({ x: 110, y: 90 });
    expect(idMap.get("s")).toBe(sticky.id);
    for (const c of creates) expect(c).not.toHaveProperty("z");
  });

  it("stops at `max`, dropping connectors whose ends did not make it", () => {
    const parsed = parseBackup(doc);
    const { creates, dropped } = planCreates(parsed.entries, { newId: () => newId("object"), max: 2 });
    expect(creates.map((c) => c.type)).toEqual(["frame", "sticky"]);
    expect(dropped).toBe(2);
  });

  it("centres on a point, and places imports right of existing content", () => {
    const parsed = parseBackup(doc);
    expect(entriesBounds(parsed.entries)).toEqual({ x: 0, y: 0, w: 840, h: 500 });
    expect(offsetToCenter(parsed.entries, { x: 1000, y: 1000 })).toEqual({ dx: 580, dy: 750 });
    expect(importOffset(parsed.entries, {}, null)).toEqual({ dx: 0, dy: 0 });
    expect(importOffset(parsed.entries, board(obj("rect", { x: -50, y: 30, w: 100, h: 100 })), null)).toEqual({ dx: 250, dy: 30 });
    expect(importOffset(parsed.entries, {}, { x: 7, y: 8 })).toEqual({ dx: 7, dy: 8 });
  });
});

describe("plain text", () => {
  it("makes one sticky per non-empty line in a square-ish grid", () => {
    const { entries, truncated } = textToEntries("one\r\n\n  two  \nthree\nfour\nfive\n");
    expect(truncated).toBe(0);
    expect(entries.map((e) => e.object.text)).toEqual(["one", "two", "three", "four", "five"]);
    expect(entries.map((e) => [e.object.x, e.object.y])).toEqual([[0, 0], [240, 0], [480, 0], [0, 240], [240, 240]]);
    expect(entries.every((e) => e.object.type === "sticky")).toBe(true);
  });

  it("keeps a tab-separated table's rows and columns", () => {
    const { entries } = textToEntries("a\tb\tc\n\nd\t\tf\n");
    expect(entries.map((e) => [e.object.text, e.object.x / 240, e.object.y / 240])).toEqual([
      ["a", 0, 0], ["b", 1, 0], ["c", 2, 0], ["d", 0, 1], ["f", 2, 1],
    ]);
  });

  it("caps the number of notes and the text of each", () => {
    const lines = Array.from({ length: BACKUP_LIMITS.textStickies + 5 }, (_, i) => `line ${i}`);
    const { entries, truncated } = textToEntries(lines.join("\n"));
    expect(entries).toHaveLength(BACKUP_LIMITS.textStickies);
    expect(truncated).toBe(5);
    expect(textToEntries("x".repeat(LIMITS.text + 10)).entries[0].object.text).toHaveLength(LIMITS.text);
    expect(textToEntries("‮evil\u0007").entries[0].object.text).toBe("evil");
    expect(textToEntries(" \n\t\n").entries).toEqual([]);
  });
});
