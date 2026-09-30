// Dark Room: a hidden-text puzzle in the style of RM Nimbus classroom software. A passage is
// shown as dots, like a photograph waiting to be developed. Guess words to reveal them, buy
// letters, or ask for a hint, and bring the whole text out of the dark.

export const config = {
  title: "Dark Room",
  mode: "nimbus", // 320 x 250, 16 Nimbus colours
  controls: "arcade",
  typing: true, // every letter is a guess, so P does not pause
  help: ["Type a word and press Return to guess it", "Type one letter and Return to buy it (25 points)", "Type ? and Return for a hint (60 points)", "Arrows and Return choose a passage"],
};

// Nimbus colours
const BLACK = 0, BLUE = 1, RED = 2, GREEN = 4, CYAN = 5, BROWN = 6, GREY = 7, DARK_GREY = 8;
const LIGHT_BLUE = 9, LIGHT_RED = 10, LIGHT_GREEN = 12, LIGHT_CYAN = 13, YELLOW = 14, WHITE = 15;

const PASSAGES = [
  { key: "hare", title: "The Hare and the Tortoise" },
  { key: "wind", title: "The North Wind and the Sun" },
];
const START_SCORE = 1000;
const COST = { wrongWord: 10, letter: 25, hint: 60 };
const WIDTH = 38; // characters per line in the window

export default function game(a) {
  const box = a.edu.textbox({ allow: /[a-zA-Z'?]/, max: 20 });
  let mode = "title"; // title | play | solved
  let pick = 0;
  let passage, puzzle, score, guesses;
  let message = "", messageColour = BLACK, messageTimer = 0;
  let submitted = false;

  // --- Flow ------------------------------------------------------------------------------------
  function begin(index) {
    passage = PASSAGES[index] ?? a.pick(PASSAGES);
    puzzle = a.edu.cloze(a.edu.passages[passage.key]);
    score = START_SCORE; guesses = 0; submitted = false;
    box.clear();
    say("Type a word you think is hidden, then Return", BLUE);
    mode = "play";
    a.sfx("select");
  }

  function say(text, colour = BLACK, frames = 240) { message = text; messageColour = colour; messageTimer = frames; }

  // A word whose letters have all been bought counts as found.
  function settleWords() {
    for (const w of puzzle.words) {
      if (w.word && !w.shown && [...w.text.toLowerCase()].every((ch) => ch === "'" || w.letters.has(ch))) w.shown = true;
    }
  }

  function charge(n) { score = Math.max(0, score - n); }

  function submit(entry) {
    const v = entry.trim();
    guesses++;
    if (v === "?") {
      const word = puzzle.hint(() => a.rnd());
      charge(COST.hint);
      say(`Hint: "${word}" (-${COST.hint})`, BROWN);
      a.sfx("powerup");
    } else if (v.length === 1 && v !== "'" && !puzzle.guess(v)) {
      // One letter buys that letter, unless it is a hidden one-letter word such as "a" or "I".
      const n = puzzle.letter(v);
      charge(COST.letter);
      settleWords();
      if (n) { say(`${n} x "${v.toUpperCase()}" developed (-${COST.letter})`, BLUE); a.sfx("coin"); }
      else { say(`No hidden "${v.toUpperCase()}" left (-${COST.letter})`, RED); a.sfx("wrong"); }
    } else {
      const n = v.length === 1 ? 1 : puzzle.guess(v);
      if (n) { say(`"${v}" found ${n} time${n > 1 ? "s" : ""}!`, GREEN); a.sfx("correct"); }
      else { charge(COST.wrongWord); say(`"${v}" is not hidden (-${COST.wrongWord})`, RED); a.sfx("wrong"); }
    }
    if (puzzle.solved) {
      mode = "solved";
      if (!submitted) { submitted = true; a.score.submit(score, passage.title); }
      a.music("Fanfare", { loop: false });
    }
  }

  // --- Update ----------------------------------------------------------------------------------
  function update() {
    const typed = a.typed();
    if (messageTimer > 0) messageTimer--;
    if (mode === "title") {
      if (a.btnp("up", 8)) pick = (pick + 2) % 3;
      if (a.btnp("down", 8)) pick = (pick + 1) % 3;
      for (const ch of typed) if (ch >= "1" && ch <= "3") pick = Number(ch) - 1;
      if (typed.includes("\n")) begin(pick);
      return;
    }
    if (mode === "play") {
      if (box.update(typed)) { submit(box.value); box.clear(); }
      return;
    }
    if (mode === "solved" && typed.includes("\n")) mode = "title";
  }

  // --- Nimbus-style chrome ---------------------------------------------------------------------
  function titleBar(g, right) {
    g.fill(0, 0, 320, 12, BLUE);
    g.text("Dark Room", 4, 2, WHITE);
    if (right) g.text(right, 316, 2, YELLOW, { align: "right" });
  }

  function menuBar(g, items) {
    g.fill(0, 12, 320, 12, GREY);
    let x = 4;
    for (const [label, colour] of items) {
      g.fill(x, 14, 8, 8, colour);
      x += 11;
      x += g.text(label, x, 14, BLACK) + 10;
    }
  }

  function windowFrame(g, x, y, w, h, title) {
    g.fill(x + 3, y + 3, w, h, BLACK); // drop shadow
    g.fill(x, y, w, h, WHITE);
    g.rect(x, y, w, h, BLACK);
    if (title) {
      g.fill(x, y, w, 11, LIGHT_BLUE);
      g.rect(x, y, w, 11, BLACK);
      g.text(title, x + w / 2, y + 2, WHITE, { align: "center" });
    }
  }

  // The passage as lines of WIDTH characters, with every undeveloped letter as "#" so it can be
  // told apart from a real full stop.
  function passageLines() {
    const text = puzzle.words.map((w) => (w.shown || !w.word ? w.text : [...w.text].map((ch) => (w.letters.has(ch.toLowerCase()) ? ch : "#")).join(""))).join("");
    const out = [];
    let line = "";
    for (const word of text.split(/\s+/)) {
      if (line && (line + " " + word).length > WIDTH) { out.push(line); line = word; }
      else line = line ? line + " " + word : word;
    }
    if (line) out.push(line);
    return out;
  }

  // Developed letters in black; undeveloped ones as grey dots.
  function drawPassage(g, x, y) {
    passageLines().forEach((line, row) => {
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === " ") continue;
        if (ch === "#") g.fill(x + i * 8 + 2, y + row * 9 + 5, 3, 2, DARK_GREY);
        else g.text(ch, x + i * 8, y + row * 9, BLACK);
      }
    });
  }

  // --- Screens ---------------------------------------------------------------------------------
  function drawTitle(g) {
    g.cls(CYAN);
    titleBar(g, a.score.best ? `Best ${a.score.best}` : "");
    menuBar(g, [["Choose", GREEN], ["Return: start", YELLOW]]);
    windowFrame(g, 30, 40, 260, 180, "Choose a passage");
    g.text("DARK ROOM", 160, 58, BLUE, { align: "center", scale: 2 });
    g.text("Develop the hidden text", 160, 78, BROWN, { align: "center" });
    const options = [...PASSAGES.map((p) => p.title), "Surprise me"];
    options.forEach((t, i) => {
      const y = 98 + i * 16;
      if (i === pick) g.fill(40, y - 3, 240, 13, YELLOW);
      g.text(`${i + 1}  ${t}`, 48, y, i === pick ? BLUE : BLACK);
    });
    ["Type words to guess them.", "One letter buys that letter.", "? gives a hint. Fewer guesses,", "higher score."].forEach((l, i) => g.text(l, 48, 152 + i * 10, DARK_GREY));
    if (a.frame % 40 < 28) g.text("Arrows or 1-3, then Return", 160, 204, RED, { align: "center" });
  }

  function drawPlay(g) {
    g.cls(CYAN);
    titleBar(g, `Score ${score}`);
    menuBar(g, [["Word", GREEN], ["Letter", LIGHT_CYAN], ["? Hint", LIGHT_RED]]);
    windowFrame(g, 2, 26, 314, 186, "");
    drawPassage(g, 8, 30);

    // Input line
    g.fill(0, 214, 320, 11, GREY);
    g.text("Guess:", 4, 216, BLUE);
    box.draw(g, 56, 216, BLACK, a.frame);
    g.text(`Guesses ${guesses}`, 316, 216, BROWN, { align: "right" });

    // Progress bar
    const p = puzzle.progress;
    g.fill(4, 228, 312, 8, BLACK);
    g.fill(5, 229, Math.round(310 * p), 6, p < 0.5 ? LIGHT_RED : p < 0.9 ? YELLOW : LIGHT_GREEN);
    g.text(`${Math.round(p * 100)}%`, 160, 228, WHITE, { align: "center" });

    if (messageTimer > 0) g.text(message, 160, 240, messageColour, { align: "center" });
  }

  function drawSolved(g) {
    g.cls(CYAN);
    titleBar(g, `Score ${score}`);
    menuBar(g, [["Developed!", LIGHT_GREEN], ["Return: another", YELLOW]]);
    windowFrame(g, 2, 26, 314, 186, "");
    drawPassage(g, 8, 30);
    g.fill(0, 214, 320, 36, BLUE);
    g.text(`Developed in ${guesses} guesses. Score ${score}`, 160, 218, YELLOW, { align: "center" });
    if (a.frame % 40 < 28) g.text("Press Return for another passage", 160, 234, WHITE, { align: "center" });
  }

  function draw(g) {
    if (mode === "title") drawTitle(g);
    else if (mode === "play") drawPlay(g);
    else drawSolved(g);
  }

  // debug() lets tests (and curious players, via the console) peek at the game's state.
  return { update, draw, debug: () => ({ mode, score, puzzle, passage }) };
}
