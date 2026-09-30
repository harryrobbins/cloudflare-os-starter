/** The pre-join checks: "we can't hear you" after five silent seconds, and the speaker test button. */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MicCheck, SILENT_AFTER_MS, SpeakerTest } from "./PrejoinChecks.js";
import { click, render, type Rendered } from "./render.test-utils.js";

let rendered: Rendered | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
  vi.useRealTimers();
});

describe("MicCheck", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  const warning = () => rendered!.container.querySelector("[data-testid='mic-silent']");
  const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

  it("shows the level and warns only after five silent seconds", () => {
    rendered = render(<MicCheck level={0} active />);
    expect(rendered.container.querySelector("[role='meter']")?.getAttribute("aria-valuenow")).toBe("0");
    advance(SILENT_AFTER_MS - 100);
    expect(warning()).toBeNull();
    advance(200);
    expect(warning()?.textContent).toBe("We can't hear you — check your microphone");
    // It sits in a polite live region.
    expect(warning()?.closest("[role='status']")).not.toBeNull();
  });

  it("clears as soon as there is sound, and restarts the wait", () => {
    rendered = render(<MicCheck level={0} active />);
    advance(SILENT_AFTER_MS + 10);
    expect(warning()).not.toBeNull();
    rendered.rerender(<MicCheck level={0.3} active />);
    expect(warning()).toBeNull();
    expect(rendered.container.querySelector("[role='meter']")?.getAttribute("aria-valuenow")).toBe("30");
    rendered.rerender(<MicCheck level={0.01} active />);
    advance(SILENT_AFTER_MS - 500);
    expect(warning()).toBeNull();
    advance(600);
    expect(warning()).not.toBeNull();
  });

  it("never warns while the level cannot be measured", () => {
    rendered = render(<MicCheck level={0} active={false} />);
    advance(SILENT_AFTER_MS * 3);
    expect(warning()).toBeNull();
  });
});

describe("SpeakerTest", () => {
  it("plays the tone on the chosen output and says so while it plays", async () => {
    let finish: () => void = () => undefined;
    const play = vi.fn((_outputId: string | null) => new Promise<void>((resolve) => (finish = resolve)));
    rendered = render(<SpeakerTest outputId="spk-2" play={play} />);
    const button = rendered.container.querySelector("button")!;
    expect(button.textContent).toBe("Test speakers");
    click(button);
    expect(play).toHaveBeenCalledWith("spk-2");
    expect(button.textContent).toBe("Playing…");
    expect(button.disabled).toBe(true);
    await act(async () => finish());
    expect(button.textContent).toBe("Test speakers");
    expect(button.disabled).toBe(false);
  });

  it("explains when this browser cannot play it", async () => {
    rendered = render(<SpeakerTest outputId={null} play={() => Promise.reject(new Error("no audio"))} />);
    click(rendered.container.querySelector("button"));
    await act(async () => undefined);
    expect(rendered.container.querySelector("[role='status']")?.textContent).toBe("Could not play a sound in this browser.");
  });
});
