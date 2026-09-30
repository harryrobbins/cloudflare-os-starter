// @ts-check
// The arcade's rules: a shelf of games (cartridge source code), a jukebox of tunes, high scores
// per game, and each player's control preferences. Pure: no storage, no platform. Every write
// validates first, then changes state, and reports the storage keys it touched.
//
// Keys: "meta"; "g:<gameId>" one game; "t:<tuneId>" one tune; "s:<gameId>" that game's scores;
// "p:<userId>" one player's preferences.

import { ENVELOPES, MAX_CHANNELS, MAX_MML, WAVES, compileSong } from "../shared/music.js";

export const LIMITS = {
  games: 60,
  tunes: 60,
  source: 100_000,
  title: 60,
  description: 240,
  scoresKept: 20,
  score: 1e12,
  detail: 60,
};
// "auto" uses each game's own layout (its config.controls).
const LAYOUT_PRESETS = ["auto", "arcade", "bbc", "wasd", "both"];
const ACTIONS = ["left", "right", "up", "down", "fire", "alt", "start", "pause"];

export class ArcadeError extends Error {}

/**
 * @typedef {{id: string, name: string}} Person
 * @typedef {{id: string, title: string, description: string, kind: string, template: string|null, source: string,
 *   version: number, createdBy: Person, updatedBy: Person, updatedAt: number}} Game
 * @typedef {{id: string, song: import("../shared/music.js").Song, version: number, updatedBy: Person, updatedAt: number}} Tune
 * @typedef {{name: string, playerId: string, score: number, detail: string, at: number}} Score
 * @typedef {{layout: string, custom: Record<string, string[]>, muted: boolean, volume: number}} Prefs
 * @typedef {{id: string, title: string, description: string, kind: string, source: string}} Template
 */

export function emptyState() {
  return {
    meta: { title: "Arcade", gameOrder: /** @type {string[]} */ ([]), tuneOrder: /** @type {string[]} */ ([]), seeded: false, revision: 0 },
    /** @type {Map<string, Game>} */ games: new Map(),
    /** @type {Map<string, Tune>} */ tunes: new Map(),
    /** @type {Map<string, Score[]>} */ scores: new Map(),
    /** @type {Map<string, Prefs>} */ prefs: new Map(),
  };
}

/** @param {any} v @param {number} max @param {string} what */
function text(v, max, what, { required = true } = {}) {
  if (typeof v !== "string") throw new ArcadeError(`${what} must be text`);
  const t = v.replace(/\s+/g, " ").trim();
  if (required && !t) throw new ArcadeError(`${what} is empty`);
  if (t.length > max) throw new ArcadeError(`${what} is longer than ${max} characters`);
  return t;
}

/** @param {any} by */
function person(by) {
  if (!by || typeof by.id !== "string" || !by.id.trim()) throw new ArcadeError("Every change needs `by`: the signed-in account {id, name}");
  return { id: by.id.trim().slice(0, 200), name: (typeof by.name === "string" && by.name.trim() ? by.name.trim() : by.id.trim()).slice(0, 80) };
}

/**
 * Checks a song and returns a clean copy. MML errors are not refused (a half-written tune is
 * saveable); the composer shows them.
 * @param {any} song
 */
export function cleanSong(song) {
  if (!song || typeof song !== "object") throw new ArcadeError("song must be {title, tempo, loop, channels}");
  const channels = Array.isArray(song.channels) ? song.channels : [];
  if (!channels.length) throw new ArcadeError("A song needs at least one channel");
  if (channels.length > MAX_CHANNELS) throw new ArcadeError(`A song has at most ${MAX_CHANNELS} channels, like the sound chips it imitates`);
  const tempo = Number(song.tempo ?? 120);
  if (!Number.isFinite(tempo) || tempo < 30 || tempo > 400) throw new ArcadeError("tempo must be 30 to 400 beats a minute");
  return {
    title: text(song.title ?? "Untitled", LIMITS.title, "Song title"),
    tempo: Math.round(tempo),
    loop: Boolean(song.loop),
    channels: channels.map((/** @type {any} */ c, /** @type {number} */ i) => {
      const wave = c?.wave ?? "square";
      if (!WAVES.includes(wave)) throw new ArcadeError(`Channel ${i + 1}: wave must be one of ${WAVES.join(", ")}`);
      const volume = Number(c?.volume ?? 12);
      if (!Number.isInteger(volume) || volume < 0 || volume > 15) throw new ArcadeError(`Channel ${i + 1}: volume must be a whole number 0 to 15`);
      let env = c?.env ?? "organ";
      if (typeof env === "string") {
        if (!(env in ENVELOPES)) throw new ArcadeError(`Channel ${i + 1}: env must be one of ${Object.keys(ENVELOPES).join(", ")} or {a, d, s, r}`);
      } else if (env && typeof env === "object") {
        env = Object.fromEntries(["a", "d", "s", "r"].map((k) => {
          const n = Number(env[k]);
          if (!Number.isFinite(n) || n < 0 || n > 4) throw new ArcadeError(`Channel ${i + 1}: env.${k} must be 0 to 4 seconds`);
          return [k, n];
        }));
      } else throw new ArcadeError(`Channel ${i + 1}: bad env`);
      const mml = typeof c?.mml === "string" ? c.mml : "";
      if (mml.length > MAX_MML) throw new ArcadeError(`Channel ${i + 1}: the notes are longer than ${MAX_MML} characters`);
      return { name: text(c?.name ?? `Channel ${i + 1}`, 30, `Channel ${i + 1} name`), wave, volume, env, mml };
    }),
  };
}

/** A starting song for "New tune": the classic four channels. */
export function blankSong(title = "New tune") {
  return {
    title, tempo: 120, loop: true,
    channels: [
      { name: "Lead", wave: "pulse25", volume: 12, env: "organ", mml: "o5 l8 c d e f g4 g4 | a a a a g2 |" },
      { name: "Harmony", wave: "square", volume: 7, env: "pad", mml: "o4 l2 e e | f e |" },
      { name: "Bass", wave: "triangle", volume: 14, env: "pluck", mml: "o3 l4 c g c g | f g c2 |" },
      { name: "Drums", wave: "noise", volume: 9, env: "perc", mml: "l8 [o3 c o7 c o5 c o7 c]4" },
    ],
  };
}

export class Arcade {
  /**
   * @param {ReturnType<typeof emptyState>} state
   * @param {{now?: () => number, random?: () => number, templates?: Template[], starterTunes?: any[]}} [opts]
   */
  constructor(state, opts = {}) {
    this.s = state;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    /** @type {Map<string, Template>} */
    this.templates = new Map((opts.templates ?? []).map((t) => [t.id, t]));
    this.starterTunes = opts.starterTunes ?? [];
  }

  newId() {
    const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
    let id = "";
    for (let i = 0; i < 10; i++) id += alphabet[Math.floor(this.random() * alphabet.length)];
    return id;
  }

  /** Stocks a new arcade with the starter games and tunes. Returns the keys written. */
  seed() {
    if (this.s.meta.seeded) return [];
    const keys = new Set(["meta"]);
    const system = { id: "arcade", name: "Arcade" };
    for (const t of this.templates.values()) {
      if (t.kind === "template") continue;
      keys.add(this.addGame(system, t.title, t.description, t.kind, t.id, t.source).key);
    }
    for (const song of this.starterTunes) keys.add(this.addTune(system, cleanSong(song)).key);
    this.s.meta.seeded = true;
    return [...keys];
  }

  /** @param {Person} by @param {string} title @param {string} description @param {string} kind @param {string|null} template @param {string} source */
  addGame(by, title, description, kind, template, source) {
    if (this.s.games.size >= LIMITS.games) throw new ArcadeError(`An arcade holds at most ${LIMITS.games} games`);
    const id = this.newId();
    const at = this.now();
    /** @type {Game} */
    const game = { id, title, description, kind, template, source, version: 1, createdBy: by, updatedBy: by, updatedAt: at };
    this.s.games.set(id, game);
    this.s.meta.gameOrder.push(id);
    return { game, key: `g:${id}` };
  }

  /** @param {Person} by @param {any} song */
  addTune(by, song) {
    if (this.s.tunes.size >= LIMITS.tunes) throw new ArcadeError(`An arcade holds at most ${LIMITS.tunes} tunes`);
    const id = this.newId();
    /** @type {Tune} */
    const tune = { id, song, version: 1, updatedBy: by, updatedAt: this.now() };
    this.s.tunes.set(id, tune);
    this.s.meta.tuneOrder.push(id);
    return { tune, key: `t:${id}` };
  }

  /** @param {any} id */
  game(id) {
    const g = this.s.games.get(String(id));
    if (!g) throw new ArcadeError("That game is not in this arcade (it may have been deleted)");
    return g;
  }

  /** @param {any} id */
  tune(id) {
    const t = this.s.tunes.get(String(id));
    if (!t) throw new ArcadeError("That tune is not in this arcade (it may have been deleted)");
    return t;
  }

  /** @param {string[]} keys @param {Record<string, any>} [extra] */
  done(keys, extra = {}) {
    this.s.meta.revision++;
    return { keys: [...new Set(["meta", ...keys])], revision: this.s.meta.revision, ...extra };
  }

  // --- Writes --------------------------------------------------------------------------------

  /** @param {any} args {by, title} */
  setTitle(args) {
    person(args.by);
    this.s.meta.title = text(args.title, LIMITS.title, "Arcade name");
    return this.done([]);
  }

  /** New game from a template (default "blank") or from source. @param {any} args {by, title?, template?, source?, description?} */
  createGame(args) {
    const by = person(args.by);
    const tpl = args.source === undefined ? this.templates.get(args.template ?? "blank") : null;
    if (args.source === undefined && !tpl) throw new ArcadeError(`No template "${args.template}". Templates: ${[...this.templates.keys()].join(", ")}`);
    const source = args.source !== undefined ? this.checkSource(args.source) : /** @type {Template} */ (tpl).source;
    const title = text(args.title ?? (tpl && tpl.kind !== "template" ? tpl.title : "New game"), LIMITS.title, "Title");
    const description = text(args.description ?? tpl?.description ?? "", LIMITS.description, "Description", { required: false });
    const { game, key } = this.addGame(by, title, description, tpl?.kind === "template" ? "arcade" : tpl?.kind ?? "arcade", tpl?.id ?? null, source);
    return this.done([key], { game: this.summary(game) });
  }

  /** @param {any} source */
  checkSource(source) {
    if (typeof source !== "string") throw new ArcadeError("source must be the game's code as text");
    if (source.length > LIMITS.source) throw new ArcadeError(`A game's code is at most ${LIMITS.source} characters`);
    if (!/export\s+default/.test(source)) throw new ArcadeError("A game must `export default function game(a) { ... }`");
    return source;
  }

  /**
   * Saves a game's code. With baseVersion, refuses when someone saved since that version, so
   * two editors never silently overwrite each other.
   * @param {any} args {by, gameId, source, baseVersion?}
   */
  saveGame(args) {
    const by = person(args.by);
    const g = this.game(args.gameId);
    const source = this.checkSource(args.source);
    if (args.baseVersion !== undefined && args.baseVersion !== g.version) {
      throw new ArcadeError(`${g.updatedBy.name} saved this game since you opened it (version ${g.version}). Copy your changes, reload, and apply them again.`);
    }
    if (source === g.source) return this.done([], { version: g.version, unchanged: true });
    g.source = source;
    g.version++;
    g.updatedBy = by;
    g.updatedAt = this.now();
    return this.done([`g:${g.id}`], { version: g.version });
  }

  /** @param {any} args {by, gameId, title?, description?} */
  updateGame(args) {
    const by = person(args.by);
    const g = this.game(args.gameId);
    if (args.title !== undefined) g.title = text(args.title, LIMITS.title, "Title");
    if (args.description !== undefined) g.description = text(args.description, LIMITS.description, "Description", { required: false });
    g.updatedBy = by;
    g.updatedAt = this.now();
    return this.done([`g:${g.id}`]);
  }

  /** @param {any} args {by, gameId, title?} */
  duplicateGame(args) {
    const by = person(args.by);
    const g = this.game(args.gameId);
    const title = text(args.title ?? `${g.title} copy`.slice(0, LIMITS.title), LIMITS.title, "Title");
    const { game, key } = this.addGame(by, title, g.description, g.kind, g.template, g.source);
    return this.done([key], { game: this.summary(game) });
  }

  /** Puts a starter game's code back as it shipped. @param {any} args {by, gameId} */
  resetGame(args) {
    const by = person(args.by);
    const g = this.game(args.gameId);
    const tpl = g.template ? this.templates.get(g.template) : null;
    if (!tpl) throw new ArcadeError("This game was not made from a starter, so there is nothing to reset to");
    return this.saveGame({ by, gameId: g.id, source: tpl.source });
  }

  /** @param {any} args {by, gameId} */
  deleteGame(args) {
    person(args.by);
    const g = this.game(args.gameId);
    this.s.games.delete(g.id);
    this.s.scores.delete(g.id);
    this.s.meta.gameOrder = this.s.meta.gameOrder.filter((id) => id !== g.id);
    return this.done([`g:${g.id}`, `s:${g.id}`]);
  }

  /** @param {any} args {by, gameId, toIndex} */
  moveGame(args) {
    person(args.by);
    const g = this.game(args.gameId);
    const order = this.s.meta.gameOrder.filter((id) => id !== g.id);
    const to = Math.max(0, Math.min(order.length, Math.round(Number(args.toIndex) || 0)));
    order.splice(to, 0, g.id);
    this.s.meta.gameOrder = order;
    return this.done([]);
  }

  /**
   * Records a score for the caller. Keeps each player's best only, and the top LIMITS.scoresKept.
   * @param {any} args {by, gameId, score, detail?}
   */
  submitScore(args) {
    const by = person(args.by);
    const g = this.game(args.gameId);
    const score = Number(args.score);
    if (!Number.isFinite(score) || score < 0 || score > LIMITS.score) throw new ArcadeError("score must be a number from 0");
    const detail = typeof args.detail === "string" ? args.detail.slice(0, LIMITS.detail) : "";
    const list = [...(this.s.scores.get(g.id) ?? [])];
    const mine = list.find((s) => s.playerId === by.id);
    if (mine && mine.score >= score) return this.done([], { rank: null, best: mine.score, recorded: false });
    const entry = { name: by.name, playerId: by.id, score: Math.round(score), detail, at: this.now() };
    const next = list.filter((s) => s.playerId !== by.id);
    next.push(entry);
    next.sort((x, y) => y.score - x.score || x.at - y.at);
    const kept = next.slice(0, LIMITS.scoresKept);
    const rank = kept.indexOf(entry);
    if (rank < 0) return this.done([], { rank: null, best: mine?.score ?? 0, recorded: false });
    this.s.scores.set(g.id, kept);
    return this.done([`s:${g.id}`], { rank: rank + 1, best: entry.score, recorded: true });
  }

  /** @param {any} args {by, gameId} */
  clearScores(args) {
    person(args.by);
    const g = this.game(args.gameId);
    this.s.scores.delete(g.id);
    return this.done([`s:${g.id}`]);
  }

  /** @param {any} args {by, song?} */
  createTune(args) {
    const by = person(args.by);
    const { tune, key } = this.addTune(by, cleanSong(args.song ?? blankSong()));
    return this.done([key], { tune });
  }

  /** @param {any} args {by, tuneId, song, baseVersion?} */
  saveTune(args) {
    const by = person(args.by);
    const t = this.tune(args.tuneId);
    const song = cleanSong(args.song);
    if (args.baseVersion !== undefined && args.baseVersion !== t.version) {
      throw new ArcadeError(`${t.updatedBy.name} saved this tune since you opened it (version ${t.version}). Copy your changes, reload, and apply them again.`);
    }
    t.song = song;
    t.version++;
    t.updatedBy = by;
    t.updatedAt = this.now();
    return this.done([`t:${t.id}`], { version: t.version });
  }

  /** @param {any} args {by, tuneId} */
  duplicateTune(args) {
    const by = person(args.by);
    const t = this.tune(args.tuneId);
    const { tune, key } = this.addTune(by, { ...structuredClone(t.song), title: `${t.song.title} copy`.slice(0, LIMITS.title) });
    return this.done([key], { tune });
  }

  /** @param {any} args {by, tuneId} */
  deleteTune(args) {
    person(args.by);
    const t = this.tune(args.tuneId);
    this.s.tunes.delete(t.id);
    this.s.meta.tuneOrder = this.s.meta.tuneOrder.filter((id) => id !== t.id);
    return this.done([`t:${t.id}`]);
  }

  /** The caller's controls and sound settings. @param {any} args {by, layout?, custom?, muted?, volume?} */
  setPrefs(args) {
    const by = person(args.by);
    const p = { ...this.prefsFor(by.id) };
    if (args.layout !== undefined) {
      if (!LAYOUT_PRESETS.includes(args.layout)) throw new ArcadeError(`layout must be one of ${LAYOUT_PRESETS.join(", ")}`);
      p.layout = args.layout;
    }
    if (args.custom !== undefined) {
      if (!args.custom || typeof args.custom !== "object") throw new ArcadeError("custom must be {action: [key codes]}");
      /** @type {Record<string, string[]>} */
      const custom = {};
      for (const [action, codes] of Object.entries(args.custom)) {
        if (!ACTIONS.includes(action)) throw new ArcadeError(`Unknown action "${action}"`);
        if (!Array.isArray(codes) || codes.length > 4 || codes.some((c) => typeof c !== "string" || !/^[A-Za-z0-9]{1,24}$/.test(c) || c === "Escape")) {
          throw new ArcadeError(`${action}: up to 4 key codes such as "KeyZ" (Escape is kept for the platform)`);
        }
        if (codes.length) custom[action] = codes;
      }
      p.custom = custom;
    }
    if (args.muted !== undefined) p.muted = Boolean(args.muted);
    if (args.volume !== undefined) {
      const v = Number(args.volume);
      if (!Number.isFinite(v) || v < 0 || v > 1) throw new ArcadeError("volume must be 0 to 1");
      p.volume = v;
    }
    this.s.prefs.set(by.id, p);
    return this.done([`p:${by.id}`], { prefs: p });
  }

  // --- Reads ---------------------------------------------------------------------------------

  /** @param {string} userId @returns {Prefs} */
  prefsFor(userId) {
    return this.s.prefs.get(userId) ?? { layout: "auto", custom: {}, muted: false, volume: 0.8 };
  }

  /** @param {Game} g */
  summary(g) {
    return {
      id: g.id, title: g.title, description: g.description, kind: g.kind, template: g.template,
      version: g.version, updatedBy: g.updatedBy, updatedAt: g.updatedAt, size: g.source.length,
      scores: (this.s.scores.get(g.id) ?? []).slice(0, 10).map(({ name, score, detail, at }) => ({ name, score, detail, at })),
    };
  }

  /** Everything the shelf shows, for one viewer (their own preferences included). @param {string} viewerId */
  viewFor(viewerId) {
    return {
      revision: this.s.meta.revision,
      title: this.s.meta.title,
      games: this.s.meta.gameOrder.map((id) => this.s.games.get(id)).filter((g) => g !== undefined).map((g) => this.summary(/** @type {Game} */ (g))),
      tunes: this.s.meta.tuneOrder.map((id) => this.s.tunes.get(id)).filter((t) => t !== undefined),
      templates: [...this.templates.values()].map(({ id, title, description, kind }) => ({ id, title, description, kind })),
      prefs: this.prefsFor(viewerId),
    };
  }

  /** A game with its source. @param {string} gameId */
  getGame(gameId) {
    const g = this.game(gameId);
    return { ...this.summary(g), source: g.source };
  }

  /** @param {string} tuneId */
  getTune(tuneId) { return this.tune(tuneId); }

  summaryMarkdown() {
    const lines = [`# ${this.s.meta.title}`, "", "## Games", ""];
    for (const id of this.s.meta.gameOrder) {
      const g = this.s.games.get(id);
      if (!g) continue;
      lines.push(`### ${g.title}`, "", g.description || "_No description._", "", `- Game id: \`${g.id}\`, version ${g.version}, ${g.source.length} characters of code${g.template ? `, from the "${g.template}" starter` : ""}`);
      const scores = this.s.scores.get(g.id) ?? [];
      if (scores.length) {
        lines.push("- High scores:");
        scores.slice(0, 10).forEach((s, i) => lines.push(`  ${i + 1}. ${s.name}: ${s.score}${s.detail ? ` (${s.detail})` : ""}`));
      }
      lines.push("");
    }
    lines.push("## Tunes", "");
    for (const id of this.s.meta.tuneOrder) {
      const t = this.s.tunes.get(id);
      if (!t) continue;
      const c = compileSong(t.song);
      lines.push(`- **${t.song.title}** (tune id \`${t.id}\`): ${t.song.channels.length} channels, ${t.song.tempo} bpm, ${c.seconds.toFixed(1)} s${t.song.loop ? ", loops" : ""}`);
    }
    return lines.join("\n") + "\n";
  }
}
