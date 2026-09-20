import { describe, expect, it } from "vitest";

import { parseEmbedOptions } from "./bridge.js";

describe("parseEmbedOptions", () => {
  it("is neither by default", () => {
    expect(parseEmbedOptions("")).toEqual({ bridged: false, compact: false });
  });

  // The shell's full `/chat` page: bridged, but entitled to the wide three-pane layout.
  it("treats embed=1 alone as bridged and not compact", () => {
    expect(parseEmbedOptions("?embed=1")).toEqual({ bridged: true, compact: false });
  });

  // The shell's dock.
  it("reads both flags together", () => {
    expect(parseEmbedOptions("?embed=1&compact=1")).toEqual({ bridged: true, compact: true });
  });

  it("allows compact without a shell, which is what a narrow standalone tab is", () => {
    expect(parseEmbedOptions("?compact=1")).toEqual({ bridged: false, compact: true });
  });

  it("only accepts the exact value 1", () => {
    expect(parseEmbedOptions("?embed=true&compact=yes")).toEqual({
      bridged: false,
      compact: false,
    });
  });

  it("ignores other parameters", () => {
    expect(parseEmbedOptions("?q=hello&embed=1")).toEqual({ bridged: true, compact: false });
  });
});
