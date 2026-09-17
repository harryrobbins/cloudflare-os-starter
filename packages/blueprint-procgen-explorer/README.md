# Synthetic Data Explorer blueprint

Source package for the wrapper-owned `format.procgen-explorer` Gadget. It requires a `PROCGEN` Synthetic Data connection and stores only bounded presentation state.

```sh
pnpm --filter blueprint-procgen-explorer test:run
pnpm --filter blueprint-procgen-explorer pack:gadget
```

The pack command builds `dist/`, writes `formats/procgen-explorer.gadget`, and bumps the sidecar revision when archive content changes.
