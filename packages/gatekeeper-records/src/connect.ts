// The Access-verified connect flow.
//
//   1. The Workshop calls GatekeeperVendor.connectAccount(callback). We create a short-lived
//      RecordsConnectFlow Durable Object holding the callback and a SHA-256 of a random nonce, and
//      return  <base>/gatekeeper/records/connect?flow=<id>&nonce=<nonce>.
//   2. The Workshop opens that URL in a new tab on the same origin. Cloudflare Access has already
//      authenticated the person; we verify the assertion ourselves (issuer + Workshop audience).
//   3. The page names the directory entry that will be connected and asks for confirmation. The
//      confirming POST must come from our own origin (Origin + Sec-Fetch-Site) and present the
//      nonce, which is single-use and expires after 10 minutes.
//   4. On confirmation we mint a RecordsAccount bound to that principal and complete the callback.
//
// Why the same-origin requirement: a flow URL started by one person and opened by another would
// otherwise connect the second person's identity to the first person's Workshop account. The
// Workshop opens the tab itself (Sec-Fetch-Site: same-origin); a link pasted from e-mail or chat
// arrives as cross-site or "none" and is refused.

import { DurableObject } from "cloudflare:workers";
import type { GatekeeperConnectCallback, GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";

import { checkConnectRequest, CONNECT_PAGE_HEADERS } from "./connect-guard.js";
import { userEmail, verifyAccessAssertion } from "./http/access.js";
import { normaliseEmail, WORKSHOP_ISSUER } from "./domain/registry.js";
import type { RecordsService } from "./domain/service.js";
import { closeQuietly, recordsService } from "./runtime.js";

const FLOW_TTL_MS = 10 * 60_000;
export const CONNECT_PATH = "/gatekeeper/records/connect";

type StoredFlow = { callback: Fetcher<GatekeeperConnectCallback>; nonceHash: string; expires: number };

async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Exports = Cloudflare.Exports;

export async function startConnectFlow(env: Cloudflare.Env, exports: Exports, callback: Fetcher<GatekeeperConnectCallback>): Promise<{ url: string }> {
  const flowId = randomToken();
  const nonce = randomToken();
  await exports.RecordsConnectFlow.getByName(flowId).start(callback, await sha256Hex(nonce));
  const url = new URL(CONNECT_PATH, env.PUBLIC_BASE_URL);
  url.searchParams.set("flow", flowId);
  url.searchParams.set("nonce", nonce);
  return { url: url.toString() };
}

export class RecordsConnectFlow extends DurableObject<Cloudflare.Env> {
  async start(callback: Fetcher<GatekeeperConnectCallback>, nonceHash: string): Promise<void> {
    if (this.ctx.storage.kv.get("flow")) throw new Error("Flow already started.");
    this.ctx.storage.kv.put<StoredFlow>("flow", { callback, nonceHash, expires: Date.now() + FLOW_TTL_MS });
    await this.ctx.storage.setAlarm(Date.now() + FLOW_TTL_MS);
  }

  /** Validates the nonce without consuming it (the confirmation page). */
  async check(nonce: string): Promise<boolean> {
    const flow = this.ctx.storage.kv.get<StoredFlow>("flow");
    return !!flow && flow.expires > Date.now() && flow.nonceHash === (await sha256Hex(nonce));
  }

  /** Consumes the nonce and completes the Workshop's callback with the minted account. */
  async complete(nonce: string, account: { orgId: string; principalId: string; displayName: string; email: string }): Promise<void> {
    const flow = this.ctx.storage.kv.get<StoredFlow>("flow");
    if (!flow || flow.expires <= Date.now() || flow.nonceHash !== (await sha256Hex(nonce))) throw new Error("This connection link has expired.");
    this.ctx.storage.kv.delete("flow");
    const user = this.ctx.exports.RecordsAccount({ props: { accountId: crypto.randomUUID(), ...account } });
    try {
      await flow.callback.complete(user as unknown as Fetcher<GatekeeperUser>);
    } finally {
      await this.ctx.storage.deleteAll();
    }
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${escapeHtml(title)}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;color:#172033}` +
      `button{font:inherit;padding:.6rem 1.2rem;border-radius:.4rem;border:1px solid #1d4ed8;background:#1d4ed8;color:#fff;cursor:pointer}` +
      `.muted{color:#526079}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
    { status, headers: { ...CONNECT_PAGE_HEADERS } },
  );
}

export async function handleConnect(request: Request, env: Cloudflare.Env, exports: Exports): Promise<Response> {
  const url = new URL(request.url);
  const flowId = url.searchParams.get("flow") ?? "";
  const nonce = url.searchParams.get("nonce") ?? "";
  if (!/^[0-9a-f]{64}$/.test(flowId) || !/^[0-9a-f]{64}$/.test(nonce)) {
    return page("Link not valid", "<p>This connection link is incomplete. Start again from Connections in the Workshop.</p>", 400);
  }

  const guard = checkConnectRequest(request);
  if (!guard.ok) {
    if (guard.reason === "method") return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
    if (guard.reason === "origin") return page("Not allowed", "<p>Confirmation must come from this site.</p>", 403);
    return page("Start from the Workshop", "<p>For your safety, connect Organisation records from <strong>Connections</strong> in the Workshop, not from a link someone sent you.</p>", 403);
  }

  const claims = await verifyAccessAssertion(request, { issuer: env.CF_ACCESS_ISS, audience: env.CF_ACCESS_AUD });
  const email = userEmail(claims);
  if (!email) return page("Sign in first", "<p>Sign in to the Workshop, then connect again.</p>", 401);

  const flow = exports.RecordsConnectFlow.getByName(flowId);
  if (!(await flow.check(nonce))) {
    return page("Link expired", "<p>This connection link has expired or was already used. Start again from Connections in the Workshop.</p>", 410);
  }

  const service = recordsService(env);
  try {
    return await confirmConnect(request, service, flow, flowId, nonce, email);
  } finally {
    await closeQuietly(service.db);
  }
}

async function confirmConnect(
  request: Request, service: RecordsService, flow: DurableObjectStub<RecordsConnectFlow>, flowId: string, nonce: string, email: string,
): Promise<Response> {
  const identity = await service.registry.resolveIdentity(WORKSHOP_ISSUER, normaliseEmail(email));
  if (!identity) {
    return page("Not in the directory",
      `<p>${escapeHtml(email)} is not in your organisation's Records directory yet.</p>` +
      `<p class="muted">Ask a data administrator to add you, then connect again. Connecting never creates access by itself.</p>`, 403);
  }
  const me = await service.registry.whoami({ orgId: identity.orgId, principalId: identity.principalId, via: "management" });

  if (request.method === "GET") {
    const action = `${CONNECT_PATH}?flow=${flowId}&nonce=${nonce}`;
    return page("Connect Organisation records",
      `<p>Connect the Workshop to Organisation records as <strong>${escapeHtml(me.principal.displayName)}</strong> (${escapeHtml(email)}).</p>` +
      `<p class="muted">Gadgets you connect will act within your own permissions on each datastore. You can remove the connection at any time; your organisation's records stay.</p>` +
      `<form method="post" action="${escapeHtml(action)}"><button type="submit">Connect</button></form>`);
  }

  try {
    await flow.complete(nonce, { orgId: identity.orgId, principalId: identity.principalId, displayName: me.principal.displayName, email: normaliseEmail(email) });
  } catch {
    return page("Link expired", "<p>This connection link has expired or was already used. Start again from Connections in the Workshop.</p>", 410);
  }
  return page("Connected", "<p>Organisation records is connected. You can close this tab.</p><script>setTimeout(() => window.close(), 800)</script>");
}
