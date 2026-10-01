// SDP and codec-preference helpers for resilient audio (chat-video.md, "Quality phase 1"). Pure
// string and array work, no WebRTC calls, so it is tested exhaustively on its own.
//
// Opus `fmtp` parameters describe what the *receiving* side of that description accepts, and Chrome
// configures its Opus encoder from the remote description. The engine therefore applies
// `ensureOpusParams` to every description it sets, local and remote: the local offer (sent to the
// SFU unchanged after munging) asks the SFU for FEC/DTX, and the SFU's answers and offers get the
// same parameters so our own encoder turns FEC and DTX on even when the SFU does not echo them.

/** In-band forward error correction and discontinuous transmission. */
export const OPUS_RESILIENCE: Readonly<Record<string, string>> = Object.freeze({ useinbandfec: "1", usedtx: "1" });

const OPUS_RTPMAP = /^a=rtpmap:(\d+) opus\/48000(?:\/\d+)?\s*$/i;
const FMTP = /^a=fmtp:(\d+) ?(.*)$/;

/**
 * Makes every Opus payload type's `a=fmtp` carry `params` (overwriting a different value, never
 * duplicating a key, keeping every other parameter and its order). A payload type with no fmtp line
 * gets one right after its rtpmap. Works per media section; anything that is not SDP with Opus comes
 * back unchanged.
 */
export function ensureOpusParams(sdp: string, params: Readonly<Record<string, string>> = OPUS_RESILIENCE): string {
  if (!/opus\/48000/i.test(sdp)) return sdp;
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(eol);
  const out: string[] = [];
  let section: string[] = [];
  const flush = (): void => {
    out.push(...mungeSection(section, params));
    section = [];
  };
  for (const line of lines) {
    if (line.startsWith("m=")) flush();
    section.push(line);
  }
  flush();
  return out.join(eol);
}

function mungeSection(lines: readonly string[], params: Readonly<Record<string, string>>): string[] {
  const opus = new Set<string>();
  for (const line of lines) {
    const match = OPUS_RTPMAP.exec(line);
    if (match) opus.add(match[1]!);
  }
  if (opus.size === 0) return [...lines];
  const withFmtp = new Set<string>();
  const merged = lines.map((line) => {
    const match = FMTP.exec(line);
    if (!match || !opus.has(match[1]!)) return line;
    withFmtp.add(match[1]!);
    return `a=fmtp:${match[1]} ${mergeFmtp(match[2] ?? "", params)}`;
  });
  const out: string[] = [];
  for (const line of merged) {
    out.push(line);
    const match = OPUS_RTPMAP.exec(line);
    if (match && !withFmtp.has(match[1]!)) {
      out.push(`a=fmtp:${match[1]} ${mergeFmtp("", params)}`);
      withFmtp.add(match[1]!);
    }
  }
  return out;
}

/** Merges `params` into an fmtp parameter list (`a=1;b=2`). Keys compare case-insensitively. */
export function mergeFmtp(existing: string, params: Readonly<Record<string, string>>): string {
  const entries = existing
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const index = part.indexOf("=");
      return index < 0 ? { key: part, value: null as string | null } : { key: part.slice(0, index).trim(), value: part.slice(index + 1).trim() };
    });
  for (const [key, value] of Object.entries(params)) {
    const found = entries.find((entry) => entry.key.toLowerCase() === key.toLowerCase());
    if (found) found.value = value;
    else entries.push({ key, value });
  }
  return entries.map((entry) => (entry.value === null ? entry.key : `${entry.key}=${entry.value}`)).join(";");
}

/**
 * Codec preferences with RED (RFC 2198 audio redundancy) first, then Opus, then the rest in the
 * browser's order. Null when the browser does not offer `audio/red` (leave the defaults alone).
 */
export function redFirst<T extends { readonly mimeType: string }>(codecs: readonly T[]): T[] | null {
  const kind = (codec: T): string => codec.mimeType.toLowerCase();
  const red = codecs.filter((codec) => kind(codec) === "audio/red");
  if (red.length === 0) return null;
  const opus = codecs.filter((codec) => kind(codec) === "audio/opus");
  const rest = codecs.filter((codec) => kind(codec) !== "audio/red" && kind(codec) !== "audio/opus");
  return [...red, ...opus, ...rest];
}

/** `audio/opus` -> `opus`, `video/VP8` -> `VP8`. Codec names only, for telemetry. */
export function codecName(mimeType: string): string {
  return mimeType.replace(/^(audio|video)\//i, "");
}
