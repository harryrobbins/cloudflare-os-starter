// The Records service: one authoritative set of domain operations behind every adapter.

import postgres from "postgres";

import type { Db } from "../db/context.js";
import { ProjectsService } from "./projects.js";
import { RegistryService } from "./registry.js";

export class RecordsService {
  readonly registry: RegistryService;
  readonly projects: ProjectsService;

  constructor(readonly db: Db) {
    this.registry = new RegistryService(db);
    this.projects = new ProjectsService(db);
  }
}

/**
 * Connect through Hyperdrive (or any Postgres URL in tests). Hyperdrive query caching must be
 * disabled for this configuration: permission and registry reads have to be fresh.
 */
export function connect(connectionString: string, opts: { max?: number } = {}): Db {
  return postgres(connectionString, {
    max: opts.max ?? 5,
    // Hyperdrive pools; each Worker invocation should not hold connections open.
    idle_timeout: 5,
    // Needed to parse array columns (scopes, api_versions); one catalogue query per connection.
    fetch_types: true,
    prepare: true,
    onnotice: () => {},
  }) as unknown as Db;
}
