// Bounded waits on one RTCPeerConnection. Event-driven, with the timeout on the injected clock so
// tests control it.

import type { CallEnvironment } from "./types.js";
import { bytesSent } from "./stats.js";

type Clock = Pick<CallEnvironment, "setTimeout" | "clearTimeout" | "now">;

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
 * Polls the senders until each one's `outbound-rtp bytesSent > 0`, or `capMs` on the clock. Every
 * poll reads the unconfirmed senders' stats together. Resolves the senders that were confirmed;
 * announcing only those keeps pullers from hitting `empty_track_error`.
 */
export async function waitForBytesSent(
  senders: readonly RTCRtpSender[],
  clock: Clock,
  capMs: number,
  pollMs = 100,
  isCurrent: () => boolean = () => true,
): Promise<Set<RTCRtpSender>> {
  const confirmed = new Set<RTCRtpSender>();
  const started = clock.now();
  for (;;) {
    const pending = senders.filter((sender) => !confirmed.has(sender));
    // A sender whose transceiver was stopped meanwhile rejects: leave it unconfirmed.
    const sent = await Promise.all(pending.map((sender) => bytesSent(sender).catch(() => 0)));
    pending.forEach((sender, index) => {
      if (sent[index]! > 0) confirmed.add(sender);
    });
    if (confirmed.size === senders.length || clock.now() - started >= capMs || !isCurrent()) return confirmed;
    await new Promise<void>((resolve) => clock.setTimeout(resolve, pollMs));
  }
}
