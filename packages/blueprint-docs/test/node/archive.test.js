// The committed formats/docs-drawings.gadget must be what the current source builds to, with a
// revision recorded for that content: a code change without a repack (and revision bump) would
// never reach a deployment.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArchive } from "../../../blueprint-whiteboard/scripts/archive.mjs";
import { buildGadget } from "../../scripts/build.mjs";
import { contentHash, packArchive, paths, readDist } from "../../scripts/pack-gadget.mjs";

describe("formats/docs-drawings.gadget", () => {
  it("is current: run `pnpm --filter blueprint-docs pack:gadget` after changing the source", async () => {
    const out = await buildGadget(await mkdtemp(join(tmpdir(), "docs-drawings-")));
    const files = await readDist(out);
    const sidecar = JSON.parse(await readFile(paths.sidecar, "utf8"));
    const lock = JSON.parse(await readFile(paths.lock, "utf8"));
    expect(lock.contentHash).toBe(contentHash(files));
    expect(lock.revision).toBe(sidecar.revision);
    const committed = new Uint8Array(await readFile(paths.archive));
    expect(Buffer.from(committed).equals(Buffer.from(packArchive(files, sidecar)))).toBe(true);
    const { metadata } = parseArchive(committed);
    expect(metadata).toMatchObject({ title: "Docs with Drawings", bindings: {}, version: sidecar.revision });
  }, 60_000);
});
