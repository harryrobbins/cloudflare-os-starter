import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LayerScheduler } from "./layers.js";
import { ridForTile } from "./media.js";
import { SerialQueue } from "./queue.js";
import { SpeakerDetector } from "./speaker.js";
import type { CallSimulcastRid } from "../../contract.js";

describe("SerialQueue", () => {
  it("runs tasks one at a time in FIFO order, even when one fails", async () => {
    const queue = new SerialQueue();
    const events: string[] = [];
    let release!: () => void;
    const first = queue.run(async () => {
      events.push("a:start");
      await new Promise<void>((resolve) => (release = resolve));
      events.push("a:end");
    });
    const second = queue.run(async () => {
      events.push("b");
      throw new Error("boom");
    });
    const third = queue.run(async () => {
      events.push("c");
      return 3;
    });
    await Promise.resolve();
    expect(events).toEqual(["a:start"]);
    expect(queue.size).toBe(3);
    release();
    await first;
    await expect(second).rejects.toThrow("boom");
    await expect(third).resolves.toBe(3);
    expect(events).toEqual(["a:start", "a:end", "b", "c"]);
    await Promise.resolve();
    expect(queue.size).toBe(0);
  });
});

describe("ridForTile", () => {
  it("maps large/medium/small/hidden to a/b/c/c and unknown to b", () => {
    expect(ridForTile("large")).toBe("a");
    expect(ridForTile("medium")).toBe("b");
    expect(ridForTile("small")).toBe("c");
    expect(ridForTile("hidden")).toBe("c");
    expect(ridForTile(undefined)).toBe("b");
  });
});

describe("SpeakerDetector", () => {
  it("needs a second of dominance before switching, with hysteresis against brief challengers", () => {
    const detector = new SpeakerDetector({ alpha: 1, threshold: 0.1, holdMs: 1000 });
    const at = (t: number, levels: Record<string, number>) => detector.update(t, new Map(Object.entries(levels))).active;
    expect(at(0, { a: 0.5, b: 0 })).toBeNull();
    expect(at(500, { a: 0.5, b: 0 })).toBeNull();
    expect(at(1000, { a: 0.5, b: 0 })).toBe("a");
    // b spikes for 750 ms, then a is back on top: no switch.
    expect(at(1250, { a: 0.2, b: 0.6 })).toBe("a");
    expect(at(2000, { a: 0.2, b: 0.6 })).toBe("a");
    expect(at(2250, { a: 0.6, b: 0.2 })).toBe("a");
    // Silence for a second clears it.
    expect(at(3000, { a: 0, b: 0 })).toBe("a");
    expect(at(4000, { a: 0, b: 0 })).toBeNull();
  });

  it("smooths levels and drops a speaker who left", () => {
    const detector = new SpeakerDetector({ alpha: 0.5, threshold: 0.05, holdMs: 0 });
    const first = detector.update(0, new Map([["a", 1]]));
    expect(first.levels.get("a")).toBeCloseTo(0.5);
    expect(detector.update(1, new Map([["a", 1]])).levels.get("a")).toBeCloseTo(0.75);
    expect(detector.update(2, new Map([["a", 1]])).active).toBe("a");
    expect(detector.update(3, new Map()).active).toBeNull();
  });
});

describe("LayerScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const clock = {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };

  it("applies a layer only after it has been wanted for the whole delay, and only when it differs", () => {
    let current: CallSimulcastRid = "b";
    const applied: CallSimulcastRid[] = [];
    const scheduler = new LayerScheduler(clock, 1000, () => current, (_key, rid) => {
      applied.push(rid);
      current = rid;
    });
    scheduler.want("t", "b");
    vi.advanceTimersByTime(2000);
    expect(applied).toEqual([]);
    scheduler.want("t", "a");
    vi.advanceTimersByTime(600);
    scheduler.want("t", "c");
    vi.advanceTimersByTime(600);
    expect(applied).toEqual([]);
    vi.advanceTimersByTime(400);
    expect(applied).toEqual(["c"]);
    scheduler.want("t", "a");
    scheduler.forget("t");
    vi.advanceTimersByTime(2000);
    expect(applied).toEqual(["c"]);
    scheduler.want("t", "a");
    scheduler.clear();
    vi.advanceTimersByTime(2000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
