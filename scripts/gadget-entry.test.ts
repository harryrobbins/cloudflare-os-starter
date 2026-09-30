import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  assembleClientCode, buildClientEntry, buildServerEntry, libraryEntrySource, parseModuleImports,
} from "./gadget-entry.mjs";

// The root has no esbuild of its own; every blueprint package does.
const esbuild = createRequire(new URL("../packages/blueprint-whiteboard/package.json", import.meta.url))("esbuild");
const scratch = await mkdtemp(join(tmpdir(), "gadget-entry-"));
after(() => rm(scratch, { recursive: true, force: true }));

test("parses default, named, aliased, namespace, side-effect and multi-line imports", () => {
  const decls = parseModuleImports([
    `import { a, b as c } from "./x.js";`,
    `import d, { e } from './y.js'`,
    `import * as ns from "./z.js";`,
    `import "./styles.js";`,
    `import {`,
    `  f,`,
    `  g, // why`,
    `} from "./w.js";`,
    `export { Gadget, Other as Renamed } from "./server/impl.js";`,
    `const s = "import x from 'nope'";`,
  ].join("\n"));
  assert.deepEqual(decls.map((d) => [d.kind, d.specifier, d.bindings.map((b) => `${b.imported}>${b.local}`)]), [
    ["import", "./x.js", ["a>a", "b>c"]],
    ["import", "./y.js", ["default>d", "e>e"]],
    ["import", "./z.js", ["*>ns"]],
    ["import", "./styles.js", []],
    ["import", "./w.js", ["f>f", "g>g"]],
    ["export", "./server/impl.js", ["Gadget>Gadget", "Other>Renamed"]],
  ]);
  assert.equal(libraryEntrySource(decls.slice(0, 4)), [
    `export { a, b as c } from "./x.js";`,
    `export { default as d, e } from "./y.js";`,
    `export * as ns from "./z.js";`,
    `import "./styles.js";`,
    ``,
  ].join("\n"));
});

test("a split client runs like the bundle it replaces, and keeps the entry's comments", async () => {
  const src = join(scratch, "client-src");
  await mkdir(src, { recursive: true });
  await writeFile(join(src, "math.js"), `export const twice = (n) => n * 2;\nexport default function greet(n) { return "hi " + n; }\n`);
  await writeFile(join(src, "main.js"), [
    `// Main view: the part people change.`,
    `import greet, { twice as double } from "./math.js";`,
    `import * as m from "./math.js";`,
    ``,
    `globalThis.out = [greet("x"), double(2), m.twice(5)];`,
  ].join("\n"));
  const out = join(scratch, "client-dist");
  const r = await buildClientEntry({ esbuild, entry: join(src, "main.js"), outDir: out, banner: "// Test gadget client." });
  assert.deepEqual(r.names, ["greet", "double", "m"]);
  const client = await readFile(join(out, "client.js"), "utf8");
  const lib = await readFile(join(out, "client.lib.js"), "utf8");
  assert.match(client, /^\/\/ Test gadget client\.\n\/\/ Main view: the part people change\./);
  assert.match(client, /const \{ greet, double, m \} = gadgetLib;/);
  assert.doesNotMatch(client, /^import /m);
  const code = assembleClientCode(client, lib);
  const scope: { out?: unknown } = {};
  new Function("globalThis", code)(scope);
  assert.deepEqual(scope.out, ["hi x", 4, 10]);
});

test("client entries over budget are refused", async () => {
  const src = join(scratch, "big");
  await mkdir(src, { recursive: true });
  await writeFile(join(src, "main.js"), `// big\n` + "x();\n".repeat(200));
  await assert.rejects(
    buildClientEntry({ esbuild, entry: join(src, "main.js"), outDir: join(scratch, "big-out"), banner: "//", budgetBytes: 100 }),
    /readable entry must stay within 100/);
});

test("a split server keeps cloudflare: imports and serves the rest from server.lib.js", async () => {
  const src = join(scratch, "server-src");
  await mkdir(join(src, "core"), { recursive: true });
  await writeFile(join(src, "core", "store.js"), `export class Store { get() { return 7; } }\nexport class ExportHandler {}\n`);
  await writeFile(join(src, "index.js"), [
    `// The gadget's RPC surface.`,
    `import { DurableObject } from "cloudflare:workers";`,
    `import { Store } from "./core/store.js";`,
    `export { ExportHandler } from "./core/store.js";`,
    ``,
    `export class Gadget extends DurableObject { value() { return new Store().get(); } }`,
  ].join("\n"));
  const out = join(scratch, "server-dist");
  await buildServerEntry({ esbuild, entry: join(src, "index.js"), outDir: out, banner: "// Test gadget server." });
  const server = await readFile(join(out, "server.js"), "utf8");
  const lib = await readFile(join(out, "server.lib.js"), "utf8");
  assert.match(server, /import \{ DurableObject \} from "cloudflare:workers";/);
  assert.match(server, /import \{ Store \} from "\.\/server\.lib\.js";/);
  assert.match(server, /export \{ ExportHandler \} from "\.\/server\.lib\.js";/);
  assert.match(lib, /export \{[^}]*\bExportHandler\b[^}]*\bStore\b|export \{[^}]*\bStore\b[^}]*\bExportHandler\b/);
  assert.doesNotMatch(lib, /cloudflare:workers/);
});
