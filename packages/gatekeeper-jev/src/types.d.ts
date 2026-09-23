/**
 * Plain text, or a structured description such as
 * `{ what: "Disputes a specific charge", not_for: "General pricing questions", examples: ["..."] }`.
 * Structured descriptions help when options are easy to confuse.
 */
export type JevText = string | { [key: string]: unknown };

/**
 * One question about `state`. Instructions may refer to fields of an object `state` by name.
 * - `noul`: a yes/no question, phrased so that a high value means yes. Optional `true`/`false`
 *   criteria sharpen a subtle boundary.
 * - `choice`: pick one label. `criteria` maps each label to what it means; list every option, and
 *   add an `other` or `none` label when inputs can fall outside them.
 * - `score`: a position on an ordered scale. `criteria` lists the levels lowest first (2-20; three
 *   is often enough). Describe each level as a concrete situation, one dimension per question.
 */
export type JevQuestion =
  | { type: "noul"; instructions: JevText; criteria?: { true?: JevText; false?: JevText } }
  | { type: "choice"; instructions: JevText; criteria: { [label: string]: JevText } }
  | { type: "score"; instructions: JevText; criteria: JevText[] };

/**
 * - `noul`: probability of yes, 0-1. 0.5 means "cannot tell", not "medium".
 * - `choice`: the most likely label, a probability for every label (summing to 1), and
 *   `confidence` (0-1), how peaked that distribution is.
 * - `score`: the probability-weighted mean level index (can fall between levels; round it for a
 *   single level), a probability per level index, and `confidence`.
 */
export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: { [label: string]: number }; confidence: number }
  | { type: "score"; score: number; probabilities: { [level: string]: number }; confidence: number };

export interface JevRequest {
  /** What the questions are about: a string, or an object or array of fields. */
  state: string | { [key: string]: unknown } | unknown[];
  /**
   * 1-32 questions, keyed by identifiers you choose (letters, digits, underscores). They are
   * answered independently and in parallel, so batch related questions into one call.
   */
  questions: { [key: string]: JevQuestion };
}

export interface JevDecision {
  /** One answer per question, under the same keys. */
  answers: { [key: string]: JevAnswer };
  model: string;
  /** Cost in US dollars, when reported. */
  cost: number | null;
}

/**
 * Jev, TypeSafe's decision model: fast, cheap, calibrated judgments about text or data, returned
 * as probabilities rather than prose. Use it to classify, route, triage, rate and check things;
 * it does not write text or explain itself. Each request, state and questions together, must fit
 * in about 32,000 tokens.
 *
 * Act on confidence: above 0.9 act automatically, 0.5-0.9 confirm with the user or gather more
 * data, below 0.5 hand the case to a person or a reasoning model. Raise the thresholds as the
 * stakes rise.
 *
 * `state` is sent outside the organisation to OpenRouter and TypeSafe, restricted to providers
 * that neither keep nor train on it. Send only what the questions need.
 */
export interface JevSession {
  /** Ask one or more questions about `state`. Throws if the request is invalid or Jev fails. */
  decide(request: JevRequest): Promise<JevDecision>;
}
