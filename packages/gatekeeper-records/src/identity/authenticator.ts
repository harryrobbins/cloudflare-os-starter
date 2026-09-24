// The service boundary: every credential the datastore service accepts becomes a CallerContext
// here, and nowhere else (canonical plan §5).
//
//   Authorization: Bearer <delegated JWT>   minted by this Worker's gatekeeper (or, once the
//                                           service is split out, by a trusted gatekeeper issuer)
//                                           → the token's principal through its binding, scopes ≤
//                                           the binding's, on the token's datastore only
//   Authorization: Bearer <Access for SaaS> an `access_saas` trusted issuer → the principal mapped
//                                           by records.identity_mappings (issuer, sub); an
//                                           unmapped subject is refused, never provisioned
//   Cf-Access-Jwt-Assertion alone           an `access` trusted issuer (a person or a mapped
//                                           Access service token) → the mapped principal
//   Authorization: Bearer rk1_…             a Records credential → its service principal
//   Authorization: Basic email:rk1_…        the same, where allowed (Jira), and only when the
//                                           e-mail is the credential owner's
//
// The path-specific Access application (RECORDS_API_ACCESS_AUD, checked by `verifyAccess`) stays in
// front of credential calls exactly as before: no verified Access assertion, no credential call.
// With no API audience configured (production today) credential calls are therefore refused.
// A bearer JWT does not need that Access application: a delegated token (60 s, single use, bound to
// one binding and datastore) and an Access for SaaS token are themselves verified proof of who is
// calling. JWTs are accepted over HTTP only from issuers in records.trusted_issuers (enabled rows),
// so with no rows (production today) every JWT is refused and HTTP behaviour is unchanged.
//
// In-process calls from this Worker's own gatekeeper (`verifyDelegated`) trust this Worker's own
// issuer and keys without a table row: the token never leaves the isolate that minted it. They
// still pass the full verification, the shared replay guard and the fresh binding checks.

import {
  IdentityError,
  IssuerRegistry,
  localKeySet,
  parseAuthorization,
  verifyBearerJwt,
  type HeaderSource,
  type VerifiedJwtIdentity,
} from "@records/identity";
import { DELEGATED_AUDIENCE, RecordsError, type CallerContext, type IssuerKind, type TrustedIssuer } from "@records/contracts";
import {
  basicUserMatches,
  loadTrustedIssuers,
  PostgresReplayGuard,
  resolveDelegatedCaller,
  type RecordsService,
} from "@records/core";
import { createRemoteJWKSet, customFetch, type FetchImplementation, type JWTVerifyGetKey } from "jose";

import { JWKS_PATH, type DelegationKeys } from "./keys.js";

/** How long an isolate reuses the trusted-issuer rows before reading them again. */
export const TRUSTED_ISSUER_TTL_MS = 60_000;

/** Per-isolate cache of trusted-issuer rows and remote key sets (jose caches each JWKS document). */
export class TrustedIssuerCache {
  #rows: { at: number; rows: Promise<TrustedIssuer[]> } | undefined;
  readonly #remote = new Map<string, JWTVerifyGetKey>();

  readonly #fetch: FetchImplementation | undefined;

  /** `fetch` replaces the global fetch for remote JWKS documents (tests, or a service binding). */
  constructor(readonly ttlMs = TRUSTED_ISSUER_TTL_MS, fetch?: FetchImplementation) {
    this.#fetch = fetch;
  }

  rows(load: () => Promise<TrustedIssuer[]>, now = Date.now()): Promise<TrustedIssuer[]> {
    if (!this.#rows || now - this.#rows.at > this.ttlMs) {
      const rows = load();
      this.#rows = { at: now, rows };
      rows.catch(() => {
        if (this.#rows?.rows === rows) this.#rows = undefined;
      });
    }
    return this.#rows.rows;
  }

  remoteKeySet(jwksUrl: string): JWTVerifyGetKey {
    let set = this.#remote.get(jwksUrl);
    if (!set) {
      set = createRemoteJWKSet(new URL(jwksUrl), {
        cacheMaxAge: 10 * 60_000,
        cooldownDuration: 30_000,
        timeoutDuration: 5_000,
        ...(this.#fetch ? { [customFetch]: this.#fetch } : {}),
      });
      this.#remote.set(jwksUrl, set);
    }
    return set;
  }

  /** Forget cached rows (tests, or after an operator change). */
  clear(): void {
    this.#rows = undefined;
  }
}

const isolateCache = new TrustedIssuerCache();

export type ServiceAuthenticatorOptions = {
  service: RecordsService;
  /** This Worker's delegation keys. Absent: no in-process delegation, and no local keys for its issuer. */
  keys?: () => Promise<DelegationKeys>;
  /** Defaults to one cache per isolate. */
  cache?: TrustedIssuerCache;
  now?: () => number;
};

export type AuthenticateOptions = {
  /** The datastore the request names (a selector: it must match any datastore the credential is bound to). */
  datastoreId: string;
  /** The path Access application check for credential callers. */
  verifyAccess: () => Promise<boolean>;
  /** Accept bearer JWTs and Access-application identities (the native API). Default false. */
  allowJwt?: boolean;
  /** Accept HTTP Basic `email:rk1_…` (the Jira surface). Default false. */
  allowBasic?: boolean;
};

export type Authenticated = {
  ok: true;
  caller: CallerContext;
  datastoreId: string;
  /** Rate-limit key: the binding when there is one, else the principal. */
  rateKey: string;
  source: "delegated" | "oidc" | "credential";
};

export type AuthRefusal = {
  ok: false;
  /** `access`: the path Access check failed; `credential`: no acceptable credential; `datastore`: bound elsewhere. */
  stage: "access" | "credential" | "datastore";
  error: RecordsError;
  /** Diagnostic only; never sent to the caller. */
  reason: string;
};

const refused = (stage: AuthRefusal["stage"], error: RecordsError, reason: string): AuthRefusal => ({ ok: false, stage, error, reason });
const ACCESS_REQUIRED = () => new RecordsError("unauthenticated", "A valid Access service token is required.");
const CREDENTIAL_REQUIRED = () => new RecordsError("unauthenticated", "A valid Records credential is required.");
const UNKNOWN_DATASTORE = () => new RecordsError("not_found", "Unknown datastore.");

export class ServiceAuthenticator {
  readonly #service: RecordsService;
  readonly #keys: (() => Promise<DelegationKeys>) | undefined;
  readonly #cache: TrustedIssuerCache;
  readonly #now: () => number;

  constructor(options: ServiceAuthenticatorOptions) {
    this.#service = options.service;
    this.#keys = options.keys;
    this.#cache = options.cache ?? isolateCache;
    this.#now = options.now ?? Date.now;
  }

  // -------------------------------------------------------------------------------------------
  // In-process: this Worker's gatekeeper

  /**
   * Verify a delegated token minted by this Worker and resolve its caller. Throws an IdentityError
   * (unauthenticated / forbidden / unavailable) or a RecordsError (revoked binding, inactive
   * principal). `datastoreId` pins the datastore: a token for another one is refused.
   */
  async verifyDelegated(token: string, datastoreId: string): Promise<CallerContext> {
    if (!this.#keys) throw new RecordsError("unavailable", "Delegated tokens are not configured.");
    const keys = await this.#keys();
    const own: TrustedIssuer = {
      issuer: keys.issuer,
      kind: "delegated",
      audiences: [DELEGATED_AUDIENCE],
      jwksUrl: `${new URL(keys.issuer).origin}${JWKS_PATH}`,
      enabled: true,
    };
    const registry = new IssuerRegistry([own], { replay: new PostgresReplayGuard(this.#service.db), keySets: { [keys.issuer]: keys.keySet } });
    const identity = await verifyBearerJwt(token, registry, { kinds: ["delegated"], expectedDatastoreId: datastoreId, now: this.#now() });
    return this.#callerOf(identity);
  }

  // -------------------------------------------------------------------------------------------
  // HTTP

  /** Authenticate one HTTP request for `options.datastoreId`. Never throws for a refused credential. */
  async authenticate(headers: HeaderSource, options: AuthenticateOptions): Promise<Authenticated | AuthRefusal> {
    const parsed = parseAuthorization(headers);

    if (options.allowJwt && parsed.type === "jwt") {
      return this.#jwt(parsed.token, ["delegated", "access_saas"], options.datastoreId);
    }
    if (options.allowJwt && parsed.type === "access" && (await this.#hasIssuerOfKind("access"))) {
      const viaAccess = await this.#jwt(parsed.token, ["access"], options.datastoreId);
      // Not a mapped Access identity: answer exactly as a credential call without a credential.
      if (viaAccess.ok || viaAccess.error.code === "unavailable") return viaAccess;
    }

    // Credential callers: the path Access application first, as before.
    if (!(await options.verifyAccess())) return refused("access", ACCESS_REQUIRED(), "access");
    if (parsed.type !== "credential" && !(parsed.type === "basic" && options.allowBasic)) {
      return refused("credential", CREDENTIAL_REQUIRED(), parsed.type === "invalid" ? parsed.reason : parsed.type);
    }
    const resolved = await this.#service.registry.authenticateCredential(parsed.token);
    if (!resolved) return refused("credential", CREDENTIAL_REQUIRED(), "credential_refused");
    if (parsed.type === "basic" && !(await basicUserMatches(this.#service.db, resolved.caller, resolved.datastoreId, parsed.email))) {
      // The same answer as a bad token, so it does not reveal whose token it is.
      return refused("credential", CREDENTIAL_REQUIRED(), "basic_user_mismatch");
    }
    if (resolved.datastoreId !== options.datastoreId) return refused("datastore", UNKNOWN_DATASTORE(), "datastore_mismatch");
    return {
      ok: true,
      caller: resolved.caller,
      datastoreId: resolved.datastoreId,
      rateKey: resolved.caller.bindingId ?? resolved.caller.principalId,
      source: "credential",
    };
  }

  async #jwt(token: string, kinds: IssuerKind[], datastoreId: string): Promise<Authenticated | AuthRefusal> {
    try {
      const registry = await this.#registry();
      const identity = await verifyBearerJwt(token, registry, { kinds, expectedDatastoreId: datastoreId, now: this.#now() });
      const caller = await this.#callerOf(identity);
      return {
        ok: true,
        caller,
        datastoreId,
        rateKey: caller.bindingId ?? caller.principalId,
        source: identity.kind,
      };
    } catch (err) {
      if (err instanceof IdentityError) {
        const error = err.code === "unauthenticated" ? CREDENTIAL_REQUIRED() : err;
        return refused(err.code === "forbidden" ? "datastore" : "credential", error, err.reason);
      }
      if (err instanceof RecordsError && (err.code === "forbidden" || err.code === "unauthenticated")) {
        return refused("credential", err.code === "unauthenticated" ? CREDENTIAL_REQUIRED() : err, "lookup_refused");
      }
      throw err;
    }
  }

  async #callerOf(identity: VerifiedJwtIdentity): Promise<CallerContext> {
    if (identity.kind === "delegated") {
      return resolveDelegatedCaller(this.#service.db, identity);
    }
    const principal = await this.#service.registry.resolveIdentity(identity.issuer, identity.subject);
    if (!principal) throw new RecordsError("unauthenticated", "A valid Records credential is required.");
    return { orgId: principal.orgId, principalId: principal.principalId, via: "http" };
  }

  async #issuers(): Promise<TrustedIssuer[]> {
    return this.#cache.rows(() => loadTrustedIssuers(this.#service.db), this.#now());
  }

  async #hasIssuerOfKind(kind: IssuerKind): Promise<boolean> {
    try {
      return (await this.#issuers()).some((i) => i.kind === kind);
    } catch {
      return false;
    }
  }

  /** A registry over the enabled rows, for this request (its replay guard uses this request's database). */
  async #registry(): Promise<IssuerRegistry> {
    let rows: TrustedIssuer[];
    try {
      rows = await this.#issuers();
    } catch {
      throw new IdentityError("jwks_unavailable");
    }
    const keySets: Record<string, JWTVerifyGetKey> = {};
    let own: DelegationKeys | undefined;
    if (this.#keys && rows.some((r) => r.kind === "delegated")) own = await this.#keys().catch(() => undefined);
    for (const row of rows) {
      // This Worker's own issuer verifies against its local keys, never over the network.
      // An ephemeral key is never published, so its tokens are not accepted over HTTP.
      if (own && row.issuer === own.issuer) keySets[row.issuer] = own.ephemeral ? localKeySet({ keys: own.published }) : own.keySet;
      else keySets[row.issuer] = this.#cache.remoteKeySet(row.jwksUrl);
    }
    return new IssuerRegistry(rows, { replay: new PostgresReplayGuard(this.#service.db), keySets });
  }
}
