# Mobile Chat production release — 1 October 2026

Outcome: all 15 configured Workers deployed and their live versions verified at 100%.
Live TLS and unauthenticated Access protection verified; signed-in production and
physical-device qualification remain open.

## Scope and authority

The user requested research, a skill, a plan, worktree implementation, merge to main and
production deployment including other repository changes. The worktree branch was
`feat/mobile-chat`; mobile commit `ca4a261`, existing Records documentation `fa80967`,
and merged production source `30fe643529964ae1819a3e2d025ff6852779401c`. The pinned submodule is `0bef28699669a02fa9bfa145789b157814cc7830`.

Target: `cfos.surprisingly.ltd`, account `e1376e48400a20e631b61bbf16f555f1`.
Pinned Wrangler 4.124.0 (starter), 4.120.0 (upstream), pnpm 11.17.0, Go 1.26.5
and Node 24.19.0 were used. Wrangler whoami matched the account.
Access issuer/audience and administrator configuration are the existing deployment.jsonc
values. No Access/DNS policy, identity, secret, migration or storage ownership change was
introduced by the mobile implementation. Existing bindings and automatically adopted
KV/R2 resources remain under their existing Worker identities. Full release updates all
15 configured Workers serially, Router last.

AI remains OpenRouter BYOK via cfos-gateway with the existing four-model allow-list.
Reporter is private and enabled in production. Observability remains logs enabled,
invocation logs off, traces off. Gatekeeper configuration and administrator provisioning
choices are preserved; runtime administrator settings were not independently inspected.

## Local evidence

- Chat backend: 281 tests; frontend: 281 tests. New regressions cover draft suspension,
  old socket events/network recovery and conditional permalink shell responses.
- Both chat TypeScript projects and production asset build passed.
- Chromium real-local-Worker mobile integration passed: 320/390/430px portrait, 844px
  landscape, send/newline/IME, thread/Back, draft reload, 44px touch actions, drawer,
  simulated keyboard viewport, install metadata/icons/script, offline navigation,
  compact and desktop presentations. Phone screenshot reviewed.
- WebKit could not launch because required system libraries are absent. Actual device
  installation, keyboards, Access session expiry and Wi-Fi/cellular tests remain open.
- New mobile files pass targeted lint. Repository-wide lint fails on pre-existing errors
  across unrelated packages; the canonical release's tests/builds/dry-runs are separate.
- Skill frontmatter/name validator passed; activation/exclusion and smoke prompt are in
  the skill and plan. No optional metadata or additional capabilities were introduced.
- Before deployment all six unauthenticated probes (root, Chat, manifest, service worker,
  API and admin) returned 302 to the existing Access issuer over valid TLS.

## Previous production versions

| Worker | Previous version |
| --- | --- |
| cfos-error-reporter | e0dddb46-0773-4737-8fdf-80f866052695 |
| cfos-context | 1ed6f23e-a007-4b6c-ada5-f8d50063fe2d |
| cfos-scheduler | 1e5c71ff-89b3-4577-86e3-1bd3d0355d62 |
| cfos-procgen | e7082117-09fb-4810-a7a4-f0cee89897e7 |
| cfos-mermaid2 | 39003241-92a5-42e7-a30b-694d003118f1 |
| cfos-custom-gatekeeper | 6947936f-e332-4414-900c-a4ee662993c1 |
| cfos-notebook-python | 68e8cca4-4fb7-48a0-acb1-80cc5b0d5e56 |
| cfos-websearch | b12b4a54-501b-4f51-9d2b-fa9b5f4c5001 |
| cfos-records | 0f4a3466-ee07-4bbd-ac74-0a0ac2114384 |
| cfos-jev | 13f185b1-6ce0-4b87-a557-c3621dfa0ee3 |
| cfos-records-service | f040cb8c-a53f-42e6-b52b-eb68355edce6 |
| cfos-search | 67d9c211-9d77-474e-9e5c-9b4cd4d6d33a |
| cfos-workshop | 6dcab00c-51a8-436a-b1c4-ec4de6b62a68 |
| cfos-chat | dc93d181-ba76-49d1-b9fb-f563794d8b8d |
| cfos-router | 9781ece4-eb9f-480d-85d8-53f3c8ef1df8 |

## Recovery limits

The release is not atomic. On a stage failure stop, preserve successful version IDs and
compare actual remote state before retrying. A compatible Worker version rollback does
not roll back data, secrets, Access or DNS; no storage deletion/downgrade is a recovery
step. The mobile backend fix is backward compatible. The navigation-only service worker
caches no content; rolling back does not uninstall existing home-screen shortcuts.

## Validation interruption and correction

The first canonical release stopped in tests before all uploads. Two Whiteboard tests hit
Vitest's 5s runner timeout; the isolated adversarial lexer finished in 6.3s under its own
15s acceptance assertion. Full concurrency also starved a serialization test. Worktree
commit `2585b27` caps Whiteboard at four test workers and gives the two large simulations
20s runner headroom, retaining all traffic/work/time assertions. All 672 Node plus 21
workerd Whiteboard tests passed. This was merged into main at `65374b7` before restarting
the canonical release. No production stage was retried after partial mutation.

## Release result

Canonical `pnpm release` validation passed on the merged `e092e9a` source: all tests,
fresh builds and all generated Worker dry-runs. Docs was additionally rechecked after
the concurrent Whiteboard merge because its earlier test run preceded that merge.

A daemon restart killed the earlier attempt before uploads. A concurrent deployment
then completed in the main checkout, after which this task uploaded Reporter but stopped
at Context when its generated config was absent. Remote versions were inventoried before
any retry. Production completion moved to a dedicated worktree with frozen, offline
installed dependencies, so its generated configs could not race with main.

That clean worktree exposed optional Go VCS stamping inspecting `/tmp` instead of the
linked repository. Commit `30fe643` disables stamping for the embedded converter,
example generation and dependency-notice commands. Converter builds and MermaiD2 tests
passed there. The flag is documented in [Go build flags](https://pkg.go.dev/cmd/go#hdr-Compile_packages_and_dependencies);
Git provenance is independently recorded here. No functional converter change is claimed.

The direct `pnpm deploy` path was then used with the existing full validation evidence
and verified build correction. It built fresh in the isolated worktree and uploaded
serially, Router last. All 15 deployed version IDs were compared with the live deployment
API and matched at 100%. No new resource identities, migrations or secrets were introduced.

Timings: full release validation tests 392.3s; builds 72.3/29.8/1.6s; dry-runs 31.8s.
Final isolated deploy: builds 67.8/27.2/1.9s; serial uploads 232.0s; total 336.1s.

The ten Chat assets were read from the freshly built app/dist. This release supersedes
the Worker versions in [the Whiteboard release note](2026-10-01-whiteboard-revision-10.md)
and includes Whiteboard rev 10 and Docs with Drawings rev 2.


## Final live versions and immediate rollback references

| Worker | Before isolated completion | Final version |
| --- | --- | --- |
| cfos-error-reporter | 3ef5b9ab-cb0b-4e98-96a3-0cfdbf047e65 | a96429ed-f4f6-40cf-9c0d-726ce640074b |
| cfos-context | db6e0022-9fe3-4664-987e-f30d7ecb34d4 | b67e7a64-8b69-443a-9804-8565b8f9a4f2 |
| cfos-scheduler | e432485c-645f-4901-8e5f-8bf57435873a | ec6bfe9d-aeb9-481f-a746-ae568e5e0024 |
| cfos-procgen | f8c722e4-a7ab-4c4c-bb13-e014c1751683 | 3c764cdc-afd9-42ed-b133-0e5aeec87ef4 |
| cfos-mermaid2 | 2f134f89-f296-46b5-8abc-cbab505e4516 | 79c8c02a-812d-448a-94ac-eb9bf68eaafc |
| cfos-custom-gatekeeper | bf828610-8250-40e8-a2d3-8a1278a40078 | 3ed6eabc-8896-4aa0-8a85-0289fe5fff64 |
| cfos-notebook-python | d6ea131e-bce2-4c73-9f68-39945bdace49 | 1f3ff63d-86d0-4aea-a7da-d4097aa51161 |
| cfos-websearch | e7ce400b-4342-46c5-8fa4-b94fa3e0945d | 8240729a-5c6e-41a8-b340-f142a221c70d |
| cfos-records | 5b2244d1-95bf-468d-bc26-742dd8f7ff18 | 128b2c36-8978-464b-b03e-e5d6cb6adb7c |
| cfos-jev | 6fe1d9bf-abef-471c-8253-62a22d8319e1 | 9dc2d382-6d2b-4477-a5eb-a267be787087 |
| cfos-records-service | b0e69e26-d330-4562-b094-97ea46d4038a | 1b018a02-f6b6-4fe7-9a83-a05a6aa01cc8 |
| cfos-search | fd34623d-cec7-4713-8406-166ce704d133 | 642032cc-6697-4c45-9e20-4af2aa8a53f1 |
| cfos-workshop | 4228868f-d17c-4a53-99fd-a8c6d29887ac | 453c3057-07a4-40bd-91c2-1df363986740 |
| cfos-chat | 6284431a-b9b3-420f-8765-8b61b89d820c | 26aebd7f-3f24-4dcd-94e6-947f8dc2920e |
| cfos-router | 638af068-3a7d-40c9-837e-51cda1ac55b2 | 75d77c92-022f-46ad-a989-a94d0046047b |

Router deployment completed at 2026-10-01T00:12:25.440277Z (UTC).

## Live evidence and limits

After deployment, `/`, `/gatekeeper/chat/`, its manifest and service-worker URL, `/api/`
and `/admin` all returned 302 to `surprisingly-pages.cloudflareaccess.com` with valid TLS.
All final Worker versions matched the deployment log. The configured backend workers
retain private bindings/routes; the release changed no Access population or policies.
The generated configs were removed on completion. Tracked source and submodule remained
clean after removing a generated type-file comment that only recorded the temporary path.

No authenticated production browser session was available. Signed-in Chat, admin
positive/negative identities, existing-data read/write, agent billing/runtime, schedules,
new format creation and real-device PWA session renewal were not independently rechecked.
These are limitations of live verification, not claims that unit tests prove them.
Closed-app push and offline message history/outbox remain unimplemented. The phone trial
and Slack-replacement qualification gates are in the research and delivery plan.
