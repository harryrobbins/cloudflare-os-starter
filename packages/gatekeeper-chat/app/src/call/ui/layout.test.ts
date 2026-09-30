import { describe, expect, it } from "vitest";

import { IDLE_CALL } from "../../store/calls.js";
import { formatCallDuration, type CallState, type User } from "../../contract.js";
import { remoteTiles } from "./CallPanel.js";
import {
  callEndedText,
  gridRows,
  mediaHelp,
  participantNames,
  tileSizeFor,
} from "./layout.js";

describe("gridRows", () => {
  it("lays out the full page: 1 full, 2 side by side, 2x2 for 3-4, 3+2 for 5", () => {
    expect(gridRows(0, false)).toEqual([]);
    expect(gridRows(1, false)).toEqual([1]);
    expect(gridRows(2, false)).toEqual([2]);
    expect(gridRows(3, false)).toEqual([2, 1]);
    expect(gridRows(4, false)).toEqual([2, 2]);
    expect(gridRows(5, false)).toEqual([3, 2]);
  });

  it("stacks in a narrow pane", () => {
    expect(gridRows(1, true)).toEqual([1]);
    expect(gridRows(2, true)).toEqual([1, 1]);
    expect(gridRows(3, true)).toEqual([2, 1]);
    expect(gridRows(5, true)).toEqual([2, 2, 1]);
  });

  it("never loses a tile", () => {
    for (let count = 0; count <= 6; count++) {
      for (const narrow of [false, true]) {
        expect(gridRows(count, narrow).reduce((sum, row) => sum + row, 0)).toBe(count);
      }
    }
  });
});

describe("tileSizeFor", () => {
  it("maps drawn width to a layer, with the stage always large and hidden tiles hidden", () => {
    expect(tileSizeFor(800)).toBe("large");
    expect(tileSizeFor(640)).toBe("large");
    expect(tileSizeFor(400)).toBe("medium");
    expect(tileSizeFor(120)).toBe("small");
    expect(tileSizeFor(120, { stage: true })).toBe("large");
    expect(tileSizeFor(800, { hidden: true })).toBe("hidden");
    expect(tileSizeFor(0)).toBe("hidden");
  });
});

describe("the history line", () => {
  const names: Record<string, string> = { h: "Harry Robbins", a: "Alice Chen", b: "Bob Okafor" };

  it("reads 'Call ended · 23 min · Harry, Alice, Bob'", () => {
    expect(
      callEndedText(
        { id: "c", state: "ended", startedAt: 0, endedAt: 23 * 60_000, participantIds: ["h", "a", "b"] },
        (id) => names[id],
      ),
    ).toBe("Call ended · 23 min · Harry, Alice, Bob");
  });

  it("formats durations", () => {
    expect(formatCallDuration(20_000)).toBe("under a minute");
    expect(formatCallDuration(60 * 60_000)).toBe("1 h");
    expect(formatCallDuration(65 * 60_000)).toBe("1 h 5 min");
  });

  it("shortens a long list of people", () => {
    expect(participantNames(["h", "a", "b", "h", "a", "b"], (id) => names[id])).toBe("Harry, Alice, Bob, Harry +2");
    expect(participantNames(["zz"], () => undefined)).toBe("Someone");
  });
});

describe("mediaHelp", () => {
  it("mentions the side panel only inside a frame", () => {
    expect(mediaHelp({ framed: false })).not.toMatch(/side panel/u);
    expect(mediaHelp({ framed: true })).toMatch(/side panel, it may need an update/u);
  });
});

describe("remoteTiles", () => {
  const users: Record<string, User> = {
    a: { id: "a", name: "Alice Chen", email: null, avatarKey: null, firstSeenAt: 0, lastSeenAt: 0, tz: null, online: true },
  };
  const room: CallState = {
    id: "call",
    channelId: "c1",
    startedBy: "a",
    startedAt: 0,
    messageId: "m",
    participants: [
      { id: "p-a", userId: "a", sessionId: "s", joinedAt: 0, audio: false, video: true, screen: false, tracks: [] },
      { id: "p-me", userId: "me", sessionId: "s2", joinedAt: 0, audio: true, video: true, screen: false, tracks: [] },
    ],
  };

  it("lists everyone but this frame's participant, with the room's flags", () => {
    const tiles = remoteTiles(room, { ...IDLE_CALL, participantId: "p-me", activeSpeaker: "p-a" }, users);
    expect(tiles).toEqual([
      {
        key: "p-a",
        userId: "a",
        name: "Alice Chen",
        stream: null,
        audioOn: false,
        // Camera on in the room, but no media pulled yet: the monogram until frames arrive.
        videoOn: false,
        speaking: true,
        paused: false,
      },
    ]);
  });

  it("carries each remote's quality, and pauses a camera that is on in audio-only mode or when its pull is", () => {
    const media = {
      participantId: "p-a",
      userId: "a",
      video: null,
      screen: null,
      audio: null,
      videoRid: null,
      quality: "fair" as const,
    };
    const base = { ...IDLE_CALL, participantId: "p-me", remotes: { "p-a": media } };
    expect(remoteTiles(room, base, users)[0]).toMatchObject({ quality: "fair", paused: false });
    expect(remoteTiles(room, { ...base, audioOnly: true }, users)[0]?.paused).toBe(true);
    expect(remoteTiles(room, { ...base, remotes: { "p-a": { ...media, videoPaused: true } } }, users)[0]?.paused).toBe(true);
    // A camera that is off is just off, whatever the engine says about the pull.
    const cameraOff = { ...room, participants: room.participants.map((p) => ({ ...p, video: false })) };
    expect(remoteTiles(cameraOff, { ...base, audioOnly: true }, users)[0]?.paused).toBe(false);
  });
});
