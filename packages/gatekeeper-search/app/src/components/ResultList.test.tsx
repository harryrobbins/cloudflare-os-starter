import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OmniHit } from "../contract.js";
import { click, key, render, type Rendered } from "../test/render.js";
import { matchHint, ResultList } from "./ResultList.js";

function hit(n: number, overrides: Partial<OmniHit> = {}): OmniHit {
  return {
    documentId: `chat:${n}`,
    source: "chat",
    kind: "message",
    title: `Result ${n}`,
    url: `/gatekeeper/chat/m/${n}`,
    snippet: `snippet <mark>${n}</mark><script>bad()</script>`,
    score: 1 / n,
    lexicalRank: n,
    denseRank: null,
    scope: "chat:C1",
    scopeLabel: "#general",
    vis: "all",
    workspace: null,
    channel: "C1",
    author: "Jane",
    mime: null,
    createdAt: 0,
    updatedAt: Date.now() - n * 60_000,
    ...overrides,
  };
}

const HITS = [hit(1), hit(2, { denseRank: 1 }), hit(3, { lexicalRank: null, denseRank: 2, url: "https://example.com/x" })];

function Harness(props: {
  onOpen: (index: number) => void;
  onFocusInput: () => void;
  onReachEnd: () => void;
}) {
  const [selected, setSelected] = useState(-1);
  const [preview, setPreview] = useState(false);
  return (
    <>
      <ResultList
        hits={HITS}
        selected={selected}
        previewOpen={preview}
        onSelect={setSelected}
        onOpen={props.onOpen}
        onPreview={(index) => {
          setSelected(index);
          setPreview(true);
        }}
        onClosePreview={() => setPreview(false)}
        onFocusInput={props.onFocusInput}
        onReachEnd={props.onReachEnd}
      />
      <output data-testid="preview">{preview ? "open" : "closed"}</output>
    </>
  );
}

let view: Rendered | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

describe("ResultList keyboard", () => {
  it("moves the selection with arrows and exposes it through aria", async () => {
    const onOpen = vi.fn();
    const onFocusInput = vi.fn();
    const onReachEnd = vi.fn();
    view = await render(<Harness onOpen={onOpen} onFocusInput={onFocusInput} onReachEnd={onReachEnd} />);
    const list = view.container.querySelector('[role="listbox"]')!;
    const options = () => [...view!.container.querySelectorAll('[role="option"]')];

    // Focusing the list selects the first row.
    (list as HTMLElement).focus();
    await key(list, "ArrowDown");
    expect(options()[1]!.getAttribute("aria-selected")).toBe("true");
    expect(list.getAttribute("aria-activedescendant")).toBe("result-1");

    await key(list, "ArrowDown");
    expect(onReachEnd).toHaveBeenCalledTimes(1);
    await key(list, "End");
    expect(options()[2]!.getAttribute("aria-selected")).toBe("true");

    await key(list, "Enter");
    expect(onOpen).toHaveBeenCalledWith(2);

    await key(list, "Home");
    await key(list, "ArrowUp");
    expect(onFocusInput).toHaveBeenCalledTimes(1);
  });

  it("opens and closes the preview with Space, arrows and Escape", async () => {
    const onFocusInput = vi.fn();
    view = await render(<Harness onOpen={vi.fn()} onFocusInput={onFocusInput} onReachEnd={vi.fn()} />);
    const list = view.container.querySelector('[role="listbox"]')!;
    const preview = () => view!.container.querySelector("output")!.textContent;
    (list as HTMLElement).focus();

    await key(list, " ");
    expect(preview()).toBe("open");
    await key(list, "ArrowLeft");
    expect(preview()).toBe("closed");
    await key(list, "ArrowRight");
    expect(preview()).toBe("open");
    await key(list, "Escape");
    expect(preview()).toBe("closed");
    expect(onFocusInput).not.toHaveBeenCalled();
    await key(list, "Escape");
    expect(onFocusInput).toHaveBeenCalledTimes(1);
  });

  it("previews on a row click but lets the title link navigate", async () => {
    view = await render(<Harness onOpen={vi.fn()} onFocusInput={vi.fn()} onReachEnd={vi.fn()} />);
    const rows = view.container.querySelectorAll('[role="option"]');
    await click(rows[1]!.querySelector("p")!);
    expect(view.container.querySelector("output")!.textContent).toBe("open");
    expect(rows[1]!.getAttribute("aria-selected")).toBe("true");
  });

  it("renders the snippet without the script and links safely", async () => {
    view = await render(<Harness onOpen={vi.fn()} onFocusInput={vi.fn()} onReachEnd={vi.fn()} />);
    expect(view.container.querySelector("script")).toBeNull();
    expect(view.container.querySelectorAll("mark")).toHaveLength(3);
    const external = view.container.querySelector('a[href="https://example.com/x"]')!;
    expect(external.getAttribute("target")).toBe("_blank");
    expect(external.getAttribute("rel")).toContain("noopener");
    const internal = view.container.querySelector('a[href="/gatekeeper/chat/m/1"]')!;
    expect(internal.hasAttribute("target")).toBe(false);
    expect(view.container.textContent).toContain("found by words and meaning");
    expect(view.container.textContent).toContain("found by meaning");
  });
});

describe("matchHint", () => {
  it("names the retrieval half", () => {
    expect(matchHint({ lexicalRank: 1, denseRank: null })?.label).toBe("found by words");
    expect(matchHint({ lexicalRank: null, denseRank: 3 })?.label).toBe("found by meaning");
    expect(matchHint({ lexicalRank: null, denseRank: null })).toBeNull();
  });
});
