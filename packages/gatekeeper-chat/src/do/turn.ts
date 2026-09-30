// ICE servers for one participant: short-lived Cloudflare TURN credentials, or STUN alone.
//
// The TURN key's API token stays in the object; what a participant receives is a credential minted
// for them with a TTL of {@link CALL_TURN_TTL_SECONDS}, returned only in their own join or reconnect
// response (docs/research/chat-video-sfu.md, "TURN").
//
// Two rules from the research note:
//   * **Drop every port-53 URL.** Browsers block it, and a gather waits for its timeout.
//   * **Keep the firewall fallbacks.** Networks that block UDP (and often every port but 443) can only
//     reach TURN over TCP, ideally TLS on 443, which also passes proxies that only allow HTTPS-shaped
//     traffic. Cloudflare's list includes both today; `withFirewallFallbacks` guarantees them for
//     each credentialed TURN entry in case the list ever changes shape.
//   * **TURN is an improvement, not a requirement.** Without a TURN key, or when minting fails, the
//     participant gets Cloudflare's public STUN server: most networks connect with it, and a join
//     that fails outright because TURN was briefly down would be worse than one that might not
//     traverse a strict firewall. A mint failure is logged so it is not silent.

import { CALL_TURN_TTL_SECONDS, type CallIceServer } from "../shared/protocol.js";
import { logEvent } from "./logs.js";
import type { RealtimeConfig } from "./sfu.js";

const TURN_BASE = "https://rtc.live.cloudflare.com/v1/turn/keys";
const TURN_TIMEOUT_MS = 10_000;

/** What a participant gets when there is no TURN key, or minting failed. */
export const STUN_ONLY: readonly CallIceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478"] }];

export async function iceServersFor(config: RealtimeConfig): Promise<readonly CallIceServer[]> {
  if (config.turnKeyId === null || config.turnKeyApiToken === null) return STUN_ONLY;
  const started = Date.now();
  try {
    const response = await config.fetch(
      `${TURN_BASE}/${encodeURIComponent(config.turnKeyId)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${config.turnKeyApiToken}`, "content-type": "application/json" },
        body: JSON.stringify({ ttl: CALL_TURN_TTL_SECONDS }),
        signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      logEvent("chat.call.turn", { outcome: `http_${response.status}`, ms: Date.now() - started });
      return STUN_ONLY;
    }
    const servers = withFirewallFallbacks(normaliseIceServers(await response.json()));
    logEvent("chat.call.turn", { outcome: servers.length > 0 ? "ok" : "empty", ms: Date.now() - started });
    return servers.length > 0 ? servers : STUN_ONLY;
  } catch {
    logEvent("chat.call.turn", { outcome: "network", ms: Date.now() - started });
    return STUN_ONLY;
  }
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

/** TLS on 443 passes firewalls and proxies that allow only HTTPS; plain TCP passes those that block UDP. */
export const TURN_TLS_443 = "turns:turn.cloudflare.com:443?transport=tcp";
export const TURN_TCP = "turn:turn.cloudflare.com:3478?transport=tcp";

/**
 * Every credentialed entry with a `turn:`/`turns:` URL on Cloudflare's TURN host also carries
 * {@link TURN_TLS_443} and {@link TURN_TCP}, appended when missing. Entries for other hosts, STUN
 * entries and entries without credentials are left alone: a URL is only useful with the credential
 * minted for that host.
 */
export function withFirewallFallbacks(servers: readonly CallIceServer[]): readonly CallIceServer[] {
  return servers.map((server) => {
    const credentialed = server.username !== undefined && server.credential !== undefined;
    const onCloudflareTurn = server.urls.some((url) => /^turns?:turn\.cloudflare\.com[:?]/u.test(url));
    if (!credentialed || !onCloudflareTurn) return server;
    const missing = [TURN_TCP, TURN_TLS_443].filter((url) => !server.urls.includes(url));
    return missing.length === 0 ? server : { ...server, urls: [...server.urls, ...missing] };
  });
}
