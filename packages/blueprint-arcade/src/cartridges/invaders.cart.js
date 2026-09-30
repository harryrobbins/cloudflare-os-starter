// Invaders: marching alien rows, crumbling bunkers and a mystery saucer.
// Adapt it: change ROWS/COLS, the colours in ROW_COLOURS, or the speeds in SETTINGS.

export const config = {
  title: "Invaders",
  mode: "arcade", // 224 x 256, like the original cabinet turned upright
  controls: "arcade",
  help: ["Left / Right: move", "Space: fire", "P: pause"],
};

export default function game(a) {
  const W = a.W, H = a.H;
  const COLS = 11, ROWS = 5;
  const SETTINGS = { playerSpeed: 1.5, shotSpeed: 5, bombSpeed: 2, maxBombs: 3 };
  // Gel-overlay colours: white at the top, green near the bottom.
  const ROW_COLOURS = ["white", "white", "cyan", "green", "green"];
  const FRAMES = [
    [a.sprites.alienA1, a.sprites.alienA2, 30], // [frame 1, frame 2, points]
    [a.sprites.alienB1, a.sprites.alienB2, 20],
    [a.sprites.alienB1, a.sprites.alienB2, 20],
    [a.sprites.alienC1, a.sprites.alienC2, 10],
    [a.sprites.alienC1, a.sprites.alienC2, 10],
  ];
  const cannon = a.sprites.cannon;
  const saucerSprite = a.sprites.saucer;
  const boom = a.sprites.boom;
  const bunkerArt = a.sprites.bunker;
  const particles = a.particles();

  let scene = "title";
  let score = 0, lives = 3, level = 1;
  let player, shot, bombs, aliens, march, saucer, bunkers, deadTimer, explosions, overTimer;

  // --- Setup -----------------------------------------------------------------------------

  function newGame() {
    score = 0; lives = 3; level = 1;
    newWave();
    buildBunkers();
    scene = "play";
    a.sfx("powerup");
  }

  function newWave() {
    aliens = [];
    const top = 40 + Math.min(level - 1, 5) * 8;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) aliens.push({ row: r, col: c, x: 16 + c * 16, y: top + r * 16, alive: true });
    }
    march = { dir: 1, frame: 0, timer: 0, step: 0, drop: false };
    player = { x: W / 2 - 5, y: H - 32 };
    shot = null;
    bombs = [];
    saucer = null;
    deadTimer = 0;
    explosions = [];
  }

  // Each bunker is a mask: 1 where brick remains. Shots and bombs chip it away.
  function buildBunkers() {
    bunkers = [];
    for (let i = 0; i < 4; i++) {
      const mask = new Uint8Array(bunkerArt.w * bunkerArt.h);
      for (let k = 0; k < mask.length; k++) mask[k] = bunkerArt.data[k] !== 255 ? 1 : 0;
      bunkers.push({ x: 22 + i * 48, y: H - 64, mask });
    }
  }

  // Does (x, y) hit a bunker? If so, blow a small hole there and say yes.
  function hitBunker(x, y) {
    for (const b of bunkers) {
      const bx = Math.floor(x - b.x), by = Math.floor(y - b.y);
      if (bx < 0 || by < 0 || bx >= bunkerArt.w || by >= bunkerArt.h) continue;
      if (!b.mask[by * bunkerArt.w + bx]) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        if (dx * dx + dy * dy > 5 || a.chance(0.25)) continue;
        const px = bx + dx, py = by + dy;
        if (px >= 0 && py >= 0 && px < bunkerArt.w && py < bunkerArt.h) b.mask[py * bunkerArt.w + px] = 0;
      }
      return true;
    }
    return false;
  }

  const alive = () => aliens.filter((al) => al.alive);
  const boxOf = (al) => ({ x: al.x, y: al.y, w: FRAMES[al.row][0].w, h: 8 });

  // --- Update ----------------------------------------------------------------------------

  function updateMarch() {
    const left = alive();
    if (!left.length) {
      level++;
      a.sfx("win");
      newWave();
      return;
    }
    // Fewer aliens, faster march: one step every `interval` frames.
    const interval = Math.max(2, Math.round(left.length / 2.2) - level);
    if (++march.timer < interval) return;
    march.timer = 0;
    march.frame ^= 1;
    a.sfx("march" + (march.step % 4 + 1));
    march.step++;
    if (march.drop) {
      for (const al of left) al.y += 8;
      march.dir *= -1;
      march.drop = false;
    } else {
      for (const al of left) al.x += 2 * march.dir;
      const edge = left.some((al) => (march.dir > 0 ? al.x + 12 >= W - 4 : al.x <= 4));
      if (edge) march.drop = true;
    }
    // Aliens that reach the cannon's row win outright.
    if (left.some((al) => al.y + 8 >= player.y)) { lives = 0; loseLife(); }
    // Aliens trample bunkers as they pass.
    for (const al of left) for (let x = al.x; x < al.x + 12; x += 2) hitBunker(x, al.y + 7);
  }

  function updateBombs() {
    const left = alive();
    if (bombs.length < SETTINGS.maxBombs && left.length && a.chance(0.02 + level * 0.005)) {
      // Bombs fall from the lowest alien in a random column.
      const shooter = a.pick(left);
      const lowest = left.filter((al) => al.col === shooter.col).toSorted((p, q) => q.y - p.y)[0];
      bombs.push({ x: lowest.x + 5, y: lowest.y + 8, zig: a.chance(0.5) });
    }
    for (const b of bombs) {
      b.y += SETTINGS.bombSpeed + level * 0.15;
      if (hitBunker(b.x, b.y + 4)) b.dead = true;
      else if (b.y > H - 20) b.dead = true;
      else if (deadTimer === 0 && a.hit.rects({ x: b.x, y: b.y, w: 2, h: 4 }, { x: player.x, y: player.y, w: cannon.w, h: cannon.h })) {
        b.dead = true;
        loseLife();
      } else if (shot && a.hit.rects({ x: b.x - 1, y: b.y, w: 4, h: 4 }, { x: shot.x, y: shot.y, w: 1, h: 4 })) {
        b.dead = true; shot = null;
      }
    }
    bombs = bombs.filter((b) => !b.dead);
  }

  function updateShot() {
    if (!shot && deadTimer === 0 && a.btnp("fire")) {
      shot = { x: player.x + 5, y: player.y - 4 };
      a.sfx("shoot");
    }
    if (!shot) return;
    shot.y -= SETTINGS.shotSpeed;
    if (shot.y < 16) { shot = null; return; }
    if (hitBunker(shot.x, shot.y)) { shot = null; return; }
    for (const al of alive()) {
      if (a.hit.point(shot.x, shot.y, boxOf(al))) {
        al.alive = false;
        score += FRAMES[al.row][2];
        explosions.push({ x: al.x, y: al.y, t: 12 });
        particles.burst(al.x + 6, al.y + 4, { count: 10, color: ROW_COLOURS[al.row], speed: 1.5, life: 16 });
        a.sfx("bang");
        shot = null;
        return;
      }
    }
    if (saucer && a.hit.point(shot.x, shot.y, { x: saucer.x, y: 24, w: 16, h: 7 })) {
      const bonus = a.pick([50, 100, 150, 300]);
      score += bonus;
      explosions.push({ x: saucer.x, y: 24, t: 40, text: String(bonus) });
      a.sfx("explode");
      a.shake(10, 2);
      saucer = null;
      shot = null;
    }
  }

  function updateSaucer() {
    if (!saucer && a.chance(0.002)) {
      const fromLeft = a.chance(0.5);
      saucer = { x: fromLeft ? -16 : W, dx: fromLeft ? 0.8 : -0.8 };
    }
    if (!saucer) return;
    saucer.x += saucer.dx;
    if (a.frame % 16 === 0) a.sfx("ufo");
    if (saucer.x < -20 || saucer.x > W + 4) saucer = null;
  }

  function loseLife() {
    if (deadTimer > 0) return;
    lives--;
    deadTimer = 90;
    a.sfx("explode");
    a.shake(20, 3);
    particles.burst(player.x + 5, player.y + 3, { count: 30, colors: ["green", "white"], speed: 2, life: 30 });
    bombs = [];
  }

  function gameOver() {
    scene = "over";
    overTimer = 0;
    a.score.submit(score, `level ${level}`);
    a.music("Game over", { loop: false });
  }

  function updatePlay() {
    if (deadTimer > 0) {
      deadTimer--;
      if (deadTimer === 0 && lives <= 0) gameOver();
      if (deadTimer === 0) player.x = W / 2 - 5;
    } else {
      const ax = a.axis().x;
      player.x = a.clamp(player.x + ax * SETTINGS.playerSpeed, 4, W - cannon.w - 4);
    }
    updateShot();
    updateMarch();
    updateBombs();
    updateSaucer();
    particles.update();
    for (const e of explosions) e.t--;
    explosions = explosions.filter((e) => e.t > 0);
  }

  // --- Draw ------------------------------------------------------------------------------

  function drawHud(g) {
    g.text(`SCORE ${String(score).padStart(5, "0")}`, 4, 4, "white");
    g.text(`HI ${String(Math.max(a.score.best, score)).padStart(5, "0")}`, W - 4, 4, "white", { align: "right" });
    g.line(0, H - 14, W, H - 14, "green");
    for (let i = 0; i < lives - 1; i++) g.sprite(cannon, 24 + i * 14, H - 11, { color: "green" });
    g.text(String(Math.max(0, lives)), 6, H - 11, "white");
    g.text(`L${level}`, W - 4, H - 11, "white", { align: "right" });
  }

  function drawPlay(g) {
    g.cls(0);
    drawHud(g);
    for (const b of bunkers) {
      for (let y = 0; y < bunkerArt.h; y++) for (let x = 0; x < bunkerArt.w; x++) {
        if (b.mask[y * bunkerArt.w + x]) g.pset(b.x + x, b.y + y, "green");
      }
    }
    for (const al of alive()) g.sprite(FRAMES[al.row][march.frame], al.x, al.y, { color: ROW_COLOURS[al.row] });
    if (saucer) g.sprite(saucerSprite, saucer.x, 24, { color: "red" });
    for (const e of explosions) {
      if (e.text) g.text(e.text, e.x, 24, "red");
      else g.sprite(boom, e.x, e.y, { color: "white" });
    }
    if (deadTimer === 0 || Math.floor(deadTimer / 6) % 2) g.sprite(cannon, player.x, player.y, { color: deadTimer ? "red" : "green" });
    if (shot) g.fill(shot.x, shot.y, 1, 4, "white");
    for (const b of bombs) g.sprite(b.zig && a.frame % 8 < 4 ? a.sprites.zigzag : a.sprites.shot, b.x, b.y, { color: "white" });
    particles.draw(g);
  }

  function drawTitle(g) {
    g.cls(0);
    g.text("INVADERS", W / 2, 30, "green", { align: "center", scale: 2 });
    const table = [[a.sprites.saucer, "= ? MYSTERY", "red"], [a.sprites.alienA1, "= 30 POINTS", "white"],
      [a.sprites.alienB1, "= 20 POINTS", "cyan"], [a.sprites.alienC1, "= 10 POINTS", "green"]];
    table.forEach(([spr, label, colour], i) => {
      g.sprite(spr, 52, 72 + i * 16, { color: colour });
      g.text(label, 76, 72 + i * 16, "white");
    });
    g.text("LEFT/RIGHT MOVE  SPACE FIRE", W / 2, 150, "cyan", { align: "center" });
    a.score.draw(g, W / 2, 170, { rows: 5, color: "white", highlight: "yellow" });
    if (Math.floor(a.frame / 30) % 2 === 0) g.text("PRESS SPACE", W / 2, 232, "yellow", { align: "center" });
  }

  function drawOver(g) {
    drawPlay(g);
    g.fill(20, 60, W - 40, 130, 0);
    g.rect(20, 60, W - 40, 130, "red");
    g.text("GAME OVER", W / 2, 72, "red", { align: "center", scale: 2 });
    g.text(`SCORE ${score}`, W / 2, 96, "white", { align: "center" });
    a.score.draw(g, W / 2, 112, { rows: 6, color: "white", highlight: "yellow" });
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
