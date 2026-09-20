// The shared contract: URL building and matching, and the inbound validators. Pure functions, but
// still run inside workerd so the encoder and crypto they use are the ones production has.
import { describe, expect, it } from "vitest";

import { adminEmails, maxUploadBytes } from "../src/env.js";
import {
  MAX_BODY_BYTES,
  MAX_SUBSCRIPTIONS,
  MAX_UPLOAD_BYTES,
  PROTOCOL_VERSION,
} from "../src/shared/protocol.js";
import {
  API_PREFIX,
  API_ROUTES,
  apiPath,
  buildPath,
  filePath,
  isWorkerPath,
  matchApiRoute,
  matchPath,
  permalink,
  WS_PATH,
} from "../src/shared/routes.js";
import {
  parseClientEvent,
  parseCreateChannel,
  parseEditMessage,
  parseEmoji,
  parseListMessagesQuery,
  parseMarkRead,
  parsePushSubscribe,
  parseSendMessage,
  parseUpdateChannel,
  parseUpdateMe,
} from "../src/shared/validate.js";

describe("routes", () => {
  it("mounts everything under the prefix the router forwards", () => {
    expect(API_PREFIX).toBe("/gatekeeper/chat/api");
    expect(WS_PATH).toBe("/gatekeeper/chat/ws");
    expect(apiPath("me")).toBe("/gatekeeper/chat/api/me");
    expect(filePath("att1", true)).toBe("/gatekeeper/chat/files/att1/thumb");
    expect(permalink("general", "m1")).toBe("/gatekeeper/chat/c/general/m/m1");
  });

  it("captures and decodes parameters", () => {
    expect(matchPath("/channels/:channelId/messages", "/channels/general/messages")).toEqual({
      channelId: "general",
    });
    expect(matchPath("/messages/:messageId/reactions/:emoji", "/messages/m1/reactions/%F0%9F%91%8D")).toEqual({
      messageId: "m1",
      emoji: "\u{1F44D}",
    });
    expect(matchPath("/channels/:channelId", "/channels")).toBeNull();
    expect(matchPath("/channels/:channelId", "/channels/a/b")).toBeNull();
  });

  it("round-trips an emoji reaction through the URL", () => {
    const path = apiPath("addReaction", { messageId: "m1", emoji: "\u{1F44D}" });
    const match = matchApiRoute("PUT", path);
    expect(match).toEqual({ name: "addReaction", params: { messageId: "m1", emoji: "\u{1F44D}" } });
  });

  it("refuses to build a path with a missing parameter", () => {
    expect(() => buildPath("/channels/:channelId", {})).toThrow(/channelId/);
  });

  it("resolves every route in the table", () => {
    for (const [name, route] of Object.entries(API_ROUTES)) {
      const params = Object.fromEntries(
        route.path
          .split("/")
          .filter((segment) => segment.startsWith(":"))
          .map((segment) => [segment.slice(1), "x1"]),
      );
      const match = matchApiRoute(route.method, API_PREFIX + buildPath(route.path, params));
      expect(match, name).toMatchObject({ name });
    }
  });

  it("reports a method mismatch separately from an unknown route", () => {
    expect(matchApiRoute("DELETE", apiPath("me"))).toEqual({ methodMismatch: ["GET", "PATCH"] });
    expect(matchApiRoute("GET", `${API_PREFIX}/nope`)).toBeNull();
    expect(matchApiRoute("GET", "/elsewhere")).toBeNull();
  });

  it("knows which paths the Worker must handle itself", () => {
    expect(isWorkerPath(WS_PATH)).toBe(true);
    expect(isWorkerPath(apiPath("me"))).toBe(true);
    expect(isWorkerPath(filePath("a1"))).toBe(true);
    expect(isWorkerPath("/gatekeeper/chat/")).toBe(false);
    expect(isWorkerPath("/gatekeeper/chat/assets/index.js")).toBe(false);
    // A path that merely starts with the same letters is not an API path.
    expect(isWorkerPath("/gatekeeper/chat/apiary")).toBe(false);
  });
});

describe("validators: messages", () => {
  it("accepts a well-formed send", () => {
    const result = parseSendMessage({ body: "hello  \n", clientId: "c1", rootId: "m1" });
    expect(result).toEqual({ ok: true, value: { body: "hello", clientId: "c1", rootId: "m1" } });
  });

  it("requires a clientId so a retry can be deduplicated", () => {
    expect(parseSendMessage({ body: "hi" })).toMatchObject({ ok: false });
    expect(parseSendMessage({ body: "hi", clientId: "not an id" })).toMatchObject({ ok: false });
  });

  it("counts the body in UTF-8 bytes, not UTF-16 units", () => {
    // Four bytes per emoji: a cap checked with .length would let this through.
    const emoji = "\u{1F600}".repeat(MAX_BODY_BYTES / 4);
    expect(parseSendMessage({ body: emoji, clientId: "c1" })).toMatchObject({ ok: true });
    expect(parseSendMessage({ body: emoji + "\u{1F600}", clientId: "c1" })).toMatchObject({ ok: false });
  });

  it("allows an empty body only when an attachment carries the message", () => {
    expect(parseSendMessage({ body: "", clientId: "c1" })).toMatchObject({ ok: false });
    expect(parseSendMessage({ body: "", clientId: "c1", attachmentIds: ["a1"] })).toMatchObject({ ok: true });
  });

  it("deduplicates attachment ids and rejects rubbish ones", () => {
    expect(parseSendMessage({ body: "x", clientId: "c1", attachmentIds: ["a1", "a1"] })).toEqual({
      ok: true,
      value: { body: "x", clientId: "c1", attachmentIds: ["a1"] },
    });
    expect(parseSendMessage({ body: "x", clientId: "c1", attachmentIds: ["../secret"] })).toMatchObject({
      ok: false,
    });
  });

  it("rejects an empty edit", () => {
    expect(parseEditMessage({ body: "   " })).toMatchObject({ ok: false });
    expect(parseEditMessage({ body: "fixed" })).toEqual({ ok: true, value: { body: "fixed" } });
  });

  it("accepts a single emoji token and nothing else", () => {
    expect(parseEmoji("\u{1F44D}")).toMatchObject({ ok: true });
    expect(parseEmoji("thumbs up")).toMatchObject({ ok: false });
    expect(parseEmoji("")).toMatchObject({ ok: false });
  });
});

describe("validators: channels and preferences", () => {
  it("requires a lowercase name for a public channel", () => {
    expect(parseCreateChannel({ kind: "public", name: "design" })).toMatchObject({ ok: true });
    expect(parseCreateChannel({ kind: "public", name: "Design Team" })).toMatchObject({ ok: false });
    expect(parseCreateChannel({ kind: "public" })).toMatchObject({ ok: false });
  });

  it("requires exactly one counterpart for a dm and refuses a name", () => {
    expect(parseCreateChannel({ kind: "dm", memberIds: ["u2"] })).toMatchObject({ ok: true });
    expect(parseCreateChannel({ kind: "dm", memberIds: ["u2", "u3"] })).toMatchObject({ ok: false });
    expect(parseCreateChannel({ kind: "dm", memberIds: ["u2"], name: "chat" })).toMatchObject({ ok: false });
    expect(parseCreateChannel({ kind: "group", memberIds: ["u2"] })).toMatchObject({ ok: false });
  });

  it("rejects an unknown channel kind", () => {
    expect(parseCreateChannel({ kind: "broadcast", name: "x" })).toMatchObject({ ok: false });
  });

  it("lets a topic be cleared but not a name", () => {
    expect(parseUpdateChannel({ topic: null })).toEqual({ ok: true, value: { topic: null } });
    expect(parseUpdateChannel({ name: null })).toMatchObject({ ok: false });
    expect(parseUpdateChannel({})).toMatchObject({ ok: false });
  });

  it("takes exactly one of seq or manualUnreadSeq", () => {
    expect(parseMarkRead({ seq: 12 })).toEqual({ ok: true, value: { seq: 12 } });
    expect(parseMarkRead({ manualUnreadSeq: null })).toEqual({ ok: true, value: { manualUnreadSeq: null } });
    expect(parseMarkRead({ seq: 12, manualUnreadSeq: 3 })).toMatchObject({ ok: false });
    expect(parseMarkRead({})).toMatchObject({ ok: false });
    expect(parseMarkRead({ seq: -1 })).toMatchObject({ ok: false });
  });

  it("validates a preference update", () => {
    expect(parseUpdateMe({ notify: "mentions" })).toEqual({ ok: true, value: { notify: "mentions" } });
    expect(parseUpdateMe({ notify: "sometimes" })).toMatchObject({ ok: false });
    expect(parseUpdateMe({ displayName: null })).toEqual({ ok: true, value: { displayName: null } });
    expect(parseUpdateMe({})).toMatchObject({ ok: false });
  });

  it("requires an https push endpoint", () => {
    expect(parsePushSubscribe({ endpoint: "https://push.example/x", p256dh: "k", auth: "a" })).toMatchObject({
      ok: true,
    });
    expect(parsePushSubscribe({ endpoint: "http://push.example/x", p256dh: "k", auth: "a" })).toMatchObject({
      ok: false,
    });
    expect(parsePushSubscribe({ endpoint: "not a url", p256dh: "k", auth: "a" })).toMatchObject({ ok: false });
  });
});

describe("validators: query strings", () => {
  it("defaults and clamps the page size", () => {
    expect(parseListMessagesQuery(new URLSearchParams())).toMatchObject({ ok: true, value: { limit: 50 } });
    expect(parseListMessagesQuery(new URLSearchParams("limit=1000"))).toMatchObject({
      ok: true,
      value: { limit: 100 },
    });
    expect(parseListMessagesQuery(new URLSearchParams("limit=0"))).toMatchObject({ ok: false });
  });

  it("accepts one cursor at a time", () => {
    expect(parseListMessagesQuery(new URLSearchParams("before=10"))).toMatchObject({
      ok: true,
      value: { before: 10 },
    });
    expect(parseListMessagesQuery(new URLSearchParams("before=10&after=2"))).toMatchObject({ ok: false });
    expect(parseListMessagesQuery(new URLSearchParams("around=m1"))).toMatchObject({
      ok: true,
      value: { around: "m1" },
    });
    expect(parseListMessagesQuery(new URLSearchParams("before=nonsense"))).toMatchObject({ ok: false });
  });
});

describe("validators: WebSocket frames", () => {
  it("accepts each event the protocol defines", () => {
    expect(parseClientEvent('{"t":"sub","channels":["general","general"]}')).toEqual({
      ok: true,
      value: { t: "sub", channels: ["general"] },
    });
    expect(parseClientEvent('{"t":"typing","channel":"general"}')).toMatchObject({ ok: true });
    expect(parseClientEvent('{"t":"read","channel":"general","seq":4}')).toMatchObject({ ok: true });
    expect(parseClientEvent('{"t":"ping"}')).toEqual({ ok: true, value: { t: "ping" } });
  });

  it("rejects anything else without throwing", () => {
    expect(parseClientEvent("")).toMatchObject({ ok: false });
    expect(parseClientEvent("not json")).toMatchObject({ ok: false });
    expect(parseClientEvent("[]")).toMatchObject({ ok: false });
    expect(parseClientEvent('{"t":"nuke"}')).toMatchObject({ ok: false });
    expect(parseClientEvent('{"t":"read","channel":"general"}')).toMatchObject({ ok: false });
    expect(parseClientEvent(new ArrayBuffer(4))).toMatchObject({ ok: false });
  });

  it("bounds the subscription list", () => {
    const channels = Array.from({ length: MAX_SUBSCRIPTIONS + 1 }, (_, i) => `c${i}`);
    expect(parseClientEvent(JSON.stringify({ t: "sub", channels }))).toMatchObject({ ok: false });
  });
});

describe("protocol constants", () => {
  it("pins the version the hello event advertises", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe("env parsing", () => {
  it("normalises the admin list and survives a malformed one", () => {
    expect(adminEmails({ ADMINS: '[" Harry@Example.Test ", ""]' })).toEqual(["harry@example.test"]);
    expect(adminEmails({ ADMINS: "not json" })).toEqual([]);
    expect(adminEmails({ ADMINS: '"a string"' })).toEqual([]);
    expect(adminEmails({ ADMINS: "" })).toEqual([]);
  });

  it("falls back to the contract's upload cap when the var is absent or nonsensical", () => {
    expect(maxUploadBytes({ MAX_UPLOAD_BYTES: 1024 })).toBe(1024);
    expect(maxUploadBytes({})).toBe(MAX_UPLOAD_BYTES);
    expect(maxUploadBytes({ MAX_UPLOAD_BYTES: 0 })).toBe(MAX_UPLOAD_BYTES);
    expect(maxUploadBytes({ MAX_UPLOAD_BYTES: -5 })).toBe(MAX_UPLOAD_BYTES);
  });
});
