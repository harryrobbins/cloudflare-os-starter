// Helpers to drive handleJira directly, and to serve it over a real local HTTP server for
// third-party clients.

import http from "node:http";
import type { AddressInfo } from "node:net";

import { handleJira, type JiraPort, type JiraRouterOptions } from "../../src/index.js";

export const BASE = "/gatekeeper/records/v1/datastores/0f0f0f0f-0000-4000-8000-000000000000/jira";
export const ORIGIN = "https://records.example.test";

export type Call = { status: number; body: any; headers: Headers };

export function caller(port: JiraPort, options: JiraRouterOptions = {}) {
  return async (method: string, path: string, body?: unknown, init: { version?: 2 | 3; headers?: Record<string, string> } = {}): Promise<Call> => {
    const url = `${ORIGIN}${BASE}/rest/api/${init.version ?? 3}${path}`;
    const req = new Request(url, {
      method,
      headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    const res = await handleJira(req, BASE, port, options);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
}

/** Serve handleJira on 127.0.0.1 at a random port. Returns the base URL clients should use. */
export async function serve(port: JiraPort, options: JiraRouterOptions = {}, log?: string[]): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      const address = server.address() as AddressInfo;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const request = new Request(`http://127.0.0.1:${address.port}${req.url}`, {
        method: req.method!,
        headers,
        ...(body.length && req.method !== "GET" && req.method !== "HEAD" ? { body } : {}),
      });
      const response = await handleJira(request, BASE, port, options);
      log?.push(`${req.method} ${req.url} -> ${response.status}${body.length ? ` ${body.toString("utf8").slice(0, 400)}` : ""}`);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port: p } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${p}${BASE}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
