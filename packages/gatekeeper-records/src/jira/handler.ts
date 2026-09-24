// The Jira-compatible surface of a Projects datastore (canonical plan §7):
//
//   /gatekeeper/records/v1/datastores/:datastoreId/jira/rest/api/{2,3,latest}/…
//
// A Jira client points its base URL at `…/datastores/:datastoreId/jira`. Two independent checks on
// every request, as on the native API:
//   1. the Cloudflare Access assertion for the API audience (`deps.verifyAccess`);
//   2. a Records credential, as either
//        Authorization: Bearer rk1_…
//        Authorization: Basic base64(<email>:rk1_…)      (Jira clients' "email + API token")
// The datastore ID in the path is a selector and must equal the credential's datastore.
//
// Basic authentication decision: the e-mail is not decoration. It must equal (trimmed,
// case-insensitive) the e-mail of the credential's owner, the person who minted it and whose
// continued credentials.manage right keeps it alive. An owner without an e-mail cannot use Basic
// (use Bearer). A mismatch is the same 401 as a bad token, so the answer does not reveal whose
// token it is. This keeps a leaked token from being presented under an arbitrary name, and makes
// the configured "user" in a Jira client match a real, accountable person. The rule, and the
// credential parsing (@records/identity parseAuthorization), are the ServiceAuthenticator's
// (src/identity/authenticator.ts); JWTs are not accepted on this surface.
//
// Everything after authentication is handleJira (@records/jira) over a port bound to the
// credential's service principal (createJiraPort). Every failure is a Jira-shaped error body.

import { LIMITS, RecordsError } from "@records/contracts";
import type { RecordsService } from "@records/core";
import { handleJira, JIRA_MESSAGES, JiraError, jiraErrorFromRecords, type JiraRouterOptions } from "@records/jira";

import { ServiceAuthenticator } from "../identity/authenticator.js";
import { createJiraPort } from "./port.js";

// The native API's prefix (http/api.ts API_PREFIX), repeated so api.ts can import this module
// without an import cycle.
const API_PREFIX = "/gatekeeper/records/v1";

/** Matches every Jira-surface path; group 1 is the datastore ID. Mount before the native API. */
export const JIRA_PATH = /^\/gatekeeper\/records\/v1\/datastores\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/jira(?:\/.*)?$/;

export type JiraApiDeps = {
  service: RecordsService;
  /** Verify the Access assertion for the API audience. Returns false when absent or invalid. */
  verifyAccess(request: Request): Promise<boolean>;
  /** Resolves credentials. Default: one over `service`. */
  authenticator?: ServiceAuthenticator;
  /** Optional per-credential rate limit. Returns false when the caller should back off. */
  rateLimit?(key: string): Promise<boolean>;
  /** Deadline for one request, in milliseconds. Default 15 s. */
  deadlineMs?: number;
  /** Router options (clock, server title, derived-key window). */
  router?: JiraRouterOptions;
};

const JSON_HEADERS = { "content-type": "application/json;charset=UTF-8", "cache-control": "no-store" };

function jiraError(err: JiraError): Response {
  return new Response(JSON.stringify(err.body), { status: err.status, headers: { ...JSON_HEADERS, ...err.headers } });
}

const unauthenticated = () =>
  jiraError(new JiraError(401, [JIRA_MESSAGES.unauthenticated], {}, { "www-authenticate": 'Basic realm="records", Bearer realm="records"' }));

async function route(request: Request, deps: JiraApiDeps): Promise<Response> {
  const url = new URL(request.url);
  const match = JIRA_PATH.exec(url.pathname);
  if (!match) return jiraError(new JiraError(404, [JIRA_MESSAGES.notFound]));
  const datastoreId = match[1]!;

  const authenticator = deps.authenticator ?? new ServiceAuthenticator({ service: deps.service });
  const resolved = await authenticator.authenticate(request.headers, {
    datastoreId,
    verifyAccess: () => deps.verifyAccess(request),
    allowBasic: true,
  });
  if (!resolved.ok) {
    if (resolved.stage === "datastore") return jiraError(new JiraError(404, [JIRA_MESSAGES.notFound]));
    return unauthenticated();
  }
  if (deps.rateLimit && !(await deps.rateLimit(resolved.rateKey))) {
    return jiraError(new JiraError(429, ["Rate limit exceeded."], {}, { "retry-after": "10" }));
  }

  const port = createJiraPort(deps.service, resolved.caller, datastoreId);
  return handleJira(request, `${API_PREFIX}/datastores/${datastoreId}/jira`, port, deps.router ?? {});
}

/** Serve one request on the Jira surface. Never throws; every failure is a Jira error body. */
export async function handleJiraApi(request: Request, deps: JiraApiDeps): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > LIMITS.httpBodyMaxBytes) return jiraError(new JiraError(413, ["The request body is too large."]));
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RecordsError("unavailable", "The request exceeded its deadline.")), deps.deadlineMs ?? 15_000);
    });
    return await Promise.race([route(request, deps), deadline]);
  } catch (err) {
    const mapped = jiraErrorFromRecords(err);
    if (mapped.status >= 500 && RecordsError.codeOf(err) !== "unavailable") {
      console.error(JSON.stringify({ event: "records.jira.unhandled", error: err instanceof Error ? err.message : String(err) }));
    }
    return jiraError(mapped);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
