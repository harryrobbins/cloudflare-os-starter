// Minimal React rendering for the call UI tests: react-dom into a jsdom container under `act`, with
// no testing library (the app has none). Only presentational components are rendered this way.

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Rendered {
  readonly container: HTMLElement;
  rerender(node: ReactNode): void;
  unmount(): void;
}

export function render(node: ReactNode): Rendered {
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root;
  act(() => {
    root = createRoot(container);
    root.render(node);
  });
  return {
    container,
    rerender(next) {
      act(() => root.render(next));
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

export function click(element: Element | null): void {
  if (element === null) throw new Error("Nothing to click.");
  act(() => {
    (element as HTMLElement).click();
  });
}
