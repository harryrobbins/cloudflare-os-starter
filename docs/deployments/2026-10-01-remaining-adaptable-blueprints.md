# Remaining adaptable blueprints release — 1 October 2026

Outcome: Workshop deployed and its active version verified at 100%. Public paths
`/`, `/api/` and `/admin` return 302 to the existing Access issuer when checked with
curl. Signed-in Workshop UI, real connector data and gadget creation remain unverified.

## Scope

Production continuation, Workshop-only release to `https://cfos.surprisingly.ltd` in
account `e1376e48400a20e631b61bbf16f555f1`. Only `cfos-workshop` is updated.

- Migration commit: `fbcdd7f`.
- Final code and model-validation commit: `3dd8686ebdadba01f3d9240af0ffac582fb40eac`.
- Submodule: `ec9847d85d4c422012ad79e71a20e081199121de`, unchanged.
- Operator explicitly requested commit and deployment and authorized gadget code to
  DeepSeek Flash. Existing production configuration supplies the target and policies.
- Access issuer remains `https://surprisingly-pages.cloudflareaccess.com`; the existing
  audience and administrator policy are unchanged.
- Existing OpenRouter AI Gateway, private Reporter, observability and Gatekeeper modes
  are unchanged. No resource provisioning, secret, DNS, Access or storage-schema change.
- Other session's mobile/chat plans are excluded from the commits.

| Format | Previous revision | Released revision |
| --- | --- | --- |
| Board | 6 | 7 |
| Arcade | 1 | 2 |
| Network Map | 1 | 2 |
| MermaiD2 | 2 | 3 |
| Data Explorer | 7 | 8 |
| Tessera | 4 | 5 |
| Notebook | 13 | 14 |
| Records Explorer | 2 | 3 |
| Project Board | 1 | 2 |
| Project Report | 1 | 2 |
| Work Board | 3 | 4 |

Wave, Docs with Drawings and default Workspace Docs/Sheets/Slides are unchanged, as are
the already migrated Whiteboard and Ranked Vote pilots. Existing gadget copies keep
their code; these revisions apply when the Workshop installs blueprints and users
create new copies.

## Validation

- All 33 reference evals pass against the final packed archives. All documented RPC
  examples run with deterministic connector fixtures. Evals are never shipped in gadgets.
- DeepSeek Flash initially passed 31/33. Project Report's adapt output contained two
  correct status messages; the eval falsely rejected the duplicated text. After fixing
  that selector, the reference and three fresh model adaptation runs passed. Coverage
  is 32/33 eval scenarios, with one genuine model miss: Records Explorer stored the
  requested columns but did not select the requested Records tab. No library files
  were read or edited by the model runs.
- Shared adapter, entry builder and eval tooling tests: 37/37 passed before release.
- Board browser tests 20/20; Arcade 7/7; Network Map 29/29; Tessera 8/8;
  MermaiD2 real-renderer sandbox tests 3/3.
- Work Board browser tests passed 30/32. Both failures reproduce with the pre-migration
  committed client: the offline Retry button detaches during automatic recovery and
  the filter timing exceeds its 50 ms threshold. Tests were not weakened.
- Initial canonical check stopped on Arcade's archive consistency check. Its server
  library lacked a fixed esbuild working directory. Corrected the build, verified
  identical output from root/package directories, and repacked at the intended revision 2.
- Package README files record model results and the remaining live verification limit.

- Final `pnpm run check --workshop-only` passed: uncached tests 356.0 s, builds
  83.8/33.1/1.8 s, Workshop dry-run 13.7 s, total 492.5 s. No validation was skipped.

## Rollback limits

The last-known-good Workshop version is `630e32d2-4878-4ad7-ad9d-d8d0ecfbe08e`.
Rollback only `cfos-workshop` to that version if needed. It already supports split
client/server libraries. Installed blueprint revision records and archive content in
KV/R2 do not roll back with a Worker version, and created gadget copies retain their
code. Reverting installed blueprints requires a separate revisioned format release.

## Deployment and live verification

| Worker | Before | After |
| --- | --- | --- |
| cfos-workshop | 630e32d2-4878-4ad7-ad9d-d8d0ecfbe08e | 0857710c-471f-4df6-b037-c22666e81305 |

- Deployment ID: `bd7c91c7-9b7a-49ac-8ac1-75e0536a5803`, created
  `2026-10-01T11:52:54.105102Z`, active at 100%.
- `pnpm run deploy --workshop-only` passed: builds 81.3/32.8/1.6 s,
  Workshop upload/deployment 24.1 s, total 143.5 s.
- Version metadata before/after confirms every binding identity is preserved,
  including all service/entrypoint pairs and existing storage:
  - `BLUEPRINTS`: KV `195bd91c4e3d4e698e51c8f5fa409468`.
  - `AVATARS`: KV `f4bf93d1d5de462ab8b8ed7583a7c050`.
  - `BLUEPRINT_CONTENT`: R2 `cfos-workshop-blueprint-content`.
- Worker runtime configuration is identical before/after. Generated configuration
  retains `workers_dev: false` and `preview_urls: false`.
- curl checks confirm the three public paths redirect to
  `https://surprisingly-pages.cloudflareaccess.com`. An initial Python urllib probe
  returned 403; curl succeeded on all three paths. No authenticated browser session
  was available, so no signed-in success is claimed.
- Temporary generated Wrangler configs were removed by the deployment wrapper.
- Commits are local; no Git push was requested or performed.
