// ICE servers for one participant: short-lived Cloudflare TURN credentials, or STUN alone.
//
// The TURN key's API token stays in the object; what a participant receives is a credential minted
// for them with a TTL of {@link CALL_TURN_TTL_SECONDS}, returned only in their own join or reconnect
// response (docs/research/chat-video-sfu.md, "TURN").
//
// The rules, from the research note and the real SFU runs:
//   * **Drop every port-53 URL.** Browsers block it, and a gather waits for its timeout.
//   * **A short list: STUN plus one TURN each over UDP 3478, TCP 3478 and TLS 443.** Networks that
//     block UDP (and often every port but 443) can only reach TURN over TCP, ideally TLS on 443,
//     which also passes proxies that only allow HTTPS-shaped traffic. Everything else Cloudflare
//     offers (5349, UDP 443, TCP 80) adds gathering time, and five or more URLs make Firefox warn.
//     The URLs are chosen from what the API returned -- never synthesised, since a URL is only useful
//     with the credential minted for it -- and a list without TLS on 443 is logged as a warning.
//   * **TURN is an improvement, not a requirement.** Without a TURN key, or when minting fails, the
//     participant gets Cloudflare's public STUN server: most networks connect with it, and a join
//     that fails outright because TURN was briefly down would be worse than one that might not
//     traverse a strict firewall. A mint failure is logged so it is not silent.

import { CALL_TURN_TTL_SECONDS, type CallIceServer } from "../shared/protocol.js";
import { logEvent } from "./logs.js";
import { realtimeFetch, type RealtimeConfig } from "./sfu.js";

const TURN_BASE = "https://rtc.live.cloudflare.com/v1/turn/keys";
const TURN_TIMEOUT_MS = 10_000;

/** What a participant gets when there is no TURN key, or minting failed. */
export const STUN_ONLY: readonly CallIceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478"] }];

export async function iceServersFor(config: RealtimeConfig): Promise<readonly CallIceServer[]> {
  if (config.turnKeyId === null || config.turnKeyApiToken === null) return STUN_ONLY;
  const started = Date.now();
  const sent = await realtimeFetch(
    config,
    `${TURN_BASE}/${encodeURIComponent(config.turnKeyId)}/credentials/generate-ice-servers`,
    { method: "POST", token: config.turnKeyApiToken, body: { ttl: CALL_TURN_TTL_SECONDS }, timeoutMs: TURN_TIMEOUT_MS },
  );
  if (sent.response === null) {
    logEvent("chat.call.turn", { outcome: sent.code, ms: Date.now() - started });
    return STUN_ONLY;
  }
  if (!sent.response.ok) {
    logEvent("chat.call.turn", { outcome: `http_${sent.response.status}`, ms: Date.now() - started });
    return STUN_ONLY;
  }
  let body: unknown;
  try {
    body = await sent.response.json();
  } catch {
    body = null;
  }
  const servers = selectIceUrls(normaliseIceServers(body));
  logEvent("chat.call.turn", { outcome: servers.length > 0 ? "ok" : "empty", ms: Date.now() - started });
  if (servers.length === 0) return STUN_ONLY;
  if (!servers.some((server) => server.urls.some((url) => slotOf(url) === "tls443"))) {
    logEvent("chat.call.turn_warning", { missing: "turns_443" });
  }
  return servers;
}

/**
 * The TURN API's `iceServers`, narrowed: `urls` may be a string or a list, port-53 URLs are removed,
 * and an entry left with no URL is dropped.
 */
export function normaliseIceServers(body: unknown): readonly CallIceServer[] {
  if (typeof body !== "object" || body === null) return [];
  const list = (body as { iceServers?: unknown }).iceServers;
  if (!Array.isArray(list)) return [];
  const out: CallIceServer[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const { urls, username, credential } = entry as { urls?: unknown; username?: unknown; credential?: unknown };
    const raw = typeof urls === "string" ? [urls] : Array.isArray(urls) ? urls : [];
    const kept = raw.filter((url): url is string => typeof url === "string" && !usesPort53(url));
    if (kept.length === 0) continue;
    out.push({
      urls: kept,
      ...(typeof username === "string" ? { username } : {}),
      ...(typeof credential === "string" ? { credential } : {}),
    });
  }
  return out;
}

/** `turn:host:53?transport=udp`, `stun:host:53` and the like. */
function usesPort53(url: string): boolean {
  return /:53(?:[?/]|$)/u.test(url);
}

/** The TURN URLs a participant is offered, at most one each. */
type TurnSlot = "udp3478" | "tcp3478" | "tls443";

/**
 * Which slot a `turn:`/`turns:` URL fills, or null. A `turn:` URL without `transport` is UDP and a
 * `turns:` one is TCP (RFC 7065).
 */
function slotOf(url: string): TurnSlot | null {
  const match = /^(turns?):[^:?]+:(\d+)(?:\?transport=(udp|tcp))?$/u.exec(url);
  if (match === null) return null;
  const [, scheme, port, transport] = match;
  if (scheme === "turns") return port === "443" && (transport ?? "tcp") === "tcp" ? "tls443" : null;
  if (port !== "3478") return null;
  return (transport ?? "udp") === "udp" ? "udp3478" : "tcp3478";
}

/**
 * Trims each entry's TURN URLs to the first of each {@link TurnSlot}, across the whole list. STUN
 * URLs are kept. An entry whose TURN URLs fill no slot keeps them all -- an unfamiliar shape is
 * better offered whole than dropped -- and an entry left with no URL is dropped.
 */
export function selectIceUrls(servers: readonly CallIceServer[]): readonly CallIceServer[] {
  const taken = new Set<TurnSlot>();
  const out: CallIceServer[] = [];
  for (const server of servers) {
    const turn = server.urls.filter((url) => /^turns?:/u.test(url));
    const fillsSlot = turn.some((url) => slotOf(url) !== null);
    const urls = server.urls.filter((url) => {
      if (!/^turns?:/u.test(url) || !fillsSlot) return true;
      const slot = slotOf(url);
      if (slot === null || taken.has(slot)) return false;
      taken.add(slot);
      return true;
    });
    if (urls.length > 0) out.push({ ...server, urls });
  }
  return out;
}
