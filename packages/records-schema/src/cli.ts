// Operator entrypoint: `node src/cli.ts <status|migrate|manifest|bootstrap>` with RECORDS_MIGRATION_URL set to
// the migration-owner credential. Never point this at a runtime (records_app) credential.

import postgres from "postgres";

import { bootstrapOrganisation } from "./bootstrap.ts";
import { projectsModuleManifest } from "./manifest.ts";
import { migrate, status } from "./migrate.ts";

const command = process.argv[2];
if (command === "manifest") {
  console.log(JSON.stringify(projectsModuleManifest(), null, 2));
  process.exit(0);
}
const url = process.env.RECORDS_MIGRATION_URL;
if (!url) {
  console.error("Set RECORDS_MIGRATION_URL to the migration owner's connection string.");
  process.exit(2);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  if (command === "status") {
    for (const m of await status(sql)) console.log(`${m.state.padEnd(8)} ${m.id} ${m.checksum.slice(0, 12)}`);
  } else if (command === "migrate") {
    const applied = await migrate(sql, undefined, (line) => console.log(line));
    console.log(applied.length ? `applied ${applied.length} migration(s)` : "up to date");
  } else if (command === "bootstrap") {
    // node src/cli.ts bootstrap "<organisation>" <admin e-mail> "<admin name>"
    const [orgName, adminEmail, adminName] = process.argv.slice(3);
    if (!orgName || !adminEmail || !adminName) throw new Error('usage: bootstrap "<organisation>" <admin e-mail> "<admin name>"');
    console.log(JSON.stringify(await bootstrapOrganisation(sql, { orgName, adminEmail, adminName })));
  } else {
    console.error("usage: node src/cli.ts <status|migrate|manifest|bootstrap>");
    process.exitCode = 2;
  }
} finally {
  await sql.end();
}
