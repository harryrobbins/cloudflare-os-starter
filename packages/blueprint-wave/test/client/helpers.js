// @ts-check
// Generic helpers for client tests under fake timers. `startStore` accepts either a FakeServer
// (test/client/fake-gadget.js; a fresh stub is connected per store) or a {gadget, RpcTarget}
// transport (e.g. a wrapped stub, or net.js once it is adapted to the Wave core).
import { vi } from "vitest";
import { createStore } from "../../src/client/sync/store.js";
import { FakeRpcTarget, FakeServer, fakeId } from "./fake-gadget.js";

export { FakeServer, FakeRpcTarget, fakeId };

let clientCounter = 0;

/**
 * Starts a store. Requires vi.useFakeTimers().
 * @param {FakeServer|{gadget: any, RpcTarget: any}} transport
 * @param {string} name
 * @param {{clientId?: string, participantId?: string, gadget?: any, onUnrecoverable?: () => void}} [options]
 */
export async function startStore(transport, name, { clientId = "client-" + name + "-" + ++clientCounter, participantId = "p-" + name, gadget, onUnrecoverable } = {}) {
  const isServer = transport instanceof FakeServer;
  const promise = createStore({
    gadget: gadget ?? (isServer ? transport.connect() : transport.gadget),
    RpcTarget: isServer ? FakeRpcTarget : transport.RpcTarget,
    viewer: { clientId, participantId, name, color: "#123456" },
    onUnrecoverable,
  });
  let ready = false;
  promise.then(() => { ready = true; }, () => { ready = true; });
  for (let i = 0; i < 200 && !ready; i++) await settle(10);
  const store = await promise;
  /** @type {{state: any, change: any}[]} */
  const changes = [];
  store.subscribe((state, change) => changes.push({ state, change }));
  return { store, clientId, changes };
}

/**
 * Awaits a store call under fake timers: advances time in steps until the promise settles, then
 * returns its value (or throws its error). A plain `await` would hang on the fake latency timer.
 * @template T @param {Promise<T>} promise @param {number} [maxMs]
 * @returns {Promise<T>}
 */
export async function resolved(promise, maxMs = 5000) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  for (let t = 0; t < maxMs && !done; t += 10) await settle(10);
  return promise;
}

/** Runs timers and microtasks for `ms` of fake time. */
export async function settle(ms = 50) {
  await vi.advanceTimersByTimeAsync(ms);
}

/**
 * The blips of a store's optimistic state as a plain record, for comparison.
 * @param {import("../../src/client/store-contract.js").Store} store
 */
export function blipsOf(store) {
  return { ...store.getState().blips };
}
