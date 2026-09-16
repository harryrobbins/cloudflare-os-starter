import { describe, expect, it } from "vitest";
import { isValidOrderKey, keyBetween, keysBetween } from "../../src/shared/order.js";

describe("keyBetween", () => {
  it("starts at a0 and extends both ways", () => {
    expect(keyBetween(null, null)).toBe("a0");
    expect(keyBetween("a0", null)).toBe("a1");
    expect(keyBetween(null, "a0")).toBe("Zz");
    expect(keyBetween("a0", "a1")).toBe("a0V");
  });

  it("stays strictly between neighbours for many inserts at the same spot", () => {
    let lo = "a0";
    const hi = "a1";
    for (let i = 0; i < 500; i++) {
      const k = keyBetween(lo, hi);
      expect(k > lo && k < hi).toBe(true);
      expect(isValidOrderKey(k)).toBe(true);
      lo = k;
    }
    expect(lo.length).toBeLessThan(128);
  });

  it("appends and prepends without growing unboundedly", () => {
    let last = null;
    let first = null;
    for (let i = 0; i < 2000; i++) {
      last = keyBetween(last, null);
      first = keyBetween(null, first);
    }
    expect(last.length).toBeLessThan(6);
    expect(first.length).toBeLessThan(6);
  });

  it("rejects bad input", () => {
    expect(() => keyBetween("a1", "a0")).toThrow();
    expect(() => keyBetween("a0", "a0")).toThrow();
    expect(isValidOrderKey("a00")).toBe(false);
    expect(isValidOrderKey("")).toBe(false);
    expect(isValidOrderKey("a-")).toBe(false);
    expect(isValidOrderKey(42)).toBe(false);
  });
});

describe("keysBetween", () => {
  it("returns n sorted distinct keys within bounds", () => {
    for (const [a, b] of [[null, null], ["a0", null], [null, "a0"], ["a0", "a5"]]) {
      const keys = keysBetween(a, b, 25);
      expect(keys).toHaveLength(25);
      expect([...keys].sort()).toEqual(keys);
      expect(new Set(keys).size).toBe(25);
      if (a) expect(keys[0] > a).toBe(true);
      if (b) expect(keys.at(-1) < b).toBe(true);
    }
  });
});
