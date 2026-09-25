// A process that loads the test cluster helpers must still exit with the code it set. embedded-postgres
// registers async-exit-hook, which answers `beforeExit` with process.exit(0); vitest reports a failed
// run through process.exitCode, so without the guard in testing.ts every failing Records suite exited
// 0 and `pnpm check` passed over it.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const testing = fileURLToPath(new URL("../src/testing.ts", import.meta.url));

it("keeps a failing exit code after loading embedded-postgres", () => {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(testing)}); process.exitCode = 3;`], {
    encoding: "utf8",
  });
  expect(child.stderr).toBe("");
  expect(child.status).toBe(3);
});

it("still exits 0 when nothing failed", () => {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(testing)});`], { encoding: "utf8" });
  expect(child.status).toBe(0);
});
