// Placeholder entry: enough for the assets spike to have a hashed module to fetch, and enough to
// prove the API is reachable from the app's own origin. Stream B replaces it.
import { apiPath } from "../../src/shared/routes.js";
import type { MeResponse } from "../../src/shared/protocol.js";

async function main(): Promise<void> {
  const root = document.querySelector("#root");
  if (root === null) return;
  const response = await fetch(apiPath("me"), { headers: { accept: "application/json" } });
  if (!response.ok) {
    root.textContent = `Chat is not available (${response.status}).`;
    return;
  }
  const me = (await response.json()) as MeResponse;
  root.textContent = `Signed in as ${me.user.name}.`;
}

void main();
