# Chat video release — 2026-10-01

Status: validated; production deployment pending.

The user explicitly requested merging and deploying the video work. The release merges
`feat/chat-video` (which includes `feat/chat-video-next`) with current main, preserving
the adaptable blueprint changes. Merge base release: `b44e7356e64b039ff4fc0ed93ac596e5fef638e5`; merged fork: `a6afe79f94372743985ead2d244b62aba494c2ef`.
The fork's `starter-openrouter` branch contains the merged commit.

## Production target and configuration

- Account: `e1376e48400a20e631b61bbf16f555f1`.
- Public origin: https://cfos.surprisingly.ltd, owned by `cfos-router`.
- Existing Access issuer, audience, administrator policy, Worker names, service bindings,
  KV/R2 ownership, AI Gateway/model list and private error reporting are retained.
- Realtime SFU app: `7cbf75fcd65b93f51d3b70a13d79ed14`.
- TURN resource ID (public): `53a6b79d5195ee1d575fb46c58a8b65e`.
- Adopt the resources already configured in the video worktree for this requested release.
  These were also used for development checks; this release does not create a separate pair.
- Transfer the supplied credentials to encrypted `REALTIME_SFU_APP_SECRET` and
  `REALTIME_TURN_KEY_API_TOKEN` secrets on `cfos-chat`, without publishing their values.
  No new Realtime resources, Access policies, DNS changes or public backend routes are needed.
- Realtime traffic is billed to the existing account. Camera/microphone capture requires
  the user's pre-join action; recording and transcription are absent.
- Uncommitted marketing/mobile work in the main checkout is excluded from this release.

## Migration and mixed-version compatibility

Chat's application SQLite schema advances from 4 to 6: migration 5 adds call and participant
tables/indexes; migration 6 adds nullable `hand_at`. These are additive and leave existing
messages, channels, memberships and uploads intact. Durable Object classes and Wrangler
migration tags stay unchanged. The Chat tests cover the schema and call behavior with local
state; live migration of existing production state and signed-in two-user production behavior
remain to be verified after deployment.

The old Workshop and Router can continue binding the new Chat Worker during the serial
release: existing HTTP/RPC contracts remain available. The persistent frame is a frontend
change. Router uploads last after Workshop and Chat. Deployment is not atomic; stop on
the first failure and inventory which versions are live.

## Validation

- Merged Workshop frontend: 33 files, 202 tests passed.
- Chat Worker: 319 tests passed; Chat app: 532 tests passed.
- First full check: Work Board accessibility test exceeded 20 seconds while frontend tests
  ran concurrently. Isolated rerun: all 10 tests in that file passed in 10.10 seconds.
- The second full check passed the Work Board accessibility suite, then found a pre-existing
  Records Node test that assumed two requests happen within one millisecond. Stabilized that
  test with a mocked clock and explicit before/after-window assertions; its 10 tests passed.
- Supplied SFU session creation and TURN credential minting passed direct provider checks.
- Real-SFU smoke check: 44/44 passed with five fake-media Chromium participants, the last
  forced through TURN. Confirmed audio/video reception, simulcast, FEC/DTX, active speaker,
  camera off beyond 35 seconds and on again, ended-call history, DM ringing and two-way DM media.
  Ran against an isolated local Worker/database with the configured real Realtime resources;
  no production chat state was used. Test server stopped on completion.
- Final `pnpm check` passed: tests 292.2 s; build batches 66.5 s, 28.8 s and 1.9 s;
  all Worker dry-runs 35.5 s; total 428.6 s. Deployment-script type check passed separately.
- The additional repository-wide lint check fails on style diagnostics across existing
  blueprint/Records code and video source. No lint autofixes or rule changes were applied.
  `pnpm check` is the repository's documented production validation gate and passed.
- Deployed versions: pending.

## Worker versions and rollback

| Worker | Before release | Final version |
| --- | --- | --- |
| cfos-chat | 26aebd7f-3f24-4dcd-94e6-947f8dc2920e | pending |
| cfos-context | b67e7a64-8b69-443a-9804-8565b8f9a4f2 | pending |
| cfos-custom-gatekeeper | 3ed6eabc-8896-4aa0-8a85-0289fe5fff64 | pending |
| cfos-error-reporter | a96429ed-f4f6-40cf-9c0d-726ce640074b | pending |
| cfos-jev | 9dc2d382-6d2b-4477-a5eb-a267be787087 | pending |
| cfos-mermaid2 | 79c8c02a-812d-448a-94ac-eb9bf68eaafc | pending |
| cfos-notebook-python | 1f3ff63d-86d0-4aea-a7da-d4097aa51161 | pending |
| cfos-procgen | 3c764cdc-afd9-42ed-b133-0e5aeec87ef4 | pending |
| cfos-records | 128b2c36-8978-464b-b03e-e5d6cb6adb7c | pending |
| cfos-records-service | 1b018a02-f6b6-4fe7-9a83-a05a6aa01cc8 | pending |
| cfos-router | 75d77c92-022f-46ad-a989-a94d0046047b | pending |
| cfos-scheduler | ec6bfe9d-aeb9-481f-a746-ae568e5e0024 | pending |
| cfos-search | 642032cc-6697-4c45-9e20-4af2aa8a53f1 | pending |
| cfos-websearch | 8240729a-5c6e-41a8-b340-f142a221c70d | pending |
| cfos-workshop | 0857710c-471f-4df6-b037-c22666e81305 | pending |

Secret installation creates and deploys an intermediate Chat version with its existing
code; record it separately. Worker code rollback does not revert secrets or SQLite data.
The previous Chat code ignores the additive call tables/column. Calls can be disabled
through `chat.calls.enabled: false` followed by a reviewed deployment; tables remain.
Do not delete or downgrade data. An in-progress call may reconnect during a Chat deploy.

## Accessing calls

Open /chat (or /gatekeeper/chat/), select a channel, DM or group, and choose **Start call**
in the conversation header. Others choose **Join**. Calls support up to five people and
screen sharing; the same call persists across the full Chat page and sidebar.
App-specific calls requested separately by the user remain unimplemented.
