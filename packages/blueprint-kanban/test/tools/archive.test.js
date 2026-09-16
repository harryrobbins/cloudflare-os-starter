import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { encodeContent, parseArchive, serializeArchive } from "../../scripts/archive.mjs";
import { contentHash, packArchive } from "../../scripts/pack-gadget.mjs";

const files = { "server.js": "export class Gadget {}", "client.js": "document.body.append('hi')", "README.md": "# Hi\n" };
const sidecar = {
  title: "Board", description: "d", author: { type: "user", name: "n", id: "i" },
  output: { id: "board", noun: "Board", plural: "Boards", icon: "kanban" }, revision: 3,
};

describe("gadget archives", () => {
  it("packs deterministically and round-trips", () => {
    const a = packArchive(files, sidecar);
    expect(Buffer.from(packArchive(files, sidecar)).equals(Buffer.from(a))).toBe(true);
    const { metadata, files: out } = parseArchive(a);
    expect(out).toEqual(files);
    expect(metadata).toMatchObject({ title: "Board", version: 3, bindings: {}, output: sidecar.output });
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
