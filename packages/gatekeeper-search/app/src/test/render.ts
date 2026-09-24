// A minimal render helper: React 19's `act` over a jsdom container, no testing-library.
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Rendered {
  container: HTMLElement;
  root: Root;
  rerender: (element: ReactElement) => Promise<void>;
  unmount: () => Promise<void>;
}

export async function render(element: ReactElement): Promise<Rendered> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    root,
    rerender: async (next) => act(async () => root.render(next)),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

export async function key(target: Element | Window, keyName: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true }));
  });
}

export async function click(target: Element): Promise<void> {
  await act(async () => {
    (target as HTMLElement).click();
  });
}

/** Sets a React-controlled input's value the way typing does. */
export async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}
