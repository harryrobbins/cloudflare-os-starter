// History replay (src/client/ui/history.js, pure parts): a blip created with text shows that text
// at its create step. The core commits the create and the seeded text as two events in one commit,
// so the replay maps the create step to the seed's sequence (seededSeqs + replaySeq). Events and
// playback come from the real core.
import { describe, expect, it } from "vitest";
import { createdSeqs, replaySeq, seededSeqs, textAtSeq } from "../../src/client/ui/history.js";
import { create, edit, nextId, setup } from "../core/wave-helpers.js";

async function eventsOf(wave) {
  return (await wave.getChanges({ afterSeq: 0, limit: 1000 })).events;
}

/** The text History shows for `id` with the scrubber at `seq`. */
async function shownAt(wave, events, id, seq) {
  const playback = await wave.getPlayback({ blipId: id });
  return textAtSeq(playback, replaySeq(seq, createdSeqs(events).get(id), seededSeqs(events).get(id))).text;
}

describe("History: seeded text at the create step", () => {
  it("shows a blip created with text as that text at its create step, and later edits only after their own step", async () => {
    const { wave } = setup();
    const { id } = await create(wave, { text: "v1." });
    await edit(wave, id, (t) => t.insert(t.length, " v2."));
    const events = await eventsOf(wave);
    const createSeq = createdSeqs(events).get(id);
    const seed = seededSeqs(events).get(id);
    expect(events.find((e) => e.seq === createSeq).kind).toBe("blip.create");
    expect(seed).toBe(createSeq + 1); // a separate event, same commit
    const pushSeq = events.at(-1).seq;
    // Before the fix the create step replayed to "" (the "(empty)" placeholder).
    expect(textAtSeq(await wave.getPlayback({ blipId: id }), createSeq).text).toBe("");
    expect(await shownAt(wave, events, id, createSeq)).toBe("v1.");
    expect(await shownAt(wave, events, id, seed)).toBe("v1.");
    expect(await shownAt(wave, events, id, pushSeq - 1)).toBe("v1.");
    expect(await shownAt(wave, events, id, pushSeq)).toBe("v1. v2.");
  });

  it("a blip created empty has no seed (its create step is honestly empty); its first push is not taken for one", async () => {
    const { wave } = setup();
    const { id } = await create(wave, {});
    await edit(wave, id, (t) => t.insert(0, "typed later"));
    const events = await eventsOf(wave);
    expect(seededSeqs(events).has(id)).toBe(false);
    expect(await shownAt(wave, events, id, createdSeqs(events).get(id))).toBe("");
    expect(await shownAt(wave, events, id, events.at(-1).seq)).toBe("typed later");
  });

  it("finds each seed in a multi-create commit (a template) and in reply / agent-style creates", async () => {
    const { wave } = setup();
    const a = nextId(), b = nextId(), c = nextId();
    await wave.applyOperation({
      by: "Ann", senderId: "s1", requestId: "tpl-1", structure: { template: "decision" },
      blipOps: [
        { op: "create", blipId: a, parentId: null, kind: "brief", text: "# Brief" },
        { op: "create", blipId: b, parentId: null },
        { op: "create", blipId: c, parentId: a, text: "Option A" },
      ],
    });
    const r = await wave.reply({ parentId: a, text: "A reply", by: "Bob", senderId: "s2", requestId: "reply-1" });
    const events = await eventsOf(wave);
    const seeds = seededSeqs(events);
    expect([...seeds.keys()].sort()).toEqual([a, c, r.blip.id].sort());
    expect(seeds.has(b)).toBe(false);
    const created = createdSeqs(events);
    expect(await shownAt(wave, events, a, created.get(a))).toBe("# Brief");
    expect(await shownAt(wave, events, c, created.get(c))).toBe("Option A");
    expect(await shownAt(wave, events, r.blip.id, created.get(r.blip.id))).toBe("A reply");
    expect(await shownAt(wave, events, b, created.get(b))).toBe("");
  });

  it("replaySeq leaves positions outside the create commit alone", () => {
    expect(replaySeq(4, 5, 6)).toBe(4);
    expect(replaySeq(5, 5, 6)).toBe(6);
    expect(replaySeq(6, 5, 6)).toBe(6);
    expect(replaySeq(9, 5, 6)).toBe(9);
    expect(replaySeq(5, undefined, 6)).toBe(5);
    expect(replaySeq(5, 5, undefined)).toBe(5);
  });
});
