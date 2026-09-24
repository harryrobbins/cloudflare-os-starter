# Customizing Cloudflare OS

This wrapper exposes controls at three depths. Start in the Admin UI, move to deployment configuration when the trust or infrastructure boundary changes, and write code only for capabilities that neither layer can express.

## Admin UI

Use `/admin` for runtime policy that should not require a deployment:

- Site name, logo, and accent color
- Announcements and agent instructions
- Connector availability and auto-provisioning policy
- Signup behavior, featured blueprints, and output formats

Authentication and authorization are deliberately absent. Sign-in configuration and administrator identities remain deployment-controlled so a compromised admin session cannot redefine the trust boundary.

### Branding

Set the site name, logo, and accent color from the General tab in `/admin`. Logo uploads accept PNG, JPEG, WebP, and SVG files up to 5 MB. The browser scales the longest edge to 256 pixels without cropping and converts the result to PNG. The server then checks the PNG header and rejects anything over 256 KB or 512 pixels before storing it in the deployment's blueprint-content R2 bucket. Square images work best.

The custom logo appears in the app chrome, sign-in screens, and browser tab on each user's next connection. Use **Restore default** to remove it.

## Deployment configuration

[`deployment.jsonc`](../deployment.jsonc) is an annotated, non-secret control surface. Its groups map directly to generated Wrangler configuration:

| Path | Controls | Choices |
| --- | --- | --- |
| `accountId` | Resource ownership | A 32-character [Cloudflare account ID](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/) |
| `publicBaseUrl` | The deployment's public origin | `null` to derive it from the router's custom domain; on a `workers.dev` route, the router's own `https://<router-name>.<subdomain>.workers.dev` |
| `workers.*.name` | Stable Worker service identities | Unique lowercase names; changing one creates a differently named Worker |
| `workers.router.route` | The deployment's public address | `customDomain` for production or `workersDev: true` for evaluation |
| `access` | Cloudflare Access trust and administrator list | Access team issuer, application audience, and verified email list |
| `aiGateway` | Deployment-managed model catalog | Enabled by default over the Workers AI binding; which providers to advertise, which gateway, and an optional model allow-list |
| `context` | Context sharing boundary, snapshot KV, and optional Artifacts repositories | `null` to scope data to the public origin, or a pinned stable label; automatic or existing KV; Git-backed collections disabled or enabled |
| `customGatekeeper` | Example integration identity and guidance | Organization-specific display text |
| `chat` | Team chat Worker, its uploads bucket, and the upload cap | Enabled or disabled; a bucket to provision or an existing one to reuse; see [Team chat](#team-chat) |
| `errorReporting` | Private explicit-issue destination | Console Reporter enabled state, environment, and release metadata |
| `resources` | Blueprint/avatar KV and blueprint-content R2 | `null` to provision or explicit IDs/names to reuse |
| `formatBlueprintsDir` | Formats shipped with the deployment | `null` for upstream's Docs, Sheets and Slides, or a directory of `.gadget`/`.json` pairs; see [Bundled formats](#bundled-formats) |
| `observability` | Worker telemetry | Structured logs, invocation logs, traces, and sampling; see the [observability guide](observability.md) |

Secrets are never valid values in this file. Install them interactively with Wrangler against the Worker that consumes them.

### Workers and routing

The deployment is seven Workers, plus team chat and Notebook Python execution when those are enabled. Keep their names unique: service bindings use these names, so update and deploy them together.

| Worker | Role |
| --- | --- |
| `router` | Owns the public route and serves the frontend. Proxies `/api` and `/blueprint-screenshot` to the Workshop, and `/gatekeeper/<name>` to the Gatekeeper whose service binding matches. |
| `workshop` | The Cloudflare OS backend, holding all user data in Durable Objects. |
| `context` | The Context Gatekeeper. |
| `scheduler` | The Scheduler Gatekeeper, which gives agents scheduled and recurring work. |
| `procgen` | The Synthetic Data Gatekeeper, which generates finite deterministic datasets. |
| `customGatekeeper` | This repository's example integration. |
| `chat` | [Team chat](#team-chat), which also serves its own app at `/gatekeeper/chat/`. Deployed only while `chat.enabled`. |
| `errorReporter` | The private explicit-issue destination. |

Context and Scheduler are *ambient*: upstream's release marks both `PREINSTALL`, so the hosted flow installs them on every instance and this starter deploys them for the same reason. Neither takes configuration beyond its name — the Scheduler takes none at all.

Only the router takes a route; every other Worker is reachable only over service bindings, and the deploy turns off `workers.dev` and [Preview URLs](https://developers.cloudflare.com/workers/configuration/previews/) on all of them. That keeps the router the single Access-protected way in.

For production, set a [Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) on it:

```jsonc
"workers": { "router": { "name": "acme-os", "route": { "customDomain": "os.example.com" } } }
```

The hostname must belong to an active Cloudflare zone and cannot conflict with an existing CNAME. Wrangler creates the DNS record and certificate, and `publicBaseUrl` can stay `null` — the deploy derives the public origin from the domain. For evaluation, use the account's [`workers.dev`](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) subdomain instead:

```jsonc
"publicBaseUrl": "https://acme-os.<subdomain>.workers.dev",
"workers": { "router": { "name": "acme-os", "route": { "workersDev": true } } }
```

`publicBaseUrl` is required there, because nothing in `deployment.jsonc` knows your account's `workers.dev` subdomain. If using workers.dev that value must be `https://<router-name>.<subdomain>.workers.dev`. Two things read the origin — `PUBLIC_BASE_URL`, which upstream builds absolute links and OAuth redirect URIs from, and the Context sharing boundary under [Storage](#storage) — so a typo here would deploy successfully and then hide existing Context data and break every redirect.

On a custom domain the hostname is yours and has nothing to do with any Worker name, so `pnpm check` compares `publicBaseUrl` against `customDomain` instead: leave it `null` and the deploy derives the origin from the domain, or set it to exactly `https://<customDomain>`.

### Sign-in methods

Cloudflare OS supports three ways to sign users in. This starter deploys Cloudflare Access.

| Method | How it works | In this starter |
| --- | --- | --- |
| Cloudflare Access | Access verifies identity before the request reaches the Worker, and the Workshop trusts the signed Access JWT. The password login and signup pages are disabled. | Deployed by default |
| Built-in password accounts | Cloudflare OS serves its own username and password login plus signup. This is the upstream default. | Requires deploy script changes |
| Auth Gatekeepers | Gatekeepers that advertise `providesAuth` add "Continue with ..." buttons, alongside or instead of password login. | Requires deploy script changes |

Access mode is the default here because unauthenticated requests never reach application code. `scripts/deploy.ts` implements it by setting `CF_ACCESS_ISS` and `CF_ACCESS_AUD` on the Workshop and building the frontend with `VITE_CF_ACCESS_MODE=true`.

To run another method, drop those two variables and the build flag, then set upstream's `AUTH_GATEKEEPERS` allowlist for provider sign-in. `DISABLE_PASSWORD_AUTH=true` makes a deployment provider-only. Upstream ignores it unless at least one auth Gatekeeper is allowlisted, so a deployment cannot lock everyone out. The wrapper's validation assumes Access mode, so review the upstream Workshop backend and frontend documentation before changing it.

The `admins` list gates `/admin` in every method.

#### Cloudflare Access

Create a [self-hosted Access application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) covering the router's hostname. Then configure:

- `issuer`: the team origin, such as `https://acme.cloudflareaccess.com`, with no path.
- `audience`: the application's [AUD tag](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/#get-your-aud-tag).
- `admins`: Access-verified email addresses allowed into `/admin`.

Access policies decide who can sign in. The `admins` list decides which signed-in identities can change runtime policy. Keep both narrow.

### Storage

Wrangler supports [automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning) for KV and R2. Leave these values as `null` for a new deployment:

```jsonc
"context": {
  "sharingDomain": null,
  "kvNamespaceId": null
},
"resources": {
  "blueprintsKvNamespaceId": null,
  "avatarsKvNamespaceId": null,
  "blueprintContentBucket": null
}
```

Wrangler creates resources with the Worker name as a prefix and reconnects them on future deploys. To adopt existing data, replace the relevant `null` with a [KV namespace ID](https://developers.cloudflare.com/kv/reference/kv-commands/#kv-namespace) or [R2 bucket name](https://developers.cloudflare.com/r2/reference/wrangler-commands/#r2-bucket).

`context.sharingDomain` is not storage but a data-isolation boundary: Context collections are visible only within it. `null` scopes them to the deployment's public origin, which is what the hosted deploy does. Changing the boundary hides existing collections even with the right KV bound, so pin it to a literal string when a hostname change must not move it:

```jsonc
"context": { "sharingDomain": "https://os.example.com" }
```

### Context Artifacts

The Context Gatekeeper can use [Artifacts](https://developers.cloudflare.com/artifacts/) as Git-compatible storage for Context collections. This is disabled when `enabled` is omitted or false and requires Artifacts access on the deployment account. Enable it without specifying a namespace to use `gatekeeper-context-collections`:

```jsonc
"artifacts": { "enabled": true }
```

To isolate repositories under another stable namespace, add the optional property:

```jsonc
"artifacts": {
  "enabled": true,
  "namespace": "acme-context-collections"
}
```

Artifacts creates the namespace implicitly when the first repository is created. Keep the selected namespace stable: existing Git-backed collections refer to repositories in it. Disabling the binding later stops repository refresh and token management but does not delete repositories; the last synchronized Context content remains readable. Write tokens grant repository mutation authority, so protect them like other credentials and revoke them when no longer needed.

### AI models

Every provider, Workers AI included, is reached through [AI Gateway](https://developers.cloudflare.com/ai-gateway/). The transport is the Workshop's `WORKERS_AI` binding, which is pre-authenticated inside your own account — so the default configuration needs **no API token at all**:

```jsonc
"aiGateway": {
  "enabled": true,
  "name": "default",
  "accountId": null,
  "providers": ["cloudflare"]
}
```

Cloudflare can [create the `default` gateway on first use](https://developers.cloudflare.com/changelog/post/2026-03-02-default-gateway/). `accountId: null` means the gateway lives in the deployment's own account, which is what makes the binding transport usable.

The binding stays bound whatever you configure here: as well as carrying gateway traffic, it is what the agent's `webFetch` tool runs document-to-Markdown conversion on.

| Configuration | Result |
| --- | --- |
| `enabled: true`, `providers: ["cloudflare"]` | Workers AI models over the binding. No token, no keys of your own. The default. |
| Add `anthropic` or `openai` | Their models appear too. Keys live on the gateway ([Unified Billing or BYOK](https://developers.cloudflare.com/ai-gateway/get-started/#provider-authentication)), not in this repository. Still no token. |
| Add `openrouter` | Rides the binding like the two above, so still no token, but it has no built-in catalogue: list its models under `aiGateway.models` and store the OpenRouter key on the gateway as BYOK. See [Storing the OpenRouter key](#storing-the-openrouter-key). |
| Add `google` | Needs `CF_AI_GATEWAY_API_TOKEN`. pi's Google adapter refuses a custom fetch, so Google inference cannot ride the binding. |
| `accountId` set to another account | Needs `CF_AI_GATEWAY_API_TOKEN`. The binding only reaches gateways in the Worker's own account, so the generated config sets `CF_AI_GATEWAY_USE_BINDING: "false"` and the HTTPS transport takes over. |
| `enabled: false` | No deployment-managed catalog. Each user supplies their own model API keys — and a Workshop [migrated from the hosted deploy](migrate-from-hosted.md) will show an empty model picker. |

`pnpm check` reports which of the last two applies before it deploys anything.

#### Model allow-list

`aiGateway.models` is a deployment-owned allow-list, keyed by provider and then by the model id the provider's API takes. The deploy emits it as the Workshop's `CF_AI_GATEWAY_EXTRA_MODELS` var, and the pinned Cloudflare OS fork merges it over upstream's built-in catalogue, so the picker shows both. Every provider named here must also be in `aiGateway.providers`.

```jsonc
"aiGateway": {
  "enabled": true,
  "name": "default",
  "accountId": null,
  "providers": ["cloudflare", "openrouter"],
  "models": {
    "openrouter": {
      "qwen/qwen3.8-flash": { "name": "Qwen 3.8 Flash", "contextWindow": 1000000, "outputLimit": 131072 }
    }
  }
}
```

`name` is what the picker shows, `contextWindow` is the input window in tokens, and `outputLimit` is optional. OpenRouter ids are its own `vendor/model` form, including the `~vendor/model` alias prefix it uses for "latest" pointers. `openrouter` ships with no built-in models, so `pnpm check` refuses to enable it without at least one entry here.

#### Storing the OpenRouter key

The key never enters this repository or a Worker secret. Store it on the gateway named in `aiGateway.name` as a [BYOK provider key](https://developers.cloudflare.com/ai-gateway/configuration/byok/): in the dashboard, open AI, then AI Gateway, choose the gateway, open Provider Keys, and add a key for the OpenRouter provider with the alias `default`. The Workshop's binding-routed requests carry no provider `Authorization` header, so the gateway attaches the stored key itself. A request that reaches OpenRouter unauthenticated means the key is missing, is under a different alias, or is stored on a different gateway than `aiGateway.name` names.

#### When a token is required

Only the two rows above need one. Create a narrowly scoped [API token](https://dash.cloudflare.com/profile/api-tokens) following the current [AI Gateway authentication guidance](https://developers.cloudflare.com/ai-gateway/configuration/authentication/) — a Run + Read token; current guidance calls for Account permissions `AI Gateway - Read`, `AI Gateway - Edit`, and `Workers AI - Read`. Install it without putting the value on the command line:

```sh
CLOUDFLARE_ACCOUNT_ID=your-account-id pnpm exec wrangler secret put CF_AI_GATEWAY_API_TOKEN --name your-workshop-worker
```

Note: Use the `accountId` from your own `deployment.jsonc`, i.e the account the Workshop deploys to.

In exactly those cases the generated Wrangler config [declares the secret as required](https://developers.cloudflare.com/workers/configuration/secrets/#validate-secrets-before-deploy), so the deploy fails clearly if it is missing. On the default path it does not, so a deployment that needs no token is never blocked waiting for one.

### Observability

The starter enables structured custom logs and a private console-backed Error Reporter, while invocation logs, traces, and browser reporting remain separate controls. See [Observability and error reporting](observability.md) for signal selection, sampling, triage, privacy, source maps, frontend reporting, and external destinations.

### Bundled formats

Formats are the blueprints offered under **New** in the composer. You can promote any published blueprint to a format in `/admin` without a deploy. To ship formats with the deployment itself, so a fresh instance has them from its first request, set `formatBlueprintsDir`:

```jsonc
"formatBlueprintsDir": "formats"
```

- **What it points at.** The directory holds `<name>.gadget` archives, each with a `<name>.json` sidecar that sets `blueprintId`, `title`, `description`, `output` and `revision`.
- **How the deploy uses it.** The deploy passes the directory's absolute path to the Workshop build as `FORMAT_BLUEPRINTS_DIR`.
- **It replaces upstream's formats.** The directory replaces upstream's default set rather than adding to it. That is why this repository's [`formats/`](../formats) carries copies of Docs, Sheets and Slides beside its own formats (Board, Whiteboard, Notebook, Data Explorer, Wave and Tessera Mosaic). The deploy refuses a directory with no archives, or an archive with no sidecar.
- **Updating a format.** A deployment reinstalls a format only when its `revision` or presentation changes. Bump `revision` with every code change.
- **Never change a `blueprintId`.** It is the install key.

This repository builds these formats from source, and each package's tests fail if its committed archive is stale:

| Format | Source | Rebuild with |
| --- | --- | --- |
| Board (`format.board`) | [`packages/blueprint-kanban`](../packages/blueprint-kanban/README.md) | `pnpm --filter blueprint-kanban pack:gadget` |
| Whiteboard (`format.whiteboard`) | [`packages/blueprint-whiteboard`](../packages/blueprint-whiteboard/README.md) | `pnpm --filter blueprint-whiteboard pack:gadget` |
| Data Explorer (`format.procgen-explorer`) | [`packages/blueprint-procgen-explorer`](../packages/blueprint-procgen-explorer/README.md) | `pnpm --filter blueprint-procgen-explorer pack:gadget` |
| Notebook (`format.notebook`) | [`packages/blueprint-notebook`](../packages/blueprint-notebook/README.md) | `pnpm --filter blueprint-notebook pack:gadget` |
| Wave (`format.wave`) | [`packages/blueprint-wave`](../packages/blueprint-wave/README.md) | `pnpm --filter blueprint-wave pack:gadget` |
| Tessera Mosaic (`format.tessera`) | [`packages/blueprint-tessera`](../packages/blueprint-tessera/README.md) | `pnpm --filter blueprint-tessera pack:gadget` |

Each command rebuilds `formats/<name>.gadget` and bumps its revision.

### Team chat

Team chat is a chat for everyone who can sign in to the deployment: channels, direct messages, threads, unread and mention tracking, search across everything, and file uploads. It is one deployment-owned Worker, `packages/gatekeeper-chat`, and it is on by default:

```jsonc
"workers": { "chat": { "name": "cfos-chat" } },
"chat": { "enabled": true, "filesBucket": null, "maxUploadBytes": 10485760 }
```

Chat is reached at **`https://<your public origin>/gatekeeper/chat/`**. The router proxies `/gatekeeper/chat` and everything under it — the app, its JSON API, its WebSocket, and authenticated file downloads — over a `GATEKEEPER_CHAT` service binding, and that binding name is what creates the path (see [Custom Gatekeepers](#custom-gatekeepers)).

A deploy with chat enabled creates three things:

| Resource | What it holds |
| --- | --- |
| One Worker, named by `workers.chat.name` | The app, the API, the WebSocket, and the file routes. No route and no Preview URL of its own, like every other Worker behind the router. |
| One SQLite Durable Object, `ChatWorkspace` | Every message, channel, membership, read cursor, reaction and the full-text search index. Its migrations are declared in the package's `wrangler.jsonc` and replayed in order. |
| One R2 bucket, bound as `FILES` | Uploaded files and generated thumbnails. Bytes stay out of the Durable Object. |

| Key | Controls |
| --- | --- |
| `chat.enabled` | Whether any of the above is built, deployed or bound. `false` is a complete opt-out. |
| `chat.filesBucket` | `null` lets Wrangler provision the uploads bucket and remember it, like the other [storage](#storage) values. A name adopts an existing bucket, which is how uploads survive a Worker rename. |
| `chat.maxUploadBytes` | Hard cap on one upload, deployed as the Worker's `MAX_UPLOAD_BYTES`. An upload arrives as a single Worker request body, so 100 MiB is the ceiling `pnpm check` allows. |
| `chat.agentAccess` | Optional, default `false`. `true` also binds chat to the Workshop with the `GatekeeperVendor` entrypoint, so every workspace gets an ambient chat session for the agent: public channels to read and search, posting as an approval-gated action. Leave it off until that observer policy has been reviewed in `/admin`; the chat app itself does not need it. |

Identity is not configured here. Signing in through Access *is* membership: nobody is invited, approved or asked for a name, and display names come from the Access identity. The chat Worker verifies the `cf-access-jwt-assertion` itself — with the `CF_ACCESS_ISS` and `CF_ACCESS_AUD` from [`access`](#cloudflare-access), on every request and every WebSocket upgrade — rather than trusting the router, and `access.admins` are its administrators, the identities that can rename and archive any channel. The package's `wrangler.dev.jsonc` carries a development-only identity switch (`DEV_IDENTITIES`); `pnpm check` refuses a deploy whose base *or* generated config carries any `DEV_*` var or required secret, so that bypass cannot reach the Access-protected hostname.

Retention and backup are policy, not defaults: the Durable Object keeps all history and the bucket keeps all uploads, and neither expires anything on its own. Decide how long messages, attachments and deleted content are kept, and rehearse a restore, before a team relies on chat. Schema changes go through the package's numbered migrations — never roll back by deleting the `ChatWorkspace` class or the bucket, which destroys the data instead.

The chat **dock** — the drawer with the unread badge in the sidebar and in the fullscreen workspace editor's top bar, plus the `/chat` page inside the shell — is a fork commit in the submodule (`feat/chat-dock`: `workshop-frontend/src/components/ChatDock.tsx`, `ChatTrigger.tsx`, `chatDockBus.ts`, `routes/chat.tsx`). It embeds the same app in a same-origin iframe and talks to it over the `postMessage` bridge typed in `packages/gatekeeper-chat/src/shared/protocol.ts`. `Ctrl/Cmd+Shift+L` toggles the drawer, and the command palette (`Ctrl/Cmd+K`) carries a **Toggle chat** action for anybody who never learns the chord. `scripts/deploy.ts` builds the frontend with `VITE_CHAT_DOCK=true` when `chat.enabled`, and without it the dock, both triggers and the route drop out of the bundle. The flag is deliberately a build-time value tied to this deployment's wiring rather than a probe of `/gatekeeper/chat`: while the chat Worker is redeploying the dock shows an unavailable state with a retry, and the way in never disappears. Chat itself works with the dock absent — `https://<your public origin>/gatekeeper/chat/` is bookmarkable.

To disable chat, set `"enabled": false`. The build, the deploy and both service bindings disappear, and `pnpm check` stops validating the rest of the block. The Worker, its Durable Object and its bucket are not deleted by disabling it, so re-enabling with the same names and bucket brings the history back.

### Web search and Jev

Two deployment-owned connectors reach outside the deployment: **Web Search** (`packages/gatekeeper-websearch`, Worker `workers.webSearch.name`) searches the web and fetches pages behind a privacy gate, and **Jev decisions** (`packages/gatekeeper-jev`, Worker `workers.jev.name`) asks TypeSafe's Jev decision model yes/no, choice and score questions. Both are RPC-only, bound to the Workshop as `GATEKEEPER_WEBSEARCH` and `GATEKEEPER_JEV`, and need an `OPENROUTER_API_KEY` secret on their own Worker.

```jsonc
"webSearch": { "enabled": true, "blockedTerms": [] },   // "builtinWebFetch": false
"jev": { "enabled": true }
```

Deploying them does not hand them to every workspace. Like Synthetic Data and Notebook Python, each is a **connection** a workspace has to be given explicitly. Each has one resource: `websearch://web` (suggested binding `WEBSEARCH`) and `jev://decisions` (`JEV`).

- **Turn it on for a workspace.** Open the workspace's connections, choose **Web Search** or **Jev decisions**, and connect it. The dialog explains what the connection grants and has nothing to fill in. Alternatively, the agent asks with `requestConnection` and you accept the request card in the chat. The connection then appears in the workspace's connection list beside the others, and Gadgets can bind it like any other resource.
- **Turn it off again.** Remove the connection from that workspace. The agent loses the binding and, for Web Search, the `webSafe` and `webFetchUnsafe` tools on its next turn.
- **Who can do it.** The same people who can connect any other connector to the workspace. There is no extra role.

The agent's web tools follow the connection. In a workspace connected to Web Search, the agent gets **Websafe (auto-mode)** (`webSafe`) and **Web fetch (UNSAFE)** (`webFetchUnsafe`), both calling that workspace's session. The privacy gate, Jev review and approvals are unchanged, and an unchecked fetch still always waits for the user. In every other workspace, the agent has no web tool. With web search enabled, the deploy sets the Workshop's `AGENT_WEB_FETCH=off`, which withholds upstream's built-in `webFetch` (it fetches any public URL with no check). Set `webSearch.builtinWebFetch: true` only if you want unconnected workspaces to keep that unchecked tool. With web search disabled, the Workshop keeps `webFetch` as upstream ships it.

`/admin` → Gatekeepers still lists both as auto-provisioned connectors, with the three-state mode that applies to Synthetic Data too. In every mode, access still needs a connection per workspace:

| Mode | Effect |
| --- | --- |
| `optional` (the default) | Each person adds the connector's account under **Connectors**, or the connect dialog adds it for them. |
| `enabled` | Every person has the account already. |
| `disabled` | No account is provisioned for it, so people who have not added it yet cannot connect it. To withdraw it from existing connections too, set `enabled: false` for it in `deployment.jsonc`. |

**Existing workspaces.** Before this change, both connectors were agent *singletons*, so every workspace of anyone holding the account got them automatically. On the first open after the upgrade, the Workshop re-reads the account's description, sees that it no longer provides a singleton, and retires those automatic capsules. The Web Search capsule's storage (its per-workspace query audit log) stays in the workspace Durable Object, but no agent or Gadget can reach it. No data or Durable Object is deleted, and no migration runs. Nothing is granted implicitly any more. A workspace that relied on web search or Jev needs one explicit connection (above). Chats started before then keep the old binding name, but it no longer resolves.

### Organisation records

Organisation records is a Postgres-backed service for data the organisation owns, rather than any one gadget or person: datastores that many gadgets and external systems share, with memberships, roles, audit history and change notifications. It is one Worker, `packages/gatekeeper-records`, and it is **off by default**. Design and status: [organisation datastores plan](plans/organisation-datastores.md).

```jsonc
"workers": { "records": { "name": "cfos-records" } },
"records": {
  "enabled": true,
  "hyperdriveId": "<32 hex>",           // runtime role (records_app), caching disabled
  "publisherHyperdriveId": "<32 hex>",  // outbox publisher role (records_publisher), caching disabled
  "apiAccessAudience": null              // or the AUD tag of the /gatekeeper/records/v1 Access app
  // "changesQueue": "cfos-records-changes", "deadLetterQueue": "cfos-records-changes-dlq"
}
```

| Key | Controls |
| --- | --- |
| `records.enabled` | Whether the Worker is built, deployed and bound. When `false` the rest of the block is not validated, and a placeholder-filled block is fine. |
| `records.hyperdriveId` | The Hyperdrive configuration the service reads and writes through, logging in as a member of `records_app`. |
| `records.publisherHyperdriveId` | A second, distinct Hyperdrive configuration logging in as a member of `records_publisher`, used only by the outbox publisher. |
| `records.apiAccessAudience` | AUD tag of a separate, path-specific Access application for `/gatekeeper/records/v1/*`, whose policy admits service tokens. Must differ from `access.audience`. `null` switches the machine API off: every `/v1` request is refused, while the Data page and gadget connections work normally. |
| `records.changesQueue`, `records.deadLetterQueue` | Optional queue names. When absent they default to `<workers.records.name>-changes` and `...-changes-dlq`. |

A deploy with Records enabled binds the Worker to the router as `GATEKEEPER_RECORDS` (so `/gatekeeper/records/*` reaches it) and to the Workshop with the `GatekeeperVendor` entrypoint (so **Organisation records** appears under Connections), and deploys it before both. The Worker gets `CF_ACCESS_ISS`/`CF_ACCESS_AUD` from [`access`](#cloudflare-access), because its connect page verifies the person's Access identity itself.

Nothing is provisioned by `pnpm deploy`. Before enabling:

1. Create a Postgres database and take its **direct** (non-pooler) connection string as the migration-owner credential.
2. `RECORDS_MIGRATION_URL=<owner url> pnpm --filter @records/schema db:migrate`. This creates the `records` and `projects` schemas and the NOLOGIN group roles `records_app` and `records_publisher`.
3. Create two LOGIN users and `GRANT records_app` / `GRANT records_publisher` to them, plus `CONNECT` on the database.
4. `wrangler hyperdrive create <name> --connection-string=<login url> --caching-disabled` for each login. Caching must be disabled: permission reads have to be fresh, and `pnpm check` cannot see this setting.
5. `wrangler queues create` the change queue and its dead-letter queue.
6. Optionally, create the path-specific Access application for the machine API.
7. `RECORDS_MIGRATION_URL=<owner url> pnpm --filter @records/schema db:bootstrap "<Organisation>" <admin e-mail> "<Admin name>"` creates the organisation and its first data administrator.

People are not added by signing in. A data administrator adds each person on the **Data** page (by the e-mail they sign in with) before that person can connect. Membership of each datastore is granted separately, and the data administrator role itself gives no access to records.

Schema changes are numbered migrations in `packages/records-schema/migrations`, applied with `db:migrate` **before** deploying code that needs them. A Worker rollback never reverses SQL. Operator detail: [`packages/gatekeeper-records/README.md`](../packages/gatekeeper-records/README.md).

## Custom Gatekeepers

Keep deployment-owned Gatekeepers under `packages/`, outside the `cloudflare-os` submodule. `scripts/deploy.ts` binds this repository's example as `GATEKEEPER_CUSTOM` and Context as `GATEKEEPER_CONTEXT`, twice each: on the Workshop with the `GatekeeperVendor` entrypoint for RPC, and on the router with no entrypoint, where the binding name is what routes `/gatekeeper/custom` and `/gatekeeper/context` to it. A Gatekeeper that serves HTTP — an OAuth redirect, for instance — needs both.

The minimal example flow is:

1. `types.d.ts` defines the API visible to TypeScript callers.
2. `CustomSessionImpl.getDeploymentInfo()` authorizes an observation before returning data.
3. `CustomGatekeeper` reads deployment values and creates the session.
4. `CustomAccount` exposes that session as a singleton.
5. `GatekeeperVendor` advertises credential-free auto-provisioning.
6. The Workshop service binding makes the vendor available to Cloudflare OS.

Read the [package guide](../packages/custom-gatekeeper/README.md) and upstream [`write-gatekeeper` skill](https://github.com/cloudflare/cloudflare-os/blob/main/.agents/skills/write-gatekeeper/SKILL.md) before adding OAuth, URL-scoped resources, writes, simulations, hooks, configurator UI, or stricter observer verification.

The wrapper also ships a credential-free Synthetic Data Gatekeeper from
[`packages/gatekeeper-procgen`](../packages/gatekeeper-procgen/README.md). It is bound only to the
Workshop as `GATEKEEPER_PROCGEN`; its configurator and dataset sessions travel over RPC, so it has
no Router binding or public route. Dataset resources use `procgen://commerce/v1/<seed>/<profile>`
and expose the suggested Gadget binding name `PROCGEN`.

## Code extensions

Prefer wrapper-owned Workers and [service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) over patches inside the submodule. Modify upstream only when a Worker boundary cannot express the behavior, and keep the change as a reviewable upstream commit or fork rather than a generated overlay.

## Upgrade

1. Record the current `cloudflare-os` gitlink for rollback.
2. Update the submodule to the intended upstream commit. The submodule tracks the `starter-openrouter` branch of this deployment's Cloudflare OS fork, which carries the `openrouter` provider, the `CF_AI_GATEWAY_EXTRA_MODELS` allow-list and the `gadgetViewer` viewer identity (formats attribute changes to the signed-in account through it; see [Viewer identity and change attribution](plans/collaborative-blueprints.md#viewer-identity-and-change-attribution)) on top of upstream; rebase that branch onto the new upstream commit, push it, and pin the rebased commit here.
3. Review Workshop and Context Wrangler base-config changes and Gatekeeper contracts.
4. Diff `cloudflare-os/pnpm-workspace.yaml`'s `catalog:` against this repository's and re-sync it. Two submodule packages are members of this workspace and resolve `catalog:` here, so a missing entry fails the install and a *stale* one silently gives the tree two copies of `capnweb` — a failure that only appears once the two installs are separate, as they are in CI.
5. Run `pnpm install`, `pnpm --dir cloudflare-os install`, `pnpm lint`, and `pnpm check`.
6. If `formatBlueprintsDir` is set, compare `cloudflare-os/packages/workshop-backend/format-blueprints/*.json` with the copies in `formats/`. Re-copy any `.gadget`/`.json` pair whose `revision` moved, or the deployment keeps shipping the old Docs, Sheets and Slides.
7. Carry the fork's `feat/chat-dock` commit forward with the rest of the fork branch. It is frontend-only — `ChatDock.tsx`, `ChatTrigger.tsx`, `chatDockBus.ts`, `routes/chat.tsx`, `routes/chat_.$.tsx`, `ChatDock.integration.test.tsx`, four call sites and `routeTree.gen.ts` — so it either rebases cleanly or is dropped: chat keeps working at `/gatekeeper/chat/` without it. `routeTree.gen.ts` is generated, so resolve a conflict there by re-running the frontend build rather than by hand.
8. If [team chat](#team-chat) is enabled, rebuild `packages/gatekeeper-chat` against the new submodule — its Gatekeeper vendor uses `@gadgets/workshop-shared` — and check that its `ChatWorkspace` migrations are unchanged and still replay in order. Never roll back chat by deleting that Durable Object class or its uploads bucket.
9. Deploy and verify Access, administrator access, storage, configured AI, Context, custom observations, the Error Reporter query surface, and that every bundled format still instantiates from **New**.
10. If needed, restore the previous gitlink and redeploy, or use [Workers rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) when bindings remain compatible.

Do not update the submodule blindly. The deployment script derives from upstream configs so incompatible base changes remain visible during review and checks.
