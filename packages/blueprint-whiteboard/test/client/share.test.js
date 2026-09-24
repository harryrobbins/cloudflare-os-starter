// Sharing and discoverability, pure parts: the one shortcuts table behind both keys and help,
// clipboard payloads and paste reading/placement, deep links, presentation order, onboarding,
// backup naming and the template gallery.
import { describe, expect, it } from "vitest";
import { LIMITS, TYPE_DEFAULTS, isId } from "../../src/shared/protocol.js";
import { BACKUP_LIMITS, parseBackup, textToEntries } from "../../src/shared/backup.js";
import { COMMANDS, keyAction, helpGroups, formatKeys } from "../../src/client/ui/canvas/keymap.js";
import { helpRows } from "../../src/client/ui/help.js";
import { clipboardPayload, placeEntries, readPaste } from "../../src/client/ui/clipboard.js";
import { parseLink, linkFor, currentHash } from "../../src/client/ui/deep-link.js";
import { presentationFrames, stepIndex } from "../../src/client/ui/presentation.js";
import { shouldShowOnboarding } from "../../src/client/ui/onboarding.js";
import { describeCounts, backupFileName } from "../../src/client/ui/backup.js";
import { TEMPLATES } from "../../src/client/ui/templates.js";

let seq = 0;
function obj(type, fields = {}) {
  const d = TYPE_DEFAULTS[type];
  return {
    id: fields.id ?? "o_" + (++seq).toString(16).padStart(12, "0"), type, x: 0, y: 0, w: d.w, h: d.h, rot: 0, z: "a0",
    frameId: null, text: "", style: { ...d.style }, version: 1, createdAt: 0, updatedAt: 0, createdBy: "t", ...fields,
  };
}
const board = (...list) => Object.fromEntries(list.map((o) => [o.id, o]));

describe("one shortcuts table for keys and help", () => {
  it("every command the keys run is listed in the help, and every listed key exists", () => {
    const listed = new Set(helpGroups().flatMap((g) => g.commands.map((c) => c.id)));
    for (const c of COMMANDS) {
      if (!c.match) expect(c.label, c.id).toBeTruthy(); // help-only rows must say something
      if (c.label) expect(listed.has(c.id)).toBe(true);
    }
    // Key variants without a label belong to a listed parent (nudge, resize).
    const unlabeled = COMMANDS.filter((c) => !c.label).map((c) => c.id.split("-")[0]);
    for (const parent of new Set(unlabeled)) expect(listed.has(parent)).toBe(true);
    expect(new Set(COMMANDS.map((c) => c.id)).size).toBe(COMMANDS.length);
  });

  it("maps the shell's commands and keeps the browser's copy, cut and paste", () => {
    expect(keyAction({ key: "?", shiftKey: true })).toEqual({ type: "command", command: "help" });
    expect(keyAction({ key: "a" })).toEqual({ type: "command", command: "addMenu" });
    expect(keyAction({ key: "O", shiftKey: true })).toEqual({ type: "command", command: "outline" });
    expect(keyAction({ key: "P", shiftKey: true })).toEqual({ type: "command", command: "present" });
    expect(keyAction({ key: "p" })).toEqual({ type: "tool", tool: "pen" });
    for (const key of ["c", "x", "v"]) expect(keyAction({ key, ctrlKey: true })).toBeNull();
    expect(keyAction({ key: "ContextMenu", altKey: true })).toEqual({ type: "contextMenu" });
    expect(keyAction({ key: "z", ctrlKey: true, altKey: true })).toBeNull();
    expect(keyAction({ key: "A", shiftKey: true })).toBeNull();
  });

  it("has presentation keys only in the presentation scope", () => {
    expect(keyAction({ key: "ArrowRight" }, "presentation")).toEqual({ type: "present", step: "next" });
    expect(keyAction({ key: " " }, "presentation")).toEqual({ type: "present", step: "next" });
    expect(keyAction({ key: "PageUp" }, "presentation")).toEqual({ type: "present", step: "previous" });
    expect(keyAction({ key: "Escape" }, "presentation")).toEqual({ type: "present", step: "exit" });
    expect(keyAction({ key: "Home" }, "presentation")).toEqual({ type: "present", step: "first" });
    expect(keyAction({ key: "Delete" }, "presentation")).toBeNull();
    expect(keyAction({ key: "ArrowRight" })).toEqual({ type: "nudge", dx: 1, dy: 0 });
  });

  it("renders Mod as Ctrl or ⌘ in the help rows", () => {
    expect(formatKeys("Mod+Shift+Z", false)).toBe("Ctrl+Shift+Z");
    expect(formatKeys("Mod+Z", true)).toBe("⌘Z");
    const rows = helpRows(false);
    const edit = rows.find((g) => g.group === "Edit");
    expect(edit.rows.find((r) => r.label === "Paste objects, or one sticky note per line of text").keys).toEqual(["Ctrl+V"]);
    expect(rows.map((g) => g.group)).toEqual(["Tools", "Edit", "Select and arrange", "View", "Presenting", "Editing a route"]);
  });
});

describe("clipboard", () => {
  it("copies frames with their members and connectors only with both ends", () => {
    const f = obj("frame", { x: 0, y: 0, w: 500, h: 500 });
    const a = obj("sticky", { frameId: f.id, x: 10, y: 10, text: "A" });
    const b = obj("sticky", { x: 900, y: 0, text: "B" });
    const c1 = obj("connector", { from: a.id, to: b.id });
    const all = board(f, a, b, c1);
    const p = clipboardPayload(all, [f.id]);
    expect(p.doc.objects.map((o) => o.id)).toEqual([f.id, a.id]);
    expect(p.text).toBe("A");
    const both = clipboardPayload(all, [a.id, b.id]);
    expect(both.doc.objects.map((o) => o.type)).toEqual(["sticky", "sticky", "connector"]);
    expect(JSON.parse(both.json).format).toBe("cloudflare-os-whiteboard");
    expect(clipboardPayload(all, ["o_ffffffffffff"])).toBeNull();
  });

  it("reads our format first, then the in-memory copy, then plain text; never HTML", () => {
    const all = board(obj("sticky", { text: "hello" }));
    const p = clipboardPayload(all, Object.keys(all));
    expect(readPaste({ json: p.json, text: "ignored" }, null)).toMatchObject({ kind: "objects" });
    expect(readPaste({ text: "hello" }, { doc: p.doc, text: "hello" })).toMatchObject({ kind: "objects" });
    expect(readPaste({ text: p.json }, null)).toMatchObject({ kind: "objects" });
    const text = readPaste({ text: "one\ntwo" }, { doc: p.doc, text: "hello" });
    expect(text.kind).toBe("text");
    expect(text.entries.map((e) => e.object.text)).toEqual(["one", "two"]);
    expect(readPaste({ text: "<b>bold</b>" }, null).entries[0].object.text).toBe("<b>bold</b>"); // inert text
    expect(readPaste({ text: "" }, null)).toEqual({ kind: "none" });
    expect(readPaste({ json: "{bad" }, null).kind).toBe("error");
  });

  it("pastes centred on a point with fresh ids, joining the frame it lands in, within the board's room", () => {
    const frame = obj("frame", { x: 0, y: 0, w: 1000, h: 1000 });
    const src = board(obj("sticky", { x: 0, y: 0 }), obj("sticky", { x: 300, y: 0 }));
    const parsed = parseBackup(clipboardPayload(src, Object.keys(src)).doc);
    const { creates, ids } = placeEntries(parsed.entries, { objects: board(frame), at: { x: 500, y: 500 } });
    expect(ids.every((id) => isId(id))).toBe(true);
    expect(ids.some((id) => src[id])).toBe(false);
    expect(creates.map((c) => [c.x, c.y])).toEqual([[250, 400], [550, 400]]);
    expect(creates.every((c) => c.frameId === frame.id)).toBe(true);
    // Room: a nearly full board takes only what fits.
    const full = Object.fromEntries(Array.from({ length: LIMITS.objects - 1 }, (_, i) => [`k${i}`, obj("rect", { id: `o_${String(i).padStart(12, "0")}` })]));
    expect(placeEntries(parsed.entries, { objects: full, at: { x: 0, y: 0 } }).ids).toHaveLength(1);
    const many = textToEntries(Array.from({ length: 50 }, (_, i) => `n${i}`).join("\n")).entries;
    expect(placeEntries(many, { objects: {}, at: { x: 0, y: 0 }, max: 10 }).ids).toHaveLength(10);
    expect(BACKUP_LIMITS.pasteObjects).toBe(LIMITS.opsPerRequest);
  });
});

describe("deep links", () => {
  const id = "o_0123456789ab";
  it("parses frame and object links, ignoring anything else", () => {
    expect(parseLink(`#frame=${id}`)).toEqual({ kind: "frame", id, present: false });
    expect(parseLink(`frame=${id}&present=1`)).toEqual({ kind: "frame", id, present: true });
    expect(parseLink(`#object=${id}&present=1`)).toEqual({ kind: "object", id, present: false });
    for (const bad of ["", "#", "#frame=nope", "#object=o_XYZ", "#other=1", null, `#frame=${"x".repeat(300)}`]) {
      expect(parseLink(bad)).toBeNull();
    }
  });

  it("reads the frame's own hash, else the host page's from the base URL", () => {
    expect(currentHash({ hash: `#object=${id}`, baseURI: "https://host/g/1#frame=o_000000000000" })).toBe(`#object=${id}`);
    expect(currentHash({ hash: "", baseURI: `https://host/g/1#frame=${id}` })).toBe(`#frame=${id}`);
    expect(currentHash({ hash: "", baseURI: "about:srcdoc" })).toBe("");
  });

  it("builds links on the host page's URL without content", () => {
    expect(linkFor("frame", id, { baseURI: "https://host/g/1?x=1#old", href: "about:srcdoc" })).toBe(`https://host/g/1?x=1#frame=${id}`);
    expect(linkFor("object", id, { baseURI: "about:srcdoc", href: "about:srcdoc" })).toBe(`#object=${id}`);
  });
});

describe("presentation", () => {
  it("orders frames by z, then id, and ignores other objects", () => {
    const a = obj("frame", { id: "o_00000000000b", z: "a1", text: "B" });
    const b = obj("frame", { id: "o_00000000000a", z: "a1", text: "A" });
    const c = obj("frame", { id: "o_000000000001", z: "a0", text: "First" });
    expect(presentationFrames(board(a, b, c, obj("sticky"))).map((f) => f.text)).toEqual(["First", "A", "B"]);
  });

  it("steps within bounds", () => {
    expect(stepIndex(0, 3, "next")).toBe(1);
    expect(stepIndex(2, 3, "next")).toBe(2);
    expect(stepIndex(0, 3, "previous")).toBe(0);
    expect(stepIndex(1, 3, "last")).toBe(2);
    expect(stepIndex(2, 3, "first")).toBe(0);
    expect(stepIndex(0, 0, "next")).toBe(-1);
  });
});

describe("onboarding, backup naming and templates", () => {
  it("shows the start card only on a live, empty board", () => {
    const base = { objectCount: 0, live: true, dismissed: false, presenting: false };
    expect(shouldShowOnboarding(base)).toBe(true);
    expect(shouldShowOnboarding({ ...base, objectCount: 1 })).toBe(false);
    expect(shouldShowOnboarding({ ...base, tool: "pen" })).toBe(false);
    expect(shouldShowOnboarding({ ...base, tool: "hand" })).toBe(true);
    expect(shouldShowOnboarding({ ...base, live: false })).toBe(false);
    expect(shouldShowOnboarding({ ...base, dismissed: true })).toBe(false);
    expect(shouldShowOnboarding({ ...base, presenting: true })).toBe(false);
  });

  it("describes counts and names files safely", () => {
    expect(describeCounts({ sticky: 3, frame: 1, pen: 0 })).toBe("3 sticky notes, 1 frame");
    expect(describeCounts({})).toBe("no objects");
    expect(backupFileName("Q4 / <Plan>!", 0)).toBe("q4-plan-1970-01-01.whiteboard.json");
    expect(backupFileName("", 0)).toBe("whiteboard-1970-01-01.whiteboard.json");
  });

  it("ships four versioned templates that read cleanly within caps", () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual(["brainstorm", "retrospective", "journey", "architecture"]);
    for (const t of TEMPLATES) {
      expect(t.doc.version).toBe(1);
      const parsed = parseBackup(JSON.parse(JSON.stringify(t.doc)));
      expect(parsed.skipped, t.id).toBe(0);
      expect(parsed.entries.length).toBeLessThanOrEqual(BACKUP_LIMITS.pasteObjects);
      const { creates } = placeEntries(parsed.entries, { objects: {}, at: { x: 0, y: 0 } });
      expect(creates).toHaveLength(parsed.entries.length);
      // Every member of a template frame stays inside it.
      const frames = new Map(creates.filter((c) => c.type === "frame").map((c) => [c.id, c]));
      for (const c of creates) {
        if (!c.frameId) continue;
        const f = frames.get(c.frameId);
        expect(c.x >= f.x && c.y >= f.y && c.x + c.w <= f.x + f.w && c.y + c.h <= f.y + f.h, `${t.id} ${c.text}`).toBe(true);
      }
    }
    expect(TEMPLATES.find((t) => t.id === "architecture").doc.objects.filter((o) => o.type === "connector")).toHaveLength(6);
  });
});
