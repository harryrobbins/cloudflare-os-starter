import type { DiagramCapabilities, DiagramRequest } from "./types.js";

/** Closed set of render options and resource limits exposed to callers. */
export const CAPABILITIES: DiagramCapabilities = {
  languages: ["d2", "mermaid"], layouts: ["tala", "dagre", "elk"],
  formats: ["svg", "png", "jpeg", "webp", "pdf", "ascii", "source", "d2", "json"],
  maxSourceBytes: 100_000, maxOutputBytes: 16 * 1024 * 1024, maxRasterPixels: 32_000_000,
  externalResources: false,
};

/** Validate before launching a browser or submitting an observation. */
export function normalizeRequest(input: DiagramRequest): Required<DiagramRequest> {
  if (!input || typeof input !== "object" || typeof input.source !== "string" || !input.source.trim()) throw new Error("invalid_request: source must be a non-empty string.");
  if (new TextEncoder().encode(input.source).length > CAPABILITIES.maxSourceBytes) throw new Error("invalid_request: source exceeds 100,000 UTF-8 bytes.");
  const request: Required<DiagramRequest> = { language: "d2", layout: "tala", format: "svg", theme: 104, sketch: false, scale: 2, ...input };
  if (!CAPABILITIES.languages.includes(request.language)) throw new Error("invalid_request: language must be d2 or mermaid.");
  if (!CAPABILITIES.layouts.includes(request.layout)) throw new Error("invalid_request: layout must be tala, dagre or elk.");
  if (!CAPABILITIES.formats.includes(request.format)) throw new Error("invalid_request: unsupported output format.");
  if (![0, 1, 103, 104, 200].includes(request.theme)) throw new Error("invalid_request: unsupported theme.");
  if (typeof request.sketch !== "boolean") throw new Error("invalid_request: sketch must be boolean.");
  if (![1, 2, 3].includes(request.scale)) throw new Error("invalid_request: scale must be 1, 2 or 3.");
  return request;
}
