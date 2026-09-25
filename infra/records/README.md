# Records infrastructure

This module creates an isolated origin boundary for the new Records service. It does not modify
the existing cloudflare-os application, its Workers, its database or its Access policies.
This optional module has not been applied. The current deployment uses the owner-supplied tunnel
on `ms` at https://records.surprisingly.ltd; see [homeserver topology](HOMESERVER.md). Do not create
a duplicate tunnel or overwrite its routes by applying this example blindly.

## Ownership

| Component | Source of truth |
| --- | --- |
| Postgres, PostgREST, gateway image and optional tunnel connector | `packages/records-service/deploy/` |
| Named Tunnel, ingress, origin Access application/policy, origin DNS | This OpenTofu module |
| HTTP edge Worker and bindings | `packages/records-edge/wrangler.jsonc` |
| Product website, including historical comparison | `sites/records/wrangler.jsonc` |
| Host provisioning, disk, firewall, backup destination | Pending host/provider selection |
| Credentials | Operator secret store; references only in code |

Use Wrangler for code deployment and OpenTofu for these network resources. Do not manage the same
DNS record or Access application in both tools. Provider version is pinned; commit the generated
provider lockfile. Review provider upgrades separately.

## Prepare and review

Requires OpenTofu 1.8+ (validated with 1.12.1). Set the provider's `CLOUDFLARE_API_TOKEN` using an
operator credential mechanism with Tunnel edit, Access applications/policies edit, and zone DNS edit
limited to the target account/zone. A Wrangler login does not automatically authenticate OpenTofu.
An Access service token authorizes requests to an application; it cannot provision infrastructure.

Provide these nonsecret inputs in an ignored `staging.tfvars` or a protected CI variable set:

```hcl
account_id              = "<reviewed-account-id>"
zone_id                 = "<reviewed-zone-id>"
name                    = "records-staging"
origin_hostname         = "records-origin-staging.example.com"
access_team_name        = "<team-subdomain>"
origin_service_token_id = "<dedicated-token-resource-uuid>"
```

The service token must already exist. This module references its resource UUID, not its client ID
or secret, so token secrets are not introduced into state. Install its client ID and secret on
the edge Worker separately. Use a different token for external staging testers.

```sh
tofu -chdir=infra/records init -backend=false
tofu -chdir=infra/records validate
tofu -chdir=infra/records test
tofu -chdir=infra/records plan -var-file=staging.tfvars -out=staging.tfplan
```

Initialisation, validation and mock-provider tests are local preparation. Planning reads remote
state; applying changes it. Provider validation and both security tests pass on OpenTofu 1.12.1.
Before a shared deployment, configure an encrypted remote state backend with locking and restricted
access, then initialise that backend. Local state/plan files are ignored and must remain protected.
No credentials or tunnel tokens are outputs of this module.

Inventory hostname, policy and tunnel-name collisions before applying. Never import or replace an
existing resource without checking its owner. Review the plan: four new resources, no existing OS
changes. All resources have `prevent_destroy`; this is an additional guard, not a backup or a ban
on in-place changes. Save approved inputs and the sanitized plan summary in the deployment record.

## Bring up and verify

After the approved plan is applied, obtain the named tunnel's connector token through the operator
secret store and mount it as the Compose tunnel token file. Do not paste it into a command line.
Tunnel configuration is remote: one exact origin hostname routes to `http://gateway:8788`, followed
by a 404 catch-all. Cloudflared also verifies the Access application audience on incoming requests.
Only the tunnel sidecar needs outbound Internet connectivity. No inbound Postgres/PostgREST port
is exposed; any localhost gateway listener is for host operators only.

Deploy the edge with its exact reviewed hostname and `RECORDS_ORIGIN` pointing at the output URL.
Keep workers.dev and preview URLs disabled. For staging, protect the edge hostname with a separate
Access application before routing traffic to it; that application and its intended testers must
be included in the concrete launch plan. This origin module does not silently invent that policy.

Verify anonymous origin denial; correct edge service token admission; invalid Records credential
denial; scoped read/write success; cross-datastore denial; SSE delivery and recovery; and persistence
after a controlled process restart. A healthy process alone is insufficient.

Rollback: retain the previous image digest, Worker version and schema version. Revert compatible
application code only; database changes and external resources do not roll back with a Worker.
Never use `tofu destroy` or `docker compose down -v` as rollback. Restore rehearsals, retention,
off-host encrypted backups and recovery objectives must be agreed before production data.

References: [Cloudflare Tunnel IaC](https://developers.cloudflare.com/tunnel/guides/terraform/),
[pinned provider resource definitions](https://github.com/cloudflare/terraform-provider-cloudflare/tree/v5.24.0/docs/resources).
