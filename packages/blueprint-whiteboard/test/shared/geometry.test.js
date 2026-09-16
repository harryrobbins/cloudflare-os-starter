import { describe, expect, it } from "vitest";
import {
  anchor, boardBounds, connectorRoute, distanceToPolyline, elbowPoints, facingSide, fitCamera, normalizeStroke,
  MAX_TEXT_LINES, penWorldPoints, pointInObjectBox, rotatedBounds, strokePathD, textLayout, textObjectHeight, textWidth,
  wrapText,
} from "../../src/shared/geometry.js";

const close = (a, b) => expect(Math.abs(a - b)).toBeLessThan(1e-6);

describe("bounds and hit tests", () => {
  it("rotated bounds grow with rotation", () => {
    const b = rotatedBounds({ x: 0, y: 0, w: 100, h: 100, rot: 45 });
    close(b.w, 100 * Math.SQRT2);
    close(b.x, 50 - 50 * Math.SQRT2);
    expect(rotatedBounds({ x: 1, y: 2, w: 3, h: 4, rot: 0 })).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });
  it("hits inside rotated boxes and ellipses only", () => {
    const r = { type: "rect", x: 0, y: 0, w: 200, h: 20, rot: 90 };
    expect(pointInObjectBox(r, { x: 100, y: 90 })).toBe(true);
    expect(pointInObjectBox(r, { x: 190, y: 10 })).toBe(false);
    const e = { type: "ellipse", x: 0, y: 0, w: 100, h: 100 };
    expect(pointInObjectBox(e, { x: 50, y: 50 })).toBe(true);
    expect(pointInObjectBox(e, { x: 3, y: 3 })).toBe(false);
  });
  it("measures distance to polylines", () => {
    expect(distanceToPolyline({ x: 5, y: 5 }, [0, 0, 10, 0])).toBe(5);
    expect(distanceToPolyline({ x: 3, y: 4 }, [0, 0])).toBe(5);
  });
  it("computes board bounds including connectors and skips dangling ones", () => {
    const objects = {
      a: { id: "a", type: "rect", x: 0, y: 0, w: 10, h: 10, rot: 0 },
      b: { id: "b", type: "rect", x: 100, y: 100, w: 10, h: 10, rot: 0 },
      c: { id: "c", type: "connector", from: "a", to: "zzz" },
    };
    expect(boardBounds(objects)).toEqual({ x: 0, y: 0, w: 110, h: 110 });
    expect(boardBounds({})).toBeNull();
  });
});

describe("pen strokes", () => {
  it("normalises and restores world points", () => {
    const world = [10, 20, 110, 20, 60, 70];
    const n = normalizeStroke(world, 0);
    expect(n).toMatchObject({ x: 10, y: 20, w: 100, h: 50 });
    expect(penWorldPoints(n)).toEqual(world);
    const padded = normalizeStroke(world, 5);
    expect(padded).toMatchObject({ x: 5, y: 15, w: 110, h: 60 });
    expect(padded.points.every((v) => v >= 0 && v <= 1)).toBe(true);
  });
  it("gives degenerate strokes a 1x1 box", () => {
    expect(normalizeStroke([5, 5, 5, 5])).toMatchObject({ w: 1, h: 1 });
  });
  it("builds path data", () => {
    expect(strokePathD([])).toBe("");
    expect(strokePathD([1, 2])).toBe("M1 2l0 0");
    expect(strokePathD([0, 0, 10, 10])).toBe("M0 0L10 10");
    expect(strokePathD([0, 0, 10, 10, 20, 0])).toBe("M0 0Q10 10 15 5L20 0");
  });
});

describe("connectors", () => {
  const a = { x: 0, y: 0, w: 100, h: 100 };
  const b = { x: 300, y: 0, w: 100, h: 100 };
  it("picks facing sides automatically", () => {
    expect(facingSide(a, { x: 350, y: 50 })).toBe("right");
    expect(facingSide(b, { x: 50, y: 50 })).toBe("left");
    expect(facingSide(a, { x: 50, y: 400 })).toBe("bottom");
    expect(connectorRoute({}, a, b).points).toEqual([{ x: 100, y: 50 }, { x: 300, y: 50 }]);
  });
  it("respects fixed sides and rotation", () => {
    const top = anchor({ x: 0, y: 0, w: 100, h: 50, rot: 90 }, "top");
    close(top.point.x, 75);
    close(top.point.y, 25);
    close(top.normal.x, 1);
    expect(connectorRoute({ fromSide: "bottom", toSide: "bottom" }, a, b).fromSide).toBe("bottom");
  });
  it("routes elbows orthogonally", () => {
    const pts = elbowPoints({ point: { x: 100, y: 50 }, normal: { x: 1, y: 0 } }, { point: { x: 350, y: 200 }, normal: { x: 0, y: -1 } });
    for (let i = 1; i < pts.length; i++) expect(pts[i].x === pts[i - 1].x || pts[i].y === pts[i - 1].y).toBe(true);
    expect(pts[0]).toEqual({ x: 100, y: 50 });
    expect(pts[pts.length - 1]).toEqual({ x: 350, y: 200 });
  });
});

describe("text", () => {
  it("wraps words, keeps newlines and breaks long words", () => {
    const lines = wrapText("The quick brown fox jumps over the lazy dog", 120, 16);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.join(" ")).toBe("The quick brown fox jumps over the lazy dog");
    expect(wrapText("a\n\nb", 100, 16)).toEqual(["a", "", "b"]);
    expect(wrapText("x".repeat(40), 80, 16).length).toBeGreaterThan(1);
  });
  it("truncates with an ellipsis beyond maxLines", () => {
    const lines = wrapText("one two three four five six seven eight", 60, 16, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith("…")).toBe(true);
  });
  it("is deterministic and bounded by the box", () => {
    const o = { type: "sticky", x: 0, y: 0, w: 200, h: 100, text: "word ".repeat(100), style: { fontSize: 20, align: "center" } };
    const l = textLayout(o);
    expect(l.lines.length * l.lineHeight).toBeLessThanOrEqual(l.h + l.lineHeight);
    expect(textLayout(o)).toEqual(l);
    expect(l.anchor).toBe("middle");
  });
  it("wraps exactly like the straightforward quadratic algorithm it replaced", () => {
    // The previous implementation, kept as the reference: re-measures the whole line per token.
    const reference = (text, maxWidth, fontSize, maxLines = Infinity) => {
      const width = Math.max(fontSize, maxWidth);
      const lines = [];
      for (const para of String(text).split("\n")) {
        let line = "";
        for (const token of para.split(/(\s+)/)) {
          if (token === "") continue;
          if (/^\s+$/.test(token)) { if (line !== "") line += token; continue; }
          if (textWidth(line + token, fontSize) <= width) { line += token; continue; }
          if (line.trim() !== "") lines.push(line.trimEnd());
          line = "";
          if (textWidth(token, fontSize) <= width) { line = token; continue; }
          for (const ch of token) {
            if (line && textWidth(line + ch, fontSize) > width) { lines.push(line); line = ""; }
            line += ch;
          }
        }
        lines.push(line.trimEnd());
      }
      if (lines.length > maxLines) {
        const kept = lines.slice(0, Math.max(1, maxLines));
        kept[kept.length - 1] = kept[kept.length - 1].replace(/\s*\S?$/, "") + "…";
        return kept;
      }
      return lines;
    };
    let seed = 5;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pieces = ["a", "i", "m", "W", "Q", " ", "  ", "\n", "\t", "é", "日", "\u{1F600}", "\u00a0", "llll", "wide", "\ud83d"];
    for (let k = 0; k < 5000; k++) {
      let text = "";
      for (let n = Math.floor(rand() * 60); n > 0; n--) text += pieces[Math.floor(rand() * pieces.length)];
      const width = rand() * 300, fontSize = 8 + Math.floor(rand() * 40);
      const maxLines = rand() < 0.5 ? Infinity : Math.floor(rand() * 6);
      expect(wrapText(text, width, fontSize, maxLines)).toEqual(reference(text, width, fontSize, maxLines));
    }
  });

  it("lays out crafted text in linear time and caps the lines of text objects", () => {
    const text = "i ".repeat(2000);
    const style = { fontSize: 8, align: "left" };
    let t = performance.now();
    for (let i = 0; i < 100; i++) textLayout({ type: "text", x: 0, y: 0, w: 100_000, h: 40, text, style });
    expect(performance.now() - t).toBeLessThan(500); // was ~55 ms per layout
    t = performance.now();
    const lines = textLayout({ type: "text", x: 0, y: 0, w: 1, h: 40, text: "x".repeat(4000), style });
    expect(performance.now() - t).toBeLessThan(100);
    expect(lines.lines).toHaveLength(MAX_TEXT_LINES);
    expect(lines.lines.at(-1).endsWith("…")).toBe(true);
    const sticky = textLayout({ type: "sticky", x: 0, y: 0, w: 1, h: 200, text: "x".repeat(4000), style: { fontSize: 8, align: "center" } });
    expect(sticky.lines.length).toBeLessThanOrEqual(Math.ceil(200 / (8 * 1.25)));
  });

  it("sizes text objects to their content", () => {
    expect(textObjectHeight("a", 200, 20)).toBe(25);
    expect(textObjectHeight("a\nb\nc", 200, 20)).toBe(75);
  });
});

describe("camera", () => {
  it("fits a rect centred with padding", () => {
    const cam = fitCamera({ x: 0, y: 0, w: 1000, h: 500 }, 1080, 600, { padding: 40 });
    expect(cam.zoom).toBe(1);
    expect(cam.x).toBe(500 - 540);
    expect(fitCamera({ x: 0, y: 0, w: 1, h: 1 }, 800, 600).zoom).toBe(20);
  });
});
