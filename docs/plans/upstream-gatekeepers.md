# Enable upstream Gatekeepers

`/admin` only shows Gatekeepers that the deployment binds to the Workshop. The packages under
`cloudflare-os/packages/gatekeeper-*` are source inputs, not automatically installed connectors.
Add Google and GitHub first, then use the same reviewed path for other upstream Gatekeepers.

## Deployment wiring

1. Add optional, stable Worker names and enabled flags to `deployment.jsonc`, initially for
   `google` and `github`. Extend `scripts/deployment-config.ts` and validation accordingly. Do not
   accept arbitrary package paths from configuration; keep a code-reviewed registry containing the
   package directory, package name, binding suffix, required secrets, and whether HTTP routing is
   needed for each supported Gatekeeper.
2. Extend `scripts/deploy.ts` so every enabled Gatekeeper:
   - reads its upstream `wrangler.jsonc` and receives the common account, observability,
     `workers_dev: false`, empty routes, and disabled Preview URL settings;
   - builds its configurator UI and Worker validation output;
   - sets `BASE_URL` to `<public origin>/gatekeeper/<short-name>`;
   - requires `CLIENT_ID` and `CLIENT_SECRET` without putting either value in tracked config;
   - binds to the Workshop as `GATEKEEPER_<NAME>` with entrypoint `GatekeeperVendor`;
   - binds to the Router without an entrypoint when it serves OAuth or other HTTP endpoints; and
   - deploys before the Workshop and Router, so every binding points to an already-deployed Worker.
3. Cover configuration validation, generated Worker configs, build commands, binding names, and
   deployment order in the deploy-script tests. `pnpm check` must build and dry-run every enabled
   Gatekeeper and remove all generated `wrangler.prod.jsonc` files afterward.

The initial production paths are:

| Gatekeeper | Workshop binding | Public callback |
| --- | --- | --- |
| Google | `GATEKEEPER_GOOGLE` | `https://cfos.surprisingly.ltd/gatekeeper/google/oauth` |
| GitHub | `GATEKEEPER_GITHUB` | `https://cfos.surprisingly.ltd/gatekeeper/github/oauth` |

The Gatekeeper Workers remain private. Only the existing Router owns the hostname; its service
bindings proxy the callback paths through the same Cloudflare Access-protected origin.

## OAuth setup and authority review

- Create a Google Web Application OAuth client with the exact Google callback URI. Enable only the
  APIs intended for use: the package supports Gmail, Docs, Drive metadata, Sheets, Calendar, and
  BigQuery. Review the requested scopes before enabling their resource types in `/admin`; several
  permit writes, and Google testing mode requires explicit test users.
- Create a GitHub **OAuth App**, not a GitHub App. Set its homepage to
  `https://cfos.surprisingly.ltd` and its exact callback URI as above. A connection requests
  `repo read:user user:email`, so approval includes access to private repositories available to the
  connecting user.
- Keep Cloudflare Access as the deployment's sign-in method. Do not set `AUTH_GATEKEEPERS` merely to
  expose connectors; that allowlist is only needed for a separately reviewed change to Google or
  GitHub sign-in.

After confirming the target account and new Worker identities do not collide with existing
Workers, enter each `CLIENT_ID` and `CLIENT_SECRET` interactively with the project-pinned Wrangler:

```sh
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm exec wrangler secret put CLIENT_ID --name <google-worker>
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm exec wrangler secret put CLIENT_SECRET --name <google-worker>
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm exec wrangler secret put CLIENT_ID --name <github-worker>
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm exec wrangler secret put CLIENT_SECRET --name <github-worker>
```

Never place these values in `deployment.jsonc`, repository-local production environment files,
command arguments, logs, or chat. Each `secret put` creates a Worker version and is therefore part
of the approved production mutation, not a preparatory read-only step.

## Rollout and verification

1. Record the root/submodule commits, existing Worker versions, proposed Worker names, OAuth
   scopes, Gatekeeper policy, and rollback limitations. Run `pnpm check`.
2. After production approval, install the secrets and run `pnpm deploy`. Stop on the first failure
   and inventory which stages completed; the deployment is not atomic.
3. Verify Google and GitHub appear in `/admin`, enable only approved resources, and complete one
   low-risk connection through each OAuth flow. Confirm the callback stays on the Router origin,
   the Workshop bindings target `GatekeeperVendor`, and neither Gatekeeper has a workers.dev route
   or Preview URL.
4. Confirm an intended user can select a narrowly scoped resource, an unapproved resource remains
   unavailable, observations and mutations follow the expected approval policy, and removing a
   connected account revokes its usable session.

Rollback by removing the Workshop and Router bindings in a reviewed forward deployment, or by
restoring compatible prior Workshop and Router versions together. Preserve the Gatekeeper Workers,
their Durable Objects, OAuth grants, and secrets until retention and deletion are separately
approved; disabling a connector is not data deletion.

For each additional upstream Gatekeeper, repeat the package-specific review of credentials,
scopes, writes, observer policy, configurator build, HTTP requirements, Durable Object migrations,
and revocation behavior before adding it to the registry.
