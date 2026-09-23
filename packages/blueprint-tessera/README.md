# Tessera Mosaic blueprint

Source package for the wrapper-owned `format.tessera` Gadget: [Tessera](https://github.com/harryrobbins/tessera), the WebGL2 unit-visualisation engine, bundled into one `client.js`. It declares no bindings, so a new gadget opens on Tessera's demo collections; a Synthetic Data connection added later in the gadget's Connections tab shows that connector's tables. Design and checklist: `docs/plans/tessera-blueprint.md`.

```sh
pnpm --filter blueprint-tessera test:run
pnpm --filter blueprint-tessera pack:gadget
```

The pack command builds `dist/`, writes `formats/tessera.gadget`, and bumps the sidecar revision when archive content changes.
