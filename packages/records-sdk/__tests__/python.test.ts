// The Python SDK's tests (stdlib unittest) against a real Node server started here.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, expect, it } from "vitest";

import { startServer, type ContractStack } from "./support.js";

const pythonDir = join(dirname(fileURLToPath(import.meta.url)), "../python");
let stack: ContractStack;

beforeAll(async () => {
  stack = await startServer();
});
afterAll(async () => stack?.close());

it("passes the Python SDK tests", async () => {
  const env = {
    ...process.env,
    RECORDS_TEST_BASE_URL: stack.baseUrl,
    RECORDS_TEST_DATASTORE_ID: stack.world.datastoreId,
    RECORDS_TEST_PROJECT_ID: stack.world.projectId,
    RECORDS_TEST_CREDENTIAL: stack.world.credential,
    RECORDS_TEST_READONLY_CREDENTIAL: stack.world.readOnlyCredential,
    RECORDS_TEST_ACCESS_ASSERTION: await stack.access.sign(),
  };
  const python = process.env.RECORDS_PYTHON ?? "python3";
  const { code, output } = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(python, ["-m", "unittest", "discover", "-v", "-s", "tests", "-t", "."], { cwd: pythonDir, env });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", reject);
    child.on("close", (c) => resolve({ code: c, output }));
  });
  if (code !== 0) console.log(output);
  expect(code, "python unittest failed (output above)").toBe(0);
  expect(output).toMatch(/^OK/m);
  expect(output).not.toMatch(/skipped '/);
}, 120_000);
