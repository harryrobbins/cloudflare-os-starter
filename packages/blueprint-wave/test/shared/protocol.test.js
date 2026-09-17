import { serialize } from "node:v8";
import { describe, expect, it } from "vitest";
import {
  LIMITS, EVENT_KINDS, RUN_OPS, RUN_STATES, BLIP_KINDS, SEQ_DIGITS,
  cleanAnchor, cleanBase64, cleanBlipIds, cleanBlipOp, cleanDecisionFields, cleanKind, cleanParticipantOp,
  cleanPresence, cleanProposalFields, cleanSeq, compareBlips, decodeBytes, decodedLength, depthOf, encodeBytes,
  isAcceptableOrderKey, isBlipId, isEventKind, isId, isOrderKey, isRequestId, isRunId, isRunOp, isRunState,
  isSession, isTemplateId, newId, newSession, parseSeqKey, previewOf, rootOf, seqKey, storedBytes,
} from "../../src/shared/protocol.js";

const bid = (n) => "b_" + n.toString(16).padStart(12, "0");
const b64 = (bytes) => encodeBytes(Uint8Array.from(bytes));

describe("ids and tokens", () => {
  it("generates blip, run and history ids that validate by kind", () => {
    const b = newId("blip"), r = newId("run"), h = newId("history");
    expect(isId(b)).toBe(true);
    expect(isBlipId(b)).toBe(true);
    expect(isRunId(r)).toBe(true);
    expect(isId(h, "history")).toBe(true);
    expect(isBlipId(r)).toBe(false);
    expect(isRunId(b)).toBe(false);
    expect(isId("b_1234")).toBe(false);
    expect(isId("b_" + "G".repeat(12))).toBe(false);
    expect(isId("B_" + "a".repeat(12))).toBe(false);
    expect(isSession(newSession())).toBe(true);
    expect(isSession("0a".repeat(15))).toBe(false);
    expect(isRequestId("abc:1")).toBe(true);
    expect(isRequestId("a".repeat(65))).toBe(false);
    expect(isRequestId("has space")).toBe(false);
    expect(isTemplateId("design_review")).toBe(true);
    expect(isTemplateId("Design")).toBe(false);
  });
});

describe("sequence keys", () => {
  it("zero-pads to 12 digits so lexical order is numeric order", () => {
    expect(seqKey(0)).toBe("000000000000");
    expect(seqKey(42)).toBe("000000000042");
    expect(seqKey(42)).toHaveLength(SEQ_DIGITS);
    const seqs = [1, 9, 10, 99, 100, 1000, 123456789, 999999999999];
    const keys = seqs.map(seqKey);
    expect([...keys].sort()).toEqual(keys);
    expect(() => seqKey(-1)).toThrow();
    expect(() => seqKey(1.5)).toThrow();
    expect(() => seqKey(10 ** 12)).toThrow();
    expect(() => seqKey(NaN)).toThrow();
  });
  it("parses the tail of prefixed keys and rejects the rest", () => {
    expect(parseSeqKey("000000000042")).toBe(42);
    expect(parseSeqKey("event:000000000007")).toBe(7);
    expect(parseSeqKey("upd:" + bid(1) + ":000000000099")).toBe(99);
    expect(parseSeqKey("upd:" + bid(1) + ":00000000009")).toBeNull();
    expect(parseSeqKey("x000000000007")).toBeNull();
    expect(parseSeqKey("event:00000000000a")).toBeNull();
    expect(parseSeqKey(7)).toBeNull();
    expect(parseSeqKey("")).toBeNull();
  });
  it("cleanSeq accepts non-negative safe integers only", () => {
    expect(cleanSeq(0)).toBe(0);
    expect(cleanSeq(5)).toBe(5);
    expect(cleanSeq(-1)).toBeNull();
    expect(cleanSeq(1.5)).toBeNull();
    expect(cleanSeq("5")).toBeNull();
    expect(cleanSeq(2 ** 53)).toBeNull();
  });
});

describe("base64", () => {
  it("round-trips bytes, including empty and all byte values", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(decodeBytes(encodeBytes(all))).toEqual(all);
    expect(decodeBytes(encodeBytes(new Uint8Array(0)))).toEqual(new Uint8Array(0));
    expect(encodeBytes(Uint8Array.from([0, 1, 2, 250, 255]))).toBe("AAEC+v8=");
    const big = new Uint8Array(200_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 255;
    const s = encodeBytes(big);
    expect(s.length % 4).toBe(0);
    expect(decodeBytes(s)).toEqual(big);
  });
  it("returns null on malformed input and over the cap", () => {
    for (const bad of ["abc", "!!!!", "AAE=C", "AA==AA==", "A===", null, 5, {}, "AAEC+v8", "AAEC+v8==="]) {
      expect(decodeBytes(bad)).toBeNull();
    }
    expect(decodeBytes("AAEC+v8=", 5)).not.toBeNull();
    expect(decodeBytes("AAEC+v8=", 4)).toBeNull();
    expect(decodedLength("AAEC+v8=")).toBe(5);
    expect(decodedLength("AAECAw==")).toBe(4);
    expect(decodedLength("AAE=")).toBe(2);
    expect(decodedLength("AAECAw")).toBe(-1);
    expect(decodeBytes("")).toEqual(new Uint8Array(0));
  });
  it("cleanBase64 canonicalises or nulls", () => {
    expect(cleanBase64("AAEC+v8=", 512)).toBe("AAEC+v8=");
    expect(cleanBase64("AAEC+v8=", 2)).toBeNull();
    expect(cleanBase64("nope!", 512)).toBeNull();
    expect(cleanBase64(undefined, 512)).toBeNull();
  });
});

describe("enumerations", () => {
  it("exposes the kind, op and state unions", () => {
    expect(BLIP_KINDS).toEqual(["note", "brief", "agent", "proposal", "decision"]);
    expect(RUN_OPS).toEqual(["summarise", "compare", "next_steps", "refresh_brief", "catch_up"]);
    expect(RUN_STATES).toEqual(["queued", "running", "done", "failed", "cancelled", "unknown"]);
    expect(EVENT_KINDS).toContain("blip.create");
    expect(EVENT_KINDS).toContain("run.unknown");
    expect(EVENT_KINDS).toContain("structure");
    expect(EVENT_KINDS).toHaveLength(15);
    expect(isEventKind("text")).toBe(true);
    expect(isEventKind("blip.rename")).toBe(false);
    expect(isRunOp("compare")).toBe(true);
    expect(isRunOp("delete_all")).toBe(false);
    expect(isRunState("unknown")).toBe(true);
    expect(isRunState("pending")).toBe(false);
    expect(cleanKind("decision")).toBe("decision");
    expect(cleanKind("Decision")).toBeNull();
    expect(cleanKind(1)).toBeNull();
  });
});

describe("limits", () => {
  it("match the plan's table", () => {
    expect(LIMITS.blips).toBe(2000);
    expect(LIMITS.replyDepth).toBe(6);
    expect(LIMITS.textChars).toBe(16000);
    expect(LIMITS.textStateBytes).toBe(96 * 1024);
    expect(LIMITS.updBytesPerBlip).toBe(256 * 1024);
    expect(LIMITS.updBytesPerWave).toBe(4 * 1024 * 1024);
    expect(LIMITS.events).toBe(5000);
    expect(LIMITS.eventBytes).toBe(1024 * 1024);
    expect(LIMITS.participants).toBe(100);
    expect(LIMITS.subscribers).toBe(100);
    expect(LIMITS.caretBytes).toBe(512);
    expect(LIMITS.runs).toMatchObject({ running: 1, queued: 3, perHour: 30, inputBytes: 24 * 1024, outputBytes: 16 * 1024, timeoutMs: 90_000 });
    expect(LIMITS.proposalFieldChars).toBe(8192);
    expect(LIMITS.decisionFieldChars).toBe(4096);
    expect(LIMITS.exportBytes).toBe(2 * 1024 * 1024);
    expect(LIMITS.title).toBe(200);
    expect(LIMITS.displayName).toBe(40);
    expect(LIMITS.compaction).toEqual({ updates: 100, bytes: 64 * 1024 });
    expect(LIMITS.requestRecords).toBeGreaterThan(0);
    expect(LIMITS.requestRecordBytes).toBeLessThanOrEqual(128 * 1024);
    expect(Object.isFrozen(LIMITS)).toBe(true);
    expect(Object.isFrozen(LIMITS.runs)).toBe(true);
  });
});

describe("anchors", () => {
  it("accepts end and para with a decodable pos, rejects the rest", () => {
    expect(cleanAnchor({ type: "end" })).toEqual({ type: "end" });
    expect(cleanAnchor({ type: "end", extra: 1 })).toEqual({ type: "end" });
    expect(cleanAnchor({ type: "para", pos: "AAEC+v8=" })).toEqual({ type: "para", pos: "AAEC+v8=" });
    expect(cleanAnchor({ type: "para", pos: "" })).toBeNull();
    expect(cleanAnchor({ type: "para", pos: "not base64!" })).toBeNull();
    expect(cleanAnchor({ type: "para", pos: b64(new Array(LIMITS.caretBytes + 1).fill(1)) })).toBeNull();
    expect(cleanAnchor({ type: "para", pos: b64(new Array(LIMITS.caretBytes).fill(1)) })).not.toBeNull();
    expect(cleanAnchor({ type: "middle" })).toBeNull();
    expect(cleanAnchor("end")).toBeNull();
    expect(cleanAnchor(null)).toBeNull();
  });
});

describe("blip ops", () => {
  it("cleans creates: parent, anchor default, kind, order, text", () => {
    const root = cleanBlipOp({ op: "create", blipId: bid(1), parentId: null, anchor: { type: "end" }, kind: "brief", order: "a0" });
    expect(root).toEqual({ ok: true, op: { op: "create", blipId: bid(1), parentId: null, kind: "brief", order: "a0" } });
    const reply = cleanBlipOp({ op: "create", blipId: bid(2), parentId: bid(1), text: "hi\r\nthere" });
    expect(reply).toEqual({ ok: true, op: { op: "create", blipId: bid(2), parentId: bid(1), anchor: { type: "end" }, text: "hi\nthere" } });
    const para = cleanBlipOp({ op: "create", blipId: bid(2), parentId: bid(1), anchor: { type: "para", pos: "AAEC" } });
    expect(para.ok && para.op.anchor).toEqual({ type: "para", pos: "AAEC" });
    expect(cleanBlipOp({ op: "create", blipId: bid(2), parentId: bid(1), order: "not a key!" }).op.order).toBeUndefined();
  });
  it("reports the right error codes", () => {
    expect(cleanBlipOp(null)).toMatchObject({ ok: false, code: "invalid_op" });
    expect(cleanBlipOp({ op: "create", blipId: "x" })).toMatchObject({ ok: false, code: "invalid_id" });
    expect(cleanBlipOp({ op: "create", blipId: bid(1), parentId: "nope" })).toMatchObject({ ok: false, code: "invalid_id" });
    expect(cleanBlipOp({ op: "create", blipId: bid(1), parentId: null, kind: "decision" })).toMatchObject({ ok: false, code: "invalid_op" });
    expect(cleanBlipOp({ op: "create", blipId: bid(1), parentId: bid(2), anchor: { type: "para", pos: "!" } })).toMatchObject({ ok: false, code: "invalid_ref" });
    expect(cleanBlipOp({ op: "create", blipId: bid(1), parentId: null, text: "x".repeat(LIMITS.textChars + 1) })).toMatchObject({ ok: false, code: "limit" });
    expect(cleanBlipOp({ op: "create", blipId: bid(1), parentId: null, text: "x".repeat(LIMITS.textChars) }).ok).toBe(true);
    expect(cleanBlipOp({ op: "delete", blipId: bid(1) })).toMatchObject({ ok: false, code: "invalid_op" });
    expect(cleanBlipOp({ op: "rename", blipId: bid(1) })).toMatchObject({ ok: false, code: "invalid_op" });
    expect(cleanBlipOp({ op: "move", blipId: bid(1), baseVersion: 1, parentId: bid(1) })).toMatchObject({ ok: false, code: "invalid_ref" });
  });
  it("cleans delete, restore and move", () => {
    expect(cleanBlipOp({ op: "delete", blipId: bid(1), baseVersion: 3, junk: 1 })).toEqual({ ok: true, op: { op: "delete", blipId: bid(1), baseVersion: 3 } });
    expect(cleanBlipOp({ op: "restore", blipId: bid(1), baseVersion: 0 })).toEqual({ ok: true, op: { op: "restore", blipId: bid(1), baseVersion: 0 } });
    expect(cleanBlipOp({ op: "move", blipId: bid(1), baseVersion: 2, parentId: bid(2), order: "a1" }))
      .toEqual({ ok: true, op: { op: "move", blipId: bid(1), baseVersion: 2, parentId: bid(2), anchor: { type: "end" }, order: "a1" } });
    expect(cleanBlipOp({ op: "move", blipId: bid(1), baseVersion: 2, parentId: null }))
      .toEqual({ ok: true, op: { op: "move", blipId: bid(1), baseVersion: 2, parentId: null } });
  });
  it("ignores prototype keys", () => {
    const raw = JSON.parse(`{"__proto__": {"op": "create"}, "op": "delete", "blipId": "${bid(1)}", "baseVersion": 1}`);
    expect(cleanBlipOp(raw)).toMatchObject({ ok: true, op: { op: "delete" } });
  });
});

describe("participants", () => {
  it("cleans upsert and remove", () => {
    expect(cleanParticipantOp({ op: "upsert", participant: { id: "p:1", name: " Ann\n", color: "#ABCDEF" } }))
      .toEqual({ op: "upsert", participant: { id: "p:1", name: "Ann", color: "#abcdef" } });
    expect(cleanParticipantOp({ op: "upsert", participant: { id: "p:1", name: "", color: "red" } }).participant)
      .toMatchObject({ name: "Guest", color: "#e1632e" });
    expect(cleanParticipantOp({ op: "remove", id: "p:1" })).toEqual({ op: "remove", id: "p:1" });
    expect(cleanParticipantOp({ op: "remove", id: "bad id" })).toBeNull();
    expect(cleanParticipantOp({ op: "upsert", participant: { id: "" } })).toBeNull();
    expect(cleanParticipantOp("x")).toBeNull();
  });
});

describe("proposal and decision fields", () => {
  it("caps and cleans proposal fields", () => {
    const p = cleanProposalFields({ targetId: bid(1), quote: "q".repeat(9000), replacement: "r\r\nx", summary: "one\nline", sources: [bid(2), "bad", bid(2), bid(3)] });
    expect(p.quote).toHaveLength(LIMITS.proposalFieldChars);
    expect(p).toMatchObject({ targetId: bid(1), replacement: "r\nx", summary: "one line", sources: [bid(2), bid(3)] });
    expect(cleanProposalFields({ targetId: bid(1) })).toBeNull();
    expect(cleanProposalFields({ targetId: "x", replacement: "r" })).toBeNull();
    expect(cleanProposalFields({ targetId: bid(1), replacement: "r" })).toMatchObject({ quote: "", summary: "", sources: [] });
    expect(cleanBlipIds(Array.from({ length: 100 }, (_, i) => bid(i)), LIMITS.sources)).toHaveLength(LIMITS.sources);
    expect(cleanBlipIds("nope", 5)).toEqual([]);
  });
  it("caps and cleans decision fields", () => {
    const d = cleanDecisionFields({ threadId: bid(1), text: "  We choose B  ", rationale: "x".repeat(5000), dissent: null, supersedes: bid(9) });
    expect(d).toMatchObject({ threadId: bid(1), text: "We choose B", dissent: "", nextSteps: "", supersedes: bid(9) });
    expect(d.rationale).toHaveLength(LIMITS.decisionFieldChars);
    expect(cleanDecisionFields({ threadId: bid(1), text: "   " })).toBeNull();
    expect(cleanDecisionFields({ threadId: "t", text: "x" })).toBeNull();
    expect(cleanDecisionFields({ threadId: bid(1), text: "x", supersedes: "bad" }).supersedes).toBeNull();
  });
});

describe("tree helpers", () => {
  const blips = {
    [bid(1)]: { id: bid(1), parentId: null, order: "a0" },
    [bid(2)]: { id: bid(2), parentId: bid(1), order: "a0" },
    [bid(3)]: { id: bid(3), parentId: bid(2), order: "a1" },
    [bid(4)]: { id: bid(4), parentId: bid(99), order: "a0" },
  };
  it("finds roots and depths, tolerating dangling parents", () => {
    expect(rootOf(bid(3), blips)).toBe(bid(1));
    expect(rootOf(bid(1), blips)).toBe(bid(1));
    expect(rootOf(bid(4), blips)).toBe(bid(4));
    expect(depthOf(bid(3), blips)).toBe(3);
    expect(depthOf(bid(4), blips)).toBe(1);
  });
  it("orders siblings by key then id", () => {
    const list = [{ id: bid(3), order: "a1" }, { id: bid(2), order: "a0" }, { id: bid(1), order: "a0" }].sort(compareBlips);
    expect(list.map((b) => b.id)).toEqual([bid(1), bid(2), bid(3)]);
  });
  it("survives a parent cycle", () => {
    const cyc = { [bid(1)]: { id: bid(1), parentId: bid(2) }, [bid(2)]: { id: bid(2), parentId: bid(1) } };
    expect(typeof rootOf(bid(1), cyc)).toBe("string");
    expect(depthOf(bid(1), cyc)).toBeGreaterThan(0);
  });
});

describe("previewOf", () => {
  it("collapses whitespace and caps at the preview length", () => {
    expect(previewOf("  # Hello\n\n  world  ")).toBe("# Hello world");
    expect(previewOf("x".repeat(500))).toHaveLength(LIMITS.preview);
    expect(previewOf(null)).toBe("");
    expect(previewOf("a\u0000b")).toBe("ab");
  });
});

describe("presence", () => {
  it("keeps previous fields, clears with null and canonicalises carets", () => {
    const first = cleanPresence({ name: "Ann", blipId: bid(1), editing: true, anchor: "AAEC+v8=", head: "AAEC+v8=" }, "c1", null);
    expect(first).toEqual({ clientId: "c1", name: "Ann", color: "#e1632e", blipId: bid(1), editing: true, anchor: "AAEC+v8=", head: "AAEC+v8=" });
    const next = cleanPresence({ head: null }, "c1", first);
    expect(next).toMatchObject({ name: "Ann", blipId: bid(1), editing: true, anchor: "AAEC+v8=", head: null });
    const moved = cleanPresence({ blipId: bid(2) }, "c1", next);
    expect(moved.blipId).toBe(bid(2));
    expect(moved.anchor).toBe("AAEC+v8=");
  });
  it("drops a malformed or over-long caret on its own, keeping the rest of the update", () => {
    const big = b64(new Array(LIMITS.caretBytes + 1).fill(7));
    const ok = b64(new Array(LIMITS.caretBytes).fill(7));
    const p = cleanPresence({ blipId: bid(1), editing: true, anchor: "not base64!", head: ok }, "c1", null);
    expect(p).toMatchObject({ blipId: bid(1), editing: true, anchor: null, head: ok });
    const q = cleanPresence({ anchor: big, head: 12 }, "c1", p);
    expect(q).toMatchObject({ anchor: null, head: null, editing: true, blipId: bid(1) });
    expect(cleanPresence({ anchor: "" }, "c1", p).anchor).toBeNull();
  });
  it("clears editing and carets without a blipId, and coerces editing to a boolean", () => {
    const p = cleanPresence({ blipId: bid(1), editing: "yes", anchor: "AAEC" }, "c1", null);
    expect(p.editing).toBe(false);
    const q = cleanPresence({ blipId: bid(1), editing: true, anchor: "AAEC" }, "c1", null);
    const gone = cleanPresence({ blipId: null }, "c1", q);
    expect(gone).toMatchObject({ blipId: null, editing: false, anchor: null, head: null });
    expect(cleanPresence({ blipId: "bogus" }, "c1", q).blipId).toBeNull();
  });
  it("tolerates garbage", () => {
    for (const raw of [null, 5, "x", [], { blipId: {}, editing: [], anchor: {}, head: [] }]) {
      expect(() => cleanPresence(raw, "c", null)).not.toThrow();
      expect(cleanPresence(raw, "c", null)).toMatchObject({ clientId: "c", name: "Guest", blipId: null, editing: false, anchor: null, head: null });
    }
  });
});

describe("storedBytes", () => {
  it("counts two bytes per unit beyond Latin-1", () => {
    expect(storedBytes({ a: "abc" })).toBeGreaterThanOrEqual(JSON.stringify({ a: "abc" }).length);
    const wide = { a: "日本語テキスト".repeat(100) };
    expect(storedBytes(wide)).toBeGreaterThanOrEqual(wide.a.length * 2);
  });

  it("bounds the V8 serialisation of Uint8Arrays alone and inside records", () => {
    for (const n of [0, 1, 10, 1000, 65536, 200_000]) {
      const u = new Uint8Array(n);
      for (let i = 0; i < n; i++) u[i] = i & 255;
      expect(storedBytes(u)).toBeGreaterThanOrEqual(serialize(u).length);
      const rec = { blipId: bid(1), seq: 42, by: "Ann", at: 1_700_000_000_000, update: u };
      expect(storedBytes(rec)).toBeGreaterThanOrEqual(serialize(rec).length);
      expect(storedBytes([u, u])).toBeGreaterThanOrEqual(serialize([u, u]).length);
    }
    // A view onto a larger buffer counts only its own bytes.
    const view = new Uint8Array(new ArrayBuffer(1000), 10, 50);
    expect(storedBytes(view)).toBeLessThan(200);
    expect(storedBytes(view)).toBeGreaterThanOrEqual(serialize(view).length - 0);
  });

  it("is an upper bound of both the UTF-8 JSON and the V8 serialisation", () => {
    let seed = 11;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const leaves = [0, 1, -1, 0.5, 0.1429, 1e6, 2 ** 31, -999999.99, 1700000000000.5, 1.2345678901234567e-300,
      true, false, null, "", "a", "é", "日本", "\u{1F600}", 'q"\\n', "x".repeat(300), "é".repeat(200), "日".repeat(300)];
    const gen = (depth) => {
      const r = rand();
      if (depth > 3 || r < 0.5) return pick(leaves);
      if (r < 0.75) {
        const holey = new Array(Math.floor(rand() * (depth ? 8 : 400)));
        for (let i = 0; i < holey.length; i++) holey[i] = gen(depth + 1);
        return holey;
      }
      const o = {};
      for (let i = 0; i < rand() * 12; i++) o[pick(["k", "é", "日本", "points"]) + i] = gen(depth + 1);
      return o;
    };
    for (let i = 0; i < 1500; i++) {
      const v = gen(0);
      const bytes = storedBytes(v);
      expect(bytes).toBeGreaterThanOrEqual(serialize(v).length);
      expect(bytes).toBeGreaterThanOrEqual(new TextEncoder().encode(JSON.stringify(v)).length);
    }
  });
});

describe("order keys", () => {
  it("accepts ordinary keys up to orderKeyAccept chars with an integer head from B to y", () => {
    for (const k of ["a0", "a1", "Zz", "b0V", "a0" + "V".repeat(LIMITS.orderKeyAccept - 2), "y" + "z".repeat(25), "B" + "0".repeat(24) + "1"]) {
      expect(isOrderKey(k)).toBe(true);
      expect(isAcceptableOrderKey(k)).toBe(true);
    }
    for (const k of ["a0" + "V".repeat(LIMITS.orderKeyAccept - 1), "z".repeat(27), "z" + "0".repeat(26), "A1" + "0".repeat(25), "", "not valid", 5]) {
      expect(isAcceptableOrderKey(k)).toBe(false);
    }
  });
});
