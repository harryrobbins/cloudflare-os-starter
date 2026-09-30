// Teletext Tables: a BBC Micro Mode 7 times-tables quiz. Everything on screen is a teletext
// page: 40 x 25 cells with in-line control codes for colour, double height and mosaic graphics.

export const config = {
  title: "Teletext Tables",
  mode: "teletext", // 320 x 250, 40 x 25 cells of 8 x 10
  controls: "arcade",
  typing: true, // letters and digits are answers, so P does not pause
  help: ["Type a table (2-12) then Return", "or pick with the arrows and Return", "Type each answer, then Return", "12 questions, 10 seconds each"],
};

const QUESTIONS = 12;
const SECONDS = 10;
const CHOICES = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "Mixed"];

export default function game(a) {
  const tt = a.tt;
  const page = a.teletext();
  const box = a.edu.textbox({ allow: /[0-9]/, max: 3 });

  let mode = "title"; // title | quiz | feedback | end
  let pick = 0, table = 2, pickError = "";
  let q = null, qNumber = 0, timeLeft = 0, correct = 0, score = 0;
  let feedback = null, feedbackTimer = 0;
  let results = []; // {text, answer, given, ok}
  let submitted = false;

  // --- Flow ------------------------------------------------------------------------------------
  function begin(choice) {
    table = choice;
    qNumber = 0; correct = 0; score = 0; results = []; submitted = false;
    a.sfx("select");
    nextQuestion();
  }

  function nextQuestion() {
    if (qNumber >= QUESTIONS) { finish(); return; }
    qNumber++;
    q = table === "mixed" ? a.edu.question({ kind: "mul", level: 4 }) : a.edu.question({ kind: "times", table });
    box.clear();
    timeLeft = SECONDS * 60;
    mode = "quiz";
  }

  function answer(given) {
    const ok = given === q.answer;
    if (ok) { correct++; score += 10 + Math.ceil(timeLeft / 60); a.sfx("correct"); }
    else a.sfx("wrong");
    results.push({ text: q.text, answer: q.answer, given, ok });
    feedback = ok ? { ok, text: "CORRECT!" } : { ok, text: given === null ? `TIME UP! ${q.text} = ${q.answer}` : `NO - ${q.text} = ${q.answer}` };
    feedbackTimer = ok ? 45 : 100;
    mode = "feedback";
  }

  function finish() {
    mode = "end";
    if (!submitted) {
      submitted = true;
      a.score.submit(score, table === "mixed" ? "mixed tables" : `${table} times table`);
    }
    if (correct === QUESTIONS) a.music("Fanfare", { loop: false });
  }

  // --- Update ----------------------------------------------------------------------------------
  function update() {
    const typed = a.typed();
    if (mode === "title") {
      if (a.btnp("up", 8)) pick = (pick + CHOICES.length - 1) % CHOICES.length;
      if (a.btnp("down", 8)) pick = (pick + 1) % CHOICES.length;
      if (box.update(typed)) {
        const n = Number(box.value);
        box.clear();
        if (n >= 2 && n <= 12) begin(n);
        else { pickError = "Choose a table from 2 to 12"; a.sfx("wrong"); }
      } else if (typed.includes("\n") && !box.value) {
        begin(pick === CHOICES.length - 1 ? "mixed" : Number(CHOICES[pick]));
      }
      return;
    }
    if (mode === "quiz") {
      if (box.update(typed)) { answer(Number(box.value)); return; }
      if (--timeLeft <= 0) answer(null);
      else if (timeLeft % 60 === 0 && timeLeft <= 180) a.sfx("tick");
      return;
    }
    if (mode === "feedback") {
      if (--feedbackTimer <= 0) nextQuestion();
      return;
    }
    if (mode === "end" && typed.includes("\n")) { box.clear(); pickError = ""; mode = "title"; }
  }

  // --- Page layout ----------------------------------------------------------------------------
  function header() {
    // Row 0: a teletext service header. Row 1-2: double-height title on a blue band.
    page.print(0, 0, tt.WHITE + "P100" + tt.CYAN + "ARCADE TXT" + tt.YELLOW + "MATHS" + tt.WHITE + clock());
    page.print(1, 0, tt.BLUE + tt.NEW_BG + tt.DOUBLE + tt.YELLOW + "  TELETEXT TABLES");
  }

  // A time of day in the header, as every teletext page had.
  function clock() {
    const s = Math.floor(a.t);
    const two = (n) => String(n).padStart(2, "0");
    return ` ${two(Math.floor(s / 3600) % 24)}:${two(Math.floor(s / 60) % 60)}/${two(s % 60)}`;
  }

  // A row of mosaic "bricks" as decoration.
  function bricks(row, colour) {
    let s = tt[`GFX_${colour}`];
    for (let i = 0; i < 38; i++) s += i % 2 ? tt.block(1, 1, 0, 0, 1, 1) : tt.block(1, 1, 1, 1, 0, 0);
    page.print(row, 0, s);
  }

  function drawTitle() {
    page.print(4, 0, tt.CYAN + "Which times table shall we practise?");
    for (let i = 0; i < CHOICES.length; i++) {
      const col = i < 6 ? 4 : 22;
      const row = 6 + (i % 6) * 2;
      const on = i === pick;
      const label = CHOICES[i] === "Mixed" ? "Mixed tables" : `${CHOICES[i]} times`;
      page.print(row, col, (on ? tt.RED + tt.NEW_BG + tt.YELLOW : tt.WHITE) + label + " " + tt.BLACK_BG);
    }
    page.print(18, 0, tt.GREEN + "Type a number and press RETURN,");
    page.print(19, 0, tt.GREEN + "or use the arrows and RETURN.");
    page.print(20, 0, tt.RED + tt.FLASH + (pickError || "") + tt.STEADY);
    page.print(21, 0, tt.YELLOW + "Your choice:" + tt.WHITE + box.value + (Math.floor(a.frame / 20) % 2 ? "_" : " "));
    bricks(23, "MAGENTA");
    if (a.score.best) page.print(24, 0, tt.CYAN + "Best score: " + tt.WHITE + a.score.best);
  }

  function drawQuiz() {
    const title = table === "mixed" ? "Mixed tables" : `The ${table} times table`;
    page.print(4, 0, tt.CYAN + title + tt.WHITE + `  Question ${qNumber} of ${QUESTIONS}`);
    page.print(6, 0, tt.GFX_BLUE + tt.block(0, 0, 1, 1, 1, 1).repeat(38));
    page.print(8, 0, tt.DOUBLE + tt.YELLOW + `   What is ${q.text} ?`);
    page.print(11, 0, tt.WHITE + "   Answer:" + tt.GREEN + tt.DOUBLE + box.value + (mode === "quiz" && Math.floor(a.frame / 15) % 2 ? "_" : " "));

    // Countdown bar: full mosaic blocks, green then yellow then red.
    const frac = mode === "quiz" ? timeLeft / (SECONDS * 60) : 0;
    const len = Math.round(frac * 36);
    const colour = frac > 0.5 ? "GREEN" : frac > 0.25 ? "YELLOW" : "RED";
    page.print(14, 0, tt.WHITE + "Time");
    page.print(15, 0, tt[`GFX_${colour}`] + "\x7f".repeat(len));

    if (mode === "feedback") {
      page.print(17, 0, (feedback.ok ? tt.GREEN : tt.RED) + tt.NEW_BG + tt.DOUBLE + tt.WHITE + " " + feedback.text);
    }
    page.print(21, 0, tt.MAGENTA + "Score " + tt.WHITE + score + tt.MAGENTA + "  Right " + tt.WHITE + correct);
    bricks(23, "BLUE");
  }

  function drawEnd() {
    const perfect = correct === QUESTIONS;
    page.print(4, 0, tt.DOUBLE + (perfect ? tt.FLASH + tt.YELLOW + "  PERFECT ROUND!" : tt.CYAN + "  Round complete"));
    // Results in two columns of six.
    results.forEach((r, i) => {
      const col = i < 6 ? 1 : 21;
      const row = 7 + (i % 6) * 2;
      const text = `${r.text} = ${r.ok ? r.answer : r.given ?? "-"}`;
      page.print(row, col, (r.ok ? tt.GREEN : tt.RED) + text.padEnd(12) + (r.ok ? "" : tt.WHITE + r.answer));
    });
    page.print(19, 0, tt.YELLOW + `You got ${correct} out of ${QUESTIONS}.` + tt.WHITE + `Score ${score}`);
    page.print(21, 0, tt.GREEN + "Press RETURN to play again.");
    bricks(23, perfect ? "YELLOW" : "CYAN");
  }

  function draw(g) {
    page.cls();
    header();
    if (mode === "title") drawTitle();
    else if (mode === "end") drawEnd();
    else drawQuiz();
    g.cls(0);
    page.draw(g, a.t);
  }

  // debug() lets tests (and curious players, via the console) peek at the game's state.
  return { update, draw, debug: () => ({ mode, q, score, correct, qNumber }) };
}
