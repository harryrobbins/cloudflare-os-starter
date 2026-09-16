// @ts-check
import { vi } from "vitest";
import { createStore } from "../../src/client/sync/store.js";
import { FakeRpcTarget, FakeServer } from "./fake-gadget.js";

export { FakeServer };

let clientCounter = 0;

/**
 * Starts a store against the fake server. Requires vi.useFakeTimers().
 * @param {FakeServer} server
 * @param {string} name
 */
export async function startStore(server, name) {
  const clientId = "client-" + name + "-" + ++clientCounter;
  const promise = createStore({
    gadget: server.connect(),
    RpcTarget: FakeRpcTarget,
    viewer: { clientId, name, color: "#123456" },
  });
  let ready = false;
  promise.then(() => { ready = true; });
  for (let i = 0; i < 200 && !ready; i++) await settle(10);
  const store = await promise;
  /** @type {{state: any, change: any}[]} */
  const changes = [];
  store.subscribe((state, change) => changes.push({ state, change }));
  return { store, clientId, changes };
}

/** Runs timers and microtasks for `ms` of fake time. */
export async function settle(ms = 50) {
  await vi.advanceTimersByTimeAsync(ms);
}

/**
 * Strips nothing; returns the card map of a store's optimistic board for comparison.
 * @param {import("../../src/client/store-contract.js").Store} store
 */
export function cardsOf(store) {
  return store.getState().board.cards;
}
