#!/usr/bin/env node
// Run the Records service on Node from environment variables (see src/main.ts for the list):
//
//   RECORDS_DATABASE_URL=postgres://records_app_login:…@db:5432/records \
//   RECORDS_ACCESS_ISSUER=https://team.cloudflareaccess.com RECORDS_ACCESS_AUDIENCE=… \
//   node packages/records-node/bin/records-node.mjs
//
// The workspace ships TypeScript sources, not builds; ./ts-hooks.mjs lets plain Node load them.
// Prints one JSON line `{"event":"records.node.listening","url":…}` when ready; SIGINT/SIGTERM
// drain and exit.

import "./ts-hooks.mjs";

const { startFromEnv } = await import("../src/main.ts");

try {
  const { server, url } = await startFromEnv(process.env);
  console.log(JSON.stringify({ event: "records.node.listening", url }));
  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ event: "records.node.stopping", signal }));
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
} catch (err) {
  console.error(JSON.stringify({ event: "records.node.failed", error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
}
