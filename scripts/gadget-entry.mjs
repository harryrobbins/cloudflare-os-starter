// Builds a gadget's readable entry points: client.js and server.js ship as their hand-written
// source (comments and all), and everything they import is bundled into a library beside them.
//
//   client.js      = src entry, verbatim, with its import declarations replaced by
//                    `const { a, b } = gadgetLib;`
//   client.lib.js  = `var gadgetLib = (() => { ... })();`, everything the entry imported. The
//                    platform (cloudflare-os/packages/workshop-backend/src/gadget-files.ts) loads it
//                    before client.js in the same module scope.
//   server.js      = src entry, verbatim, with its local imports pointed at "./server.lib.js"
//   server.lib.js  = an ESM bundle exporting exactly the names the entry imported.
//
// The in-Workshop agent's readFile returns whole files, so the file it edits must stay small and
// legible. See .agents/skills/author-adaptable-blueprints/SKILL.md.
//
// The entry's imports must be static top-level declarations. Library names are the entry's local
// binding names, so the entry reads the same before and after the rewrite.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export const CLIENT_LIBRARY_GLOBAL = "gadgetLib";
export const DEFAULT_ENTRY_BUDGET_BYTES = 64 * 1024;

const IMPORT_RE = /^[ \t]*import\s+(?:([\w$*{][^;]*?)\s+from\s+)?(["'])([^"']+)\2[ \t]*;?[ \t]*$/gm;
const EXPORT_FROM_RE = /^[ \t]*export\s+(\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?)\s+from\s+(["'])([^"']+)\2[ \t]*;?[ \t]*$/gm;

/**
 * The top-level static imports and re-exports of an ES module.
 * @param {string} source
 */
export function parseModuleImports(source) {
  /** @type {{start: number, end: number, specifier: string, bindings: {imported: string, local: string}[], kind: "import" | "export"}[]} */
  const decls = [];
  for (const m of source.matchAll(IMPORT_RE)) {
    decls.push({ start: m.index, end: m.index + m[0].length, specifier: m[3], bindings: m[1] ? parseImportClause(m[1]) : [], kind: "import" });
  }
  for (const m of source.matchAll(EXPORT_FROM_RE)) {
    if (m[1].startsWith("*")) throw new Error(`export * from "${m[3]}" is not supported in a gadget entry: name the exports`);
    decls.push({ start: m.index, end: m.index + m[0].length, specifier: m[3], bindings: parseNamedList(m[1]), kind: "export" });
  }
  return decls.toSorted((a, b) => a.start - b.start);
}

/** @param {string} clause */
function parseImportClause(clause) {
  const text = clause.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "").trim();
  /** @type {{imported: string, local: string}[]} */
  const out = [];
  const ns = text.match(/^(?:([\w$]+)\s*,\s*)?\*\s+as\s+([\w$]+)$/);
  if (ns) {
    if (ns[1]) out.push({ imported: "default", local: ns[1] });
    out.push({ imported: "*", local: ns[2] });
    return out;
  }
  const m = text.match(/^(?:([\w$]+)\s*(?:,\s*)?)?(\{[\s\S]*\})?$/);
  if (!m) throw new Error(`cannot parse import clause: ${clause}`);
  if (m[1]) out.push({ imported: "default", local: m[1] });
  if (m[2]) out.push(...parseNamedList(m[2]));
  return out;
}

/** @param {string} braces */
function parseNamedList(braces) {
  return braces.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "").replace(/^\{|\}$/g, "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    if (s.startsWith("type ")) throw new Error(`type-only import in a JS entry: ${s}`);
    const [imported, local = imported] = s.split(/\s+as\s+/).map((x) => x.trim());
    return { imported, local };
  });
}

/**
 * Source for the library's entry module: re-exports every binding the gadget entry imports,
 * under the entry's local name.
 * @param {ReturnType<typeof parseModuleImports>} decls
 */
export function libraryEntrySource(decls) {
  const lines = [];
  for (const d of decls) {
    if (d.bindings.length === 0) { lines.push(`import ${JSON.stringify(d.specifier)};`); continue; }
    const named = [];
    for (const b of d.bindings) {
      if (b.imported === "*") lines.push(`export * as ${b.local} from ${JSON.stringify(d.specifier)};`);
      else named.push(b.imported === b.local ? b.local : `${b.imported} as ${b.local}`);
    }
    if (named.length) lines.push(`export { ${named.join(", ")} } from ${JSON.stringify(d.specifier)};`);
  }
  return lines.join("\n") + "\n";
}

/**
 * @param {string} source
 * @param {ReturnType<typeof parseModuleImports>} decls  the declarations to replace
 * @param {(decls: ReturnType<typeof parseModuleImports>) => string} replacement  text for the first
 */
function replaceDeclarations(source, decls, replacement) {
  if (decls.length === 0) return source;
  let out = "";
  let at = 0;
  decls.forEach((d, i) => {
    out += source.slice(at, d.start) + (i === 0 ? replacement(decls) : "");
    at = d.end;
    // Drop the now-empty line.
    if (i > 0 && source[at] === "\n" && (d.start === 0 || source[d.start - 1] === "\n")) at++;
  });
  return out + source.slice(at);
}

/** @param {string} source */
function assertNoModuleSyntaxLeft(source, file) {
  const left = source.match(/^[ \t]*(import\s+[\w${*"']|export\s+(\{|\*)[^\n]*from\s)/m);
  if (left) throw new Error(`${file}: unsupported module syntax left after rewriting: ${left[0].trim()}`);
}

/**
 * Writes client.js (readable entry) and client.lib.js (bundle) to outDir.
 * @param {object} o
 * @param {typeof import("esbuild")} o.esbuild
 * @param {string} o.entry  absolute path of the hand-written entry
 * @param {string} o.outDir
 * @param {string} o.banner  first line(s) of client.js: what this gadget is and where its source lives
 * @param {object} [o.library]  extra esbuild options for client.lib.js (minify, define, plugins, ...)
 * @param {number} [o.budgetBytes]
 */
export async function buildClientEntry({ esbuild, entry, outDir, banner, library = {}, budgetBytes = DEFAULT_ENTRY_BUDGET_BYTES }) {
  const source = await readFile(entry, "utf8");
  const decls = parseModuleImports(source);
  if (decls.some((d) => d.kind === "export")) throw new Error(`${entry}: a client entry does not export`);
  if (/(?<![\w.])import\s*\(/.test(withoutComments(source))) throw new Error(`${entry}: dynamic import() cannot load in the gadget iframe`);
  const names = decls.flatMap((d) => d.bindings.map((b) => b.local));
  const client = banner.trimEnd() + "\n" + replaceDeclarations(source, decls, () =>
    `// From client.lib.js, the prebuilt library the platform loads before this file. Do not edit\n` +
    `// that file; README.md ("Adapting this gadget") documents these names.\n` +
    (names.length ? `const { ${names.join(", ")} } = ${CLIENT_LIBRARY_GLOBAL};` : `/* nothing imported */`));
  assertNoModuleSyntaxLeft(client, "client.js");
  await esbuild.transform(client, { loader: "js", format: "esm", target: "es2022" });
  checkBudget("client.js", client, budgetBytes);

  await mkdir(outDir, { recursive: true });
  const lib = await esbuild.build({
    bundle: true, target: "es2022", legalComments: "none", charset: "utf8", logLevel: "warning", platform: "browser",
    ...library,
    stdin: { contents: libraryEntrySource(decls), resolveDir: dirname(entry), sourcefile: "client.lib.js", loader: "js" },
    format: "iife",
    globalName: CLIENT_LIBRARY_GLOBAL,
    write: false,
  });
  const libCode = libraryBanner("client", entry) + lib.outputFiles[0].text;
  await writeFile(join(outDir, "client.js"), client);
  await writeFile(join(outDir, "client.lib.js"), libCode);
  return { names, clientBytes: Buffer.byteLength(client), libraryBytes: Buffer.byteLength(libCode) };
}

/**
 * Writes server.js (readable entry) and server.lib.js (bundle) to outDir. `cloudflare:` imports
 * stay in server.js; every other import and re-export is served from server.lib.js.
 * @param {object} o
 * @param {typeof import("esbuild")} o.esbuild
 * @param {string} o.entry
 * @param {string} o.outDir
 * @param {string} o.banner
 * @param {object} [o.library]
 * @param {number} [o.budgetBytes]
 */
export async function buildServerEntry({ esbuild, entry, outDir, banner, library = {}, budgetBytes = DEFAULT_ENTRY_BUDGET_BYTES }) {
  const source = await readFile(entry, "utf8");
  const decls = parseModuleImports(source).filter((d) => !d.specifier.startsWith("cloudflare:"));
  if (/(?<![\w.])import\s*\(/.test(withoutComments(source))) throw new Error(`${entry}: use static imports in a server entry`);
  const imports = decls.filter((d) => d.kind === "import");
  const reexports = decls.filter((d) => d.kind === "export");
  const importNames = imports.flatMap((d) => d.bindings.map((b) => b.local));
  const exportNames = reexports.flatMap((d) => d.bindings.map((b) => b.local));
  const server = banner.trimEnd() + "\n" + replaceDeclarations(source, decls, () => [
    `// From server.lib.js, the prebuilt library bundled from this gadget's source. Do not edit it;`,
    `// README.md ("Adapting this gadget") documents these names.`,
    ...(imports.some((d) => d.bindings.length === 0) || importNames.length ? [`import { ${importNames.join(", ")} } from "./server.lib.js";`] : []),
    ...(exportNames.length ? [`export { ${exportNames.join(", ")} } from "./server.lib.js";`] : []),
  ].join("\n"));
  await esbuild.transform(server, { loader: "js", format: "esm", target: "es2022" });
  checkBudget("server.js", server, budgetBytes);

  await mkdir(outDir, { recursive: true });
  const lib = await esbuild.build({
    bundle: true, target: "es2022", legalComments: "none", charset: "utf8", logLevel: "warning", platform: "neutral",
    external: ["cloudflare:*"],
    ...library,
    stdin: { contents: libraryEntrySource(decls), resolveDir: dirname(entry), sourcefile: "server.lib.js", loader: "js" },
    format: "esm",
    write: false,
  });
  const libCode = libraryBanner("server", entry) + lib.outputFiles[0].text;
  await writeFile(join(outDir, "server.js"), server);
  await writeFile(join(outDir, "server.lib.js"), libCode);
  return { names: [...importNames, ...exportNames], serverBytes: Buffer.byteLength(server), libraryBytes: Buffer.byteLength(libCode) };
}

/** Source with comments blanked, for syntax checks (JSDoc types say `import("…")`). */
function withoutComments(/** @type {string} */ source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/** The platform's client code for a gadget: library, then client.js, in one module (gadget-files.ts). */
export function assembleClientCode(client, library) {
  return library && library.trim() ? `${library}\n;\n${client}` : client;
}

function libraryBanner(kind, entry) {
  const pkg = entry.match(/packages\/[^/]+/)?.[0] ?? "this gadget's source package";
  return `// Prebuilt ${kind} library for ${kind}.js, bundled from ${pkg}. Generated: do not edit or read;\n` +
    `// change ${kind}.js instead, or rebuild from source.\n`;
}

function checkBudget(file, code, budget) {
  const bytes = Buffer.byteLength(code);
  if (bytes > budget) throw new Error(`${file} is ${bytes} bytes; a readable entry must stay within ${budget}. Move stable code into a module it imports.`);
}
