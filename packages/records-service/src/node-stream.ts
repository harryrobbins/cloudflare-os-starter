import { Readable, pipeline, type Writable } from 'node:stream';

/** Own both stream error paths; a disconnected HTTP client must not crash the gateway. */
export function pipeResponseBody(body: ReadableStream<Uint8Array>, destination: Writable): void {
  const source = Readable.fromWeb(body as import('node:stream/web').ReadableStream);
  pipeline(source, destination, () => {
    // pipeline cancels the source and destroys the destination on failure. Its callback consumes
    // client-disconnect and origin-body errors; headers may already be sent, so no JSON is appended.
  });
}
