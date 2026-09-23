// The gate: normalize -> deterministic detectors -> Jev -> outcome. Fails closed: any error from
// Jev blocks. Only a query every check clearly clears is allowed without a human.

import { detect, redact, type Category, type DetectorConfig, type Hit } from "./detectors";
import { askJev, type JevQuestion, type JevScores, type JevVerdict } from "./jev";
import { normalize } from "./normalize";

export const MAX_QUERY_CHARS = 300;
export const MAX_URL_CHARS = 2048;
export const ALLOW_AT_MOST = 0.1;
/** Allow line when Jev is confident the query is about a public figure or general topic. */
export const ALLOW_PUBLIC_AT_MOST = 0.3;
export const PUBLIC_AT_LEAST = 0.8;
export const BLOCK_AT_LEAST = 0.5;

const HARD_QUESTIONS: JevQuestion[] = ["financial_identifier", "credential", "hidden_payload", "split_across_queries"];
/** Questions whose high probability means risk. `public_or_general` is the opposite: reassurance. */
const RISK_QUESTIONS: JevQuestion[] = ["private_person", "personal_attribute", ...HARD_QUESTIONS];

export type Outcome = "allow" | "review" | "block";

export type GateDecision = {
  outcome: Outcome;
  /** Categories and question names behind the outcome, for the agent and the audit. */
  reasons: string[];
  /** The text that would be sent: the normalized query, or the URL unchanged. */
  text: string;
  /** Safe to store and display: detector matches replaced by their category. */
  redacted: string;
  hits: Hit[];
  jev: JevVerdict | null;
  /** Set when Jev could not be consulted; the decision is then a block. */
  error?: string;
};

export type GateContext = {
  apiKey: string;
  detectors: DetectorConfig;
  recentQueries: string[];
  fetchImpl?: typeof fetch;
};

export async function checkQuery(raw: string, ctx: GateContext): Promise<GateDecision> {
  let n = normalize(raw);
  if (n.text.length === 0) {
    return { outcome: "block", reasons: ["empty"], text: "", redacted: "", hits: [], jev: null };
  }
  if (n.text.length > MAX_QUERY_CHARS) {
    return {
      outcome: "block", reasons: ["oversized"], text: n.text,
      redacted: `[${n.text.length} characters, over the ${MAX_QUERY_CHARS} limit]`, hits: [], jev: null,
    };
  }
  let hits = detect(n, ctx.detectors);
  return decide(n.text, n.text, hits, ctx);
}

/**
 * URLs are classified on a readable decomposition: host labels, decoded path segments, and decoded
 * query parameters and fragment. The hostname matters as much as the path, because the DNS lookup
 * alone sends it to a resolver the attacker may control.
 */
export async function checkUrl(url: URL, ctx: GateContext): Promise<GateDecision> {
  if (url.href.length > MAX_URL_CHARS) {
    return {
      outcome: "block", reasons: ["oversized"], text: url.href,
      redacted: `[URL of ${url.href.length} characters]`, hits: [], jev: null,
    };
  }
  let decode = (s: string) => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; } };
  let parts = [
    url.hostname,
    ...url.pathname.split("/").filter(Boolean).map(decode),
    ...Array.from(url.searchParams, ([k, v]) => `${k}=${v}`),
    decode(url.hash.slice(1)),
  ].filter(Boolean);
  let described = parts.join(" ");
  let n = normalize(described);
  let hits = detect(n, ctx.detectors);
  // Long random-looking host labels are a classic DNS exfiltration channel.
  for (let label of url.hostname.split(".")) {
    if (label.length >= 32 || (/\d{6,}/.test(label))) {
      hits.push({ category: "hidden_payload", detector: "suspicious_host_label", severity: "flag", match: label });
    }
  }
  let jevText = `URL ${url.href}\nHost: ${url.hostname}\nPath and parameters: ${parts.slice(1).join(" | ")}`;
  return decide(url.href, jevText, hits, ctx, redact(url.href, hits));
}

async function decide(
  text: string,
  jevText: string,
  hits: Hit[],
  ctx: GateContext,
  redacted = redact(text, hits),
): Promise<GateDecision> {
  let blocking = hits.filter(h => h.severity === "block");
  if (blocking.length > 0) {
    // Proven by pattern: Jev never sees it.
    return { outcome: "block", reasons: uniqueCategories(blocking), text, redacted, hits, jev: null };
  }

  let jev: JevVerdict;
  try {
    jev = await askJev(ctx.apiKey, { query: jevText, recent_queries: ctx.recentQueries }, ctx.fetchImpl);
  } catch (error) {
    return {
      outcome: "block", reasons: ["classifier_unavailable"], text, redacted, hits, jev: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  let { outcome, reasons } = outcomeFromScores(jev.scores, hits);
  return { outcome, reasons, text, redacted, hits, jev };
}

export function outcomeFromScores(scores: JevScores, hits: Hit[]): { outcome: Outcome; reasons: string[] } {
  let high = HARD_QUESTIONS.filter(q => scores[q] >= BLOCK_AT_LEAST);
  if (scores.private_person >= BLOCK_AT_LEAST && scores.personal_attribute >= BLOCK_AT_LEAST) {
    high.push("private_person", "personal_attribute");
  }
  if (high.length > 0) return { outcome: "block", reasons: high };

  // A public figure's birthday or a product name is not personal data; Jev's "private person"
  // score hovers around 0.2 for them, so a confident "public or general" relaxes the allow line.
  // It never relaxes a block, and a pattern flag still forces review.
  let allowAtMost = scores.public_or_general >= PUBLIC_AT_LEAST ? ALLOW_PUBLIC_AT_MOST : ALLOW_AT_MOST;
  let unsure = RISK_QUESTIONS.filter(q => scores[q] > allowAtMost);
  let flagged = uniqueCategories(hits);
  if (unsure.length > 0 || flagged.length > 0) {
    return { outcome: "review", reasons: [...flagged, ...unsure] };
  }
  return { outcome: "allow", reasons: [] };
}

function uniqueCategories(hits: Hit[]): Category[] {
  return [...new Set(hits.map(h => h.category))];
}

/** The refusal the agent sees. Names categories, never the matched text. */
export function refusalMessage(decision: GateDecision, kind: "query" | "URL"): string {
  if (decision.reasons.includes("classifier_unavailable")) {
    return `The ${kind} was not sent: the privacy check is unavailable right now, so it failed closed. Try again shortly.`;
  }
  if (decision.reasons.includes("oversized")) {
    return `The ${kind} was not sent: it is too long. Web ${kind === "query" ? "searches" : "fetches"} must be short; use at most ${kind === "query" ? MAX_QUERY_CHARS : MAX_URL_CHARS} characters.`;
  }
  let what = decision.reasons.map(r => r.replace(/_/g, " ")).join(", ");
  return `The ${kind} was refused by the privacy gate (${what}). It was not sent anywhere. ` +
      `Rephrase it without personal data, financial or government identifiers, or secrets. ` +
      `Do not try to encode, split or spell out the same data.`;
}
