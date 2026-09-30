// @ts-check
// The tunes every new arcade starts with, on its Music tab. Games play them by title with
// a.music("Title theme"). Traditional melodies (Korobeiniki, Twinkle) are public domain; the rest
// are written for this blueprint.

/** @type {import("../shared/music.js").Song[]} */
export const STARTER_TUNES = [
  {
    title: "Title theme",
    tempo: 140,
    loop: true,
    channels: [
      { name: "Lead", wave: "pulse25", volume: 11, env: "organ", mml: `o5 l8
[c e g > c < g e c e | d f a > d < a f d f | e g b > e < b g e g | f4 a4 g2 ]2` },
      { name: "Harmony", wave: "square", volume: 6, env: "pad", mml: `o4 l2
[e g | f a | g b | a b ]2` },
      { name: "Bass", wave: "triangle", volume: 14, env: "pluck", mml: `o3 l4
[c g c g | d a d a | e b e b | f g c2 ]2` },
      { name: "Drums", wave: "noise", volume: 9, env: "perc", mml: `l8
[o2 c o7 c o5 c o7 c ]16` },
    ],
  },
  {
    title: "Korobeiniki",
    tempo: 150,
    loop: true,
    channels: [
      { name: "Melody", wave: "pulse25", volume: 12, env: "organ", mml: `o5 l8 q6
e4 < b > c d4 c < b | a4 a > c e4 d c | < b4. > c d4 e4 | c4 < a4 a2 |
r > d4 f a4 g f | e4. c e4 d c | < b4 b > c d4 e4 | c4 < a4 a4 r4` },
      { name: "Bass", wave: "triangle", volume: 14, env: "pluck", mml: `o2 l8
[e > e <]4 [a > a <]4 [g+ > g+ <]4 [a > a <]4
[d > d <]4 [c > c <]4 [e > e <]4 [a > a <]4` },
      { name: "Drums", wave: "noise", volume: 8, env: "perc", mml: `
[o3 c4 o7 c8 c8 o5 c4 o7 c8 c8 ]8` },
    ],
  },
  {
    title: "Game over",
    tempo: 100,
    loop: false,
    channels: [
      { name: "Lead", wave: "square", volume: 12, env: "organ", mml: "o4 l8 g f+ f e d+ d c+4. c2" },
      { name: "Bass", wave: "triangle", volume: 14, env: "organ", mml: "o2 l2 g f e c" },
    ],
  },
  {
    title: "Fanfare",
    tempo: 132,
    loop: false,
    channels: [
      { name: "Trumpet", wave: "pulse25", volume: 12, env: "organ", mml: "o4 l16 g g g g8 > c4 r8 < g8 > c8 e8 g2" },
      { name: "Second", wave: "square", volume: 7, env: "organ", mml: "o4 l16 e e e e8 g4 r8 e8 g8 > c8 e2" },
      { name: "Bass", wave: "triangle", volume: 14, env: "organ", mml: "o2 l8 c c c c c4 r8 c g > c c2" },
      { name: "Drums", wave: "noise", volume: 8, env: "perc", mml: "o3 l16 c c c c8 c4 r8 c8 c8 c8 o6 c2" },
    ],
  },
  {
    title: "Twinkle",
    tempo: 110,
    loop: true,
    channels: [
      { name: "Tune", wave: "sine", volume: 13, env: "bell", mml: `o5 l4
c c g g | a a g2 | f f e e | d d c2 |
g g f f | e e d2 | g g f f | e e d2 |
c c g g | a a g2 | f f e e | d d c2` },
      { name: "Accompaniment", wave: "triangle", volume: 12, env: "pluck", mml: `o3 l4
[c > c <]2 | f > c < c > c < | f > c < c > c < | g > d < c > c < |
c > c < f > c < | c > c < g > d < | c > c < f > c < | c > c < g > d < |
[c > c <]2 | f > c < c > c < | f > c < c > c < | g > d < c > c <` },
    ],
  },
];
