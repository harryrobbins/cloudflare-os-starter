---
name: mermaid2-blueprint
description: Create, populate or edit a MermaiD2 diagram playground gadget in Cloudflare OS. Use when the user wants an editable Mermaid/D2 diagram document, layout comparison, example gallery or exports from the playground; use mermaid2-connector for rendering files without a gadget.
---
# MermaiD2 blueprint

Create a gadget from blueprint `format.mermaid2` (shown under New → Diagram / MermaiD2). Bind its `MERMAID2` connector to `mermaid2://renderer`. Discover the gadget's actual binding name; examples call it `env.Diagram`.

| Task | Method |
| --- | --- |
| Inspect saved drafts/options | `getDocument()` |
| Replace drafts/options | `setDocument({ expectedRevision, document })` |
| Export the saved active diagram | `exportDiagram(format, scale)` |
| Preview arbitrary source | `renderDiagram(request)` |

```js
const current = await env.Diagram.getDocument();
const document = {
  language: "d2", layout: "tala", theme: "104", sketch: false, live: true,
  drafts: {
    d2: "client: Client\napi: API\ndb: Database {shape: cylinder}\nclient -> api -> db",
    mermaid: current.drafts?.mermaid ?? "flowchart LR\n A --> B",
  },
};
await env.Diagram.setDocument({ expectedRevision: current.revision, document });
return { saved: true };
```

A document has separate Mermaid and D2 drafts. Preserve the inactive draft unless asked to replace it. `theme` is a string: "0", "1", "103", "104", "200". Layout is tala/dagre/elk. Changing the document is a persistent edit; only do it when authorized. Rendering and exports do not change the document.

On `conflict:` reread the current document and preserve the other person's changes; never overwrite with a guessed revision. Each draft is limited to 100,000 UTF-8 bytes. `not_connected:` means connect the renderer binding. An untouched gadget returns only `{ revision: 0 }` until its UI or an agent initializes drafts.

The UI provides 14 examples, live/manual preview, palettes, sketch, pan/zoom and exports. Copy unsaved source before reloading after a save conflict. The gadget stores drafts on the server and does not use browser localStorage. The current UI does not merge simultaneous edits: revision checks protect against overwriting another editor.

For D2 syntax read `readSkill("d2-authoring")`; for programmatic render options read `readSkill("mermaid2-connector")`. Those skills are also bundled as gadget files under `skills/<name>/SKILL.md`. Export files belong to the user; publishing or sharing them requires an authorized destination.
