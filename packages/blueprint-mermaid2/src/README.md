# MermaiD2

A diagram playground: Mermaid or D2 source, TALA/Dagre/ELK layout, 14 examples,
palettes, sketch, pan/zoom, and SVG/PNG/JPEG/WebP/PDF/ASCII/source/JSON exports.
Drafts are stored with the gadget. Rendering uses the MermaiD2 connector.

## Connection

Bind `MERMAID2` to the `mermaid2` connector resource `mermaid2://renderer`.
The renderer is private, credential-free and read-only. It processes supplied
source ephemerally on Cloudflare, blocks external resources, and records
observations. Browser usage applies. PDF contains a raster image; SVG is vector.

## Agent RPC

- `getDocument()` → `{ revision, drafts?, language?, layout?, theme?, sketch?, live? }`.
- `setDocument({ expectedRevision, document })` → saved document. Requires the current
  revision, two string drafts keyed by mermaid/d2, language, layout, string theme,
  and boolean sketch/live. `conflict:` means another editor saved; reread before editing.
- `renderDiagram({ source, language?, layout?, theme?, sketch?, format?, scale? })`
  → `{ data: Uint8Array, contentType, filename, nodes, edges, d2Source? }`.
- `exportDiagram(format, scale)` renders the saved active draft.
- `readSkill(id)` reads one of the skills below through the connector.

For UI editing use one editor at a time. Simultaneous edits are detected by
revision checks, with a copy-before-reload message; they are not automatically merged.

## Bundled skills

Read the relevant skill before using the API:

- `skills/mermaid2-blueprint/SKILL.md`: persistent document editing and conflict handling.
- `skills/mermaid2-connector/SKILL.md`: render options, bytes, formats and limits.
- `skills/d2-authoring/SKILL.md`: D2 patterns and layout choices.

These are also discoverable in the connector's agent catalog and available through
`MERMAID2.readSkill(id)`. Use the actual connected binding name in agent code.
