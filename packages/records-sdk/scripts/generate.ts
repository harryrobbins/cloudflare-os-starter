// Generate the Records SDKs from the OpenAPI document.
//
//   node scripts/generate.ts                 read the live document from gatekeeper-records'
//                                            src/http/openapi.ts (loaded through Vite's module
//                                            runner, which resolves the workspace's TypeScript)
//   node scripts/generate.ts <file|url>      read a saved or served openapi.json instead
//
// Writes openapi.json (the snapshot the output was generated from), src/generated/{types,client}.ts
// and python/records_sdk/_generated.py. __tests__/generate.test.ts fails when any of them is stale.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { generatePython, generateTsClient, generateTsTypes } from "./codegen.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const OPENAPI_SOURCE = join(root, "../gatekeeper-records/src/http/openapi.ts");

async function liveDocument(): Promise<any> {
  const { runnerImport } = await import("vite");
  const { module } = await runnerImport<{ openApiDocument(): unknown }>(OPENAPI_SOURCE);
  return module.openApiDocument();
}

async function readDocument(source: string | undefined): Promise<any> {
  if (!source) return liveDocument();
  if (/^https?:\/\//.test(source)) return (await fetch(source)).json();
  return JSON.parse(readFileSync(source, "utf8"));
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  console.log(`wrote ${path.slice(root.length + 1)}`);
}

const document = await readDocument(process.argv[2]);
write(join(root, "openapi.json"), `${JSON.stringify(document, null, 2)}\n`);
write(join(root, "src/generated/types.ts"), generateTsTypes(document));
write(join(root, "src/generated/client.ts"), generateTsClient(document));
write(join(root, "python/records_sdk/_generated.py"), generatePython(document));
