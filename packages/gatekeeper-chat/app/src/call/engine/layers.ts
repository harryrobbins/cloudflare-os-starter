// Per-track debounce of simulcast layer requests. The UI reports tile sizes on every layout change;
// a layer switch goes to the SFU only once the wanted layer has been stable for `delayMs` and only
// when it differs from the layer currently requested.

import type { CallSimulcastRid } from "../../contract.js";
import type { CallEnvironment } from "./types.js";

type Clock = Pick<CallEnvironment, "setTimeout" | "clearTimeout">;

export class LayerScheduler {
  private readonly pending = new Map<string, { rid: CallSimulcastRid; timer: unknown }>();

  constructor(
    private readonly clock: Clock,
    private readonly delayMs: number,
    /** The layer the SFU was last asked for, or null when the track is gone. */
    private readonly current: (key: string) => CallSimulcastRid | null,
    private readonly apply: (key: string, rid: CallSimulcastRid) => void,
  ) {}

  want(key: string, rid: CallSimulcastRid): void {
    const existing = this.pending.get(key);
    if (existing) {
      if (existing.rid === rid) return;
      this.clock.clearTimeout(existing.timer);
      this.pending.delete(key);
    }
    if (this.current(key) === rid) return;
    const timer = this.clock.setTimeout(() => {
      this.pending.delete(key);
      const now = this.current(key);
      if (now !== null && now !== rid) this.apply(key, rid);
    }, this.delayMs);
    this.pending.set(key, { rid, timer });
  }

  forget(key: string): void {
    const existing = this.pending.get(key);
    if (existing) this.clock.clearTimeout(existing.timer);
    this.pending.delete(key);
  }

  clear(): void {
    for (const { timer } of this.pending.values()) this.clock.clearTimeout(timer);
    this.pending.clear();
  }
}
