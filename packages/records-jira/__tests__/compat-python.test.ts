// Python `jira` smoke test. Opt-in (RECORDS_JIRA_PYTHON=1): it runs `uv run --with jira`, which
// needs the package from PyPI or uv's cache. Findings are recorded in COMPATIBILITY.md.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createFakePort } from "./support/fake-port.js";
import { serve } from "./support/http.js";

const enabled = process.env.RECORDS_JIRA_PYTHON === "1";

describe.skipIf(!enabled)("python jira against the router", () => {
  it("connects, creates, edits, transitions, comments and searches", async () => {
    const fake = createFakePort();
    const log: string[] = [];
    const server = await serve(fake.port, {}, log);
    try {
      const script = fileURLToPath(new URL("./support/python_jira_smoke.py", import.meta.url));
      // Async spawn, so the in-process server can answer while Python runs.
      const run = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn("uv", ["run", "--quiet", "--with", "jira", "python", script, server.url], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      });
      if (process.env.JIRA_COMPAT_LOG) console.log(`${log.join("\n")}\n${run.stdout}\n${run.stderr}`);
      const results = JSON.parse(run.stdout.trim().split("\n").pop() ?? "[]") as { step: string; ok: boolean; error?: string }[];
      const failed = results.filter((r) => !r.ok);
      expect(failed, JSON.stringify(results, null, 1)).toEqual([]);
      expect(run.status).toBe(0);
    } finally {
      await server.close();
    }
  }, 120_000);
});
