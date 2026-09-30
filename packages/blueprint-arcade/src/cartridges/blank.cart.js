// A blank cartridge: the smallest useful game. Change anything, then press Run.
// The full list of what `a` can do is in the Reference panel.

// config sets up the screen and keys before the game starts.
export const config = {
  title: "My game",
  mode: "default",     // 320 x 256. Try "bbc2", "arcade", "teletext", "nimbus" or "vector"
  palette: "arcade",   // colours 0-15; you can also write names like "red"
  controls: "arcade",  // arrows + Space. Players can switch to BBC (Z X : /) or WASD
  help: ["Arrows: move", "Space: beep and score", "Return: finish and save your score"],
};

// game(a) runs once. It returns update() (60 times a second) and draw(g).
export default function game(a) {
  // Draw a sprite with characters: "." is see-through, other letters use the key.
  const hero = a.sprite([
    "..XX..",
    ".XXXX.",
    "XX..XX",
    "XXXXXX",
    ".X..X.",
  ], { X: "yellow" });

  let x = a.W / 2, y = a.H / 2;
  let score = 0;
  let saved = false;

  return {
    update() {
      // a.btn is true while a key is held; a.btnp only on the frame it is pressed.
      if (a.btn("left")) x -= 2;
      if (a.btn("right")) x += 2;
      if (a.btn("up")) y -= 2;
      if (a.btn("down")) y += 2;
      x = a.clamp(x, 0, a.W - hero.w * 3);
      y = a.clamp(y, 12, a.H - hero.h * 3);

      if (a.btnp("fire")) {
        score += 10;
        a.sfx("coin"); // other sounds: laser, explode, jump, powerup, hit, blip...
      }
      if (a.btnp("start") && !saved) {
        a.score.submit(score); // saved against the signed-in player
        saved = true;
      }
    },

    draw(g) {
      g.cls(0); // clear to colour 0 (black)
      g.text(config.title, a.W / 2, 8, "cyan", { align: "center", scale: 2 });
      g.text(`SCORE ${score}`, 4, 30, "white");
      g.sprite(hero, x, y, { scale: 3 });
      if (saved) a.score.draw(g, a.W / 2, 150);
      else g.text("PRESS SPACE TO BEEP, RETURN TO SAVE", a.W / 2, a.H - 16, "grey", { align: "center" });
    },
  };
}
