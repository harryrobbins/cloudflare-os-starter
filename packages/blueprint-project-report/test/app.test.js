// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReportApp } from "../src/client/app.js";
import { createReadOnlyProxy } from "../src/server/proxy.js";
import { ChangeFeed } from "../src/server/feed.js";
import { WRITES, fakeGadget, fakeSession, memoryKv } from "./fake.js";

let app;
afterEach(() => { app?.destroy(); app = null; });
const memoryPrefs = () => { let v = {}; return { load: () => v, save: (p) => { v = p; } }; };

async function mount(session, download = vi.fn()) {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const gadget = fakeGadget(session);
  app = createReportApp({ gadget, root, prefs: memoryPrefs(), download });
  await app.ready;
  return { root, gadget, download };
}
const text = (root) => root.textContent.replace(/\s+/g, " ");

describe("read-only report", () => {
  it("has no write path on the gadget server", () => {
    const proxy = createReadOnlyProxy(() => ({}), new ChangeFeed(memoryKv()), async () => ({}));
    for (const w of [...WRITES, "getWriteOutcome"]) expect(proxy).not.toHaveProperty(w);
  });

  it("renders tiles, charts and recent issues without ever calling a write method", async () => {
    const session = fakeSession();
    const { root, gadget, download } = await mount(session);
    expect([...root.querySelectorAll(".tile .value")].map((e) => e.textContent)).toEqual(["6", "4", "2", "1"]);
    expect(root.querySelectorAll("ul.bars")).toHaveLength(3);
    expect(root.querySelector('section[aria-label="By state"] ul.bars').getAttribute("aria-label")).toBe("By state: To do 3, In progress 1, Done 2");
    expect(root.querySelectorAll(".recent tbody tr")).toHaveLength(6);

    // Exercise every interaction: filter, refresh, CSV, live updates.
    const project = root.querySelector('select[aria-label="Project"]');
    project.value = "prj-2";
    project.dispatchEvent(new Event("change"));
    expect(root.querySelector(".tile .value").textContent).toBe("2");
    root.querySelector('button[aria-label="Download CSV of the current view"]').click();
    expect(download).toHaveBeenCalledTimes(1);
    const [name, csv] = download.mock.calls[0];
    expect(name).toBe("OPS-issues.csv");
    expect(csv.trim().split("\r\n")).toHaveLength(3);
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Turn on live updates")?.click();
    root.querySelector('button[aria-label="Refresh from the datastore"]').click();
    await vi.waitFor(() => expect(session.reads.filter((r) => r === "listIssues").length).toBeGreaterThan(1));
    await gadget.exportCsv();

    for (const w of WRITES) expect(session[w]).not.toHaveBeenCalled();
    expect(gadget.$createViewerAssertion).not.toHaveBeenCalled();
  });

  it("explains forbidden access and a missing connection", async () => {
    const session = fakeSession({ readError: new Error("forbidden: not a member") });
    let { root } = await mount(session);
    expect(text(root)).toContain("You don't have access to this datastore");
    app.destroy();
    ({ root } = await mount(null));
    expect(text(root)).toContain("Connect a Projects datastore");
  });

  it("refuses a binding without read scopes", async () => {
    const { root } = await mount(fakeSession({ scopes: ["projects.read"] }));
    expect(text(root)).toContain("This connection cannot read issues");
  });

  it("falls back to the Export menu when the download is blocked", async () => {
    const { root } = await mount(fakeSession(), () => { throw new Error("blocked"); });
    root.querySelector('button[aria-label="Download CSV of the current view"]').click();
    expect(text(root)).toContain("Export → CSV (all issues)");
  });
});
