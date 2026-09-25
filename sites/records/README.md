# Records website

Product presentation for the standards-based app datastore: “Meaning first. Apps follow.”
The new service is a deployed alpha in `packages/records-service`; its complete pinned
Schema.org catalogue and model package live in `packages/records-model`. Production qualification
and full cloudflare-os enrollment/approval integration remain delivery gates.

The website itself uses static HTML, CSS and an illustrative browser demo. It needs no service
credentials, analytics, remote fonts or backend connection.

The homeserver service image bundles this website at `RECORDS_SITE_DIR=/opt/records/site` and
serves it on the same hostname as the `/v1/` API. Its public hostname is
`https://records.surprisingly.ltd/`. Rebuilding a Records release includes current website source;
there is no separate website deployment step for this topology. Standalone Wrangler hosting
remains optional.

```sh
pnpm --dir sites/records build
pnpm --dir sites/records preview
# http://127.0.0.1:4178
```

Use `pnpm --dir sites/records dev` to serve source files. `PORT=4180` overrides the port.
Deployable static output is `dist/`. No production deployment is performed by these commands.

- `/` — new product site; its explorer changes illustrative local browser state only.
- `/docs/getting-started.html` — runnable local service installation, Compose startup and first command.
- `/docs/` — implemented alpha contracts, models, module publication and remaining integration work.
- `/compare.html` — old and new sites side by side.
- `/previous.html` — historical site in a labelled frame.
- `/archive/` — preserved earlier product, v1, docs and separation pages. Their original wording,
  claims, external fonts and incomplete links remain for comparison. They are superseded.
- `/architecture-plan.md` — the detailed architecture direction copied into the build.

The archived product is the page containing “What changes when you use Records”. Its original is
also preserved under `/tmp/claude-1000/-var-web-cloudflare-os-starter/d148eb28-e4e3-4c59-91ed-2ff7500746fa/scratchpad/`.
The earlier Records runtime remains separate; this site does not imply a production cutover.

Executable examples cover work items, messaging and a custom inventory module. The catalogue
contains all 3,026 Schema.org terms in the pinned 30.1 release; catalogue breadth is different from
implemented workflow coverage. Richer project/channel profiles are labelled examples. The local
TypeScript client and administration scripts are repository tools, not published SDK releases.

Source of truth: [Records direction](../../docs/plans/external_datastores/records-direction.md).
Current delivery evidence belongs in the linked plan and service documentation. Earlier responsive
and interaction checks validate the static website only; backend tests and local restore evidence
are reported separately.
# Cloudflare deployment

`wrangler.jsonc` supplies a static-assets deployment with workers.dev and preview URLs disabled.
Build with `node sites/records/scripts/build.mjs` from the repository root, then validate with
`pnpm exec wrangler deploy --dry-run --config sites/records/wrangler.jsonc`. This passed with
Wrangler 4.124.0. Set the reviewed account and hostname before a live deployment; see
[the Records launch checklist](../../docs/plans/external_datastores/records-launch.md).
The build includes both the new website and the untouched historical comparison.
