// A deterministic stand-in for the Jev decisions connector (packages/gatekeeper-jev): `decide()`
// with the same request and answer shapes (types.d.ts), judging by keywords so tests and the
// harness get stable, plausible, calibrated-looking answers. Records every request.

/** @param {Record<string, number>} weights @returns {{ choice: string, probabilities: Record<string, number>, confidence: number }} */
function distribution(weights) {
  const total = Object.values(weights).reduce((s, w) => s + w, 0) || 1;
  const probabilities = Object.fromEntries(Object.entries(weights).map(([k, w]) => [k, Math.round((w / total) * 1000) / 1000]));
  const [choice] = Object.entries(probabilities).toSorted((a, b) => b[1] - a[1])[0];
  const sorted = Object.values(probabilities).toSorted((a, b) => b - a);
  return { choice, probabilities, confidence: Math.round((sorted[0] - (sorted[1] ?? 0)) * 1000) / 1000 };
}

/** @param {string} s */
const words = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3));

/**
 * @param {{ delayMs?: number, fail?: boolean }} [options]
 */
export function createFakeJev(options = {}) {
  /** @type {any[]} */
  const calls = [];
  return {
    calls,
    /** @param {{ state: any, questions: Record<string, any> }} request */
    async decide(request) {
      if (!request || typeof request !== "object" || !request.questions) throw new Error("decide() takes { state, questions }.");
      const keys = Object.keys(request.questions);
      if (!keys.length || keys.length > 32) throw new Error("1-32 questions.");
      calls.push(request);
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      if (options.fail) throw new Error("Jev is unavailable (fake).");
      const item = request.state?.item ?? {};
      const text = `${item.title ?? ""} ${item.description ?? ""}`.toLowerCase();
      /** @type {Record<string, any>} */
      const answers = {};
      for (const [key, q] of Object.entries(request.questions)) {
        if (q.type === "noul") {
          const label = /“([^”]+)”/.exec(String(q.instructions))?.[1]?.toLowerCase() ?? "";
          const hints = { bug: ["fix", "broken", "error", "crash", "redirect"], docs: ["document", "docs", "guide"], performance: ["speed", "slow", "faster", "lazy"], security: ["audit", "security", "permission", "sso"], design: ["redesign", "design", "dark", "contrast"], feature: ["add", "support"], improvement: ["improve", "refactor"] };
          const hit = (/** @type {Record<string, string[]>} */ (hints)[label] ?? [label]).some((w) => text.includes(w));
          answers[key] = { type: "noul", noul: hit ? 0.94 : label.length % 3 === 0 ? 0.62 : 0.12 };
        } else if (q.type === "choice") {
          const labels = Object.keys(q.criteria);
          /** @type {Record<string, number>} */
          const w = Object.fromEntries(labels.map((l) => [l, 1]));
          if (key === "priority") {
            if (/crash|security|outage|data loss|audit/.test(text)) w.urgent = 30;
            else if (/fix|broken|error|login|bug/.test(text)) w.high = 24;
            else if (/docs|document|copy|screenshot/.test(text)) w.low = 16;
            else w.medium = 8;
          } else if (key === "state") {
            const pick = labels.find((l) => /Backlog/.test(q.criteria[l])) ?? labels[0];
            const todo = labels.find((l) => /Todo/.test(q.criteria[l]));
            w[/fix|broken|urgent|login/.test(text) && todo ? todo : pick] = 14;
          } else if (key === "duplicate") {
            const mine = words(item.title ?? "");
            let best = "none", score = 0;
            for (const l of labels.filter((x) => x !== "none")) {
              const theirs = words(String(q.criteria[l]).replace(/^.*?: /, ""));
              const n = [...mine].filter((x) => theirs.has(x)).length / Math.max(1, Math.min(mine.size, theirs.size));
              if (n > score) { score = n; best = l; }
            }
            w[score >= 0.99 ? best : "none"] = score >= 0.99 ? 40 : 12;
          } else w[labels[0]] = 5;
          answers[key] = { type: "choice", ...distribution(w) };
        } else if (q.type === "score") {
          answers[key] = { type: "score", score: 1, probabilities: { 0: 0.2, 1: 0.6, 2: 0.2 }, confidence: 0.4 };
        }
      }
      return { answers, model: "fake-jev", cost: 0.0001 * keys.length };
    },
  };
}
