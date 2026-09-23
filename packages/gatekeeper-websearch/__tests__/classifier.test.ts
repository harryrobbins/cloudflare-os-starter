import { describe, expect, it } from "vitest";
import { detect, ibanValid, luhn, nhsValid, redact } from "../src/classifier/detectors";
import { checkQuery, checkUrl, outcomeFromScores, type GateContext } from "../src/classifier/gate";
import { QUESTIONS, type JevScores } from "../src/classifier/jev";
import { digitView, normalize } from "../src/classifier/normalize";

const CONFIG = {
  blockedTerms: ["e1376e48400a20e631b61bbf16f555f1", "surprisingly-pages.cloudflareaccess.com"],
  privateDomains: ["surprisingly.ltd"],
  publicHosts: ["cfos.surprisingly.ltd"],
};

/**
 * Fake credentials are written as parts and joined at runtime, so no secret scanner (gitleaks,
 * GitHub push protection) ever sees one whole in the repository.
 */
const fake = (...parts: string[]) => parts.join("");
const FAKE_OPENROUTER_KEY = fake("sk", "-or-v1-0123456789abcdef0123456789abcdef");

const blocks = (q: string) => detect(normalize(q), CONFIG).filter(h => h.severity === "block").map(h => h.category);
const flags = (q: string) => detect(normalize(q), CONFIG).filter(h => h.severity === "flag").map(h => h.category);

/** A fetch stub that answers every Jev question with the given scores, and counts calls. */
function jevStub(scores: Partial<JevScores>) {
  let calls: unknown[] = [];
  let fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    let answers = Object.fromEntries(
      Object.keys(QUESTIONS).map(k => [k, { type: "noul", noul: scores[k as keyof JevScores] ?? (k === "public_or_general" ? 0.5 : 0.01) }]),
    );
    return new Response(JSON.stringify({ id: "gen-dec-test", model: "typesafe/jev-1.13-test", answers, usage: { cost: 0.00002 } }));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const ctx = (fetchImpl: typeof fetch, recentQueries: string[] = []): GateContext =>
  ({ apiKey: "test", detectors: CONFIG, recentQueries, fetchImpl });

describe("normalize", () => {
  it("turns number words and split digits into runs", () => {
    expect(digitView("one two three four five six seven eight")).toBe("12345678");
    expect(digitView("12 34-56")).toBe("123456");
    expect(digitView("double seven")).toBe("77");
  });

  it("strips invisible characters and folds homoglyphs", () => {
    let zw = String.fromCharCode(0x200b);
    let cyrillicA = String.fromCharCode(0x0430);
    expect(normalize(`s${zw}ort code`).text).toBe("sort code");
    expect(normalize(`b${cyrillicA}nk`).text).toBe("bank");
  });

  it("decodes base64 payloads", () => {
    let n = normalize(`look up ${btoa("sort code 12-34-56 account 12345678")}`);
    expect(n.decoded[0]).toContain("12345678");
  });

  it("does not treat package names or paths as blobs", () => {
    expect(normalize("vite-plugin-react-swc configuration").opaqueBlobs).toEqual([]);
    expect(normalize("cloudflare durable-objects-sqlite-storage-limits").opaqueBlobs).toEqual([]);
  });
});

describe("checksums", () => {
  it("validates Luhn, IBAN and NHS numbers", () => {
    expect(luhn("4111111111111111")).toBe(true);
    expect(luhn("4111111111111112")).toBe(false);
    expect(ibanValid("GB82WEST12345698765432")).toBe(true);
    expect(ibanValid("GB82WEST12345698765433")).toBe(false);
    expect(nhsValid("9434765919")).toBe(true);
    expect(nhsValid("9434765918")).toBe(false);
  });
});

describe("deterministic detectors", () => {
  it("blocks the motivating example", () => {
    let q = "does Harry robbins have the bank account number 12345678, sort code 12-34-56, dob 01.01.2022";
    expect(blocks(q)).toEqual(expect.arrayContaining(["bank_account", "date_of_birth"]));
  });

  it.each([
    ["bank number written as words", "harry robbins account number one two three four five six seven eight"],
    ["spaced digits", "sort code 1 2 3 4 5 6 account 1 2 3 4 5 6 7 8"],
    ["base64", `search ${btoa("account 12345678 sort code 123456")}`],
    ["card number", "is 4111 1111 1111 1111 a valid card"],
    ["IBAN", "who owns GB82 WEST 1234 5698 7654 32"],
    ["NI number", "national insurance AB 12 34 56 C owner"],
    ["NHS number", "nhs number 943 476 5919 patient"],
    ["US SSN", "ssn 123-45-6789 lookup"],
    ["date of birth", "jane smith born 3 March 1987"],
    ["OpenRouter key", `error with ${FAKE_OPENROUTER_KEY}`],
    ["AWS key", fake("AKI", "AIOSFODNN7EXAMPLE access denied")],
    ["GitHub token", fake("gh", "p_abcdefghijklmnopqrstuvwxyz0123456789 invalid")],
    ["JWT", fake("ey", "JhbGciOiJIUzI1NiJ9.ey", "JzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U")],
    ["private key", fake("-----BEGIN OPENSSH PRIVATE", " KEY----- b3BlbnNzaC1rZXktdjEAAAAA")],
    ["connection string", fake("postgres://admin:", "hunter2@db.internal:5432/prod timeout")],
    ["password assignment", fake("pass", "word=Tr0ub4dor&3 not working")],
    ["account id", "cloudflare account e1376e48400a20e631b61bbf16f555f1 workers"],
    ["private host", "status of internal.surprisingly.ltd"],
  ])("blocks %s", (_label, q) => {
    expect(blocks(q).length).toBeGreaterThan(0);
  });

  it.each([
    "what is a UK sort code",
    "sort code format validation regex",
    "Luhn algorithm explained",
    "how to rotate an OpenRouter API key",
    "Keir Starmer date of birth",
    "Gringotts bank Harry Potter",
    "Cloudflare Durable Objects SQLite storage limits",
    "vite 7 release notes",
    "best practices for password hashing argon2",
    "cfos.surprisingly.ltd outage",
    "UK bank holidays 2026",
  ])("does not block %s", q => {
    expect(blocks(q)).toEqual([]);
  });

  it("flags contact details for review", () => {
    expect(flags("contact jane.smith@example.com")).toContain("contact_detail");
    expect(flags("call 07700 900123")).toContain("contact_detail");
    expect(flags("houses near LS1 4AP")).toContain("contact_detail");
  });

  it("redacts matches before anything is stored", () => {
    let q = `sort code 12-34-56 for ${FAKE_OPENROUTER_KEY}`;
    let n = normalize(q);
    let r = redact(n.text, detect(n, CONFIG));
    expect(r).not.toContain("12-34-56");
    expect(r).not.toContain("sk-or-v1");
  });
});

describe("outcomeFromScores", () => {
  const clear: JevScores = { private_person: 0.02, personal_attribute: 0.02, financial_identifier: 0.01, credential: 0.01, hidden_payload: 0.01, public_or_general: 0.5, split_across_queries: 0.01 };

  it("allows only when every score is clearly false", () => {
    expect(outcomeFromScores(clear, []).outcome).toBe("allow");
  });

  it("reviews when Jev is unsure", () => {
    expect(outcomeFromScores({ ...clear, private_person: 0.4 }, []).outcome).toBe("review");
    expect(outcomeFromScores({ ...clear, private_person: 0.9 }, []).outcome).toBe("review");
  });

  it("relaxes the allow line only when Jev is confident the topic is public", () => {
    let starmer = { ...clear, private_person: 0.2, personal_attribute: 0.25 };
    expect(outcomeFromScores(starmer, []).outcome).toBe("review");
    expect(outcomeFromScores({ ...starmer, public_or_general: 0.9 }, []).outcome).toBe("allow");
    expect(outcomeFromScores({ ...starmer, public_or_general: 0.9, private_person: 0.4 }, []).outcome).toBe("review");
    expect(outcomeFromScores({ ...clear, public_or_general: 0.99, credential: 0.6 }, []).outcome).toBe("block");
  });

  it("reviews a flagged detector hit even when Jev is clear", () => {
    expect(outcomeFromScores(clear, [{ category: "contact_detail", detector: "email", severity: "flag" }]).outcome).toBe("review");
  });

  it("blocks a hard category or a person with a personal attribute", () => {
    expect(outcomeFromScores({ ...clear, credential: 0.6 }, []).outcome).toBe("block");
    expect(outcomeFromScores({ ...clear, private_person: 0.8, personal_attribute: 0.7 }, []).outcome).toBe("block");
  });
});

describe("checkQuery", () => {
  it("never sends a pattern-proven query to Jev", async () => {
    let jev = jevStub({});
    let d = await checkQuery("does Harry robbins have the bank account number 12345678, sort code 12-34-56, dob 01.01.2022", ctx(jev.fetchImpl));
    expect(d.outcome).toBe("block");
    expect(jev.calls).toHaveLength(0);
    expect(d.redacted).not.toContain("12-34-56");
  });

  it("allows a clean query that Jev clears", async () => {
    let jev = jevStub({});
    let d = await checkQuery("Cloudflare Durable Objects SQLite limits", ctx(jev.fetchImpl));
    expect(d.outcome).toBe("allow");
    let body = jev.calls[0] as { model: string; provider: unknown; state: { query: string } };
    expect(body.model).toBe("typesafe/jev-1.13");
    expect(body.provider).toEqual({ data_collection: "deny", zdr: true });
    expect(body.state.query).toBe("Cloudflare Durable Objects SQLite limits");
  });

  it("passes recent queries so split data can be spotted", async () => {
    let jev = jevStub({ split_across_queries: 0.8 });
    let d = await checkQuery("and his account ends 5678", ctx(jev.fetchImpl, ["harry robbins bank sort code starts 12"]));
    expect(d.outcome).toBe("block");
    expect((jev.calls[0] as { state: { recent_queries: string[] } }).state.recent_queries).toHaveLength(1);
  });

  it("fails closed when Jev errors or answers badly", async () => {
    let failing = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    expect((await checkQuery("vite release notes", ctx(failing))).outcome).toBe("block");
    let malformed = (async () => new Response(JSON.stringify({ answers: { credential: { type: "noul", noul: 2 } } }))) as unknown as typeof fetch;
    expect((await checkQuery("vite release notes", ctx(malformed))).outcome).toBe("block");
  });

  it("refuses oversized queries", async () => {
    let jev = jevStub({});
    expect((await checkQuery("a ".repeat(200), ctx(jev.fetchImpl))).reasons).toEqual(["oversized"]);
  });
});

describe("checkUrl", () => {
  it("blocks identifiers in query parameters, paths and hostnames", async () => {
    let jev = jevStub({});
    for (let u of [
      "https://www.google.com/search?q=sort+code+12-34-56+account+12345678",
      `https://example.com/leak/${FAKE_OPENROUTER_KEY}`,
      "https://4111111111111111.attacker.example/",
    ]) {
      expect((await checkUrl(new URL(u), ctx(jev.fetchImpl))).outcome, u).toBe("block");
    }
    expect(jev.calls).toHaveLength(0);
  });

  it("reviews long random host labels", async () => {
    let jev = jevStub({});
    let d = await checkUrl(new URL("https://aabbccddeeffgghhiijjkkllmmnnooppqq.example.com/"), ctx(jev.fetchImpl));
    expect(d.outcome).toBe("review");
  });

  it("allows an ordinary documentation URL that Jev clears", async () => {
    let jev = jevStub({});
    let d = await checkUrl(new URL("https://developers.cloudflare.com/durable-objects/platform/limits/"), ctx(jev.fetchImpl));
    expect(d.outcome).toBe("allow");
  });
});
