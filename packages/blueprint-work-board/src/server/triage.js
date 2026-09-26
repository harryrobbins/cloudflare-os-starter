// @ts-check
// Jev triage through the OPTIONAL `JEV` binding (the Jev decisions connector, jev://decisions).
// The board works without it; `triage()` then fails `not_connected:`. One `decide()` call per
// item, cached per item revision, rate-limited per gadget. Nothing is ever applied: the caller
// turns chosen suggestions into a proposal.

import { JEV_BINDING, TRIAGE_LIMITS, buildTriageRequest, readSuggestions } from "../shared/insights/triage.js";
import { itemByKey, personName } from "../shared/model/index.js";
import { PRIORITIES } from "../shared/model/work.js";

/** @param {string} message */
const invalid = (message) => new Error(`invalid_request: ${message}`);
const RATE = { perMinute: 60 };
const CACHE = 1000;

/**
 * @param {{ getEnv: () => any, queries: ReturnType<typeof import("./query.js").createQueryCache>, now?: () => number }} options
 */
export function createTriage({ getEnv, queries, now = () => Date.now() }) {
  /** @type {Map<string, any>} */
  const cache = new Map();
  let tokens = RATE.perMinute;
  let refilled = now();

  function take() {
    const t = now();
    tokens = Math.min(RATE.perMinute, tokens + ((t - refilled) / 60_000) * RATE.perMinute);
    refilled = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  }

  function jev() {
    const session = getEnv()?.[JEV_BINDING];
    if (!session || typeof session.decide !== "function") {
      throw new Error(`not_connected: Jev triage is optional: connect the Jev decisions connector as ${JEV_BINDING} in this gadget's Connections tab to use it.`);
    }
    return session;
  }

  return {
    /** Whether the optional Jev binding is connected. */
    available() { const s = getEnv()?.[JEV_BINDING]; return Boolean(s && typeof s.decide === "function"); },

    /**
     * Triage suggestions for up to 20 items: priority, state, labels and a possible duplicate,
     * each with Jev's probability. Only suggestions ≥ 0.5 are returned (preselect: ≥ 0.9).
     * @param {unknown} keys an item key or a list of keys
     */
    async triage(keys) {
      const list = typeof keys === "string" ? [keys] : keys;
      if (!Array.isArray(list) || !list.length || list.some((k) => typeof k !== "string")) throw invalid("triage takes an item key or a list of keys.");
      if (list.length > TRIAGE_LIMITS.keys) throw invalid(`triage takes at most ${TRIAGE_LIMITS.keys} items at a time.`);
      const session = jev();
      const ix = await queries.index();
      const results = [];
      /** @type {string[]} */
      const limited = [];
      let cost = 0;
      let model = null;
      for (const key of list) {
        const item = itemByKey(ix, key);
        if (!item) throw new Error(`not_found: No item ${key}.`);
        const cacheKey = `${item.id}:${item.revision}`;
        const hit = cache.get(cacheKey);
        if (hit) { results.push({ ...hit, cached: true }); continue; }
        if (!take()) { limited.push(item.key); continue; }
        const { request, meta } = buildTriageRequest(ix, item);
        let decision;
        try {
          decision = await session.decide(request);
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          throw new Error(`unavailable: Jev could not answer for ${item.key}: ${m.replace(/^[a-z_]+:\s*/, "")}`, { cause: err });
        }
        cost += Number(decision?.cost ?? 0) || 0;
        model = decision?.model ?? model;
        const { suggestions, hidden } = readSuggestions(ix, item, meta, decision?.answers ?? {});
        const current = {
          state: ix.stateByKey.get(item.state)?.name ?? item.state, priority: PRIORITIES[item.priority].name,
          labels: item.labels.map((l) => ix.labelByKey.get(l)?.name ?? l), assignee: item.assignee ? personName(ix, item.assignee) : null,
        };
        const result = { key: item.key, title: item.title, revision: item.revision, current, suggestions, hidden, cached: false };
        cache.set(cacheKey, result);
        while (cache.size > CACHE) cache.delete(/** @type {string} */ (cache.keys().next().value));
        results.push(result);
      }
      return {
        results, model, cost: Math.round(cost * 1e6) / 1e6,
        limited, ...(limited.length ? { message: `Jev is rate-limited on this board (about ${RATE.perMinute} items a minute); try ${limited.join(", ")} again shortly.` } : {}),
      };
    },
  };
}
