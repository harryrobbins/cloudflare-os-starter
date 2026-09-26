// @ts-check
// Quick-create inline tokens: "Fix login #bug @ada !1 ^current" → title "Fix login" plus
// labels, assignee, priority and cycle. Tokens are recognised only when they resolve; anything
// else stays in the title, so nothing typed is silently lost.

import { PRIORITIES, localDay } from "../../shared/model/work.js";
import { personName } from "../../shared/model/index.js";

const PRIORITY_WORDS = { urgent: 1, high: 2, medium: 3, med: 3, low: 4, none: 0 };

/**
 * @param {string} text
 * @param {import("../../shared/model/index.js").WorkIndex} index
 * @param {{ me: string|null, today?: string }} ctx
 * @returns {{ title: string, fields: Record<string, unknown>, tokens: { text: string, field: string, label: string }[] }}
 */
export function parseTokens(text, index, ctx) {
  /** @type {Record<string, unknown>} */
  const fields = {};
  /** @type {{ text: string, field: string, label: string }[]} */
  const tokens = [];
  const today = ctx.today ?? localDay(new Date());
  const kept = [];
  for (const word of text.split(/\s+/)) {
    const m = /^([#@!^])(.+)$/.exec(word);
    const handled = m && index.planning ? resolve(m[1], m[2]) : null;
    if (handled) tokens.push({ text: word, ...handled });
    else if (word) kept.push(word);
  }
  return { title: kept.join(" "), fields, tokens };

  /** @param {string} sigil @param {string} value */
  function resolve(sigil, value) {
    const v = value.toLowerCase();
    if (sigil === "#") {
      const label = index.labels.find((l) => l.key.toLowerCase() === v || l.name.toLowerCase() === v);
      const key = label?.key ?? value;
      const labels = /** @type {string[]} */ (fields.labels ?? []);
      if (!labels.includes(key)) fields.labels = [...labels, key];
      return { field: "labels", label: `Label ${label?.name ?? value}` };
    }
    if (sigil === "@") {
      if ((v === "me" || v === "myself") && ctx.me) { fields.assignee = ctx.me; return { field: "assignee", label: "Assign to you" }; }
      const person = [...index.people.values()].find((p) => p.name.toLowerCase() === v || p.name.toLowerCase().startsWith(v) || p.id.toLowerCase().endsWith(`:${v}`) || p.id.toLowerCase().includes(`:${v}@`));
      if (!person) return null;
      fields.assignee = person.id;
      return { field: "assignee", label: `Assign to ${personName(index, person.id)}` };
    }
    if (sigil === "!") {
      const p = /^[0-4]$/.test(v) ? Number(v) : /** @type {any} */ (PRIORITY_WORDS)[v];
      if (p === undefined) return null;
      fields.priority = p;
      return { field: "priority", label: `Priority ${PRIORITIES[p].name}` };
    }
    if (sigil === "^") {
      const cycles = index.cycles;
      let cycle = null;
      if (v === "current" || v === "now") cycle = cycles.find((c) => c.start && c.end && c.start <= today && today <= c.end);
      else if (v === "next") cycle = cycles.find((c) => c.start && c.start > today);
      else cycle = cycles.find((c) => c.name.toLowerCase() === v || String(c.number) === v || c.name.toLowerCase().replace(/\s+/g, "") === v);
      if (!cycle) return null;
      fields.cycle = cycle.id;
      return { field: "cycle", label: `Cycle ${cycle.name}` };
    }
    return null;
  }
}
