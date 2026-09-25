# Whiteboard revision 8 deployment

Requested by the operator in this session after reviewing the implementation and packaged revision. Production continuation, scoped to the Workshop Worker that carries the bundled formats.

## Inventory

- Account: `e1376e48400a20e631b61bbf16f555f1` (Wrangler OAuth account verified).
- Origin: `https://cfos.surprisingly.ltd`.
- Root commit: `1343158e089dba6329cc89a3ece622eb82c2cc2f`, plus the reviewed whiteboard worktree changes.
- Pinned and checked-out submodule: `0bef28699669a02fa9bfa145789b157814cc7830`; no tracked changes.
- Worker to update: `cfos-workshop` only; router and Gatekeepers remain on their existing deployments.
- Previous active Workshop version: `15cf899f-249c-41bc-a292-b53afbb47f4a`, deployed at 2026-09-25T16:52:01Z.
- Previous installed `format.whiteboard`: version 7, confirmed by remote KV read.
- Existing BLUEPRINTS KV: `195bd91c4e3d4e698e51c8f5fa409468`; AVATARS KV: `f4bf93d1d5de462ab8b8ed7583a7c050`; blueprint R2 bucket: `cfos-workshop-blueprint-content`. No new resource intended.
- Access issuer: `https://surprisingly-pages.cloudflareaccess.com`; audience and administrator list unchanged from `deployment.jsonc` and the live version. No Access/DNS changes.
- AI: existing `cfos-gateway`, OpenRouter catalog unchanged. Reporter enabled, production environment; invocation logs and traces remain disabled. Existing service bindings unchanged.
- Current migration tag `v2`, compatibility date and flags unchanged. Whiteboard stored schema remains 1.

## Validation

The first two full checks failed on the Search app's fixed-delay back/forward test. Its isolated run passed; the test used a 10 ms delay to assert an asynchronous result. Replaced that single assertion with a bounded `vi.waitFor` that flushes React and waits for the actual result. No Search runtime change. The isolated 9-test suite passed after the fix.

Final full-check, deployment and verification results are recorded below once available.

## Rollback boundary

The previous Workshop version is recorded above. Worker rollback changes code, not stored board data or KV/R2 state. Bundled formats are installed on API traffic; verify the metadata and archive after any rollback. Existing whiteboards keep their copied code, so neither this deployment nor a Worker rollback automatically upgrades or downgrades their app code. No storage migration or destructive operation is part of this update.

A subsequent full run reached the Whiteboard suite and timed out the exhaustive Bézier-flattening fixture at its default 5-second limit under concurrent workspace load. Kept every curve and all 2,000 samples per curve, aggregating their maximum distance before asserting the same tolerance instead of constructing about 180,000 assertion wrappers. No runtime geometry, sample coverage, tolerance or performance budget was changed.

Added `--workshop-only` to the existing deployment wrapper, with a deployment-target regression test and README usage, so this release follows the normal configuration/build/cleanup path without redeploying unrelated Workers. Default deploy order is unchanged. This mode retains all tests/builds when used with `release`; dependency existence and compatibility are prerequisites, verified for this deployment.

Final `pnpm check` passed: tests 126.4 s; build batches 61.6 s, 27.1 s and 1.7 s; all Worker dry-runs 25.0 s; total 245.9 s. The subsequently added deployment scope passed `node --test scripts/deploy.test.ts` and `pnpm types:scripts`. Production command: `pnpm run deploy --workshop-only`.

Release archive SHA-256: `ee98094e4e1a0f19214b436c24ad8276d80a355dfe482c9e817a7d2d523ef940`.

## Result

Deployed successfully at 2026-09-25T19:03:34Z.

- Workshop version: `f4b20a88-53ef-45ca-bacb-325ee27dee13`.
- Deployment: `a4e8257a-a0fe-4c62-adf8-afaa6f5ad5fc`, 100% traffic confirmed by `wrangler deployments list --json`.
- Only `cfos-workshop` uploaded; existing private Worker has no public route/preview target. Wrapper cleaned all generated production configs.
- Public hostname returns HTTP 302 to the existing `surprisingly-pages.cloudflareaccess.com` login.
- The bundled installer normally runs on the next `/api` visit. A temporary loopback-only Wrangler client used a remote service binding to invoke that normal bootstrap without a user identity or board RPC. Backend correctly returned HTTP 403 for the identity-free request; the installer runs before authentication. No production service binding, Access rule or public endpoint was added. The temporary client was stopped after verification.
- Remote BLUEPRINTS metadata now reports whiteboard version **8**.
- Downloaded `cfos-workshop-blueprint-content/format.whiteboard/8` from R2. Its compressed code snapshot SHA-256 is `b208a576b64bcfeb57a5b217471a3c533be410679406dc634cf5414c5fab69c1`, exactly matching the tested local archive's content section.
- No production user board was created or edited. Authenticated browser interaction, administrator/non-administrator policy checks and screen-reader testing were not repeated in production. Local browser coverage is recorded in the flagship workplan.

New whiteboards receive revision 8. Existing whiteboards retain their copied application code and were not upgraded by this release.

Reference for verification transport: [Cloudflare supported remote service bindings](https://developers.cloudflare.com/workers/local-development/bindings-per-env/). The production command uses the repository wrapper and its generated configurations; no generated config was deployed manually.
