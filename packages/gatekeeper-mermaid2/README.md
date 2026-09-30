# MermaiD2 connector

A private Cloudflare OS connector that converts supplied Mermaid/D2, lays out with
TALA/Dagre/ELK, and returns SVG, PNG, JPEG, WebP, PDF, ASCII, input source,
converted D2 or compiled graph JSON. Source is ephemeral. No OAuth or secrets.

## Use

Connect resource `mermaid2://renderer` to an app/workspace as `MERMAID2`.

```js
const image = await env.MERMAID2.render({
  source: 'a -> b', language: 'd2', layout: 'tala', format: 'png', scale: 2,
});
// image.data: Uint8Array; image.contentType: image/png; image.filename: mermaid2-diagram.png
```

`describeCapabilities()` reports formats/limits. `readSkill(id)` exposes three
bundled skills; `getAgentCatalog` advertises them when the connector is connected.
The same skills are bundled in the blueprint archive and exposed in the starter's
`.agents/skills` directory. See [types.d.ts](src/types.d.ts) for the complete API.

Other Cloudflare Workers can bind this Worker with entrypoint `DiagramRenderer`
and call the same API. HTTP fetch returns 404, including asset paths: private
renderer assets are fetched only through `RENDERER_ASSETS` during request interception.

## Architecture and isolation

A Cloudflare Browser Run instance executes the pinned D2 and mermaid2d2 WASM
engines. Trusted renderer scripts are fulfilled from a private static-assets
binding at a synthetic origin. All other requests are blocked, with a restrictive
CSP also covering worker fetches. User source is never evaluated as JavaScript.
Each browser is closed after the render, including errors/timeouts. There is no
source history or global result cache. The supplied source and output are omitted
from observation descriptions and operational logs. Sharing allows collaborators
to observe diagrams supplied to their gadget; no third-party account data is read.

Limits: 100,000 UTF-8 input bytes; 1,000 nodes/2,000 edges; 16 MiB generated output;
32 million raster pixels and 16,384 pixels/side. PDF embeds a raster image on one
page; ASCII simplifies some shapes. External images/imports are unavailable.

The connector is an optional credential-free vendor; deployments/admins control
availability and users explicitly connect the resource. It does not assert
ambient authority or modify other apps. Browser usage is billed to the deployment.

## Build and test

Requires the starter's Node/pnpm versions and Go 1.26.2+.

```sh
pnpm --filter gatekeeper-mermaid2 build
pnpm --filter gatekeeper-mermaid2 test
pnpm --filter blueprint-mermaid2 pack:gadget
```

The build compiles the Go/WASM bridge, generates D2 gallery companions, embeds the
converter bytes in its worker, bundles trusted renderer assets and generates
skill/type metadata. Generated outputs are ignored; lockfiles pin dependencies.
Deployment is coordinated by the starter's deployment.jsonc and scripts/deploy.ts.
License notices are packaged with renderer assets; the adapted playground sources
retain their MPL-2.0 license. mermaid2d2 is MIT.
