# Homeserver Records deployment

Authorised target: `ms:~/containers/records`, user `harry` (UID 1000). This deployment is independent
of the earlier local evaluation stack and every other application on the host. The task used the
existing ai-proxy deployment skill as a convention reference: scope all commands to this stack,
keep secrets outside source, use `compose up -d` and verify health after deployment.

## Deployed release, 2026-09-25

- Release: `5f5b1702ae22252b617003bfa14c940d4fe446fa5532b01b56e239de34f5bae8`
- Source archive SHA-256: `1c5f181ab1bdf461d28087f27363af00bd25716d12aada8cf1eb8c9ab232bc06`
- Built image ID: `sha256:a9adeef061f28298f878dbfd0d77cc0ee80581b463d6977c57621a8b50b115de`
- Source snapshot: 81 files, each hashed in `release.json`. No root repository commit was made;
  unrelated dirty work, node_modules, local fixture credentials and .git were not transferred.
- Persistent database volume: `records-server_records-data`.
- Gateway listener: `127.0.0.1:8789`; database and PostgREST have no public host ports.
- Private networks: database `10.214.1.0/24`, ingress `10.214.2.0/24`.

Preflight verified the target absent, port 8789 unused, host UID 1000 and about 630 GB free.
Docker's automatic pool was exhausted. Existing networks and routes were inspected; the two
explicit subnets were unused. Only the new, empty Records network from the failed first attempt
was removed and recreated. No other stack or host Docker address-pool configuration was changed.

The server built the image from the verified source archive. Secrets were generated on that host
using the new image, never copied from local fixtures: directory mode 0700, secret files mode 0600,
owner `harry`. Root `.env` is mode 0600 and contains nonsecret image/path settings; actual application
secrets live under `secrets/`. The user-supplied tunnel token was subsequently installed separately by the root agent. The
remotely managed tunnel is running as `0aa965d9-bc89-44a0-9342-21d728f486d6`. This agent did not
create DNS/Access resources. Public-hostname validation remains separate from tunnel connectivity.

Verification: DB and gateway healthy; private PostgREST running; work-profile and Schema.org Project
routes return valid definitions; migration ledger contains six entries; datastore count is zero.
This proves startup and schema installation, not a production application workload or recovery SLA.

## Release and operate

```sh
node packages/records-service/deploy/package-release.ts /tmp/records-release-output
# Pass the exact generated archive, then retain its manifest/checksum in the deployment record.
packages/records-service/deploy/deploy-homeserver.sh /absolute/path/records-RELEASE.tar.gz

ssh ms 'cd ~/containers/records && ./compose ps'
ssh ms 'curl --fail --silent http://127.0.0.1:8789/healthz'
```

The deploy script verifies archive/file checksums, builds a release-tagged image, retains existing
host secrets, applies only this project's Compose stack and switches `current` after health passes.
`releases/` keeps prior snapshots and each successful release records its image ID. `incoming/`
contains source archives; secrets never belong there. `./compose` is a scoped wrapper for the base
and homeserver overlays; it also includes the tunnel overlay when the host token file exists.

When the authorised tunnel token is supplied, the separate token installer sends only that value
into `secrets/tunnel_token`; the tunnel overlay runs UID 1000 so it can read the private file. The
reviewed remotely managed tunnel origin is `http://gateway:8788`. Hostname/DNS/Access management is
separate and must match that tunnel; neither release packaging nor base deployment mutates it.

For future releases, review and back up first. Schema migrations are forward-only; retaining an old
image does not reconcile new writes. A failed application update needs a reviewed schema/data
rollback or forward fix. Do not use `docker system prune`, global restart commands or unscoped
network removal. Backups, restore objectives, remote access policy and monitoring remain required
operational work; this file does not assert those are complete.

The final release includes the gateway streaming-error fix. Its redeployment preserved the database,
PostgREST and running tunnel, reapplied migrations idempotently, and replaced only the migration job
and gateway. The gateway and database were healthy after the update.

The website-serving fix packages the product site into the application image. Verification on the
host returned HTML 200 for `/`, `/docs/`, `/compare.html` and the archived prior product; API model
metadata still returns JSON 200. `/docs?from=site` redirects 308 to `/docs/?from=site`, preserving
relative documentation links and the query. CSS, JavaScript and the architecture-plan download were
also verified. Tunnel and database containers were retained during the application update.

Root-agent external verification at `https://records.surprisingly.ltd` also passed: website, docs,
comparison, archive, assets and model API returned 200; a datastore request without credentials
returned 401. Browser checks covered 12 routes at three viewport sizes without horizontal overflow
or JavaScript errors. Demo actions passed and the historical comparison remained available.

The documentation refresh published `/docs/blueprints.html`, `/blueprint-adaptation-plan.md` and
`/explorer-blueprint-plan.md`; all returned 200 with correct HTML/Markdown types both on the host
and through `https://records.surprisingly.ltd`. Root and the model API still returned 200. This
release publishes plans only; no new explorer or adapted blueprint implementation was deployed.
Root-agent external verification independently confirmed the blueprint and hosting documentation
pages return HTML 200 and both plan downloads return Markdown 200.
