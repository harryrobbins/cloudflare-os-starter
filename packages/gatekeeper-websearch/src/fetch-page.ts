// HTTPS GET for the Websafe tool, ported from the Workshop's built-in webFetch
// (cloudflare-os/packages/workshop-backend/src/web-fetch.ts): same limits, same Markdown
// conversion, same Content-Signal respect. The only difference is who calls it: this runs after
// the privacy gate has cleared the URL.
//
// SSRF: the Worker sets `global_fetch_strictly_public`, so fetch() refuses private and reserved
// addresses after DNS resolution. Redirect targets are chosen by the server rather than the agent,
// so they cannot carry the agent's data; they are followed and reported as `finalUrl`.

export type FetchedPage = {
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
  truncated: boolean;
};

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 30_000;
const USER_AGENT = "GadgetsWebFetch/1.0 (websafe)";

const TO_MARKDOWN = new Set([
  "text/html", "application/xhtml+xml", "application/pdf", "application/xml", "text/xml", "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.ms-excel.sheet.binary.macroenabled.12",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.apple.numbers",
]);

/** Throws on anything the gate should never be asked about: non-HTTPS or embedded credentials. */
export function parseFetchUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${input.slice(0, 200)}`);
  }
  if (url.protocol !== "https:") throw new Error("Only https:// URLs are allowed.");
  if (url.username || url.password) throw new Error("URLs with embedded credentials are not allowed.");
  return url;
}

export async function fetchPage(ai: Ai, url: URL, raw = false): Promise<FetchedPage> {
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/markdown,text/html;q=0.9,text/plain;q=0.9,application/json;q=0.9,application/xhtml+xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(`Fetch timed out after ${TIMEOUT_MS}ms`);
    }
    throw error;
  }

  let finalUrl = response.url ? new URL(response.url) : url;
  let contentType = response.headers.get("content-type") ?? "";
  if (contentSignalDenies(response, "ai-input")) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`The site at ${finalUrl} sets Content-Signal: ai-input=no, so its content may not be used as AI input.`);
  }

  let { bytes, truncated } = await readCapped(response, MAX_BYTES);
  let body = new TextDecoder().decode(bytes);
  let mime = contentType.split(";")[0].trim().toLowerCase();
  if (!raw && TO_MARKDOWN.has(mime)) {
    let name = finalUrl.pathname.split("/").filter(Boolean).pop() || "document";
    let result = await ai.toMarkdown(
      { name, blob: new Blob([bytes], { type: mime }) },
      { conversionOptions: { html: { hostname: finalUrl.origin, images: { convert: false, convertOGImage: false } } } },
    );
    if (result.format === "error") throw new Error(`Markdown conversion failed: ${result.error}`);
    body = result.data;
  }
  return { status: response.status, finalUrl: finalUrl.toString(), contentType, body, truncated };
}

function contentSignalDenies(response: Response, signal: string): boolean {
  let header = response.headers.get("content-signal");
  if (!header) return false;
  return header.split(",").some(part => {
    let [key, value] = part.split("=").map(s => s.trim().toLowerCase());
    return key === signal && value === "no";
  });
}

async function readCapped(response: Response, max: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(0), truncated: false };
  let reader = response.body.getReader();
  let chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      let { value, done } = await reader.read();
      if (done) break;
      if (total + value.byteLength > max) {
        chunks.push(value.subarray(0, max - total));
        total = max;
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  let out = new Uint8Array(total);
  let offset = 0;
  for (let c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return { bytes: out, truncated };
}
