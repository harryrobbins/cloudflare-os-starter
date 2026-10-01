// @ts-check
// Ranked-vote rules over a small in-memory state, persisted through a Repository.
//
// Lifecycle:
//   open    people propose options, fill in their fields and drag every option into their own
//           order. A ballot is created the first time someone saves an order. Clicking Reveal marks
//           the ballot ready and locks it; un-clicking unlocks it.
//   closed  the moment every ballot is ready, there are at least `minVoters` ballots and at least
//           two options, the count runs and the result is stored. `minVoters` (default 2, anyone
//           may change it) stops the first people to rank from ending the vote before the others
//           have started. Anyone may reopen: readiness clears, ballots and past results
//           are kept, and new options may be proposed again.
//
// Secrecy: a viewer is only ever sent their own ballot (viewFor). Who has a ballot and who is ready
// is public; what anyone ranked is never sent, before or after the count.
//
// Trust: callers identify themselves with `by` = {id, name}, taken by honest clients from the
// signed-in account (gadgetViewer). The server cannot verify it (docs: collaborative-blueprints.md
// "Trust limits"), so ballot secrecy and readiness hold against honest clients only.
//
// Every write bumps `revision` and returns the state keys it changed; the server persists them in
// one transaction and pushes fresh views to subscribers.
//
// The assistant: an agent calling from the Workshop has no signed-in account, so its writes are
// attributed to ASSISTANT. Options it proposes belong to everyone (anyone may rename or withdraw
// them), and it never ranks or clicks Reveal: a ballot is a person's own.
//
// References: wherever a write takes an option or a field, it accepts the id or, for agents, the
// option's title or the field's label (case-insensitive).

import { countInstantRunoff } from "../shared/count.js";

export const SCHEMA_VERSION = 1;
export const DESCRIPTION_FIELD = "description";
export const FIELD_KINDS = /** @type {const} */ (["text", "long", "url"]);

/** Who agent writes are attributed to. */
export const ASSISTANT = Object.freeze({ id: "assistant", name: "Assistant" });

export const LIMITS = {
  options: 100,
  fields: 10,
  voters: 60,
  title: 80,
  question: 200,
  fieldLabel: 40,
  value: 2000,
  activity: 60,
  results: 20,
};

/**
 * @typedef {{id: string, name: string}} Actor
 * @typedef {{id: string, label: string, kind: "text"|"long"|"url"}} Field
 * @typedef {{id: string, title: string, values: Record<string, string>, by: Actor, at: number, editedBy?: Actor, editedAt?: number}} Option
 * @typedef {{name: string, ranking: string[], unseen: string[], ready: boolean, at: number}} Ballot
 * @typedef {{at: number, by: string, text: string}} Activity
 * @typedef {{n: number, at: number, winner: string|null, options: Record<string, string>, voters: string[], ballots: number, rounds: import("../shared/count.js").Round[]}} Result
 * @typedef {{schemaVersion: number, revision: number, question: string, phase: "open"|"closed", fields: Field[], order: string[], activity: Activity[], nextId: number, results: number, minVoters: number}} Meta
 * @typedef {{meta: Meta, options: Map<string, Option>, ballots: Record<string, Ballot>, results: Result[]}} State
 */

/** @returns {State} */
export function emptyState() {
  return {
    meta: {
      schemaVersion: SCHEMA_VERSION,
      revision: 0,
      question: "What should we call it?",
      phase: "open",
      fields: [{ id: DESCRIPTION_FIELD, label: "Description", kind: "long" }],
      order: [],
      activity: [],
      nextId: 1,
      results: 0,
      minVoters: 2,
    },
    options: new Map(),
    ballots: {},
    results: [],
  };
}

export class VoteError extends Error {}

/** @param {unknown} v @param {number} max */
export function cleanLine(v, max) {
  if (typeof v !== "string") return "";
  return v.replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** @param {unknown} v @param {number} max */
function cleanText(v, max) {
  if (typeof v !== "string") return "";
  return v.replace(/\r\n?/g, "\n").replace(/[^\P{Cc}\n]+/gu, " ").trim().slice(0, max);
}

/** @param {unknown} by @returns {Actor} */
function actor(by) {
  const raw = /** @type {any} */ (by && typeof by === "object" ? by : {});
  const id = cleanLine(raw.id, 200);
  if (!id) throw new VoteError("Missing voter identity");
  return { id, name: cleanLine(raw.name, 80) || id };
}

/** @param {string} s */
const fold = (s) => s.normalize("NFKC").toLocaleLowerCase("en").replace(/\s+/g, " ").trim();

/**
 * A stable pseudo-random order of `ids` for one voter, so nobody starts from the same list and
 * the order options were proposed in does not favour the first ones.
 * @param {string[]} ids @param {string} seed
 */
export function shuffledFor(ids, seed) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  const rand = () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export class Vote {
  /** @param {State} state @param {{now?: () => number, random?: () => number}} [opts] */
  constructor(state, { now = Date.now, random = Math.random } = {}) {
    this.s = state;
    this.now = now;
    this.random = random;
    /** @type {Set<string>} keys changed by the current write: "meta", "ballots", "o:<id>", "r:<n>" */
    this.dirty = new Set();
  }

  // --- Reads --------------------------------------------------------------------------------

  /** What one viewer may see. @param {string} voterId */
  viewFor(voterId) {
    const { meta, ballots } = this.s;
    const mine = voterId ? ballots[voterId] : undefined;
    return {
      revision: meta.revision,
      question: meta.question,
      phase: meta.phase,
      minVoters: meta.minVoters,
      fields: structuredClone(meta.fields),
      options: meta.order.map((id) => structuredClone(this.s.options.get(id))),
      voters: Object.entries(ballots)
        .map(([id, b]) => ({ id, name: b.name, ready: b.ready }))
        .toSorted((a, b) => a.name.localeCompare(b.name)),
      mine: mine ? { ranking: [...mine.ranking], unseen: [...mine.unseen], ready: mine.ready } : null,
      suggested: mine ? null : shuffledFor(meta.order, voterId || "anyone"),
      results: structuredClone(this.s.results).toReversed(),
      activity: meta.activity.slice(-30).toReversed(),
      limits: LIMITS,
    };
  }

  /** A plain-text summary for agents and exports; never includes ballots. */
  summaryMarkdown() {
    const { meta } = this.s;
    const lines = [`# ${meta.question}`, "", `Status: ${meta.phase === "open" ? "voting open" : "results revealed"}`, ""];
    lines.push("## Options", "");
    for (const id of meta.order) {
      const o = /** @type {Option} */ (this.s.options.get(id));
      lines.push(`### ${o.title}`, "", `Proposed by ${o.by.name}`);
      for (const f of meta.fields) if (o.values[f.id]) lines.push(`- **${f.label}:** ${o.values[f.id].replace(/\n/g, " ")}`);
      lines.push("");
    }
    const voters = Object.values(this.s.ballots);
    lines.push("## Voters", "", ...voters.map((b) => `- ${b.name}${b.ready ? " (ready)" : ""}`), "");
    for (const r of this.s.results.toReversed()) {
      lines.push(`## Count ${r.n} (${new Date(r.at).toISOString().slice(0, 16).replace("T", " ")} UTC)`, "");
      lines.push(`Winner: **${r.winner ? r.options[r.winner] : "none"}** from ${r.ballots} ballots`, "");
      r.rounds.forEach((round, i) => {
        const counts = Object.entries(round.counts).toSorted((a, b) => b[1] - a[1]).map(([id, n]) => `${r.options[id]} ${n}`).join(", ");
        const out = round.eliminated.map((id) => r.options[id]).join(", ");
        lines.push(`- Round ${i + 1}: ${counts}${out ? `; eliminated ${out}` : ""}${round.tieBreak ? ` (tie broken by ${round.tieBreak === "lot" ? "lot" : "earlier round"})` : ""}`);
      });
      lines.push("");
    }
    return lines.join("\n");
  }

  /**
   * The vote's state and latest count in plain terms (titles, names, ISO times) for agents. Never
   * includes ballots.
   */
  resultSummary() {
    const { meta, ballots } = this.s;
    const voters = Object.entries(ballots)
      .map(([id, b]) => ({ id, name: b.name, ready: b.ready }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
    const latest = this.s.results.at(-1);
    const title = (/** @type {Result} */ r, /** @type {string} */ id) => r.options[id] ?? "(withdrawn)";
    return {
      question: meta.question,
      phase: meta.phase,
      minVoters: meta.minVoters,
      options: meta.order.map((id) => {
        const o = /** @type {Option} */ (this.s.options.get(id));
        return { id, title: o.title, proposedBy: o.by.name };
      }),
      voters,
      waitingOn: meta.phase === "open" ? voters.filter((v) => !v.ready).map((v) => v.name) : [],
      votersNeeded: meta.phase === "open" ? Math.max(0, meta.minVoters - voters.length) : 0,
      latestCount: latest ? {
        count: latest.n,
        at: new Date(latest.at).toISOString(),
        current: meta.phase === "closed",
        winner: latest.winner ? title(latest, latest.winner) : null,
        ballots: latest.ballots,
        voters: [...latest.voters],
        rounds: latest.rounds.map((round, i) => ({
          round: i + 1,
          votes: Object.fromEntries(Object.entries(round.counts).toSorted((a, b) => b[1] - a[1]).map(([id, n]) => [title(latest, id), n])),
          eliminated: round.eliminated.map((id) => title(latest, id)),
          ...(round.tieBreak ? { tieBreak: round.tieBreak } : {}),
        })),
      } : null,
      earlierCounts: Math.max(0, this.s.results.length - 1),
    };
  }

  // --- Writes -------------------------------------------------------------------------------

  #begin() { this.dirty = new Set(); }

  /** @param {Actor} by @param {string} text */
  #commit(by, text) {
    const { meta } = this.s;
    meta.revision++;
    if (text) {
      meta.activity.push({ at: this.now(), by: by.name, text });
      if (meta.activity.length > LIMITS.activity) meta.activity.splice(0, meta.activity.length - LIMITS.activity);
    }
    this.dirty.add("meta");
    return { revision: meta.revision, keys: [...this.dirty] };
  }

  #requireOpen() {
    if (this.s.meta.phase !== "open") throw new VoteError("The results are showing; reopen voting first");
  }

  /** An option by id or (folded) title. @param {unknown} ref */
  #option(ref) {
    const key = typeof ref === "string" ? ref : "";
    const o = this.s.options.get(key) ?? [...this.s.options.values()].find((x) => fold(x.title) === fold(key));
    if (!o) throw new VoteError(key ? `No option called “${key}”` : "No such option");
    return o;
  }

  /** A field by id or (folded) label, from `fields` (default: the vote's). @param {unknown} ref @param {Field[]} [fields] */
  #field(ref, fields = this.s.meta.fields) {
    const key = typeof ref === "string" ? ref : "";
    return fields.find((f) => f.id === key) ?? fields.find((f) => fold(f.label) === fold(key));
  }

  /** Whether `who` may rename or withdraw `o`: its proposer, or anyone for the assistant's. @param {Option} o @param {Actor} who */
  #owns(o, who) { return o.by.id === who.id || o.by.id === ASSISTANT.id; }

  /** @param {Actor} who */
  #refuseAssistantBallot(who) {
    if (who.id === ASSISTANT.id) throw new VoteError("A ballot is a person's own: the assistant cannot rank options or click Reveal");
  }

  /** @param {string} exceptId clears readiness of every ballot except this voter's; returns how many */
  #unready(exceptId = "") {
    let n = 0;
    for (const [id, b] of Object.entries(this.s.ballots)) {
      if (b.ready && id !== exceptId) { b.ready = false; n++; }
    }
    if (n) this.dirty.add("ballots");
    return n;
  }

  /** @param {{by: Actor, question: string}} args */
  setQuestion({ by, question }) {
    this.#begin();
    const who = actor(by);
    const q = cleanLine(question, LIMITS.question);
    if (!q) throw new VoteError("The question cannot be empty");
    this.s.meta.question = q;
    return this.#commit(who, `set the question to “${q}”`);
  }

  /** @param {{by: Actor, label: string, kind?: string}} args */
  addField({ by, label, kind = "text" }) {
    this.#begin();
    const who = actor(by);
    const l = cleanLine(label, LIMITS.fieldLabel);
    if (!l) throw new VoteError("A field needs a name");
    const k = /** @type {Field["kind"]} */ (FIELD_KINDS.includes(/** @type {any} */ (kind)) ? kind : "text");
    const { fields } = this.s.meta;
    if (fields.length >= LIMITS.fields) throw new VoteError(`At most ${LIMITS.fields} fields`);
    if (fields.some((f) => fold(f.label) === fold(l))) throw new VoteError(`There is already a field called “${l}”`);
    const field = { id: `f${this.s.meta.nextId++}`, label: l, kind: k };
    fields.push(field);
    this.#commit(who, `added the field “${l}”`);
    return { field, revision: this.s.meta.revision, keys: [...this.dirty] };
  }

  /** @param {{by: Actor, fieldId?: string, field?: string}} args  fieldId: an id or label */
  removeField({ by, fieldId, field: ref }) {
    this.#begin();
    const who = actor(by);
    const { fields } = this.s.meta;
    const found = this.#field(fieldId ?? ref);
    const i = found ? fields.indexOf(found) : -1;
    if (i < 0) throw new VoteError("No such field");
    if (found?.id === DESCRIPTION_FIELD) throw new VoteError("The description field cannot be removed");
    const [field] = fields.splice(i, 1);
    for (const o of this.s.options.values()) {
      if (field.id in o.values) { delete o.values[field.id]; this.dirty.add(`o:${o.id}`); }
    }
    return this.#commit(who, `removed the field “${field.label}”`);
  }

  /**
   * Field values keyed by field id or label. An unknown key is ignored, or refused when `strict`
   * (agent calls), so a misspelt label is not silently dropped.
   * @param {unknown} values @param {boolean} [strict] @param {Field[]} [fields]
   */
  #cleanValues(values, strict = false, fields = this.s.meta.fields) {
    /** @type {Record<string, string>} */
    const out = {};
    if (values === undefined || values === null) return out;
    if (typeof values !== "object" || Array.isArray(values)) {
      if (strict) throw new VoteError("values must be an object of {field label or id: text}");
      return out;
    }
    for (const [key, value] of Object.entries(values)) {
      const f = this.#field(key, fields);
      if (!f) {
        if (strict) throw new VoteError(`No field called “${key}”. Fields: ${fields.map((x) => x.label).join(", ")}`);
        continue;
      }
      if (strict && typeof value !== "string") throw new VoteError(`The value for “${f.label}” must be text`);
      out[f.id] = f.kind === "long" ? cleanText(value, LIMITS.value) : cleanLine(value, LIMITS.value);
    }
    return out;
  }

  /** @param {string} title @param {string} [exceptId] */
  #checkTitle(title, exceptId) {
    if (!title) throw new VoteError("An option needs a name");
    for (const o of this.s.options.values()) {
      if (o.id !== exceptId && fold(o.title) === fold(title)) throw new VoteError(`“${o.title}” is already on the list`);
    }
  }

  /**
   * Adds an option to the end of every ballot. For everyone but the proposer it is marked unseen,
   * and anyone who was ready is un-readied, so no ballot is counted before its owner has placed it.
   * @param {{by: Actor, title: string, values?: Record<string, unknown>}} args
   */
  addOption({ by, title, values = {} }) {
    this.#begin();
    const who = actor(by);
    this.#requireOpen();
    const t = cleanLine(title, LIMITS.title);
    this.#checkTitle(t);
    if (this.s.options.size >= LIMITS.options) throw new VoteError(`At most ${LIMITS.options} options`);
    const id = `o${this.s.meta.nextId++}`;
    /** @type {Option} */
    const option = { id, title: t, values: this.#cleanValues(values), by: who, at: this.now() };
    this.s.options.set(id, option);
    this.s.meta.order.push(id);
    this.dirty.add(`o:${id}`);
    for (const [voterId, b] of Object.entries(this.s.ballots)) {
      b.ranking.push(id);
      if (voterId !== who.id) b.unseen.push(id);
      this.dirty.add("ballots");
    }
    const reset = this.#unready();
    this.#commit(who, `proposed “${t}”${reset ? `; ${reset} reveal${reset === 1 ? "" : "s"} reset` : ""}`);
    return { option: structuredClone(option), revision: this.s.meta.revision, keys: [...this.dirty] };
  }

  /**
   * Sets up or extends a vote in one write: an optional question, fields (an existing label is
   * reused), options (a title already on the list is skipped and reported) and a minimum number of
   * voters. Everything is validated before anything changes. Option values may be keyed by field
   * label or id, including fields added in the same call; `description` fills the Description.
   * @param {{by: Actor, question?: string, fields?: unknown[], options?: unknown[], minVoters?: number}} args
   */
  setUp({ by, question, fields = [], options = [], minVoters }) {
    this.#begin();
    const who = actor(by);
    const { meta } = this.s;
    if (!Array.isArray(fields)) throw new VoteError("fields must be a list of {label, kind}");
    if (!Array.isArray(options)) throw new VoteError("options must be a list of titles or {title, description?, values?}");
    if (options.length || minVoters !== undefined) this.#requireOpen();

    let q;
    if (question !== undefined) {
      q = cleanLine(question, LIMITS.question);
      if (!q) throw new VoteError("The question cannot be empty");
    }

    /** @type {Field[]} planned field list: existing, then new ones with placeholder ids */
    const planned = [...meta.fields];
    /** @type {{label: string, kind: Field["kind"]}[]} */
    const newFields = [];
    for (const raw of fields) {
      const f = /** @type {any} */ (typeof raw === "string" ? { label: raw } : raw);
      const label = cleanLine(f?.label, LIMITS.fieldLabel);
      if (!label) throw new VoteError("Every field needs a label");
      const kind = f.kind ?? "text";
      if (!FIELD_KINDS.includes(kind)) throw new VoteError(`Field “${label}”: kind must be one of ${FIELD_KINDS.join(", ")}`);
      if (planned.some((x) => fold(x.label) === fold(label))) continue;
      newFields.push({ label, kind });
      planned.push({ id: `new:${newFields.length}`, label, kind });
    }
    if (planned.length > LIMITS.fields) throw new VoteError(`At most ${LIMITS.fields} fields`);

    /** @type {{title: string, values: Record<string, string>}[]} */
    const toAdd = [];
    const skipped = [];
    for (const raw of options) {
      const o = /** @type {any} */ (typeof raw === "string" ? { title: raw } : raw);
      if (!o || typeof o !== "object") throw new VoteError("Each option is a title or {title, description?, values?}");
      const t = cleanLine(o.title, LIMITS.title);
      if (!t) throw new VoteError("Every option needs a title");
      if (toAdd.some((x) => fold(x.title) === fold(t))) throw new VoteError(`“${t}” is listed twice`);
      if ([...this.s.options.values()].some((x) => fold(x.title) === fold(t))) { skipped.push(t); continue; }
      const values = this.#cleanValues(o.values, true, planned);
      if (o.description !== undefined) values[DESCRIPTION_FIELD] = cleanText(o.description, LIMITS.value);
      toAdd.push({ title: t, values });
    }
    if (this.s.options.size + toAdd.length > LIMITS.options) throw new VoteError(`At most ${LIMITS.options} options`);

    let min;
    if (minVoters !== undefined) {
      min = Math.floor(Number(minVoters));
      if (!Number.isFinite(min) || min < 1 || min > LIMITS.voters) throw new VoteError(`Choose between 1 and ${LIMITS.voters} voters`);
    }

    // Validated: apply.
    const parts = [];
    if (q !== undefined && q !== meta.question) { meta.question = q; parts.push(`set the question to “${q}”`); }
    /** @type {Record<string, string>} */
    const idFor = {};
    for (const [i, f] of newFields.entries()) {
      const field = { id: `f${meta.nextId++}`, label: f.label, kind: f.kind };
      meta.fields.push(field);
      idFor[`new:${i + 1}`] = field.id;
    }
    if (newFields.length) parts.push(`added the field${newFields.length === 1 ? "" : "s"} ${newFields.map((f) => `“${f.label}”`).join(", ")}`);
    const added = [];
    for (const o of toAdd) {
      const id = `o${meta.nextId++}`;
      const values = Object.fromEntries(Object.entries(o.values).filter(([, v]) => v).map(([k, v]) => [idFor[k] ?? k, v]));
      this.s.options.set(id, { id, title: o.title, values, by: who, at: this.now() });
      meta.order.push(id);
      this.dirty.add(`o:${id}`);
      for (const [voterId, b] of Object.entries(this.s.ballots)) {
        b.ranking.push(id);
        if (voterId !== who.id) b.unseen.push(id);
        this.dirty.add("ballots");
      }
      added.push({ id, title: o.title });
    }
    if (added.length) {
      const reset = this.#unready();
      parts.push(`proposed ${added.map((o) => `“${o.title}”`).join(", ")}${reset ? `; ${reset} reveal${reset === 1 ? "" : "s"} reset` : ""}`);
    }
    let counted = false;
    if (min !== undefined && min !== meta.minVoters) {
      meta.minVoters = min;
      parts.push(`set the minimum to ${min} voter${min === 1 ? "" : "s"}`);
      counted = this.#maybeCount();
      if (counted) parts.push("everyone is ready, so the count ran");
    }
    const out = { question: meta.question, fields: structuredClone(meta.fields), added, skipped, minVoters: meta.minVoters, counted };
    if (!parts.length) return { ...out, revision: meta.revision, keys: [] };
    const { revision, keys } = this.#commit(who, parts.join("; "));
    return { ...out, revision, keys };
  }

  /**
   * Edits an option's fields (anyone) or its name (only whoever proposed it, or anyone for the
   * assistant's). A new name counts as a new suggestion for everyone else: it moves to the bottom
   * of their ballot, marked unseen, and every Reveal resets. The proposer's own ballot keeps its
   * place. `strict` refuses unknown field keys instead of ignoring them.
   * @param {{by: Actor, optionId?: string, option?: string, title?: string, values?: Record<string, unknown>, strict?: boolean}} args
   */
  updateOption({ by, optionId, option: ref, title, values, strict = false }) {
    this.#begin();
    const who = actor(by);
    this.#requireOpen();
    const o = this.#option(optionId ?? ref);
    const clean = values !== undefined ? this.#cleanValues(values, strict) : undefined;
    const parts = [];
    if (title !== undefined) {
      const t = cleanLine(title, LIMITS.title);
      if (t !== o.title) {
        if (!this.#owns(o, who)) throw new VoteError(`Only ${o.by.name} can rename “${o.title}”`);
        this.#checkTitle(t, o.id);
        parts.push(`renamed “${o.title}” to “${t}”`);
        o.title = t;
        for (const [voterId, b] of Object.entries(this.s.ballots)) {
          if (voterId === who.id) continue;
          b.ranking = [...b.ranking.filter((id) => id !== o.id), o.id];
          if (!b.unseen.includes(o.id)) b.unseen.push(o.id);
          this.dirty.add("ballots");
        }
        const reset = this.#unready();
        if (reset) parts.push(`${reset} reveal${reset === 1 ? "" : "s"} reset`);
      }
    }
    if (clean !== undefined) {
      const changed = Object.keys(clean).filter((k) => (o.values[k] ?? "") !== clean[k]);
      for (const k of changed) {
        if (clean[k]) o.values[k] = clean[k];
        else delete o.values[k];
      }
      if (changed.length) {
        const labels = changed.map((k) => this.s.meta.fields.find((f) => f.id === k)?.label ?? k);
        parts.push(`edited ${labels.join(", ")} on “${o.title}”`);
      }
    }
    if (!parts.length) return { revision: this.s.meta.revision, keys: [] };
    o.editedBy = who;
    o.editedAt = this.now();
    this.dirty.add(`o:${o.id}`);
    return this.#commit(who, parts.join("; "));
  }

  /** Only whoever proposed an option (anyone, for the assistant's) may withdraw it. @param {{by: Actor, optionId?: string, option?: string}} args */
  withdrawOption({ by, optionId, option: ref }) {
    this.#begin();
    const who = actor(by);
    this.#requireOpen();
    const o = this.#option(optionId ?? ref);
    if (!this.#owns(o, who)) throw new VoteError(`Only ${o.by.name} can withdraw “${o.title}”`);
    this.s.options.delete(o.id);
    this.s.meta.order = this.s.meta.order.filter((id) => id !== o.id);
    for (const b of Object.values(this.s.ballots)) {
      b.ranking = b.ranking.filter((id) => id !== o.id);
      b.unseen = b.unseen.filter((id) => id !== o.id);
    }
    this.dirty.add(`o:${o.id}`).add("ballots");
    return this.#commit(who, `withdrew “${o.title}”`);
  }

  /** @param {unknown} ranking */
  #checkRanking(ranking) {
    const order = this.s.meta.order;
    const ids = Array.isArray(ranking) ? ranking.filter((x) => typeof x === "string") : [];
    const set = new Set(ids);
    if (ids.length !== order.length || set.size !== ids.length || !order.every((id) => set.has(id))) {
      throw new VoteError("The list of options changed; your order has been refreshed");
    }
    return ids;
  }

  /**
   * Saves the caller's full order (every option exactly once), creating their ballot if needed.
   * Clears their "new" markers. Refused while they are ready.
   * @param {{by: Actor, ranking: string[]}} args
   */
  saveRanking({ by, ranking }) {
    this.#begin();
    const who = actor(by);
    this.#refuseAssistantBallot(who);
    this.#requireOpen();
    const ids = this.#checkRanking(ranking);
    const existing = this.s.ballots[who.id];
    if (existing?.ready) throw new VoteError("Undo Reveal to change your order");
    if (!existing && Object.keys(this.s.ballots).length >= LIMITS.voters) throw new VoteError(`At most ${LIMITS.voters} voters`);
    this.s.ballots[who.id] = { name: who.name, ranking: ids, unseen: [], ready: false, at: this.now() };
    this.dirty.add("ballots");
    return this.#commit(who, existing ? "" : "joined the vote");
  }

  /**
   * Marks the caller ready (Reveal) or not. `ranking`, when given, is saved first, so a first-time
   * voter can reveal with the order in front of them. When the last ballot becomes ready the count
   * runs and the vote closes.
   * @param {{by: Actor, ready: boolean, ranking?: string[]}} args
   */
  setReady({ by, ready, ranking }) {
    this.#begin();
    const who = actor(by);
    this.#refuseAssistantBallot(who);
    this.#requireOpen();
    let b = this.s.ballots[who.id];
    if (ready) {
      if (this.s.meta.order.length < 2) throw new VoteError("Propose at least two options first");
      if (ranking !== undefined && !b?.ready) {
        const ids = this.#checkRanking(ranking);
        if (!b && Object.keys(this.s.ballots).length >= LIMITS.voters) throw new VoteError(`At most ${LIMITS.voters} voters`);
        const joined = !b;
        b = this.s.ballots[who.id] = { name: who.name, ranking: ids, unseen: [], ready: false, at: this.now() };
        if (joined) this.s.meta.activity.push({ at: this.now(), by: who.name, text: "joined the vote" });
      }
      if (!b) throw new VoteError("Put the options in order first");
      if (b.unseen.length) throw new VoteError("Place the new options in your order first");
    } else if (!b) {
      return { revision: this.s.meta.revision, keys: [] };
    }
    b.name = who.name;
    b.ready = !!ready;
    b.at = this.now();
    this.dirty.add("ballots");
    if (ready && this.#maybeCount()) return this.#commit(who, "clicked Reveal; everyone is ready, so the count ran");
    const ballots = Object.values(this.s.ballots);
    const waiting = ballots.filter((x) => !x.ready).length;
    const short = Math.max(0, this.s.meta.minVoters - ballots.length);
    const why = [waiting ? `waiting on ${waiting}` : "", short ? `needs ${short} more voter${short === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
    return this.#commit(who, ready ? `clicked Reveal${why ? ` (${why})` : ""}` : "undid Reveal");
  }

  /** Runs the count when every ballot is ready and there are enough of them. */
  #maybeCount() {
    const ballots = Object.values(this.s.ballots);
    if (ballots.length < this.s.meta.minVoters || this.s.meta.order.length < 2 || !ballots.every((b) => b.ready)) return false;
    this.#runCount();
    return true;
  }

  /** How many ballots the count waits for, at least. @param {{by: Actor, minVoters: number}} args */
  setMinVoters({ by, minVoters }) {
    this.#begin();
    const who = actor(by);
    this.#requireOpen();
    const n = Math.floor(Number(minVoters));
    if (!Number.isFinite(n) || n < 1 || n > LIMITS.voters) throw new VoteError(`Choose between 1 and ${LIMITS.voters} voters`);
    if (n === this.s.meta.minVoters) return { revision: this.s.meta.revision, keys: [] };
    this.s.meta.minVoters = n;
    if (this.#maybeCount()) return this.#commit(who, `set the minimum to ${n} voter${n === 1 ? "" : "s"}; everyone is ready, so the count ran`);
    return this.#commit(who, `set the minimum to ${n} voter${n === 1 ? "" : "s"}`);
  }

  #runCount() {
    const { meta } = this.s;
    const ballots = Object.values(this.s.ballots);
    const count = countInstantRunoff(meta.order, ballots.map((b) => b.ranking), { random: this.random });
    const n = ++meta.results;
    /** @type {Result} */
    const result = {
      n,
      at: this.now(),
      winner: count.winner,
      options: Object.fromEntries(meta.order.map((id) => [id, /** @type {Option} */ (this.s.options.get(id)).title])),
      voters: ballots.map((b) => b.name).toSorted((a, b) => a.localeCompare(b)),
      ballots: count.ballots,
      rounds: count.rounds,
    };
    this.s.results.push(result);
    this.dirty.add(`r:${n}`);
    while (this.s.results.length > LIMITS.results) this.dirty.add(`r:${/** @type {Result} */ (this.s.results.shift()).n}`);
    meta.phase = "closed";
  }

  /**
   * Removes a ballot. Anyone may remove their own; anyone may remove someone else's that is not
   * ready (for a colleague who is away and holding up the reveal). Logged by name.
   * @param {{by: Actor, voterId?: string, voter?: string}} args  voterId: an account id or a voter's name
   */
  removeBallot({ by, voterId: ref, voter }) {
    this.#begin();
    const who = actor(by);
    this.#requireOpen();
    const key = typeof (ref ?? voter) === "string" ? /** @type {string} */ (ref ?? voter) : "";
    const voterId = key in this.s.ballots ? key : Object.keys(this.s.ballots).find((id) => fold(this.s.ballots[id].name) === fold(key)) ?? "";
    const b = this.s.ballots[voterId];
    if (!b) throw new VoteError(key ? `Nobody called “${key}” has a ballot` : "No such ballot");
    const own = voterId === who.id;
    if (!own && b.ready) throw new VoteError(`${b.name} is ready; only they can withdraw their ballot now`);
    delete this.s.ballots[voterId];
    this.dirty.add("ballots");
    const text = own ? "withdrew their ballot" : `removed ${b.name}’s ballot`;
    if (this.#maybeCount()) return this.#commit(who, `${text}; everyone left is ready, so the count ran`);
    return this.#commit(who, text);
  }

  /** Closed → open. Clears readiness; keeps ballots and past results. @param {{by: Actor}} args */
  reopen({ by }) {
    this.#begin();
    const who = actor(by);
    if (this.s.meta.phase === "open") return { revision: this.s.meta.revision, keys: [] };
    this.s.meta.phase = "open";
    this.#unready();
    return this.#commit(who, "reopened voting");
  }
}
