// @ts-check
// Arcade gadget server: the `Gadget` Durable Object (RPC surface in src/README.md) and the
// `ExportHandler` (Markdown summary, every game's code, and each tune as WAV or MIDI). Rules live
// in src/core/arcade.js, persistence and fan-out in src/core/store.js; this file wires them to the
// platform.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { ArcadeService } from "../core/store.js";
import { TEMPLATES } from "../cartridges/sources.js";
import { STARTER_TUNES } from "../tunes/starter.js";
import { encodeMidi, encodeWav, renderSong } from "../shared/music.js";

const BATCH = 128;
const WAV_RATE = 22_050;
// The platform allows 32 export formats: the summary, all code, then WAV and MIDI per tune.
const MAX_TUNE_EXPORTS = 15;

/** Durable Object storage behind the Repository seam; a write is one transaction. */
class DoRepository {
  /** @param {any} storage */
  constructor(storage) { this.storage = storage; }
  /** @param {string[]} keys */
  get(keys) { return this.storage.get(keys); }
  /** @param {string} prefix */
  list(prefix) { return this.storage.list({ prefix }); }
  /** @param {Record<string, any>} puts @param {string[]} deletes */
  async write(puts, deletes) {
    const entries = Object.entries(puts);
    await this.storage.transaction(async (/** @type {any} */ txn) => {
      for (let i = 0; i < deletes.length; i += BATCH) await txn.delete(deletes.slice(i, i + BATCH));
      for (let i = 0; i < entries.length; i += BATCH) await txn.put(Object.fromEntries(entries.slice(i, i + BATCH)));
    });
  }
}

export class Gadget extends DurableObject {
  /** @param {DurableObjectState} ctx @param {unknown} env */
  constructor(ctx, env) {
    super(ctx, /** @type {any} */ (env));
    this.service = new ArcadeService(new DoRepository(ctx.storage), { templates: TEMPLATES, starterTunes: STARTER_TUNES });
  }

  // --- Reads ---------------------------------------------------------------------------------

  /** The shelf: games (no code), tunes, starter templates, and this viewer's preferences. @param {string} viewerId */
  getView(viewerId) { return this.service.view(viewerId); }
  /** One game including its `source`. @param {string} gameId */
  getGame(gameId) { return this.service.read((a) => a.getGame(gameId)); }
  /** One tune: {id, song, version}. @param {string} tuneId */
  getTune(tuneId) { return this.service.read((a) => a.getTune(tuneId)); }
  /** The starter templates including their source. */
  getTemplates() { return TEMPLATES; }
  /** Games, scores and tunes as Markdown. */
  getSummaryMarkdown() { return this.service.read((a) => a.summaryMarkdown()); }

  // --- Writes (every args object carries by = {id, name} of the signed-in account) -----------

  /** @param {any} args {by, title} */
  setTitle(args) { return this.service.write("setTitle", args); }
  /** @param {any} args {by, title?, template?, source?, description?} */
  createGame(args) { return this.service.write("createGame", args); }
  /** @param {any} args {by, gameId, source, baseVersion?} */
  saveGame(args) { return this.service.write("saveGame", args); }
  /** @param {any} args {by, gameId, title?, description?} */
  updateGame(args) { return this.service.write("updateGame", args); }
  /** @param {any} args {by, gameId, title?} */
  duplicateGame(args) { return this.service.write("duplicateGame", args); }
  /** @param {any} args {by, gameId} */
  resetGame(args) { return this.service.write("resetGame", args); }
  /** @param {any} args {by, gameId} */
  deleteGame(args) { return this.service.write("deleteGame", args); }
  /** @param {any} args {by, gameId, toIndex} */
  moveGame(args) { return this.service.write("moveGame", args); }
  /** @param {any} args {by, gameId, score, detail?} */
  submitScore(args) { return this.service.write("submitScore", args); }
  /** @param {any} args {by, gameId} */
  clearScores(args) { return this.service.write("clearScores", args); }
  /** @param {any} args {by, song?} */
  createTune(args) { return this.service.write("createTune", args); }
  /** @param {any} args {by, tuneId, song, baseVersion?} */
  saveTune(args) { return this.service.write("saveTune", args); }
  /** @param {any} args {by, tuneId} */
  duplicateTune(args) { return this.service.write("duplicateTune", args); }
  /** @param {any} args {by, tuneId} */
  deleteTune(args) { return this.service.write("deleteTune", args); }
  /** @param {any} args {by, layout?, custom?, muted?, volume?} */
  setPrefs(args) { return this.service.write("setPrefs", args); }

  // --- Live updates --------------------------------------------------------------------------

  /**
   * Keeps `callback` (an RpcTarget with update(view)), duplicated so it outlives this call, and
   * returns the current view. update(view) is then called after every change.
   * @param {any} callback @param {any} client {clientId, viewerId}
   */
  subscribe(callback, client) {
    const stub = typeof callback?.dup === "function" ? callback.dup() : callback;
    return this.service.subscribe(stub, client);
  }

  /** @param {string} clientId */
  unsubscribe(clientId) { this.service.unsubscribe(clientId); }

  /** @param {string} clientId @param {string} viewerId */
  ping(clientId, viewerId) { return this.service.ping(clientId, viewerId); }
}

export class ExportHandler extends WorkerEntrypoint {
  /** @param {any} gadget */
  async getExportFormats(gadget) {
    const view = await gadget.getView("");
    const formats = [
      { id: "summary", label: "Games, scores and tunes (Markdown)", mode: "server", contentType: "text/markdown", fileExtension: ".md" },
      { id: "code", label: "Every game's code (Markdown)", mode: "server", contentType: "text/markdown", fileExtension: ".md" },
    ];
    for (const t of view.tunes.slice(0, MAX_TUNE_EXPORTS)) {
      const name = String(t.song.title).slice(0, 90);
      formats.push(
        { id: `wav:${t.id}`, label: `${name} (WAV audio)`, mode: "server", contentType: "audio/wav", fileExtension: ".wav" },
        { id: `midi:${t.id}`, label: `${name} (MIDI)`, mode: "server", contentType: "audio/midi", fileExtension: ".mid" },
      );
    }
    return formats;
  }

  /** @param {any} gadget @param {string} id */
  async export(gadget, id) {
    if (id === "summary") return new Response(await gadget.getSummaryMarkdown()).body;
    if (id === "code") {
      const view = await gadget.getView("");
      const parts = [`# ${view.title}: game code`, ""];
      for (const g of view.games) {
        const full = await gadget.getGame(g.id);
        parts.push(`## ${g.title}`, "", "```js", full.source, "```", "");
      }
      return new Response(parts.join("\n")).body;
    }
    const m = /^(wav|midi):(.+)$/.exec(id);
    if (m) {
      const tune = await gadget.getTune(m[2]);
      if (tune.error) throw new Error(tune.error);
      if (m[1] === "midi") return new Response(encodeMidi(tune.song)).body;
      // A looping tune is exported twice through, so it can be heard looping.
      const { samples } = renderSong(tune.song, { sampleRate: WAV_RATE, loops: tune.song.loop ? 2 : 1 });
      return new Response(encodeWav(samples, WAV_RATE)).body;
    }
    throw new Error(`Unknown export format: ${id}`);
  }
}
