// The sync endpoints' domain half: push and pull (canonical plan §6). Adapters (native HTTP, the
// gadget session) authenticate the caller and hand the request body over unchanged.

import type { CallerContext, PullResponse, PushResponse } from "@records/contracts";

import type { CommandBus } from "../bus/bus.js";
import type { Db } from "../db/context.js";
import { SyncPuller, type PullOptions } from "./pull.js";
import { SyncPusher, type PushOptions } from "./push.js";

export class SyncService {
  readonly #pusher: SyncPusher;
  readonly #puller: SyncPuller;

  constructor(db: Db, bus: CommandBus) {
    this.#pusher = new SyncPusher(db, bus);
    this.#puller = new SyncPuller(db);
  }

  push(caller: CallerContext, datastoreId: string, request: unknown, opts?: PushOptions): Promise<PushResponse> {
    return this.#pusher.push(caller, datastoreId, request, opts);
  }

  pull(caller: CallerContext, datastoreId: string, request: unknown, opts?: PullOptions): Promise<PullResponse> {
    return this.#puller.pull(caller, datastoreId, request, opts);
  }
}
