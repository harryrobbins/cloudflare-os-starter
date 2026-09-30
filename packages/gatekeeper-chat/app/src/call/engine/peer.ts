// Bounded waits on one RTCPeerConnection. Event-driven, with the timeout on the injected clock so
// tests control it.

import type { CallEnvironment } from "./types.js";
import { bytesSent } from "./stats.js";

type Clock = Pick<CallEnvironment, "setTimeout" | "clearTimeout">;

/** Waits for ICE gathering to complete, or `capMs`, whichever is first. Never rejects. */
export function waitForIceGathering(pc: RTCPeerConnection, clock: Clock, capMs: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clock.clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = (): void => {
      if (pc.iceGatheringState === "complete") done();
    };
    const timer = clock.setTimeout(done, capMs);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

/** Resolves true once `connectionState` is `connected`; false on `failed`/`closed` or after `capMs`. */
export function waitForConnected(pc: RTCPeerConnection, clock: Clock, capMs: number): Promise<boolean> {
  if (pc.connectionState === "connected") return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean): void => {
      clock.clearTimeout(timer);
      pc.removeEventListener("connectionstatechange", check);
      resolve(ok);
    };
    const check = (): void => {
      const state = pc.connectionState;
      if (state === "connected") done(true);
      else if (state === "failed" || state === "closed") done(false);
    };
    const timer = clock.setTimeout(() => done(false), capMs);
    pc.addEventListener("connectionstatechange", check);
  });
}

/**
 * Polls each sender until its `outbound-rtp bytesSent > 0`, or `capMs`. Resolves the senders that
 * were confirmed; announcing only those keeps pullers from hitting `empty_track_error`.
 */
export async function waitForBytesSent(
  senders: readonly RTCRtpSender[],
  clock: Clock,
  capMs: number,
  pollMs = 100,
  isCurrent: () => boolean = () => true,
): Promise<Set<RTCRtpSender>> {
  const confirmed = new Set<RTCRtpSender>();
  let waited = 0;
  for (;;) {
    for (const sender of senders) {
      if (confirmed.has(sender)) continue;
      try {
        if ((await bytesSent(sender)) > 0) confirmed.add(sender);
      } catch {
        // A sender whose transceiver was stopped meanwhile: leave it unconfirmed.
      }
    }
    if (confirmed.size === senders.length || waited >= capMs || !isCurrent()) return confirmed;
    await new Promise<void>((resolve) => clock.setTimeout(resolve, pollMs));
    waited += pollMs;
  }
}
