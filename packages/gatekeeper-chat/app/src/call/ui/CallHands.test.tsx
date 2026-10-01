/**
 * Raised hands and reactions in the UI: the queue order, the tile badge and overlay, and the people
 * list against a minimal store.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { CallParticipant, CallState, ParticipantId } from "../../contract.js";
import { StoreProvider } from "../../hooks/store.js";
import { IDLE_CALL } from "../../store/calls.js";
import { INITIAL_STATE, type ChatState } from "../../store/state.js";
import type { ChatStore } from "../../store/store.js";
import { ParticipantList } from "./CallControls.js";
import { remoteTiles } from "./CallPanel.js";
import { CallTile, type TileModel } from "./CallTile.js";
import { handQueue } from "./layout.js";
import { render, type Rendered } from "./render.test-utils.js";

beforeAll(() => {
  HTMLMediaElement.prototype.play = () => Promise.resolve();
});

let rendered: Rendered | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
});

function person(id: string, userId: string, patch: Partial<CallParticipant> = {}): CallParticipant {
  return { id, userId, sessionId: `s-${id}`, joinedAt: 0, audio: true, video: false, screen: false, tracks: [], ...patch };
}

function room(participants: CallParticipant[]): CallState {
  return { id: "call-1", channelId: "c1", startedBy: "me", startedAt: 0, messageId: "m1", participants };
}

const users = {
  me: { id: "me", name: "Harry Robbins", email: null, kind: "human" },
  alice: { id: "alice", name: "Alice Chen", email: null, kind: "human" },
  bob: { id: "bob", name: "Bob Diaz", email: null, kind: "human" },
} as unknown as ChatState["users"];

const tile: TileModel = { key: "p-a", userId: "alice", name: "Alice Chen", stream: null, audioOn: true, videoOn: false, speaking: false };

describe("handQueue", () => {
  it("orders raised hands by when they went up", () => {
    const queue = handQueue(room([person("p-a", "alice", { hand: 30 }), person("p-b", "bob"), person("p-c", "me", { hand: 10 })]));
    expect([...queue]).toEqual([
      ["p-c", 1],
      ["p-a", 2],
    ]);
    expect(handQueue(undefined).size).toBe(0);
  });
});

describe("remoteTiles", () => {
  it("carries each remote's hand place and only their own reactions", () => {
    const local = { ...IDLE_CALL, phase: "connected" as const, participantId: "p-me" as ParticipantId };
    const tiles = remoteTiles(
      room([person("p-a", "alice", { hand: 5 }), person("p-b", "bob"), person("p-me", "me", { hand: 1 })]),
      local,
      users,
      [
        { id: 1, participantId: "p-b", emoji: "🎉" },
        { id: 2, participantId: "p-me", emoji: "👍" },
      ],
    );
    expect(tiles.map((entry) => [entry.key, entry.hand, entry.handOrder, entry.reactions])).toEqual([
      ["p-a", true, 2, undefined],
      ["p-b", undefined, undefined, [{ id: 1, participantId: "p-b", emoji: "🎉" }]],
    ]);
  });
});

describe("CallTile", () => {
  it("badges a raised hand with its place, and floats reactions", () => {
    rendered = render(<CallTile tile={{ ...tile, hand: true, handOrder: 2, reactions: [{ id: 1, emoji: "👏" }] }} />);
    const badge = rendered.container.querySelector("[data-testid='hand-raised']");
    expect(badge?.getAttribute("aria-label")).toBe("Hand raised, second");
    expect(badge?.textContent).toBe("✋2");
    expect(rendered.container.querySelector("[data-testid='tile-reaction']")?.textContent).toBe("👏");
    rendered.rerender(<CallTile tile={tile} />);
    expect(rendered.container.querySelector("[data-testid='hand-raised']")).toBeNull();
    expect(rendered.container.querySelector("[data-testid='tile-reaction']")).toBeNull();
  });
});

describe("ParticipantList", () => {
  it("lists raised hands first in queue order, then everyone else in join order", () => {
    const state: ChatState = {
      ...INITIAL_STATE,
      users,
      calls: {
        c1: room([
          person("p-me", "me"),
          person("p-a", "alice", { hand: 20, audio: false }),
          person("p-b", "bob", { hand: 10 }),
        ]),
      },
      call: { ...IDLE_CALL, phase: "connected", channelId: "c1", callId: "call-1", participantId: "p-me" as ParticipantId },
    };
    const store = { subscribe: () => () => undefined, getSnapshot: () => state } as unknown as ChatStore;
    rendered = render(
      <StoreProvider store={store}>
        <ParticipantList />
      </StoreProvider>,
    );
    const rows = [...rendered.container.querySelectorAll("[data-testid='call-person']")];
    expect(rows.map((row) => row.textContent)).toEqual(["Bob Diaz✋1", "Alice Chen✋2", "Harry Robbins (you)"]);
    expect(rows[1]!.querySelector("[aria-label='Microphone off']")).not.toBeNull();
  });
});
