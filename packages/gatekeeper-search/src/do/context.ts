// What every SearchIndex module is handed. Built once in the Durable Object's constructor.

import type { DenseIndex } from "../dense.js";
import type { SearchEnv } from "../env.js";

export interface Ctx {
  readonly sql: SqlStorage;
  readonly storage: DurableObjectStorage;
  readonly env: SearchEnv;
  now(): number;
  /** The dense index, or null when this deployment runs lexical-only. */
  dense(): DenseIndex | null;
  /** Sends chunk ids to the EMBED queue. Returns how many were sent. Never throws. */
  enqueue(chunkIds: readonly string[]): Promise<number>;
  /** Makes sure the tombstone purge alarm will run. */
  armPurge(): Promise<void>;
}
