import type { PrincipalRef } from "@records/contracts";

import { SyncClient, type SyncClientOptions } from "../src/client.js";
import { projectMutators } from "../src/mutators/projects.js";
import type { FakeServer, FakeTransport } from "./fake-server.js";

/** mulberry32: small seeded RNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type TestClient = {
  client: SyncClient<typeof projectMutators>;
  transport: FakeTransport;
  principal: PrincipalRef;
  /** When true, pokes for this client are dropped. */
  dropPokes: { value: boolean };
};

let clientCounter = 0;

export function makeClient(
  server: FakeServer,
  principal: PrincipalRef,
  opts: Partial<SyncClientOptions<typeof projectMutators>> = {},
  flags: { approvals?: boolean } = {},
): TestClient {
  const transport = server.transport(principal);
  const wire =
    flags.approvals === false ? { push: transport.push.bind(transport), pull: transport.pull.bind(transport) } : transport;
  const dropPokes = { value: false };
  const n = ++clientCounter;
  const client = new SyncClient({
    transport: wire,
    principal,
    clientGroupId: `group-${n.toString().padStart(6, "0")}`,
    clientId: `client-${n.toString().padStart(6, "0")}`,
    pushDelayMs: 0,
    safetyPullIntervalMs: 0,
    retryBaseMs: 1,
    retryMaxMs: 4,
    onPoke: (handler) =>
      server.subscribePokes((head) => {
        if (!dropPokes.value) handler(head);
      }),
    ...opts,
  });
  return { client, transport, principal, dropPokes };
}

/** Let fire-and-forget pushes/pulls finish. */
export async function settle(ms = 5): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Sync until the client has nothing unsynced and holds the server head. */
export async function converge(c: TestClient, server: FakeServer): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await c.client.sync();
    if (!c.client.hasUnsyncedChanges && c.client.pending().length === 0 && c.client.cookie === server.seq) return;
  }
  throw new Error("client did not converge");
}
