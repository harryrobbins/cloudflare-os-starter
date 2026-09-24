import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.js";
import { createMockApi } from "./mock/api.js";
import { click, flush, key, render, type, type Rendered } from "./test/render.js";
import type { LinkTarget } from "./lib/links.js";

let view: Rendered | undefined;

beforeEach(() => {
  window.history.replaceState(null, "", "/gatekeeper/search/");
});

afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

const input = () => view!.container.querySelector<HTMLInputElement>("#omni-q")!;

describe("App", () => {
  it("shows sources and syntax help when empty", async () => {
    view = await render(<App api={createMockApi()} />);
    await flush();
    expect(view.container.textContent).toContain("Team chat");
    expect(view.container.textContent).toContain("Context Library");
    expect(view.container.textContent).toContain("in:#design");
  });

  it("runs the query from ?q=, renders chips, and rewrites q when one is removed", async () => {
    window.history.replaceState(null, "", "/gatekeeper/search/?q=atlas+kind%3Adoc&mock=x");
    view = await render(<App api={createMockApi()} />);
    await flush(10);
    expect(view.container.querySelectorAll('[role="option"]').length).toBeGreaterThan(0);
    const chip = view.container.querySelector('button[aria-label="Remove filter kind: doc"]')!;
    expect(chip).not.toBeNull();
    await click(chip);
    await flush(10);
    expect(new URLSearchParams(window.location.search).get("q")).toBe("atlas");
    // Other params survive.
    expect(new URLSearchParams(window.location.search).get("mock")).toBe("x");
    expect(input().value).toBe("atlas");
    expect(view.container.querySelector('button[aria-label^="Remove filter"]')).toBeNull();
  });

  it("debounces typing into the URL and follows back/forward", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      view = await render(<App api={createMockApi()} />);
      await type(input(), "bud");
      await type(input(), "budget");
      expect(window.location.search).toBe("");
      await vi.advanceTimersByTimeAsync(300);
      expect(new URLSearchParams(window.location.search).get("q")).toBe("budget");
    } finally {
      vi.useRealTimers();
    }
    await flush(10);
    expect(view.container.textContent).toContain("Q4 budget");

    window.history.pushState(null, "", "/gatekeeper/search/?q=holiday");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await flush(10);
    expect(input().value).toBe("holiday");
    expect(view.container.textContent).toContain("Holiday and leave");
  });

  it("clicking a facet adds its qualifier", async () => {
    window.history.replaceState(null, "", "/gatekeeper/search/?q=atlas");
    view = await render(<App api={createMockApi()} />);
    await flush(10);
    const facet = [...view.container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Filters"] button[aria-pressed]')].find(
      (button) => button.textContent?.includes("Context Library"),
    )!;
    await click(facet);
    await flush(10);
    expect(new URLSearchParams(window.location.search).get("q")).toBe("atlas source:context");
    expect(view.container.querySelector('button[aria-label="Remove filter source: context"]')).not.toBeNull();
  });

  it("is keyboard-driven: / focuses, ArrowDown enters the list, Enter opens, Space previews", async () => {
    window.history.replaceState(null, "", "/gatekeeper/search/?q=kickoff");
    const navigate = vi.fn<(target: LinkTarget) => void>();
    view = await render(<App api={createMockApi()} navigate={navigate} />);
    await flush(10);

    (document.activeElement as HTMLElement | null)?.blur();
    await key(document.body, "/");
    expect(document.activeElement).toBe(input());

    await key(input(), "ArrowDown");
    const list = view.container.querySelector('[role="listbox"]')!;
    expect(document.activeElement).toBe(list);
    expect(list.getAttribute("aria-activedescendant")).toBe("result-0");

    await key(list, "Enter");
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0]![0].external).toBe(false);

    await key(list, " ");
    await flush(200);
    const preview = view.container.querySelector('section[aria-label^="Preview"]')!;
    expect(preview).not.toBeNull();
    expect(preview.querySelector("pre")!.textContent).toMatch(/kickoff/iu);

    await key(list, "Escape");
    expect(view.container.querySelector('section[aria-label^="Preview"]')).toBeNull();
  });

  it("shows the truncated notice for a long document", async () => {
    window.history.replaceState(null, "", "/gatekeeper/search/?q=runbook");
    view = await render(<App api={createMockApi()} />);
    await flush(10);
    const list = view.container.querySelector('[role="listbox"]')!;
    (list as HTMLElement).focus();
    await key(list, "ArrowRight");
    await flush(200);
    expect(view.container.textContent).toContain("preview is truncated");
  });

  it("says when meaning-based results are unavailable", async () => {
    window.history.replaceState(null, "", "/gatekeeper/search/?q=atlas");
    view = await render(<App api={createMockApi({ dense: "unavailable" })} />);
    await flush(10);
    expect(view.container.textContent).toContain("Meaning-based results unavailable, showing word matches.");
  });

  it("shows Sign in again on a 401 and the message on other errors", async () => {
    window.history.replaceState(null, "", "/gatekeeper/search/?q=atlas");
    view = await render(<App api={createMockApi({ failStatus: 401 })} />);
    await flush(10);
    const alert = view.container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("Sign in again");
    await view.unmount();

    view = await render(<App api={createMockApi({ failStatus: 500 })} />);
    await flush(10);
    expect(view.container.querySelector('[role="alert"]')!.textContent).toContain("The search index is unavailable.");
  });

  it("shows the admin panel only to admins and re-queues", async () => {
    view = await render(<App api={createMockApi({ admin: false })} />);
    await flush();
    expect(view.container.querySelector('button[aria-controls="admin-panel"]')).toBeNull();
    await view.unmount();

    view = await render(<App api={createMockApi()} />);
    await flush();
    await click(view.container.querySelector('button[aria-controls="admin-panel"]')!);
    await flush();
    expect(view.container.textContent).toContain("Pending embeddings");
    const requeue = [...view.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Re-queue pending embeddings"),
    )!;
    await click(requeue);
    await flush(10);
    expect(view.container.textContent).toContain("Re-queued 37 chunks.");
  });
});
