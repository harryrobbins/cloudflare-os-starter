import { describe, expect, it } from "vitest";
import { bbcSound, compileSong, encodeMidi, encodeWav, midiToHz, parseMml, renderSfx, renderSong, SFX_PRESETS } from "../../src/shared/music.js";
import { STARTER_TUNES } from "../../src/tunes/starter.js";

describe("parseMml", () => {
  it("reads notes, octaves, lengths, dots and rests", () => {
    const { events, beats, errors } = parseMml("o4 l8 c d4 e. r > c+ < b-16");
    expect(errors).toEqual([]);
    expect(events.map((e) => e.midi)).toEqual([60, 62, 64, 73, 70]);
    expect(events.map((e) => e.beats)).toEqual([0.5, 1, 0.75, 0.5, 0.25]);
    expect(events[3].beat).toBe(0.5 + 1 + 0.75 + 0.5);
    expect(beats).toBe(3.5);
  });

  it("ties notes and repeats brackets", () => {
    const tied = parseMml("c4&c4 d");
    expect(tied.events).toHaveLength(2);
    expect(tied.events[0].beats).toBe(2);
    const rep = parseMml("[c d [e]2 ]3 f");
    expect(rep.events.map((e) => e.midi)).toEqual([60, 62, 64, 64, 60, 62, 64, 64, 60, 62, 64, 64, 65]);
  });

  it("switches waves and volume, and reports errors with positions", () => {
    const { events, errors } = parseMml("@noise v8 c @bogus x t120 [c");
    expect(events[0].wave).toBe("noise");
    expect(events[0].vol).toBeCloseTo(8 / 15);
    expect(errors.map((e) => e.at)).toEqual([12, 19, 21, 26]);
    expect(errors[0].message).toMatch(/unknown wave/);
    expect(errors[2].message).toMatch(/tempo/);
  });

  it("ignores comments and bar lines", () => {
    const { events, errors } = parseMml("c ; a comment with notes a b\n| d");
    expect(errors).toEqual([]);
    expect(events.map((e) => e.midi)).toEqual([60, 62]);
  });

  it("stops runaway repeats", () => {
    const { errors } = parseMml("[[[[[c]64]64]64]64]64");
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("rendering", () => {
  it("renders every starter tune without errors, audibly and within range", () => {
    for (const song of STARTER_TUNES) {
      const compiled = compileSong(song);
      expect(compiled.channels.flatMap((c) => c.errors), song.title).toEqual([]);
      const { samples, seconds } = renderSong(song, { sampleRate: 8000 });
      expect(seconds).toBeGreaterThan(1);
      let peak = 0;
      for (const s of samples) peak = Math.max(peak, Math.abs(s));
      expect(peak, song.title).toBeGreaterThan(0.1);
      expect(peak).toBeLessThanOrEqual(1);
    }
  });

  it("keeps channels of a looping tune the same length", () => {
    for (const song of STARTER_TUNES.filter((s) => s.loop)) {
      const lengths = compileSong(song).channels.map((c) => c.beats);
      expect(new Set(lengths).size, `${song.title}: ${lengths}`).toBe(1);
    }
  });

  it("renders every sound effect preset", () => {
    for (const name of Object.keys(SFX_PRESETS)) {
      const s = renderSfx(name, 8000);
      expect(s.length, name).toBeGreaterThan(10);
      expect(s.some((v) => Math.abs(v) > 0.01), name).toBe(true);
    }
    expect(() => renderSfx("nope")).toThrow(/Unknown sound/);
  });

  it("maps BBC SOUND pitches (53 is middle C)", () => {
    expect(bbcSound(1, -15, 53, 10).hz).toBeCloseTo(261.63, 1);
    expect(bbcSound(1, -15, 101, 10).hz).toBeCloseTo(523.25, 0);
    expect(bbcSound(0, -10, 6, 5).wave).toBe("noise");
    expect(bbcSound(0, -10, 1, 5).wave).toBe("periodic");
    expect(midiToHz(69)).toBe(440);
  });
});

describe("encoders", () => {
  it("writes a valid WAV header", () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -1, 1]), 22050);
    const v = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE");
    expect(v.getUint32(24, true)).toBe(22050);
    expect(v.getUint32(40, true)).toBe(8);
    expect(v.getInt16(48, true)).toBe(-32767);
  });

  it("writes a type-1 MIDI file with a track per channel", () => {
    const song = STARTER_TUNES[1];
    const mid = encodeMidi(song);
    expect(new TextDecoder().decode(mid.slice(0, 4))).toBe("MThd");
    const v = new DataView(mid.buffer);
    expect(v.getUint16(8)).toBe(1);
    expect(v.getUint16(10)).toBe(1 + song.channels.length);
    // Walk the chunks: every one is an MTrk whose length fits.
    let at = 14, tracks = 0;
    while (at < mid.length) {
      expect(new TextDecoder().decode(mid.slice(at, at + 4))).toBe("MTrk");
      at += 8 + v.getUint32(at + 4);
      tracks++;
    }
    expect(at).toBe(mid.length);
    expect(tracks).toBe(1 + song.channels.length);
    // The drum channel's notes go to MIDI channel 10 (status 0x99).
    expect([...mid].some((b, i) => b === 0x99 && mid[i + 1] === 42 || b === 0x99 && mid[i + 1] === 36)).toBe(true);
  });
});
