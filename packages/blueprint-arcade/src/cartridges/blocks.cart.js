// Blocks: falling blocks with wall kicks, hold, a ghost piece and the 7-bag randomiser.
// Adapt it: change GRAVITY for a different speed curve, or COLOURS for a new look.

export const config = {
  title: "Blocks",
  mode: "default", // 320 x 256
  palette: "arcade",
  controls: "arcade",
  help: ["Left / Right: move", "Down: soft drop", "Up: hard drop", "Space: rotate", "X or Shift: hold", "P: pause"],
};

export default function game(a) {
  const W = a.W;
  const CELL = 12;
  const COLS = 10, ROWS = 20;
  const WX = Math.floor((W - COLS * CELL) / 2), WY = 8; // the well's top-left corner on screen
  const LINE_SCORES = [0, 100, 300, 500, 800];
  const LOCK_DELAY = 30;
  // Frames per row fall, by level (1-based); level 15 and up drop every frame.
  const GRAVITY = [48, 43, 38, 33, 28, 23, 18, 13, 8, 6, 5, 5, 4, 4, 3, 3, 2, 2, 1];

  const well = a.well(COLS, ROWS);
  const bag = a.bag();
  const particles = a.particles();

  let scene = "title";
  let piece, held, canHold, score, lines, level, fallTimer, lockTimer, flash, overTimer;

  // --- Pieces ----------------------------------------------------------------------------

  function spawn(type) {
    piece = { type, x: type === "O" ? 4 : 3, y: -1, rot: 0 };
    fallTimer = 0;
    lockTimer = 0;
    if (!well.fits(piece)) gameOver();
  }

  function newGame() {
    well.reset();
    bag.reset();
    score = 0; lines = 0; level = 1;
    held = null; canHold = true; flash = null;
    spawn(bag.next());
    scene = "play";
    a.music("Korobeiniki");
  }

  function tryMove(dx, dy) {
    const q = { ...piece, x: piece.x + dx, y: piece.y + dy };
    if (!well.fits(q)) return false;
    piece = q;
    if (dx) lockTimer = 0; // moving sideways on the floor buys a little time
    return true;
  }

  function lockPiece() {
    const ok = well.place(piece);
    a.sfx("lock");
    const full = well.fullRows();
    if (full.length) {
      for (const y of full) particles.burst(WX + (COLS * CELL) / 2, WY + y * CELL + 6, { count: 20, colors: ["white", "yellow", "cyan"], speed: 3, life: 25, spread: Math.PI });
      flash = { rows: full, t: 10 };
      const n = well.clearLines();
      lines += n;
      score += LINE_SCORES[n] * level;
      a.sfx(n === 4 ? "powerup" : "line");
      if (n === 4) a.shake(12, 3);
      const newLevel = Math.floor(lines / 10) + 1;
      if (newLevel > level) { level = newLevel; a.sfx("win"); }
    }
    if (!ok) { gameOver(); return; }
    canHold = true;
    spawn(bag.next());
  }

  function hold() {
    if (!canHold) return;
    const t = piece.type;
    if (held) spawn(held); else spawn(bag.next());
    held = t;
    canHold = false;
    a.sfx("select");
  }

  function gameOver() {
    scene = "over";
    overTimer = 0;
    a.stopMusic();
    a.music("Game over", { loop: false });
    a.score.submit(score, `${lines} lines`);
  }

  // --- Update ----------------------------------------------------------------------------

  function updatePlay() {
    if (flash && --flash.t <= 0) flash = null;
    particles.update();
    // Delayed auto-shift: move once, then repeat after 10 frames every 3 frames.
    if (a.btnp("left", 3, 10)) tryMove(-1, 0);
    if (a.btnp("right", 3, 10)) tryMove(1, 0);
    if (a.btnp("fire")) {
      const r = well.rotate(piece, 1);
      if (r) { piece = r; lockTimer = 0; a.sfx("blip"); }
    }
    if (a.btnp("alt")) { hold(); if (scene !== "play") return; }
    if (a.btnp("up")) {
      const landed = well.dropPosition(piece);
      score += 2 * (landed.y - piece.y);
      piece = landed;
      lockPiece();
      return;
    }
    const soft = a.btn("down");
    const speed = soft ? 2 : GRAVITY[Math.min(level, GRAVITY.length) - 1];
    if (++fallTimer >= speed) {
      fallTimer = 0;
      if (tryMove(0, 1)) { if (soft) score += 1; }
    }
    // On the floor: lock after LOCK_DELAY frames.
    if (!well.fits({ ...piece, y: piece.y + 1 })) {
      if (++lockTimer >= LOCK_DELAY) lockPiece();
    } else lockTimer = 0;
  }

  // --- Draw ------------------------------------------------------------------------------

  function cell(g, x, y, colour, ghost) {
    const px = WX + x * CELL, py = WY + y * CELL;
    if (y < 0) return;
    if (ghost) { g.rect(px + 1, py + 1, CELL - 2, CELL - 2, colour); return; }
    g.fill(px, py, CELL - 1, CELL - 1, colour);
    g.line(px, py, px + CELL - 2, py, "white"); // a little highlight
  }

  function drawMini(g, type, x, y) {
    const t = a.tetrominoes[type];
    for (const [cx, cy] of t.rotations[0]) g.fill(x + cx * 7, y + cy * 7, 6, 6, t.color);
  }

  function drawWell(g) {
    g.cls(0);
    g.rect(WX - 2, WY - 2, COLS * CELL + 3, ROWS * CELL + 3, "grey");
    well.each((v, x, y) => { if (v) cell(g, x, y, v); else g.pset(WX + x * CELL + 5, WY + y * CELL + 5, 10); });
    if (flash) for (const y of flash.rows) g.fill(WX, WY + y * CELL, COLS * CELL, CELL - 1, flash.t % 4 < 2 ? "white" : 0);
  }

  function drawPlay(g) {
    drawWell(g);
    const colour = a.tetrominoes[piece.type].color;
    for (const [x, y] of well.cellsOf(well.dropPosition(piece))) cell(g, x, y, colour, true);
    for (const [x, y] of well.cellsOf(piece)) cell(g, x, y, colour);
    particles.draw(g);
    // Left panel: hold and stats.
    g.text("HOLD", 12, 12, "white");
    if (held) drawMini(g, held, 14, 26);
    g.text("SCORE", 12, 70, "white");
    g.text(String(score), 12, 82, "yellow");
    g.text("LINES", 12, 100, "white");
    g.text(String(lines), 12, 112, "yellow");
    g.text("LEVEL", 12, 130, "white");
    g.text(String(level), 12, 142, "yellow");
    g.text("HI", 12, 160, "white");
    g.text(String(Math.max(a.score.best, score)), 12, 172, "yellow");
    // Right panel: the next three pieces.
    const rx = WX + COLS * CELL + 14;
    g.text("NEXT", rx, 12, "white");
    bag.peek(3).forEach((t, i) => drawMini(g, t, rx + 2, 28 + i * 26));
  }

  function drawTitle(g) {
    g.cls(0);
    const names = Object.keys(a.tetrominoes);
    names.forEach((t, i) => drawMini(g, t, 20 + i * 42, 16 + Math.round(Math.sin(a.t * 2 + i) * 4)));
    g.text("BLOCKS", W / 2, 50, "cyan", { align: "center", scale: 3 });
    const help = ["LEFT/RIGHT  MOVE", "DOWN  SOFT DROP   UP  HARD DROP", "SPACE  ROTATE   X  HOLD"];
    help.forEach((line, i) => g.text(line, W / 2, 86 + i * 11, "white", { align: "center" }));
    a.score.draw(g, W / 2, 130, { rows: 7, color: "white", highlight: "yellow" });
    if (Math.floor(a.frame / 30) % 2 === 0) g.text("PRESS SPACE", W / 2, 230, "yellow", { align: "center" });
  }

  function drawOver(g) {
    drawWell(g);
    particles.draw(g);
    g.fill(40, 60, W - 80, 130, 0);
    g.rect(40, 60, W - 80, 130, "red");
    g.text("GAME OVER", W / 2, 70, "red", { align: "center", scale: 2 });
    g.text(`SCORE ${score}  LINES ${lines}`, W / 2, 92, "white", { align: "center" });
    a.score.draw(g, W / 2, 108, { rows: 6, color: "white", highlight: "yellow" });
    if (overTimer > 60 && Math.floor(a.frame / 30) % 2 === 0) g.text("PRESS SPACE", W / 2, 176, "yellow", { align: "center" });
  }

  return {
    update() {
      if (scene === "title") {
        if (a.btnp("fire") || a.btnp("start")) newGame();
      } else if (scene === "play") {
        updatePlay();
      } else {
        overTimer++;
        particles.update();
        if (overTimer > 60 && (a.btnp("fire") || a.btnp("start"))) scene = "title";
      }
    },
    draw(g) {
      if (scene === "title") drawTitle(g);
      else if (scene === "play") drawPlay(g);
      else drawOver(g);
    },
  };
}
