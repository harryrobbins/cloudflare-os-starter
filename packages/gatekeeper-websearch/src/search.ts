// Web search through OpenRouter's `openrouter:web_search` server tool on the Responses API.
//
// OpenRouter has no bare "query in, results out" endpoint: a model issues the search. The gate's
// guarantee rests on one invariant: the search model's entire context is a fixed instruction plus
// the already-approved query, so any query it writes can only carry information that was in the
// approved one. The Responses API reports each executed query (`action.query`), which is checked
// against the approved text and logged. Spike results: docs/plans/web-search-gatekeeper.md#spikes.

export const RESPONSES_URL = "https://openrouter.ai/api/v1/responses";
export const SEARCH_MODEL = "~deepseek/deepseek-flash-latest";
const TIMEOUT_MS = 30_000;

const INSTRUCTIONS =
  "Call web_search exactly once with the user's text verbatim as the query. " +
  "Then reply with the single word DONE.";

export type SearchResult = { title: string; url: string; snippet: string };

export type SearchOutcome = {
  results: SearchResult[];
  /** Queries OpenRouter reports it executed. Normally exactly one, equal to the approved text. */
  executedQueries: string[];
  cost: number | null;
};

export type SearchOptions = { count?: number };

export async function openRouterSearch(
  apiKey: string,
  query: string,
  opts: SearchOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<SearchOutcome> {
  let count = Math.min(Math.max(Math.trunc(opts.count ?? 5), 1), 10);
  let res = await fetchImpl(RESPONSES_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: SEARCH_MODEL,
      instructions: INSTRUCTIONS,
      input: query,
      tools: [{
        type: "openrouter:web_search",
        // Pin the engine: "auto" would switch to a provider's native search.
        parameters: { engine: "perplexity", max_uses: 1, max_results: count, max_characters: 600 },
      }],
      provider: { data_collection: "deny" },
      max_output_tokens: 256,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Web search failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  let body = await res.json() as {
    output?: Array<{
      type?: string;
      action?: { query?: unknown };
      content?: Array<{ annotations?: Array<{ type?: string; url?: unknown; title?: unknown; content?: unknown; url_citation?: { url?: unknown; title?: unknown; content?: unknown } }> }>;
    }>;
    usage?: { cost?: unknown };
  };

  let executedQueries: string[] = [];
  let results: SearchResult[] = [];
  let seen = new Set<string>();
  for (let item of body.output ?? []) {
    if (item.type === "openrouter:web_search" && typeof item.action?.query === "string") {
      executedQueries.push(item.action.query);
    }
    if (item.type !== "message") continue;
    for (let part of item.content ?? []) {
      for (let a of part.annotations ?? []) {
        if (a.type !== "url_citation") continue;
        let c = a.url_citation ?? a;
        if (typeof c.url !== "string" || seen.has(c.url)) continue;
        seen.add(c.url);
        results.push({
          title: typeof c.title === "string" ? c.title : c.url,
          url: c.url,
          snippet: typeof c.content === "string" ? c.content.slice(0, 500) : "",
        });
      }
    }
  }
  return {
    results: results.slice(0, count),
    executedQueries,
    cost: typeof body.usage?.cost === "number" ? body.usage.cost : null,
  };
}
