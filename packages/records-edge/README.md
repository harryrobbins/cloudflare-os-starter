# Records HTTP edge

Separately deployable Cloudflare Worker in front of the Node Records gateway. Postgres,
PostgREST, credential checking, journal reconciliation and SSE authorization remain at the
gateway. This package does not deploy or register the Cloudflare OS gatekeeper.

The checked-in configuration has no routes, no workers.dev address, no preview URLs and an
empty origin. It cannot forward requests until an operator supplies an origin. No remote
deployment has been performed.

## Configuration

- Set `RECORDS_ORIGIN` to the gateway's exact HTTPS origin, such as `https://records-origin.example.com`.
  Paths, query strings, fragments, credentials and HTTP origins are rejected. Use a separate
  hostname from the edge to prevent loops. The Node gateway must not be reachable through an
  unprotected alternate hostname if Access is intended to protect it.
- Leave `ORIGIN_AUTH_MODE=access` for a Cloudflare Access protected gateway. Configure a
  **Service Auth** policy for an enrolled service token. Store `CF_ACCESS_CLIENT_ID` and
  `CF_ACCESS_CLIENT_SECRET` as Worker secrets using Wrangler's documented secret workflow.
  Both are mandatory in Access mode. The origin receives these as Access service headers;
  the caller's Records `Authorization: Bearer …` remains separate.
- `ORIGIN_AUTH_MODE=records` is an explicit alternative for an HTTPS gateway relying on its
  own Records credentials. It supplies no Access service token. Do not choose this mode for
  an origin that requires Access.
- Add an explicit custom domain or route for the target account only when deployment is
  intended. Enable gateway authentication, request limits and operational monitoring first.

Local `.dev.vars` and `.env` files are ignored. Never put credentials in Wrangler vars, URLs,
source code, logs or gadget configuration. This Worker does not store user credentials.

## Transport and limitations

Only supported Records public routes and GET/POST methods are proxied. Request headers use
an allowlist: authorization, JSON content type, accept, idempotency key and revision precondition.
Caller-supplied Access credentials, cookies and forwarded identity headers are discarded.
Response headers are similarly limited; origin cookies and redirects are never exposed.

The upstream request uses `redirect: manual`, rejects all redirects, and has a 15-second
deadline for response headers. Responses stream without buffering, including SSE. The
deadline is removed when headers arrive so a healthy SSE stream can continue for the
gateway's bounded stream lifetime. Client cancellation propagates upstream. Known request
lengths above 64 KiB are rejected here; the gateway also bounds streamed JSON bodies before
executing any command. Responses are never cached by this Worker.

This is a same-origin/server-client interface: no wildcard CORS, cookie authentication,
credential exchange or browser token vending is added. Configure a trusted application
backend or explicit host integration for gadgets.

## Checks

From the repository root:

```sh
node --test packages/records-edge/test/*.test.ts
WRANGLER_LOG_PATH=/tmp/records-edge-wrangler.log node_modules/.bin/wrangler types \
  -c packages/records-edge/wrangler.jsonc packages/records-edge/worker-configuration.d.ts --strict-vars=false
node_modules/.bin/tsc -p packages/records-edge/tsconfig.json --noEmit
WRANGLER_LOG_PATH=/tmp/records-edge-wrangler.log node_modules/.bin/wrangler deploy \
  -c packages/records-edge/wrangler.jsonc --dry-run --outdir /tmp/records-edge-dry-run
```

Five focused transport tests, generated runtime types, TypeScript and Wrangler dry-run are
the local qualification. A dry-run does not validate a deployed route, Cloudflare Access
policy, production network latency or real origin certificates.

Verified against installed Wrangler 4.124.0 and current documentation:
[request redirects](https://developers.cloudflare.com/workers/runtime-apis/request/),
[Worker configuration](https://developers.cloudflare.com/workers/wrangler/configuration/),
[Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).
