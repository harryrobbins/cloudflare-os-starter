---
name: mermaid2-connector
description: Render supplied Mermaid or D2 as SVG, PNG, JPEG, WebP, PDF, ASCII, source or graph JSON through the MermaiD2 connector. Use for programmatic diagram exports or embedding diagrams in other apps, rather than editing a playground gadget.
---
# MermaiD2 connector

Use the connected `DiagramSession` binding (examples call it `env.MERMAID2`; discover the actual binding name first). The resource is `mermaid2://renderer`. Connect it to the app or workspace explicitly; it has no ambient authority.

| Task | Method |
| --- | --- |
| Discover supported outputs and limits | `describeCapabilities()` |
| Render/export supplied source | `render(request)` |
| Read D2 authoring guidance | `readSkill("d2-authoring")` |

```js
const file = await env.MERMAID2.render({
  language: "mermaid",
  source: "flowchart LR\n A[Client] --> B[API] --> C[(Database)]",
  layout: "tala",
  format: "svg",
});
// file.data is Uint8Array; file.contentType and file.filename describe the file.
return { svg: new TextDecoder().decode(file.data), nodes: file.nodes, edges: file.edges };
```

For PNG use `format: "png", scale: 2`. Binary files can be stored in an app's own storage or sent in `new Response(file.data, { headers: { "Content-Type": file.contentType } })`. In a browser use `new Blob([file.data], { type: file.contentType })`.

Defaults: language `d2`, layout `tala`, format `svg`, theme `104`, sketch false, scale 2. Layouts: `tala`, `dagre`, `elk`; themes: 0, 1, 103, 104, 200. Scale: 1, 2, 3. Formats: svg, png, jpeg, webp, pdf, ascii, source, d2, json. PDF embeds a raster image; ASCII can simplify complex shapes. `source` preserves input; `d2` returns normalized/converted D2; `json` returns the compiled D2 graph.

Input is limited to 100,000 UTF-8 bytes. Generated files are capped at 16 MiB, raster images at 32 million pixels and 16,384 pixels per side, graphs at 1,000 nodes/2,000 edges. Lower the scale or choose SVG if a raster exceeds limits. Invalid syntax, unsupported formats, timeouts and unavailable browser capacity throw. Fix the cause before retrying; do not repeatedly retry unchanged syntax.

Source is processed ephemerally on Cloudflare; browser usage applies. No diagram history is retained by the connector. Use self-contained source and embedded images; external resource requests and local imports are blocked. Rendering has no external write actions. Do not publish, share or persist returned files unless the task authorizes that destination.

## Other Cloudflare Workers

Bind the private renderer Worker with entrypoint `DiagramRenderer` and call the same three methods through that service binding. Worker-native service bindings are capabilities; the renderer has no public HTTP API and requires no token. Workshop apps should use their connector session so observations are recorded.
