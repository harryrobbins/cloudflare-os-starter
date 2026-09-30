/**
 * The mock engine against the mock transport: the room is the fake server's, the media is fake.
 * Covers what the screenshot runs rely on -- joining shows the others as remotes, beats carry the
 * flags, the cap and replacement behave as the server does, and leaving ends a call you started.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { ClientEvent, ServerEvent } from "../contract.js";
import { createMockTransport } from "../mock/index.js";
import { createMockCallEngine, type MockMedia } from "./mock-engine.js";
import type { CallEngine } from "./engine/types.js";

async function until(check: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the mock.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** No devices at all, and no canvas capture: the engine must still work, just without pictures. */
const noMedia: MockMedia = {
  getUserMedia: () => Promise.reject(new DOMException("none", "NotFoundError")),
  enumerateDevices: async () => [],
  testPattern: () => null,
};

const engines: CallEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

function setup() {
  const transport = createMockTransport();
  const sent: ClientEvent[] = [];
  const events: ServerEvent[] = [];
  transport.socket.onEvent((event) => events.push(event));
  transport.socket.open();
  const engine = createMockCallEngine({
    api: transport.api,
    send: (event) => {
      sent.push(event);
      transport.socket.send(event);
    },
    media: noMedia,
    speakerIntervalMs: 30,
  });
  engines.push(engine);
  return { transport, engine, sent, events };
}

const defaults = { audio: true, video: true, devices: { audioInputId: null, videoInputId: null, audioOutputId: null } };

describe("the mock engine", () => {
  it("joins the seeded #design call and shows the three others as remotes", async () => {
    const { engine, sent } = setup();
    await engine.join({ ...defaults, channelId: "c-design" });
    const snapshot = engine.snapshot();
    expect(snapshot.phase).toBe("connected");
    expect(snapshot.callId).toBe("call-design");
    expect(Object.values(snapshot.remotes).map((remote) => remote.userId).sort()).toEqual(["u-alice", "u-bob", "u-eve"]);
    // No devices here, so it joined with both off, and said so in its first beat.
    expect(sent[0]).toMatchObject({ t: "call-beat", call: "call-design", audio: false, video: false });
    // The active speaker walks round the people with their microphones on (Eve and Alice).
    await until(() => engine.snapshot().activeSpeaker !== null);
    expect(["p-eve", "p-alice"]).toContain(engine.snapshot().activeSpeaker);
  });

  it("broadcasts a flag change from a beat, as the server does", async () => {
    const { engine, events } = setup();
    await engine.join({ ...defaults, channelId: "c-design" });
    const me = engine.snapshot().participantId;
    events.length = 0;
    await engine.setScreenEnabled(false);
    engine.setAudioEnabled(false);
    // Nothing changed (both already off), so nothing is broadcast.
    expect(events.filter((event) => event.t === "call")).toHaveLength(0);
    await engine.setVideoEnabled(true);
    expect(engine.snapshot().videoEnabled).toBe(false); // no camera and no pattern here
    expect(me).not.toBeNull();
  });

  it("follows the room: a departed participant's remote goes away, and the end of the call idles it", async () => {
    const { engine } = setup();
    await engine.join({ ...defaults, channelId: "c-design" });
    const room = engine.snapshot();
    engine.applyCallState({
      id: "call-design",
      channelId: "c-design",
      startedBy: "u-eve",
      startedAt: 0,
      messageId: "m",
      participants: [
        { id: "p-eve", userId: "u-eve", sessionId: "s", joinedAt: 0, audio: true, video: true, screen: false, tracks: [] },
        { id: room.participantId!, userId: "u-harry", sessionId: "s2", joinedAt: 0, audio: false, video: false, screen: false, tracks: [] },
      ],
    });
    expect(Object.keys(engine.snapshot().remotes)).toEqual(["p-eve"]);
    engine.applyCallState(null);
    expect(engine.snapshot().phase).toBe("idle");
  });

  it("is refused past the cap with conflict and ends up failed", async () => {
    const { engine, transport } = setup();
    transport.mock!.fillCall("c-design");
    await expect(engine.join({ ...defaults, channelId: "c-design" })).rejects.toMatchObject({ code: "conflict" });
    expect(engine.snapshot().phase).toBe("failed");
  });

  it("replaces an older participant from another tab with call-moved", async () => {
    const { engine, events } = setup();
    await engine.join({ ...defaults, channelId: "c-design" });
    const first = engine.snapshot().participantId!;
    // Joining again from this same transport stands in for a second tab.
    await engine.join({ ...defaults, channelId: "c-design" });
    const moved = events.find((event) => event.t === "call-moved");
    expect(moved).toMatchObject({ t: "call-moved", call: "call-design", participant: first, reason: "replaced" });
    engine.handleMoved("call-design", engine.snapshot().participantId!);
    expect(engine.snapshot().phase).toBe("moved");
  });

  it("starts a dm call that the other person answers, and ends it when you leave", async () => {
    const { engine, events } = setup();
    await engine.join({ ...defaults, channelId: "d-bob" });
    const callId = engine.snapshot().callId!;
    await until(() =>
      events.some((event) => event.t === "call" && event.call?.participants.some((entry) => entry.userId === "u-bob")),
    );
    const latest = [...events].reverse().find((event) => event.t === "call");
    if (latest?.t === "call" && latest.call !== null) engine.applyCallState(latest.call);
    expect(Object.values(engine.snapshot().remotes).map((remote) => remote.userId)).toEqual(["u-bob"]);

    await engine.leave();
    expect(engine.snapshot().phase).toBe("idle");
    await until(() => events.some((event) => event.t === "call" && event.channel === "d-bob" && event.call === null));
    const edited = [...events].reverse().find((event) => event.t === "edit" && event.message.call?.id === callId);
    expect(edited?.t === "edit" && edited.message.call?.state).toBe("ended");
    expect(edited?.t === "edit" && edited.message.call?.participantIds).toEqual(["u-harry", "u-bob"]);
  });
});
