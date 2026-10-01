---
name: author-adaptable-blueprints
description: Create, convert or rebuild a Cloudflare OS blueprint (packages/blueprint-*, formats/*.gadget) so the in-Workshop agent can both use it (call its documented domain operations) and adapt it (change its display or functionality) through small readable entry points instead of a bundled or minified client. Use when authoring a blueprint, changing its build, published files, RPC surface or README; not for ordinary content edits to one gadget.
---

# Author adaptable blueprints

Every gadget made from a blueprint is an editable copy, worked on by the Workshop agent. That
agent's `readFile` returns whole files with no line ranges or search, and `editFile` needs an
exact unique match. A 900 KB `client.js`, minified or not, is therefore effectively uneditable.
It also cannot infer a gadget's operations from hundreds of KB of bundled server code.

Design every blueprint for the two jobs the agent is asked to do:

| Job | Where the agent goes |
| --- | --- |
| **Use** it: read or change its content | `describeBinding` → `describeGadget()` → RPC from `executeCode` |
| **Adapt** it: change what it shows or can do | README "Adapting this gadget" → `client.js` adapt block, `server.js` |

Which operations and extension points make sense is each blueprint's own design decision; this
skill fixes only where they live and how they are described.

## Published shape

| File | What | Rules |
| --- | --- | --- |
| `client.js` | The hand-written client entry, **verbatim** (comments kept), its imports rewritten to `const { … } = gadgetLib;` | Readable, unminified, ≤ 64 KiB (aim for far less). Starts with the adapt block. |
| `client.lib.js` | Everything the entry imports, as `var gadgetLib = (() => …)()` | May be minified. The platform loads it before `client.js` in the same module scope. Never hand-edited. |
| `server.js` | The hand-written server entry, verbatim, local imports pointed at `./server.lib.js` | Readable, ≤ 64 KiB. Exports `Gadget` (and `ExportHandler` if any). |
| `server.lib.js` | ESM bundle of what the server entry imports | Unminified is fine; never hand-edited. |
| `README.md` | Usage, then **"Adapting this gadget"** | See below. |

`scripts/gadget-entry.mjs` builds all four (`buildClientEntry`, `buildServerEntry`; tested in
`scripts/gadget-entry.test.ts`). The platform side is the fork's
`packages/workshop-backend/src/gadget-files.ts`: `client.lib.js` is prepended to `client.js` and
is never a server module. `describeBinding` appends the result of the gadget's `describeGadget()`.

Wire a package's `scripts/build.mjs` like this and keep its existing budgets, plugins, defines
and minify choice on the library:

```js
import * as esbuild from "esbuild";
import { buildClientEntry, buildServerEntry } from "../../../scripts/gadget-entry.mjs";
await buildServerEntry({ esbuild, entry: join(pkg, "src/server/index.js"), outDir,
  banner: "// <Name> gadget server: the RPC surface. Source: packages/blueprint-<name>/src/server/index.js." });
await buildClientEntry({ esbuild, entry: join(pkg, "src/client/main.js"), outDir,
  banner: "// <Name> gadget client: the main view. Adapt it in the block below. Source: packages/blueprint-<name>/src/client/main.js.",
  library: { minify: false } });
```

Entries must use static top-level `import` declarations only (no `import()`, no `export *`).
Library names are the entry's local binding names, so the shipped file reads like the source.
Add `client.lib.js` and `server.lib.js` to `FILES` in `scripts/pack-gadget.mjs`. Harnesses
and tests that run `dist/client.js` must run `client.lib.js + "\n;\n" + client.js`, exactly
like the platform (`assembleClientCode` in `scripts/gadget-entry.mjs`).

## Use: `describeGadget()`

Give the server's `Gadget` class a synchronous, side-effect-free `describeGadget()` that returns:

```js
{
  gadget: "<format id>", contract: 1,
  summary: "One sentence: what it holds and how to call it.",
  operations: [{
    name: "<method on class Gadget>",
    description: "What it does, and whether it reads current revisions itself.",
    input: { /* JSON Schema of its argument */ },
    example: "await env.<Binding>.<method>({ … })",
    returns: "<shape of the result>",
  }],
  adapt: { client: "client.js: `adapt` block (settings, styles, actions, onReady)", server: "server.js: add methods to class Gadget", readme: "README.md#adapting-this-gadget" },
}
```

- List the **convenience** operations an agent should reach for first. These are the
  blueprint's own domain verbs that read current revisions themselves and return ids. Either
  validate the whole input before writing, or apply the valid items and report the rest in
  `errors`, and say which in the description. List low-level escape hatches (raw operation or
  patch methods) last. Add a thin, validated verb only where the obvious job has none, and
  describe what exists rather than an idealised API.
- **Who the agent acts as.** Calls from `executeCode` carry no signed-in account. Attribute
  agent writes to an "Assistant" identity when `by` is omitted. Let people edit or withdraw what
  the Assistant created. Never let the Assistant perform a person's own act, such as casting a
  ballot, approving, or marking someone ready.
- Every `example` must be real, runnable code whose argument satisfies `input`. A test calls
  each example's operation with that input against the real service or DO.
- Keep it bounded. describeBinding prints it as compact JSON and truncates at 24 000 characters.
  Explain shared conventions (colours, positions, `by`) once in `summary` rather than in every
  schema, and name rarely used methods in `summary` instead of listing them. The whiteboard's
  16 operations come to about 19 KB.

## Adapt: the adapt block

Near the top of the client entry, after the platform-global guards, put one clearly marked
object. It is the first thing an agent sees and the one place it edits for most changes:

```js
// ===== Adapt this gadget =====================================================
// Settings and extension points, honoured by client.lib.js. Change these rather than the library.
// README.md ("Adapting this gadget") documents every field and the `app` handle.
const adapt = {
  // <blueprint settings: title, default colours, labels, limits, templates …>
  styles: "",   // extra CSS, applied after the built-in styles
  actions: [    // extra commands: { id, label, title?, run(app) } shown in <where>
  ],
  onReady(app) {},  // called once, when the view has mounted and shows its first data
};
// ==============================================================================
```

- `styles`, `actions` and `onReady` are the common core. Every blueprint supports them with
  the same meaning. Add blueprint settings that people plausibly want changed, and only ones
  the library really honours.
- Pass `adapt` into the library's mount call. The library must validate it (ignore unknown
  keys; report a bad action in the console, don't crash) and put actions somewhere visible and
  keyboard-reachable: a toolbar, the board menu or a command list.
- `app` is a small documented handle, not the internals. It holds the same domain verbs the
  server offers, where they make sense client-side, plus a way to show a short message. Document its methods in README.
- Test each core extension point with a fixture: one extra action appears and runs, extra
  styles apply, and `onReady` fires once.
- Settings and actions are usually enough; you need not move the view's composition into the
  entry. Do expose the composition people plausibly change (layout, panels, labels) as settings.
  Move sync and reload plumbing into the library when that keeps the adapt block the first
  thing in the file. Stable engine code (sync, geometry, rendering, parsers, vendor libraries)
  belongs in the library.
- Harness and e2e tests inject a fixture adapt block by rewriting `dist/client.js` as it is
  served, for example with Playwright `context.route`.

## README: "Adapting this gadget"

Add this section after the user guide in `src/README.md`, which ships as the gadget's README:

1. The file map (the table above, in one line each) and "never edit `*.lib.js`".
2. **Use**: point to `describeGadget()` and list the operation names.
3. **Adapt**: every `adapt` field, the `app` handle's methods, and where actions appear.
4. Two worked examples in this blueprint's own terms: one operation call and one adaptation.
   They must not match an eval; a worked answer in the README makes the eval measure copying.
5. That edits to a gadget copy are not carried back to `packages/blueprint-*`.

## Evals: what an agent must be able to do

Every adaptable blueprint keeps `src/evals.mjs` in its package. It is the blueprint's
executable promise about the requests an agent should handle: a few `use` evals and at least
one `adapt` eval, each phrased as a person would type it in the Workshop chat, in the
blueprint's own domain.

**Never ship evals in the gadget**, and keep their prompts, names and results out of the
shipped README. In the pilots, agents read a shipped `evals.mjs` and copied the reference
answer.

```js
// <Name>: requests an agent should be able to carry out with this gadget.
// Run: node scripts/blueprint-evals/run.mjs <format> [--eval <id>] [--reference] [--model <m>]
export default [
  {
    id: "kebab-case-id",
    kind: "use",   // "use": call operations from executeCode, editing no file; "adapt": edit code
    prompt: "What the person asks for, in their words.",
    // A known-good solution. `--reference` runs it without a model, proving the eval is
    // achievable and its check is right; the package tests run every reference.
    reference: { code: "await env.<Binding>.<method>({ … });" },   // final?: the reply text
    //   adapt: { edits: [{ file: "client.js", find: "<exact text>", replace: "<text>" }] }
    // Optional: seed state the agent must not create itself (other people's contributions).
    async setup(t) { await t.gadget.<method>({ … }); },
    /** @param {EvalContext} t @returns {Promise<string[]>} problems; empty means pass */
    async check(t) { const state = await t.gadget.<read method>(); return [ … ]; },
  },
];
```

`EvalContext` (scripts/blueprint-evals/run.mjs) holds:
- `t.gadget`: the gadget's real `Gadget` class, built from the final files and running in Node
  with in-memory Durable Object storage. Call its methods directly.
- `t.files`: the final gadget files, keyed by name.
- `await t.client()`: a Playwright page running the assembled client exactly as the platform
  does, with `gadget` bridged to `t.gadget`. Use it to click an added action and check its effect.
- `t.final`: the agent's closing reply (or `reference.final`), for requests answered in text.

`scripts/blueprint-evals/node-gadget.mjs` (`loadGadget`, `MemoryStorage`) also serves package
tests that run the real `Gadget` in Node, such as running every `describeGadget()` example as
written. workerd has no `new Function`.

Checks judge outcomes, not method choice: accept any reasonable way of doing the job, and be
tolerant of wording, case and layout jitter. The runner also fails a `use` eval that edited a
file, and any eval that touched a `.lib.js` file. Record model runs (model, date, pass rate)
in the package's own `README.md`, which does not ship.

## Checks before release

- `node --test scripts/gadget-entry.test.ts` and the package's `test:run` (plus `test:e2e`
  where it exists) pass. The build fails when an entry exceeds its budget.
- `dist/client.js` and `dist/server.js` start with the banner and the adapt block, contain
  no `import` from a relative path, and are unminified.
- `pack:gadget` bumps the revision whenever the content changed since the last pack. Before
  the final pack of a release, restore `formats/<name>.json` and `gadget.lock.json` to the last
  released state so the release is one bump. Then `pack-gadget.mjs --check` passes. Repack any
  format that embeds this one (Docs with Drawings embeds the whiteboard).
- Every eval passes with `--reference`, and a model run with the test model
  (`litellm_proxy/deepseek/deepseek-v4-flash`) passes most runs; investigate any eval it fails.
- Smoke test in the Workshop with one request of each kind, phrased in the blueprint's own
  terms. A content request should use `describeBinding` and call operations without editing
  code. A request to change behaviour or display should edit the adapt block of `client.js`,
  or `server.js`, never a `.lib.js` file.
