// @ts-check
// A gadget-local record of Records pokes, so browser tabs can ask "has the datastore moved?"
// cheaply (a gadget-local read, not a Records read) and then pull by seq.
//
// Records calls the persistent hook's `poked({datastoreId, head})` after each commit, best effort.
// Only the highest head is kept (no record content, no identifiers). A hook registered by an
// earlier version of this gadget with `deliver: "changes"` calls `changed`/`resync` instead; those
// bump `nudges`, which tells tabs to pull without knowing the head.

export const POKES_KEY = "records-pokes";

/**
 * @typedef {{requested: boolean, requestedAt: string|null, lastDeliveryAt: string|null,
 *   datastoreId: string|null, head: number|null, nudges: number}} PokeState
 * @typedef {{get(key: string): any, put(key: string, value: any): void}} SyncKv
 * @typedef {{live: "off"|"requested"|"active", head: number|null, nudges: number,
 *   datastoreId: string|null, lastDeliveryAt: string|null}} PokeSummary
 */

/** @returns {PokeState} */
function fresh() {
  return { requested: false, requestedAt: null, lastDeliveryAt: null, datastoreId: null, head: null, nudges: 0 };
}

export class PokeLog {
  /** @param {SyncKv} kv @param {() => Date} [now] */
  constructor(kv, now = () => new Date()) {
    this.kv = kv;
    this.now = now;
  }

  /** @returns {PokeState} */
  state() {
    const saved = this.kv.get(POKES_KEY);
    return saved && typeof saved.nudges === "number" ? saved : fresh();
  }

  /** @param {PokeState} state */
  #save(state) {
    this.kv.put(POKES_KEY, state);
  }

  markRequested() {
    const state = this.state();
    state.requested = true;
    state.requestedAt = this.now().toISOString();
    this.#save(state);
  }

  /** @param {unknown} poke `{datastoreId, head}` from the hook; untrusted shape, so checked. */
  poked(poke) {
    const { datastoreId, head } = /** @type {any} */ (poke && typeof poke === "object" ? poke : {});
    if (typeof head !== "number" || !Number.isSafeInteger(head) || head < 0) return;
    const state = this.state();
    if (typeof datastoreId === "string" && state.datastoreId !== null && datastoreId !== state.datastoreId) {
      // Another datastore (the binding was reconnected): its clock is unrelated to the old one.
      state.datastoreId = datastoreId;
      state.head = head;
      state.nudges += 1;
    } else if (state.head === null || head > state.head) {
      state.head = head;
    }
    if (typeof datastoreId === "string") state.datastoreId = datastoreId;
    state.lastDeliveryAt = this.now().toISOString();
    this.#save(state);
  }

  /** A legacy change notification (`changed` or `resync`): pull, head unknown. */
  nudge() {
    const state = this.state();
    state.nudges += 1;
    state.lastDeliveryAt = this.now().toISOString();
    this.#save(state);
  }

  /** @returns {PokeSummary} */
  summary() {
    const s = this.state();
    return {
      live: s.lastDeliveryAt ? "active" : s.requested ? "requested" : "off",
      head: s.head, nudges: s.nudges, datastoreId: s.datastoreId, lastDeliveryAt: s.lastDeliveryAt,
    };
  }
}
