// Entry point: follow the system theme, build the API client (the mock in mock builds), mount.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

import { createApi } from "./api/index.js";
import { App } from "./App.js";

function followSystemTheme(): void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = (): void => {
    document.documentElement.dataset.mode = media.matches ? "dark" : "light";
  };
  apply();
  media.addEventListener("change", apply);
}

async function main(): Promise<void> {
  const root = document.querySelector("#root");
  if (root === null) throw new Error("The app root is missing from index.html.");
  followSystemTheme();
  const api = await createApi();
  createRoot(root).render(
    <StrictMode>
      <App api={api} />
    </StrictMode>,
  );
}

void main().catch((cause: unknown) => {
  const root = document.querySelector("#root");
  if (root !== null) {
    root.textContent = cause instanceof Error ? `Search failed to start: ${cause.message}` : "Search failed to start.";
  }
});
