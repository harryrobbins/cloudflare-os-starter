// @ts-check
// The templates offered on first open, as data. The client applies one through applyOperation:
// one `create` of kind "brief" with the brief text, one `create` of kind "note" per root, and
// `structure: {template: id}`, all in one request (see templateOperation). The server accepts
// `structure.template` only while meta.template is null, so two people opening a fresh Wave at
// once end up with one template, not two.

import { LIMITS, newId } from "./protocol.js";
import { keysBetween } from "./order.js";

/**
 * @typedef {object} Template
 * @property {string} id           TEMPLATES id: lowercase, [a-z0-9_]
 * @property {string} title
 * @property {string} description  one line for the picker
 * @property {string} brief        Markdown of the pinned brief blip
 * @property {{text: string}[]} roots  root blips created after the brief, in order
 */

/** @type {readonly Template[]} */
export const TEMPLATES = Object.freeze([
  {
    id: "blank",
    title: "Blank",
    description: "A brief and nothing else. Add threads as you go.",
    brief: "# Brief\n\nWhat is this Wave for, and what would a good outcome look like? Edit this brief as the discussion sharpens.",
    roots: [],
  },
  {
    id: "decision",
    title: "Decision",
    description: "Frame a question, lay out the options and constraints, then record the decision.",
    brief: "# Brief\n\nWe need to decide **what** by **when**, and why it matters. Replace this with the decision you are trying to make and the deadline.\n\nAsk the agent to *Compare options* once the Options thread has two or more, then *Record decision* from that thread.",
    roots: [
      { text: "## Question\n\nWhat exactly are we deciding? State it so that a yes or no, or a choice of one option, answers it." },
      { text: "## Options\n\nOne reply per option. Say what it costs, what it gains, and what it rules out.\n\n- **Option A**: …\n- **Option B**: …" },
      { text: "## Constraints\n\nBudget, dates, people, dependencies and anything already decided elsewhere." },
    ],
  },
  {
    id: "design_review",
    title: "Design review",
    description: "Review a proposal against its goals, with open questions and a decision at the end.",
    brief: "# Brief\n\nWhat is being reviewed, who owns it, and what the review must answer. Link the design (a URL is fine) and say when the review closes.",
    roots: [
      { text: "## Goals and non-goals\n\nWhat the design must achieve, and what it deliberately leaves out." },
      { text: "## Proposal\n\nThe design in a few paragraphs. Reply after the paragraph you are questioning." },
      { text: "## Open questions\n\nOne reply per question. Mark it answered by replying with the answer." },
    ],
  },
  {
    id: "retrospective",
    title: "Retrospective",
    description: "What went well, what did not, and what to change next time.",
    brief: "# Brief\n\nThe period or project under review, who took part, and the one thing this retrospective should change.",
    roots: [
      { text: "## What went well\n\nOne reply per item. Say what made it work so it can be repeated." },
      { text: "## What did not\n\nOne reply per item. Facts first, then what you would do differently." },
      { text: "## Actions\n\nOwner, action and date. Ask the agent to *Propose next steps* from the two threads above, then record the ones you commit to as a decision." },
    ],
  },
  {
    id: "incident_review",
    title: "Incident review",
    description: "Timeline, impact, causes and follow-ups for an incident, blame-free.",
    brief: "# Brief\n\nWhat happened, when it started and ended, who was affected and how badly. Keep it to what is known; put guesses in the Causes thread.",
    roots: [
      { text: "## Timeline\n\nOne reply per event, with a time. Detection, escalation, mitigation, resolution." },
      { text: "## Impact\n\nWho and what was affected, for how long, and how it was noticed." },
      { text: "## Causes\n\nContributing causes, not a single root cause. Reply to a cause to add evidence for or against it." },
      { text: "## Follow-ups\n\nOwner, action and date. Ask the agent to *Summarise* the Wave, then record the follow-ups as a decision." },
    ],
  },
]);

/** @param {unknown} id @returns {Template|null} */
export function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) ?? null;
}

/**
 * The applyOperation body that applies a template to an empty Wave: creates for the brief and
 * every root (fresh ids and evenly spread order keys), plus `structure.template`. The caller adds
 * senderId, by and requestId. Root `order` keys are given explicitly so the request is
 * deterministic in order regardless of how the server assigns defaults.
 * @param {string} templateId
 * @param {{newId?: () => string}} [options]  id factory (tests pass a deterministic one)
 * @returns {{blipOps: import("./protocol.js").BlipOp[], structure: {template: string}}|null}
 */
export function templateOperation(templateId, { newId: makeId = () => newId("blip") } = {}) {
  const template = getTemplate(templateId);
  if (!template) return null;
  const count = 1 + template.roots.length;
  const orders = keysBetween(null, null, count);
  /** @type {import("./protocol.js").BlipOp[]} */
  const blipOps = [
    { op: "create", blipId: makeId(), parentId: null, kind: "brief", order: orders[0], text: template.brief },
    ...template.roots.map((root, i) => /** @type {import("./protocol.js").BlipOp} */ ({
      op: "create", blipId: makeId(), parentId: null, kind: "note", order: orders[i + 1], text: root.text,
    })),
  ];
  return { blipOps, structure: { template: template.id } };
}

/** Sanity limits the tests check, so a template can never exceed what the server accepts. */
export const TEMPLATE_LIMITS = Object.freeze({
  roots: 8,
  textChars: LIMITS.textChars,
  descriptionChars: 120,
  titleChars: 40,
});
