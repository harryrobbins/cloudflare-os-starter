// Document Picture-in-Picture: when it is offered, what opening it does to the new window's
// document, and the page's stand-in while the call is there.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { StoreProvider } from "../../hooks/store.js";
import { IDLE_CALL } from "../../store/calls.js";
import { INITIAL_STATE, type ChatState } from "../../store/state.js";
import type { ChatStore } from "../../store/store.js";
import { CallPanel } from "./CallPanel.js";
import { createFakeCallEngine } from "./fake-engine.js";
import { canPictureInPicture, closePictureInPicture, copyStyles, openPictureInPicture, pipWindow } from "./pip.js";
import { click, render, type Rendered } from "./render.test-utils.js";

beforeAll(() => {
  HTMLMediaElement.prototype.play = () => Promise.resolve();
});

let rendered: Rendered | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
  closePictureInPicture();
  delete (window as { documentPictureInPicture?: unknown }).documentPictureInPicture;
  vi.restoreAllMocks();
});

/** A stand-in for the window `requestWindow` resolves with: its own document, close and pagehide. */
function fakeWindow() {
  const doc = document.implementation.createHTMLDocument("pip");
  const listeners = new Map<string, () => void>();
  const closed = { value: false };
  const win = {
    document: doc,
    close: () => {
      closed.value = true;
      listeners.get("pagehide")?.();
    },
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
  } as unknown as Window;
  return { win, closed, pagehide: () => listeners.get("pagehide")?.() };
}

function installApi(opened: Window | "refuse") {
  const requestWindow = vi.fn(async () => {
    if (opened === "refuse") throw new DOMException("no gesture", "NotAllowedError");
    return opened;
  });
  (window as { documentPictureInPicture?: unknown }).documentPictureInPicture = { requestWindow, window: null };
  return requestWindow;
}

describe("canPictureInPicture", () => {
  it("needs the API and a top-level page", () => {
    expect(canPictureInPicture()).toBe(false);
    installApi("refuse");
    expect(canPictureInPicture()).toBe(true);
    const framed = { documentPictureInPicture: { requestWindow: () => undefined }, top: {} } as unknown as Window;
    expect(canPictureInPicture(framed)).toBe(false);
  });
});

describe("openPictureInPicture", () => {
  it("opens once, copies styles and theme, and forgets the window when it closes", async () => {
    const { win, pagehide } = fakeWindow();
    const requestWindow = installApi(win);
    const style = document.createElement("style");
    style.textContent = ".pip-probe { color: red; }";
    document.head.append(style);
    document.documentElement.dataset.mode = "dark";

    await expect(openPictureInPicture()).resolves.toBe(true);
    await expect(openPictureInPicture()).resolves.toBe(true);
    expect(requestWindow).toHaveBeenCalledTimes(1);
    expect(pipWindow()).toBe(win);
    expect(win.document.head.textContent).toContain(".pip-probe");
    expect(win.document.documentElement.dataset).toMatchObject({ mode: "dark", compact: "1" });

    pagehide();
    expect(pipWindow()).toBeNull();
    style.remove();
    delete document.documentElement.dataset.mode;
  });

  it("resolves false when the browser refuses", async () => {
    installApi("refuse");
    await expect(openPictureInPicture()).resolves.toBe(false);
    expect(pipWindow()).toBeNull();
  });

  it("copyStyles links a sheet whose rules it cannot read", () => {
    const to = document.implementation.createHTMLDocument("to");
    const from = {
      styleSheets: [
        {
          href: "https://example.com/a.css",
          get cssRules(): never {
            throw new DOMException("cross-origin", "SecurityError");
          },
        },
      ],
      documentElement: document.createElement("html"),
      body: document.createElement("body"),
    } as unknown as Document;
    copyStyles(from, to);
    expect(to.head.querySelector("link")?.getAttribute("href")).toBe("https://example.com/a.css");
  });
});

describe("CallPanel while the call floats", () => {
  it("shows a stand-in with a way back instead of the tiles", async () => {
    const { win, closed } = fakeWindow();
    installApi(win);
    await openPictureInPicture();
    const state: ChatState = {
      ...INITIAL_STATE,
      call: { ...IDLE_CALL, phase: "connected", channelId: "c1", callId: "call-1", participantId: "p-me" },
    };
    const store = {
      subscribe: () => () => undefined,
      getSnapshot: () => state,
      callEngine: createFakeCallEngine(),
    } as unknown as ChatStore;
    rendered = render(
      <StoreProvider store={store}>
        <CallPanel channelId="c1" label="#general" layout="page" />
      </StoreProvider>,
    );
    expect(rendered.container.textContent).toContain("The call is in a floating window.");
    expect(rendered.container.querySelector("[data-testid='call-tile']")).toBeNull();
    click([...rendered.container.querySelectorAll("button")].find((button) => button.textContent === "Bring the call back here")!);
    expect(closed.value).toBe(true);
    expect(pipWindow()).toBeNull();
  });
});
