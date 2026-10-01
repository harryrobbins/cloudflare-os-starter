// @ts-check
// The `Gadget` Durable Object (its RPC surface) and the `ExportHandler`. The vote's rules live in
// server.lib.js (source: src/core/vote.js), persistence and live updates in src/core/store.js; this
// file wires them to the platform and describes them for agents.
//
// Use: call these methods from executeCode as env.<binding>.<method>(…); describeGadget() below
// lists the ones to reach for first. Adapt: add a method to class Gadget. `this.service.write(rule,
// args)` runs one Vote rule (setUp, addOption, updateOption, …), persists it and pushes fresh views;
// `this.service.result()` and `this.service.view(voterId)` read.
//
// Every write takes `by: {id, name}`, the signed-in account; the client always sends it. When an
// agent leaves it out, the write is attributed to the Assistant. The Assistant never ranks or
// clicks Reveal (the rules refuse): a ballot is a person's own.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { VoteService } from "../core/store.js";
import { ASSISTANT, FIELD_KINDS, LIMITS } from "../core/vote.js";
import { DoRepository } from "./do-repository.js";

/** @param {any} args */
const withBy = (args) => ({ ...(args && typeof args === "object" ? args : {}), by: args?.by ?? ASSISTANT });

export class Gadget extends DurableObject {
  /** @param {DurableObjectState} ctx @param {unknown} env */
  constructor(ctx, env) {
    super(ctx, /** @type {any} */ (env));
    this.service = new VoteService(new DoRepository(ctx.storage));
  }

  // --- For agents: convenience verbs (see describeGadget) -----------------------------------

  /**
   * Question, fields, options and minimum voters in one validated write.
   * @param {any} args {by?, question?, fields?: [{label, kind?}], options?: [title | {title, description?, values?}], minVoters?}
   */
  setUpVote(args) { return this.service.write("setUp", withBy(args)); }

  /** Adds options (titles or {title, description?, values?}) in one write. @param {any} args {by?, options} */
  proposeOptions(args) {
    const { by, options } = withBy(args);
    return this.service.write("setUp", { by, options: options ?? [] });
  }

  /** Fills in an option's fields, by option title or id and field label or id. @param {any} args {by?, option, values, title?} */
  fillInOption(args) {
    const { by, option, values, title } = withBy(args);
    return this.service.write("updateOption", { by, option, values, title, strict: true });
  }

  /** Status, voters (who is ready, who is waiting) and the latest count by title. Never ballots. */
  getResult() { return this.service.result(); }

  /** What describeBinding shows an agent. */
  describeGadget() { return gadgetDescription(); }

  // --- Reads ---------------------------------------------------------------------------------

  /** Everything `voterId` may see: options, fields, who is ready, their own ballot, results. @param {string} voterId */
  getView(voterId) { return this.service.view(voterId); }

  /** Question, options with fields, voters and every count, as Markdown. Never includes ballots. */
  getSummaryMarkdown() { return this.service.markdown(); }

  // --- Writes (an option or field reference may be its id or its title/label) -----------------

  /** @param {any} args {by, question} */
  setQuestion(args) { return this.service.write("setQuestion", withBy(args)); }
  /** @param {any} args {by, label, kind: "text"|"long"|"url"} */
  addField(args) { return this.service.write("addField", withBy(args)); }
  /** @param {any} args {by, fieldId} */
  removeField(args) { return this.service.write("removeField", withBy(args)); }
  /** @param {any} args {by, title, values?: {fieldId: string}} */
  addOption(args) { return this.service.write("addOption", withBy(args)); }
  /** @param {any} args {by, optionId, title?, values?} */
  updateOption(args) { return this.service.write("updateOption", withBy(args)); }
  /** @param {any} args {by, optionId} */
  withdrawOption(args) { return this.service.write("withdrawOption", withBy(args)); }
  /** A person's own order; the client sends it. @param {any} args {by, ranking: optionId[]} */
  saveRanking(args) { return this.service.write("saveRanking", withBy(args)); }
  /** A person's own Reveal; the client sends it. @param {any} args {by, ready: boolean, ranking?} */
  setReady(args) { return this.service.write("setReady", withBy(args)); }
  /** @param {any} args {by, voterId} an account id or a voter's name */
  removeBallot(args) { return this.service.write("removeBallot", withBy(args)); }
  /** @param {any} args {by, minVoters} the count waits for at least this many ballots */
  setMinVoters(args) { return this.service.write("setMinVoters", withBy(args)); }
  /** @param {any} args {by} */
  reopen(args) { return this.service.write("reopen", withBy(args)); }

  // --- Live updates (used by client.js) -------------------------------------------------------

  /**
   * Keeps `callback` (an RpcTarget with update(view)), duplicated so it outlives this call, and
   * returns the current view. update(view) is then called after every change.
   * @param {any} callback @param {any} client {clientId, voterId}
   */
  subscribe(callback, client) {
    const stub = typeof callback?.dup === "function" ? callback.dup() : callback;
    return this.service.subscribe(stub, client);
  }

  /** @param {string} clientId */
  unsubscribe(clientId) { this.service.unsubscribe(clientId); }

  /** @param {string} clientId @param {string} voterId */
  ping(clientId, voterId) { return this.service.ping(clientId, voterId); }
}

const BY = { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, description: "Who is acting; leave out to act as the Assistant" };
const OPTION = {
  oneOf: [
    { type: "string", description: "The option's title" },
    {
      type: "object", required: ["title"],
      properties: {
        title: { type: "string", maxLength: LIMITS.title },
        description: { type: "string" },
        values: { type: "object", description: "{field label or id: text}", additionalProperties: { type: "string" } },
      },
    },
  ],
};
const NO_ARGS = { type: "object", properties: {} };
const REVISION = "{revision} or {error}";

/** The operations an agent reaches for first, then low-level ones. Every example runs as written. */
function gadgetDescription() {
  return {
    gadget: "format.ranked-vote",
    contract: 1,
    summary: "A ranked-choice vote (single transferable vote, one winner): a question, options with fields, " +
      "private ballots and round-by-round counts. Call from executeCode as env.<binding>.<method>(…); the " +
      "examples say env.Vote. Writes resolve to {revision, …} or {error}. Without `by` they are attributed to " +
      "the Assistant, and anyone may rename or withdraw the Assistant's options. Ranking and Reveal are each " +
      "person's own: no operation votes for someone. The count runs by itself once every voter has clicked " +
      "Reveal and there are at least minVoters of them.",
    operations: [
      {
        name: "setUpVote",
        description: "Set up or extend the vote in one validated write: question, fields, options, minimum voters. Existing field labels are reused; titles already on the list are skipped and reported. Option values are keyed by field label or id, including fields added in the same call. Adding options resets everyone's Reveal.",
        input: {
          type: "object",
          properties: {
            by: BY,
            question: { type: "string", maxLength: LIMITS.question },
            fields: { type: "array", maxItems: LIMITS.fields, items: { type: "object", required: ["label"], properties: { label: { type: "string", maxLength: LIMITS.fieldLabel }, kind: { enum: [...FIELD_KINDS], description: "text (default), long or url" } } } },
            options: { type: "array", items: OPTION },
            minVoters: { type: "integer", minimum: 1, maximum: LIMITS.voters, description: "The count waits for at least this many ballots; set it to the group's size" },
          },
        },
        example: 'await env.Vote.setUpVote({ question: "What should we call the company?", fields: [{ label: "Proposed URL", kind: "url" }], options: ["Hoarse", { title: "Lumen", description: "Light and bright", values: { "Proposed URL": "lumen.co.uk" } }], minVoters: 3 })',
        returns: "{revision, question, fields: [{id, label, kind}], added: [{id, title}], skipped: [title], minVoters, counted} or {error}",
      },
      {
        name: "proposeOptions",
        description: "Add options in one write: titles, or {title, description?, values?}. Titles already on the list are skipped. Only while voting is open.",
        input: { type: "object", required: ["options"], properties: { by: BY, options: { type: "array", minItems: 1, items: OPTION } } },
        example: 'await env.Vote.proposeOptions({ options: ["Tessel", { title: "Quill", description: "A pen, and sharp" }] })',
        returns: "{revision, added: [{id, title}], skipped: [title], …} or {error}",
      },
      {
        name: "fillInOption",
        description: "Fill in an option's fields (anyone may). Option by title or id, fields by label or id; an unknown label is refused. `title` renames it (its proposer, or anyone for the Assistant's), which moves it to the bottom of everyone else's ballot and resets Reveals.",
        input: { type: "object", required: ["option"], properties: { by: BY, option: { type: "string", description: "Option title or id" }, values: { type: "object", additionalProperties: { type: "string" } }, title: { type: "string" } } },
        example: 'await env.Vote.fillInOption({ option: "Lumen", values: { "Proposed URL": "lumen.co.uk", Description: "Light and bright" } })',
        returns: REVISION,
      },
      {
        name: "getResult",
        description: "Read the vote: question, phase (open or closed), options, voters with ready state, waitingOn (names), votersNeeded, and the latest count by title, round by round. Never includes ballots.",
        input: NO_ARGS,
        example: "await env.Vote.getResult()",
        returns: "{question, phase, minVoters, options: [{id, title, proposedBy}], voters: [{id, name, ready}], waitingOn: [name], votersNeeded, latestCount: null | {count, at, current, winner, ballots, voters, rounds: [{round, votes: {title: n}, eliminated: [title], tieBreak?}]}, earlierCounts}",
      },
      {
        name: "getSummaryMarkdown",
        description: "The whole vote as Markdown: options with their fields, voters and every count. Never includes ballots.",
        input: NO_ARGS,
        example: "await env.Vote.getSummaryMarkdown()",
        returns: "string",
      },
      {
        name: "setMinVoters",
        description: "How many ballots the count waits for (1 to 60). If everyone is already ready and there are enough, the count runs.",
        input: { type: "object", required: ["minVoters"], properties: { by: BY, minVoters: { type: "integer", minimum: 1, maximum: LIMITS.voters } } },
        example: "await env.Vote.setMinVoters({ minVoters: 4 })",
        returns: REVISION,
      },
      {
        name: "removeBallot",
        description: "Remove the ballot of a voter who is not ready, e.g. someone away holding up the count (it is logged). voterId is an account id or the voter's name. If everyone left is ready, the count runs.",
        input: { type: "object", required: ["voterId"], properties: { by: BY, voterId: { type: "string", description: "Account id or voter name" } } },
        example: 'await env.Vote.removeBallot({ voterId: "Bob" })',
        returns: REVISION,
      },
      {
        name: "reopen",
        description: "Reopen voting after a count: Reveals clear; ballots and earlier counts are kept.",
        input: { type: "object", properties: { by: BY } },
        example: "await env.Vote.reopen({})",
        returns: "{revision}",
      },
      {
        name: "setQuestion",
        description: "Change the question.",
        input: { type: "object", required: ["question"], properties: { by: BY, question: { type: "string", maxLength: LIMITS.question } } },
        example: 'await env.Vote.setQuestion({ question: "Where should the team offsite be?" })',
        returns: REVISION,
      },
      {
        name: "addField",
        description: "Add a field that every option has.",
        input: { type: "object", required: ["label"], properties: { by: BY, label: { type: "string", maxLength: LIMITS.fieldLabel }, kind: { enum: [...FIELD_KINDS] } } },
        example: 'await env.Vote.addField({ label: "Companies House check", kind: "text" })',
        returns: "{revision, field: {id, label, kind}} or {error}",
      },
      {
        name: "removeField",
        description: "Remove a field (by label or id) and its values. The Description field stays.",
        input: { type: "object", required: ["fieldId"], properties: { by: BY, fieldId: { type: "string", description: "Field label or id" } } },
        example: 'await env.Vote.removeField({ fieldId: "Proposed URL" })',
        returns: REVISION,
      },
      {
        name: "withdrawOption",
        description: "Withdraw an option (by title or id): its proposer, or anyone for the Assistant's. Only while voting is open.",
        input: { type: "object", required: ["optionId"], properties: { by: BY, optionId: { type: "string", description: "Option title or id" } } },
        example: 'await env.Vote.withdrawOption({ optionId: "Quill" })',
        returns: REVISION,
      },
      {
        name: "getView",
        description: "Low level: what one voter's screen shows, with option and field ids. Pass \"\" for anyone.",
        input: { type: "string", description: "A voter's account id, or \"\"" },
        example: 'await env.Vote.getView("")',
        returns: "{revision, question, phase, minVoters, fields, options: [{id, title, values, by}], voters, mine, results (newest first), activity, limits}",
      },
      {
        name: "addOption",
        description: "Low level: add one option; values keyed by field id or label, unknown keys ignored. Prefer proposeOptions.",
        input: { type: "object", required: ["title"], properties: { by: BY, title: { type: "string" }, values: { type: "object" } } },
        example: 'await env.Vote.addOption({ title: "Orrery" })',
        returns: "{revision, option} or {error}",
      },
      {
        name: "updateOption",
        description: "Low level: edit an option; unknown field keys are ignored. Prefer fillInOption.",
        input: { type: "object", required: ["optionId"], properties: { by: BY, optionId: { type: "string" }, title: { type: "string" }, values: { type: "object" } } },
        example: 'await env.Vote.updateOption({ optionId: "Hoarse", values: { description: "Rough or husky" } })',
        returns: REVISION,
      },
    ],
    adapt: {
      client: "client.js: the `adapt` block at the top (title, labels, layout, panels, showRounds, styles, actions, onReady) and the `app` handle",
      server: "server.js: add methods to class Gadget; this.service.write(rule, args) runs a Vote rule, persists it and pushes views",
      readme: "README.md#adapting-this-gadget",
    },
  };
}

export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(/** @type {any} */ _gadget) {
    return [{ id: "summary", label: "Options and results (Markdown)", mode: "server", contentType: "text/markdown", fileExtension: ".md" }];
  }

  /** @param {any} gadget @param {string} id */
  async export(gadget, id) {
    if (id !== "summary") throw new Error(`Unknown export format: ${id}`);
    return new Response(await gadget.getSummaryMarkdown()).body;
  }
}
