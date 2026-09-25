import { describe, expect, it, vi } from "vitest";
import { createRecordsProxy } from "../src/server/proxy.js";
import REQUIREMENT from "../src/service-requirement.json";
import { BLUEPRINT_BINDINGS } from "../src/shared/records.js";
import { parseArchive } from "../scripts/archive.mjs";
import { packArchive } from "../scripts/pack-gadget.mjs";

describe("service requirement and binding", () => {
  it("asks for work v1 with read and write, and no unimplemented features", () => {
    expect(REQUIREMENT).toEqual({ service: "records", moduleId: "work", apiMajor: 1, features: [], scopes: ["work.read", "work.write"] });
    expect(BLUEPRINT_BINDINGS.RECORDS).toMatchObject({ type: "gatekeeper", gatekeeperName: "recordservice", typeUrlPattern: "records-service://datastore/*" });
  });

  it("packs an archive declaring the binding", () => {
    const bytes = packArchive({ "server.js": "s", "client.js": "c", "README.md": "r", "service-requirement.json": "{}" },
      { title: "Work Board", description: "d", author: { type: "user", name: "T", id: "t" }, output: { id: "work-board", noun: "Work board", plural: "Work boards", icon: "kanban" }, revision: 1 });
    const archive = parseArchive(bytes);
    expect(archive.metadata.bindings).toEqual(BLUEPRINT_BINDINGS);
    expect(archive.files["client.js"]).toBe("c");
  });
});

describe("gadget server proxy", () => {
  it("passes command arguments through by identity", async () => {
    const session = { command: vi.fn(async () => ({ status: "pending", actionId: 1 })) };
    const proxy = createRecordsProxy(() => ({ RECORDS: session }));
    const input = { title: "t", extra: undefined };
    const options = { viewerAssertion: "a", idempotencyKey: "k" };
    await proxy.command("work.create", input, options);
    expect(session.command.mock.calls[0][1]).toBe(input);
    expect(session.command.mock.calls[0][2]).toBe(options);
    expect(Object.keys(input)).toEqual(["title", "extra"]);
  });

  it("reports setup without throwing", async () => {
    expect(await createRecordsProxy(() => ({})).getSetup()).toMatchObject({ connected: false });
    const failing = { connection: async () => { throw new Error("forbidden: no"); }, describe: async () => ({}) };
    expect(await createRecordsProxy(() => ({ RECORDS: failing })).getSetup()).toMatchObject({ connected: true, error: "forbidden: no" });
    expect(() => createRecordsProxy(() => ({})).snapshot(1)).toThrow(/^not_connected/);
  });
});
