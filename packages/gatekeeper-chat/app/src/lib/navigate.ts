// A one-function indirection so components can navigate to an *already-prefixed* app path without
// importing the router, which imports them. The router registers the real implementation at startup.

type Navigator = (absolutePath: string) => void;

let navigator: Navigator | null = null;

export function setAppNavigator(next: Navigator): void {
  navigator = next;
}

/** Navigates to a path that carries the `/gatekeeper/chat` prefix: a permalink, a toast, `chat:open`. */
export function navigateToAppPath(absolutePath: string): void {
  navigator?.(absolutePath);
}
