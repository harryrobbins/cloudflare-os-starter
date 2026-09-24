// Server tests in workerd: the Gadget Durable Object over real DO storage and RPC callbacks.
import { env, RpcTarget } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ExportHandler } from "../../src/server/index.js";

class Listener extends RpcTarget {
  views = [];
  update(view) { this.views.push(view); }
}

const fresh = () => env.GADGET.get(env.GADGET.idFromName(crypto.randomUUID()));
const alice = { id: "alice@x", name: "Alice" };
const bob = { id: "bob@x", name: "Bob" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("Gadget", () => {
  it("runs a vote over RPC and pushes private views", async () => {
    const g = fresh();
    const la = new Listener();
    const lb = new Listener();
    expect((await g.subscribe(la, { clientId: "a1", voterId: alice.id })).options).toEqual([]);
    await g.subscribe(lb, { clientId: "b1", voterId: bob.id });
    const one = (await g.addOption({ by: alice, title: "Hoarse", values: { description: "rough voice" } })).option.id;
    const two = (await g.addOption({ by: bob, title: "Lumen" })).option.id;
    expect(await g.addOption({ by: bob, title: "lumen" })).toMatchObject({ error: expect.stringMatching(/already/) });
    const field = (await g.addField({ by: bob, label: "Companies House check" })).field;
    await g.updateOption({ by: bob, optionId: one, values: { [field.id]: "No match" } });
    await g.setReady({ by: alice, ready: true, ranking: [one, two] });
    await g.setReady({ by: bob, ready: true, ranking: [two, one] });
    await sleep(50);
    const last = lb.views.at(-1);
    expect(last.phase).toBe("closed");
    expect(last.mine.ranking).toEqual([two, one]);
    expect(la.views.at(-1).mine.ranking).toEqual([one, two]);
    expect(last.results[0].rounds[0].counts).toEqual({ [one]: 1, [two]: 1 });
    expect(last.results[0].rounds[0].tieBreak).toBe("lot");

    const md = await g.getSummaryMarkdown();
    expect(md).toContain("Companies House check:** No match");
    expect(md).toContain("Winner:");

    const handler = new ExportHandler(/** @type {any} */ ({}), /** @type {any} */ ({}));
    expect((await handler.getExportFormats(g))[0].id).toBe("summary");
    const text = await new Response(await handler.export(g, "summary")).text();
    expect(text).toContain("# What should we call it?");
  });

  it("survives a restart with the same data", async () => {
    const id = env.GADGET.idFromName(crypto.randomUUID());
    const g = env.GADGET.get(id);
    await g.setQuestion({ by: alice, question: "Company name?" });
    await g.addOption({ by: alice, title: "One" });
    const again = env.GADGET.get(id);
    const v = await again.getView(bob.id);
    expect(v.question).toBe("Company name?");
    expect(v.options.map((o) => o.title)).toEqual(["One"]);
    expect(v.suggested).toHaveLength(1);
  });
});
