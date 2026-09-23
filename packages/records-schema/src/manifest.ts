// Builds the module manifest (module version, API versions, ordered migration checksums) that a
// published module bundle carries. Validated against the contract schema by the tests.

import { loadMigrations, MIGRATIONS_DIR } from "./migrate.ts";

export function projectsModuleManifest(dir = MIGRATIONS_DIR) {
  return {
    moduleId: "projects",
    version: "1.0.0",
    apiVersions: [1],
    features: ["issues", "comments", "workflow", "custom_fields"],
    schema: "projects",
    migrations: loadMigrations(dir).map(({ id, checksum }) => ({ id, checksum })),
  };
}
