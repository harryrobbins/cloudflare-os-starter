// @ts-check
// Project board gadget server. It holds no business records: every read and write goes to the
// organisation's Records service through the RECORDS binding (see README.md). The only state kept
// here is the latest Records poke (a datastore clock value) in src/server/pokes.js.

import { DurableObject, RpcTarget, restore } from "cloudflare:workers";
import { PokeLog } from "./pokes.js";
import { createRecordsProxy } from "./proxy.js";

const HOOK_PARAMS = Object.freeze({ type: "records-poke" });
/** Hooks registered by earlier revisions of this board (`deliver: "changes"`). */
const LEGACY_HOOK_TYPE = "records-change";

/** Receives Records pokes (`RecordsPokeHook`), and legacy change notifications as nudges. */
class PokeReceiver extends RpcTarget {
  /** @param {PokeLog} pokes */
  constructor(pokes) {
    super();
    this.pokes = pokes;
  }
  /** @param {unknown} poke */
  poked(poke) { this.pokes.poked(poke); }
  changed() { this.pokes.nudge(); }
  resync() { this.pokes.nudge(); }
}

export class Gadget extends DurableObject {
  /** @param {DurableObjectState} ctx @param {any} env */
  constructor(ctx, env) {
    super(ctx, env);
    this.pokes = new PokeLog(/** @type {any} */ (ctx.storage).kv);
    this.proxy = createRecordsProxy(() => this.env, this.pokes,
      () => /** @type {any} */ (this.ctx).restore(HOOK_PARAMS));
  }

  /** Recreates the persistent hook callback whenever Records delivers a poke. */
  // @ts-ignore restore is a runtime-provided symbol
  [restore](/** @type {any} */ params) {
    if (params?.type === HOOK_PARAMS.type || params?.type === LEGACY_HOOK_TYPE) return new PokeReceiver(this.pokes);
    throw new Error("unknown restore params");
  }

  getSetup() { return this.proxy.getSetup(); }
  listProjects() { return this.proxy.listProjects(); }
  getWorkflow() { return this.proxy.getWorkflow(); }
  listAssignees() { return this.proxy.listAssignees(); }
  /** @param {any} input */
  listIssues(input) { return this.proxy.listIssues(input); }
  /** @param {string} issueId */
  getIssue(issueId) { return this.proxy.getIssue(issueId); }
  /** @param {any} input */
  listComments(input) { return this.proxy.listComments(input); }
  /** @param {any} request @param {any} options */
  syncPush(request, options) { return this.proxy.syncPush(request, options); }
  /** @param {any} request */
  syncPull(request) { return this.proxy.syncPull(request); }
  /** @param {number[]} actionIds */
  syncApprovals(actionIds) { return this.proxy.syncApprovals(actionIds); }
  requestLiveUpdates() { return this.proxy.requestLiveUpdates(); }
  getPokes() { return this.proxy.getPokes(); }
}
