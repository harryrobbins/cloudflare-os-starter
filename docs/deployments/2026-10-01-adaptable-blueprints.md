# Adaptable blueprints release — 1 October 2026

Outcome: `cfos-workshop` deployed alone (`pnpm release --workshop-only`). Its live version was
verified at 100%. Unauthenticated `/`, `/api/` and `/admin` return 302 to the existing Access
issuer. Signed-in checks in the Workshop are still open.

## Scope

- Root `82e7a21` (main, merge of `feat/adaptable-blueprints`).
- Submodule `ec9847d8`, fork branch `feat/adaptable-gadgets`, built on `0bef286`. It is not
  pushed to GitHub yet; a clean worktree needs the local `insteadOf` described in the operator
  notes.
- Target: account `e1376e48400a20e631b61bbf16f555f1`, `cfos.surprisingly.ltd`.

Fork changes in the Workshop backend:

- `client.lib.js` is loaded before `client.js` in the same module scope and is never a server
  module (`gadget-files.ts`).
- `describeBinding` appends a gadget's `describeGadget()` result as compact JSON, capped at
  24 000 characters.
- The agent prompt now explains using a gadget (RPC from `executeCode`) versus adapting it
  (the `client.js` adapt block or `server.js`), and says never to read or edit `.lib.js` files.

Formats: Whiteboard rev 11, Ranked vote rev 3 and Docs with Drawings rev 3 (it embeds the
Whiteboard). They follow `.agents/skills/author-adaptable-blueprints/SKILL.md`. The other formats
are unchanged.

No resource, secret, migration, Access, DNS, AI, observability, Reporter or Gatekeeper change.

## Evidence

- Canonical validation inside the release: tests 321.1 s, builds 74.9/25.0/1.5 s, dry-runs
  8.9 s, Workshop upload 24.1 s, total 458.4 s.
- Package suites before merge: Whiteboard 782 Node + 24 workerd tests, Docs 1 + 17, Ranked vote
  41 + 3, Ranked vote e2e 6/6, Whiteboard adapt e2e 1/1. Root `scripts/` tests 12/12.
- Blueprint evals (`node scripts/blueprint-evals/run.mjs`), with evals kept out of the shipped
  gadgets:
  - reference runs passed 6/6;
  - `deepseek/deepseek-v4-flash` passed 18/18 (3 runs per eval);
  - Whiteboard passed 6/6 more after merging main's shapes, tables and diagrams;
  - no run read or edited a `.lib.js` file.

## Versions and rollback

| Worker | Before | After |
| --- | --- | --- |
| cfos-workshop | 453c3057-07a4-40bd-91c2-1df363986740 | 630e32d2-4878-4ad7-ad9d-d8d0ecfbe08e |

Rollback is `wrangler rollback` of `cfos-workshop` to `453c3057…`. It has these limits:

- Format records installed at the new revisions remain in KV/R2.
- Gadgets already created from them keep their split files. Under the old Workshop those gadgets
  would not load `client.lib.js`, so roll the formats back too, or avoid rollback once such
  gadgets exist.
- Existing gadgets created before this release keep their old code.
