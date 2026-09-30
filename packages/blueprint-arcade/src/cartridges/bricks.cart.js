// Bricks: bat and ball against a wall of bricks.
// Adapt it: draw your own wall in LEVELS (one letter per brick, "." for a gap).

export const config = {
  title: "Bricks",
  mode: "default", // 320 x 256
  palette: "arcade",
  controls: "arcade",
  help: ["Left / Right: move the bat", "Space: launch the ball", "P: pause"],
};

export default function game(a) {
  const W = a.W, H = a.H;
  const BW = 20, BH = 8, TOP = 32; // brick size and the wall's top edge
  const COLOURS = { r: "red", o: "orange", y: "yellow", g: "green", b: "blue", m: "magenta", w: "white" };
  const LEVELS = [
    ["rrrrrrrrrrrrrrrr", "oooooooooooooooo", "yyyyyyyyyyyyyyyy", "gggggggggggggggg", "bbbbbbbbbbbbbbbb"],
    ["r.r.r.r.r.r.r.r.", ".o.o.o.o.o.o.o.o", "y.y.y.y.y.y.y.y.", ".g.g.g.g.g.g.g.g", "b.b.b.b.b.b.b.b.", ".m.m.m.m.m.m.m.m"],
    ["......wwww......", "....mmmmmmmm....", "..bbbbbbbbbbbb..", "gggggggggggggggg", "..yyyyyyyyyyyy..", "....oooooooo....", "......rrrr......"],
  ];
  const particles = a.particles();
  const bat = { w: 32, h: 5, y: H - 20, x: 0 };

  let scene = "title";
  let ball, bricks, score, lives, level, speed, hits, overTimer;

  // --- Setup -----------------------------------------------------------------------------

  function buildWall() {
    bricks = [];
    const rows = LEVELS[(level - 1) % LEVELS.length];
    rows.forEach((row, r) => [...row].forEach((ch, c) => {
      if (ch !== ".") bricks.push({ x: c * BW, y: TOP + r * BH, w: BW - 1, h: BH - 1, colour: COLOURS[ch] ?? "white", points: (rows.length - r) * 10 });
    }));
    speed = 2.2 + (level - 1) * 0.3;
    hits = 0;
  }

  function serve() {
    ball = { x: bat.x + bat.w / 2, y: bat.y - 3, vx: 0, vy: 0, stuck: true, r: 2 };
  }

  function newGame() {
    score = 0; lives = 3; level = 1;
    bat.x = W / 2 - bat.w / 2;
    buildWall();
    serve();
    scene = "play";
    a.sfx("powerup");
  }

  function gameOver() {
    scene = "over";
    overTimer = 0;
    a.score.submit(score, `level ${level}`);
    a.music("Game over", { loop: false });
  }

  // --- Update ----------------------------------------------------------------------------

  function launch() {
    const angle = -Math.PI / 2 + (a.rnd() - 0.5) * 0.8;
    ball.vx = Math.cos(angle) * speed;
    ball.vy = Math.sin(angle) * speed;
    ball.stuck = false;
    a.sfx("blip");
  }

  function moveBall() {
    ball.x += ball.vx;
    ball.y += ball.vy;
    // Walls.
    if (ball.x < ball.r) { ball.x = ball.r; ball.vx = Math.abs(ball.vx); a.sfx("tick"); }
    if (ball.x > W - ball.r) { ball.x = W - ball.r; ball.vx = -Math.abs(ball.vx); a.sfx("tick"); }
    if (ball.y < 16 + ball.r) { ball.y = 16 + ball.r; ball.vy = Math.abs(ball.vy); a.sfx("tick"); }
    // Bat: the further from the middle it hits, the steeper the bounce.
    if (ball.vy > 0 && a.hit.circleRect(ball, bat)) {
      const offset = a.clamp((ball.x - (bat.x + bat.w / 2)) / (bat.w / 2), -1, 1);
      const angle = -Math.PI / 2 + offset * 1.1;
      ball.vx = Math.cos(angle) * speed;
      ball.vy = Math.sin(angle) * speed;
      ball.y = bat.y - ball.r;
      a.sfx("step");
    }
    // Bricks: bounce off the side we came through.
    for (let i = 0; i < bricks.length; i++) {
      const b = bricks[i];
      if (!a.hit.circleRect(ball, b)) continue;
      const fromSide = ball.x - ball.vx < b.x || ball.x - ball.vx > b.x + b.w;
      if (fromSide) ball.vx = -ball.vx; else ball.vy = -ball.vy;
      bricks.splice(i, 1);
      score += b.points;
      particles.burst(b.x + b.w / 2, b.y + b.h / 2, { count: 8, color: b.colour, speed: 1.5, life: 18 });
      a.sfx("bang");
      // Every 8 bricks the ball speeds up a little.
      if (++hits % 8 === 0) {
        speed = Math.min(speed + 0.25, 6);
        const s = Math.hypot(ball.vx, ball.vy);
        ball.vx *= speed / s; ball.vy *= speed / s;
      }
      break;
    }
    // Lost ball.
    if (ball.y > H + 4) {
      lives--;
      a.sfx("lose");
      a.shake(12, 2);
      if (lives <= 0) gameOver(); else serve();
    }
  }

  function updatePlay() {
    const ax = a.axis().x;
    bat.x = a.clamp(bat.x + ax * 4, 0, W - bat.w);
    if (ball.stuck) {
      ball.x = bat.x + bat.w / 2;
      if (a.btnp("fire")) launch();
    } else moveBall();
    particles.update();
    if (scene === "play" && !bricks.length) {
      level++;
      a.music("Fanfare", { loop: false });
      buildWall();
      serve();
    }
  }

  // --- Draw ------------------------------------------------------------------------------

  function drawPlay(g) {
    g.cls(0);
    g.text(`SCORE ${score}`, 4, 4, "white");
    g.text(`HI ${Math.max(a.score.best, score)}`, W / 2, 4, "grey", { align: "center" });
    g.text(`LIVES ${lives}`, W - 4, 4, "white", { align: "right" });
    g.line(0, 14, W, 14, "grey");
    for (const b of bricks) {
      g.fill(b.x, b.y, b.w, b.h, b.colour);
      g.line(b.x, b.y, b.x + b.w - 1, b.y, "white");
    }
    g.fill(bat.x, bat.y, bat.w, bat.h, "cyan");
    g.fill(bat.x + 2, bat.y + 1, bat.w - 4, 1, "white");
    g.disc(ball.x, ball.y, ball.r, "white");
    particles.draw(g);
    if (ball.stuck && Math.floor(a.frame / 20) % 2 === 0) g.text("SPACE TO LAUNCH", W / 2, H / 2 + 40, "yellow", { align: "center" });
  }

  function drawTitle(g) {
    g.cls(0);
    Object.values(COLOURS).forEach((c, i) => g.fill(20 + i * 42, 20, 38, 8, c));
    g.text("BRICKS", W / 2, 48, "orange", { align: "center", scale: 3 });
    g.text("LEFT/RIGHT MOVE   SPACE LAUNCH", W / 2, 88, "white", { align: "center" });
    a.score.draw(g, W / 2, 112, { rows: 8, color: "white", highlight: "yellow" });
    if (Math.floor(a.frame / 30) % 2 === 0) g.text("PRESS SPACE", W / 2, 220, "yellow", { align: "center" });
  }

  function drawOver(g) {
    drawPlay(g);
    g.fill(40, 60, W - 80, 130, 0);
    g.rect(40, 60, W - 80, 130, "red");
    g.text("GAME OVER", W / 2, 70, "red", { align: "center", scale: 2 });
    g.text(`SCORE ${score}`, W / 2, 92, "white", { align: "center" });
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
