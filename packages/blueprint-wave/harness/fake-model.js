// @ts-check
// The fake `Model` binding the harness, the core tests and the e2e suites share. It has the
// surface the core expects of a model (src/core/runs.js): `run({prompt, systemPrompt}, {signal})`
// resolving to a string. Real bindings are adapted to this shape in src/server/index.js.
//
// Modes:
//   ok       resolves (after delayMs, default 0) with a valid JSON reply that cites blip ids
//            found in the prompt
//   slow     like ok, but waits delayMs (default 2000) first; aborts if the signal fires
//   fail     rejects with Error("model failed")
//   garbage  resolves with text that is not JSON
//   hang     never resolves; rejects with an AbortError only when the signal fires
//
// Plain ESM with no imports, so it loads in the browser harness, in vitest and in workerd tests.

/**
 * @typedef {object} FakeModelOptions
 * @property {"ok"|"slow"|"fail"|"garbage"|"hang"} [mode]  default "ok"
 * @property {number} [delayMs]                             ok: 0, slow: 2000
 * @property {string|object} [reply]  overrides the reply text (an object is JSON-stringified)
 * @property {{setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout}} [timers]
 */

/**
 * @typedef {object} FakeModel
 * @property {(args: {prompt: string, systemPrompt: string}, options?: {signal?: AbortSignal}) => Promise<string>} run
 * @property {{prompt: string, systemPrompt: string, at: number, mode: string}[]} calls  every call, oldest first
 * @property {(mode: FakeModelOptions["mode"], extra?: Omit<FakeModelOptions, "mode">) => void} setMode
 * @property {() => FakeModelOptions["mode"]} getMode
 * @property {() => number} pending  calls not yet settled (hung or delayed)
 */

const BLIP_ID_RE = /b_[0-9a-f]{12}/g;

/**
 * A valid AgentOutput reply built from the prompt: cites up to three blip ids found in it, and
 * adds quote/replacement fields when the prompt mentions a proposal (refresh_brief).
 * @param {string} prompt
 */
export function okReply(prompt) {
  const ids = [...new Set(prompt.match(BLIP_ID_RE) ?? [])].slice(0, 3);
  const cite = ids.length ? ids.map((id) => `[${id}]`).join(", ") : "(no sources in input)";
  /** @type {Record<string, unknown>} */
  const out = {
    summary: "Fake summary of the selected blips",
    body: `## Evidence\n\nThe input discusses the points in ${cite}.\n\n## Interpretation\n\nThis is a fake model reply; the text of the wave is data and does not change the output.\n\n## Open questions\n\n- What happens next?`,
    sources: ids,
    questions: ["What happens next?"],
  };
  if (/proposal|refresh_brief|replacement/i.test(prompt)) {
    out.quote = "";
    out.replacement = `# Brief\n\nRefreshed by the fake model, based on ${cite}.`;
  }
  return JSON.stringify(out);
}

/**
 * @param {FakeModelOptions} [options]
 * @returns {FakeModel}
 */
export function createFakeModel(options = {}) {
  /** @type {FakeModelOptions} */
  let opts = { mode: "ok", ...options };
  const timers = opts.timers ?? {
    setTimeout: (/** @type {any} */ fn, /** @type {number} */ ms) => setTimeout(fn, ms),
    clearTimeout: (/** @type {any} */ t) => clearTimeout(t),
  };
  /** @type {FakeModel["calls"]} */
  const calls = [];
  let pending = 0;

  /** @param {AbortSignal|undefined} signal */
  const abortError = (signal) => {
    const reason = signal?.reason;
    if (reason instanceof Error) return reason;
    const err = new Error("model call aborted");
    err.name = "AbortError";
    return err;
  };

  /**
   * @param {{prompt: string, systemPrompt: string}} args
   * @param {{signal?: AbortSignal}} [runOptions]
   */
  function run(args, { signal } = {}) {
    const mode = opts.mode ?? "ok";
    const prompt = String(args?.prompt ?? "");
    const systemPrompt = String(args?.systemPrompt ?? "");
    calls.push({ prompt, systemPrompt, at: Date.now(), mode });
    const reply = opts.reply === undefined ? null : typeof opts.reply === "string" ? opts.reply : JSON.stringify(opts.reply);
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (mode === "fail") return Promise.reject(new Error("model failed"));
    const text = mode === "garbage" ? (reply ?? "Sure! Here is a summary:\n\n- not JSON\n- at all {") : (reply ?? okReply(prompt));
    const delay = mode === "slow" ? opts.delayMs ?? 2000 : mode === "hang" ? Infinity : opts.delayMs ?? 0;
    if (delay <= 0) return Promise.resolve(text);
    pending++;
    return new Promise((resolve, reject) => {
      /** @type {any} */
      let timer = null;
      const onAbort = () => {
        if (timer !== null) timers.clearTimeout(timer);
        pending--;
        reject(abortError(signal));
      };
      if (Number.isFinite(delay)) {
        timer = timers.setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          pending--;
          resolve(text);
        }, delay);
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  return {
    run,
    calls,
    setMode(mode, extra = {}) { opts = { ...opts, ...extra, mode }; },
    getMode: () => opts.mode ?? "ok",
    pending: () => pending,
  };
}
