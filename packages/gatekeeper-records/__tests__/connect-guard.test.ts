import { describe, expect, it } from "vitest";

import { checkConnectRequest, CONNECT_PAGE_HEADERS } from "../src/connect-guard.ts";

const URL_ = "https://cfos.example.test/gatekeeper/records/connect?flow=a&nonce=b";
const req = (method: string, headers: Record<string, string>) => new Request(URL_, { method, headers });

describe("connect page guard", () => {
  it("accepts the Workshop-opened page and its own confirmation POST", () => {
    expect(checkConnectRequest(req("GET", { "sec-fetch-site": "same-origin" }))).toEqual({ ok: true });
    expect(checkConnectRequest(req("POST", { "sec-fetch-site": "same-origin", origin: "https://cfos.example.test" }))).toEqual({ ok: true });
  });

  it("refuses links opened from elsewhere, foreign or null origins, and other methods", () => {
    expect(checkConnectRequest(req("GET", { "sec-fetch-site": "cross-site" }))).toMatchObject({ ok: false, reason: "cross-site" });
    expect(checkConnectRequest(req("GET", { "sec-fetch-site": "none" }))).toMatchObject({ ok: false, reason: "cross-site" });
    expect(checkConnectRequest(req("GET", {}))).toMatchObject({ ok: false, reason: "cross-site" });
    expect(checkConnectRequest(req("POST", { "sec-fetch-site": "same-origin", origin: "https://evil.test" }))).toMatchObject({ ok: false, reason: "origin" });
    expect(checkConnectRequest(req("POST", { "sec-fetch-site": "same-origin", origin: "null" }))).toMatchObject({ ok: false, reason: "origin" });
    expect(checkConnectRequest(req("PUT", { "sec-fetch-site": "same-origin" }))).toMatchObject({ ok: false, status: 405 });
  });

  it("does not use no-referrer, which makes browsers send Origin: null on the confirmation POST", () => {
    // Regression: with no-referrer every real confirmation failed with "Confirmation must come from this site."
    expect(CONNECT_PAGE_HEADERS["referrer-policy"]).toBe("same-origin");
  });
});
