import { describe, expect, it } from "vitest";
import { ArcadeService, InMemoryRepository } from "../../src/core/store.js";
import { STARTER_TUNES } from "../../src/tunes/starter.js";

const alice = { id: "alice@x", name: "Alice" };
const bob = { id: "bob@x", name: "Bob" };
const SRC = "export const config = { title: 'T' };\nexport default function game(a) { return { update() {}, draw(g) { g.cls(1); } }; }\n";
const templates = [
  { id: "invaders", title: "Invaders", description: "d", kind: "arcade", source: SRC + "// invaders" },
  { id: "blank", title: "Blank cartridge", description: "b", kind: "template", source: SRC + "// blank" },
];
let n = 0;
const fresh = (repo = new InMemoryRepository()) => ({ repo, svc: new ArcadeService(repo, { templates, starterTunes: STARTER_TUNES, now: () => ++n * 1000 }) });

describe("ArcadeService", () => {
  it("stocks a new arcade with starter games (not the blank template) and tunes, once", async () => {
    const { repo, svc } = fresh();
    const v = await svc.view(alice.id);
    expect(v.games.map((g) => g.title)).toEqual(["Invaders"]);
    expect(v.tunes.map((t) => t.song.title)).toEqual(STARTER_TUNES.map((t) => t.title));
    expect(v.templates.map((t) => t.id)).toEqual(["invaders", "blank"]);
    expect(v.prefs.layout).toBe("auto");
    const again = new ArcadeService(repo, { templates, starterTunes: STARTER_TUNES });
    expect((await again.view(bob.id)).games).toHaveLength(1);
  });

  it("creates, saves with version checks, duplicates, resets and deletes games", async () => {
    const { repo, svc } = fresh();
    const made = await svc.write("createGame", { by: alice, template: "blank", title: "My game" });
    expect(made.game).toMatchObject({ title: "My game", kind: "arcade", template: "blank", version: 1 });
    const id = made.game.id;
    expect((await svc.write("saveGame", { by: alice, gameId: id, source: SRC + "// v2", baseVersion: 1 })).version).toBe(2);
    const clash = await svc.write("saveGame", { by: bob, gameId: id, source: SRC + "// bob", baseVersion: 1 });
    expect(clash.error).toMatch(/Alice saved this game/);
    expect((await svc.write("saveGame", { by: bob, gameId: id, source: "no default here" })).error).toMatch(/export default/);
    expect((await svc.read((a) => a.getGame(id))).source).toContain("// v2");
    const copy = await svc.write("duplicateGame", { by: bob, gameId: id });
    expect(copy.game.title).toBe("My game copy");
    await svc.write("resetGame", { by: alice, gameId: id });
    expect((await svc.read((a) => a.getGame(id))).source).toContain("// blank");
    await svc.write("deleteGame", { by: alice, gameId: id });
    expect((await svc.read((a) => a.getGame(id))).error).toMatch(/not in this arcade/);
    // Persisted: a fresh service over the same storage agrees.
    const again = new ArcadeService(repo, { templates, starterTunes: STARTER_TUNES });
    expect((await again.view(alice.id)).games.map((g) => g.title)).toEqual(["Invaders", "My game copy"]);
  });

  it("keeps each player's best score and the top twenty", async () => {
    const { svc } = fresh();
    const gameId = (await svc.view(alice.id)).games[0].id;
    expect(await svc.write("submitScore", { by: alice, gameId, score: 500 })).toMatchObject({ rank: 1, recorded: true });
    expect(await svc.write("submitScore", { by: alice, gameId, score: 300 })).toMatchObject({ rank: null, best: 500, recorded: false });
    expect(await svc.write("submitScore", { by: bob, gameId, score: 900, detail: "level 3" })).toMatchObject({ rank: 1 });
    for (let i = 0; i < 25; i++) await svc.write("submitScore", { by: { id: `p${i}`, name: `P${i}` }, gameId, score: 1000 + i });
    const scores = (await svc.view(alice.id)).games[0].scores;
    expect(scores).toHaveLength(10);
    expect(scores[0]).toMatchObject({ name: "P24", score: 1024 });
    expect((await svc.write("submitScore", { by: alice, gameId, score: -1 })).error).toBeTruthy();
    expect(await svc.write("submitScore", { by: { id: "late", name: "Late" }, gameId, score: 1 })).toMatchObject({ recorded: false });
  });

  it("saves tunes and validates songs", async () => {
    const { svc } = fresh();
    const made = await svc.write("createTune", { by: alice });
    expect(made.tune.song.channels).toHaveLength(4);
    const song = { ...made.tune.song, title: "Mine", tempo: 90 };
    expect((await svc.write("saveTune", { by: alice, tuneId: made.tune.id, song, baseVersion: 1 })).version).toBe(2);
    expect((await svc.write("saveTune", { by: bob, tuneId: made.tune.id, song, baseVersion: 1 })).error).toMatch(/saved this tune/);
    expect((await svc.write("saveTune", { by: bob, tuneId: made.tune.id, song: { ...song, channels: [] } })).error).toMatch(/at least one/);
    expect((await svc.write("saveTune", { by: bob, tuneId: made.tune.id, song: { ...song, channels: [...song.channels, song.channels[0]] } })).error).toMatch(/at most 4/);
    expect((await svc.write("saveTune", { by: bob, tuneId: made.tune.id, song: { ...song, channels: [{ wave: "kazoo" }] } })).error).toMatch(/wave/);
    expect((await svc.read((a) => a.getTune(made.tune.id))).song.title).toBe("Mine");
  });

  it("stores preferences per player and pushes per-viewer views", async () => {
    const { svc } = fresh();
    const views = { a: /** @type {any[]} */ ([]), b: /** @type {any[]} */ ([]) };
    await svc.subscribe({ update: (v) => views.a.push(v) }, { clientId: "a", viewerId: alice.id });
    await svc.subscribe({ update: (v) => views.b.push(v) }, { clientId: "b", viewerId: bob.id });
    await svc.write("setPrefs", { by: alice, layout: "bbc", custom: { fire: ["KeyM"] }, muted: true });
    await new Promise((r) => setTimeout(r, 5));
    expect(views.a.at(-1).prefs).toMatchObject({ layout: "bbc", custom: { fire: ["KeyM"] }, muted: true });
    expect(views.b.at(-1).prefs.layout).toBe("auto");
    expect((await svc.write("setPrefs", { by: alice, custom: { fire: ["Escape"] } })).error).toMatch(/Escape/);
    expect((await svc.write("setPrefs", { by: alice, layout: "joystick" })).error).toMatch(/layout/);
    // A subscriber whose delivery fails is dropped.
    await svc.subscribe({ update: () => { throw new Error("gone"); } }, { clientId: "dead", viewerId: bob.id });
    await svc.write("setTitle", { by: bob, title: "Staff room arcade" });
    await new Promise((r) => setTimeout(r, 5));
    expect(svc.subscribers.has("dead")).toBe(false);
    expect((await svc.ping("dead", bob.id)).subscribed).toBe(false);
  });

  it("writes a Markdown summary", async () => {
    const { svc } = fresh();
    const gameId = (await svc.view(alice.id)).games[0].id;
    await svc.write("submitScore", { by: alice, gameId, score: 42 });
    const md = await svc.read((a) => a.summaryMarkdown());
    expect(md).toContain("### Invaders");
    expect(md).toContain("1. Alice: 42");
    expect(md).toContain("**Korobeiniki**");
  });
});
