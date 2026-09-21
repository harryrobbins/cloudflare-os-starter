// Spike 3 (chat.md phase 0, item 3): the `assets` binding serves a Vite build whose `base` is
// `/gatekeeper/chat/` when the Worker is reached through another Worker's service binding.
//
// The build under test is the real one: `pnpm --filter gatekeeper-chat build` writes app/dist, and
// both the runner Worker and the `spike-chat` auxiliary Worker point their assets directory at it.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

const ORIGIN = "https://chat.example.test";
const BASE = "/gatekeeper/chat/";

let hashedModule = "";

/** Turns a browser-facing asset URL into the path the asset directory holds. */
function unprefixed(path: string): string {
  return path.slice("/gatekeeper/chat".length);
}

beforeAll(async () => {
  // The hash is discovered from the served shell rather than hard-coded, and the assertion that it
  // starts with the prefix is what proves Vite's `base` reached the output: a default `base` would
  // emit "/assets/index-<hash>.js", which the router never forwards.
  //
  // Fetched from the binding with the prefix already stripped, because that is what the asset server
  // understands -- the finding this spike exists to pin down. (workerd has no real filesystem, so
  // reading app/dist directly is not an option here.)
  const response = await env.ASSETS.fetch(`${ORIGIN}/`);
  expect(response.status).toBe(200);
  const match = /<script type="module"[^>]*src="([^"]+\.js)"/.exec(await response.text());
  expect(match, "the built index.html references a module").not.toBeNull();
  hashedModule = match![1]!;
  expect(hashedModule.startsWith(`${BASE}assets/`)).toBe(true);
});

describe("spike: assets under a base prefix, through a service binding", () => {
  it("serves the app shell", async () => {
    const response = await env.ROUTER.fetch(`${ORIGIN}${BASE}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain('<div id="root">');
    expect(body).toContain(hashedModule);
  });

  it("serves the hashed module with a JavaScript content type", async () => {
    const response = await env.ROUTER.fetch(`${ORIGIN}${hashedModule}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/javascript/);
    // Module bytes, not the shell: the SPA fallback must not have answered instead. Asserting on a
    // string from the app itself would tie this spike to whatever stream B has built today.
    const body = await response.text();
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toContain("<!doctype html");
  });

  it("404s an asset that does not exist rather than serving the shell", async () => {
    // The asset server is not the SPA fallback; `src/serve.ts` owns that decision, so an unknown
    // asset path must come back 404 from here.
    const response = await env.ROUTER.fetch(`${ORIGIN}${BASE}assets/does-not-exist.js`);
    expect(response.status).toBe(404);
  });

  it("is reached through the ASSETS binding in the runner Worker too", async () => {
    // Same directory, no service-binding hop: isolates "the build is fine" from "the hop is fine".
    const response = await env.ASSETS.fetch(`${ORIGIN}${unprefixed(hashedModule)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/javascript/);
  });

  it("404s the prefixed path on the binding itself: the prefix must be stripped by the Worker", async () => {
    // The finding. If a future wrangler release starts stripping `base` for us, this test fails and
    // the rewrite in src/serve.ts can go.
    const response = await env.ASSETS.fetch(`${ORIGIN}${hashedModule}`);
    expect(response.status).toBe(404);
  });
});
