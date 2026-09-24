// @ts-check
// The quick-add bar's syntax (plan §5.1). Statements are separated by new lines or ";".
//
//   A                     an element
//   A -> B                A connects to B (directed)
//   A <- B                B connects to A
//   A <-> B               mutual
//   A -- B                undirected
//   A -> B, C, D          one connection to each
//   A -> B -> C           a chain
//   A -[funds]-> B        a labelled connection (also <-[x]-, -[x]-, <-[x]->)
//
// Labels are trimmed; empty ones are ignored. Parsing is linear and never throws.

import { LIMITS, cleanLine } from "./protocol.js";

const ARROW_RE = /<-\[([^\]]*)\]->|<-\[([^\]]*)\]-|-\[([^\]]*)\]->|-\[([^\]]*)\]-|<->|->|<-|--/g;
export const QUICK_ADD_MAX_STATEMENTS = 200;
export const QUICK_ADD_MAX_ITEMS = 500;

/**
 * @typedef {{from: string, to: string, direction: "directed"|"undirected"|"mutual", label: string}} QuickConnection
 * @param {string} text
 * @returns {{elements: string[], connections: QuickConnection[], problems: string[]}}
 */
export function parseQuickAdd(text) {
  /** @type {string[]} */
  const elements = [];
  const seen = new Set();
  /** @type {QuickConnection[]} */
  const connections = [];
  /** @type {string[]} */
  const problems = [];
  const add = (/** @type {string} */ label) => {
    const key = label.toLowerCase();
    if (!seen.has(key)) { seen.add(key); elements.push(label); }
  };
  const statements = String(text ?? "").split(/[\n;]/).slice(0, QUICK_ADD_MAX_STATEMENTS);
  for (const raw of statements) {
    const s = raw.trim();
    if (!s) continue;
    /** @type {{kind: string, label: string}[]} */
    const arrows = [];
    /** @type {string[]} */
    const parts = [];
    let last = 0;
    ARROW_RE.lastIndex = 0;
    for (let m = ARROW_RE.exec(s); m; m = ARROW_RE.exec(s)) {
      parts.push(s.slice(last, m.index));
      last = m.index + m[0].length;
      const label = cleanLine(m[1] ?? m[2] ?? m[3] ?? m[4] ?? "", LIMITS.label);
      const kind = m[1] !== undefined ? "<->" : m[2] !== undefined ? "<-" : m[3] !== undefined ? "->" : m[4] !== undefined ? "--" : m[0];
      arrows.push({ kind, label });
    }
    parts.push(s.slice(last));
    const groups = parts.map((p) => p.split(",").map((x) => cleanLine(x, LIMITS.label)).filter(Boolean));
    if (groups.some((g) => !g.length)) {
      problems.push(`“${cleanLine(s, 60)}”: an arrow needs a name on both sides`);
      continue;
    }
    for (const g of groups) for (const label of g) add(label);
    for (let i = 0; i < arrows.length; i++) {
      const { kind, label } = arrows[i];
      for (const a of groups[i]) {
        for (const b of groups[i + 1]) {
          if (connections.length >= QUICK_ADD_MAX_ITEMS) break;
          if (kind === "->") connections.push({ from: a, to: b, direction: "directed", label });
          else if (kind === "<-") connections.push({ from: b, to: a, direction: "directed", label });
          else if (kind === "<->") connections.push({ from: a, to: b, direction: "mutual", label });
          else connections.push({ from: a, to: b, direction: "undirected", label });
        }
      }
    }
    if (elements.length >= QUICK_ADD_MAX_ITEMS) { problems.push(`Only the first ${QUICK_ADD_MAX_ITEMS} names were read`); break; }
  }
  return { elements: elements.slice(0, QUICK_ADD_MAX_ITEMS), connections, problems };
}
