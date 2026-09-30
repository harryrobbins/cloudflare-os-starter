// ICE servers handed to a participant (src/do/turn.ts): port-53 URLs dropped, and TURN over TCP and
// TLS on 443 always present, so people behind a UDP-blocking or HTTPS-only firewall still connect.
//
// Fake credentials are built at runtime so no secret-shaped literal sits in the repository.
import { describe, expect, it } from "vitest";

import type { RealtimeConfig } from "../src/do/sfu.js";
import {
  STUN_ONLY,
  TURN_TCP,
  TURN_TLS_443,
  iceServersFor,
  normaliseIceServers,
  withFirewallFallbacks,
} from "../src/do/turn.js";

const USER = ["u", "ser"].join("");
const CRED = ["cr", "ed"].join("");

/** The shape `generate-ice-servers` answered with on 2026-09-30 (credentials replaced). */
const LIVE_SHAPE = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
    {
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
        "turns:turn.cloudflare.com:5349?transport=tcp",
        "turn:turn.cloudflare.com:443?transport=udp",
        "turn:turn.cloudflare.com:53?transport=udp",
        "turn:turn.cloudflare.com:80?transport=tcp",
        "turns:turn.cloudflare.com:443?transport=tcp",
      ],
      username: USER,
      credential: CRED,
    },
  ],
};

function config(body: unknown, status = 201): RealtimeConfig {
  return {
    sfuAppId: "0a".repeat(16),
    sfuAppSecret: ["s", "e", "c"].join(""),
    turnKeyId: "7c".repeat(16),
    turnKeyApiToken: ["t", "o", "k"].join(""),
    fetch: (async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch,
  };
}

describe("iceServersFor", () => {
  it("keeps TCP and TLS-on-443 TURN from the live response and drops port 53", async () => {
    const servers = await iceServersFor(config(LIVE_SHAPE));
    const all = servers.flatMap((server) => server.urls);
    expect(all).toContain(TURN_TLS_443);
    expect(all).toContain(TURN_TCP);
    expect(all.some((url) => /:53(?:[?/]|$)/u.test(url))).toBe(false);
    // No duplicates were added to a list that already had both.
    expect(servers[1]!.urls).toHaveLength(6);
    expect(servers[1]).toMatchObject({ username: USER, credential: CRED });
  });

  it("adds the firewall fallbacks when the TURN entry offers UDP only", async () => {
    const servers = await iceServersFor(
      config({
        iceServers: [{ urls: "turn:turn.cloudflare.com:3478?transport=udp", username: USER, credential: CRED }],
      }),
    );
    expect(servers).toEqual([
      {
        urls: ["turn:turn.cloudflare.com:3478?transport=udp", TURN_TCP, TURN_TLS_443],
        username: USER,
        credential: CRED,
      },
    ]);
  });

  it("falls back to STUN alone when minting fails", async () => {
    expect(await iceServersFor(config({ errors: [] }, 401))).toBe(STUN_ONLY);
  });
});

describe("withFirewallFallbacks", () => {
  it("leaves STUN, uncredentialed and other hosts alone", () => {
    const input = normaliseIceServers({
      iceServers: [
        { urls: ["stun:stun.cloudflare.com:3478"] },
        { urls: ["turn:turn.cloudflare.com:3478?transport=udp"] },
        { urls: ["turn:turn.example.com:3478"], username: USER, credential: CRED },
      ],
    });
    expect(withFirewallFallbacks(input)).toEqual(input);
  });
});
