// An in-memory stand-in for the gadget server + Records connector: a work datastore with a journal,
// viewer assertions checked against the connector's own digest, and approval-gated commands.
import { recordsOsIntentDigest } from "../../records-service/src/cloudflare-os.ts";

export const CONNECTION = {
  url: "records-service://datastore/7c1e4b52-3a0d-4d7e-9b1f-2f6a8c9d0e11/work/v1/write",
  datastore: "7c1e4b52-3a0d-4d7e-9b1f-2f6a8c9d0e11", binding: "b-1", label: "Team work",
  moduleId: "work", apiMajor: 1, access: "write", scopes: ["work.read", "work.write"],
};

export class FakeWork {
  constructor({ items = [], access = "write", module = "work", epoch = 1 } = {}) {
    this.seq = 0;
    this.epoch = epoch;
    this.rows = new Map();
    this.journal = [];
    this.actions = new Map();
    this.assertions = new Map();
    this.connection = { ...CONNECTION, access };
    this.module = module;
    this.calls = [];
    for (const data of items) this.#commit(crypto.randomUUID(), { status: "open", description: "", extensions: {}, ...data });
  }
  #commit(id, data) {
    this.seq += 1;
    const row = { id, entity: "work_item", revision: this.seq, data };
    this.rows.set(id, row);
    this.journal.push({ seq: this.seq, ordinal: 0, entity: "work_item", record_id: id, revision: this.seq, data });
    return row;
  }
  /** Someone else writes directly (another board, an API client). */
  external(id, changes) { const row = this.rows.get(id); return this.#commit(id, { ...row.data, ...changes }); }
  approve(actionId) {
    const action = this.actions.get(actionId);
    const { command, input, options } = action;
    if (command === "work.create") {
      action.outcome = { status: "applied", result: { record: this.#commit(crypto.randomUUID(), { status: "open", description: "", extensions: {}, ...input }) } };
    } else {
      const row = this.rows.get(input.id);
      if (row.revision !== options.revision) { action.outcome = { status: "rejected", reason: "Records refused the command (412)" }; return; }
      const { id, ...changes } = input;
      action.outcome = { status: "applied", result: { record: this.#commit(id, { ...row.data, ...changes }) } };
    }
  }
  gadget() {
    const self = this;
    return {
      async getSetup() {
        return { connected: true, connection: self.connection, description: { id: CONNECTION.datastore, module_id: self.module, api_major: 1, permission_epoch: self.epoch, granted_scopes: self.connection.scopes, modules: [] }, error: null };
      },
      async snapshot(limit) { self.calls.push(["snapshot", limit]); return { records: [...self.rows.values()], seq: self.seq, permission_epoch: self.epoch, complete: true }; },
      async changes(after, epoch) {
        self.calls.push(["changes", after, epoch]);
        if (epoch !== undefined && epoch !== self.epoch) throw new Error("reset_required: The datastore's permissions changed.");
        const page = self.journal.filter((c) => c.seq > after).slice(0, 100);
        return { changes: page, cursor: page.at(-1)?.seq ?? after, permission_epoch: self.epoch };
      },
      async $createViewerAssertion(binding, digest) { const token = `a-${self.assertions.size + 1}`; self.assertions.set(token, { binding, digest }); return token; },
      async command(command, input, options) {
        const asserted = self.assertions.get(options.viewerAssertion);
        self.assertions.delete(options.viewerAssertion);
        const digest = await recordsOsIntentDigest({
          datastore: self.connection.datastore, binding: self.connection.binding, moduleId: "work", apiMajor: 1, command, input,
          expectedRevision: options.revision ?? null, idempotencyKey: options.idempotencyKey,
        });
        if (!asserted || asserted.binding !== "RECORDS" || asserted.digest !== digest) throw new Error("forbidden: assertion mismatch");
        const actionId = self.actions.size + 1;
        self.actions.set(actionId, { command, input, options });
        return { status: "pending", actionId };
      },
      async getOutcome(actionId) { return self.actions.get(actionId)?.outcome ?? { status: "pending", actionId }; },
    };
  }
}
