export const ORIGIN = "https://mermaid2-renderer.invalid";
export const CSP = "default-src 'none'; script-src 'self' blob: 'wasm-unsafe-eval'; worker-src blob:; connect-src data: blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";

/** Only trusted, packaged JS can be loaded. Source cannot cause arbitrary browser requests. */
export function assetPath(url: string): string | null {
  const parsed = new URL(url);
  if (parsed.origin !== ORIGIN || parsed.search || parsed.hash) return null;
  return /^\/(?:|index\.html|main\.js|assets\/[\w.-]+\.js)$/.test(parsed.pathname) ? parsed.pathname : null;
}
