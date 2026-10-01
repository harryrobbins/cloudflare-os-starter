# Whiteboard revision 10 and Docs with Drawings revision 2 (2026-10-01)

## What shipped

- **Whiteboard rev 10** (`packages/blueprint-whiteboard`):
  - 28 shape outlines on rectangles (`style.shape`): basic, flowchart and arrow/callout groups, including database, queue, multiple documents, note and subprocess.
  - Connector end markers (arrow, open, hollow triangle, diamonds, dot, bar, crow's foot) and solid, dashed or dotted lines.
  - Connector ends meet the shape's real outline.
  - Dragging a connection handle to empty canvas adds a connected copy.
  - A `table` type with per-cell editing (`cellEdits` patches).
  - A `diagram` type: D2 or Mermaid, drawn by the optional MermaiD2 connector bound as `MERMAID2`.
  - Toolbar Table, Code block and Diagram buttons, plus Flowchart and Data model templates.
- **Docs with Drawings rev 2** (`packages/blueprint-docs`): the same whiteboard in drawings, and diagram renders through the document's own optional `MERMAID2`.

## How it reached production

- Branch `feat/whiteboard-shapes` was merged into main as e092e9a at about 00:44 BST.
- Another `pnpm release` was already running from the main checkout (started 00:39 at 65374b7). Its Workshop format bundle was generated at 00:48 and contains Whiteboard rev 10 and Docs rev 2.
- The release finished at 00:54 BST: cfos-workshop **4228868f**, cfos-router **638af068**.
- Last known good before it: workshop 6dcab00c, router 9781ece4 (main 9a0605a).
- Only Whiteboard and Docs sources and `formats/whiteboard.*` / `formats/docs-drawings.*` differ between 65374b7 and e092e9a. Production therefore matches e092e9a.
- No second deploy was made.

## Verification

- Before merge:
  - Whiteboard: Node and workerd tests passed (747 + 23).
  - Harness e2e: 49/49 passed, including new `e2e/shapes.test.mjs` and `e2e/tables-diagrams.test.mjs` (with a fake renderer).
  - Docs: 17 workerd tests + 1 Node test passed.
- An independent code review found eight issues. All were fixed before the merge (commit 5cf468b).
- After merge: `pnpm check` of e092e9a passed in a clean worktree (tests, builds, Wrangler dry-runs).
  - The first attempt hit the known `records-node` "fixed window resets" timing flake.
- Not run: local-platform e2e. Other sessions held the local platform ports at the time.

## Pending

- Signed-in production checks: New → Whiteboard gets rev 10; shapes, tables and the diagram placeholder work.
- Diagrams draw only after the MermaiD2 connector is connected to a board as `MERMAID2` (for example through the Workshop agent's `setGadgetBinding`). Real D2 and Mermaid renders have not been checked yet. The renderer path was tested with a stand-in.

## Rollback

Roll back cfos-workshop to 6dcab00c. Boards created on rev 10 keep their code, as with every format revision. Objects of the new types would be unknown to rev 9 code.
