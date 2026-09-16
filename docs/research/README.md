# Research

Background research behind the plans in [`../plans/`](../plans/collaborative-blueprints.md). Written 2026-09-16 against the pinned submodule at `cloudflare-os` commit `90f0591` (branch `starter-openrouter` of the private `surprisingly-os` fork) and upstream `cloudflare/cloudflare-os` `main` as of that date.

| File | What it covers |
| --- | --- |
| [gadget-collaboration-runtime.md](gadget-collaboration-runtime.md) | Code trace of the pinned release: what a gadget, blueprint, workspace and chat are at runtime; where state lives; how sharing resolves to one Durable Object; the live-push plumbing; the sandbox policy. Every claim carries a `file:line`. |
| [bundled-blueprint-sync-patterns.md](bundled-blueprint-sync-patterns.md) | How the three shipped format blueprints (Docs, Sheets, Slides) implement multi-user sync, with the wire protocol, conflict policy and presence handling side by side. The reference for the plans. |
| [cloudflare-os-collaboration-public-docs.md](cloudflare-os-collaboration-public-docs.md) | What Cloudflare says publicly about collaboration in gadgets, known gaps and open issues, where upstream `main` has moved since our pin, and Cloudflare's general 2026 guidance for realtime on Workers. |
| [bundled-blueprints/](bundled-blueprints/) | The decoded `server.js` and `README.md` of each bundled blueprint, plus `extract-gadget.mjs`, the script that decodes any `.gadget` archive into its source files. |

## Decoding a `.gadget` archive

```sh
node docs/research/bundled-blueprints/extract-gadget.mjs \
  cloudflare-os/packages/workshop-backend/format-blueprints/workspace-sheets.gadget \
  /tmp/sheets
```

The script reads the 24-byte prefix, the JSON metadata and the gzip-compressed Yjs V2 snapshot, and writes one file per entry in the Yjs map. It resolves `yjs` from the submodule's `workshop-backend` package, so run `pnpm --dir cloudflare-os install` first.
