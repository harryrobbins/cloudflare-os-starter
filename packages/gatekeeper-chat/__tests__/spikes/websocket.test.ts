// Spike 2 (chat.md phase 0, item 1), local half: a WebSocket upgrade forwarded over a service
// binding, exactly as cfos-router forwards `/gatekeeper/chat/*`, reaches a hibernatable Durable
// Object; messages round-trip; and a second socket carrying the same tag receives the fan-out.
//
// The chain is main -> ROUTER (auxiliary Worker) -> CHAT (auxiliary Worker) -> SpikeWs DO. See
// vitest.config.ts for why the router has to be an auxiliary Worker.
import { env, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const WS_URL = "https://chat.example.test/gatekeeper/chat/ws";

interface EchoFrame {
  readonly t: "echo";
  readonly from: string;
  readonly seq: number;
  readonly body: string;
}

/** Opens a socket through the router and returns it already accepted. */
async function connect(user: string): Promise<WebSocket> {
  const response = await env.ROUTER.fetch(`${WS_URL}?user=${encodeURIComponent(user)}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (socket === null) throw new Error("The upgrade did not survive the service-binding hop.");
  socket.accept();
  return socket;
}

/** Resolves with the next `n` text frames, so a fan-out assertion cannot pass on a race. */
function collect(socket: WebSocket, n: number): Promise<EchoFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: EchoFrame[] = [];
    const timer = setTimeout(
      () => reject(new Error(`Only ${frames.length} of ${n} frames arrived`)),
      5_000,
    );
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String(event.data)) as EchoFrame);
      if (frames.length < n) return;
      clearTimeout(timer);
      resolve(frames);
    });
    socket.addEventListener("error", (event) => {
      clearTimeout(timer);
      reject(new Error(`socket error: ${String(event)}`));
    });
  });
}

describe("spike: WebSocket upgrade through a service binding", () => {
  it("routes a non-prefixed path nowhere, so the prefix is doing the work", async () => {
    const response = await env.ROUTER.fetch("https://chat.example.test/elsewhere");
    expect(response.status).toBe(404);
  });

  it("reaches the Durable Object and round-trips a message", async () => {
    const socket = await connect("user1");
    const frames = collect(socket, 1);
    socket.send("hello");
    const [frame] = await frames;
    expect(frame).toMatchObject({ t: "echo", from: "user1", seq: 1, body: "hello" });
    socket.close(1000, "done");
  });

  it("fans out to every socket carrying the same tag", async () => {
    const first = await connect("user2");
    const second = await connect("user2");
    const onFirst = collect(first, 1);
    const onSecond = collect(second, 1);

    first.send("from the first tab");

    expect((await onFirst)[0]).toMatchObject({ from: "user2", body: "from the first tab" });
    expect((await onSecond)[0]).toMatchObject({ from: "user2", body: "from the first tab" });

    first.close(1000, "done");
    second.close(1000, "done");
  });

  it("does not fan out to a different tag", async () => {
    const mine = await connect("user3");
    const theirs = await connect("user4");

    const otherFrames: string[] = [];
    theirs.addEventListener("message", (event) => otherFrames.push(String(event.data)));

    const onMine = collect(mine, 1);
    mine.send("private");
    await onMine;
    expect(otherFrames).toEqual([]);

    mine.close(1000, "done");
    theirs.close(1000, "done");
  });

  it("keeps the per-socket attachment across frames", async () => {
    const socket = await connect("user5");
    const frames = collect(socket, 2);
    socket.send("one");
    socket.send("two");
    const [a, b] = await frames;
    // The counter lives only in serializeAttachment(), so an incrementing seq is proof the attachment
    // was read back and rewritten rather than reconstructed from nothing.
    expect(a?.seq).toBe(1);
    expect(b?.seq).toBe(2);
    socket.close(1000, "done");
  });

  it("exposes the attachment through getWebSockets(tag) to a plain request", async () => {
    const socket = await connect("user6");
    const frames = collect(socket, 1);
    socket.send("bump");
    await frames;

    const response = await env.ROUTER.fetch(
      "https://chat.example.test/gatekeeper/chat/sockets?user=user6",
    );
    const state = (await response.json()) as {
      tags: readonly { userId: string; seq: number }[];
      total: number;
    };
    expect(state.tags).toHaveLength(1);
    expect(state.tags[0]).toMatchObject({ userId: "user6", seq: 1 });
    expect(state.total).toBeGreaterThanOrEqual(1);

    socket.close(1000, "done");
  });
});

describe("spike: hibernation survives eviction", () => {
  it("restores the socket and its attachment after the Durable Object is torn down", async () => {
    const stub = env.SPIKE_WS_LOCAL.get(env.SPIKE_WS_LOCAL.idFromName(`evict-${crypto.randomUUID()}`));
    const response = await stub.fetch("https://do.invalid/?user=user7", {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (socket === null) throw new Error("no socket");
    socket.accept();

    const first = collect(socket, 1);
    socket.send("before");
    expect((await first)[0]?.seq).toBe(1);

    // Tears down the instance, hibernating the socket rather than closing it.
    await evictDurableObject(stub, { webSockets: "hibernate" });

    const second = collect(socket, 1);
    socket.send("after");
    // Nothing but serializeAttachment() carried the counter across the eviction.
    expect((await second)[0]).toMatchObject({ from: "user7", seq: 2, body: "after" });
    await expect(stub.attachments("user7")).resolves.toEqual([
      expect.objectContaining({ userId: "user7", seq: 2 }),
    ]);

    socket.close(1000, "done");
  });
});
