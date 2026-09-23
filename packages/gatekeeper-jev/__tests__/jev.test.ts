import { describe, expect, it } from "vitest";
import typesSource from "../src/types.d.ts?raw";
import TYPES_CODE from "../src/types-code.js";
import {
  askJev,
  checkRequest,
  DECISIONS_URL,
  describeJevAccount,
  describeJevVendor,
  JevSessionImpl,
  type JevBackend,
} from "../src/jev.js";
import type { JevRequest } from "../src/types.js";

const request: JevRequest = {
  state: { ticket: "I was charged twice for my plan this month." },
  questions: {
    refund: { type: "noul", instructions: "Is the customer asking for money back?" },
    team: {
      type: "choice",
      instructions: "Which team should handle `ticket`?",
      criteria: { billing: "Payments, invoices, refunds", technical: "Bugs and outages", other: "Anything else" },
    },
    severity: {
      type: "score",
      instructions: "How urgent is `ticket`?",
      criteria: ["Cosmetic", { what: "Money taken wrongly", examples: ["charged twice"] }, "Service down"],
    },
  },
};

const reply = {
  id: "dec-1",
  model: "typesafe/jev-1.13",
  answers: {
    refund: { type: "noul", noul: 0.91 },
    team: { type: "choice", choice: "billing", probabilities: { billing: 0.9, technical: 0.05, other: 0.05 }, confidence: 0.85 },
    severity: { type: "score", score: 1.1, legend: { "0": "Cosmetic" }, probabilities: { "0": 0, "1": 0.9, "2": 0.1 }, confidence: 0.8 },
  },
  usage: { cost: 0.00002 },
};

function fakeFetch(body: unknown, status = 200) {
  let calls: Array<{ url: string; init: RequestInit }> = [];
  let impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("jev gatekeeper", () => {
  it("serves types that match types.d.ts", () => {
    expect(TYPES_CODE).toBe(typesSource);
  });

  it("describes an auto-provisioned singleton", () => {
    expect(describeJevVendor()).toMatchObject({ autoProvisionsAccount: true, providesAuth: false });
    expect(describeJevAccount()).toMatchObject({ singleton: { tsType: "JevSession" } });
  });

  it("accepts all three question types", () => {
    expect(() => checkRequest(request)).not.toThrow();
  });

  it.each([
    ["no questions", { state: "x", questions: {} }, /1-32 questions/],
    ["empty state", { state: " ", questions: request.questions }, /state/],
    ["bad key", { state: "x", questions: { "not ok": request.questions.refund } }, /identifier/],
    ["unknown type", { state: "x", questions: { q: { type: "rank", instructions: "?" } } }, /unknown type/],
    ["one choice label", { state: "x", questions: { q: { type: "choice", instructions: "?", criteria: { a: "A" } } } }, /2-50 labels/],
    ["score as object", { state: "x", questions: { q: { type: "score", instructions: "?", criteria: { a: "A" } } } }, /array/],
    ["noul criteria keys", { state: "x", questions: { q: { type: "noul", instructions: "?", criteria: { yes: "Y" } } } }, /"true" and "false"/],
    ["too large", { state: "x".repeat(130_000), questions: request.questions }, /window/],
  ])("refuses %s", (_name, bad, message) => {
    expect(() => checkRequest(bad as JevRequest)).toThrow(message);
  });

  it("calls the Decisions API with a zero-retention provider policy and returns typed answers", async () => {
    let { impl, calls } = fakeFetch(reply);
    let result = await askJev("sk-test", request, impl);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(DECISIONS_URL);
    let sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent).toMatchObject({
      model: "typesafe/jev-1.13",
      provider: { data_collection: "deny", zdr: true },
      state: request.state,
      questions: request.questions,
    });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect(result).toEqual({
      id: "dec-1",
      model: "typesafe/jev-1.13",
      cost: 0.00002,
      answers: {
        refund: { type: "noul", noul: 0.91 },
        team: { type: "choice", choice: "billing", probabilities: { billing: 0.9, technical: 0.05, other: 0.05 }, confidence: 0.85 },
        severity: { type: "score", score: 1.1, probabilities: { "0": 0, "1": 0.9, "2": 0.1 }, confidence: 0.8 },
      },
    });
  });

  it("reports an HTTP failure with its status", async () => {
    let { impl } = fakeFetch("insufficient credits", 402);
    await expect(askJev("sk-test", request, impl)).rejects.toThrow(/HTTP 402 insufficient credits/);
  });

  it("refuses an answer of the wrong type or missing", async () => {
    let { impl } = fakeFetch({ ...reply, answers: { ...reply.answers, refund: { type: "choice", choice: "yes" } } });
    await expect(askJev("sk-test", request, impl)).rejects.toThrow(/"refund"/);
    let missing = fakeFetch({ ...reply, answers: { refund: reply.answers.refund } });
    await expect(askJev("sk-test", request, missing.impl)).rejects.toThrow(/"team"/);
  });

  it("records an observation before anything is sent, and sends nothing when it is refused", async () => {
    let log: string[] = [];
    let backend: JevBackend = {
      async ask() {
        log.push("ask");
        return { id: "dec-1", model: "typesafe/jev-1.13", cost: 0.00002, answers: { refund: { type: "noul", noul: 0.9 } } };
      },
    };
    let queue = { async authorizeObservation(d: { title: string; description: string }) { log.push(`observe:${d.title}:${d.description}`); } };
    let session = new JevSessionImpl(queue as never, backend);
    let result = await session.decide(request);
    expect(log[0]).toMatch(/^observe:Jev decision: 3 questions:.*refund \(noul\), team \(choice\), severity \(score\)/);
    expect(log[0]).not.toContain("charged twice");
    expect(log[1]).toBe("ask");
    expect(result).toEqual({ model: "typesafe/jev-1.13", cost: 0.00002, answers: { refund: { type: "noul", noul: 0.9 } } });

    let refused = new JevSessionImpl({ async authorizeObservation() { throw new Error("denied"); } } as never, backend);
    log.length = 0;
    await expect(refused.decide(request)).rejects.toThrow("denied");
    expect(log).toEqual([]);
  });

  it("refuses an invalid request without observing or sending", async () => {
    let log: string[] = [];
    let session = new JevSessionImpl(
      { async authorizeObservation() { log.push("observe"); } } as never,
      { async ask() { log.push("ask"); throw new Error("unreachable"); } },
    );
    await expect(session.decide({ state: "x", questions: {} })).rejects.toThrow(/questions/);
    expect(log).toEqual([]);
  });
});
