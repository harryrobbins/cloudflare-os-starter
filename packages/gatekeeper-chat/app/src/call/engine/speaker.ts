// Active-speaker detection over sampled audio levels: exponential smoothing, a threshold, and a
// hold time, so the highlighted tile follows whoever dominates for a second rather than every
// cough. Pure; the engine feeds it samples every 250 ms.

export interface SpeakerOptions {
  /** Weight of the newest sample, 0..1. */
  readonly alpha?: number;
  /** Smoothed level below which a participant counts as silent. */
  readonly threshold?: number;
  /** How long a challenger (or silence) must dominate before the active speaker changes. */
  readonly holdMs?: number;
}

export interface SpeakerSample {
  /** Smoothed levels, 0..1, for every id sampled this round. */
  readonly levels: ReadonlyMap<string, number>;
  readonly active: string | null;
}

export class SpeakerDetector {
  private readonly alpha: number;
  private readonly threshold: number;
  private readonly holdMs: number;
  private smoothed = new Map<string, number>();
  private active: string | null = null;
  /** Who is currently louder than the active speaker (null = silence), and since when. */
  private challenger: { id: string | null; since: number } | null = null;

  constructor(options: SpeakerOptions = {}) {
    this.alpha = options.alpha ?? 0.5;
    this.threshold = options.threshold ?? 0.05;
    this.holdMs = options.holdMs ?? 1000;
  }

  update(now: number, raw: ReadonlyMap<string, number>): SpeakerSample {
    const next = new Map<string, number>();
    for (const [id, level] of raw) {
      const previous = this.smoothed.get(id) ?? 0;
      next.set(id, previous * (1 - this.alpha) + clamp01(level) * this.alpha);
    }
    this.smoothed = next;

    if (this.active !== null && !next.has(this.active)) {
      this.active = null;
      this.challenger = null;
    }

    let loudest: string | null = null;
    let loudestLevel = this.threshold;
    for (const [id, level] of next) {
      if (level >= loudestLevel) {
        loudest = id;
        loudestLevel = level;
      }
    }

    if (loudest === this.active) {
      this.challenger = null;
    } else if (this.challenger === null || this.challenger.id !== loudest) {
      this.challenger = { id: loudest, since: now };
    } else if (now - this.challenger.since >= this.holdMs) {
      this.active = loudest;
      this.challenger = null;
    }
    return { levels: next, active: this.active };
  }

  reset(): void {
    this.smoothed.clear();
    this.active = null;
    this.challenger = null;
  }
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}
