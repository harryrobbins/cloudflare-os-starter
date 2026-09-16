import type { RuntimeRun } from "./types.js";

// Bound before JSON parsing and before storage/RPC. Rich active HTML is never forwarded.
export async function collectOutput(stream: ReadableStream<Uint8Array>, run: RuntimeRun,
    publish: () => void, signal: AbortSignal): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "", bytes = 0, complete = false, lastPublish = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const append = (text: unknown) => {
    if (typeof text !== "string") return;
    const space = Math.max(0, 12_000 - run.text.length);
    run.text += text.slice(0, space);
    if (text.length > space) run.truncated = true;
  };
  try {
    for (;;) {
      if (signal.aborted) throw new Error("Execution interrupted.");
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1_000_000) { run.truncated = true; throw new Error("Execution output exceeded its limit."); }
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 128_000) throw new Error("Execution event exceeded its limit.");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const event = JSON.parse(data);
        if (event.type === "stdout" || event.type === "stderr") append(event.text);
        if (event.type === "result") {
          const value = event.data ?? event;
          append(value["text/plain"] ?? value.text);
          const png = value["image/png"] ?? value.png;
          if (typeof png === "string" && /^[A-Za-z0-9+/=\r\n]+$/.test(png)) {
            if (png.length <= 24_000) run.png = png; else run.truncated = true;
          }
        }
        if (event.type === "error") {
          run.status = "failed";
          complete = true; // Interpreter errors terminate the SSE stream without execution_complete.
          append(`${event.ename ?? "Error"}: ${event.evalue ?? "Execution failed"}\n`);
          if (Array.isArray(event.traceback)) append(event.traceback.filter((v: unknown) => typeof v === "string").join("\n"));
        }
        if (event.type === "execution_complete") {
          complete = true;
          if (Number.isSafeInteger(event.execution_count)) run.executionCount = event.execution_count;
        }
      }
      if (Date.now() - lastPublish > 250) { publish(); lastPublish = Date.now(); }
    }
    if (signal.aborted || !complete) throw new Error("Execution stream ended before completion.");
    if (run.status !== "failed") run.status = "succeeded";
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
