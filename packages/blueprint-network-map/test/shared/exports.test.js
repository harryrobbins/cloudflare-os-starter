import { describe, it, expect } from "vitest";
import { buildBackup, parseBackup, toKumuJson, toElementsCsv, toConnectionsCsv, toGraphml, toGexf, csvEscape, BACKUP_VERSION } from "../../src/shared/exports.js";
import { parseKumuJson, parseKumuSheets, parseDelimited } from "../../src/shared/imports.js";
import { createNetworkMap } from "../../src/core/network-map.js";
import { InMemoryRepository } from "../../src/core/repository.js";
import { createChangesets } from "../../src/core/changesets.js";

const demo = () => createNetworkMap(new InMemoryRepository()).getMap();

/** A tiny hand-built map with awkward text. */
const tricky = () => ({
  meta: { title: 'Map <&"\'>' },
  objects: [
    { id: "t_000000000001", name: "Org & Co", appliesTo: "element" },
    { id: "f_000000000001", name: "Score", kind: "number", appliesTo: "element" },
    { id: "f_000000000002", name: "Topics", kind: "multichoice", appliesTo: "both", choices: ["a", "b"] },
    { id: "e_000000000001", label: 'A <b> & "q"', typeId: "t_000000000001", fields: { f_000000000001: -3, f_000000000002: ["a", "b"] } },
    { id: "e_000000000002", label: "=HYPERLINK(\"x\")", description: "-foo", tags: ["@t"] },
    { id: "c_000000000001", from: "e_000000000001", to: "e_000000000002", direction: "mutual", label: "x<y", polarity: "-", strength: -2 },
    { id: "c_000000000002", from: "e_000000000002", to: "e_000000000001", direction: "undirected" },
  ],
  positions: [{ layout: "shared", ids: ["e_000000000001"], x: [10.5], y: [-4], pin: "0", v: [1] }],
});

describe("csvEscape", () => {
  it("escapes formula prefixes but not plain numbers", () => {
    expect(csvEscape("-3")).toBe("-3");
    expect(csvEscape("+2")).toBe("+2");
    expect(csvEscape(-3)).toBe("-3");
    expect(csvEscape("-1.5e3")).toBe("-1.5e3");
    expect(csvEscape("-foo")).toBe("'-foo");
    expect(csvEscape("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvEscape("@cmd")).toBe("'@cmd");
    expect(csvEscape("+ 1")).toBe("'+ 1");
    expect(csvEscape("\tx")).toBe("'\tx");
    expect(csvEscape("\rx")).toBe("\"'\rx\"");
    expect(csvEscape("plain")).toBe("plain");
  });

  it("quotes commas, quotes and newlines", () => {
    expect(csvEscape('a,"b"')).toBe('"a,""b"""');
    expect(csvEscape("a\nb")).toBe('"a\nb"');
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(["x", "y"])).toBe("x|y");
  });
});

describe("CSV exports", () => {
  it("writes the Kumu layout with CRLF, ids and safe cells", () => {
    const map = tricky();
    const el = toElementsCsv(map);
    expect(el.split("\r\n")[0]).toBe("ID,Label,Type,Description,Tags,Score,Topics");
    expect(el).toContain('e_000000000001,"A <b> & ""q""",Org & Co,,,-3,a|b\r\n');
    expect(el).toContain(`e_000000000002,"'=HYPERLINK(""x"")",,'-foo,'@t,,\r\n`);
    const cn = toConnectionsCsv(map);
    expect(cn.split("\r\n")[0]).toBe("From,To,FromID,ToID,Type,Direction,Label,Polarity,Strength,Description,Tags,Topics");
    expect(cn).toContain(`"A <b> & ""q""","'=HYPERLINK(""x"")",e_000000000001,e_000000000002,,mutual,x<y,'-,-2,,,\r\n`);
  });

  it("round-trips through the sheets importer", async () => {
    const map = await demo();
    const plan = parseKumuSheets({ elements: toElementsCsv(map), connections: toConnectionsCsv(map), sourceName: "demo" });
    expect(plan.preview.problems).toEqual([]);
    expect(plan.preview.elements).toBe(16);
    expect(plan.preview.connections).toBe(22);
    const polarities = plan.items.filter((it) => it.kind === "connection").map((c) => c.polarity);
    expect(polarities.filter((p) => p === "-")).toHaveLength(map.objects.filter((o) => o.polarity === "-").length);
    expect(parseDelimited(toElementsCsv(map)).rows).toHaveLength(16);
  });
});

describe("XML exports", () => {
  it("escapes GraphML text and marks undirected edges", () => {
    const xml = toGraphml(tricky());
    expect(xml).toContain('<data key="label">A &lt;b&gt; &amp; &quot;q&quot;</data>');
    expect(xml).toContain("<desc>Map &lt;&amp;&quot;&apos;&gt;</desc>");
    expect(xml).toContain('<key id="f_000000000002" for="all" attr.name="Topics" attr.type="string"/>');
    expect(xml).toMatch(/<edge id="c_000000000001" [^>]*directed="false">/);
    expect(xml).toMatch(/<edge id="c_000000000002" [^>]*directed="false">/);
    expect(xml).toContain('<data key="x">10.5</data>');
    expect(xml).not.toMatch(/<b>/);
  });

  it("escapes GEXF text, writes positions and edge types", () => {
    const xml = toGexf(tricky());
    expect(xml).toContain('label="A &lt;b&gt; &amp; &quot;q&quot;"');
    expect(xml).toContain('<viz:position x="10.5" y="-4" z="0.0"/>');
    expect(xml).toMatch(/<edge id="c_000000000001" [^>]*type="mutual" label="x&lt;y" weight="-2">/);
    expect(xml).toMatch(/<edge id="c_000000000002" [^>]*type="undirected">/);
    expect(xml).toContain('<attvalue for="f_000000000002" value="a|b"/>');
    expect(xml).toContain('<attvalue for="type" value="Org &amp; Co"/>');
  });

  it("drops characters XML cannot hold", () => {
    const map = tricky();
    map.objects[3].label = "bad\u0001char";
    expect(toGraphml(map)).toContain(">badchar<");
  });
});

describe("backup", () => {
  it("round-trips losslessly", async () => {
    const map = await demo();
    const backup = buildBackup(map);
    expect(backup).toMatchObject({ format: "cloudflare-os-network-map", version: 1, title: map.meta.title });
    expect(typeof backup.exportedAt).toBe("string");
    const parsed = parseBackup(JSON.stringify(backup));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.backup.objects).toEqual(map.objects);
    expect(parsed.backup.positions).toEqual(map.positions);
  });

  it("refuses newer versions and other files", () => {
    const newer = parseBackup(JSON.stringify({ format: "cloudflare-os-network-map", version: BACKUP_VERSION + 1, objects: [] }));
    expect(newer).toEqual({ ok: false, problems: [expect.stringMatching(/newer version.*format version 2/)] });
    expect(parseBackup("{").ok).toBe(false);
    expect(parseBackup(JSON.stringify({ format: "other", version: 1, objects: [] })).ok).toBe(false);
    expect(parseBackup(JSON.stringify({ format: "cloudflare-os-network-map", version: 0, objects: [] })).ok).toBe(false);
  });
});

describe("Kumu JSON", () => {
  it("exports the Kumu project shape", async () => {
    const map = await demo();
    const kumu = toKumuJson(map);
    expect(kumu.elements).toHaveLength(16);
    expect(kumu.elements[0]).toEqual({
      _id: "e_000000000001",
      attributes: { label: "Local farms", "element type": "Actor", description: "Small and mid-size growers within 50 miles.", Sector: "Private", Influence: 4, "Active since": "2008-04-01" },
    });
    expect(kumu.connections[0]).toMatchObject({ _id: "c_000000000001", from: "e_000000000001", to: "e_000000000002", direction: "directed", attributes: { "connection type": "Supports", polarity: "+" } });
    expect(kumu.loops[0]).toMatchObject({ _id: "l_000000000001", attributes: { label: "Market growth" }, connections: ["c_000000000001", "c_000000000002", "c_000000000003"] });
  });

  it("round-trips export -> import -> apply, keeping labels, types, fields and endpoints", async () => {
    const original = await demo();
    const plan = parseKumuJson(JSON.stringify(toKumuJson(original)), { sourceName: "demo.json" });
    expect(plan.preview.skipped).toEqual(["skipped: 2 loops, 0 perspectives (not supported yet)"]);
    expect(plan.preview.autoCreated).toBe(0);

    const target = createNetworkMap(new InMemoryRepository(), { seedDemo: false });
    const cs = createChangesets(target);
    const m = await cs.createChangeset({ name: "demo.json", source: plan.source, format: plan.format, by: "T" });
    expect((await cs.addChangesetItems({ changesetId: m.id, items: plan.items })).errors).toEqual([]);
    const fin = await cs.finalizeChangeset({ changesetId: m.id });
    const done = await cs.acceptChangeset({ changesetId: m.id, digest: fin.digest, by: "T", senderId: "t" });
    expect(done.status).toBe("applied");
    const copy = await target.getMap();

    /** Labels, type names, field values by name and endpoint labels, independent of ids. @param {any} map */
    const shape = (map) => {
      const byId = new Map(map.objects.map((/** @type {any} */ o) => [o.id, o]));
      const fieldName = (/** @type {string} */ id) => byId.get(id).name;
      const named = (/** @type {any} */ f) => Object.fromEntries(Object.entries(f ?? {}).map(([k, v]) => [fieldName(k), v]));
      return {
        elements: map.objects.filter((/** @type {any} */ o) => o.id[0] === "e")
          .map((/** @type {any} */ e) => ({ label: e.label, type: byId.get(e.typeId)?.name, tags: e.tags ?? [], fields: named(e.fields) }))
          .sort((/** @type {any} */ a, /** @type {any} */ b) => a.label.localeCompare(b.label)),
        connections: map.objects.filter((/** @type {any} */ o) => o.id[0] === "c")
          .map((/** @type {any} */ c) => `${byId.get(c.from).label} -> ${byId.get(c.to).label} ${c.direction} ${byId.get(c.typeId)?.name} ${c.polarity ?? ""} ${c.label ?? ""}`).sort(),
      };
    };
    expect(shape(copy)).toEqual(shape(original));
  });
});
