// Warn before closing a page that holds changes the server has not acknowledged (plan §6:
// pending mutations live in memory only; a page with unsynced changes says so).

type UnloadTarget = {
  addEventListener(type: "beforeunload", listener: (event: { preventDefault(): void; returnValue?: unknown }) => void): void;
  removeEventListener(type: "beforeunload", listener: (event: { preventDefault(): void; returnValue?: unknown }) => void): void;
};

/**
 * Adds a `beforeunload` guard that asks the browser to confirm leaving while
 * `client.hasUnsyncedChanges`. It also tries one last push. Returns a remover.
 */
export function guardUnload(
  client: { readonly hasUnsyncedChanges: boolean; flush(): Promise<void> },
  target: UnloadTarget = globalThis as unknown as UnloadTarget,
): () => void {
  const listener = (event: { preventDefault(): void; returnValue?: unknown }) => {
    if (!client.hasUnsyncedChanges) return;
    void client.flush();
    event.preventDefault();
    // Older browsers need returnValue set to show the prompt.
    event.returnValue = "";
  };
  target.addEventListener("beforeunload", listener);
  return () => target.removeEventListener("beforeunload", listener);
}
