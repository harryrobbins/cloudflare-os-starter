// @ts-check
// The starter cartridges every new arcade is stocked with. Each `<id>.cart.js` in this directory
// is a game's full source, stored as text in the arcade and edited there; see src/README.md.

export const CARTRIDGES = [
  { id: "invaders", title: "Invaders", kind: "arcade", description: "Marching alien rows, crumbling bunkers and a mystery saucer. Space fires." },
  { id: "rocks", title: "Rocks", kind: "arcade", description: "Vector-screen asteroid field: rotate, thrust, fire and hyperspace." },
  { id: "blocks", title: "Blocks", kind: "arcade", description: "Falling blocks with rotation kicks, hold, ghost piece and a 7-bag." },
  { id: "bricks", title: "Bricks", kind: "arcade", description: "Bat and ball against a wall of bricks, with speed-ups." },
  { id: "gulper", title: "Number Gulper", kind: "classroom", description: "BBC Mode 2 maths munching: eat the numbers that fit the rule, dodge the Troggles." },
  { id: "tables", title: "Teletext Tables", kind: "classroom", description: "A Mode 7 times-tables quiz against the clock, typed answers, level by level." },
  { id: "darkroom", title: "Dark Room", kind: "classroom", description: "A Nimbus-style hidden-text puzzle: guess words and letters to develop the passage." },
  { id: "blank", title: "Blank cartridge", kind: "template", description: "A commented starting point: a sprite you can move, a sound and a score." },
];
