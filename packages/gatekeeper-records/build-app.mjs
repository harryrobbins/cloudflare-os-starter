// Build the Data management SPA (app/) into one inlined HTML file for startAppUi().
//
// One-shot only. `--dev` builds unminified (for debugging the bundle); there is deliberately no
// `--watch`: this laptop overheats under repo watchers, and the Worker imports the generated file.
//
// Output: src/generated/app.txt (the HTML) and src/generated/app.ts (`export const APP_HTML`).

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = dirname(fileURLToPath(import.meta.url));
const dev = process.argv.includes("--dev");
const require = createRequire(import.meta.url);
const viteBin = resolve(dirname(require.resolve("vite/package.json")), "bin", "vite.js");

console.log(`building Data management app single-file bundle${dev ? " (unminified)" : ""}…`);
execFileSync(process.execPath, [viteBin, "build", "-c", "vite.app.config.ts"], {
  cwd: pkgDir,
  stdio: "inherit",
  // Always explicit, so an inherited value cannot make a production build unminified.
  env: { ...process.env, GATEKEEPER_APP_UNMINIFIED: dev ? "true" : "false" },
});
