// Single-use `jti` enforcement for delegated tokens.
//
// `MemoryReplayGuard` is only correct within one isolate. A Worker runs many isolates, so production
// needs a shared guard: every verifier must see every claim. Suggested Postgres shape (the claim is
// one round trip; an expired row with the same jti is reclaimed rather than refused):
//
//   CREATE TABLE records.delegated_token_uses (
//     jti        text        PRIMARY KEY,
//     expires_at timestamptz NOT NULL
//   );
//   CREATE INDEX ON records.delegated_token_uses (expires_at);
//
//   -- claim(jti, expiresAt): claimed iff a row comes back.
//   INSERT INTO records.delegated_token_uses (jti, expires_at)
//        VALUES ($1, to_timestamp($2))
//   ON CONFLICT (jti) DO UPDATE SET expires_at = EXCLUDED.expires_at
//         WHERE records.delegated_token_uses.expires_at < now()
//   RETURNING jti;
//
//   -- periodic cleanup (cron or opportunistically, e.g. 1 in 100 claims):
//   DELETE FROM records.delegated_token_uses WHERE expires_at < now() - interval '5 minutes';
//
// A Durable Object keyed by jti (or by a jti hash prefix) with an alarm at expiry is an equivalent
// alternative. Either way the guard must fail closed: if the store is unreachable, reject.

/** Records a token id as used. Resolves `true` the first time, `false` for a replay. */
export interface ReplayGuard {
  /** `expiresAt` is the token's `exp` in seconds since the epoch; the entry may be dropped after it. */
  claim(jti: string, expiresAt: number): Promise<boolean>;
}

export type MemoryReplayGuardOptions = {
  /** Upper bound on remembered ids. When full of unexpired ids, claims fail closed. Default 10 000. */
  maxEntries?: number;
  /** Clock in milliseconds, for tests. */
  now?: () => number;
};

/** In-process guard for tests, local development and single-isolate deployments. */
export class MemoryReplayGuard implements ReplayGuard {
  readonly #seen = new Map<string, number>();
  readonly #max: number;
  readonly #now: () => number;

  constructor(options: MemoryReplayGuardOptions = {}) {
    this.#max = Math.max(1, options.maxEntries ?? 10_000);
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#seen.size;
  }

  async claim(jti: string, expiresAt: number): Promise<boolean> {
    const nowSec = this.#now() / 1000;
    // Tokens share one TTL, so insertion order is close to expiry order: trim from the front.
    for (const [key, exp] of this.#seen) {
      if (exp >= nowSec) break;
      this.#seen.delete(key);
    }
    const existing = this.#seen.get(jti);
    if (existing !== undefined && existing >= nowSec) return false;
    if (existing === undefined && this.#seen.size >= this.#max) {
      for (const [key, exp] of this.#seen) if (exp < nowSec) this.#seen.delete(key);
      if (this.#seen.size >= this.#max) return false; // Fail closed rather than forget a live id.
    }
    this.#seen.delete(jti);
    this.#seen.set(jti, expiresAt);
    return true;
  }
}
