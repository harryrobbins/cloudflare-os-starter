import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { encodeContent, parseArchive, serializeArchive } from "../../scripts/archive.mjs";
import { SIDECAR_KEYS, contentHash, packArchive, validateBindings, validateSidecarKeys } from "../../scripts/pack-gadget.mjs";

// A stand-in for dist/ so the test does not depend on a build.
const files = { "server.js": "export class Gadget {}", "client.js": "document.body.append('hi')", "README.md": "# Hi\n" };
const sidecar = {
  title: "Wave", description: "d", author: { type: "user", name: "n", id: "i" },
  output: { id: "wave", noun: "Wave", plural: "Waves", icon: "notebook" }, revision: 3,
};
const modelBinding = {
  Model: { title: "Model for Ask agent", description: "Optional. Summarise, compare and catch up run on this model.", type: "aiModel" },
};

describe("gadget archives", () => {
  it("packs deterministically and round-trips", () => {
    const a = packArchive(files, sidecar);
    expect(Buffer.from(packArchive(files, sidecar)).equals(Buffer.from(a))).toBe(true);
    const { metadata, files: out } = parseArchive(a);
    expect(out).toEqual(files);
    expect(metadata).toMatchObject({ title: "Wave", version: 3, bindings: {}, output: sidecar.output });
  });

  it("round-trips the sidecar's bindings into the archive metadata", () => {
    const { metadata } = parseArchive(packArchive(files, { ...sidecar, bindings: modelBinding }));
    expect(metadata.bindings).toEqual(modelBinding);
    expect(Object.keys(metadata.bindings)).toEqual(["Model"]);
  });

  it("packs the committed sidecar with bindings.json, which declares Model with Qwen suggested so New prefills it", async () => {
    const committed = JSON.parse(await readFile(new URL("../../../../formats/wave.json", import.meta.url), "utf8"));
    const bindings = JSON.parse(await readFile(new URL("../../bindings.json", import.meta.url), "utf8"));
    expect(committed.blueprintId).toBe("format.wave");
    expect(committed.output).toEqual({ id: "wave", noun: "Wave", plural: "Waves", icon: "notebook" });
    expect(() => validateSidecarKeys(committed)).not.toThrow();
    expect(bindings).toEqual({
      Model: {
        title: "Model for Ask agent",
        description: "Summarise, compare and catch up run on this model.",
        type: "aiModel",
        suggestedModel: { provider: "openrouter", modelName: "qwen/qwen3.8-flash" },
      },
    });
    const { metadata } = parseArchive(packArchive(files, { ...committed, bindings }));
    expect(metadata.bindings).toEqual(bindings);
    expect(metadata.output).toEqual(committed.output);
  });

  it("allows exactly the sidecar keys the platform's format build accepts", async () => {
    // The deploy failed once on `bindings` in the sidecar: keep SIDECAR_KEYS in step with the
    // destructuring in upstream's parseSidecar.
    const script = await readFile(new URL("../../../../cloudflare-os/packages/workshop-backend/scripts/build-format-blueprints.mjs", import.meta.url), "utf8");
    const m = script.match(/let \{ ([^}]+), \.\.\.rest \} = parsed;/);
    expect(m).not.toBeNull();
    const upstream = /** @type {RegExpMatchArray} */ (m)[1].split(",").map((k) => k.trim());
    expect([...SIDECAR_KEYS].sort()).toEqual(upstream.sort());
    expect(() => validateSidecarKeys({ ...sidecar, bindings: {} })).toThrow(/unknown keys bindings/);
  });

  it("writes `bindings: {}` for a sidecar that declares none, explicitly or not", () => {
    expect(parseArchive(packArchive(files, { ...sidecar, bindings: {} })).metadata.bindings).toEqual({});
    expect(parseArchive(packArchive(files, sidecar)).metadata.bindings).toEqual({});
  });

  it("rejects bindings that do not match the platform's shape", () => {
    expect(validateBindings(undefined)).toEqual({});
    expect(() => validateBindings([])).toThrow(/object/);
    expect(() => validateBindings({ "bad name": { title: "t", description: "", type: "aiModel" } })).toThrow(/name/);
    expect(() => validateBindings({ M: { title: "", description: "", type: "aiModel" } })).toThrow(/title/);
    expect(() => validateBindings({ M: { title: "t", type: "aiModel" } })).toThrow(/description/);
    expect(() => validateBindings({ M: { title: "t", description: "", type: "model" } })).toThrow(/type/);
    expect(() => validateBindings({ M: { title: "t", description: "", type: "aiModel", required: false } })).toThrow(/unknown field/);
    expect(() => validateBindings({ M: { title: "t", description: "", type: "aiModel", optional: true } })).toThrow(/unknown field/);
    expect(() => validateBindings({ G: { title: "t", description: "", type: "gatekeeper", gatekeeperName: "x" } })).toThrow(/typeUrlPattern/);
    expect(() => validateBindings({ S: { title: "t", description: "", type: "agentSpawner", env: { M: { type: "binding", name: "Nope" } } } })).toThrow(/env\.M/);
    const full = {
      Model: { ...modelBinding.Model, suggestedModel: { provider: "openrouter", modelName: "x" } },
      Spawner: { title: "s", description: "", type: "agentSpawner", suggestedModel: null,
        env: { MODEL: { type: "binding", name: "Model" }, WAVE: { type: "gadget" } } },
    };
    expect(validateBindings(full)).toBe(full);
  });

  it("decodes upstream's own archive format", async () => {
    const bytes = await readFile(new URL("../../../../formats/workspace-sheets.gadget", import.meta.url));
    const { metadata, files: out } = parseArchive(new Uint8Array(bytes));
    expect(metadata.title).toBe("Workspace Sheets");
    expect(Object.keys(out).sort()).toEqual(["README.md", "client.js", "server.js"]);
  });

  it("rejects corrupt archives", () => {
    const good = serializeArchive({ title: "x" }, encodeContent(files));
    const bad = good.slice();
    bad[0] ^= 0xff;
    expect(() => parseArchive(bad)).toThrow(/magic/);
    expect(() => parseArchive(good.subarray(0, good.length - 1))).toThrow(/content/);
  });

  it("hashes content independent of key order", () => {
    const reversed = Object.fromEntries(Object.entries(files).reverse());
    expect(contentHash(reversed)).toBe(contentHash(files));
    expect(contentHash({ ...files, "README.md": "changed" })).not.toBe(contentHash(files));
  });
});
