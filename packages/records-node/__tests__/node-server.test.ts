// Node-only behaviour around the shared adapters: SSE pokes (in-process and across instances via
// Postgres LISTEN/NOTIFY), the rate limit, access configuration, and the bin script.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { createRecordsServer, fixedWindowLimiter, type RecordsServer } from "../src/index.js";
import { startContractStack, type ContractStack } from "./support/world.js";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
let stack: ContractStack;
let assertion: string;

beforeAll(async () => {
  stack = await startContractStack(inject("pgSuperuserUrl"), { pokes: { pubsub: "postgres", heartbeatMs: 200 } });
  assertion = await stack.access.sign();
});
afterAll(async () => stack?.close());

const ds = () => `/gatekeeper/records/v1/datastores/${stack.world.datastoreId}`;
const auth = (credential = stack.world.credential) => ({ "cf-access-jwt-assertion": assertion, authorization: `Bearer ${credential}` });

async function createIssue(baseUrl: string, title: string): Promise<Response> {
  return fetch(`${baseUrl}${ds()}/issues`, {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json", "idempotency-key": `node-${crypto.randomUUID()}` },
    body: JSON.stringify({ projectId: stack.world.projectId, title }),
  });
}

/** Open an SSE subscription and collect its events until `until` matches or the timeout passes. */
async function subscribe(baseUrl: string, credential?: string) {
  const abort = new AbortController();
  const res = await fetch(`${baseUrl}${ds()}/poke`, { headers: { ...auth(credential), accept: "text/event-stream" }, signal: abort.signal });
  const events: { event: string; data: string }[] = [];
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += value;
        let i: number;
        while ((i = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1] ?? (block.startsWith(":") ? "comment" : "message");
          events.push({ event, data: /^data: (.*)$/m.exec(block)?.[1] ?? "" });
        }
      }
    } catch {
      // aborted
    }
  })();
  return {
    res,
    events,
    async waitFor(pred: (e: { event: string; data: string }) => boolean, ms = 5_000) {
      const start = Date.now();
      while (Date.now() - start < ms) {
        const hit = events.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`no matching event; got ${JSON.stringify(events)}`);
    },
    async close() {
      abort.abort();
      await pump;
    },
  };
}

describe("SSE pokes", () => {
  it("streams a poke with the new head after a commit, and heartbeats", async () => {
    const sub = await subscribe(stack.baseUrl, stack.world.readOnlyCredential);
    expect(sub.res.status).toBe(200);
    expect(sub.res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    await sub.waitFor((e) => e.event === "ready");
    const created = await createIssue(stack.baseUrl, "Poked");
    expect(created.status).toBe(201);
    const changes = (await (await fetch(`${stack.baseUrl}${ds()}/changes?after=0&limit=1`, { headers: auth() })).json()) as { head: number };
    const poke = await sub.waitFor((e) => e.event === "poke");
    expect(JSON.parse(poke.data)).toEqual({ datastoreId: stack.world.datastoreId, head: expect.any(Number) });
    expect(JSON.parse(poke.data).head).toBeLessThanOrEqual(changes.head);
    await sub.waitFor((e) => e.event === "comment");
    await sub.close();
  });

  it("authorises the subscription like the WebSocket route", async () => {
    const anonymous = await fetch(`${stack.baseUrl}${ds()}/poke`, { headers: { accept: "text/event-stream", "cf-access-jwt-assertion": assertion } });
    expect(anonymous.status).toBe(401);
    const websocket = await fetch(`${stack.baseUrl}${ds()}/poke`, { headers: { ...auth(), upgrade: "websocket", connection: "upgrade" } }).catch(() => null);
    // node:http hands an Upgrade request to the "upgrade" event, which this server does not serve.
    expect(websocket === null || websocket.status >= 400).toBe(true);
    const plain = await fetch(`${stack.baseUrl}${ds()}/poke`, { headers: auth() });
    expect(plain.status).toBe(400);
  });

  it("shares pokes between instances through Postgres LISTEN/NOTIFY", async () => {
    const other: RecordsServer = await createRecordsServer({
      databaseUrl: stack.world.db.appUrl, access: { issuer: stack.access.issuer, audience: stack.access.audience }, pokes: { pubsub: "postgres" },
    });
    const otherUrl = await other.listen();
    try {
      const sub = await subscribe(otherUrl);
      await sub.waitFor((e) => e.event === "ready");
      expect(other.pokes.subscriberCount(stack.world.datastoreId)).toBe(1);
      expect((await createIssue(stack.baseUrl, "Poked across instances")).status).toBe(201);
      await sub.waitFor((e) => e.event === "poke");
      await sub.close();
      await new Promise((r) => setTimeout(r, 100));
      expect(other.pokes.subscriberCount(stack.world.datastoreId)).toBe(0);
    } finally {
      await other.close();
    }
  });

  it("ends a stream after its maximum lifetime", async () => {
    const short = await createRecordsServer({ databaseUrl: stack.world.db.appUrl, access: { issuer: stack.access.issuer, audience: stack.access.audience }, pokes: { lifetimeMs: 300 } });
    const url = await short.listen();
    try {
      const sub = await subscribe(url);
      await sub.waitFor((e) => e.event === "close", 3_000);
      await sub.close();
    } finally {
      await short.close();
    }
  });
});

describe("server configuration", () => {
  it("refuses to start without an explicit first-factor choice", async () => {
    await expect(createRecordsServer({ databaseUrl: stack.world.db.appUrl })).rejects.toThrow(/access/);
  });

  it("rate-limits per credential with Retry-After", async () => {
    const limited = await createRecordsServer({ databaseUrl: stack.world.db.appUrl, access: "none", rateLimit: { limit: 2, windowMs: 60_000 } });
    const url = await limited.listen();
    try {
      const statuses: number[] = [];
      let last: Response | undefined;
      for (let i = 0; i < 3; i++) {
        last = await fetch(`${url}${ds()}/projects`, { headers: { authorization: `Bearer ${stack.world.credential}` } });
        statuses.push(last.status);
      }
      expect(statuses).toEqual([200, 200, 429]);
      expect(last!.headers.get("retry-after")).toBe("10");
      expect(((await last!.json()) as { code: string }).code).toBe("rate_limited");
    } finally {
      await limited.close();
    }
  });

  it("the fixed window resets", () => {
    const limit = fixedWindowLimiter({ limit: 1, windowMs: 1 });
    expect(limit("a")).toBe(true);
    expect(limit("a")).toBe(false);
    expect(limit("b")).toBe(true);
  });

  it("adds the Worker's security headers and serves the OpenAPI document on the public origin", async () => {
    const withOrigin = await createRecordsServer({ databaseUrl: stack.world.db.appUrl, access: "none", publicBaseUrl: "https://records.example.com/ignored" });
    const url = await withOrigin.listen();
    try {
      const res = await fetch(`${url}/gatekeeper/records/v1/openapi.json`);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(((await res.json()) as { servers: { url: string }[] }).servers[0]!.url).toBe("https://records.example.com");
      expect((await fetch(`${url}/elsewhere`)).status).toBe(404);
    } finally {
      await withOrigin.close();
    }
  });
});

describe("bin/records-node.mjs", () => {
  it("starts from environment variables, serves, and stops on SIGTERM", async () => {
    const child = spawn(process.execPath, [join(packageDir, "bin/records-node.mjs")], {
      env: {
        PATH: process.env.PATH ?? "",
        RECORDS_DATABASE_URL: stack.world.db.appUrl,
        RECORDS_PORT: "0",
        RECORDS_ACCESS_ISSUER: stack.access.issuer,
        RECORDS_ACCESS_AUDIENCE: stack.access.audience,
      },
    });
    let output = "";
    child.stderr.on("data", (d) => (output += d));
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`bin did not start: ${output}`)), 20_000);
      child.stdout.on("data", (d) => {
        output += d;
        const m = /"event":"records\.node\.listening","url":"([^"]+)"/.exec(output);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]!);
        }
      });
      child.on("exit", (code) => reject(new Error(`bin exited ${code}: ${output}`)));
    });
    try {
      const res = await fetch(`${url}${ds()}/projects`, { headers: auth() });
      expect(res.status).toBe(200);
      expect((await fetch(`${url}${ds()}/projects`, { headers: { authorization: `Bearer ${stack.world.credential}` } })).status).toBe(401);
    } finally {
      const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
      child.kill("SIGTERM");
      expect(await exited).toBe(0);
    }
  });

  it("exits non-zero with a clear message when misconfigured", async () => {
    const child = spawn(process.execPath, [join(packageDir, "bin/records-node.mjs")], { env: { PATH: process.env.PATH ?? "" } });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(code).toBe(1);
    expect(output).toContain("RECORDS_DATABASE_URL is required");
  });
});
