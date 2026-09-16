/** Immutable operation on this connection's Python kernel. */
export interface RuntimeIntent {
  /** Client-generated UUID, reused only when retrying this exact request. */
  requestId: string;
  /** Monotonic reservation sequence returned by getStatus(). */
  sequence: number;
  /** Kernel generation returned by getStatus(); stale requests are rejected. */
  generation: number;
  /** Stop discards the kernel and its temporary files, including an active execution. */
  operation: "execute" | "stop";
  /** Stable notebook cell ID (empty for stop). */
  cellId: string;
  /** Exact source revision; results never silently belong to newer source. */
  sourceRevision: number;
  /** Python source, at most 16,000 characters (empty for stop). */
  source: string;
}
/** A bounded execution result, safe to save as notebook data. */
export interface RuntimeRun {
  id: string;
  sequence: number;
  generation: number;
  cellId: string;
  sourceRevision: number;
  status: "pending" | "submission-unknown" | "running" | "succeeded" | "failed" | "rejected" | "interrupted";
  text: string;
  png?: string;
  truncated: boolean;
  executionCount?: number;
}
/** Python state is temporary. Saved notebook cells and outputs survive kernel loss. */
export interface RuntimeStatus {
  sequence: number;
  generation: number;
  active: RuntimeRun | null;
}
/** One isolated Python kernel. Results are visible to authorized workspace collaborators. */
export interface NotebookRuntime {
  /** Read lifecycle state without starting a container. */
  getStatus(): Promise<RuntimeStatus>;
  /** Submit an immutable operation with an owner-issued, one-use permit. No output is fabricated. */
  submit(intent: RuntimeIntent, ownerPermit: string): Promise<RuntimeRun>;
  /** Read an existing run. Old runs may expire; this never re-executes code. */
  getRun(id: string): Promise<RuntimeRun | null>;
}
