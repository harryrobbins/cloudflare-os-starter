# Gadget HTTP API: review and recommendations

Written 2026-09-23 against starter `main` at `7d39f48`, the pinned `cloudflare-os`
submodule at `e50a9058`, and these proposals:

- [`gadget-http-api-options.md`](gadget-http-api-options.md)
- [`../plans/gadget-http-api.md`](../plans/gadget-http-api.md)

This is a design review, not an implementation status report. The feature remains unbuilt.

Scope clarification (2026-09-23): these recommendations concern gadget-specific automation.
For durable organisational records, follow the [Organisation datastores plan](../plans/organisation-datastores.md)
and [decision record](organisation-datastores-decisions.md), which use a domain service rather
than routing business-record operations through a gadget hook.

## Recommendation

Proceed with the **Gatekeeper plus hook** architecture. It fits the platform's capability and
consent model, avoids a kernel patch, gives the deployment an administrative kill switch, and
keeps public ingress on the Router. Keep direct Cap'n Web access as an operator tool rather than
the public product API.

Do not start the full implementation from the current plan unchanged. First resolve the six P0
items below. The most important changes are to give this path its own Access application, remove
request bodies from observations, make registration genuinely one-time or idempotent, and define
timeouts and retries without pretending that a timed-out mutation was cancelled.

## Priority summary

| Priority | Recommendation | Why |
| --- | --- | --- |
| P0 | Prove hook return values with a minimal spike. | Email and Scheduler prove delivery, but not a returned HTTP response. The entire design depends on this. |
| P0 | Define one-time/idempotent handler registration. | `ApprovalQueue.bindHook()` always creates a new disabled hook; it does not replace one. Re-running `serve()` would accumulate confusing duplicate Connections entries. |
| P0 | Use a path-specific Access application and audience. | A service token admitted by the root application is broader than this API. A more-specific `/gatekeeper/httpapi/e/*` application contains that authority. |
| P0 | Remove payloads and raw paths from observations. | They may contain secrets or personal data, and an observation per request creates unbounded noise and storage writes. |
| P0 | Specify idempotency, deadline and overload behavior. | Returning `504` does not prove the gadget stopped; blind retries can duplicate writes. Durable Object overloads must not be retried immediately. |
| P0 | Bound responses and tighten the HTTP grammar. | The plan caps request bodies but not responses, allows every `x-*` header, and accepts invalid/interim response statuses. |
| P1 | Add an endpoint lifecycle and first-class setup/test UI. | Today the happy path spans the configurator, agent, Connections, Access and a shell with little diagnosis when one step is missing. |
| P1 | Replace verb-derived scopes with explicit route/method grants. | A gadget can mutate on `GET`; `read = GET/HEAD` is transport convention, not a security boundary. |
| P1 | Coalesce usage writes and add bounded audit retention. | `last_used_at`, a persisted rate bucket and one observation per request turn a low-volume API into several writes per call. |
| P1 | Add deployment, schema migration and live-verification gates. | The new Worker and SQLite Durable Object are durable service identities and need the same provenance and rollback treatment as the rest of the starter. |
| P2 | Add OpenAPI export, a generated client and optional browser CORS. | These materially improve developer experience but are not required to validate the core transport. |

## What the proposals get right

Retain these decisions:

- The Gatekeeper owns HTTP ingress, endpoint credentials, policy and audit; the gadget owns business
  behavior.
- The Router remains the only public Worker. The HTTP API Worker has no route or preview URL of its
  own.
- Every delivery calls `initiator.startHook()` and uses the freshly restored callback. The
  Gatekeeper never persists a callback stub.
- Endpoint identifiers and token secrets carry at least 128 and 256 bits of randomness
  respectively. Token secrets are shown once and only a digest is stored.
- Token minting and revocation stay in owner-facing management UI. Secrets do not enter gadget code,
  agent context, tracked configuration or logs.
- The initial release is buffered UTF-8/JSON rather than an attempted streaming abstraction across
  multiple RPC boundaries.
- The endpoint Worker is disabled by default, deployed as a separate service, and wired to both the
  Router and Workshop only when enabled.
- Direct Overseer bindings and a gadget-level public `fetch()` route remain rejected. Both bypass
  the platform's existing consent and capability boundary.

## P0 design changes

### 1. Make the feasibility spike phase zero

Before building the configurator or token store, implement the smallest local experiment that:

1. Binds a persistent `RpcTarget` callback through the existing hook machinery.
2. Enables it through the same Overseer path production will use.
3. Returns a structured value from the callback through `startHook().callback` to the caller.
4. Throws before and after an `await`, returns an unserializable value, and exceeds a short
   caller-side deadline.
5. Repeats the call after a gadget code update to confirm restore behavior.
6. Disposes every returned stub and passes under local workerd.

This is a kill gate, not a phase-two detail. If values cannot traverse this path reliably, retain
the Gatekeeper but change the product to asynchronous jobs: accept a request, return `202` and a job
identifier, then expose polling. Do not patch the kernel merely to preserve synchronous REST.

### 2. Replace `serve()`'s unsupported replacement promise

The proposed contract says `serve(handler)` replaces the earlier handler. The current
`Overseer.bindHook()` implementation always allocates a new hook and action record. It returns no
hook identifier and has no update operation. Therefore repeated calls can create multiple disabled
hooks which all appear valid in Connections.

For v1, make registration explicitly one-time:

```ts
export interface HttpApiSession {
  /** Register this endpoint's persistent callback once. Safe to retry with the same registration key. */
  register(registration: HttpApiRegistration, handler: RpcStub<HttpApiHook>): Promise<RegisterResult>;
  getBaseUrl(): Promise<string>;
}

export type HttpApiRegistration = {
  /** Stable, gadget-chosen key such as "main-v1"; not a secret. */
  key: string;
  contractVersion: "1";
  routes: HttpApiRoute[];
};

export type RegisterResult =
  | { state: "created" | "already-registered"; baseUrl: string }
  | { state: "conflict"; message: string };
```

The Endpoint object should reserve the registration key before calling `bindHook`, roll it back if
binding fails, and offer an owner-only recovery action for an abandoned pending reservation. A code
edit does not normally require re-registration: the stored initiator restores a fresh callback from
the same restore parameters on every invocation.

Do not expose `listTokens()` to the gadget or agent session. It is management data, not a capability
the request handler needs. Keep it inside the configurator UI RPC surface.

The plan's ownership question can also be closed now: the Email configurator iframe does not need
to reveal `userAccountId`. `UserAccount.complete()` puts its own Durable Object ID in
`GatekeeperUserImpl` props, and `getGatekeeperClassFor()` performs the authoritative claim using
that prop. HTTP API should copy that server-side chain rather than trust an owner identifier from
configurator input.

### 3. Give HTTP API ingress its own Access boundary

Configure a distinct, more-specific Access application for:

```text
https://<public-host>/gatekeeper/httpapi/e/*
```

Cloudflare documents that a more-specific application path takes precedence over a root
application and does not inherit its rules. Give this application its own audience and configure a
Service Auth policy containing only the intended service tokens. The Worker must verify this
application's issuer and audience, then require service-token-shaped claims (`common_name` present;
no human identity is inferred). A service-token application JWT has an empty `sub` and carries the
client ID in `common_name`.

Consequences for the deployment design:

- Do not reuse the Workshop's `access.audience` for HTTP API requests.
- Add an explicit `httpApi.access.issuer` and `httpApi.access.audience` when the mode is
  `service-auth`.
- Replace `bypassAccess: boolean` with an explicit mode such as
  `accessMode: "service-auth" | "bearer-only"`.
- Validation must reject an enabled service-auth deployment without both values.
- `pnpm check` cannot prove the remote Access application exists or has the right path and policy;
  the production checklist must.
- Test that the service token cannot reach `/api`, `/admin`, the frontend, or another Gatekeeper.

`bearer-only` is a risk acceptance, not a convenience flag. It requires a separate path-specific
Access application with Bypass, and Cloudflare warns that Bypass disables Access enforcement and
Access logging. Require explicit production approval, a WAF/rate-limit control before the Endpoint
DO, and a negative test against every neighboring path.

The current plan also overstates webhook compatibility. Removing Access does not remove the bearer
token requirement. A sender that cannot set `Authorization` is still unsupported. Do not put a
long-lived token in a query string or capability URL; either document that limitation for v1 or add
a separately reviewed provider-signature mode later.

Relevant current Cloudflare documentation:

- [Access application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
- [Access policies and Bypass warning](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
- [Access application-token claims](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
- [Validating Access JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

### 4. Treat activity records as sensitive, durable data

Do not put the request body in an observation, even truncated. Also avoid raw query strings and raw
paths: APIs commonly place customer identifiers and, regrettably, credentials in them. Token labels
are user-controlled display text and must be escaped wherever rendered.

At the proposed default limit, one continuously busy endpoint can make 172,800 requests per day or
about 5.2 million per 30-day month. One Workshop observation per request would create the same
number of durable activity records before counting token and rate-limit writes. “Revisit if noisy”
is too late.

Use two audit layers instead:

- A bounded endpoint request ledger with retention and a fixed maximum row count. Record request ID,
  endpoint ID, opaque token ID, verified Access client ID when present, method, matched route name,
  result class, latency and byte counts. Never record authorization headers, bodies or query values.
- High-signal Workshop observations for state-changing route grants, registration/enable/disable,
  token lifecycle, repeated authorization failures and delivery failures. If product requirements
  demand a visible record of every successful write request, record writes individually but batch
  read-only traffic into interval summaries.

Make retention, visibility and deletion behavior explicit in the configurator. Structured Worker
logs remain operational telemetry, not the sole security ledger, because sampling and retention are
separate deployment choices.

### 5. Define retries and deadlines as API semantics

A `Promise.race()` can stop waiting, but it does not establish that a downstream gadget mutation
was cancelled. Therefore:

- Use a response deadline below the platform ceiling, configurable within a safe range; start with
  10 seconds rather than 30.
- Document `504` as “the gateway stopped waiting; outcome unknown” unless a cancellation mechanism
  is proven by the phase-zero spike.
- Accept `Idempotency-Key` on declared mutating routes. Store a bounded record keyed by endpoint,
  token and key, including an in-progress marker and the completed response digest/result.
- Reject reuse of a key with a different request fingerprint.
- Return the prior completed response for a safe retry and a distinct conflict/in-progress response
  when the original result is not known.
- Never automatically retry a mutating gadget call.
- Map a Durable Object error with `.overloaded === true` to `503` plus `Retry-After`; do not retry it
  internally. Cloudflare explicitly warns that retrying an overloaded object worsens overload.

Use a stable JSON problem format for gateway errors, for example:

```json
{
  "type": "https://docs.example/errors/hook-disabled",
  "title": "Endpoint is disabled",
  "status": 503,
  "code": "hook_disabled",
  "requestId": "01J..."
}
```

Do not expose stack traces, Worker exception text, resource IDs or existence details before
authentication succeeds.

See Cloudflare's current [Durable Object error-handling guidance](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/).

### 6. Tighten request and response contracts

The gateway contract should be intentionally smaller than HTTP:

- Allow only `GET`, `HEAD`, `POST`, `PUT`, `PATCH` and `DELETE` initially. Handle `OPTIONS` in the
  gateway if browser access is later enabled. Reject `CONNECT`, `TRACE` and protocol upgrades.
- Replace the wildcard `x-*` forwarding rule with named headers declared in the endpoint contract.
  Always strip `authorization`, cookies, Access headers, `cf-*`, forwarding headers and hop-by-hop
  headers.
- Add maximum URL, path, query-key, query-value, header-count and header-value sizes. Define how
  percent-encoded slashes, duplicate query keys and invalid UTF-8 are represented.
- Reject an oversized declared `Content-Length` early, but still count bytes while consuming the
  body because that header can be absent or untrusted.
- Add `maxResponseBytes`; serialize and count the response before returning it. Handle cyclic
  objects, `BigInt` and other non-JSON values as a controlled `502`.
- Limit statuses to those a final Worker `Response` can represent; v1 should accept `200`–`599`,
  not `100`–`599`. Apply correct `HEAD`, `204` and `304` body behavior.
- Use an explicit response-header allow-list. At minimum strip `set-cookie`, `content-length`,
  `transfer-encoding`, `connection`, `upgrade`, Access headers, `cf-*` and all CORS headers.
- Keep CORS off by default. If added, configure exact origins and allowed headers per endpoint;
  never silently reflect `Origin`.

Cloudflare currently documents a 16 KB URL limit, 128 KB aggregate header limits and 128 MB Worker
memory. The product limits should be substantially smaller and tested independently of platform
limits. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and
[Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/).

## User-experience improvements

### One guided endpoint lifecycle

Present one endpoint page with these states:

```text
created → handler registered → awaiting owner enablement → active
                                      ↓                    ↓
                                   disabled             unhealthy
```

The page should show:

- endpoint name, URL, target workspace/gadget and contract version;
- whether the handler is registered and the hook is enabled;
- Access mode and whether remote configuration has been verified;
- the last successful call and last error category, without payloads;
- route/method grants and limits;
- tokens with label, grant, expiry and coarse last-used time;
- rotate, revoke, disable and delete actions with their exact effects;
- a copyable test command and a “Send test request” action using a harmless declared route.

After showing a new token once, require the user to confirm that it was saved. Offer an immediately
usable command but never persist the secret in browser storage, page URLs, telemetry or shell
history. Rotation should support an overlap window: mint new, verify new, revoke old.

Use clear diagnostics rather than one generic `409`:

- `handler_not_registered`
- `hook_disabled`
- `token_expired`
- `token_scope_denied`
- `rate_limited`
- `gadget_timeout_outcome_unknown`
- `gadget_unavailable`

Return safe detail to the caller and richer, still sanitized guidance to the endpoint owner.

### Explain the collaboration trust boundary

The endpoint owner controls credentials, but collaborators who can edit the target gadget can
change what those credentials do. Before activation, say that tokens authorize the gadget's future
server code, not a frozen implementation. Show the current target and collaboration visibility,
and record target/contract changes as high-signal events.

The hook's `HookTargetMetadata` is display metadata only; upstream explicitly says it must not be
used for authorization or storage scoping. Authorization must continue to derive from the bound
capabilities and the endpoint's owner record.

## Developer-experience improvements

### Publish a contract, not just a handler

Register a small route manifest beside the callback. Each route should have a stable name, methods,
path template, request/response content types, grant and idempotency behavior. The manifest enables:

- validation before invoking gadget code;
- route names rather than sensitive raw paths in audit records;
- an OpenAPI 3.1 document downloadable from owner UI;
- accurate curl examples and a generated TypeScript client;
- compatibility checks when gadget code changes;
- safer token grants than the current global `read`/`write` pair.

Do not call method-derived permissions “read” and “write.” A handler can mutate on `GET`. Use
explicit grant names selected by the gadget author, with route/method pairs as the enforceable
boundary. A simple v1 can start with `invoke:read-routes` and `invoke:write-routes`, but the UI must
say these are declared route groups, not verified side-effect properties.

### Provide a safe local and CLI workflow

Ship one supported local command that starts the platform and Gatekeeper in the same workerd process;
do not leave this as tribal knowledge about `CHAT_IN_PLATFORM=1`. The e2e fixture should use that
command.

Provide a small CLI or curl-config generator that reads secrets from environment or stdin, performs
`/health`/contract checks, redacts headers on failure and explains the two authentication layers.
Avoid examples that paste literal credentials into shell history. The client should only retry
idempotent requests and should honor `Retry-After`.

## Security and privacy recommendations

### Token lifecycle

- Default tokens to an expiry, such as 90 days. “Never expires” should require an explicit warning.
- Cap active tokens per endpoint and token lifetime at deployment-configured maxima.
- Store a random token ID separately from its secret digest. Select by ID, then compare the digest
  with `crypto.subtle.timingSafeEqual`.
- Bind every token to exactly one endpoint and a set of declared route grants.
- Revoke immediately and make revocation idempotent.
- Disconnecting/revoking the Gatekeeper account must disable all of its endpoints immediately.
  Reconnection must not silently reactivate old tokens or hooks.
- Coarsen `lastUsedAt` updates, for example to at most once per token per hour.
- Never accept tokens in query parameters and never return a secret after creation.
- Pass the gadget only opaque caller identifiers and grants. A token label and Access
  `common_name` are service metadata, never a signed-in person.

SHA-256 is adequate for a uniformly random 256-bit secret; a password KDF is unnecessary. A
deployment-keyed HMAC can add database-compromise separation, but it also creates a new secret and
rotation problem. Prefer the simpler digest unless the threat model specifically requires HMAC.

### Abuse resistance

Apply limits in this order:

1. Access or an approved edge control.
2. Method, URL, header and declared-size checks in the Worker.
3. A cheap per-source/per-endpoint invalid-auth limiter before expensive RPC.
4. Constant-time token verification in the Endpoint DO.
5. Per-token and aggregate endpoint rate limits.
6. An explicit in-flight delivery limit with fast `503` rejection.
7. Request and response deadlines and byte caps.

Do not rely on the Endpoint DO to “serialize requests.” Durable Objects are single-threaded, but
requests can interleave across `await` of non-storage I/O. Use atomic SQLite operations for counters
and explicit in-flight state. Do not hold `blockConcurrencyWhile()` across the hook call; Cloudflare
documents that as an anti-pattern which reduces throughput.

See [Durable Object concurrency guidance](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/).

## Performance and cost recommendations

The intended workload remains a control/data API, not a high-QPS public service. State that in the
product and reject configurations that imply otherwise.

Use the Endpoint DO for the coordination it genuinely needs—ownership, token revocation,
idempotency and precise endpoint limits—but avoid a durable write for every ordinary read:

- keep the hot token bucket in memory with a conservative persisted checkpoint or use short,
  atomic fixed windows in SQLite;
- coalesce last-used timestamps;
- batch/retain audit records rather than growing them forever;
- keep indexes on token ID, expiry and idempotency-key expiry;
- purge expired tokens, idempotency records and request-ledger rows with bounded incremental work;
- report request, CPU, DO duration, row-read and row-write estimates in the operator docs.

An Endpoint DO that awaits the gadget remains active for the duration of the call, so slow gadget
methods affect both capacity and Durable Object duration cost. Measure p50/p95/p99 latency and
duration in the e2e and a small load test. Test a slow endpoint, burst traffic, multiple tokens and
cold starts. Do not infer capacity from the platform's simple-DO headline; this path performs
cross-Worker RPC and gadget work.

Cloudflare's Standard Workers pricing counts the initial Worker request and aggregates CPU across
service bindings rather than charging each binding as another request. Durable Objects separately
bill compute duration and storage operations. Confirm the deployment's actual plan before publishing
an estimate:

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)

## Maintainability and operations

### Keep policy in a pure core

Separate the package into:

- pure request parsing, contract matching, auth-shape validation and response shaping;
- token and idempotency storage;
- hook registration/delivery;
- Access JWT verification;
- Worker routing and RPC adapters;
- configurator UI.

The pure core should take ordinary values and return tagged results. This makes malformed-input and
policy tests fast and avoids requiring workerd for every branch. Keep workerd tests for RPC,
`ctx.exports`, Durable Object storage and disposal behavior.

### Treat the Worker name and DO class as durable identities

Add an explicit SQLite Durable Object migration in the package's base `wrangler.jsonc`. Document
that renaming the Worker strands endpoint/token state unless it is intentionally migrated. The
starter must validate unique names, add the package to base/generated config types, build commands,
deployment order and cleanup, and test both enabled and disabled configurations.

Deploy the HTTP API Worker before the Workshop and Router that bind it. Because deployment is not
atomic, document mixed-version compatibility and the first-deploy sequence. A failure after the API
Worker deploy but before the Router should leave it private and harmless; a failure after Workshop
but before Router must preserve old public behavior.

### Observability

Emit structured, payload-free events for:

- authorization result class;
- rate/size/concurrency rejection;
- hook state and restore failures;
- callback latency and result class;
- response-shaping failure;
- token creation/revocation/expiry counts, without secrets;
- retention cleanup failures.

Use request IDs generated by the gateway and returned in `x-request-id`. If a caller supplies its
own correlation ID, validate and store it separately; do not let it replace the trusted request ID.
Metrics and alerts should cover error ratio, p95/p99 latency, overloads, repeated invalid tokens,
ledger cleanup lag and unexpected cost growth.

## Repository evidence for the main findings

| Finding | Current source |
| --- | --- |
| Router ingress is derived from `GATEKEEPER_*` bindings, so the feature needs no Router code patch. | `cloudflare-os/packages/router/src/index.ts:25-37` |
| `bindHook()` allocates a fresh hook and action every time; it has no replacement path or returned hook ID. | `cloudflare-os/packages/workshop-backend/src/overseer.ts:3121-3175` |
| A controller must accept target metadata, but that metadata is explicitly forbidden as an authorization or storage-scoping input. | `cloudflare-os/packages/workshop-shared/src/gatekeeper.ts:1234-1284` |
| A Gatekeeper must store the initiator, call `startHook()` for each delivery and not store the callback. | `cloudflare-os/packages/workshop-shared/src/gatekeeper.ts:1286-1300` |
| Email proves the persistent-stub delivery and disposal pattern, but its callback returns `void`. | `cloudflare-os/packages/gatekeeper-email/src/email.ts:482-700` |
| Email derives resource ownership from the server-side `UserAccount`/`GatekeeperUserImpl` capability chain, not a configurator-supplied account ID. | `cloudflare-os/packages/gatekeeper-email/src/email.ts:300-455` |
| The existing chat verifier validates Access issuer and audience and caches the remote JWKS; HTTP API can reuse the mechanism but needs its own audience and service-token claim rules. | `packages/gatekeeper-chat/src/access.ts` |
| The starter disables preview URLs on every Worker and gives the public route only to the Router. | `scripts/deploy.ts`, `setCommon()` and `generateConfigs()` |
| The deploy is ordered and non-atomic, with the Router last because it binds the backend Workers. | `scripts/deploy.ts`, `deployOrder()` |

## Revised implementation sequence

1. **Feasibility spike:** callback return values, disposal, error shapes, deadline behavior and code
   update restoration. Decide synchronous `200` versus asynchronous `202` from evidence.
2. **Contract review:** finalize registration idempotency, route manifest, error format, grants,
   timeout semantics, Access boundary, retention and token lifecycle.
3. **Pure HTTP core:** parsers, byte bounds, route matching, response shaping and exhaustive unit
   tests/fuzz cases.
4. **Endpoint storage:** schema/migration, ownership, tokens, expiry, idempotency, bounded ledger,
   cleanup and rate/concurrency controls.
5. **Hook integration:** one-time registration, owner checks, enable/disable and request delivery.
6. **Configurator:** guided lifecycle, secret show-once/rotation, status, contract and safe test.
7. **Starter wiring:** disabled by default, distinct Access values, package/build/deploy order and
   config-generation tests.
8. **Local e2e:** happy path plus duplicate registration, disabled hook, expired/revoked token,
   oversize request/response, timeout with unknown outcome, overload and code update.
9. **Load/cost test:** bursts, slow handler, concurrent tokens, cold starts, retention and write
   counts. Set defaults from measurements.
10. **Controlled production evaluation:** operators only, read-only showcase routes first, Access
    positive/negative tests, route-bypass inventory, observability and rollback record.

## Release acceptance criteria

The feature is ready for a limited release only when all of these are true:

- Hook response return and disposal are proven in local e2e.
- Re-running setup creates no duplicate hook or endpoint.
- The path-specific Access app admits the intended service token and denies it everywhere else.
- Bearer-only mode, if shipped, has an approved edge abuse control and cannot affect neighboring
  routes.
- No secret, body, query value or raw authorization failure is present in observations or logs.
- Request and response caps are enforced without buffering beyond the configured bound.
- A timed-out mutation has documented unknown-outcome and idempotency behavior.
- Overload returns promptly and is not internally retried.
- Token rotation/revocation and hook disable take effect on the next request.
- Endpoint, token, ledger and idempotency retention/deletion are tested.
- Sustained-limit cost and storage-write estimates are documented from measurements.
- A prior gadget still loads and existing platform routes retain their Access behavior.
- The HTTP API Worker has no route or preview URL other than Router forwarding.
- The deployment has recorded Worker versions, DO migration, rollback limits and live positive and
  negative verification.

## Final product position

The strongest v1 is deliberately narrow: an owner-created, low-throughput, non-streaming JSON API
for automation, protected by a dedicated Access service-auth application plus a revocable endpoint
token. It has explicit route grants, bounded payloads, idempotent writes, a short response deadline,
and a guided lifecycle UI.

That product is more useful than a raw “publish every `server.js` method” switch and much safer than
a generic public webhook proxy. Streaming, anonymous webhooks, browser CORS and high-throughput
serving should remain separate follow-on designs with their own trust and cost reviews.
