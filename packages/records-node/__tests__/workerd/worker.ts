// The Worker under contract test: the production adapters composed as gatekeeper-records'
// src/index.ts composes them for `/gatekeeper/records/v1/*` (Access verification, the Jira surface
// first, then the native API, security headers, one Hyperdrive client per request). The Durable
// Object poke hub, outbox publishing and the rate limiter binding are left out: they are
// Worker-specific plumbing around the adapters, covered by gatekeeper-records' own workerd suite.

import { connect, RecordsService } from "@records/core";
import { verifyAccessAssertion } from "gatekeeper-records/http/access";
import { API_PREFIX, handleApi } from "gatekeeper-records/http/api";
import { OPENAPI_PATH, openApiDocument } from "gatekeeper-records/http/openapi";
import { handleJiraApi, JIRA_PATH } from "gatekeeper-records/jira/handler";

export type ContractEnv = {
  HYPERDRIVE: { connectionString: string };
  CF_ACCESS_ISS: string;
  RECORDS_API_ACCESS_AUD: string;
  CONTRACT_TARGET: string;
};

const SECURITY_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "same-origin" };

type Ctx = { waitUntil(promise: Promise<unknown>): void };

async function route(request: Request, env: ContractEnv, ctx: Ctx): Promise<Response> {
  const url = new URL(request.url);
  // Served here until api.ts mounts the route itself (the Node server does the same).
  if (url.pathname === OPENAPI_PATH && request.method === "GET") {
    return new Response(JSON.stringify(openApiDocument(url.origin)), { headers: { "content-type": "application/json; charset=utf-8" } });
  }
  if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) return new Response("Not found", { status: 404 });
  const service = new RecordsService(connect(env.HYPERDRIVE.connectionString, { max: 3 }));
  const verifyAccess = async (r: Request) => (await verifyAccessAssertion(r, { issuer: env.CF_ACCESS_ISS, audience: env.RECORDS_API_ACCESS_AUD })) !== null;
  try {
    return JIRA_PATH.test(url.pathname) ? await handleJiraApi(request, { service, verifyAccess }) : await handleApi(request, { service, verifyAccess });
  } finally {
    // As index.ts: end the per-request client after the response. (Awaiting end() here instead
    // hangs under the test pool; see onUnhandledError in vitest.workerd.config.ts.)
    ctx.waitUntil(service.db.end({ timeout: 5 }).catch(() => {}));
  }
}

export default {
  async fetch(request: Request, env: ContractEnv, ctx: Ctx): Promise<Response> {
    const response = await route(request, env, ctx);
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    return new Response(response.body, { status: response.status, headers });
  },
};
