# MermaiD2

MermaiD2 is a Cloudflare OS blueprint and reusable diagram connector. It accepts
Mermaid or D2, renders with TALA, Dagre or ELK, and exports SVG, PNG, JPEG, WebP,
PDF, ASCII, original source, converted D2, or compiled graph JSON.

## Open the playground

Choose **New → Diagram → MermaiD2** in the Workshop. Connect its `MERMAID2`
binding to **MermaiD2 → mermaid2://renderer** when prompted. Deployment
administrators must allow the MermaiD2 connector in the connector policies.

Paste either language, select a layout, or choose one of 14 examples. The gallery
includes flows, state machines, sequence diagrams, classes, ER models, dependency
maps and larger architectures. Drafts and options persist in gadget storage.

Use the Workshop **Export** menu for direct file downloads. The playground's
Export button prepares a file and offers an explicit open/save link, because the
Workshop iframe restricts direct downloads. SVG is vector; PDF embeds a raster
image. The renderer blocks external images and imports.

Use one editor at a time. A revision check catches simultaneous writes and asks
you to copy your changes before reloading; documents are not automatically merged.

## Call the connector from another app

Connect resource `mermaid2://renderer` as `MERMAID2`, then call:

```js
const file = await env.MERMAID2.render({
  source: 'flowchart LR\n  A[Request] --> B[Response]',
  language: 'mermaid',
  layout: 'tala',
  format: 'png',
  scale: 2,
});
return new Response(file.data, {
  headers: { 'content-type': file.contentType },
});
```

The response includes `data` (Uint8Array), `contentType`, `filename`, language,
layout, format, node/edge counts, and converted `d2Source` when applicable.
`describeCapabilities()` returns supported options and limits.

Other Workers in the same Cloudflare account can use a native service binding:

```jsonc
{
  "services": [{
    "binding": "MERMAID2",
    "service": "cfos-mermaid2",
    "entrypoint": "DiagramRenderer"
  }]
}
```

That entrypoint has the same render/capabilities/skill API. Workshop connections
also record observations through the Gatekeeper approval queue. The renderer has
no public HTTP endpoint or public assets. Its source processing is ephemeral;
the playground stores drafts in its own gadget.

Each render uses Cloudflare Browser Run. Input is limited to 100,000 UTF-8 bytes,
1,000 nodes and 2,000 edges; output to 16 MiB; raster images to 32 million pixels
and 16,384 pixels on either side. Requests run trusted WASM engines in a browser
with external network access blocked. Browser instances are closed after use.
Source and image contents are excluded from observation descriptions and logs.

## Skills

The following skills are bundled in the blueprint archive, advertised in the
connected renderer's agent catalog, available through `MERMAID2.readSkill(id)`,
and linked in this repository's `.agents/skills/`:

- `mermaid2-blueprint`: create/edit persistent diagram gadgets and handle revisions.
- `mermaid2-connector`: render diagrams and consume exported bytes in other apps.
- `d2-authoring`: write D2 architectures, flows, sequence diagrams and data models.

Source files live in `packages/gatekeeper-mermaid2/skills/`. Blueprint README
links expose their archive paths to agents inspecting the gadget.

## Build and release

Requires the checkout's pinned Node, pnpm and Wrangler, plus Go 1.26.2 or newer.
`deployment.jsonc` controls `mermaid2.enabled` and `workers.mermaid2.name`.

```sh
pnpm --filter gatekeeper-mermaid2 build
pnpm --filter blueprint-mermaid2 pack:gadget
pnpm check --diagrams-only
pnpm deploy --diagrams-only
node packages/gatekeeper-mermaid2/scripts/verify-live.mjs
```

The focused release deploys the renderer first, then Workshop, preserving the
existing router and other Worker identities. The normal full release also
includes MermaiD2 when enabled. Disabling it omits the service binding and Worker
from deployment; existing connected diagrams will need the renderer restored.

The converter is built from the bundled mermaid2d2 Go sources. The actual D2
renderer is pinned to `@d2lang/d2` 0.1.34. The adapted playground retains MPL-2.0;
converter and dependency notices are bundled with the renderer assets.

Repository test tasks run one package at a time so browser and Workers test pools
do not compete with each other and trigger unrelated timing failures.
