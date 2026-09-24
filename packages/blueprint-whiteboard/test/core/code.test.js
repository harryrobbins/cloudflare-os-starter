// Code blocks in the whiteboard rules: creation through the normal path (defaults, fitted height,
// limits), updates and undo, history summaries, findObjects, the addCode convenience method, the
// SVG export, backup round trips, and boards stored before code blocks existed (no schema bump).
import { describe, expect, it } from "vitest";
import { LIMITS, SCHEMA_VERSION } from "../../src/shared/protocol.js";
import { InMemoryRepository } from "../../src/core/repository.js";
import { createWhiteboard, migrate } from "../../src/core/whiteboard.js";
import { exportData, importData } from "../../src/core/backup.js";
import { codeHeight } from "../../src/shared/code/layout.js";
import { apply, create, oid, setup, updateOp } from "./helpers.js";

const code = (extra = {}) => ({ type: "code", text: "print('hi')", language: "python", ...extra });

describe("code objects", () => {
  it("creates code blocks with defaults and a height fitted to the code; never rotated", async () => {
    const { board } = setup();
    const { obj } = await create(board, code({ text: "a\nb\nc", rot: 30 }));
    expect(obj).toMatchObject({ type: "code", language: "python", theme: "light", lineNumbers: true, wrap: false, filename: "", rot: 0, w: 480 });
    expect(obj.h).toBe(codeHeight(obj));
    const { obj: sized } = await create(board, code({ h: 400 }));
    expect(sized.h).toBe(400);
  });

  it("applies the code limits and the per-object byte budget", async () => {
    const { board } = setup();
    const { obj } = await create(board, code({ text: "x".repeat(LIMITS.codeText + 10) }));
    expect(obj.text).toHaveLength(LIMITS.codeText);
    // A tight budget refuses an oversized code block with `limit`, like any object.
    const small = setup({ limits: { objectBytes: 1000 } });
    const r = await apply(small.board, { objectOps: [{ op: "create", object: { id: oid(), ...code({ text: "y".repeat(5000) }) } }] });
    expect(r.errors.map((e) => e.code)).toEqual(["limit"]);
  });

  it("updates code fields, summarises by language, and undoes", async () => {
    const { board } = setup();
    const { id, obj, result } = await create(board, code());
    expect(result.history.summary).toBe("Added a Python code block");
    const r = await apply(board, { by: "Tester", objectOps: [updateOp(id, obj.version, { language: "rb", theme: "dark", wrap: true, filename: "x.rb", lineNumbers: false, rot: 90 })] });
    expect(r.upserts[0]).toMatchObject({ language: "ruby", theme: "dark", wrap: true, filename: "x.rb", lineNumbers: false, rot: 0 });
    expect(r.history.summary).toBe("Edited a Ruby code block");
    await board.undo({ by: "Tester" });
    const back = (await board.getBoard()).objects[id];
    expect(back).toMatchObject({ language: "python", theme: "light", wrap: false, filename: "", lineNumbers: true });
    // An update changing only a code field is a real change (not dropped as a no-op).
    const again = await apply(board, { objectOps: [updateOp(id, back.version, { wrap: true })] });
    expect(again.status).toBe("applied");
  });

  it("findObjects filters by type code and by the code's text", async () => {
    const { board } = setup();
    await create(board, code({ text: "SELECT secret_column FROM t", language: "sql" }));
    await create(board, { type: "sticky", text: "secret_column" });
    expect((await board.findObjects({ type: "code" })).map((o) => o.language)).toEqual(["sql"]);
    expect(await board.findObjects({ type: "code", text: "SECRET_COLUMN" })).toHaveLength(1);
  });

  it("exportSvg draws highlighted tokens and escapes the code", async () => {
    const { board } = setup();
    await create(board, code({ text: "def f(): return '</text><script>'" }));
    const svg = await board.exportSvg();
    expect(svg).toContain(">def</tspan>");
    expect(svg).not.toContain("<script");
    expect(svg).toContain("&lt;/text&gt;&lt;script&gt;");
  });
});

describe("addCode", () => {
  it("adds one block: guessed or named language, file name, placement, fitted height", async () => {
    const { board } = setup();
    await create(board, { type: "sticky", x: 0, y: 0 });
    const { block, errors } = await board.addCode({ by: "Agent", code: "package main\n\nfunc main() {}\n", title: "main.go" });
    expect(errors).toEqual([]);
    expect(block).toMatchObject({ type: "code", language: "go", filename: "main.go", createdBy: "Agent", x: 400, y: 0 });
    expect(block.h).toBe(codeHeight(block));
    const named = await board.addCode({ code: "x", language: "TS", at: { x: 10, y: 20 }, theme: "dark", wrap: true, lineNumbers: false, fontSize: 18, w: 300 });
    expect(named.block).toMatchObject({ language: "typescript", x: 10, y: 20, theme: "dark", wrap: true, lineNumbers: false, w: 300, style: { fontSize: 18 } });
  });

  it("places into a frame by name and reports bad input", async () => {
    const { board } = setup();
    const { frame } = await board.addFrame({ name: "Snippets", x: 1000, y: 1000, w: 800, h: 600 });
    const { block } = await board.addCode({ code: "a", language: "plain", frame: "snippets" });
    expect(block).toMatchObject({ frameId: frame.id, x: 1040, y: 1040 });
    expect((await board.addCode({ code: 42 })).errors[0].code).toBe("invalid_op");
    expect((await board.addCode({ code: "a", language: "klingon" })).errors[0].message).toMatch(/Unknown language/);
    expect((await board.addCode({ code: "a", frame: "nope" })).errors[0].code).toBe("invalid_ref");
  });
});

describe("backup round trip", () => {
  it("exportData and importData keep every code field", async () => {
    const a = setup();
    await a.board.addCode({ code: "SELECT 1;", language: "sql", theme: "dark", filename: "q.sql", wrap: true, lineNumbers: false });
    const doc = await exportData(a.board);
    const b = setup();
    const r = await importData(b.board, { data: JSON.parse(JSON.stringify(doc)), by: "Importer" });
    expect(r.errors).toEqual([]);
    const [o] = Object.values((await b.board.getBoard()).objects);
    expect(o).toMatchObject({ type: "code", text: "SELECT 1;", language: "sql", theme: "dark", filename: "q.sql", wrap: true, lineNumbers: false });
  });
});

describe("stored data compatibility", () => {
  it("keeps schemaVersion 1: a board stored before code blocks existed loads unchanged and takes code", async () => {
    expect(SCHEMA_VERSION).toBe(1);
    const repo = new InMemoryRepository();
    const meta = { schemaVersion: 1, revision: 4, title: "Before code", background: "dots", lastModified: 5 };
    const rect = {
      id: "o_0000000000b1", type: "rect", x: 0, y: 0, w: 200, h: 120, rot: 0, z: "a0", frameId: null, text: "old",
      style: { fill: "#ffffff", stroke: "#1f2937", strokeWidth: 2, textColor: "#1f2937", fontSize: 18, align: "center", arrowStart: "none", arrowEnd: "none" },
      version: 2, createdAt: 1, updatedAt: 2, createdBy: "Ann",
    };
    await repo.commit({ meta, putObjects: [rect], history: [] });
    expect(migrate(meta)).toBe(meta);
    const board = createWhiteboard(repo);
    const snap = await board.getBoard();
    expect(snap.objects[rect.id]).toEqual(rect);
    const { block } = await board.addCode({ code: "echo hi", language: "sh" });
    expect(block.language).toBe("bash");
    expect((await repo.getMeta()).schemaVersion).toBe(1);
    expect(await board.exportSvg()).toContain(">old<");
  });
});
