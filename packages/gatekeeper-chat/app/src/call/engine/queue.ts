// One FIFO promise queue per peer connection. The SFU tolerates one negotiation per session at a
// time (overlapping mutations answer 406), and an SFU offer must be answered through `renegotiate`
// before anything else touches the session, so every SDP exchange runs here, start to finish.

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private depth = 0;

  /** Runs `task` after every task queued before it has settled. A failing task does not block the queue. */
  run<T>(task: () => Promise<T>): Promise<T> {
    this.depth += 1;
    const result = this.tail.then(task);
    this.tail = result.then(
      () => {
        this.depth -= 1;
      },
      () => {
        this.depth -= 1;
      },
    );
    return result;
  }

  /** Tasks queued or running. */
  get size(): number {
    return this.depth;
  }
}

/** Thrown inside a queued task when the connection it belonged to was torn down or rebuilt. */
export class Superseded extends Error {
  constructor() {
    super("superseded");
    this.name = "Superseded";
  }
}
