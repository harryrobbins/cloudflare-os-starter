// The Records service: one authoritative set of domain operations behind every adapter. Portable:
// postgres.js over any Postgres URL (Hyperdrive on Workers, a direct connection on Node).

import postgres from "postgres";

import { CommandBus } from "../bus/bus.js";
import { JournalReader } from "../bus/changes.js";
import type { BusHooks } from "../bus/commit.js";
import type { Db } from "../db/context.js";
import { SyncService } from "../sync/service.js";
import { ProjectsService } from "./projects.js";
import { RegistryService } from "./registry.js";

export class RecordsService {
  readonly registry: RegistryService;
  readonly projects: ProjectsService;
  /** Every journaled write goes through this bus; `projects` wraps it for the v1 adapters. */
  readonly commands: CommandBus;
  /** The change feed and entity history. */
  readonly journal: JournalReader;
  /** Sync push and pull over the same bus and journal. */
  readonly sync: SyncService;

  constructor(readonly db: Db, hooks: BusHooks = {}) {
    this.commands = new CommandBus(db, hooks);
    this.registry = new RegistryService(db);
    this.projects = new ProjectsService(db, this.commands);
    this.journal = new JournalReader(db);
    this.sync = new SyncService(db, this.commands);
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
