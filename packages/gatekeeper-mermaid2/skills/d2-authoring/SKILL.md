---
name: d2-authoring
description: Author or revise D2 diagram source for architectures, flows, nested systems, sequence diagrams, classes and data models. Use when the requested output is D2 text, or when preparing D2 for MermaiD2 rendering; use the connector skill for export APIs and the blueprint skill for persistent gadget edits.
---
# D2 authoring

Produce self-contained, readable D2. Read the existing source before editing it and preserve its IDs and intended connections.

| Need | Pattern |
| --- | --- |
| Node | `api: API gateway` |
| Directed/labeled edge | `api -> db: Query` |
| Nested container | `services: { api: API }` and `services.api -> db` |
| Database shape | `db: Database {shape: cylinder}` |
| Sequence diagram | `shape: sequence_diagram` with participant nodes/edges |
| Class or ER shape | `shape: class` or `shape: sql_table`; verify the specialized syntax by rendering |

```d2
users: Users {shape: person}
services: Application {
  api: API gateway
  worker: Job worker
  api -> worker: Queue work
}
data: Data {
  db: Orders {shape: cylinder}
  cache: Cache {shape: cylinder}
}
users -> services.api
services.api -> data.cache
services.worker -> data.db
```

TALA is suited to orthogonal architecture layouts, nested containers, shared dependencies and cycles. Omit `direction` when you want its unconstrained placement. Add `direction: right` or `direction: down` when a flow direction is intentional. Compare Dagre and ELK for layered flows. D2's sequence and grid layouts specialize placement regardless of the general engine selection.

Keep labels concise, use stable meaningful IDs, and group nodes by system boundary. Cross-container edges use qualified IDs. Quote labels/IDs when punctuation needs quoting. Keep relationship labels on edges rather than inventing disconnected legend nodes.

MermaiD2 accepts Markdown fences. Mermaid conversion supports flowchart, sequence, state, class, ER, mindmap and C4; styling and some metadata are lossy. Pie, Gantt, journey, XY and git graphs are unsupported. Mermaid frontmatter/init settings do not override the playground's output options.

Validate actual output with the connected renderer before claiming the diagram works:

```js
const file = await env.MERMAID2.render({ source: d2Source, language: "d2", layout: "tala", format: "svg" });
return { svg: new TextDecoder().decode(file.data), nodes: file.nodes, edges: file.edges };
```

Fix compiler errors in the source and render again. Do not change the deployment or install another engine to hide a syntax error. External images and local imports are unavailable: embed an image as a data URL or omit it. Unsupported or unknown syntax should be checked against https://d2lang.com/tour/ rather than guessed. Drafting source is reversible; saving it into a gadget, publishing or sharing output requires that task's authorization.
