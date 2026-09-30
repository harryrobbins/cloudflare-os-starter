import { afterEach, expect, it, vi } from "vitest";
import { createWebSocketClient } from "./socket.js";

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  send = vi.fn();
  constructor(_url: string) {
    super();
    FakeSocket.instances.push(this);
  }
  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  FakeSocket.instances = [];
});

it("replaces a socket after phone suspension and ignores its late close", () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  const client = createWebSocketClient("ws://localhost/chat");
  client.open();
  const first = FakeSocket.instances[0]!;
  first.open();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  vi.advanceTimersByTime(20_000);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  expect(FakeSocket.instances).toHaveLength(2);
  FakeSocket.instances[1]!.open();
  first.dispatchEvent(new Event("close"));
  expect(client.status()).toBe("open");
  client.close();
  window.dispatchEvent(new Event("online"));
  expect(FakeSocket.instances).toHaveLength(2);
});

it("retries immediately on network recovery and preserves queued subscriptions", () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  const client = createWebSocketClient("ws://localhost/chat");
  client.open();
  FakeSocket.instances[0]!.close();
  client.send({ t: "sub", channels: ["general"] });
  window.dispatchEvent(new Event("online"));
  const next = FakeSocket.instances[1]!;
  next.open();
  expect(next.send).toHaveBeenCalledWith(JSON.stringify({ t: "sub", channels: ["general"] }));
  vi.advanceTimersByTime(1000);
  expect(FakeSocket.instances).toHaveLength(2);
  client.close();
});
