# Upstream Gatekeeper credential models

Research written 2026-09-23 against the pinned `cloudflare-os` submodule at commit `e50a9058`.
It classifies the upstream Gatekeepers by who supplies credentials and where authority lives. It
does not mean that every package is deployed by this starter: `/admin` can only discover a
Gatekeeper after the deployment creates its Worker and binds it to the Workshop.

## Headline

An OAuth Gatekeeper normally has two distinct credential layers:

1. The deployment operator registers one OAuth application and installs its `CLIENT_ID` and
   `CLIENT_SECRET` on that Gatekeeper Worker. These identify the deployment's application; they are
   not a shared end-user account.
2. Each user presses **Connect**, signs in to their own provider account, and authorizes the scopes
   requested for the selected resource. The resulting access/refresh grant is stored in that
   user's Gatekeeper account Durable Object.

GitHub follows this model. The operator creates one GitHub **OAuth App**; each user authorizes their
own GitHub identity and repositories. Users do not give Cloudflare OS a GitHub password or personal
access token. The package requests `repo read:user user:email` for connections
([GitHub guide](../../cloudflare-os/packages/gatekeeper-github/README.md)). There is no GitLab
Gatekeeper in this pinned checkout.

Enabling a connector in `/admin` only controls whether an already-deployed Gatekeeper and its
resources are offered. It does not create the provider OAuth application, install Worker secrets,
or turn a deployment credential into a user grant.

## Complete upstream inventory

The release manifest classifies these packages as installable unless noted otherwise. “Deployment
credential” means a secret shared by that Gatekeeper Worker across users; “per-user grant” means
the external authority is separately authorized and stored for each connected user.

| Gatekeeper | Deployment-wide requirement | Per-user authentication | Credential model |
| --- | --- | --- | --- |
| Cloudflare | OAuth client ID/secret and registered callback | User authorizes their Cloudflare account | Deployment OAuth app + per-user grant |
| Confluence | Atlassian OAuth client ID/secret and callback | User authorizes accessible Confluence sites | Deployment OAuth app + per-user grant |
| GitHub | GitHub OAuth App client ID/secret and callback | User authorizes their GitHub account | Deployment OAuth app + per-user grant |
| Google | Google Web OAuth client ID/secret, consent screen, APIs and callback | User authorizes selected Google resources | Deployment OAuth app + per-user grant |
| Linear | Linear OAuth client ID/secret and callback | User authorizes their Linear workspace | Deployment OAuth app + per-user grant |
| Notion | Public integration client ID/secret and callback | User chooses pages/databases to share | Deployment OAuth app + per-user grant |
| Slack | Slack app client ID/secret, callback and user-token scopes | User authorizes their Slack workspace identity | Deployment OAuth app + per-user grant |
| Spotify | Spotify app client ID/secret and callback | User authorizes their Spotify account | Deployment OAuth app + per-user grant |
| Supabase | Supabase OAuth app client ID/secret and callback | User authorizes an organization | Deployment OAuth app + per-user grant |
| ZoomInfo | ZoomInfo OAuth app client ID/secret and callback | User authorizes their ZoomInfo account | Deployment OAuth app + per-user grant |
| Home Assistant | No deployment credential | User pastes their instance URL and long-lived access token | Entirely per-user secret |
| MCP | No deployment credential or fixed server | User supplies an endpoint; it is public or uses dynamic OAuth | Public or per-user dynamic grant |
| MCP Portal | Deployment portal URL; optional shared token | OAuth mode authorizes each user; `none` has no auth | Conditional; see below |
| Context | KV binding; optional deployment-owned Artifacts configuration | Auto-provisioned local account | No third-party credential |
| Scheduler | Worker/Durable Object service only | Auto-provisioned local account | No third-party credential |
| Email | Cloudflare Email Routing, DNS and an Email Worker route; not manifest-installable | No external account connection | No secret, but deployment-wide infrastructure |

The OAuth-app group is corroborated by the release manifest's `CLIENT_ID` and `CLIENT_SECRET`
secret inputs and by the package implementations. Examples include the
[Cloudflare OAuth setup](../../cloudflare-os/packages/gatekeeper-cloudflare/README.md#setting-up-cloudflare-oauth-credentials),
[Confluence credential setup](../../cloudflare-os/packages/gatekeeper-confluence/README.md#configuring-credentials),
[Notion authentication](../../cloudflare-os/packages/gatekeeper-notion/README.md#auth), and
[Slack authentication](../../cloudflare-os/packages/gatekeeper-slack/README.md#auth).

## Gatekeepers without platform-wide third-party credentials

### Home Assistant

The user supplies an instance URL and a Home Assistant long-lived access token. The Gatekeeper
validates and stores both in that user's Durable Object. There is no central OAuth application, but
the token is powerful and long-lived; on a Cloudflare-hosted deployment the Home Assistant endpoint
must also be publicly reachable. See the
[Home Assistant authentication model](../../cloudflare-os/packages/gatekeeper-homeassistant/README.md#authentication).

### MCP

The user supplies an HTTPS MCP endpoint. Public servers need no token. A `401` starts protected
resource discovery, authorization-server discovery, dynamic client registration, authorization
code with PKCE, and a per-user grant. The deployment supplies no server-specific client secret.
This is the broadest “bring your own service” option, but the endpoint and its tool annotations are
a user trust decision; production keeps private, loopback, link-local and metadata destinations
blocked. See [MCP configuration and connection flow](../../cloudflare-os/packages/gatekeeper-mcp/README.md#configuration).

### MCP Portal

This connector always needs one administrator-selected `MCP_PORTAL_URL`, which is global
configuration but not itself a credential. Its authentication mode changes the answer:

- `oauth` (default): users individually authorize against the portal; no shared portal secret.
- `none`: no credential at either layer.
- `token`: the deployment supplies one shared `MCP_PORTAL_TOKEN`; this is a platform-wide secret,
  and users do not individually authorize.

Changing the portal URL is a trust-boundary change and forces existing accounts to reconnect. See
the [MCP Portal configuration](../../cloudflare-os/packages/gatekeeper-mcp-portal/README.md#configuration).

### Context and Scheduler

These are deployment-local ambient Gatekeepers. Context uses deployment storage bindings and may
optionally use the account's Artifacts service; Scheduler owns its Durable Objects and alarms. They
do not ask the operator or user for an external SaaS credential.

### Email

Email uses no API key or OAuth application because the Worker is the receiving service. Production
still requires a domain, Cloudflare Email Routing DNS records, and a route to the Email Worker. The
release manifest marks it non-installable, so it needs special deployment wiring rather than the
ordinary connector path. See [Email production configuration](../../cloudflare-os/packages/gatekeeper-email/README.md#production-configuration).

## Security and deployment consequences

- Keep deployment OAuth credentials in Worker secrets, never `deployment.jsonc`, tracked files,
  shell command arguments, logs, or documentation. The OAuth client ID is often public by protocol,
  but the current release models both fields as secret inputs; preserve that contract.
- Treat installation and enablement separately. Installing creates Workers, service bindings,
  callback routes and possibly Durable Object migrations. `/admin` only curates the resources the
  installed vendor advertises.
- Review both layers of authority: the scopes permitted on the deployment's OAuth application and
  the resources/scopes each user grants. A narrow `/admin` resource list does not retroactively
  reduce a provider token's scopes.
- Disconnect and disable are not deletion. Per-user grants, Durable Object state, deployment
  secrets and provider-side OAuth authorizations each have their own revocation and retention path.
- Cloudflare Access remains this starter's sign-in boundary. `AUTH_GATEKEEPERS` is a separate
  deployment choice for provider-based login and is not required to offer Google, GitHub, or other
  connectors.

For an implementation sequence, see
[Enable upstream Gatekeepers](../plans/upstream-gatekeepers.md).
