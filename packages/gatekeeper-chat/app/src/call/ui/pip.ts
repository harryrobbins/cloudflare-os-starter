// Document Picture-in-Picture for the call (Chrome and Edge 116+): the call grid and a small control
// bar in an always-on-top window, so a call keeps its faces while the person works in another tab.
//
// Only a top-level page may open one (the API refuses a request from inside an iframe), so this is
// offered when chat is opened on its own, not inside the shell's dock or `/chat` page, and nowhere
// the API is missing. The window shares this document's JavaScript realm: React renders into it
// through a portal, the store and the engine are the same objects, and a `MediaStream` plays there
// unchanged. What it does not share is CSS, so every stylesheet is copied across when it opens.

import { useSyncExternalStore } from "react";

interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number; disallowReturnToOpener?: boolean }): Promise<Window>;
  readonly window: Window | null;
}

function api(target: Window | undefined = typeof window === "undefined" ? undefined : window): DocumentPictureInPicture | null {
  const candidate = (target as { documentPictureInPicture?: DocumentPictureInPicture } | undefined)?.documentPictureInPicture;
  return candidate !== undefined && typeof candidate.requestWindow === "function" ? candidate : null;
}

/** True where a call can pop out into its own window: the API exists and this is the top page. */
export function canPictureInPicture(target: Window | undefined = typeof window === "undefined" ? undefined : window): boolean {
  if (target === undefined || api(target) === null) return false;
  try {
    return target.top === target;
  } catch {
    // A cross-origin parent makes `top` unreadable: framed, so no.
    return false;
  }
}

let current: Window | null = null;
const listeners = new Set<() => void>();

function setCurrent(next: Window | null): void {
  if (current === next) return;
  current = next;
  for (const listener of listeners) listener();
}

/** The open call window, or null. For `useSyncExternalStore`. */
export function pipWindow(): Window | null {
  return current;
}

export function subscribePip(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePipWindow(): Window | null {
  return useSyncExternalStore(subscribePip, pipWindow, () => null);
}

/** Copies every stylesheet, and the root's theme attributes, into the new window's document. */
export function copyStyles(from: Document, to: Document): void {
  for (const sheet of Array.from(from.styleSheets)) {
    try {
      const style = to.createElement("style");
      style.textContent = Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n");
      to.head.append(style);
    } catch {
      // A cross-origin sheet hides its rules; link to it instead.
      if (sheet.href !== null) {
        const link = to.createElement("link");
        link.rel = "stylesheet";
        link.href = sheet.href;
        to.head.append(link);
      }
    }
  }
  const root = to.documentElement;
  root.className = from.documentElement.className;
  for (const [key, value] of Object.entries(from.documentElement.dataset)) {
    if (value !== undefined) root.dataset[key] = value;
  }
  // The window is always the compact layout, whatever the page it came from.
  root.dataset.compact = "1";
  to.body.className = from.body.className;
}

/**
 * Opens the call window (from a click: the API needs a user gesture). Resolves false when the
 * browser refused or the API is missing; an already open window is reused.
 */
export async function openPictureInPicture(size: { width: number; height: number } = { width: 400, height: 520 }): Promise<boolean> {
  if (current !== null) return true;
  const pip = api();
  if (pip === null || !canPictureInPicture()) return false;
  let opened: Window;
  try {
    opened = await pip.requestWindow(size);
  } catch {
    return false;
  }
  copyStyles(document, opened.document);
  opened.document.title = "Call";
  opened.addEventListener("pagehide", () => {
    if (current === opened) setCurrent(null);
  });
  setCurrent(opened);
  return true;
}

/** Closes the call window; the call carries on in the page. */
export function closePictureInPicture(): void {
  const opened = current;
  setCurrent(null);
  opened?.close();
}

/** The theme follows the page: a later change is mirrored into an open window. */
export function syncPipTheme(): void {
  if (current === null) return;
  const root = current.document.documentElement;
  for (const [key, value] of Object.entries(document.documentElement.dataset)) {
    if (value !== undefined && key !== "compact") root.dataset[key] = value;
  }
}
