import { describe, expect, it } from "vitest";
import { parseAuthorization } from "../src/index.js";

const RK1 = `rk1_${"0123456789abcdef".repeat(2)}_${"A".repeat(43)}`;
const JWT = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln";
const h = (init: Record<string, string>) => new Headers(init);
const basic = (s: string) => `Basic ${btoa(s)}`;

describe("parseAuthorization", () => {
  it("classifies bearer JWTs and rk1 credentials", () => {
    expect(parseAuthorization(h({ authorization: `Bearer ${JWT}` }))).toEqual({ type: "jwt", token: JWT });
    expect(parseAuthorization(h({ authorization: `bearer ${RK1}` }))).toEqual({ type: "credential", token: RK1 });
    expect(parseAuthorization(h({ authorization: `BEARER   ${RK1}` }))).toEqual({ type: "credential", token: RK1 });
  });

  it("parses Basic email:rk1 and rejects Basic with any other password", () => {
    expect(parseAuthorization(h({ authorization: basic(`ada@example.test:${RK1}`) }))).toEqual({ type: "basic", email: "ada@example.test", token: RK1 });
    expect(parseAuthorization(h({ authorization: basic("ada@example.test:hunter2") }))).toEqual({ type: "invalid", reason: "basic_not_credential" });
    expect(parseAuthorization(h({ authorization: basic(`:${RK1}`) }))).toEqual({ type: "invalid", reason: "bad_basic_user" });
    expect(parseAuthorization(h({ authorization: basic("no-colon") }))).toEqual({ type: "invalid", reason: "bad_basic_user" });
    expect(parseAuthorization(h({ authorization: basic(`a b@x:${RK1}`) }))).toEqual({ type: "invalid", reason: "bad_basic_user" });
    expect(parseAuthorization(h({ authorization: basic(`${"a".repeat(321)}:${RK1}`) }))).toEqual({ type: "invalid", reason: "bad_basic_user" });
  });

  it("treats bad base64 and non-UTF-8 as invalid, never throwing", () => {
    expect(parseAuthorization(h({ authorization: "Basic !!!!" }))).toEqual({ type: "invalid", reason: "bad_basic_encoding" });
    expect(parseAuthorization(h({ authorization: "Basic abc" }))).toEqual({ type: "invalid", reason: "bad_basic_encoding" });
    expect(parseAuthorization(h({ authorization: `Basic ${btoa("\xff\xfe:x")}` }))).toEqual({ type: "invalid", reason: "bad_basic_encoding" });
  });

  it("rejects unknown schemes, extra fields, junk bearer values and oversize headers", () => {
    expect(parseAuthorization(h({ authorization: "Digest foo" }))).toEqual({ type: "invalid", reason: "unknown_scheme" });
    expect(parseAuthorization(h({ authorization: "Bearer" }))).toEqual({ type: "invalid", reason: "unknown_scheme" });
    expect(parseAuthorization(h({ authorization: `Bearer ${JWT} extra` }))).toEqual({ type: "invalid", reason: "unknown_scheme" });
    expect(parseAuthorization(h({ authorization: "Bearer rk1_short" }))).toEqual({ type: "invalid", reason: "bad_bearer" });
    expect(parseAuthorization(h({ authorization: "Bearer not-a-token" }))).toEqual({ type: "invalid", reason: "bad_bearer" });
    expect(parseAuthorization(h({ authorization: `Bearer ${"a".repeat(9000)}` }))).toEqual({ type: "invalid", reason: "too_long" });
  });

  it("uses the Access assertion only when there is no Authorization header", () => {
    expect(parseAuthorization(h({ "cf-access-jwt-assertion": JWT }))).toEqual({ type: "access", token: JWT });
    expect(parseAuthorization(h({ "cf-access-jwt-assertion": JWT, authorization: `Bearer ${RK1}` }))).toEqual({ type: "credential", token: RK1 });
    expect(parseAuthorization(h({ "cf-access-jwt-assertion": JWT, authorization: "Bearer junk" }))).toEqual({ type: "invalid", reason: "bad_bearer" });
    expect(parseAuthorization(h({ "cf-access-jwt-assertion": "garbage" }))).toEqual({ type: "invalid", reason: "bad_access_assertion" });
  });

  it("returns none when there is no credential", () => {
    expect(parseAuthorization(h({}))).toEqual({ type: "none" });
    expect(parseAuthorization(h({ authorization: "  " }))).toEqual({ type: "none" });
  });

  it("does not throw when the header source throws", () => {
    expect(parseAuthorization({ get: () => { throw new Error("boom"); } }).type).toBe("invalid");
  });
});
