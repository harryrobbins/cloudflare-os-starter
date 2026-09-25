# Records launch preparation

Status: owner authorised an isolated homeserver deployment at `ms:~/containers/records`.
Base services and the supplied-token cloudflared connector are running at
`https://records.surprisingly.ltd/`. Website, docs, comparison and public API metadata pass remote
HTTPS checks; unauthenticated datastore access returns 401. See the
[deployment record](../../../packages/records-service/deploy/homeserver.md).

The selected runtime is Postgres + PostgREST + Node gateway/notification relay. Wrangler deploys
the edge Worker and static product website. It does not provision the persistent server in this
reference architecture. The new deployment remains separate from the current OS Records worker
and Neon database.

## What is already available

- Wrangler 4.124.0 is authenticated to the account configured in `deployment.jsonc`.
- Root commit `1343158e089dba6329cc89a3ece622eb82c2cc2f`; upstream pinned and checked out at
  `0bef28699669a02fa9bfa145789b157814cc7830`. The Records changes are currently uncommitted.
- Local service, real database tests, model publication, scoped API and notification tests.
- [Infrastructure sources](../../../infra/records/README.md) and a separate container deployment.
- Both product websites remain available in one static build, with the comparison page intact.

## Inputs needed for a real launch

1. Host chosen: `ms` (`mini-harry`), user `harry`, project `~/containers/records`.
   Start with isolated staging and synthetic data; a single host is not high availability.
2. Exact edge, origin and website hostnames, and whether the website should be public or protected.
3. Intended staging testers and Access policy; a dedicated edge-to-origin service token, distinct
   from tester credentials. Supply secret material via the operator's secret store, not chat.
4. Before production: backup destination, retention, recovery time/data-loss targets and operator.

Existing Cloudflare account selection is known. Do not request another Workers API token merely
to use Wrangler. OpenTofu needs its own provider authentication if the existing operator environment
does not already supply a suitably scoped API token. Remote host access also needs to be available
through the approved operator mechanism.

## Launch sequence

- [x] Choose homeserver; verify new project path, available port and Docker/Compose.
- [x] Owner published records.surprisingly.ltd; verify it reaches the selected gateway.
- [x] Validate edge/website dry-runs and IaC provider schema plus mock security tests.
- [x] Validate standalone container build and isolated startup.
- [ ] Prepare encrypted/locked IaC state and review a concrete infrastructure plan.
- [x] Build/tag an immutable image and record digest; generate file secrets on the homeserver.
- [x] Initialise an empty isolated database and install bundled module profiles; no demo grants.
- [x] Install the supplied tunnel token separately and start the connector; four connections observed.
- [ ] Provision a scoped staging credential for remote authenticated smoke checks.
- [ ] Apply reviewed Tunnel/Access/DNS plan; verify direct origin denial.
- [x] Serve the bundled website and API through the homeserver tunnel; preserve old site comparison.
  The separate edge Worker is optional and has not been deployed.
- [ ] Test authenticated API, cross-tenant denials, approval integration and stream recovery remotely.
- [ ] Record image/Worker versions, resource IDs, schema versions and rollback evidence.
- [ ] Complete production qualification and approve any existing-data cutover separately.

The complete OS deploy script currently includes legacy Records and many unrelated Workers.
Do not run it to launch this standalone service. No host, route or resource name is inferred from
the existing production hostname. Preparation proceeds while these choices are outstanding.
