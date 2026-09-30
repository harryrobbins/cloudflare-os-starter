// Server tests in workerd: the Gadget Durable Object over real DO storage and RPC callbacks, and
// the export handler's Markdown, WAV and MIDI.
import { env, RpcTarget } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ExportHandler } from "../../src/server/index.js";

class Listener extends RpcTarget {
  views = [];
  update(view) { this.views.push(view); }
}

const fresh = () => env.GADGET.get(env.GADGET.idFromName(crypto.randomUUID()));
const alice = { id: "alice@x", name: "Alice" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bytes = async (stream) => new Uint8Array(await new Response(stream).arrayBuffer());

describe("Gadget", () => {
  it("stocks the arcade, saves code, records scores and pushes views", async () => {
    const g = fresh();
    const l = new Listener();
    const view = await g.subscribe(l, { clientId: "a1", viewerId: alice.id });
    expect(view.games.map((x) => x.title)).toEqual(["Invaders", "Rocks", "Blocks", "Bricks", "Number Gulper", "Teletext Tables", "Dark Room"]);
    expect(view.tunes.length).toBe(5);
    const blocks = view.games.find((x) => x.title === "Blocks");
    const full = await g.getGame(blocks.id);
    expect(full.source).toContain("export default");
    const saved = await g.saveGame({ by: alice, gameId: blocks.id, source: full.source + "\n// tweak", baseVersion: full.version });
    expect(saved.version).toBe(2);
    await g.submitScore({ by: alice, gameId: blocks.id, score: 1234 });
    await sleep(50);
    expect(l.views.at(-1).games.find((x) => x.id === blocks.id).scores[0]).toMatchObject({ name: "Alice", score: 1234 });
    expect((await g.getTemplates()).find((t) => t.id === "blank").source).toContain("export default");
    expect((await g.getGame("nope")).error).toBeTruthy();
  });

  it("exports Markdown, code, WAV and MIDI", async () => {
    const g = fresh();
    const handler = new ExportHandler(/** @type {any} */ ({}), /** @type {any} */ ({}));
    const formats = await handler.getExportFormats(g);
    expect(formats.length).toBeLessThanOrEqual(32);
    expect(formats.map((f) => f.id).slice(0, 2)).toEqual(["summary", "code"]);
    const wav = formats.find((f) => f.id.startsWith("wav:") && f.label.startsWith("Game over"));
    const midi = formats.find((f) => f.id.startsWith("midi:") && f.label.startsWith("Korobeiniki"));
    const md = await new Response(await handler.export(g, "summary")).text();
    expect(md).toContain("## Tunes");
    expect(await new Response(await handler.export(g, "code")).text()).toContain("```js");
    const w = await bytes(await handler.export(g, wav.id));
    expect(new TextDecoder().decode(w.slice(0, 4))).toBe("RIFF");
    expect(w.length).toBeGreaterThan(44 + 22050);
    const m = await bytes(await handler.export(g, midi.id));
    expect(new TextDecoder().decode(m.slice(0, 4))).toBe("MThd");
  });

  it("survives a restart with the same data", async () => {
    const id = env.GADGET.idFromName(crypto.randomUUID());
    const g = env.GADGET.get(id);
    await g.setTitle({ by: alice, title: "Staff room arcade" });
    const again = env.GADGET.get(id);
    const v = await again.getView(alice.id);
    expect(v.title).toBe("Staff room arcade");
    expect(v.games).toHaveLength(7);
  });
});
