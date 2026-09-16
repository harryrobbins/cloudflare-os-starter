import type { RuntimeIntent } from "./types.js";

export function validateIntent(input: RuntimeIntent): RuntimeIntent {
  if (!input || typeof input !== "object" || !/^[a-f0-9-]{36}$/.test(input.requestId) ||
      !Number.isSafeInteger(input.sequence) || input.sequence < 0 ||
      !Number.isSafeInteger(input.generation) || input.generation < 0 ||
      !Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 0 ||
      typeof input.cellId !== "string" || input.cellId.length > 64 ||
      typeof input.source !== "string" || input.source.length > 16_000 ||
      !["execute", "stop"].includes(input.operation)) throw new Error("Invalid runtime operation.");
  if (input.operation === "stop" && (input.source || input.cellId)) throw new Error("Invalid stop operation.");
  return { requestId: input.requestId, sequence: input.sequence, generation: input.generation,
    operation: input.operation, cellId: input.cellId, sourceRevision: input.sourceRevision, source: input.source };
}

export async function intentHash(input: RuntimeIntent): Promise<string> {
  const canonical = JSON.stringify(["notebook-runtime-v1", validateIntent(input)]);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)))].map(b => b.toString(16).padStart(2, "0")).join("");
}
