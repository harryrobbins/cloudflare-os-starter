/**
 * Call quality in the UI: the tile indicator and the paused-video tile, and the banner/tip strip
 * against a minimal store fed by the fake engine's snapshots.
 */
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { CallState, ParticipantId } from "../../contract.js";
import { StoreProvider } from "../../hooks/store.js";
import { IDLE_CALL } from "../../store/calls.js";
import { INITIAL_STATE, type ChatState } from "../../store/state.js";
import type { ChatStore } from "../../store/store.js";
import type { CallSnapshot } from "../engine/types.js";
import { CallQualityNotices, QualityBars, resetCallQualityNotices } from "./CallQuality.js";
import { CallTile, type TileModel } from "./CallTile.js";
import { createFakeCallEngine, type FakeCallEngine } from "./fake-engine.js";
import { click, render, type Rendered } from "./render.test-utils.js";

// jsdom has no media playback; the tile calls play() on its video.
beforeAll(() => {
  HTMLMediaElement.prototype.play = () => Promise.resolve();
});

let rendered: Rendered | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
  resetCallQualityNotices();
  window.localStorage.clear();
});

const tile: TileModel = {
  key: "p-alice",
  userId: "alice",
  name: "Alice Chen",
  stream: null,
  audioOn: true,
  videoOn: false,
  speaking: false,
};

describe("QualityBars", () => {
  it("draws good, fair and poor with a label, and nothing when unknown or absent", () => {
    rendered = render(
      <div>
        <QualityBars quality="good" />
        <QualityBars quality="fair" />
        <QualityBars quality="poor" />
        <QualityBars quality="unknown" />
        <QualityBars quality={undefined} />
      </div>,
    );
    const glyphs = [...rendered.container.querySelectorAll("[role='img']")];
    expect(glyphs.map((glyph) => glyph.getAttribute("aria-label"))).toEqual([
      "Connection: good",
      "Connection: fair",
      "Connection: poor",
    ]);
    expect(glyphs.map((glyph) => glyph.getAttribute("title"))).toEqual([
      "Connection: good",
      "Connection: fair",
      "Connection: poor",
    ]);
    // Filled bars: 3, 2, 1.
    expect(glyphs.map((glyph) => [...glyph.querySelectorAll("rect")].filter((bar) => bar.getAttribute("opacity") === "1").length)).toEqual([3, 2, 1]);
  });
});

describe("CallTile quality", () => {
  it("shows the indicator in the name pill of a remote and of your self-view", () => {
    rendered = render(
      <div>
        <CallTile tile={{ ...tile, quality: "fair" }} />
        <CallTile tile={{ ...tile, key: "self", self: true, quality: "poor" }} />
        <CallTile tile={{ ...tile, key: "p-bob" }} />
      </div>,
    );
    const tiles = rendered.container.querySelectorAll("[data-testid='call-tile']");
    expect(tiles[0]!.querySelector("[aria-label='Connection: fair']")).not.toBeNull();
    expect(tiles[1]!.querySelector("[aria-label='Connection: poor']")).not.toBeNull();
    expect(tiles[2]!.querySelector("[role='img']")).toBeNull();
  });

  it("draws a paused camera as the avatar with a hint, never the frozen frame", () => {
    const stream = new EventTarget() as unknown as MediaStream;
    rendered = render(<CallTile tile={{ ...tile, stream, videoOn: true, paused: true }} />);
    expect(rendered.container.querySelector("video")).toBeNull();
    expect(rendered.container.querySelector("[data-testid='video-paused']")?.textContent).toBe("Video paused");
    rendered.rerender(<CallTile tile={{ ...tile, stream, videoOn: true, paused: false }} />);
    expect(rendered.container.querySelector("video")).not.toBeNull();
    expect(rendered.container.querySelector("[data-testid='video-paused']")).toBeNull();
  });

  it("puts the paused hint in the name pill of a compact strip tile", () => {
    const stream = new EventTarget() as unknown as MediaStream;
    rendered = render(<CallTile tile={{ ...tile, stream, videoOn: true, paused: true }} compact />);
    expect(rendered.container.querySelector("video")).toBeNull();
    expect(rendered.container.querySelector("[data-testid='video-paused']")?.getAttribute("aria-label")).toBe("Video paused");
  });

  it("never pauses a screen share tile", () => {
    const stream = new EventTarget() as unknown as MediaStream;
    rendered = render(<CallTile tile={{ ...tile, stream, videoOn: true, screen: true, paused: true, quality: "poor" }} />);
    expect(rendered.container.querySelector("video")).not.toBeNull();
    expect(rendered.container.querySelector("[role='img']")).toBeNull();
  });
});

// --- the banner strip against a minimal store --------------------------------------------------

function room(others: number): CallState {
  const ids = ["p-me", ...Array.from({ length: others }, (_, index) => `p-${index}`)];
  return {
    id: "call-1",
    channelId: "c1",
    startedBy: "u-me",
    startedAt: 0,
    messageId: "m",
    participants: ids.map((id) => ({
      id,
      userId: id === "p-me" ? "u-me" : `u-${id}`,
      sessionId: "s",
      joinedAt: 0,
      audio: true,
      video: true,
      screen: false,
      tracks: [],
    })),
  };
}

interface Harness {
  store: ChatStore;
  engine: FakeCallEngine;
  announced: string[];
  setCall(patch: Partial<CallSnapshot>): void;
}

function harness(options: { others?: number; outputs?: { deviceId: string; label: string }[] } = {}): Harness {
  const engine = createFakeCallEngine();
  const outputs = (options.outputs ?? []).map((output) => ({ ...output, kind: "audiooutput", groupId: "" }) as MediaDeviceInfo);
  engine.listDevices = async () => ({ audioInputs: [], videoInputs: [], audioOutputs: outputs });
  const listeners = new Set<() => void>();
  const announced: string[] = [];
  let state: ChatState = {
    ...INITIAL_STATE,
    calls: { c1: room(options.others ?? 1) },
    call: { ...IDLE_CALL, phase: "connected", channelId: "c1", callId: "call-1", participantId: "p-me" as ParticipantId },
  };
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    announce: (message: string) => announced.push(message),
    callEngine: engine,
  } as unknown as ChatStore;
  return {
    store,
    engine,
    announced,
    setCall(patch) {
      act(() => {
        state = { ...state, call: { ...state.call, ...patch } };
        for (const listener of listeners) listener();
      });
    },
  };
}

function mount(h: Harness): Rendered {
  rendered = render(
    <StoreProvider store={h.store}>
      <CallQualityNotices />
    </StoreProvider>,
  );
  return rendered;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("CallQualityNotices", () => {
  it("shows nothing while the call is healthy or the fields are absent", () => {
    const h = harness();
    const view = mount(h);
    expect(view.container.innerHTML).toBe("");
    h.setCall({ localQuality: "fair", limitation: "bandwidth" });
    expect(view.container.innerHTML).toBe("");
    expect(h.announced).toEqual([]);
  });

  it("shows one banner at a time by priority, and announces each once", () => {
    const h = harness();
    const view = mount(h);
    h.setCall({ limitation: "cpu" });
    const text = () => view.container.querySelector("[data-testid='call-banner']")?.textContent ?? null;
    expect(text()).toBe("Your computer is struggling — sending lower video quality");
    h.setCall({ localQuality: "poor" });
    expect(text()).toBe("Your connection is unstable");
    h.setCall({ audioOnly: true });
    expect(text()).toBe("Your connection is unstable — video paused to keep audio clear");
    h.setCall({ audioOnly: false, localQuality: "good" });
    expect(text()).toBe("Your computer is struggling — sending lower video quality");
    expect(h.announced).toEqual([
      "Your computer is struggling — sending lower video quality",
      "Your connection is unstable",
      "Your connection is unstable — video paused to keep audio clear",
    ]);
  });

  it("stays dismissed for the rest of the call, across a remount, and is not re-announced", () => {
    const h = harness();
    let view = mount(h);
    h.setCall({ localQuality: "poor" });
    click(view.container.querySelector("button[aria-label='Dismiss']"));
    expect(view.container.querySelector("[data-testid='call-banner']")).toBeNull();
    // The Chat toggle unmounts the panel; coming back must not bring the banner back.
    view.unmount();
    view = mount(h);
    expect(view.container.querySelector("[data-testid='call-banner']")).toBeNull();
    expect(h.announced).toEqual(["Your connection is unstable"]);
    // A different problem still gets its say.
    h.setCall({ limitation: "cpu" });
    expect(view.container.querySelector("[data-testid='call-banner']")?.textContent).toContain("Your computer is struggling");
    // A new call starts with a clean slate.
    h.setCall({ callId: "call-2", limitation: "none" });
    expect(view.container.querySelector("[data-testid='call-banner']")?.textContent).toBe("Your connection is unstable");
  });

  it("suggests headphones once with two or more others on built-in speakers", async () => {
    const outputs = [{ deviceId: "default", label: "Default - MacBook Pro Speakers (Built-in)" }];
    const h = harness({ others: 2, outputs });
    const view = mount(h);
    await flush();
    const tip = () => view.container.querySelector("[data-testid='call-headphones-tip']");
    expect(tip()?.textContent).toContain("Using headphones prevents echo");
    // A quality banner takes the strip while it lasts.
    h.setCall({ localQuality: "poor" });
    expect(tip()).toBeNull();
    h.setCall({ localQuality: "good" });
    click(view.container.querySelector("button[aria-label='Dismiss tip']"));
    expect(tip()).toBeNull();
    // Dismissed for good, in this browser.
    view.unmount();
    const again = mount(harness({ others: 3, outputs }));
    await flush();
    expect(again.container.querySelector("[data-testid='call-headphones-tip']")).toBeNull();
  });

  it("gives no tip with one other person, on headphones, or without device labels", async () => {
    for (const setup of [
      { others: 1, outputs: [{ deviceId: "default", label: "MacBook Pro Speakers" }] },
      { others: 3, outputs: [{ deviceId: "default", label: "AirPods Pro" }] },
      { others: 3, outputs: [{ deviceId: "default", label: "" }] },
    ]) {
      const view = mount(harness(setup));
      await flush();
      expect(view.container.querySelector("[data-testid='call-headphones-tip']")).toBeNull();
      view.unmount();
      rendered = null;
    }
  });
});
