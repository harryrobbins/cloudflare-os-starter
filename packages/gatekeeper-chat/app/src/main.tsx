// Entry point: build the transport, start the store, wire the browser-level signals it cannot observe
// for itself (visibility, focus, the OS theme, the embed bridge), and mount the router.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";

import "./styles.css";

import { createTransport } from "./api/transport.js";
import { StoreProvider } from "./hooks/store.js";
import { applyAccent, createBridge, isEmbedded } from "./lib/bridge.js";
import { attachStore, navigateToAppPath, router } from "./router.js";
import { ChatStore } from "./store/store.js";

async function main(): Promise<void> {
  const root = document.querySelector("#root");
  if (root === null) throw new Error("The app root is missing from index.html.");

  const embedded = isEmbedded();
  const transport = await createTransport();
  const store = new ChatStore({ transport, navigate: navigateToAppPath });
  attachStore(store);
  store.setNavigate(navigateToAppPath);

  const bridge = createBridge(
    {
      onOpen: (href) => navigateToAppPath(href),
      onTheme: (mode, accent) => {
        // The shell's choice wins over the media query but is not persisted: it is the shell's
        // preference, not this app's, and a later standalone visit should follow the OS again.
        store.setTheme(mode, { persist: false });
        applyAccent(accent);
      },
      onVisible: (visible) => store.setVisible(visible),
    },
    embedded,
  );

  if (bridge.active) {
    store.onBadgeChange = (unread, mentions) => bridge.badge(unread, mentions);
    store.onNotify = (title, body, href) => bridge.notify(title, body, href);
  }

  // The three browser signals the read model depends on: is the document visible, is the window focused,
  // and has the OS theme changed while no explicit override is set.
  document.addEventListener("visibilitychange", () => {
    store.setVisible(document.visibilityState === "visible");
  });
  window.addEventListener("focus", () => store.setFocused(true));
  window.addEventListener("blur", () => store.setFocused(false));
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => store.systemThemeChanged());

  if (embedded) document.documentElement.dataset.embed = "1";

  await store.start({ embedded });

  createRoot(root).render(
    <StrictMode>
      <StoreProvider store={store}>
        <RouterProvider router={router} />
      </StoreProvider>
    </StrictMode>,
  );
}

void main().catch((cause: unknown) => {
  // Nothing rendered, so there is no toast to raise; a plain message beats a blank page.
  const root = document.querySelector("#root");
  if (root !== null) {
    root.textContent =
      cause instanceof Error ? `Chat failed to start: ${cause.message}` : "Chat failed to start.";
  }
});
