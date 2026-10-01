// describeGadget(): well-formed, bounded, and every example is real: run against the real Gadget,
// its argument satisfies the operation's `input` schema and the call reports no errors.
import { describe, expect, it } from "vitest";
import { Gadget } from "../../src/server/index.js";
import { MAX_GADGET_DESCRIPTION_CHARS } from "../../../../cloudflare-os/packages/workshop-backend/src/gadget-files.ts";
import { nodeGadget, runCode, validate } from "./node-gadget.js";

const A = "o_1a2b3c4d5e6f";
const B = "o_6f5e4d3c2b1a";

/** A board the examples can refer to: two notes, a frame named Planning, attributed to Assistant. */
async function seeded() {
  const gadget = nodeGadget();
  const { errors } = await gadget.addObjects({
    by: "Assistant",
    objects: [
      { type: "frame", id: "o_00000000f4a3", text: "Planning", x: -100, y: -100, w: 1200, h: 800 },
      { type: "sticky", id: A, x: 0, y: 0, text: "Launch plan", frameId: "o_00000000f4a3" },
      { type: "sticky", id: B, x: 400, y: 0, text: "Launch review", frameId: "o_00000000f4a3" },
    ],
  });
  expect(errors).toEqual([]);
  return gadget;
}

/** Problems a call's result reports, across the result shapes the operations use. @param {any} r */
function reported(r) {
  if (r === undefined) return ["returned nothing"];
  if (r === null) return ["returned null"];
  if (typeof r !== "object") return [];
  return [
    ...(r.error ? [r.error] : []),
    ...(Array.isArray(r.errors) ? r.errors.map((/** @type {any} */ e) => e.message) : []),
    ...(Array.isArray(r.result?.errors) ? r.result.errors.map((/** @type {any} */ e) => e.message) : []),
  ];
}

describe("describeGadget()", () => {
  const d = nodeGadget().describeGadget();

  it("is well formed, bounded and serialisable", () => {
    expect(d).toMatchObject({ gadget: "whiteboard", contract: 1 });
    expect(typeof d.summary).toBe("string");
    expect(d.operations.length).toBeGreaterThanOrEqual(10);
    expect(d.operations.length).toBeLessThanOrEqual(22);
    expect(Object.keys(d.adapt).sort()).toEqual(["client", "readme", "server"]);
    const text = JSON.stringify(d, null, 2);
    expect(text.length).toBeLessThan(MAX_GADGET_DESCRIPTION_CHARS);
    // describeBinding pretty-prints it into every agent's context: keep well clear of the cap.
    expect(text.length).toBeLessThan(20_000);
    expect(JSON.parse(text)).toEqual(d);
  });

  it("describes real methods, each with a description, schema, example and result", () => {
    const names = d.operations.map((/** @type {any} */ o) => o.name);
    expect(new Set(names).size).toBe(names.length);
    for (const op of d.operations) {
      expect(typeof /** @type {any} */ (Gadget.prototype)[op.name], op.name).toBe("function");
      for (const k of ["description", "example", "returns"]) expect(typeof op[k], `${op.name}.${k}`).toBe("string");
      expect(typeof op.input, `${op.name}.input`).toBe("object");
      expect(op.example, op.name).toContain(`env.Whiteboard.${op.name}(`);
    }
    // Convenience first, the raw escape hatch last.
    expect(names.at(-1)).toBe("applyOperation");
  });

  it("names every public RPC method an agent would call, as an operation or in the summary", () => {
    const uiOnly = new Set(["constructor", "describeGadget", "subscribe", "updatePresence", "leavePresence"]);
    const methods = Object.getOwnPropertyNames(Gadget.prototype).filter((m) => !uiOnly.has(m));
    const names = new Set(d.operations.map((/** @type {any} */ o) => o.name));
    expect(methods.filter((m) => !names.has(m) && !d.summary.includes(m + "("))).toEqual([]);
  });

  for (const op of nodeGadget().describeGadget().operations) {
    it(`example for ${op.name} runs, fits its input schema and reports no errors`, async () => {
      const gadget = await seeded();
      /** @type {any[][]} */
      const calls = [];
      const env = {
        Whiteboard: new Proxy({}, {
          get: (_, m) => (/** @type {any[]} */ ...args) => {
            if (m === op.name) calls.push(args);
            return gadget[/** @type {string} */ (m)](...args);
          },
        }),
      };
      const result = await runCode(`return ${op.example}`, env);
      expect(calls.length, "the example calls its own operation").toBe(1);
      const [args] = calls;
      expect(args.length).toBeLessThanOrEqual(1);
      expect(validate(op.input, args[0])).toEqual([]);
      expect(reported(result)).toEqual([]);
      if (Array.isArray(result?.created)) expect(result.created.length).toBeGreaterThan(0);
    });
  }

  it("the bundled schema check rejects a wrong input", () => {
    const addStickies = d.operations.find((/** @type {any} */ o) => o.name === "addStickies");
    expect(validate(addStickies.input, { stickies: [{ color: "red" }] })).not.toEqual([]);
    expect(validate(addStickies.input, {})).toEqual(["input.stickies: required"]);
  });
});
