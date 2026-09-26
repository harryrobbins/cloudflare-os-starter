// @ts-check
// Applying a proposal: each chosen change goes through the store's normal write path, so the
// Workshop asks the signed-in person for a viewer assertion and Records attributes the change to
// them. A change is applied only against the revision it was proposed for; if the item moved on
// it "needs refresh" (the gadget server rebases it on request).

/**
 * @typedef {import("./store.js").Store} Store
 * @typedef {import("./store.js").Change} Change
 * @typedef {"ready"|"stale"|"noop"|"invalid"|"sent"|"pending"|"applied"|"conflict"|"rejected"} ChangeState
 */

const DONE = new Set(["sent", "pending", "applied"]);

/**
 * Where one proposed change stands for this viewer: its live store change (sent this session)
 * wins, then the recorded outcome, then whether it can still be applied.
 * @param {Store} store @param {any} change @param {Change|null} [live]
 * @returns {{ state: ChangeState, text: string, selectable: boolean }}
 */
export function changeState(store, change, live = null) {
  if (live) {
    const map = { saving: ["sent", "Sending…"], pending: ["pending", "Awaiting approval"], applied: ["applied", "Saved"], conflict: ["conflict", `Not saved: ${live.message}`], rejected: ["rejected", `Not saved: ${live.message}`] };
    const [state, text] = map[live.status];
    return { state: /** @type {ChangeState} */ (state), text, selectable: state === "rejected" };
  }
  const o = change.outcome;
  if (o && DONE.has(o.status)) return { state: o.status, text: o.status === "applied" ? `Saved${o.by ? ` · applied by ${o.by}` : ""}` : `Sent${o.by ? ` by ${o.by}` : ""}, awaiting approval`, selectable: false };
  if (change.noop) return { state: "noop", text: "Already done", selectable: false };
  if (change.error) return { state: "invalid", text: `Can't apply: ${change.error}`, selectable: false };
  if (isStale(store, change)) return { state: "stale", text: "Needs refresh: the item changed since this was proposed", selectable: false };
  if (o && (o.status === "conflict" || o.status === "rejected")) return { state: o.status, text: `Not saved last time${o.message ? `: ${o.message}` : ""}. Select to try again.`, selectable: true };
  return { state: "ready", text: "Ready", selectable: true };
}

/** @param {Store} store @param {any} change */
export function isStale(store, change) {
  const ix = store.index();
  if (change.command === "work.update") {
    const item = ix.items.get(change.item_id);
    return !item || item.revision !== change.revision;
  }
  if (change.command === "work.relation.update") {
    const rel = ix.relations.find((r) => r.id === change.item_id);
    return !rel || rel.revision !== change.revision;
  }
  return false;
}

/**
 * Sends the chosen changes. Returns per-change results and the outcomes to record.
 * @param {Store} store @param {any} proposal @param {number[]} ns change numbers
 */
export function applyProposal(store, proposal, ns) {
  const group = `proposal-${proposal.id}-${Date.now().toString(36)}`;
  /** @type {{ n: number, ok: boolean, change: Change|null, error: string|null }[]} */
  const results = [];
  for (const n of ns) {
    const c = proposal.changes.find((/** @type {any} */ x) => x.n === n);
    if (!c) continue;
    const state = changeState(store, c);
    if (!state.selectable) { results.push({ n, ok: false, change: null, error: state.text }); continue; }
    const label = c.text;
    /** @type {{ ok: true, change: Change|null } | { ok: false, error: string }} */
    let r;
    if (c.command === "work.update") {
      const item = store.index().items.get(c.item_id);
      if (!item) { results.push({ n, ok: false, change: null, error: "The item is no longer on the board." }); continue; }
      const { id: _id, ...patch } = c.input;
      r = store.updateItem(item, patch, { label, group, undoable: false });
    } else if (c.command === "work.create") {
      r = store.createItem({ ...c.input }, { label, group });
    } else {
      r = store.entity(c.command, { ...c.input }, { label, revision: c.revision, itemId: c.item_id });
    }
    results.push(r.ok ? { n, ok: true, change: r.change, error: r.change ? null : "Already done" } : { n, ok: false, change: null, error: r.error });
  }
  const outcomes = results.map((r) => (r.ok
    ? { n: r.n, status: r.change ? "sent" : "noop", message: "" }
    : { n: r.n, status: "rejected", message: r.error ?? "" }));
  return { results, outcomes, group };
}

/** A store change's status as a recorded proposal outcome. @param {Change} ch */
export function outcomeOf(ch) {
  const status = ch.status === "saving" ? "sent" : ch.status;
  return { status, message: ch.status === "conflict" || ch.status === "rejected" ? ch.message : "", actionId: ch.actionId };
}
