import { describe, expect, it, vi } from "vitest";
import { InMemoryRepository } from "../../src/core/repository.js";
import { createWhiteboard } from "../../src/core/whiteboard.js";
import { diagramHash } from "../../src/shared/diagram.js";
import { apply, updateOp } from "./helpers.js";

const svg = (label) => `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><text>${label}</text></svg>`;

function setup(renderDiagram) {
  const repo = new InMemoryRepository();
  let t = 1_700_000_000_000;
  const board = createWhiteboard(repo, { now: () => (t += 1000), renderDiagram });
  return { repo, board };
}

async function addDiagram(board, fields = {}) {
  const { created, errors } = await board.addObjects({ objects: [{ type: "diagram", source: "a -> b", ...fields }] });
  expect(errors).toEqual([]);
  return created[0];
}

describe("diagram renders", () => {
  it("renders once per source, caches in the repository, and passes the request through", async () => {
    const render = vi.fn(async (req) => ({ data: new TextEncoder().encode(svg(req.source)) }));
    const { board, repo } = setup(render);
    const d = await addDiagram(board, { language: "mermaid", layout: "elk" });
    expect(d).toMatchObject({ syntax: "mermaid", layout: "elk", text: "a -> b" });
    const [r1, r2] = await Promise.all([board.diagramRender(d.id), board.diagramRender(d.id)]);
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0][0]).toMatchObject({ source: "a -> b", language: "mermaid", layout: "elk", format: "svg" });
    expect(r1).toMatchObject({ id: d.id, hash: diagramHash(d), status: "ok", w: 100, h: 50 });
    expect(r1.svg).toContain("a -> b");
    expect(r2.svg).toBe(r1.svg);
    expect((await repo.getRender(d.id)).hash).toBe(diagramHash(d));
    // A new board over the same storage uses the stored render.
    const again = createWhiteboard(repo, { renderDiagram: render });
    await again.diagramRender(d.id);
    expect(render).toHaveBeenCalledTimes(1);
    // A source change renders again; a move does not.
    await apply(board, { objectOps: [updateOp(d.id, d.version, { x: 500 })] });
    await board.diagramRender(d.id);
    expect(render).toHaveBeenCalledTimes(1);
    await board.updateObjects({ updates: [{ id: d.id, fields: { text: "b -> c" } }] });
    expect((await board.diagramRender(d.id)).svg).toContain("b -> c");
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("reports renderer errors and non-SVG output as errors, and no renderer as unavailable", async () => {
    const { board } = setup(async () => { throw new Error("invalid_request: syntax error\non line 2"); });
    const d = await addDiagram(board);
    expect(await board.diagramRender(d.id)).toMatchObject({ status: "error", error: "invalid_request: syntax error on line 2" });
    const html = setup(async () => ({ data: "<html><script></script></html>" }));
    const d2 = await addDiagram(html.board);
    expect(await html.board.diagramRender(d2.id)).toMatchObject({ status: "error" });
    const none = setup(null);
    const d3 = await addDiagram(none.board);
    expect(await none.board.diagramRender(d3.id)).toMatchObject({ status: "unavailable", hash: diagramHash(d3) });
  });

  it("keeps no render for a source that changed while it was made, and none for deleted diagrams", async () => {
    /** @type {(v: any) => void} */
    let release = () => {};
    const render = vi.fn(() => new Promise((r) => { release = r; }));
    const { board, repo } = setup(render);
    const d = await addDiagram(board);
    const pending = board.diagramRender(d.id);
    await vi.waitFor(() => expect(render).toHaveBeenCalled());
    await board.updateObjects({ updates: [{ id: d.id, fields: { text: "changed" } }] });
    release({ data: svg("old") });
    expect((await pending).status).toBe("ok");
    expect(await repo.getRender(d.id)).toBeNull();
    const fresh = setup(async () => ({ data: svg("x") }));
    const e = await addDiagram(fresh.board);
    await fresh.board.diagramRender(e.id);
    expect(await fresh.repo.getRender(e.id)).not.toBeNull();
    await fresh.board.deleteObjects({ ids: [e.id] });
    await vi.waitFor(async () => expect(await fresh.repo.getRender(e.id)).toBeNull());
    expect(await fresh.board.diagramRender(e.id)).toBeNull();
    expect(await fresh.board.diagramRender("o_ffffffffffff")).toBeNull();
    expect(await fresh.board.diagramRender(42)).toBeNull();
  });

  it("exports diagrams from their cached renders, never waiting for the renderer", async () => {
    const render = vi.fn(async () => ({ data: svg("exported") }));
    const { board } = setup(render);
    const d = await addDiagram(board);
    expect(await board.exportSvg()).not.toContain("<image");
    expect(render).not.toHaveBeenCalled();
    await board.diagramRender(d.id);
    expect(await board.exportSvg()).toContain('href="data:image/svg+xml;base64,');
  });
});

describe("tables through the board", () => {
  it("addObjects takes rows, updates cells, undo restores them; history names them", async () => {
    const { board } = setup(null);
    const { created } = await board.addObjects({ by: "Ann", objects: [{ type: "table", rows: [["Name", "Role"], ["Ann", "Lead"]], header: true }] });
    const t = created[0];
    expect(t).toMatchObject({ type: "table", cells: [["Name", "Role"], ["Ann", "Lead"]], header: true, text: "" });
    const r = await board.updateObjects({ by: "Ann", updates: [{ id: t.id, fields: { cells: [["Name", "Role"], ["Ann", "Owner"]] } }] });
    expect(r.result.upserts[0].cells[1][1]).toBe("Owner");
    // An update with the same cells changes nothing.
    const same = await board.updateObjects({ by: "Ann", updates: [{ id: t.id, fields: { cells: [["Name", "Role"], ["Ann", "Owner"]] } }] });
    expect(same.result.upserts).toEqual([]);
    await board.undo({ by: "Ann" });
    expect((await board.getBoard()).objects[t.id].cells[1][1]).toBe("Lead");
    const history = await board.getHistory(5);
    expect(history.some((e) => /table/.test(e.summary))).toBe(true);
  });
});
