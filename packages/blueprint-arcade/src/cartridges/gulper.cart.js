// Number Gulper: a BBC Micro Mode 2 maths game. Steer the gulper round a grid of numbers and
// gulp the ones that fit the rule at the top. Wrong gulps cost a life, and so do the Troggles.

export const config = {
  title: "Number Gulper",
  mode: "bbc2", // 160 x 256, wide pixels, BBC colours (8-15 flash)
  controls: "both",
  help: ["Arrows, WASD or Z X move", "Space or J gulps a number", "Eat every number that fits the rule", "Avoid the Troggles", "P pauses"],
};

// BBC colours
const BLACK = 0, RED = 1, GREEN = 2, YELLOW = 3, BLUE = 4, MAGENTA = 5, CYAN = 6, WHITE = 7;
const FLASH_RED = 9; // flashes red / cyan

const COLS = 6, ROWS = 5;
const CELL_W = 26, CELL_H = 36;
const GRID_X = 2, GRID_Y = 44;

export default function game(a) {
  let mode = "title"; // title | play | dying | clear | over
  let level = 1, score = 0, lives = 3;
  let rule, cells, left;
  let gx = 0, gy = 0, gulpTimer = 0;
  let troggles = [];
  let message = [], messageTimer = 0, modeTimer = 0;
  let submitted = false;
  const sparks = a.particles();

  // --- Rules -----------------------------------------------------------------------------------
  // Each rule has an engine test and the words used to explain a wrong gulp.
  function makeRule(lv) {
    const choices = [];
    if (lv <= 2) choices.push(
      { r: a.edu.rules.even(), what: "even" },
      { r: a.edu.rules.odd(), what: "odd" },
      ...[2, 3, 5, 10].map((m) => ({ r: a.edu.rules.multipleOf(m), what: `a multiple of ${m}` })));
    else if (lv <= 4) choices.push(
      ...[3, 4, 6, 7].map((m) => ({ r: a.edu.rules.multipleOf(m), what: `a multiple of ${m}` })),
      ...[12, 18, 20, 24].map((m) => ({ r: a.edu.rules.factorOf(m), what: `a factor of ${m}` })));
    else choices.push(
      { r: a.edu.rules.prime(), what: "prime" },
      { r: a.edu.rules.square(), what: "a square number" },
      ...[6, 7, 8, 9].map((m) => ({ r: a.edu.rules.multipleOf(m), what: `a multiple of ${m}` })),
      ...[30, 36, 48].map((m) => ({ r: a.edu.rules.factorOf(m), what: `a factor of ${m}` })));
    return a.pick(choices);
  }

  // Fill the grid so roughly 40% of the numbers fit the rule.
  function newLevel() {
    rule = makeRule(level);
    const max = Math.min(99, 20 + level * 10);
    const fits = [], misses = [];
    for (let n = 1; n <= max; n++) (rule.r.test(n) ? fits : misses).push(n);
    cells = [];
    for (let i = 0; i < COLS * ROWS; i++) {
      const good = fits.length && (a.chance(0.4) || !misses.length);
      cells.push({ n: a.pick(good ? fits : misses), eaten: false });
    }
    if (!cells.some((c) => rule.r.test(c.n))) cells[a.rndi(0, cells.length - 1)].n = a.pick(fits);
    left = cells.filter((c) => rule.r.test(c.n)).length;
    gx = 0; gy = 0; troggles = [];
    say(["LEVEL " + level, ...wrap(rule.r.label.toUpperCase())], 90);
  }

  function startGame() {
    level = 1; score = 0; lives = 3; submitted = false;
    newLevel();
    mode = "play";
    a.music("Title theme", { loop: false });
  }

  // --- Messages (20 characters to a line in Mode 2) -------------------------------------------
  function wrap(text, width = 19) {
    const out = [];
    let line = "";
    for (const w of text.split(" ")) {
      if ((line + " " + w).trim().length > width) { out.push(line); line = w; } else line = (line + " " + w).trim();
    }
    if (line) out.push(line);
    return out;
  }
  function say(lines, frames = 120) { message = lines; messageTimer = frames; }

  // --- Gulping ---------------------------------------------------------------------------------
  function gulp() {
    const c = cells[gy * COLS + gx];
    if (c.eaten) return;
    c.eaten = true;
    gulpTimer = 12;
    if (rule.r.test(c.n)) {
      score += 10 * level;
      left--;
      a.sfx("correct");
      sparks.burst(cx(gx), cy(gy), { count: 12, colors: [YELLOW, GREEN, WHITE], speed: 1.5, life: 20 });
      if (left === 0) { mode = "clear"; modeTimer = 120; score += 50 * level; a.sfx("win"); say(["LEVEL CLEARED!", `BONUS ${50 * level}`], 120); }
    } else {
      a.sfx("wrong");
      say(wrap(`${c.n} IS NOT ${rule.what.toUpperCase()}`), 150);
      loseLife();
    }
  }

  function loseLife() {
    lives--;
    a.shake(15, 2);
    sparks.burst(cx(gx), cy(gy), { count: 20, colors: [RED, MAGENTA], speed: 2, life: 30 });
    mode = "dying"; modeTimer = 60;
  }

  // --- Troggles --------------------------------------------------------------------------------
  function spawnTroggle() {
    const side = a.rndi(0, 3);
    const t = side === 0 ? { x: -1, y: a.rndi(0, ROWS - 1), dx: 1, dy: 0 }
      : side === 1 ? { x: COLS, y: a.rndi(0, ROWS - 1), dx: -1, dy: 0 }
      : side === 2 ? { x: a.rndi(0, COLS - 1), y: -1, dx: 0, dy: 1 }
      : { x: a.rndi(0, COLS - 1), y: ROWS, dx: 0, dy: -1 };
    troggles.push({ ...t, wait: 0 });
  }

  function moveTroggles() {
    const speed = Math.max(20, 60 - level * 6); // frames per step
    for (const t of troggles) {
      if (++t.wait < speed) continue;
      t.wait = 0;
      // Sometimes turn towards the gulper.
      if (a.chance(0.3)) {
        if (a.chance(0.5) && t.x !== gx) { t.dx = Math.sign(gx - t.x); t.dy = 0; }
        else if (t.y !== gy) { t.dx = 0; t.dy = Math.sign(gy - t.y); }
      }
      t.x += t.dx; t.y += t.dy;
    }
    troggles = troggles.filter((t) => t.x >= -1 && t.x <= COLS && t.y >= -1 && t.y <= ROWS);
  }

  const cx = (x) => GRID_X + x * CELL_W + CELL_W / 2;
  const cy = (y) => GRID_Y + y * CELL_H + CELL_H / 2;

  // --- Update ----------------------------------------------------------------------------------
  function update() {
    sparks.update();
    if (messageTimer > 0) messageTimer--;
    if (gulpTimer > 0) gulpTimer--;

    if (mode === "title" || mode === "over") {
      if (mode === "over" && !submitted) { submitted = true; a.score.submit(score, `level ${level}`); }
      if (a.btnp("fire") || a.btnp("start")) startGame();
      return;
    }
    if (mode === "dying" || mode === "clear") {
      if (--modeTimer > 0) return;
      if (mode === "clear") { level++; newLevel(); mode = "play"; return; }
      if (lives <= 0) { mode = "over"; a.music("Game over", { loop: false }); return; }
      troggles = [];
      mode = "play";
      return;
    }

    // Playing
    if (a.btnp("left", 8) && gx > 0) { gx--; a.sfx("step"); }
    if (a.btnp("right", 8) && gx < COLS - 1) { gx++; a.sfx("step"); }
    if (a.btnp("up", 8) && gy > 0) { gy--; a.sfx("step"); }
    if (a.btnp("down", 8) && gy < ROWS - 1) { gy++; a.sfx("step"); }
    if (a.btnp("fire")) gulp();
    if (mode !== "play") return;

    if (troggles.length < Math.min(3, level) && a.chance(0.004 + level * 0.001)) spawnTroggle();
    moveTroggles();
    if (troggles.some((t) => t.x === gx && t.y === gy)) {
      a.sfx("explode");
      say(["EATEN BY A", "TROGGLE!"], 120);
      loseLife();
    }
  }

  // --- Draw ------------------------------------------------------------------------------------
  function drawTitle(g) {
    g.text("NUMBER", 80, 30, YELLOW, { align: "center", sy: 2 });
    g.text("GULPER", 80, 50, FLASH_RED, { align: "center", sy: 2 });
    g.sprite(a.frame % 30 < 15 ? a.sprites.gulper1 : a.sprites.gulper2, 64, 80, { color: YELLOW, scale: 2 });
    g.sprite(a.sprites.troggle, 84, 80, { color: MAGENTA, scale: 2 });
    const lines = ["GULP NUMBERS THAT", "FIT THE RULE.", "", "MOVE: ARROWS/WASD", "      OR Z X", "GULP: SPACE OR J", "PAUSE: P", "", "DODGE TROGGLES!"];
    lines.forEach((l, i) => g.text(l, 4, 110 + i * 10, i < 2 ? CYAN : WHITE));
    if (a.frame % 40 < 28) g.text("SPACE TO START", 80, 210, GREEN, { align: "center" });
    const best = a.score.best;
    if (best) g.text(`BEST ${best}`, 80, 230, YELLOW, { align: "center" });
  }

  function drawBoard(g) {
    // Rule banner
    g.fill(0, 0, 160, 20, BLUE);
    wrap(rule.r.label.toUpperCase()).slice(0, 2).forEach((l, i) => g.text(l, 80, 2 + i * 9, YELLOW, { align: "center" }));
    g.text(`SC ${score}`, 2, 26, WHITE);
    g.text(`L${level}`, 110, 26, CYAN);
    for (let i = 0; i < lives; i++) g.sprite(a.sprites.heart, 132 + i * 9, 26, { color: RED });

    // Grid
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      const c = cells[y * COLS + x];
      const px = GRID_X + x * CELL_W, py = GRID_Y + y * CELL_H;
      g.rect(px, py, CELL_W - 1, CELL_H - 1, BLUE);
      if (!c.eaten) g.text(String(c.n), px + CELL_W / 2, py + 22, WHITE, { align: "center" });
    }
    // Gulper
    const open = gulpTimer > 0 ? a.frame % 6 < 3 : a.frame % 30 < 15;
    if (mode !== "dying" || a.frame % 8 < 4) {
      g.sprite(open ? a.sprites.gulper1 : a.sprites.gulper2, GRID_X + gx * CELL_W + 5, GRID_Y + gy * CELL_H + 3, { color: YELLOW });
    }
    // Troggles
    for (const t of troggles) {
      if (t.x < 0 || t.x >= COLS || t.y < 0 || t.y >= ROWS) continue;
      g.sprite(a.sprites.troggle, GRID_X + t.x * CELL_W + 13, GRID_Y + t.y * CELL_H + 3, { color: a.frame % 20 < 10 ? MAGENTA : RED });
    }
    sparks.draw(g);
  }

  function drawMessage(g) {
    if (messageTimer <= 0 || !message.length) return;
    const h = message.length * 10 + 6;
    g.fill(0, 256 - h, 160, h, BLACK);
    message.forEach((l, i) => g.text(l, 80, 256 - h + i * 10 + 2, i === 0 ? YELLOW : WHITE, { align: "center" }));
  }

  function draw(g) {
    g.cls(BLACK);
    if (mode === "title") { drawTitle(g); return; }
    drawBoard(g);
    if (mode === "over") {
      g.fill(8, 90, 144, 90, BLACK);
      g.rect(8, 90, 144, 90, RED);
      g.text("GAME OVER", 80, 98, FLASH_RED, { align: "center", sy: 2 });
      g.text(`SCORE ${score}`, 80, 122, WHITE, { align: "center" });
      // The full score table is wider than Mode 2's 20 columns, so show the top three briefly.
      a.score.table().slice(0, 3).forEach((r, i) => g.text(`${String(r.name).slice(0, 10).toUpperCase()} ${r.score}`, 80, 136 + i * 10, i ? CYAN : YELLOW, { align: "center" }));
      if (a.frame % 40 < 28) g.text("SPACE: AGAIN", 80, 168, GREEN, { align: "center" });
      return;
    }
    drawMessage(g);
  }

  // debug() lets tests (and curious players, via the console) peek at the game's state.
  return { update, draw, debug: () => ({ mode, score, lives, level, gx, gy, cells, rule, troggles }) };
}
