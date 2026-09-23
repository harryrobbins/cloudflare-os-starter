import { describe, expect, it } from "vitest";
import typesSource from "../src/types.d.ts?raw";
import TYPES_CODE from "../src/types-code.js";
import type { GateDecision } from "../src/classifier/gate.js";
import {
  describeWebSearchAccount,
  describeWebSearchVendor,
  WebSearchSessionImpl,
  type WebSearchBackend,
} from "../src/websearch.js";

function decision(outcome: GateDecision["outcome"], text: string, reasons: string[] = []): GateDecision {
  return { outcome, reasons, text, redacted: text, hits: [], jev: null };
}

function harness(outcome: GateDecision["outcome"], opts: { submitFails?: boolean } = {}) {
  let log: string[] = [];
  let submitted: Array<{ action: number; description: Record<string, unknown> }> = [];
  let unstaged: number[] = [];
  let queue = {
    async authorizeObservation(d: { title: string }) { log.push(`observe:${d.title}`); },
    async submitAction(action: number, description: Record<string, unknown>) {
      if (opts.submitFails) throw new Error("queue closed");
      log.push(`submit:${action}`);
      submitted.push({ action, description });
    },
  };
  let backend: WebSearchBackend = {
    async gate(request) {
      let text = request.kind === "search" ? request.query : request.url;
      log.push(`gate:${text}`);
      return decision(outcome, text, outcome === "allow" ? [] : ["financial_identifier"]);
    },
    async run(request) {
      log.push(`run:${request.kind}`);
      return request.kind === "search"
        ? { status: "ok", results: [{ title: "T", url: "https://example.com/", snippet: "S" }] }
        : { status: "ok", page: { status: 200, finalUrl: request.url, contentType: "text/html", body: "# Hi", truncated: false } };
    },
    stagePending() { return 7; },
    unstagePending(action) { unstaged.push(action); },
    readResult(action) {
      return action === 7 ? { status: "ok", results: [] } : { status: "pending" };
    },
  };
  let session = new WebSearchSessionImpl(queue as never, backend);
  return { session, log, submitted, unstaged };
}

describe("websearch gatekeeper", () => {
  it("serves types that match types.d.ts", () => {
    expect(TYPES_CODE).toBe(typesSource);
  });

  it("describes an auto-provisioned singleton", () => {
    expect(describeWebSearchVendor()).toMatchObject({ autoProvisionsAccount: true, providesAuth: false });
    expect(describeWebSearchAccount()).toMatchObject({ singleton: { tsType: "WebSearchSession" } });
  });

  it("refuses a blocked query without observing, searching or asking", async () => {
    let h = harness("block");
    await expect(h.session.search("sort code 12-34-56")).rejects.toThrow(/refused by the privacy gate/);
    expect(h.log).toEqual(["gate:sort code 12-34-56"]);
  });

  it("authorizes the observation before an allowed query leaves", async () => {
    let h = harness("allow");
    let result = await h.session.search("vite 7 release notes");
    expect(result).toMatchObject({ status: "ok", results: [{ url: "https://example.com/" }] });
    expect(h.log).toEqual(["gate:vite 7 release notes", "observe:Web search: vite 7 release notes", "run:search"]);
  });

  it("asks the user to approve an uncertain query, and runs nothing yet", async () => {
    let h = harness("review");
    let result = await h.session.search("jane smith leeds");
    expect(result).toEqual({ status: "pending", action: 7, reasons: ["financial_identifier"] });
    expect(h.log).toEqual(["gate:jane smith leeds", "submit:7"]);
    expect(h.submitted[0].description).toMatchObject({ awaitDecision: true, implementsRevert: false });
    expect(String(h.submitted[0].description.description)).toContain("jane smith leeds");
  });

  it("unstages the request if the approval queue refuses it", async () => {
    let h = harness("review", { submitFails: true });
    await expect(h.session.search("jane smith leeds")).rejects.toThrow("queue closed");
    expect(h.unstaged).toEqual([7]);
  });

  it("gates fetches the same way", async () => {
    let blocked = harness("block");
    await expect(blocked.session.fetchPage("https://example.com/?q=12345678")).rejects.toThrow(/URL was refused/);
    let allowed = harness("allow");
    let page = await allowed.session.fetchPage("https://example.com/docs");
    expect(page).toMatchObject({ status: "ok", page: { body: "# Hi" } });
    expect(allowed.log[1]).toBe("observe:Websafe fetch: example.com");
  });

  it("always asks the user before an unchecked fetch, and never consults the gate", async () => {
    let h = harness("allow");
    let result = await h.session.fetchUnchecked("https://example.com/?q=anything");
    expect(result).toEqual({ status: "pending", action: 7, reasons: ["unchecked"] });
    expect(h.log).toEqual(["submit:7"]);
    expect(h.submitted[0].description).toMatchObject({ awaitDecision: true, title: "UNSAFE web fetch: example.com" });
    await expect(h.session.fetchUnchecked("http://example.com/")).rejects.toThrow(/https/);
  });

  it("observes before handing back an approved result", async () => {
    let h = harness("review");
    expect(await h.session.getResult(7)).toEqual({ status: "ok", results: [] });
    expect(h.log).toEqual(["observe:Read approved web result #7"]);
    expect(await h.session.getResult(8)).toEqual({ status: "pending" });
  });

  it("check() reports the decision without running anything", async () => {
    let h = harness("review");
    expect(await h.session.check({ query: "jane smith" })).toEqual({ outcome: "review", reasons: ["financial_identifier"] });
    expect(h.log).toEqual(["gate:jane smith"]);
  });
});
