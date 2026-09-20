// Picks the transport.
//
// `__CHAT_MOCK__` is a build-time constant (see app/vite.config.ts), not an environment lookup, so in a
// production build this collapses to `if (false)` and Rollup drops the branch -- including the dynamic
// `import("../mock/index.js")`, which is why the fake never reaches the shipped bundle.

import { createHttpApi } from "./http.js";
import { createWebSocketClient } from "./socket.js";
import type { Transport } from "./types.js";

export async function createTransport(): Promise<Transport> {
  if (__CHAT_MOCK__) {
    const { createMockTransport } = await import("../mock/index.js");
    return createMockTransport();
  }
  return { api: createHttpApi(), socket: createWebSocketClient() };
}
