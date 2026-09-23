# Tessera Mosaic blueprint

Source package for the wrapper-owned `format.tessera` Gadget: [Tessera](https://github.com/harryrobbins/tessera), the WebGL2 unit-visualisation engine, bundled into one `client.js`. It declares no bindings, so a new gadget opens on Tessera's demo collections; a Synthetic Data connection added later in the gadget's Connections tab shows that connector's tables. Design and checklist: `docs/plans/tessera-blueprint.md`.

```sh
pnpm --filter blueprint-tessera test:run
pnpm --filter blueprint-tessera pack:gadget
```

The pack command builds `dist/`, writes `formats/tessera.gadget`, and bumps the sidecar revision when archive content changes.

## Testing

```sh
pnpm --filter blueprint-tessera test:e2e   # Playwright suite in the opaque-origin harness
pnpm --filter blueprint-tessera harness    # the same harness at http://127.0.0.1:8791 (?procgen=1 binds a fake connector)
```

The harness copies the prefix, CSP and sandbox from `GadgetUI.tsx` (the source lines are cited in `harness/parent.js`). It runs the real `src/server/core.js` against the real procgen generator. Do not relax it to `allow-same-origin`: that would hide the failures the sandbox causes, such as blocked storage and blocked `blob:` URLs.

## Updating Tessera

The rendering engine is not in this package. It comes from Tessera's `embed-api` branch, pinned by commit in `package.json`. To change it:

1. Commit to `embed-api` in the Tessera repo and push it.
2. Point the `github:harryrobbins/tessera#<sha>` pin at the new commit.
3. Run `pnpm install`, then `pnpm --filter blueprint-tessera pack:gadget`. The pack bumps the revision.

`pack-gadget --check` rebuilds from source, so a stale archive fails the package tests.

The agent-facing API (RPC methods, state shape and connectors) is documented in [`src/README.md`](src/README.md).
