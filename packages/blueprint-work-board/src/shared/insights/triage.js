// @ts-check
// Jev triage: the compact state and questions sent to Jev's `decide()` for one work item, and the
// suggestions read back from its calibrated answers. Pure, so it is unit-tested with a fake Jev.
//
// Confidence bands (plan.md): ≥ 0.9 pre-selected, 0.5–0.9 shown unselected, < 0.5 hidden. A
// suggestion is never applied by itself: it becomes a proposal a person applies.

import { KIND_LABELS, PRIORITIES } from "../model/work.js";

export const JEV_BINDING = "JEV";
/**
 * The optional connection: packages/gatekeeper-jev, Workshop vendor id "jev" (deploy.ts binds it
 * as GATEKEEPER_JEV), one resource `jev://decisions`. It is deliberately NOT declared in the
 * archive's `bindings`: the platform makes every declared binding mandatory when a gadget is
 * created from the blueprint (BlueprintLandingPage requires all of them), which would stop
 * deployments without Jev from creating a board. People add it in the Connections tab as JEV.
 */
export const JEV_CONNECTION = Object.freeze({ gatekeeperName: "jev", typeUrlPattern: "jev://decisions" });
export const TRIAGE_LIMITS = Object.freeze({ keys: 20, labels: 8, similar: 5, description: 1200 });
export const BANDS = Object.freeze({ preselect: 0.9, show: 0.5 });

const PRIORITY_CRITERIA = {
  urgent: "Broken for many people, losing data, a security problem or an outage: drop other work for it",
  high: "Important and time-sensitive; belongs in the current or next cycle",
  medium: "Worth doing soon, but nothing bad happens if it waits a few weeks",
  low: "Nice to have; can wait indefinitely",
  none: "Too little information to judge its priority",
};
const PRIORITY_VALUE = { none: 0, urgent: 1, high: 2, medium: 3, low: 4 };
const STATE_MEANING = {
  triage: "Needs more information before anyone can decide (stay in triage)",
  backlog: "Valid, but not planned yet",
  unstarted: "Valid and ready to be worked on soon",
  canceled: "Not worth doing: invalid, obsolete, or will not be done",
};

/**
 * @typedef {import("../model/index.js").WorkIndex} WorkIndex
 * @typedef {import("../model/index.js").ItemView} ItemView
 * @typedef {{ id: string, key: string, field: "priority"|"state"|"label"|"duplicate", text: string, value: string|number,
 *   probability: number, confidence: string, preselect: boolean }} Suggestion
 */

/** Lowercase word tokens (3+ letters) of a text. @param {string} text */
export function tokens(text) {
  return new Set(String(text).toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)));
}
const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "when", "not", "are", "was", "our", "has", "have", "can", "all", "its", "but", "you", "any", "out"]);

/** Jaccard overlap of two token sets. @param {Set<string>} a @param {Set<string>} b */
export function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / (a.size + b.size - n);
}

/** The open items most similar to one (by title and description words). @param {WorkIndex} ix @param {ItemView} item */
export function similarItems(ix, item, limit = TRIAGE_LIMITS.similar) {
  const mine = tokens(`${item.title} ${item.title} ${item.description.slice(0, 400)}`);
  return ix.itemList
    .filter((o) => o.id !== item.id && !o.archived && o.category !== "done")
    .map((o) => ({ item: o, score: overlap(mine, tokens(`${o.title} ${o.title} ${o.description.slice(0, 400)}`)) }))
    .filter((x) => x.score > 0.08)
    .toSorted((a, b) => b.score - a.score || (b.item.number ?? 0) - (a.item.number ?? 0))
    .slice(0, limit);
}

/**
 * The request for one item: state (what Jev reads) and questions (priority, state, up to eight
 * labels, and a possible duplicate among the similar open items).
 * @param {WorkIndex} ix @param {ItemView} item
 */
export function buildTriageRequest(ix, item) {
  const candidates = ix.states.filter((s) => s.kind in STATE_MEANING);
  const usage = new Map();
  for (const i of ix.itemList) for (const l of i.labels) usage.set(l, (usage.get(l) ?? 0) + 1);
  const words = tokens(`${item.title} ${item.description}`);
  const labels = ix.labels.filter((l) => !l.archived && !item.labels.includes(l.key))
    .map((l) => ({ l, score: overlap(words, tokens(`${l.name} ${l.key} ${l.description}`)) * 10 + Math.log1p(usage.get(l.key) ?? 0) }))
    .toSorted((a, b) => b.score - a.score).slice(0, TRIAGE_LIMITS.labels).map((x) => x.l);
  const similar = similarItems(ix, item);
  /** @type {Record<string, any>} */
  const questions = {
    priority: { type: "choice", instructions: "How urgent is this work item for the team?", criteria: { ...PRIORITY_CRITERIA } },
  };
  if (candidates.length > 1) {
    questions.state = {
      type: "choice", instructions: "Where should this work item go after triage?",
      criteria: Object.fromEntries(candidates.map((s, i) => [`s${i}`, `${s.name}: ${/** @type {Record<string, string>} */ (STATE_MEANING)[s.kind]}`])),
    };
  }
  labels.forEach((l, i) => {
    questions[`label_${i}`] = { type: "noul", instructions: `Does the label “${l.name}”${l.description ? ` (${l.description})` : ""} apply to this work item?` };
  });
  if (similar.length) {
    questions.duplicate = {
      type: "choice", instructions: "Does this work item describe the same work as one of the similar open items?",
      criteria: { none: "No: it is different work from all of them", ...Object.fromEntries(similar.map((s, i) => [`d${i}`, `Yes, the same work as ${s.item.key}: ${s.item.title}`])) },
    };
  }
  const state = {
    item: {
      key: item.key, title: item.title, description: item.description.slice(0, TRIAGE_LIMITS.description),
      state: ix.stateByKey.get(item.state)?.name ?? item.state, priority: PRIORITIES[item.priority].name,
      labels: item.labels.map((l) => ix.labelByKey.get(l)?.name ?? l),
    },
    labels_on_this_board: ix.labels.filter((l) => !l.archived).map((l) => l.name),
    similar_open_items: similar.map((s) => ({ key: s.item.key, title: s.item.title, state: ix.stateByKey.get(s.item.state)?.name ?? s.item.state })),
  };
  return { request: { state, questions }, meta: { candidates: candidates.map((s) => s.key), labels: labels.map((l) => l.key), similar: similar.map((s) => s.item.key) } };
}

/** @param {number} p */
export const confidenceText = (p) => `${Math.round(p * 100)}% likely`;

/**
 * Suggestions from Jev's answers: only changes (not what the item already has), each with its
 * probability; those under 0.5 are counted, not returned.
 * @param {WorkIndex} ix @param {ItemView} item @param {ReturnType<typeof buildTriageRequest>["meta"]} meta
 * @param {Record<string, any>} answers
 * @returns {{ suggestions: Suggestion[], hidden: number }}
 */
export function readSuggestions(ix, item, meta, answers) {
  /** @type {Suggestion[]} */
  const all = [];
  const add = (/** @type {Omit<Suggestion, "confidence"|"preselect"|"key">} */ s) => all.push({ ...s, key: item.key, probability: Math.round(s.probability * 1000) / 1000, confidence: confidenceText(s.probability), preselect: s.probability >= BANDS.preselect });
  const pr = answers.priority;
  if (pr?.type === "choice" && pr.choice in PRIORITY_VALUE) {
    const value = /** @type {Record<string, number>} */ (PRIORITY_VALUE)[pr.choice];
    const p = Number(pr.probabilities?.[pr.choice] ?? pr.confidence ?? 0);
    if (value !== item.priority && pr.choice !== "none") add({ id: `${item.key}:priority`, field: "priority", text: `Priority ${PRIORITIES[item.priority].name} → ${PRIORITIES[value].name}`, value: pr.choice, probability: p });
  }
  const st = answers.state;
  if (st?.type === "choice" && /^s\d+$/.test(st.choice)) {
    const key = meta.candidates[Number(st.choice.slice(1))];
    const p = Number(st.probabilities?.[st.choice] ?? 0);
    if (key && key !== item.state) add({ id: `${item.key}:state`, field: "state", text: `State ${ix.stateByKey.get(item.state)?.name ?? item.state} → ${ix.stateByKey.get(key)?.name ?? key}`, value: ix.stateByKey.get(key)?.name ?? key, probability: p });
  }
  meta.labels.forEach((l, i) => {
    const a = answers[`label_${i}`];
    if (a?.type !== "noul") return;
    add({ id: `${item.key}:label:${l}`, field: "label", text: `Add label ${ix.labelByKey.get(l)?.name ?? l}`, value: ix.labelByKey.get(l)?.name ?? l, probability: Number(a.noul) });
  });
  const du = answers.duplicate;
  if (du?.type === "choice" && /^d\d+$/.test(du.choice)) {
    const other = meta.similar[Number(du.choice.slice(1))];
    const p = Number(du.probabilities?.[du.choice] ?? 0);
    if (other) add({ id: `${item.key}:duplicate`, field: "duplicate", text: `Duplicate of ${other}`, value: other, probability: p });
  }
  const shown = all.filter((s) => s.probability >= BANDS.show).toSorted((a, b) => b.probability - a.probability);
  return { suggestions: shown, hidden: all.length - shown.length };
}

/**
 * Proposal changes for chosen suggestions: one work.update per item (priority, state and added
 * labels together) and a duplicates relation for a duplicate.
 * @param {Suggestion[]} chosen
 */
export function suggestionsToChanges(chosen) {
  /** @type {Map<string, Suggestion[]>} */
  const byKey = new Map();
  for (const s of chosen) byKey.set(s.key, [...(byKey.get(s.key) ?? []), s]);
  /** @type {{ command: string, input: Record<string, unknown>, reason: string }[]} */
  const changes = [];
  for (const [key, list] of byKey) {
    /** @type {Record<string, unknown>} */
    const input = { id: key };
    const why = [];
    for (const s of list) {
      if (s.field === "priority") input.priority = s.value;
      else if (s.field === "state") input.state = s.value;
      else if (s.field === "label") input.labels_add = [...(/** @type {string[]} */ (input.labels_add) ?? []), s.value];
      if (s.field !== "duplicate") why.push(`${s.text} (${s.confidence})`);
    }
    if (Object.keys(input).length > 1) changes.push({ command: "work.update", input, reason: `Jev: ${why.join("; ")}` });
    const dup = list.find((s) => s.field === "duplicate");
    if (dup) changes.push({ command: "work.relation.create", input: { from: key, to: dup.value, kind: "duplicates" }, reason: `Jev: ${dup.text} (${dup.confidence})` });
  }
  return changes;
}

/** @param {string} kind */
export const kindLabel = (kind) => /** @type {Record<string, string>} */ (KIND_LABELS)[kind] ?? kind;
