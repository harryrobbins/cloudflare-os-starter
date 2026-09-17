// Pure-logic tests of the conversation UI (stream C1): the keymap, thread ordering and collapse
// maths, the since-marker walk, paragraph-anchor placement, and the Markdown node builder against
// a tiny fake document. No jsdom: DOM behaviour is covered by the harness e2e suite.
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../../src/shared/markdown.js";
import { keyAction, nextChanged, stepFocus } from "../../src/client/ui/keymap.js";
import {
  ancestorsToExpand, compareSiblings, editingLabel, flattenTree, h, orderedRoots, placeParaReplies,
  relativeTime, renderBlocks, renderMarkdown, rootOf, shortId, threadTree,
} from "../../src/client/ui/render.js";

const bid = (n) => "b_" + n.toString(16).padStart(12, "0");

/** @param {Partial<import("../../src/shared/protocol.js").Blip> & {id: string}} b */
function blip(b) {
  return {
    parentId: null, anchor: null, kind: "note", order: "a0", by: "Alice", createdAt: 1, updatedAt: 1, version: 1,
    seq: 1, textSeq: 0, textChars: 0, log: { count: 0, bytes: 0, sinceCompaction: 0, sinceCompactionBytes: 0 },
    deleted: false, locked: false, preview: "", ...b,
  };
}

/** A map of blips from a compact spec: [id, parentId, order, extra]. */
function wave(specs) {
  const blips = {};
  for (const [id, parentId, order = "a0", extra = {}] of specs) {
    blips[id] = blip({ id, parentId, order, anchor: parentId === null ? null : (extra.anchor ?? { type: "end" }), ...extra });
  }
  return blips;
}

const key = (k, mods = {}) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
const onCard = { onCard: true, inEditor: false };

describe("keymap", () => {
  it("maps the documented keys when a card is focused", () => {
    expect(keyAction(key("j"), onCard)).toBe("next");
    expect(keyAction(key("k"), onCard)).toBe("prev");
    expect(keyAction(key("J"), onCard)).toBe("next");
    expect(keyAction(key("n"), onCard)).toBe("nextChanged");
    expect(keyAction(key("N", { shiftKey: true }), onCard)).toBe("prevChanged");
    expect(keyAction(key("r"), onCard)).toBe("reply");
    expect(keyAction(key("e"), onCard)).toBe("edit");
    expect(keyAction(key("Enter"), onCard)).toBe("focusThread");
    expect(keyAction(key("Escape"), onCard)).toBe("back");
    expect(keyAction(key("Delete"), onCard)).toBe("delete");
    expect(keyAction(key("ArrowDown"), onCard)).toBe("next");
    expect(keyAction(key("ArrowUp"), onCard)).toBe("prev");
    expect(keyAction(key("Home"), onCard)).toBe("first");
    expect(keyAction(key("End"), onCard)).toBe("last");
    expect(keyAction(key("ContextMenu"), onCard)).toBe("menu");
    expect(keyAction(key("F10", { shiftKey: true }), onCard)).toBe("menu");
  });

  it("ignores letters with modifiers, unknown keys, and letters typed off a card", () => {
    expect(keyAction(key("j", { ctrlKey: true }), onCard)).toBeNull();
    expect(keyAction(key("j", { altKey: true }), onCard)).toBeNull();
    expect(keyAction(key("x"), onCard)).toBeNull();
    expect(keyAction(key("j"), { onCard: false, inEditor: false })).toBeNull();
    expect(keyAction(key("r", { shiftKey: true }), onCard)).toBeNull();
    expect(keyAction({ ...key("j"), isComposing: true }, onCard)).toBeNull();
    expect(keyAction(key("j"), { ...onCard, composing: true })).toBeNull();
  });

  it("keeps Escape as 'back' from a button inside the conversation", () => {
    expect(keyAction(key("Escape"), { onCard: false, inEditor: false })).toBe("back");
  });

  it("inside an editor only Ctrl+Enter, Escape and undo keys act", () => {
    const ed = { onCard: false, inEditor: true };
    expect(keyAction(key("Enter", { ctrlKey: true }), ed)).toBe("done");
    expect(keyAction(key("Enter", { metaKey: true }), ed)).toBe("done");
    expect(keyAction(key("Escape"), ed)).toBe("done");
    expect(keyAction(key("z", { ctrlKey: true }), ed)).toBe("undo");
    expect(keyAction(key("z", { ctrlKey: true, shiftKey: true }), ed)).toBe("redo");
    expect(keyAction(key("y", { ctrlKey: true }), ed)).toBe("redo");
    expect(keyAction(key("j"), ed)).toBeNull();
    expect(keyAction(key("Enter"), ed)).toBeNull();
    expect(keyAction(key("Delete"), ed)).toBeNull();
  });

  it("outside an editor Ctrl+Z is not an action (the capture handler swallows it)", () => {
    expect(keyAction(key("z", { ctrlKey: true }), onCard)).toBeNull();
    expect(keyAction(key("Enter", { ctrlKey: true }), onCard)).toBeNull();
  });

  it("disables write keys in History mode and on locked cards, and gives Esc to the shell in History", () => {
    const hist = { ...onCard, historyMode: true };
    expect(keyAction(key("r"), hist)).toBeNull();
    expect(keyAction(key("e"), hist)).toBeNull();
    expect(keyAction(key("Delete"), hist)).toBeNull();
    expect(keyAction(key("Escape"), hist)).toBeNull();
    expect(keyAction(key("j"), hist)).toBe("next");
    expect(keyAction(key("n"), hist)).toBe("nextChanged");
    const locked = { ...onCard, locked: true };
    expect(keyAction(key("e"), locked)).toBeNull();
    expect(keyAction(key("Delete"), locked)).toBeNull();
    expect(keyAction(key("r"), locked)).toBe("reply");
  });
});

describe("changed-set walking", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const changed = new Set(["b", "d"]);

  it("walks forwards and backwards from the focus without wrapping", () => {
    expect(nextChanged(ids, "a", 1, changed)).toBe("b");
    expect(nextChanged(ids, "b", 1, changed)).toBe("d");
    expect(nextChanged(ids, "d", 1, changed)).toBeNull();
    expect(nextChanged(ids, "e", -1, changed)).toBe("d");
    expect(nextChanged(ids, "d", -1, changed)).toBe("b");
    expect(nextChanged(ids, "b", -1, changed)).toBeNull();
  });

  it("starts from the ends when nothing (or something unknown) is focused", () => {
    expect(nextChanged(ids, null, 1, changed)).toBe("b");
    expect(nextChanged(ids, null, -1, changed)).toBe("d");
    expect(nextChanged(ids, "zz", 1, changed)).toBe("b");
    expect(nextChanged(ids, "zz", -1, changed)).toBe("d");
    expect(nextChanged([], null, 1, changed)).toBeNull();
  });

  it("accepts any object with has()", () => {
    expect(nextChanged(ids, "a", 1, { has: (id) => id === "e" })).toBe("e");
  });

  it("stepFocus clamps at the ends and starts at an end with no focus", () => {
    expect(stepFocus(ids, "a", 1)).toBe("b");
    expect(stepFocus(ids, "e", 1)).toBe("e");
    expect(stepFocus(ids, "a", -1)).toBe("a");
    expect(stepFocus(ids, null, 1)).toBe("a");
    expect(stepFocus(ids, null, -1)).toBe("e");
    expect(stepFocus(ids, "c", -99)).toBe("a");
    expect(stepFocus(ids, "c", 99)).toBe("e");
    expect(stepFocus([], null, 1)).toBeNull();
  });
});

describe("thread ordering and collapse", () => {
  const root1 = bid(1), root2 = bid(2), brief = bid(3);
  const r1 = bid(11), r2 = bid(12), r11 = bid(111), r111 = bid(1111), r112 = bid(1112), r21 = bid(121);
  const blips = wave([
    [root1, null, "a1"], [root2, null, "a2"], [brief, null, "a3", { kind: "brief" }],
    [r1, root1, "a0"], [r2, root1, "a1"],
    [r11, r1, "a0"], [r111, r11, "a0"], [r112, r11, "a1"],
    [r21, r2, "a0"],
  ]);
  const rootOrder = [root1, root2, brief];

  it("pins the brief first and keeps rootOrder otherwise", () => {
    expect(orderedRoots(blips, rootOrder, () => true)).toEqual([brief, root1, root2]);
  });

  it("appends roots missing from rootOrder sorted by order key, and skips deleted or unknown ids", () => {
    const extra = { ...blips, [bid(4)]: blip({ id: bid(4), order: "a0" }), [bid(5)]: blip({ id: bid(5), order: "Zz", deleted: true }) };
    expect(orderedRoots(extra, [root1, "b_nope", root2], (b) => !b.deleted)).toEqual([brief, root1, root2, bid(4)]);
  });

  it("shows roots and first-level replies and collapses deeper levels behind a count", () => {
    const tree = threadTree(blips, rootOrder);
    expect(tree.map((n) => n.id)).toEqual([brief, root1, root2]);
    const t1 = tree[1];
    expect(t1.depth).toBe(1);
    expect(t1.children.map((c) => c.id)).toEqual([r1, r2]);
    expect(t1.children[0].depth).toBe(2);
    expect(t1.children[0].children).toEqual([]);
    expect(t1.children[0].hidden).toBe(3);
    expect(t1.children[0].hiddenIds).toEqual([r11, r111, r112]);
    expect(t1.children[1].hidden).toBe(1);
    expect(flattenTree(tree)).toEqual([brief, root1, r1, r2, root2]);
  });

  it("expands a card's collapsed replies when asked, one level at a time", () => {
    const tree = threadTree(blips, rootOrder, { expanded: new Set([r1]) });
    const n1 = tree[1].children[0];
    expect(n1.hidden).toBe(0);
    expect(n1.children.map((c) => c.id)).toEqual([r11]);
    expect(n1.children[0].hidden).toBe(2);
    const all = threadTree(blips, rootOrder, { expandAll: true });
    expect(flattenTree(all)).toEqual([brief, root1, r1, r11, r111, r112, r2, r21, root2]);
    expect(all[1].children[0].children[0].children.map((c) => c.depth)).toEqual([4, 4]);
  });

  it("skips deleted blips and their subtrees, and honours the visible filter", () => {
    const b = { ...blips, [r1]: { ...blips[r1], deleted: true } };
    const tree = threadTree(b, rootOrder, { expandAll: true });
    expect(flattenTree(tree)).toEqual([brief, root1, r2, r21, root2]);
    const hist = threadTree(blips, rootOrder, { expandAll: true, visible: (x) => x.id !== r2 && x.id !== brief });
    expect(flattenTree(hist)).toEqual([root1, r1, r11, r111, r112, root2]);
  });

  it("orders siblings by order key, then time, then id", () => {
    const a = blip({ id: bid(1), order: "a0", createdAt: 5 });
    const b = blip({ id: bid(2), order: "a1", createdAt: 1 });
    const c = blip({ id: bid(3), order: "a0", createdAt: 1 });
    expect([b, a, c].sort(compareSiblings).map((x) => x.id)).toEqual([bid(3), bid(1), bid(2)]);
    expect(compareSiblings(blip({ id: bid(1) }), blip({ id: bid(1) }))).toBe(0);
  });

  it("survives a cycle in parent links", () => {
    const loop = wave([[bid(1), null], [bid(2), bid(1)], [bid(3), bid(2)]]);
    loop[bid(1)].parentId = bid(3);
    const tree = threadTree(loop, [], { expandAll: true });
    expect(tree).toEqual([]);
    expect(rootOf(loop, bid(2))).toBeTruthy();
  });

  it("finds the root and the ancestors that must expand for a deep blip to show", () => {
    expect(rootOf(blips, r112)).toBe(root1);
    expect(rootOf(blips, root2)).toBe(root2);
    expect(rootOf(blips, "b_missing")).toBeNull();
    expect(ancestorsToExpand(blips, r112)).toEqual([r11, r1]);
    expect(ancestorsToExpand(blips, r11)).toEqual([r1]);
    expect(ancestorsToExpand(blips, r1)).toEqual([]);
    expect(ancestorsToExpand(blips, root1)).toEqual([]);
  });
});

describe("paragraph-anchor placement", () => {
  const blocks = [{ start: 0, end: 10 }, { start: 12, end: 30 }, { start: 32, end: 40 }];

  it("puts a reply after the block whose start is the largest one at or before its index", () => {
    const p = placeParaReplies(blocks, [
      { id: "a", index: 0 }, { id: "b", index: 12 }, { id: "c", index: 20 }, { id: "d", index: 999 }, { id: "e", index: 5 },
    ]);
    expect(p.byBlock).toEqual([["a", "e"], ["b", "c"], ["d"]]);
    expect(p.trailing).toEqual([]);
    expect(p.orphaned).toEqual([]);
    expect(p.pending).toEqual([]);
  });

  it("separates unresolved (removed text), unknown (text not open) and no-block cases", () => {
    const p = placeParaReplies(blocks, [{ id: "gone", index: null }, { id: "later", index: undefined }]);
    expect(p.orphaned).toEqual(["gone"]);
    expect(p.pending).toEqual(["later"]);
    expect(p.byBlock).toEqual([[], [], []]);
    const none = placeParaReplies([], [{ id: "x", index: 3 }, { id: "y", index: null }]);
    expect(none).toEqual({ byBlock: [], trailing: ["x"], orphaned: ["y"], pending: [] });
  });

  it("agrees with parseMarkdown offsets", () => {
    const text = "first para\n\n- item one\n- item two\n\n```\ncode\n```";
    const parsed = parseMarkdown(text);
    const p = placeParaReplies(parsed, [{ id: "a", index: text.indexOf("item two") }, { id: "b", index: text.indexOf("code") }]);
    expect(p.byBlock).toEqual([[], ["a"], ["b"]]);
  });
});

describe("labels", () => {
  it("relativeTime", () => {
    const now = 10 * 86_400_000;
    expect(relativeTime(now, now)).toBe("just now");
    expect(relativeTime(now - 59_000, now)).toBe("just now");
    expect(relativeTime(now - 60_000, now)).toBe("1 minute ago");
    expect(relativeTime(now - 3 * 60_000, now)).toBe("3 minutes ago");
    expect(relativeTime(now - 3_600_000, now)).toBe("1 hour ago");
    expect(relativeTime(now - 5 * 3_600_000, now)).toBe("5 hours ago");
    expect(relativeTime(now - 86_400_000, now)).toBe("yesterday");
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe("3 days ago");
    expect(relativeTime(now + 5000, now)).toBe("just now");
    expect(relativeTime(0, now)).toBe("");
    expect(typeof relativeTime(now - 30 * 86_400_000, now)).toBe("string");
  });

  it("editingLabel and shortId", () => {
    expect(editingLabel([])).toBe("");
    expect(editingLabel(["Alice"])).toBe("Alice is editing");
    expect(editingLabel(["Alice", "Bob"])).toBe("Alice and Bob are editing");
    expect(editingLabel(["Alice", "Bob", "Cy"])).toBe("Alice, Bob and 1 other are editing");
    expect(editingLabel(["Alice", "Alice", ""])).toBe("Alice and Someone are editing");
    expect(shortId(bid(0x3f1e))).toBe("b_0000…");
    expect(shortId("b_1")).toBe("b_1");
  });
});

// ---------------------------------------------------------------------------------------------
// Markdown node builder against a fake document
// ---------------------------------------------------------------------------------------------

function fakeDocument() {
  const log = { attrs: [], tags: [] };
  const make = (tag) => ({
    nodeType: 1, tagName: tag, attrs: {}, children: [], listeners: {},
    setAttribute(k, v) { this.attrs[k] = String(v); log.attrs.push([tag, k, String(v)]); },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, f) { (this.listeners[t] ??= []).push(f); },
  });
  const document = {
    createElement(tag) { log.tags.push(tag); return make(tag); },
    createTextNode(t) { return { nodeType: 3, text: String(t) }; },
  };
  return { document, log };
}

const textOf = (n) => (n.nodeType === 3 ? n.text : n.children.map(textOf).join(""));
const find = (n, tag, out = []) => { if (n.nodeType === 1) { if (n.tagName === tag) out.push(n); n.children.forEach((c) => find(c, tag, out)); } return out; };

describe("renderMarkdown", () => {
  it("builds the block structure from the node tree", () => {
    const { document } = fakeDocument();
    const md = "# Title\n\nSome **bold** and *it* and `c`\nsecond line\n\n- one\n- two\n\n1. first\n\n> quoted\n\n---\n\n```js\nlet x = 1;\n```";
    const root = renderMarkdown(parseMarkdown(md), { document });
    expect(root.tagName).toBe("div");
    expect(root.attrs.class).toBe("md");
    expect(root.children.map((c) => c.tagName)).toEqual(["h3", "p", "ul", "ol", "blockquote", "hr", "pre"]);
    expect(textOf(root.children[0])).toBe("Title");
    const p = root.children[1];
    expect(p.children.map((c) => (c.nodeType === 3 ? "#" : c.tagName))).toEqual(["#", "strong", "#", "em", "#", "code", "br", "#"]);
    expect(textOf(p)).toBe("Some bold and it and csecond line");
    expect(root.children[2].children.map((li) => textOf(li))).toEqual(["one", "two"]);
    expect(root.children[2].children[0].tagName).toBe("li");
    expect(root.children[3].attrs.start).toBeUndefined();
    expect(textOf(root.children[4])).toBe("quoted");
    const pre = root.children[6];
    expect(pre.children[0].tagName).toBe("code");
    expect(textOf(pre)).toBe("let x = 1;");
  });

  it("numbers an ordered list from its first number", () => {
    const { document } = fakeDocument();
    const root = renderMarkdown(parseMarkdown("5) five\n6) six"), { document });
    expect(root.children[0].tagName).toBe("ol");
    expect(root.children[0].attrs.start).toBe("5");
  });

  it("renders http, https and mailto links with rel and target, everything else as text", () => {
    const { document, log } = fakeDocument();
    const md = "[ok](https://example.com/a?b=1) [mail](mailto:x@y.z) bare http://ex.com/p. [bad](javascript:alert(1)) [data](data:text/html,x)";
    const root = renderMarkdown(parseMarkdown(md), { document });
    const links = find(root, "a");
    expect(links.map((a) => a.attrs.href)).toEqual(["https://example.com/a?b=1", "mailto:x@y.z", "http://ex.com/p"]);
    for (const a of links) {
      expect(a.attrs.rel).toBe("noopener noreferrer");
      expect(a.attrs.target).toBe("_blank");
    }
    expect(textOf(root)).toContain("[bad](javascript:alert(1))");
    expect(textOf(root)).toContain("[data](data:text/html,x)");
    expect(log.attrs.some(([, , v]) => v.includes("javascript:") || v.includes("data:"))).toBe(false);
    expect(log.tags).not.toContain("script");
  });

  it("never puts user text into attributes and never creates script or style elements", () => {
    const { document, log } = fakeDocument();
    const evil = "<script>alert(1)</script> \" onmouseover=\"x\" **<b>bold</b>** `<img src=x onerror=y>` [t](https://e.com/\"><script>) ```\n</script><script>\n```";
    const root = renderMarkdown(parseMarkdown(evil), { document });
    expect(textOf(root)).toContain("<script>alert(1)</script>");
    expect(log.tags).not.toContain("script");
    expect(log.tags).not.toContain("style");
    expect(log.tags).not.toContain("img");
    for (const [, name, value] of log.attrs) {
      expect(["class", "href", "rel", "target", "start", "data-bid", "title", "type"]).toContain(name);
      if (name === "href") expect(value).toMatch(/^(https?:\/\/|mailto:)/);
      expect(value).not.toContain("<");
      expect(value).not.toContain("onmouseover");
    }
  });

  it("renders bliplinks as buttons that call onBlipLink, or as anchors without it", () => {
    const { document } = fakeDocument();
    const id = bid(0xabc);
    const calls = [];
    const root = renderMarkdown(parseMarkdown(`see ${id} and b_nothex`), { document, onBlipLink: (x) => calls.push(x) });
    const buttons = find(root, "button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].attrs.class).toBe("bliplink");
    expect(buttons[0].attrs.type).toBe("button");
    expect(buttons[0].attrs["data-bid"]).toBe(id);
    expect(textOf(buttons[0])).toBe(shortId(id));
    const prevented = [];
    buttons[0].listeners.click[0]({ preventDefault: () => prevented.push(1), stopPropagation: () => {} });
    expect(calls).toEqual([id]);
    expect(prevented).toEqual([1]);
    expect(textOf(root)).toContain("b_nothex");
    const exportRoot = renderMarkdown(parseMarkdown(`see ${id}`), { document });
    const anchors = find(exportRoot, "a");
    expect(anchors).toHaveLength(1);
    expect(anchors[0].attrs.href).toBe("#" + id);
    expect(find(exportRoot, "button")).toHaveLength(0);
  });

  it("renderBlocks gives one element per top-level block, and h() skips null attributes", () => {
    const { document } = fakeDocument();
    const els = renderBlocks(parseMarkdown("a\n\nb\n\n- c"), { document });
    expect(els.map((e) => e.tagName)).toEqual(["p", "p", "ul"]);
    const node = h(document, "span", { class: "x", hidden: false, title: null, "data-n": 1, dataset: { k: "v" } }, "t", null, ["u", 2]);
    expect(node.attrs).toEqual({ class: "x", "data-n": "1", "data-k": "v" });
    expect(textOf(node)).toBe("tu2");
    expect(renderMarkdown([], { document }).children).toEqual([]);
  });
});
