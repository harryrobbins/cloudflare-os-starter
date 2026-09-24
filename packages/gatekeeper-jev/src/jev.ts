// Jev decisions for agents and Gadgets. Jev (TypeSafe's System One decision model) answers typed
// questions over OpenRouter's Decisions API, not chat completions, so it cannot be offered as an
// AI model; this Gatekeeper holds the OpenRouter key and makes the call on the caller's behalf.
// https://openrouter.ai/docs/guides/community/jev

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ActionKind,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { JevAnswer, JevDecision, JevQuestion, JevRequest, JevSession } from "./types.js";
import TYPES_CODE from "./types-code.js";
import CONFIGURATOR_HTML from "./configurator-html.js";

export const JEV_MODEL = "typesafe/jev-1.13";
export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const TIMEOUT_MS = 15_000;
const MAX_QUESTIONS = 32;
const MAX_CHOICE_LABELS = 50;
const MAX_SCORE_LEVELS = 20;
/** Jev's window is about 32,000 tokens; this refuses what cannot fit before paying for it. */
const MAX_REQUEST_CHARS = 128_000;
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='none' stroke='currentColor' stroke-width='16'><path d='M40 128h56l32-72 32 144 32-72h24'/></svg>",
    ),
};

type ObservationQueue = Pick<ApprovalQueue, "authorizeObservation"> & Partial<{ [Symbol.dispose](): void }>;

export function describeJevVendor(): VendorDescription {
  return {
    displayName: "Jev decisions",
    url: "https://openrouter.ai/docs/guides/community/jev",
    logo: ICON,
    color: "#eef2ff",
    tagline: "Fast, calibrated yes/no, choice and score decisions",
    description:
      "TypeSafe's Jev decision model, through OpenRouter. Classify, route, triage and rate text or " +
      "data, with a probability for every answer. Data goes only to providers that neither keep nor train on it.",
    autoProvisionsAccount: true,
    providesAuth: false,
  };
}

/**
 * The one resource: Jev for the workspace it is connected to. Jev is deliberately not an agent
 * singleton (which the Workshop would install in every workspace the account owner has); like any
 * other connector, it reaches a workspace only through an explicit connection there.
 */
export const JEV_RESOURCE: SupportedResource = {
  urlPattern: "jev://decisions",
  title: "Jev decisions",
  description: "Calibrated yes/no, choice and score decisions for this workspace.",
  icon: ICON,
};

/** Accepts the resource URL (tolerating a trailing slash) and returns its canonical form. */
export function parseJevResourceUrl(url: string): string {
  if (url.replace(/\/+$/, "") !== JEV_RESOURCE.urlPattern) {
    throw new Error(`Jev decisions has one resource: ${JEV_RESOURCE.urlPattern}.`);
  }
  return JEV_RESOURCE.urlPattern;
}

export function describeJevAccount(): AccountDescription {
  return { displayName: "Jev decisions", avatar: ICON };
}

class FixedResourceConfigurator extends RpcTarget {}

/**
 * Refuses a Gatekeeper that was not made for an explicit connection. Before connections were
 * explicit, the Workshop installed this class in every workspace as an ambient capsule, created
 * without props; such an instance may still exist until the Workshop retires it, and must stay
 * inert -- no sessions, and no pending action applied -- whatever the Workshop does.
 */
export function assertExplicitConnection(props: unknown): void {
  let url = (props as { resourceUrl?: unknown } | undefined)?.resourceUrl;
  if (url !== JEV_RESOURCE.urlPattern) {
    throw new Error(
      "Jev decisions is now connected per workspace. Connect it to this workspace to use it here.");
  }
}

function isText(value: unknown): boolean {
  return typeof value === "string" ? value.trim() !== "" : !!value && typeof value === "object" && !Array.isArray(value);
}

function checkQuestion(key: string, q: JevQuestion): void {
  let where = `Question "${key}"`;
  if (!q || typeof q !== "object") throw new Error(`${where} must be an object.`);
  if (!isText(q.instructions)) throw new Error(`${where} needs instructions: text, or a structured object.`);
  switch (q.type) {
    case "noul": {
      if (q.criteria === undefined) return;
      let c = q.criteria as Record<string, unknown>;
      if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).some(k => k !== "true" && k !== "false") ||
          Object.values(c).some(v => !isText(v))) {
        throw new Error(`${where}: noul criteria may only describe "true" and "false".`);
      }
      return;
    }
    case "choice": {
      let c = q.criteria;
      let labels = c && typeof c === "object" && !Array.isArray(c) ? Object.keys(c) : [];
      if (labels.length < 2 || labels.length > MAX_CHOICE_LABELS) {
        throw new Error(`${where}: choice criteria must map 2-${MAX_CHOICE_LABELS} labels to their meanings.`);
      }
      if (labels.some(l => !KEY_PATTERN.test(l))) throw new Error(`${where}: choice labels must be identifiers (letters, digits, underscores).`);
      if (Object.values(c).some(v => !isText(v))) throw new Error(`${where}: every choice label needs a description.`);
      return;
    }
    case "score": {
      let c = q.criteria;
      if (!Array.isArray(c) || c.length < 2 || c.length > MAX_SCORE_LEVELS) {
        throw new Error(`${where}: score criteria must be an array of 2-${MAX_SCORE_LEVELS} levels, lowest first.`);
      }
      if (c.some(v => !isText(v))) throw new Error(`${where}: every score level needs a description.`);
      return;
    }
    default:
      throw new Error(`${where} has unknown type ${JSON.stringify((q as { type?: unknown }).type)}; use noul, choice or score.`);
  }
}

/** Throws a caller-facing error for anything Jev would reject or that cannot fit its window. */
export function checkRequest(request: JevRequest): void {
  if (!request || typeof request !== "object") throw new Error("decide() takes { state, questions }.");
  let { state, questions } = request;
  if (state === undefined || state === null || (typeof state === "string" ? state.trim() === "" : typeof state !== "object")) {
    throw new Error("state must be a non-empty string, object or array.");
  }
  let keys = questions && typeof questions === "object" && !Array.isArray(questions) ? Object.keys(questions) : [];
  if (keys.length < 1 || keys.length > MAX_QUESTIONS) throw new Error(`Ask 1-${MAX_QUESTIONS} questions, keyed by name.`);
  for (let key of keys) {
    if (!KEY_PATTERN.test(key)) throw new Error(`Question key "${key.slice(0, 40)}" must be an identifier (letters, digits, underscores).`);
    checkQuestion(key, questions[key]!);
  }
  let size = JSON.stringify(request).length;
  if (size > MAX_REQUEST_CHARS) {
    throw new Error(`Request is ${size} characters; Jev's window fits about ${MAX_REQUEST_CHARS}. Send less state.`);
  }
}

function isProbability(p: unknown): p is number {
  return typeof p === "number" && p >= 0 && p <= 1;
}

function checkAnswer(key: string, question: JevQuestion, answer: unknown): JevAnswer {
  let a = answer as Record<string, unknown> | undefined;
  let bad = () => new Error(`Jev returned no valid answer for "${key}".`);
  if (!a || a.type !== question.type) throw bad();
  let probabilities = (): Record<string, number> => {
    let p = a!.probabilities;
    if (!p || typeof p !== "object" || Object.values(p).some(v => !isProbability(v))) throw bad();
    return p as Record<string, number>;
  };
  switch (question.type) {
    case "noul":
      if (!isProbability(a.noul)) throw bad();
      return { type: "noul", noul: a.noul };
    case "choice":
      if (typeof a.choice !== "string" || !isProbability(a.confidence)) throw bad();
      return { type: "choice", choice: a.choice, probabilities: probabilities(), confidence: a.confidence };
    case "score":
      if (typeof a.score !== "number" || !Number.isFinite(a.score) || !isProbability(a.confidence)) throw bad();
      return { type: "score", score: a.score, probabilities: probabilities(), confidence: a.confidence };
  }
}

export type JevResult = JevDecision & { id: string };

/** One Decisions API call. The request must already have passed checkRequest. */
export async function askJev(apiKey: string, request: JevRequest, fetchImpl: typeof fetch = fetch): Promise<JevResult> {
  let res = await fetchImpl(DECISIONS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: JEV_MODEL,
      // Refuse providers that keep or train on inputs.
      provider: { data_collection: "deny", zdr: true },
      state: request.state,
      questions: request.questions,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    let detail = (await res.text()).slice(0, 300);
    throw new Error(`Jev request failed: HTTP ${res.status}${detail ? ` ${detail}` : ""}`);
  }
  let body = await res.json() as {
    id?: unknown; model?: unknown; answers?: Record<string, unknown>; usage?: { cost?: unknown };
  };
  let answers: Record<string, JevAnswer> = {};
  for (let [key, question] of Object.entries(request.questions)) {
    answers[key] = checkAnswer(key, question, body.answers?.[key]);
  }
  return {
    answers,
    id: typeof body.id === "string" ? body.id : "",
    model: typeof body.model === "string" ? body.model : JEV_MODEL,
    cost: typeof body.usage?.cost === "number" ? body.usage.cost : null,
  };
}

/** What the session needs from its Durable Object; narrow so tests can supply a fake. */
export interface JevBackend {
  ask(request: JevRequest): Promise<JevResult>;
}

function summarize(request: JevRequest): string {
  return Object.entries(request.questions).map(([key, q]) => `${key} (${q.type})`).join(", ");
}

@validateRpc()
export class JevSessionImpl extends RpcTarget implements JevSession {
  readonly #queue: ObservationQueue;
  readonly #backend: JevBackend;

  constructor(queue: ObservationQueue, backend: JevBackend) {
    super();
    this.#queue = queue;
    this.#backend = backend;
  }

  async decide(request: JevRequest): Promise<JevDecision> {
    checkRequest(request);
    let count = Object.keys(request.questions).length;
    // Authorize before the state leaves: if the observation is refused, nothing is sent.
    await this.#queue.authorizeObservation({
      title: `Jev decision: ${count} question${count === 1 ? "" : "s"}`,
      description: `Asked Jev (${JEV_MODEL}, via OpenRouter): ${summarize(request)}.`,
    });
    let { answers, model, cost } = await this.#backend.ask(request);
    return { answers, model, cost };
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]?.();
  }
}

@validateRpc()
export class JevGatekeeper extends DurableObject<Cloudflare.Env> implements Gatekeeper<JevSession>, JevBackend {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // Question keys, types and cost only: never the state or the question text.
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, questions TEXT NOT NULL,
        ok INTEGER NOT NULL, jev_id TEXT, model TEXT, cost REAL, error TEXT);
    `);
  }

  async describe(): Promise<ResourceDescription> {
    return {
      url: "jev://decisions",
      title: "Jev decisions",
      snippet: "Calibrated yes/no, choice and score decisions from TypeSafe's Jev.",
      // Usable only while a gadget binds it or a chat that accepted it still holds it.
      revocable: true,
      suggestedBindingName: "JEV",
      tsType: "JevSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(queue: RpcStub<ApprovalQueue>): Promise<JevSession> {
    assertExplicitConnection(this.ctx.props);
    return new JevSessionImpl(queue.dup(), this);
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  async applyAction(_action: number): Promise<void> {
    assertExplicitConnection(this.ctx.props);
    throw new Error("Jev decisions take no actions.");
  }

  async rejectAction(_action: number): Promise<void> {}

  async revertAction(_action: number): Promise<{ message: string }> {
    return { message: "Jev decisions take no actions." };
  }

  async ask(request: JevRequest): Promise<JevResult> {
    checkRequest(request);
    let questions = summarize(request);
    let now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM decisions WHERE at < ?", now - AUDIT_RETENTION_MS);
    try {
      let result = await askJev(this.env.OPENROUTER_API_KEY, request);
      this.ctx.storage.sql.exec(
        "INSERT INTO decisions (at, questions, ok, jev_id, model, cost) VALUES (?, ?, 1, ?, ?, ?)",
        now, questions, result.id, result.model, result.cost);
      return result;
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      this.ctx.storage.sql.exec(
        "INSERT INTO decisions (at, questions, ok, error) VALUES (?, ?, 0, ?)", now, questions, message.slice(0, 500));
      throw error;
    }
  }
}

@validateRpc()
export class JevAccount extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return describeJevAccount();
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [JEV_RESOURCE];
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<JevSession>>; resource: SupportedResource;
  }> {
    parseJevResourceUrl(url);
    return { class: this.ctx.exports.JevGatekeeper({ props: { resourceUrl: JEV_RESOURCE.urlPattern } }),
      resource: JEV_RESOURCE,
    };
  }

  async startResourceConfigurator(pattern: string): Promise<ResourceConfiguratorFrame> {
    parseJevResourceUrl(pattern);
    return { iframeHtml: CONFIGURATOR_HTML, ui: new RpcStub(new FixedResourceConfigurator()) };
  }

  async ensureResources(patterns: string[]): Promise<{ url?: string }> {
    for (let pattern of patterns) parseJevResourceUrl(pattern);
    return {};
  }

  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("Jev decisions has no credentials to reconnect.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.JevVerifier({});
  }
}

@validateRpc()
export class JevVerifier extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return describeJevVendor();
  }

  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.JevAccount({});
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Jev decisions is auto-provisioned and has no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [JEV_RESOURCE];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}
