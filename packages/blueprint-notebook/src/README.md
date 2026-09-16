# Notebook

Python cells, Markdown and saved results. Connect the Notebook Python resource as `PYTHON` to enable execution. The workspace owner can request runs and stop/reset; approve those requests in Workshop Activity. Shared viewers can read saved outputs, but cannot obtain the one-use owner permits needed to run code. Use the **use** sharing role for readers; **build** collaborators can change application source and should be trusted accordingly.

A kernel keeps variables between cells until it stops, reaches its idle timeout or fails. It has no internet access. Runs are limited to 60 seconds including startup and outputs are capped. Stop/reset discards variables and temporary files; saved cells/results remain. This initial version does not persist the Python filesystem or install packages on demand.

Use Workshop’s gadget menu → Export → Jupyter notebook to download a copy as `.ipynb`, create a new Notebook, import the file and connect your own Python resource. This copies the document and outputs, never a runtime identity, credentials or live variables. Import does not execute code.

## Programmatic use

The agent may edit the document through these gadget methods. Do not edit application source to change a user's cells.

- `getNotebook()` returns title, revision and cells, each with `id`, `type`, `source`, `version`, saved outputs and optional run provenance.
- `saveCell(id, version, source, type)` returns `{conflict, cell}`; on conflict, inspect the current cell before editing again.
- `changeStructure(revision, operation)` supports `{type:'insert',cellType:'code'|'markdown'|'raw',index?}`, `{type:'delete',id}`, `{type:'move',id,index}`, and `{type:'title',title}`. Read the notebook first for the revision.
- `importNotebook(text, revision)` replaces document cells with a bounded Python `.ipynb` v4 file.
- `exportNotebook()` returns `.ipynb` JSON containing saved outputs.
- `getRuntimeStatus()` and `refreshRun()` read current execution state; reading never starts Python.

Execution requires a fresh owner-authenticated UI permit for the exact source and generation. Agents and collaborators cannot mint those permits. Ask the owner to run the cell using the notebook UI. A code edit after submission leaves the output labelled as coming from an older revision.

Limits: 100 cells; 16,000 source characters per cell; 100,000 UTF-8 JSON bytes per cell; 2 MB total notebook storage. Imported active HTML/JavaScript is never executed. Unsupported bounded MIME data/metadata are preserved in downloads, not displayed.
