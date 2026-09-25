import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { pipeResponseBody } from '../src/node-stream.ts';

test('disconnect cancels upstream web body and consumes the destination error', async () => {
  let resolveCancelled!: () => void;
  const cancelled = new Promise<void>(resolve => { resolveCancelled = resolve; });
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('first chunk')); },
    cancel() { resolveCancelled(); },
  });
  const destination = new PassThrough();
  const received = new Promise<void>(resolve => destination.once('data', () => resolve()));
  // No error listener is installed by the test: the production helper must own that error.
  pipeResponseBody(body, destination);
  await received;
  destination.destroy(new Error('simulated client connection reset'));
  await cancelled;
  assert.equal(destination.destroyed, true);
});

test('origin failure after response starts destroys destination without an uncaught source error', async () => {
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; controller.enqueue(new TextEncoder().encode('partial response')); } });
  const destination = new PassThrough();
  const received = new Promise<void>(resolve => destination.once('data', () => resolve()));
  const closed = new Promise<void>(resolve => destination.once('close', () => resolve()));
  pipeResponseBody(body, destination);
  await received;
  upstream.error(new Error('upstream response failed'));
  await closed;
  assert.equal(destination.destroyed, true);
});

test('normal streaming body completes and preserves bytes', async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3])); controller.close(); } });
  const destination = new PassThrough(); const chunks: Buffer[] = [];
  destination.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>(resolve => destination.once('finish', () => resolve()));
  pipeResponseBody(body, destination); await finished;
  assert.deepEqual([...Buffer.concat(chunks)], [1, 2, 3]);
});
