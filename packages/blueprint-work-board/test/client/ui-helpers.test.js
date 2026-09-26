import { describe, expect, it } from "vitest";
import { parseTokens } from "../../src/client/ui/tokens.js";
import { SHORTCUTS, isTyping, keyLabel, matchShortcut, shortcutFor } from "../../src/client/ui/keys.js";
import { fuzzyFilter, fuzzyScore } from "../../src/client/ui/fuzzy.js";
import { buildIndex } from "../../src/shared/model/index.js";
import { ADA, BOB, CYCLE, TODAY, id, records } from "../wql/fixture.js";

const index = buildIndex(records(), { keyPrefix: "WRK" });
const parse = (/** @type {string} */ t) => parseTokens(t, index, { me: ADA, today: TODAY });

describe("quick-create tokens", () => {
  it("plain title", () => expect(parse("Fix the login")).toEqual({ title: "Fix the login", fields: {}, tokens: [] }));
  it("existing label by key or name, and new free-text labels", () => {
    const r = parse("Fix #bug #User #newthing login");
    expect(r.title).toBe("Fix login");
    expect(r.fields.labels).toEqual(["bug", "User", "newthing"]);
    // "#User" matches neither key nor full name "User interface", so it becomes a free-text label.
    expect(parse("x #ui").fields.labels).toEqual(["ui"]);
    expect(parse("x #Bug #bug").fields.labels).toEqual(["bug"]);
  });
  it("@me, @name, unknown people stay in the title", () => {
    expect(parse("Task @me").fields.assignee).toBe(ADA);
    expect(parse("Task @bob").fields.assignee).toBe(BOB);
    expect(parse("Task @bob@example.com").fields.assignee).toBe(BOB);
    const r = parse("Email @nobody");
    expect(r.title).toBe("Email @nobody");
    expect(r.fields.assignee).toBeUndefined();
    expect(parseTokens("x @me", index, { me: null, today: TODAY }).title).toBe("x @me");
  });
  it.each([["!1", 1], ["!urgent", 1], ["!high", 2], ["!med", 3], ["!low", 4], ["!0", 0], ["!none", 0]])("%s → priority %i", (t, p) => {
    expect(parse(`x ${t}`).fields.priority).toBe(p);
  });
  it("!bogus stays in the title", () => {
    expect(parse("Wow !bogus").title).toBe("Wow !bogus");
    expect(parse("Wow !5").fields.priority).toBeUndefined();
  });
  it.each([["^current", CYCLE.cur], ["^now", CYCLE.cur], ["^next", CYCLE.next], ["^3", CYCLE.next], ["^cycle1", CYCLE.prev]])("%s", (t, c) => {
    expect(parse(`x ${t}`).fields.cycle).toBe(c);
  });
  it("unknown cycle stays in the title", () => expect(parse("x ^later").title).toBe("x ^later"));
  it("labels tokens for display", () => {
    const r = parse("x !1 @me");
    expect(r.tokens.map((t) => t.field)).toEqual(["priority", "assignee"]);
    expect(r.tokens[1].label).toBe("Assign to you");
  });
  it("v1 datastores leave everything in the title", () => {
    const v1 = buildIndex([{ id: id(1), entity: "work_item", revision: 1, data: { title: "x" } }]);
    expect(parseTokens("Fix #bug @me !1", v1, { me: ADA, today: TODAY })).toEqual({ title: "Fix #bug @me !1", fields: {}, tokens: [] });
  });
});

/** @param {string} key @param {Partial<KeyboardEvent> & { tag?: string, type?: string, editable?: boolean }} [o] */
function ev(key, o = {}) {
  const target = o.tag ? { tagName: o.tag, type: o.type ?? "text", isContentEditable: o.editable ?? false } : { tagName: "DIV", isContentEditable: o.editable ?? false };
  return /** @type {any} */ ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target, ...o });
}
const on = { singleKeys: true }, off = { singleKeys: false };

describe("shortcuts", () => {
  it.each([
    ["c", "create"], ["/", "filter"], ["?", "help"], ["j", "down"], ["k", "up"], ["ArrowDown", "down"], ["ArrowLeft", "left"],
    ["h", "left"], ["l", "labels"], ["x", "select"], ["s", "state"], ["a", "assign"], ["i", "assignMe"], ["p", "priority"],
    ["e", "estimate"], ["d", "due"], ["m", "move"], ["Enter", "open"], [" ", "peek"], ["Escape", "close"], ["Home", "first"],
    ["End", "last"], ["PageUp", "pageUp"], ["PageDown", "pageDown"], ["C", "create"], ["q", null], ["Tab", null],
  ])("%j → %s", (key, id_) => expect(matchShortcut(ev(key), on)).toBe(id_));

  it.each([["k", "palette"], ["b", "toggleLayout"], ["z", "undo"], ["a", "selectAll"], ["x", null]])("Mod+%s → %s", (key, id_) => {
    expect(matchShortcut(ev(key, { ctrlKey: true }), on)).toBe(id_);
    expect(matchShortcut(ev(key, { metaKey: true }), off)).toBe(id_);
  });

  it("never fires single keys while typing", () => {
    for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) for (const k of ["c", "j", " ", "Enter", "Escape", "ArrowDown"]) expect(matchShortcut(ev(k, { tag }), on)).toBeNull();
    expect(matchShortcut(ev("c", { editable: true }), on)).toBeNull();
    expect(matchShortcut(ev("c", { tag: "INPUT", type: "checkbox" }), on)).toBe("create");
  });
  it("Mod+K works while typing; other Mod shortcuts do not", () => {
    expect(matchShortcut(ev("k", { tag: "INPUT", ctrlKey: true }), on)).toBe("palette");
    expect(matchShortcut(ev("b", { tag: "INPUT", ctrlKey: true }), on)).toBeNull();
    expect(matchShortcut(ev("k", { ctrlKey: true, shiftKey: true }), on)).toBeNull();
  });
  it("single keys off: letters, / and ? stop; navigation keeps working", () => {
    for (const k of ["c", "j", "k", "x", "/", "?", "s", "l"]) expect(matchShortcut(ev(k), off)).toBeNull();
    expect(matchShortcut(ev("ArrowDown"), off)).toBe("down");
    expect(matchShortcut(ev("Enter"), off)).toBe("open");
    expect(matchShortcut(ev(" "), off)).toBe("peek");
    expect(matchShortcut(ev("Escape"), off)).toBe("close");
  });
  it("Shift+arrows is move mode; Alt disables everything", () => {
    for (const k of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) expect(matchShortcut(ev(k, { shiftKey: true }), off)).toBe("moveMode");
    expect(matchShortcut(ev("c", { altKey: true }), on)).toBeNull();
  });
  it("isTyping", () => {
    expect(isTyping(null)).toBe(false);
    expect(isTyping(/** @type {any} */ ({ tagName: "INPUT", type: "radio" }))).toBe(false);
    expect(isTyping(/** @type {any} */ ({ tagName: "INPUT", type: "search" }))).toBe(true);
  });
  it("keyLabel", () => {
    expect(keyLabel("Mod+k", true)).toBe("⌘K");
    expect(keyLabel("Mod+k", false)).toBe("Ctrl+K");
    expect(keyLabel("Shift+ArrowUp", false)).toBe("⇧+↑");
    expect(keyLabel(" ", false)).toBe("Space");
    expect(keyLabel("Escape", false)).toBe("Esc");
  });
  it("every shortcut has a unique id and a label", () => {
    expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(SHORTCUTS.length);
    expect(shortcutFor("create")?.keys).toEqual(["c"]);
    expect(shortcutFor("nope")).toBeNull();
  });
});

describe("fuzzy", () => {
  it("scores substrings above scattered matches and prefixes highest", () => {
    const direct = /** @type {number} */ (fuzzyScore("log", "Login page"));
    const inner = /** @type {number} */ (fuzzyScore("log", "Catalog page"));
    const scattered = /** @type {number} */ (fuzzyScore("lpg", "Login page"));
    expect(direct).toBeGreaterThan(inner);
    expect(inner).toBeGreaterThan(scattered);
    expect(fuzzyScore("xyz", "Login")).toBeNull();
    expect(fuzzyScore("", "x")).toBe(0);
    expect(fuzzyScore("LOGIN", "login")).not.toBeNull();
  });
  it("filters and orders; empty query keeps order with limit", () => {
    const items = ["Set state", "Assign", "Set priority", "Settings", "Estimate"];
    expect(fuzzyFilter("set", items, (x) => x).slice(0, 3).sort()).toEqual(["Set priority", "Set state", "Settings"]);
    expect(fuzzyFilter("set", items, (x) => x)).not.toContain("Assign");
    expect(fuzzyFilter("", items, (x) => x, 2)).toEqual(["Set state", "Assign"]);
    expect(fuzzyFilter("sp", items, (x) => x)).toContain("Set priority");
  });
});
