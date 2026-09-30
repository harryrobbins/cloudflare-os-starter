// @ts-check
// Helpers for educational games in the BBC Micro and RM Nimbus classroom tradition: maths
// questions by level, word lists, a typed-answer box, a two-word adventure parser, and the
// hidden-text puzzle behind "Developing Tray"-style cloze games.

/** Word lists for spelling, hangman, sorting and cloze games. All lower case. */
export const WORDS = {
  animals: ["cat", "dog", "horse", "sheep", "rabbit", "mouse", "tiger", "zebra", "otter", "badger", "hedgehog", "squirrel", "penguin", "dolphin", "giraffe", "elephant", "kangaroo", "owl", "fox", "frog"],
  colours: ["red", "orange", "yellow", "green", "blue", "purple", "pink", "brown", "black", "white", "grey", "silver", "gold"],
  fruit: ["apple", "banana", "cherry", "grape", "lemon", "mango", "orange", "peach", "pear", "plum", "melon", "kiwi", "lime", "strawberry"],
  numbers: ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "twenty", "hundred", "thousand"],
  shapes: ["circle", "square", "triangle", "rectangle", "pentagon", "hexagon", "octagon", "oval", "cube", "sphere", "cylinder", "cone", "pyramid"],
  planets: ["mercury", "venus", "earth", "mars", "jupiter", "saturn", "uranus", "neptune"],
  // Common exception words, roughly by school year (England).
  year1: ["the", "said", "was", "were", "is", "his", "has", "you", "your", "they", "be", "he", "me", "she", "we", "no", "go", "so", "by", "my", "here", "there", "where", "love", "come", "some", "one", "once", "ask", "friend", "school", "put", "push", "pull", "full", "house", "our"],
  year2: ["door", "floor", "poor", "because", "find", "kind", "mind", "behind", "child", "wild", "climb", "most", "only", "both", "old", "cold", "gold", "hold", "told", "every", "great", "break", "steak", "pretty", "beautiful", "after", "fast", "last", "past", "father", "class", "grass", "pass", "plant", "path", "bath", "hour", "move", "prove", "improve", "sure", "sugar", "eye", "could", "should", "would", "who", "whole", "any", "many", "clothes", "busy", "people", "water", "again", "half", "money", "parents", "christmas"],
  year4: ["accident", "actually", "address", "answer", "appear", "arrive", "believe", "bicycle", "breath", "breathe", "build", "busy", "calendar", "caught", "centre", "century", "certain", "circle", "complete", "consider", "continue", "decide", "describe", "different", "difficult", "disappear", "early", "earth", "eight", "enough", "exercise", "experience", "extreme", "famous", "favourite", "february", "forward", "fruit", "grammar", "group", "guard", "guide", "heard", "heart", "height", "history", "imagine", "important", "increase", "interest", "island", "knowledge", "learn", "length", "library", "material", "medicine", "mention", "minute", "natural", "naughty", "notice", "occasion", "often", "opposite", "ordinary", "particular", "peculiar", "perhaps", "popular", "position", "possess", "possible", "potatoes", "pressure", "probably", "promise", "purpose", "quarter", "question", "recent", "regular", "reign", "remember", "sentence", "separate", "special", "straight", "strange", "strength", "suppose", "surprise", "therefore", "though", "thought", "through", "various", "weight", "woman", "women"],
};

/** A short public-domain passage for cloze games (Aesop, "The Hare and the Tortoise"). */
export const PASSAGES = {
  hare: "A hare was making fun of a tortoise one day for being so slow. \"Do you ever get anywhere?\" he asked with a laugh. \"Yes,\" replied the tortoise, \"and I get there sooner than you think. I will run you a race and prove it.\" The hare was much amused at the idea of running a race with the tortoise, but for the fun of the thing he agreed. The hare was soon far out of sight, and to make the tortoise feel very deeply how silly he was, he lay down beside the course to take a nap. The tortoise meanwhile kept going slowly but steadily, and after a time passed the place where the hare was sleeping. When the hare awoke, he ran his fastest, but the tortoise had already crossed the line. Slow and steady wins the race.",
  wind: "The North Wind and the Sun had a quarrel about which of them was the stronger. While they were disputing with much heat and bluster, a traveller passed along the road wrapped in a cloak. \"Let us agree,\" said the Sun, \"that he is the stronger who can strip that traveller of his cloak.\" The North Wind blew with all his might, but the harder he blew the more closely did the traveller wrap his cloak around him. Then the Sun came out and shone warmly, and the traveller soon took off his cloak. Gentleness and kind persuasion win where force and bluster fail.",
};

/**
 * A maths question. kind: "add", "sub", "mul", "div", "bonds" (make `target`), "times" (one
 * `table`), "mixed". level 1-5 widens the numbers. Returns {text, answer, choices} where choices
 * holds the answer and three plausible wrong ones, shuffled.
 * @param {{kind?: string, level?: number, table?: number, target?: number}} opts @param {ReturnType<typeof import("./helpers.js").makeRng>} rng
 */
export function question(opts, rng) {
  const level = Math.max(1, Math.min(5, Math.round(opts.level ?? 1)));
  let kind = opts.kind ?? "add";
  if (kind === "mixed") kind = rng.pick(level < 3 ? ["add", "sub"] : ["add", "sub", "mul", "div"]);
  const top = [10, 20, 50, 100, 1000][level - 1];
  let text, answer;
  if (kind === "add") {
    const a = rng.rndi(0, top), b = rng.rndi(0, top - a);
    text = `${a} + ${b}`; answer = a + b;
  } else if (kind === "sub") {
    const a = rng.rndi(0, top), b = rng.rndi(0, a);
    text = `${a} - ${b}`; answer = a - b;
  } else if (kind === "mul" || kind === "times") {
    const t = kind === "times" ? Math.max(1, Math.min(12, opts.table ?? 2)) : rng.rndi(2, Math.min(12, 3 + level * 2));
    const b = rng.rndi(1, 12);
    text = `${b} x ${t}`; answer = b * t;
  } else if (kind === "div") {
    const t = rng.rndi(2, Math.min(12, 3 + level * 2)), b = rng.rndi(1, 12);
    text = `${b * t} ÷ ${t}`.replace("÷", "/"); answer = b;
  } else if (kind === "bonds") {
    const target = opts.target ?? [10, 20, 100, 100, 1000][level - 1];
    const a = rng.rndi(0, target);
    text = `${a} + ? = ${target}`; answer = target - a;
  } else throw new Error(`Unknown question kind "${kind}": use add, sub, mul, div, bonds, times or mixed`);
  const wrong = new Set();
  for (let tries = 0; wrong.size < 3 && tries < 100; tries++) {
    const off = rng.pick([-10, -2, -1, 1, 2, 10, rng.rndi(-5, 5)]);
    const w = answer + off;
    if (w !== answer && w >= 0) wrong.add(w);
  }
  return { text, answer, choices: rng.shuffle([answer, ...wrong]) };
}

/** Is n a multiple / factor / prime etc.? Rules for "munch the right numbers" games. */
export const rules = {
  /** @param {number} m */ multipleOf: (m) => ({ label: `Multiples of ${m}`, test: (/** @type {number} */ n) => n % m === 0 }),
  /** @param {number} m */ factorOf: (m) => ({ label: `Factors of ${m}`, test: (/** @type {number} */ n) => n > 0 && m % n === 0 }),
  prime: () => ({ label: "Prime numbers", test: (/** @type {number} */ n) => n > 1 && [...Array(Math.floor(Math.sqrt(n)) + 1).keys()].slice(2).every((d) => n % d !== 0) }),
  even: () => ({ label: "Even numbers", test: (/** @type {number} */ n) => n % 2 === 0 }),
  odd: () => ({ label: "Odd numbers", test: (/** @type {number} */ n) => n % 2 === 1 }),
  square: () => ({ label: "Square numbers", test: (/** @type {number} */ n) => Number.isInteger(Math.sqrt(n)) }),
  /** @param {number} lo @param {number} hi */ between: (lo, hi) => ({ label: `Between ${lo} and ${hi}`, test: (/** @type {number} */ n) => n > lo && n < hi }),
};

/**
 * A typed-answer box. Feed it a.typed() each frame; `done` becomes true on Return with a value.
 * @param {{max?: number, allow?: RegExp, upper?: boolean}} [opts]
 */
export function textbox(opts = {}) {
  const box = {
    value: "",
    done: false,
    /** @param {string[]} chars */
    update(chars) {
      box.done = false;
      for (const ch of chars) {
        if (ch === "\b") box.value = box.value.slice(0, -1);
        else if (ch === "\n") { if (box.value.trim()) box.done = true; }
        else if (box.value.length < (opts.max ?? 20) && (!opts.allow || opts.allow.test(ch))) box.value += opts.upper ? ch.toUpperCase() : ch;
      }
      return box.done;
    },
    clear() { box.value = ""; box.done = false; },
    /** Draws the value with a blinking cursor. @param {any} g @param {number} x @param {number} y @param {any} [c] @param {number} [frame] @param {number} [scale] */
    draw(g, x, y, c = 7, frame = 0, scale = 1) {
      const w = g.text(box.value, x, y, c, { scale });
      if (Math.floor(frame / 20) % 2 === 0) g.fill(x + w, y + 7 * scale, 7 * scale, scale, c);
    },
  };
  return box;
}

/**
 * Splits a typed command into a verb and a noun, as in "GET LAMP" or "go north". Abbreviations
 * (n, s, e, w, u, d, i, l, x) expand, "the"/"a"/"at" are dropped, and synonyms map to one verb.
 * @param {string} input
 */
export function parse(input) {
  const DIRS = /** @type {Record<string, string>} */ ({ n: "north", s: "south", e: "east", w: "west", u: "up", d: "down" });
  const SYN = /** @type {Record<string, string>} */ ({ take: "get", grab: "get", pick: "get", l: "look", examine: "look", x: "look", inspect: "look", i: "inventory", inv: "inventory", walk: "go", run: "go", move: "go", drop: "drop", put: "drop", talk: "say", speak: "say" });
  const words = String(input).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w && !["the", "a", "an", "at", "to"].includes(w));
  if (!words.length) return { verb: "", noun: "", words };
  const [first, ...rest] = words;
  if (DIRS[first] || Object.values(DIRS).includes(first)) return { verb: "go", noun: DIRS[first] ?? first, words };
  const verb = SYN[first] ?? first;
  // "pick up the lamp": the particle belongs to the verb.
  const tail = verb !== "go" && rest[0] === "up" ? rest.slice(1) : rest;
  const noun = tail.join(" ");
  return { verb, noun: verb === "go" ? DIRS[noun] ?? noun : noun, words };
}

/**
 * The hidden-text puzzle: every letter is a dot until guessed. guess(word) reveals every
 * occurrence of a whole word (ignoring case) and returns how many; letter(ch) reveals a letter.
 * @param {string} text
 */
export function cloze(text) {
  const tokens = String(text).match(/[A-Za-z']+|[^A-Za-z']+/g) ?? [];
  const words = tokens.map((t) => ({ text: t, word: /[A-Za-z]/.test(t), shown: !/[A-Za-z]/.test(t), letters: new Set() }));
  const c = {
    words,
    /** @param {string} w */
    guess(w) {
      const target = w.toLowerCase().trim();
      let n = 0;
      for (const t of words) if (t.word && !t.shown && t.text.toLowerCase() === target) { t.shown = true; n++; }
      return n;
    },
    /** @param {string} ch */
    letter(ch) {
      const l = ch.toLowerCase();
      let n = 0;
      for (const t of words) if (t.word && !t.shown) for (const x of t.text.toLowerCase()) if (x === l && !t.letters.has(l)) n++;
      for (const t of words) {
        if (!t.word) continue;
        t.letters.add(l);
        // A word whose every letter has been bought counts as found.
        if (!t.shown && [...t.text.toLowerCase()].every((x) => !/[a-z]/.test(x) || t.letters.has(x))) t.shown = true;
      }
      return n;
    },
    /** Reveals one random hidden word; returns it. @param {() => number} rnd */
    hint(rnd) {
      const hidden = words.filter((t) => t.word && !t.shown);
      if (!hidden.length) return "";
      const t = hidden[Math.floor(rnd() * hidden.length)];
      c.guess(t.text);
      return t.text;
    },
    get solved() { return words.every((t) => t.shown); },
    get progress() { const ws = words.filter((t) => t.word); return ws.filter((t) => t.shown).length / Math.max(1, ws.length); },
    /** The text as currently shown: hidden letters as `hidden` (default "."), guessed ones as themselves. @param {string} [hidden] */
    display(hidden = ".") {
      return words.map((t) => (t.shown ? t.text : [...t.text].map((ch) => (t.letters.has(ch.toLowerCase()) ? ch : hidden)).join(""))).join("");
    },
    /** Word-wraps display() to lines of `width` characters. @param {number} width @param {string} [hidden] */
    lines(width, hidden = ".") {
      const out = [];
      let line = "";
      for (const piece of c.display(hidden).split(/(\s+)/)) {
        if (/^\s+$/.test(piece)) { if (line) line += " "; continue; }
        if ((line + piece).length > width && line.trim()) { out.push(line.trimEnd()); line = ""; }
        line += piece;
      }
      if (line.trim()) out.push(line.trimEnd());
      return out;
    },
  };
  return c;
}
