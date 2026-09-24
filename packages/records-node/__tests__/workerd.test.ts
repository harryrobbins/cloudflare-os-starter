// Plan §11.8, "the service passes its contract suite on Workers and on Node against the same
// database": this file owns the database and the Node server, then runs the workerd half
// (vitest.workerd.config.ts) as a child process pointed at the same database, and finally checks
// through Node what the Worker wrote.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, expect, inject, it } from "vitest";

import { startContractStack, worldInfo, type ContractStack } from "./support/world.js";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
let stack: ContractStack;

beforeAll(async () => {
  stack = await startContractStack(inject("pgSuperuserUrl"));
});
afterAll(async () => stack?.close());

function runWorkerdSuite(extraEnv: Record<string, string>): Promise<{ code: number | null; output: string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("VITEST") && k !== "NODE_ENV") env[k] = v;
  Object.assign(env, extraEnv);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(packageDir, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.workerd.config.ts"], { cwd: packageDir, env });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    // Never leave workerd running if this test is abandoned.
    const timer = setTimeout(() => child.kill("SIGTERM"), 200_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

it("passes the contract suite inside workerd against the Node server's database", async () => {
  const t = await stack.target();
  const headers = { "cf-access-jwt-assertion": t.accessAssertion, authorization: `Bearer ${t.credential}`, "content-type": "application/json" };
  const issuesUrl = `${stack.baseUrl}/gatekeeper/records/v1/datastores/${t.datastoreId}/issues`;
  const created = await fetch(issuesUrl, { method: "POST", headers: { ...headers, "idempotency-key": `node-${crypto.randomUUID()}` }, body: JSON.stringify({ projectId: t.projectId, title: "Created on Node" }) });
  expect(created.status).toBe(201);
  const shared = (await created.json()) as { id: string };

  const { code, output } = await runWorkerdSuite({
    RECORDS_CONTRACT_WORKERD: JSON.stringify({
      appUrl: stack.world.db.appUrl,
      issuer: stack.access.issuer,
      audience: stack.access.audience,
      target: { ...worldInfo(stack.world), baseUrl: "https://records.workerd.test", accessAssertion: t.accessAssertion, sharedIssueId: shared.id },
    }),
  });
  if (code !== 0) console.log(output);
  expect(code, "workerd contract run failed (output above)").toBe(0);
  expect(output).toMatch(/Tests\s+\d+ passed/);

  // What the Worker wrote is what Node now serves.
  const after = await fetch(`${issuesUrl}/${shared.id}`, { headers });
  expect(after.headers.get("etag")).toBe('"r2"');
  expect(((await after.json()) as { title: string }).title).toBe("Edited on Workers");
}, 240_000);
