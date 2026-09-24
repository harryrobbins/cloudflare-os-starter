import { describe, expect, it } from "vitest";

import { linkTarget } from "./links.js";

describe("linkTarget", () => {
  it("keeps origin-relative paths in the same tab", () => {
    expect(linkTarget("/gatekeeper/chat/c/C1/m/M1")).toEqual({ href: "/gatekeeper/chat/c/C1/m/M1", external: false });
  });

  it("opens absolute http(s) URLs externally", () => {
    expect(linkTarget("https://github.com/x/y/issues/1")).toEqual({ href: "https://github.com/x/y/issues/1", external: true });
  });

  it("refuses scripts, data, protocol-relative and empty urls", () => {
    expect(linkTarget("javascript:alert(1)")).toBeNull();
    expect(linkTarget("data:text/html,hi")).toBeNull();
    expect(linkTarget("//evil.example/")).toBeNull();
    expect(linkTarget("/\t/evil.example/")).toBeNull();
    expect(linkTarget("/\\evil.example/")).toBeNull();
    expect(linkTarget("")).toBeNull();
    expect(linkTarget(null)).toBeNull();
  });
});
