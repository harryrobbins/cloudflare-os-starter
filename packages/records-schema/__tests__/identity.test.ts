// Migration 0007: the delegated-token replay guard. The app role claims through one function and
// cannot touch the table; the publisher prunes; a claim is single use until it expires.

import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";

import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

const quiet = { onnotice: () => {} } as const;

let db: TestDatabase;
let owner: Sql;
let app: Sql;
let publisher: Sql;

beforeAll(async () => {
  db = await createTestDatabase(inject("pgSuperuserUrl"));
  owner = postgres(db.ownerUrl, { max: 1, ...quiet });
  app = postgres(db.appUrl, { max: 2, ...quiet });
  publisher = postgres(db.publisherUrl, { max: 1, ...quiet });
});

afterAll(async () => {
  await Promise.all([owner?.end(), app?.end(), publisher?.end()]);
});

const jti = () => crypto.randomUUID().replaceAll("-", "").slice(0, 22);
const claim = async (sql: Sql, id: string, expiresAt: string) =>
  ((await sql`SELECT records.claim_delegated_token(${id}, ${expiresAt}::timestamptz) AS claimed`)[0] as { claimed: boolean }).claimed;

describe("delegated token replay guard (0007)", () => {
  it("claims an id once; a replay is refused while it is live", async () => {
    const id = jti();
    expect(await claim(app, id, new Date(Date.now() + 60_000).toISOString())).toBe(true);
    expect(await claim(app, id, new Date(Date.now() + 60_000).toISOString())).toBe(false);
  });

  it("reclaims an id whose earlier claim has expired", async () => {
    const id = jti();
    await owner`INSERT INTO records.delegated_token_uses (jti, expires_at) VALUES (${id}, now() - interval '1 second')`;
    expect(await claim(app, id, new Date(Date.now() + 60_000).toISOString())).toBe(true);
  });

  it("refuses malformed claims and far-future expiries", async () => {
    await expect(claim(app, "short", new Date(Date.now() + 60_000).toISOString())).rejects.toThrow(/invalid delegated token claim/);
    await expect(claim(app, jti(), new Date(Date.now() + 3600_000).toISOString())).rejects.toThrow(/invalid delegated token claim/);
  });

  it("the app role cannot read or write the table, and cannot prune", async () => {
    await expect(app`SELECT * FROM records.delegated_token_uses`).rejects.toThrow(/permission denied/);
    await expect(app`INSERT INTO records.delegated_token_uses (jti, expires_at) VALUES (${jti()}, now())`).rejects.toThrow(/permission denied/);
    await expect(app`SELECT records.prune_delegated_token_uses()`).rejects.toThrow(/permission denied/);
    await expect(publisher`SELECT records.claim_delegated_token(${jti()}, now())`).rejects.toThrow(/permission denied/);
  });

  it("the publisher prunes claims that expired more than five minutes ago", async () => {
    const old = jti();
    const recent = jti();
    await owner`INSERT INTO records.delegated_token_uses (jti, expires_at) VALUES (${old}, now() - interval '10 minutes'), (${recent}, now() - interval '1 minute')`;
    const [{ pruned }] = (await publisher`SELECT records.prune_delegated_token_uses() AS pruned`) as unknown as [{ pruned: number }];
    expect(pruned).toBeGreaterThanOrEqual(1);
    const left = await owner`SELECT jti FROM records.delegated_token_uses WHERE jti IN (${old}, ${recent})`;
    expect(left.map((r) => r.jti)).toEqual([recent]);
  });
});
