// Emoji and other multi-code-point characters as board text: grapheme clusters, truncation at the
// text limits, line wrapping and widths, and integrity through normalisation, the backup format,
// the clipboard, the SVG export and the whiteboard rules. No schemaVersion change: emoji are
// ordinary text (legacy fixture below).
import { describe, expect, it } from "vitest";
import { graphemes, graphemeCount, truncateText } from "../../src/shared/graphemes.js";
import { LIMITS, SCHEMA_VERSION, cleanLine, cleanText, normalizeNewObject } from "../../src/shared/protocol.js";
import { textWidth, wrapText, textObjectHeight } from "../../src/shared/geometry.js";
import { buildBackup, buildClipboard, parseBackup, plainTextOf } from "../../src/shared/backup.js";
import { boardToSvg, escapeXml, FONT_FAMILY } from "../../src/shared/render.js";
import { InMemoryRepository } from "../../src/core/repository.js";
import { createWhiteboard, migrate } from "../../src/core/whiteboard.js";
import { exportData, importData } from "../../src/core/backup.js";
import { create, setup } from "../core/helpers.js";

// Written with escapes so an editor cannot normalise them away.
const FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}"; // man, woman, girl, boy (ZWJ)
const HEART_ON_FIRE = "❤️‍\u{1F525}"; // variation selector inside a ZWJ sequence
const FLAG_GB = "\u{1F1EC}\u{1F1E7}";
const FLAG_ENGLAND = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}"; // tag sequence
const THUMBS_DARK = "\u{1F44D}\u{1F3FF}"; // skin tone modifier
const HOLDING_HANDS = "\u{1F9D1}\u{1F3FD}‍\u{1F91D}‍\u{1F9D1}\u{1F3FB}"; // two tones
const KEYCAP = "#️⃣";
const SAMPLES = [FAMILY, HEART_ON_FIRE, FLAG_GB, FLAG_ENGLAND, THUMBS_DARK, HOLDING_HANDS, KEYCAP];

describe("grapheme clusters", () => {
  it("keeps every emoji sequence as one cluster", () => {
    for (const s of SAMPLES) expect([...graphemes(s)], s).toEqual([s]);
    expect([...graphemes(`a${FAMILY}b ${FLAG_GB}${FLAG_GB}`)]).toEqual(["a", FAMILY, "b", " ", FLAG_GB, FLAG_GB]);
    expect([...graphemes("\u{1F1EC}\u{1F1E7}\u{1F1EB}")]).toEqual([FLAG_GB, "\u{1F1EB}"]); // odd indicator stands alone
    expect(graphemeCount(`é${KEYCAP}`)).toBe(2);
    expect([...graphemes("")]).toEqual([]);
  });

  it("truncates to the UTF-16 limit without splitting a cluster or a surrogate pair", () => {
    expect(truncateText(`ab${FAMILY}`, 2 + FAMILY.length)).toBe(`ab${FAMILY}`);
    expect(truncateText(`ab${FAMILY}`, 2 + FAMILY.length - 1)).toBe("ab");
    expect(truncateText(`a${FLAG_GB}`, 3)).toBe("a");
    expect(truncateText("a\u{1F600}", 2)).toBe("a");
    expect(truncateText(FAMILY, 3)).toBe("\u{1F468}‍"); // one cluster longer than the limit: code points only
    expect(truncateText("plain", 3)).toBe("pla");
    expect(truncateText("x", 0)).toBe("");
  });
});

describe("text normalisation keeps emoji intact", () => {
  it("keeps ZWJ, variation selectors, flags, tags and skin tones through cleanText and cleanLine", () => {
    for (const s of SAMPLES) {
      expect(cleanText(`  ${s}\n`, LIMITS.text)).toBe(`  ${s}\n`);
      expect(cleanLine(` ${s} `, LIMITS.frameName)).toBe(s);
    }
    // Bidi controls are still removed; joiners are not.
    expect(cleanLine(`‮${FAMILY}`, 80)).toBe(FAMILY);
  });

  it("counts limits in UTF-16 units and drops a sequence that would cross the limit", () => {
    const filler = "x".repeat(LIMITS.text - 5);
    const t = cleanText(filler + FAMILY, LIMITS.text); // FAMILY is 11 units: it does not fit
    expect(t).toBe(filler);
    expect(cleanText(filler + FLAG_GB, LIMITS.text)).toBe(filler + FLAG_GB); // 4 units: fits
    expect(cleanLine("y".repeat(LIMITS.connectorLabel - 1) + THUMBS_DARK, LIMITS.connectorLabel)).toBe("y".repeat(LIMITS.connectorLabel - 1));
    const o = normalizeNewObject({ id: "o_00000000e001", type: "text", text: HOLDING_HANDS, style: { fontSize: 64, align: "center" } });
    expect(o?.text).toBe(HOLDING_HANDS);
  });
});

describe("layout of emoji", () => {
  it("measures one emoji sequence as one square glyph", () => {
    for (const s of SAMPLES.filter((x) => x !== KEYCAP)) expect(textWidth(s, 64), s).toBe(64);
    expect(textWidth(KEYCAP, 10)).toBeCloseTo(textWidth("#", 10));
    expect(textWidth("✅", 10)).toBe(10); // dingbat emoji are square too
  });

  it("never wraps inside an emoji sequence", () => {
    const long = FAMILY.repeat(6);
    const lines = wrapText(long, 64 * 2, 64);
    expect(lines.join("")).toBe(long);
    for (const line of lines) expect([...graphemes(line)].every((g) => g === FAMILY)).toBe(true);
    expect(lines).toHaveLength(3);
    expect(textObjectHeight(FAMILY, 80, 64)).toBe(80);
  });
});

describe("emoji through backup, clipboard and SVG export", () => {
  const style = { fill: "none", stroke: "none", strokeWidth: 0, textColor: "#1f2937", fontSize: 64, align: "center", arrowStart: "none", arrowEnd: "none" };
  const objects = Object.fromEntries(SAMPLES.map((s, i) => {
    const id = "o_00000000f00" + i;
    return [id, { id, type: "text", x: i * 100, y: 0, w: 80, h: 80, rot: 0, z: "a" + i, frameId: null, text: s, style, version: 1, createdAt: 0, updatedAt: 0, createdBy: "t" }];
  }));
  const snapshot = { schemaVersion: SCHEMA_VERSION, revision: 1, title: `Emoji ${FAMILY}`, background: "dots", lastModified: 0, objects };

  it("round-trips every sequence through a backup and the clipboard", () => {
    const doc = JSON.parse(JSON.stringify(buildBackup(snapshot, { now: 0 })));
    const parsed = parseBackup(JSON.stringify(doc));
    expect("error" in parsed).toBe(false);
    expect(/** @type {any} */ (parsed).entries.map((e) => e.object.text)).toEqual(SAMPLES);
    expect(/** @type {any} */ (parsed).title).toBe(`Emoji ${FAMILY}`);
    const clip = buildClipboard(Object.values(objects), objects);
    expect(clip.objects.map((o) => o.text)).toEqual(SAMPLES);
    expect(plainTextOf(Object.values(objects))).toBe(SAMPLES.join("\n"));
  });

  it("writes every sequence unescaped and intact into the SVG, with the emoji fonts", () => {
    const svg = boardToSvg(/** @type {any} */ (snapshot));
    for (const s of SAMPLES) expect(svg, s).toContain(`>${s}<`);
    expect(escapeXml(`<${FAMILY}&>`)).toBe(`&lt;${FAMILY}&amp;&gt;`);
    expect(FONT_FAMILY).toMatch(/Apple Color Emoji.*Segoe UI Emoji.*Noto Color Emoji/);
  });

  it("keeps them through the whiteboard rules, exportData/importData and exportSvg", async () => {
    const { board } = setup();
    const made = [];
    for (const s of SAMPLES) made.push((await create(board, { type: "text", text: s, w: 80, h: 80, style: { fontSize: 64, align: "center" } })).obj);
    expect(made.map((o) => o.text)).toEqual(SAMPLES);
    const other = setup();
    const r = await importData(other.board, { data: await exportData(board), by: "Importer" });
    expect(r.created).toBe(SAMPLES.length);
    const texts = Object.values((await other.board.getBoard()).objects).map((o) => o.text).toSorted();
    expect(texts).toEqual(SAMPLES.toSorted());
    const svg = await other.board.exportSvg({});
    for (const s of SAMPLES) expect(svg).toContain(s);
  });
});

describe("stored data compatibility", () => {
  it("keeps schemaVersion 1: a board stored before emoji support loads unchanged", async () => {
    expect(SCHEMA_VERSION).toBe(1);
    const repo = new InMemoryRepository();
    const meta = { schemaVersion: 1, revision: 4, title: "Legacy", background: "dots", lastModified: 9 };
    // Stored with the height the old width rules gave it (a family measured as several glyphs).
    const text = {
      id: "o_0000000000b1", type: "text", x: 0, y: 0, w: 240, h: 150, rot: 0, z: "a0", frameId: null, text: `Team ${FAMILY}`,
      style: { fill: "none", stroke: "none", strokeWidth: 0, textColor: "#1f2937", fontSize: 24, align: "left", arrowStart: "none", arrowEnd: "none" },
      version: 2, createdAt: 1, updatedAt: 2, createdBy: "Ann",
    };
    await repo.commit({ meta, putObjects: [text], history: [] });
    expect(migrate(meta)).toBe(meta);
    const board = createWhiteboard(repo);
    const snap = await board.getBoard();
    expect(snap.objects[text.id]).toEqual(text);
    expect((await repo.getMeta()).schemaVersion).toBe(1);
  });
});
