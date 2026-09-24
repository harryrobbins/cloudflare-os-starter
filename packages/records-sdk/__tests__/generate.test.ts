// The committed SDK output matches what the generator makes from the current OpenAPI document.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { openApiDocument } from "../../gatekeeper-records/src/http/openapi.ts";
import { generatePython, generateTsClient, generateTsTypes } from "../scripts/codegen.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const STALE = "stale: run `pnpm -C packages/records-sdk generate`";

it("openapi.json is the current document", () => {
  expect(JSON.parse(read("openapi.json")), STALE).toEqual(JSON.parse(JSON.stringify(openApiDocument())));
});

it("the generated TypeScript and Python are current", () => {
  const doc = JSON.parse(read("openapi.json"));
  expect(read("src/generated/types.ts"), STALE).toBe(generateTsTypes(doc));
  expect(read("src/generated/client.ts"), STALE).toBe(generateTsClient(doc));
  expect(read("python/records_sdk/_generated.py"), STALE).toBe(generatePython(doc));
});
