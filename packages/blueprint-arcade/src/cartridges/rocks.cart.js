// Rocks: a vector-screen asteroid field. Everything is drawn with lines, like the old
// vector monitors. Adapt it: change SIZES for bigger rocks, or SHIP for a floatier ship.

export const config = {
  title: "Rocks",
  mode: "vector", // 320 x 240, green phosphor palette: 0 background, 1 bright, 2 mid, 3 dim
  controls: "arcade",
  help: ["Left / Right: rotate", "Up: thrust", "Space: fire", "X or Shift: hyperspace", "P: pause"],
};

export default function game(a) {
  const W = a.W, H = a.H;
  const BRIGHT = 1, MID = 2, DIM = 3;
  const SHIP = { turn: 0.075, thrust: 0.09, drag: 0.992, maxSpeed: 5 };
  const SIZES = [{ r: 22, points: 20, speed: 0.8 }, { r: 12, points: 50, speed: 1.3 }, { r: 6, points: 100, speed: 1.9 }];
  const particles = a.particles();

  let scene = "title";
  let ship, rocks, saucer, score, lives, wave, nextLife, respawn, overTimer;
  let bullets = [], saucerShots = [];

  // --- Helpers ---------------------------------------------------------------------------

  // Keep things on screen by wrapping round the edges.
  function wrap(o) { o.x = a.wrap(o.x, W); o.y = a.wrap(o.y, H); }

  function makeRock(x, y, size) {
    const angle = a.rnd(Math.PI * 2);
    const speed = SIZES[size].speed * (0.6 + a.rnd(0.8));
    return { x, y, size, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      spin: (a.rnd() - 0.5) * 0.04, angle: 0, outline: a.rock(SIZES[size].r) };
  }

  function newWave() {
    rocks = [];
    const n = Math.min(3 + wave, 10);
    for (let i = 0; i < n; i++) {
      // Start rocks away from the ship, near the edges.
      const edge = a.chance(0.5);
      rocks.push(makeRock(edge ? a.rnd(W) : 0, edge ? 0 : a.rnd(H), 0));
    }
  }

  function resetShip() {
    ship = { x: W / 2, y: H / 2, vx: 0, vy: 0, angle: -Math.PI / 2, thrusting: false, safe: 120 };
  }

  function newGame() {
    score = 0; lives = 3; wave = 1; nextLife = 10000;
    bullets = []; saucer = null; saucerShots = []; respawn = 0;
    resetShip();
    newWave();
    scene = "play";
    a.sfx("powerup");
  }

  function addScore(n) {
    score += n;
    if (score >= nextLife) { lives++; nextLife += 10000; a.sfx("coin"); }
  }

  function shipOutline() { return a.shape(a.shapes.ship, ship.x, ship.y, ship.angle); }

  function blowUpShip() {
    particles.burst(ship.x, ship.y, { count: 40, colors: [BRIGHT, MID], speed: 2.5, life: 50 });
    a.sfx("explode");
    a.shake(20, 3);
    lives--;
    ship = null;
    respawn = 120;
  }

  function splitRock(rock, i) {
    rocks.splice(i, 1);
    addScore(SIZES[rock.size].points);
    particles.burst(rock.x, rock.y, { count: 12 - rock.size * 3, color: MID, speed: 1.5, life: 25 });
    a.sfx("bang");
    if (rock.size < 2) for (let k = 0; k < 2; k++) rocks.push(makeRock(rock.x, rock.y, rock.size + 1));
  }

  // --- Update ----------------------------------------------------------------------------

  function updateShip() {
    if (!ship) {
      if (--respawn <= 0) {
        if (lives <= 0) { gameOver(); return; }
        resetShip();
      }
      return;
    }
    if (a.btn("left")) ship.angle -= SHIP.turn;
    if (a.btn("right")) ship.angle += SHIP.turn;
    ship.thrusting = a.btn("up");
    if (ship.thrusting) {
      ship.vx += Math.cos(ship.angle) * SHIP.thrust;
      ship.vy += Math.sin(ship.angle) * SHIP.thrust;
      if (a.frame % 6 === 0) a.sfx("thrust");
    }
    const speed = Math.hypot(ship.vx, ship.vy);
    if (speed > SHIP.maxSpeed) { ship.vx *= SHIP.maxSpeed / speed; ship.vy *= SHIP.maxSpeed / speed; }
    ship.vx *= SHIP.drag; ship.vy *= SHIP.drag;
    ship.x += ship.vx; ship.y += ship.vy;
    wrap(ship);
    if (ship.safe > 0) ship.safe--;

    if (a.btnp("fire") && bullets.length < 4) {
      const nose = a.shape([10, 0], ship.x, ship.y, ship.angle);
      bullets.push({ x: nose[0], y: nose[1], vx: ship.vx + Math.cos(ship.angle) * 5, vy: ship.vy + Math.sin(ship.angle) * 5, life: 50 });
      a.sfx("laser");
    }
    if (a.btnp("alt")) {
      // Hyperspace: somewhere random, with a small chance of not surviving the trip.
      ship.x = a.rnd(W); ship.y = a.rnd(H); ship.vx = ship.vy = 0;
      a.sfx("powerup");
      if (a.chance(0.1)) blowUpShip();
    }
  }

  function updateSaucer() {
    if (!saucer && a.chance(0.0015 + wave * 0.0005)) {
      const fromLeft = a.chance(0.5);
      saucer = { x: fromLeft ? 0 : W, y: a.rnd(H * 0.8) + H * 0.1, vx: fromLeft ? 1.2 : -1.2, small: score > 5000 && a.chance(0.5), life: 400 };
    }
    if (saucer) {
      saucer.x += saucer.vx;
      if (a.frame % 60 === 0) saucer.y += a.rndi(-1, 1) * 20;
      saucer.y = a.wrap(saucer.y, H);
      if (a.frame % 20 === 0) a.sfx("tick");
      if (--saucer.life <= 0 || saucer.x < -20 || saucer.x > W + 20) saucer = null;
      else if (a.frame % 50 === 0) {
        // Small saucers aim at the ship; big ones fire anywhere.
        const angle = ship && saucer.small ? a.angle(saucer.x, saucer.y, ship.x, ship.y) : a.rnd(Math.PI * 2);
        saucerShots.push({ x: saucer.x, y: saucer.y, vx: Math.cos(angle) * 3, vy: Math.sin(angle) * 3, life: 70 });
        a.sfx("shoot");
      }
    }
    for (const s of saucerShots) { s.x += s.vx; s.y += s.vy; wrap(s); s.life--; }
    saucerShots = saucerShots.filter((s) => s.life > 0);
  }

  function updateCollisions() {
    for (const b of bullets) { b.x += b.vx; b.y += b.vy; wrap(b); b.life--; }
    for (let i = rocks.length - 1; i >= 0; i--) {
      const r = rocks[i];
      const outline = a.shape(r.outline, r.x, r.y, r.angle);
      const hitBy = bullets.find((b) => b.life > 0 && a.hit.polyCircle(outline, { x: b.x, y: b.y, r: 1 }));
      if (hitBy) { hitBy.life = 0; splitRock(r, i); continue; }
      if (ship && !ship.safe && a.hit.polyCircle(outline, { x: ship.x, y: ship.y, r: 5 })) { splitRock(r, i); blowUpShip(); }
    }
    if (saucer) {
      const box = { x: saucer.x, y: saucer.y, r: saucer.small ? 5 : 10 };
      const hitBy = bullets.find((b) => b.life > 0 && a.hit.circles(box, { x: b.x, y: b.y, r: 1 }));
      if (hitBy) {
        hitBy.life = 0;
        addScore(saucer.small ? 1000 : 200);
        particles.burst(saucer.x, saucer.y, { count: 25, color: BRIGHT, speed: 2, life: 35 });
        a.sfx("explode");
        saucer = null;
      }
    }
    if (ship && !ship.safe) {
      for (const s of saucerShots) {
        if (a.hit.circles({ x: ship.x, y: ship.y, r: 5 }, { x: s.x, y: s.y, r: 1 })) { s.life = 0; blowUpShip(); break; }
      }
    }
    bullets = bullets.filter((b) => b.life > 0);
  }

  function gameOver() {
    scene = "over";
    overTimer = 0;
    a.score.submit(score, `wave ${wave}`);
    a.music("Game over", { loop: false });
  }

  function updatePlay() {
    updateShip();
    if (scene !== "play") return;
    for (const r of rocks) { r.x += r.vx; r.y += r.vy; r.angle += r.spin; wrap(r); }
    updateSaucer();
    updateCollisions();
    particles.update();
    if (!rocks.length) { wave++; newWave(); a.sfx("win"); }
  }

  // --- Draw ------------------------------------------------------------------------------

  function drawField(g) {
    g.cls(0);
    for (const r of rocks) g.poly(a.shape(r.outline, r.x, r.y, r.angle), BRIGHT);
    if (saucer) g.poly(a.shape(a.shapes.saucer, saucer.x, saucer.y, 0, saucer.small ? 0.5 : 1), BRIGHT);
    for (const b of bullets) g.fill(b.x, b.y, 2, 2, BRIGHT);
    for (const s of saucerShots) g.pset(s.x, s.y, BRIGHT);
    particles.draw(g);
  }

  function drawPlay(g) {
    drawField(g);
    if (ship && (!ship.safe || Math.floor(ship.safe / 5) % 2 === 0)) {
      g.poly(shipOutline(), BRIGHT);
      if (ship.thrusting && a.frame % 4 < 2) g.poly(a.shape(a.shapes.flame, ship.x, ship.y, ship.angle), MID);
    }
    g.text(String(score).padStart(6, " "), 8, 6, BRIGHT);
    g.text(`HI ${Math.max(a.score.best, score)}`, W / 2, 6, DIM, { align: "center" });
    for (let i = 0; i < lives; i++) g.poly(a.shape(a.shapes.ship, W - 14 - i * 14, 12, -Math.PI / 2, 0.7), MID);
  }

  function drawTitle(g) {
    if (!rocks) { wave = 3; newWave(); }
    for (const r of rocks) { r.x += r.vx * 0.3; r.y += r.vy * 0.3; r.angle += r.spin; wrap(r); }
    drawField(g);
    g.text("ROCKS", W / 2, 36, BRIGHT, { align: "center", scale: 3 });
    g.text("LEFT/RIGHT ROTATE   UP THRUST", W / 2, 80, MID, { align: "center" });
    g.text("SPACE FIRE   X HYPERSPACE", W / 2, 92, MID, { align: "center" });
    a.score.draw(g, W / 2, 116, { rows: 6, color: MID, highlight: BRIGHT });
    if (Math.floor(a.frame / 30) % 2 === 0) g.text("PRESS SPACE", W / 2, 210, BRIGHT, { align: "center" });
  }

  function drawOver(g) {
    drawField(g);
    g.text("GAME OVER", W / 2, 50, BRIGHT, { align: "center", scale: 2 });
    g.text(`SCORE ${score}`, W / 2, 78, MID, { align: "center" });
    a.score.draw(g, W / 2, 100, { rows: 8, color: MID, highlight: BRIGHT });
    if (overTimer > 60 && Math.floor(a.frame / 30) % 2 === 0) g.text("PRESS SPACE", W / 2, 210, BRIGHT, { align: "center" });
  }

  return {
    update() {
      if (scene === "title") {
        if (a.btnp("fire") || a.btnp("start")) newGame();
      } else if (scene === "play") {
        updatePlay();
      } else {
        overTimer++;
        for (const r of rocks) { r.x += r.vx; r.y += r.vy; r.angle += r.spin; wrap(r); }
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
