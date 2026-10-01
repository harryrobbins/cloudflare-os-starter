# blueprint-ranked-vote

Source of the **Ranked Vote** format (`format.ranked-vote`). A group proposes options, and each option carries fields: a Description, plus any the group adds, such as Proposed URL or Companies House check. Everyone privately drags every option into their own order. When all voters have clicked Reveal, a single-winner single transferable vote (instant-runoff) count runs, and everyone sees it round by round. The user guide and RPC reference is [`src/README.md`](src/README.md), which ships inside the gadget.

## Layout

| Path | What |
| --- | --- |
| `src/shared/count.js` | The instant-runoff count: pure, with the tie-break rules documented |
| `src/core/vote.js` | Vote rules: options, fields, ballots, Reveal, minimum voters, reopen, per-viewer views |
| `src/core/store.js` | Persistence behind a small repository seam, serialised writes, per-viewer push to subscribers |
| `src/server/index.js` | The `Gadget` Durable Object and `ExportHandler` (Markdown summary) |
| `src/client/` | Plain-DOM UI (`app.js`), connection and recovery (`main.js`), CSS (`styles.js`) |
| `harness/` | Three panes (`?names=Alice,Bob,Cara`) running the real client over the real rules |
| `e2e/harness.test.mjs` | Playwright over the harness: the whole flow, plus recovery from a dead stub |

## Commands

Run these from this directory, with node from fnm (`fnm use v24.21.0`).

```sh
pnpm test:run                          # node tests (count, rules, store) + workerd tests (Durable Object)
pnpm pack:gadget                       # build dist/, write formats/ranked-vote.gadget (bumps revision on change)
node scripts/build.mjs && pnpm test:e2e  # harness end-to-end
pnpm harness                           # serve the harness at http://127.0.0.1:8790/harness/
```

The `test` task run by `pnpm check` rebuilds `dist/` and fails when `formats/ranked-vote.gadget` is stale. **Run `pack:gadget` and commit the archive with every source change.** Never change `blueprintId`.

## Design notes

- **Secrecy.** A viewer is only ever sent their own ballot. Before and after the count, others see only who has a ballot and who is ready. The server takes the caller's identity from RPC arguments, as every format here does (see "Trust limits" in `docs/plans/collaborative-blueprints.md`). Secrecy therefore holds for honest clients only.
- **Everyone who has ranked must Reveal.** A voter is anyone with a saved ballot. The count also waits for a minimum number of voters, 2 by default and adjustable in the UI, so that the first two people to rank cannot end the vote early. Set it to the group's size.
- **Late options** go to the bottom of every ballot, marked new, and clear every Reveal.
- **Storage.** `meta`, `ballots`, one `o:<id>` per option and one `r:<n>` per count, so no value nears the 128 KiB limit. The limits are 100 options, 10 fields, 60 voters and 20 stored counts.

## Evals

`src/evals.mjs` holds the requests an agent must be able to handle with this gadget (see
`.agents/skills/author-adaptable-blueprints`). It stays in this package: shipped in the gadget,
an agent reads it and copies the answers. Run `node scripts/blueprint-evals/run.mjs ranked-vote`
(`--reference` needs no model).

| Date | Model | Result |
| --- | --- | --- |
| 2026-10-01 | reference | 3/3 |
| 2026-10-01 | deepseek/deepseek-v4-flash, 3 runs per eval, evals hidden from the agent | 9/9 |
