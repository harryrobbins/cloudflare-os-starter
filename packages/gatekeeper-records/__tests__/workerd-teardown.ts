// Stops the embedded Postgres that vitest.worker.config.ts started at config time.
export async function teardown(): Promise<void> {
  await (globalThis as { __recordsTestCluster?: { stop(): Promise<void> } }).__recordsTestCluster?.stop();
}
