import { describe, expect, it } from "vitest";
import { MemoryReplayGuard } from "../src/index.js";

describe("MemoryReplayGuard", () => {
  it("claims once, then refuses until expiry, then allows reuse of the slot", async () => {
    let now = 1_000_000;
    const g = new MemoryReplayGuard({ now: () => now });
    expect(await g.claim("j1", 1_000 + 60)).toBe(true);
    expect(await g.claim("j1", 1_000 + 60)).toBe(false);
    now = (1_000 + 61) * 1000;
    expect(await g.claim("j1", 1_061 + 60)).toBe(true);
  });

  it("evicts expired entries and fails closed when full of live ones", async () => {
    let now = 0;
    const g = new MemoryReplayGuard({ maxEntries: 3, now: () => now });
    for (const j of ["a", "b", "c"]) expect(await g.claim(j, 60)).toBe(true);
    expect(await g.claim("d", 60)).toBe(false);
    now = 61_000;
    expect(await g.claim("d", 121)).toBe(true);
    expect(g.size).toBe(1);
  });
});
