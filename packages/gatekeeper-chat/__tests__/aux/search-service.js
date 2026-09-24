// Stands in for the omni-search Worker's `SearchService` entrypoint
// (packages/gatekeeper-search/src/shared/contract.ts) in the omni-search suites, bound to the test
// Worker as SEARCH exactly the way deploy.ts binds the real one: a named entrypoint with
// `props: { source: "chat" }`. A side door, `Control`, lets a test read what was pushed, script what
// dense recall answers, and make ingest fail.
//
// Suites run in parallel against this one Worker, so nothing here is a global mode switch: ingest
// failures are keyed by a marker string that appears in the batch, and dense recall is scripted per
// query text. Plain JavaScript because auxiliary Workers are handed straight to Miniflare and never
// see Vite.
import { WorkerEntrypoint } from "cloudflare:workers";

/** Every accepted batch, in arrival order. */
const ingests = [];
/** Every ingest attempt, accepted or failed, with the marker it matched. */
const attempts = [];
/** { marker, skip, remaining, message } */
const failures = [];
/** Every denseRecall request. */
const recalls = [];
/** query text -> { hits, dense } | { error } | { hangMs, hits?, dense? } */
const scripts = new Map();

function sourceOf(ctx) {
  const source = ctx.props?.source;
  if (!source) throw new Error("SearchService source prop is required.");
  return source;
}

export class SearchService extends WorkerEntrypoint {
  async ingest(batch) {
    const source = sourceOf(this.ctx);
    const json = JSON.stringify(batch);
    for (const failure of failures) {
      if (failure.remaining <= 0 || !json.includes(failure.marker)) continue;
      if (failure.skip > 0) {
        failure.skip--;
        continue;
      }
      failure.remaining--;
      attempts.push({ ok: false, marker: failure.marker });
      throw new Error(failure.message);
    }
    attempts.push({ ok: true });
    ingests.push({ source, batch, json });
    return {
      upserted: batch.upserts?.length ?? 0,
      unchanged: 0,
      deleted: batch.deletes?.length ?? 0,
      queued: batch.upserts?.length ?? 0,
    };
  }

  async denseRecall(request) {
    const source = sourceOf(this.ctx);
    recalls.push({ source, ...request });
    const script = scripts.get(request.text);
    if (script === undefined) return { hits: [], dense: "off" };
    if (script.hangMs !== undefined) await new Promise((resolve) => setTimeout(resolve, script.hangMs));
    if (script.error !== undefined) throw new Error(script.error);
    return { hits: script.hits ?? [], dense: script.dense ?? "ok" };
  }
}

export class Control extends WorkerEntrypoint {
  /** Accepted batches whose JSON contains `marker`. */
  ingests(marker) {
    return ingests.filter((entry) => entry.json.includes(marker)).map((entry) => ({
      source: entry.source,
      batch: entry.batch,
    }));
  }

  /** Failed attempts for `marker`. */
  failedAttempts(marker) {
    return attempts.filter((entry) => !entry.ok && entry.marker === marker).length;
  }

  /**
   * Makes the next `times` ingest calls whose batch contains `marker` throw, after letting `skip`
   * such calls through. A message starting "search: invalid input: " is the contract's input error.
   */
  failIngest(marker, times, skip = 0, message = "The search Worker is unavailable.") {
    failures.push({ marker, skip, remaining: times, message });
  }

  /** Stops every scripted failure for `marker`. */
  healIngest(marker) {
    for (const failure of failures) if (failure.marker === marker) failure.remaining = 0;
  }

  /** What `denseRecall` answers for exactly this query text. */
  script(text, result) {
    scripts.set(text, result);
  }

  /** denseRecall requests for exactly this query text. */
  recalls(text) {
    return recalls.filter((entry) => entry.text === text);
  }
}

export default {
  fetch() {
    return new Response("mock search", { status: 404 });
  },
};
