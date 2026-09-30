import { describe, expect, it, vi } from "vitest";

import { createBridge, parseEmbedOptions } from "./bridge.js";

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

describe("createBridge, calls", () => {
  // jsdom's window is its own parent; the bridge needs a real-looking one to talk to.
  function framed(): { posted: unknown[]; parent: Window; restore: () => void } {
    const posted: unknown[] = [];
    const parent = { postMessage: (message: unknown) => posted.push(message) } as unknown as Window;
    const original = Object.getOwnPropertyDescriptor(window, "parent");
    Object.defineProperty(window, "parent", { configurable: true, get: () => parent });
    return {
      posted,
      parent,
      restore: () => {
        if (original !== undefined) Object.defineProperty(window, "parent", original);
      },
    };
  }

  function handlers() {
    return {
      onOpen: vi.fn(),
      onTheme: vi.fn(),
      onVisible: vi.fn(),
      onLayout: vi.fn(),
      onCallControl: vi.fn(),
    };
  }

  function deliver(source: Window, data: unknown, origin = window.location.origin): void {
    window.dispatchEvent(new MessageEvent("message", { data, origin, source: source as MessageEventSource }));
  }

  it("posts chat:call on join and leave, and chat:present for the call bar's moves", () => {
    const frame = framed();
    try {
      const bridge = createBridge(handlers(), true);
      bridge.call({ active: true, href: "/gatekeeper/chat/c/c-design", audio: true, video: false });
      bridge.call({ active: false });
      bridge.present("dock");
      bridge.present("page");
      expect(frame.posted).toEqual([
        { type: "chat:call", active: true, href: "/gatekeeper/chat/c/c-design", audio: true, video: false },
        { type: "chat:call", active: false },
        { type: "chat:present", mode: "dock" },
        { type: "chat:present", mode: "page" },
      ]);
      bridge.dispose();
    } finally {
      frame.restore();
    }
  });

  it("passes chat:layout and chat:call-control from the shell, and nothing else", () => {
    const frame = framed();
    try {
      const on = handlers();
      const bridge = createBridge(on, true);
      deliver(frame.parent, { type: "chat:layout", mode: "dock" });
      deliver(frame.parent, { type: "chat:layout", mode: "hidden" });
      deliver(frame.parent, { type: "chat:layout", mode: "sideways" });
      deliver(frame.parent, { type: "chat:call-control", action: "toggle-audio" });
      deliver(frame.parent, { type: "chat:call-control", action: "leave" });
      deliver(frame.parent, { type: "chat:call-control", action: "self-destruct" });
      // Another origin, or another window, is never obeyed.
      deliver(frame.parent, { type: "chat:call-control", action: "leave" }, "https://evil.example");
      deliver(window, { type: "chat:layout", mode: "page" });
      expect(on.onLayout.mock.calls).toEqual([["dock"], ["hidden"]]);
      expect(on.onCallControl.mock.calls).toEqual([["toggle-audio"], ["leave"]]);
      bridge.dispose();
    } finally {
      frame.restore();
    }
  });

  it("is inert when not embedded", () => {
    const bridge = createBridge(handlers(), false);
    expect(bridge.active).toBe(false);
    expect(() => bridge.call({ active: true, href: "/x" })).not.toThrow();
    expect(() => bridge.present("page")).not.toThrow();
  });
});
