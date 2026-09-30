import { afterEach, describe, expect, it, vi } from "vitest";

import { CallButtonView } from "./CallButton.js";
import { click, render, type Rendered } from "./render.test-utils.js";

const names: Record<string, string> = { a: "Alice Chen", b: "Bob Okafor", c: "Cara Silva" };
let rendered: Rendered | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
});

function view(state: Parameters<typeof CallButtonView>[0]["state"], handlers = { onStart: vi.fn(), onShowCall: vi.fn() }) {
  rendered = render(<CallButtonView state={state} nameOf={(id) => names[id]} {...handlers} />);
  return { container: rendered.container, ...handlers };
}

describe("CallButtonView", () => {
  it("renders nothing when hidden", () => {
    const { container } = view({ kind: "hidden" });
    expect(container.innerHTML).toBe("");
  });

  it("starts a call", () => {
    const { container, onStart } = view({ kind: "start" });
    const button = container.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("Start call");
    click(button);
    expect(onStart).toHaveBeenCalledOnce();
  });

  it("is a Join pill with a count and up to three faces", () => {
    const { container, onStart } = view({ kind: "join", count: 4, userIds: ["a", "b", "c"] });
    const button = container.querySelector("button")!;
    expect(button.textContent).toContain("Join · 4");
    expect(button.getAttribute("aria-label")).toBe("Join call, 4 in the call");
    expect(button.title).toBe("Join the call with Alice Chen, Bob Okafor, Cara Silva and others");
    expect(button.querySelectorAll("[aria-hidden='true'] > span")).toHaveLength(3);
    click(button);
    expect(onStart).toHaveBeenCalledOnce();
  });

  it("says In call and brings the grid back", () => {
    const { container, onShowCall, onStart } = view({ kind: "in-call" });
    expect(container.textContent).toContain("In call");
    click(container.querySelector("button"));
    expect(onShowCall).toHaveBeenCalledOnce();
    expect(onStart).not.toHaveBeenCalled();
  });

  it("is disabled with the reason when the call is full", () => {
    const { container, onStart } = view({ kind: "full", max: 5 });
    const button = container.querySelector("button")!;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("This call is full (5)");
    expect(container.querySelector("[title]")?.getAttribute("title")).toBe("This call is full (5)");
    click(button);
    expect(onStart).not.toHaveBeenCalled();
  });
});
