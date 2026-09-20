// The embedded-mode bridge.
//
// Message shapes come from `protocol.ts` (`AppToShellMessage`, `ShellToAppMessage`) so the shell's
// phase-2 commit and this app cannot drift. Both directions are origin-checked against
// `window.location.origin`: the shell embeds this app same-origin, so anything from elsewhere is either
// a mistake or an attack, and `postMessage("*")` would leak the badge counts to whoever framed us.

import type { AppToShellMessage, ShellToAppMessage } from "../contract.js";

export interface BridgeHandlers {
  readonly onOpen: (href: string) => void;
  readonly onTheme: (mode: "light" | "dark", accent?: string) => void;
  readonly onVisible: (visible: boolean) => void;
}

export interface Bridge {
  readonly active: boolean;
  badge(unread: number, mentions: number): void;
  notify(title: string, body: string, href: string): void;
  expand(href: string): void;
  dispose(): void;
}

/** True when the app is running inside the shell's drawer. */
export function isEmbedded(search: string = window.location.search): boolean {
  return new URLSearchParams(search).get("embed") === "1";
}

export function createBridge(handlers: BridgeHandlers, embedded: boolean): Bridge {
  if (!embedded || window.parent === window) {
    return {
      active: false,
      badge: () => undefined,
      notify: () => undefined,
      expand: () => undefined,
      dispose: () => undefined,
    };
  }

  const origin = window.location.origin;

  function post(message: AppToShellMessage): void {
    window.parent.postMessage(message, origin);
  }

  function onMessage(event: MessageEvent<unknown>): void {
    if (event.origin !== origin) return;
    if (event.source !== window.parent) return;
    const data = event.data;
    if (typeof data !== "object" || data === null || !("type" in data)) return;
    const message = data as ShellToAppMessage;
    switch (message.type) {
      case "chat:open":
        if (typeof message.href === "string") handlers.onOpen(message.href);
        return;
      case "chat:theme":
        if (message.mode === "light" || message.mode === "dark") {
          handlers.onTheme(message.mode, message.accent);
        }
        return;
      case "chat:visible":
        handlers.onVisible(message.visible === true);
        return;
    }
  }

  window.addEventListener("message", onMessage);

  return {
    active: true,
    badge: (unread, mentions) => post({ type: "chat:badge", unread, mentions }),
    notify: (title, body, href) => post({ type: "chat:notify", title, body, href }),
    expand: (href) => post({ type: "chat:expand", href }),
    dispose: () => window.removeEventListener("message", onMessage),
  };
}

/**
 * Applies the shell's accent override.
 *
 * The shell sends the same brand colour it sets on itself, and both halves read it from the identical
 * Kumo variables, so one assignment is the whole integration.
 */
export function applyAccent(accent: string | undefined): void {
  const root = document.documentElement;
  if (accent === undefined || accent.length === 0) {
    root.style.removeProperty("--color-kumo-brand");
    root.style.removeProperty("--text-color-kumo-brand");
    root.style.removeProperty("--text-color-kumo-link");
    return;
  }
  // Only a CSS colour is accepted; anything else is dropped rather than written into a style attribute.
  if (!/^#[0-9a-f]{3,8}$|^(rgb|hsl|oklch|color)\(/i.test(accent.trim())) return;
  root.style.setProperty("--color-kumo-brand", accent);
  root.style.setProperty("--text-color-kumo-brand", accent);
  root.style.setProperty("--text-color-kumo-link", accent);
}
