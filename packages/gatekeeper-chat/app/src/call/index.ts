// Builds the app's one CallEngine.
//
// Mock builds get the loop-back fake (`mock-engine.ts`), reached through a dynamic import behind the
// `__CHAT_MOCK__` build constant exactly as `api/transport.ts` reaches the fake transport, so a
// production bundle contains neither. Everywhere else it is the real engine over the chat API and the
// app's socket. A browser without WebRTC gets no engine at all: the room state still reaches the rail
// and the history, and the call pane explains that this browser cannot join.

import type { Transport } from "../api/types.js";
import { createBrowserCallEnvironment } from "./engine/browser-env.js";
import { createCallEngine } from "./engine/engine.js";
import type { CallEngine } from "./engine/types.js";

export async function createAppCallEngine(transport: Transport): Promise<CallEngine | null> {
  if (__CHAT_MOCK__) {
    const { createMockCallEngine } = await import("./mock-engine.js");
    return createMockCallEngine({ api: transport.api, send: (event) => transport.socket.send(event) });
  }
  if (typeof RTCPeerConnection === "undefined") return null;
  try {
    return createCallEngine({
      api: transport.api,
      send: (event) => transport.socket.send(event),
      env: createBrowserCallEnvironment(),
      log: (event, fields) => {
        if (__DEV_BUILD__) console.debug(`[call] ${event}`, fields ?? {});
      },
    });
  } catch (cause) {
    // A missing engine must not take chat down with it.
    console.warn("Calls are unavailable in this browser.", cause);
    return null;
  }
}
