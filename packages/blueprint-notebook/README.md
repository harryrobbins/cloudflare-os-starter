# Python Notebook blueprint

A Cloudflare OS notebook with Python, Markdown and raw cells, saved results, CodeMirror editing and `.ipynb` import/export. Application source lives in `src/`; the generated archive is `formats/notebook.gadget`.

Execution requires the companion `gatekeeper-runtime` and the owner-permit changes in the pinned Cloudflare OS fork. Installing the archive alone supports editing and saved results. Connect a Notebook Python resource as `PYTHON`, and click Run. That owner click authorizes the exact source; Activity records it without another approval.

Share with the **Gadget only / use** role to expose notebook outputs without permission to run or reset Python. This restriction covers execution, not document edits. Build collaborators can edit application code and require trust. For an independent copy, use Workshop's **Export Gadget → Jupyter notebook**, create a new Notebook, import the file and connect a new Python resource. Imports never execute automatically.

```sh
pnpm --filter blueprint-notebook pack:gadget
pnpm --filter blueprint-notebook test:run
pnpm --filter blueprint-notebook exec node scripts/pack-gadget.mjs --check
```

See [the gadget API](src/README.md), [implementation plan](../../docs/plans/notebook-ide-blueprints.md) and [browser tests](e2e/README.md).
