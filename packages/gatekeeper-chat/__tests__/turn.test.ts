// ICE servers handed to a participant (src/do/turn.ts): port-53 URLs dropped, and the minted list cut
// to STUN plus one TURN each over UDP 3478, TCP 3478 and TLS 443 -- short enough that Firefox does not
// warn, and still reachable behind a UDP-blocking or HTTPS-only firewall.
//
// Fake credentials are built at runtime so no secret-shaped literal sits in the repository.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RealtimeConfig } from "../src/do/sfu.js";
import { STUN_ONLY, iceServersFor, normaliseIceServers, selectIceUrls } from "../src/do/turn.js";

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

function turnWarnings(spy: { mock: { calls: unknown[][] } }): unknown[] {
  return spy.mock.calls
    .map((args) => String(args[0]))
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line["evt"] === "chat.call.turn_warning");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("iceServersFor", () => {
  it("keeps STUN and one TURN each over UDP 3478, TCP 3478 and TLS 443 from the live response", async () => {
    const spy = vi.spyOn(console, "log");
    const servers = await iceServersFor(config(LIVE_SHAPE));
    expect(servers).toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
      {
        urls: [
          "turn:turn.cloudflare.com:3478?transport=udp",
          "turn:turn.cloudflare.com:3478?transport=tcp",
          "turns:turn.cloudflare.com:443?transport=tcp",
        ],
        username: USER,
        credential: CRED,
      },
    ]);
    // Under five URLs in all, which is where Firefox starts to warn.
    expect(servers.flatMap((server) => server.urls).length).toBeLessThan(5);
    expect(turnWarnings(spy)).toEqual([]);
  });

  it("never synthesises a URL, and warns when TLS on 443 is missing", async () => {
    const spy = vi.spyOn(console, "log");
    const servers = await iceServersFor(
      config({
        iceServers: [{ urls: "turn:turn.cloudflare.com:3478?transport=udp", username: USER, credential: CRED }],
      }),
    );
    expect(servers).toEqual([
      { urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: USER, credential: CRED },
    ]);
    expect(turnWarnings(spy)).toEqual([expect.objectContaining({ missing: "turns_443" })]);
  });

  it("falls back to STUN alone when minting fails", async () => {
    expect(await iceServersFor(config({ errors: [] }, 401))).toBe(STUN_ONLY);
  });
});

describe("selectIceUrls", () => {
  it("reads default transports and takes each slot once across entries", () => {
    const input = normaliseIceServers({
      iceServers: [
        { urls: ["stun:stun.cloudflare.com:3478"] },
        { urls: ["turn:a.example.com:3478", "turns:a.example.com:443"], username: USER, credential: CRED },
        { urls: ["turn:b.example.com:3478?transport=udp", "turn:b.example.com:3478?transport=tcp"], username: USER, credential: CRED },
      ],
    });
    expect(selectIceUrls(input)).toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
      { urls: ["turn:a.example.com:3478", "turns:a.example.com:443"], username: USER, credential: CRED },
      { urls: ["turn:b.example.com:3478?transport=tcp"], username: USER, credential: CRED },
    ]);
  });

  it("keeps an entry whole when none of its TURN URLs fills a slot", () => {
    const input = normaliseIceServers({
      iceServers: [{ urls: ["turn:turn.example.com:5000?transport=udp"], username: USER, credential: CRED }],
    });
    expect(selectIceUrls(input)).toEqual(input);
  });
});
