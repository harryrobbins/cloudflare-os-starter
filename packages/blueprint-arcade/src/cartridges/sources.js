// @ts-check
// The starter cartridges' code as text, joined with their registry entries. The `?raw` imports
// are resolved by scripts/build.mjs (esbuild) and by Vite in the tests.

import { CARTRIDGES } from "./registry.js";
// @ts-ignore text import
import invaders from "./invaders.cart.js?raw";
// @ts-ignore text import
import rocks from "./rocks.cart.js?raw";
// @ts-ignore text import
import blocks from "./blocks.cart.js?raw";
// @ts-ignore text import
import bricks from "./bricks.cart.js?raw";
// @ts-ignore text import
import gulper from "./gulper.cart.js?raw";
// @ts-ignore text import
import tables from "./tables.cart.js?raw";
// @ts-ignore text import
import darkroom from "./darkroom.cart.js?raw";
// @ts-ignore text import
import blank from "./blank.cart.js?raw";

/** @type {Record<string, string>} */
const SOURCES = { invaders, rocks, blocks, bricks, gulper, tables, darkroom, blank };

export const TEMPLATES = CARTRIDGES.map((c) => ({ ...c, source: SOURCES[c.id] }));
