// @ts-check
// Built-in art: sprite rows (see makeSprite: "." transparent, "X" draws in the colour you pass or
// white) and vector outlines ([x0, y0, x1, y1, ...] around the origin, pointing right at angle 0).
// Original drawings in the style of the classics, free to use and change.

export const SPRITES = {
  // Three rows of marching aliens, two frames each.
  alienA1: ["...XX...", "..XXXX..", ".XXXXXX.", "XX.XX.XX", "XXXXXXXX", "..X..X..", ".X.XX.X.", "X.X..X.X"],
  alienA2: ["...XX...", "..XXXX..", ".XXXXXX.", "XX.XX.XX", "XXXXXXXX", ".X.XX.X.", "X......X", ".X....X."],
  alienB1: ["..X.....X..", "...X...X...", "..XXXXXXX..", ".XX.XXX.XX.", "XXXXXXXXXXX", "X.XXXXXXX.X", "X.X.....X.X", "...XX.XX..."],
  alienB2: ["..X.....X..", "X..X...X..X", "X.XXXXXXX.X", "XXX.XXX.XXX", "XXXXXXXXXXX", ".XXXXXXXXX.", "..X.....X..", ".X.......X."],
  alienC1: ["....XXXX....", ".XXXXXXXXXX.", "XXXXXXXXXXXX", "XXX..XX..XXX", "XXXXXXXXXXXX", "...XX..XX...", "..XX.XX.XX..", "XX........XX"],
  alienC2: ["....XXXX....", ".XXXXXXXXXX.", "XXXXXXXXXXXX", "XXX..XX..XXX", "XXXXXXXXXXXX", "..XXX..XXX..", ".XX..XX..XX.", "..XX....XX.."],
  cannon: [".....X.....", "....XXX....", "....XXX....", ".XXXXXXXXX.", "XXXXXXXXXXX", "XXXXXXXXXXX", "XXXXXXXXXXX"],
  saucer: [".....XXXXXX.....", "...XXXXXXXXXX...", "..XXXXXXXXXXXX..", ".XX.XX.XX.XX.XX.", "XXXXXXXXXXXXXXXX", "..XXX..XX..XXX..", "...X........X..."],
  boom: ["X...X..X...X", ".X...XX...X.", "..X......X..", "XX........XX", "..X......X..", ".X...XX...X.", "X...X..X...X"],
  shot: ["X", "X", "X", "X"],
  zigzag: [".X", "X.", ".X", "X."],
  bunker: ["....XXXXXXXXXXXX....", "...XXXXXXXXXXXXXX...", "..XXXXXXXXXXXXXXXX..", ".XXXXXXXXXXXXXXXXXX.", "XXXXXXXXXXXXXXXXXXXX",
    "XXXXXXXXXXXXXXXXXXXX", "XXXXXXXXXXXXXXXXXXXX", "XXXXXXXXXXXXXXXXXXXX", "XXXXXXXXXXXXXXXXXXXX", "XXXXXXXXXXXXXXXXXXXX",
    "XXXXXX........XXXXXX", "XXXXX..........XXXXX", "XXXX............XXXX", "XXXX............XXXX"],
  // General purpose.
  heart: [".XX.XX.", "XXXXXXX", "XXXXXXX", ".XXXXX.", "..XXX..", "...X..."],
  star: ["...X...", "...X...", "XXXXXXX", ".XXXXX.", "..XXX..", ".XX.XX.", "X.....X"],
  coin: ["..XXX..", ".X...X.", "X..X..X", "X..X..X", "X..X..X", ".X...X.", "..XXX.."],
  gem: ["..XXX..", ".XXXXX.", "XXXXXXX", ".XXXXX.", "..XXX..", "...X..."],
  key: [".XXX.....", "X...X....", "X...XXXXX", "X...X.X.X", ".XXX....."],
  apple: ["....X...", "...X....", ".XX.XX..", "XXXXXXX.", "XXXXXXX.", "XXXXXXX.", ".XXXXX..", "..X.X..."],
  ghost: ["..XXXX..", ".XXXXXX.", "XX.XX.XX", "XXXXXXXX", "XXXXXXXX", "XXXXXXXX", "X.XX.XX."],
  smiley: ["..XXXX..", ".X....X.", "X.X..X.X", "X......X", "X.X..X.X", "X..XX..X", ".X....X.", "..XXXX.."],
  arrow: ["...X....", "...XX...", "XXXXXX..", "XXXXXXX.", "XXXXXX..", "...XX...", "...X...."],
  block: ["XXXXXXXX", "X......X", "X......X", "X......X", "X......X", "X......X", "X......X", "XXXXXXXX"],
  brick: ["XXXXXXXXXXXXXXX.", "XXXXXXXXXXXXXXX.", "XXXXXXXXXXXXXXX.", "XXXXXXXXXXXXXXX.", "XXXXXXXXXXXXXXX.", "XXXXXXXXXXXXXXX.", "................"],
  ball: [".XX.", "XXXX", "XXXX", ".XX."],
  paddle: [".XXXXXXXXXXXXXXXXXXXXX.", "XXXXXXXXXXXXXXXXXXXXXXX", ".XXXXXXXXXXXXXXXXXXXXX."],
  // A little muncher for number and word games, mouth open and shut.
  gulper1: ["..XXXX..", ".XXXXXX.", "XXX.XX..", "XXXXX...", "XXXXX...", "XXXXXX..", ".XXXXXX.", "..XXXX.."],
  gulper2: ["..XXXX..", ".XXXXXX.", "XXX.XXXX", "XXXXXXXX", "XXXXXXXX", "XXXXXXXX", ".XXXXXX.", "..XXXX.."],
  troggle: ["..X..X..", "...XX...", ".XXXXXX.", "XX.XX.XX", "XXXXXXXX", ".X.XX.X.", ".X....X.", "XX....XX"],
  owl: ["X......X", "XX....XX", "XXXXXXXX", "X.XXXX.X", "XXX..XXX", ".XXXXXX.", ".X.XX.X.", "..X..X.."],
  // Player figure, two walking frames.
  man1: ["..XX..", "..XX..", ".XXXX.", "X.XX.X", "..XX..", ".X..X.", ".X..X."],
  man2: ["..XX..", "..XX..", ".XXXX.", "X.XX.X", "..XX..", "..XX..", ".X.X.."],
};

export const SHAPES = {
  // Asteroids-style ship: nose at +x.
  ship: [10, 0, -7, -6, -4, 0, -7, 6],
  flame: [-5, -3, -11, 0, -5, 3],
  saucer: [-10, 0, -5, -4, 5, -4, 10, 0, 5, 4, -5, 4, -10, 0, 10, 0],
  arrowhead: [8, 0, -6, -6, -2, 0, -6, 6],
  diamond: [0, -8, 8, 0, 0, 8, -8, 0],
  square: [-6, -6, 6, -6, 6, 6, -6, 6],
  triangle: [0, -8, 7, 6, -7, 6],
  star5: (() => {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 4 : 10;
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      pts.push(Math.round(Math.cos(a) * r * 10) / 10, Math.round(Math.sin(a) * r * 10) / 10);
    }
    return pts;
  })(),
};
