// src/evals.mjs: every `use` reference passes its own check against the real Gadget, the checks
// reject wrong boards, and every `adapt` edit applies exactly once to the client entry and still
// parses. The adapt checks need a browser: scripts/blueprint-evals/run.mjs whiteboard --reference.
import { readFileSync } from "node:fs";
import { transform } from "esbuild";
import { describe, expect, it } from "vitest";
import evals from "../../src/evals.mjs";
import { nodeGadget, runCode } from "./node-gadget.js";

const SOURCES = {
  // client.js ships as src/client/main.js verbatim apart from its import lines (scripts/build.mjs).
  "client.js": readFileSync(new URL("../../src/client/main.js", import.meta.url), "utf8"),
  "server.js": readFileSync(new URL("../../src/server/index.js", import.meta.url), "utf8"),
};

/** @param {any} gadget */
const context = (gadget) => ({
  gadget, files: {}, binding: "Whiteboard",
  client: () => { throw new Error("t.client() needs a browser: use scripts/blueprint-evals/run.mjs"); },
});

const byId = Object.fromEntries(evals.map((/** @type {any} */ e) => [e.id, e]));

describe("evals.mjs", () => {
  it("has use and adapt evals with unique ids, prompts, references and checks", () => {
    expect(new Set(evals.map((/** @type {any} */ e) => e.id)).size).toBe(evals.length);
    expect(evals.filter((/** @type {any} */ e) => e.kind === "use").length).toBeGreaterThanOrEqual(2);
    expect(evals.filter((/** @type {any} */ e) => e.kind === "adapt").length).toBeGreaterThanOrEqual(1);
    for (const e of evals) {
      expect(typeof e.prompt).toBe("string");
      expect(typeof e.check).toBe("function");
      expect(e.kind === "use" ? typeof e.reference?.code : Array.isArray(e.reference?.edits)).toBe(e.kind === "use" ? "string" : true);
    }
    expect(byId["weekday-stickies"].prompt).toBe("Add one post-it note in a different colour for each day of the week, in a row.");
  });

  for (const e of evals.filter((/** @type {any} */ e) => e.kind === "use")) {
    it(`${e.id}: the reference passes its check`, async () => {
      const gadget = nodeGadget();
      await runCode(e.reference.code, { Whiteboard: gadget });
      expect(await e.check(context(gadget))).toEqual([]);
    });
  }

  for (const e of evals.filter((/** @type {any} */ e) => e.kind === "adapt")) {
    it(`${e.id}: each reference edit applies once and the result parses`, async () => {
      for (const edit of e.reference.edits) {
        const source = /** @type {any} */ (SOURCES)[edit.file];
        expect(source, edit.file).toBeTypeOf("string");
        expect(source.split(edit.find).length - 1, `${edit.file}: find occurs once`).toBe(1);
        const edited = source.replace(edit.find, () => edit.replace);
        await expect(transform(edited, { loader: "js", format: "esm", target: "es2022" })).resolves.toBeTruthy();
      }
    });
  }

  it("weekday-stickies rejects a column, repeated colours, a missing day and extra notes", async () => {
    const check = byId["weekday-stickies"].check;
    const days = ["Mon", "TUES", "wednesday", "Thurs", "Fri", "Sat", "Sun"];
    const colors = ["yellow", "orange", "red", "pink", "purple", "blue", "green"];
    const board = async (/** @type {any} */ args) => {
      const gadget = nodeGadget();
      await gadget.addStickies({ ...args });
      return check(context(gadget));
    };
    expect(await board({ stickies: days.map((text, i) => ({ text, color: colors[i] })), columns: 7 })).toEqual([]);
    expect(await board({ stickies: days.map((text, i) => ({ text, color: colors[i] })), columns: 1 })).toContain("not one row: centres range over y 100..1540");
    expect((await board({ stickies: days, columns: 7 }))[0]).toMatch(/7 different colours, found 1/);
    expect(await board({ stickies: days.slice(0, 6), columns: 7 })).toContain("expected one note naming sunday, found 0");
    expect(await board({ stickies: [...days, "Notes"], columns: 8 })).toContain("expected 7 sticky notes, found 8");
    const reversed = [...days].reverse();
    expect(await board({ stickies: reversed.map((text, i) => ({ text, color: colors[i] })), columns: 7 })).toContain("tuesday is not to the right of monday");
  });

  it("tea-flow rejects a missing step and a missing or backwards arrow", async () => {
    const check = byId["tea-flow"].check;
    const gadget = nodeGadget();
    const { created } = await gadget.addStickies({ stickies: ["Boil water", "Tea bag into the mug", "Pour the boiling water", "Steep 3 minutes"], columns: 4 });
    const [boil, bag, pour, steep] = created.map((/** @type {any} */ o) => o.id);
    await gadget.connectObjects({ from: boil, to: bag });
    await gadget.connectObjects({ from: pour, to: bag });
    await gadget.connectObjects({ from: pour, to: steep, arrow: "none" });
    expect(await check(context(gadget))).toEqual(['no object for the "milk" step']);
    const { created: [milk] } = await gadget.addStickies({ stickies: ["Milk"] });
    await gadget.connectObjects({ from: steep, to: milk.id });
    expect(await check(context(gadget))).toEqual([
      'no arrow from the "tea bag" step to the "pour" step',
      'no arrow from the "pour" step to the "brew" step',
    ]);
  });
});
