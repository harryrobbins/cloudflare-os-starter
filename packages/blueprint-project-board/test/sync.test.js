import { afterEach, describe, expect, it, vi } from "vitest";
import { createSync, POLL_MS, LIVE_TICK_MS } from "../src/client/sync.js";
import { FakeRecords, fakeGadget } from "./fake-records.js";

afterEach(() => vi.useRealTimers());

describe("sync", () => {
  it("falls back to a full refresh every 15 s without live updates", async () => {
    vi.useFakeTimers();
    const onRefetchAll = vi.fn();
    const sync = createSync({ gadget: fakeGadget(new FakeRecords()), onRefetchAll, onChanges: vi.fn() });
    await sync.start();
    expect(onRefetchAll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(onRefetchAll).toHaveBeenCalledTimes(2);
    sync.stop();
  });

  it("uses logged changes once the hook delivers", async () => {
    vi.useFakeTimers();
    const gadget = fakeGadget(new FakeRecords());
    const onChanges = vi.fn();
    const onRefetchAll = vi.fn();
    const sync = createSync({ gadget, onRefetchAll, onChanges });
    await sync.start();
    gadget.feed.record([{ entityType: "issue", entityId: "iss-1", revision: 2 }]);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(sync.live).toBe("active");
    gadget.feed.record([{ entityType: "issue", entityId: "iss-2", revision: 5 }]);
    await vi.advanceTimersByTimeAsync(LIVE_TICK_MS);
    expect(onChanges).toHaveBeenLastCalledWith([expect.objectContaining({ entityId: "iss-2", revision: 5 })]);
    gadget.feed.resync();
    const before = onRefetchAll.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LIVE_TICK_MS);
    expect(onRefetchAll.mock.calls.length).toBe(before + 1);
    sync.stop();
  });
});
