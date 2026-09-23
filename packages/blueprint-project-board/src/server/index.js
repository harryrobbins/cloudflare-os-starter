// @ts-check
// Project board gadget server. It holds no business records: every read and write goes to the
// organisation's Records service through the RECORDS binding (see README.md). The only state kept
// here is the change-notification log (identifiers and revisions) in src/server/feed.js.

import { DurableObject, RpcTarget, restore } from "cloudflare:workers";
import { ChangeFeed } from "./feed.js";
import { createRecordsProxy } from "./proxy.js";

const HOOK_PARAMS = Object.freeze({ type: "records-change" });

/** Receives Records change notifications (the `RecordsChangeHook` interface). */
class ChangeReceiver extends RpcTarget {
  /** @param {ChangeFeed} feed */
  constructor(feed) {
    super();
    this.feed = feed;
  }
  /** @param {unknown} changes */
  changed(changes) { this.feed.record(changes); }
  resync() { this.feed.resync(); }
}

export class Gadget extends DurableObject {
  /** @param {DurableObjectState} ctx @param {any} env */
  constructor(ctx, env) {
    super(ctx, env);
    const feed = new ChangeFeed(/** @type {any} */ (ctx.storage).kv);
    this.feed = feed;
    const proxy = createRecordsProxy(() => this.env, feed,
      () => /** @type {any} */ (this.ctx).restore(HOOK_PARAMS));
    this.proxy = proxy;
  }

  /** Recreates the persistent hook callback whenever Records delivers a change. */
  // @ts-ignore restore is a runtime-provided symbol
  [restore](/** @type {any} */ params) {
    if (params?.type === HOOK_PARAMS.type) return new ChangeReceiver(this.feed);
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
  /** @param {any} input @param {any} options */
  createIssue(input, options) { return this.proxy.createIssue(input, options); }
  /** @param {any} input @param {any} options */
  editIssue(input, options) { return this.proxy.editIssue(input, options); }
  /** @param {any} input @param {any} options */
  transitionIssue(input, options) { return this.proxy.transitionIssue(input, options); }
  /** @param {any} input @param {any} options */
  addComment(input, options) { return this.proxy.addComment(input, options); }
  /** @param {number} actionId */
  getWriteOutcome(actionId) { return this.proxy.getWriteOutcome(actionId); }
  requestLiveUpdates() { return this.proxy.requestLiveUpdates(); }
  /** @param {any} since */
  getChanges(since) { return this.proxy.getChanges(since); }
}
