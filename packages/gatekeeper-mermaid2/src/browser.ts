import { launch } from "@cloudflare/puppeteer";
import { Buffer } from "node:buffer";
import type { DiagramRequest, DiagramResult } from "./types.js";

/** Internal browser result, never a caller-controlled response. */
interface BrowserRenderResult {
  base64: string;
  extension: string;
  contentType: string;
  nodes: number;
  edges: number;
  d2Source?: string;
}
declare global {
  var renderMermaiD2: (request: Required<DiagramRequest>) => Promise<BrowserRenderResult>;
}
import { ORIGIN, CSP, assetPath } from "./browser-policy.js";

/** Run an ephemeral, network-isolated browser and always release its capacity. */
export async function renderInBrowser(env: Cloudflare.Env, request: Required<DiagramRequest>): Promise<DiagramResult> {
  const browser = await launch(env.BROWSER);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on("request", intercepted => {
          void (async () => {
            const path = assetPath(intercepted.url());
            if (path === null) { await intercepted.abort("blockedbyclient"); return; }
            const response = await env.RENDERER_ASSETS.fetch(new Request(`${ORIGIN}${path}`));
            await intercepted.respond({ status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/octet-stream", "content-security-policy": CSP }, body: Buffer.from(await response.arrayBuffer()) });
          })().catch(() => { void intercepted.abort().catch(() => {}); });
        });
        await page.goto(`${ORIGIN}/`, { waitUntil: "load", timeout: 45_000 });
        await page.waitForFunction(() => typeof globalThis.renderMermaiD2 === "function", { timeout: 15_000 });
        const output = await page.evaluate(async input => globalThis.renderMermaiD2(input), request);
        const data = Uint8Array.from(Buffer.from(output.base64, "base64"));
        if (data.length > 16 * 1024 * 1024) throw new Error("render_limit: generated file exceeds 16 MiB.");
        return { data, contentType: output.contentType, filename: `mermaid2-diagram.${output.extension}`, format: request.format, language: request.language, layout: request.layout, nodes: output.nodes, edges: output.edges, ...(output.d2Source !== undefined && { d2Source: output.d2Source }) };
      })(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("render_timeout: rendering exceeded 90 seconds.")), 90_000); }),
    ]);
  } finally {
    clearTimeout(timer);
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([browser.close(), new Promise<never>((_resolve, reject) => {
        closeTimer = setTimeout(() => reject(new Error("Browser close timed out.")), 10_000);
      })]);
    } catch {
      console.warn(JSON.stringify({ component: "gatekeeper.mermaid2", event: "browser.close.failed" }));
    } finally { clearTimeout(closeTimer); }
  }
}
