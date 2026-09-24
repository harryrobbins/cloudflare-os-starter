// The caller -> ACL step. Everything that returns a row goes through one of these.
//
//   person     vis:"all" plus every scope that lists them in `principals`
//   delegated  exactly the scopes the source resolved, restricted to `<source>:`; never vis:"all"
//   agent      vis:"all" plus `account:<accountId>`
//
// The SQL clause is the authoritative check and is applied before ranking (plan: "The ACL filter runs
// before ranking on both halves"). `restricted` is the list the dense half puts in its `$in` filter;
// `includeAll` says whether the dense half also queries `{vis: "all"}`.

import type { SearchCaller, Scope } from "../shared/contract.js";
import { IN_LIST, inputError, jsonList } from "./util.js";

/** Scopes a delegated caller may pass. More is a caller bug, not a bigger ACL. */
export const MAX_DELEGATED_SCOPES = 5000;

export interface Acl {
  readonly caller: SearchCaller;
  /** Scopes this caller may see beyond vis:"all". */
  readonly restricted: readonly Scope[];
  readonly includeAll: boolean;
  /** A boolean SQL expression over `documents` aliased as `d`, with its parameters. */
  readonly clause: string;
  readonly params: readonly (string | number)[];
}

export function resolveAcl(sql: SqlStorage, caller: SearchCaller): Acl {
  switch (caller.kind) {
    case "person": {
      if (typeof caller.principal !== "string" || caller.principal.length === 0) {
        throw inputError("a person caller needs a principal.");
      }
      const restricted = sql
        .exec<{ scope: string }>(`SELECT scope FROM principals WHERE principal = ?`, caller.principal)
        .toArray()
        .map((row) => row.scope);
      return {
        caller,
        restricted,
        includeAll: true,
        // A subquery rather than the list above, so the check is exactly as fresh as the statement.
        clause: `(d.vis = 'all' OR d.scope IN (SELECT scope FROM principals WHERE principal = ?))`,
        params: [caller.principal],
      };
    }
    case "delegated": {
      const prefix = `${caller.source}:`;
      if (typeof caller.source !== "string" || caller.source.length === 0) {
        throw inputError("a delegated caller needs a source.");
      }
      if (!Array.isArray(caller.scopes) || caller.scopes.length > MAX_DELEGATED_SCOPES) {
        throw inputError(`scopes must be a list of at most ${MAX_DELEGATED_SCOPES}.`);
      }
      const restricted = [
        ...new Set(caller.scopes.filter((scope) => typeof scope === "string" && scope.startsWith(prefix))),
      ];
      return {
        caller,
        restricted,
        includeAll: false,
        clause: `d.scope IN ${IN_LIST}`,
        params: [jsonList(restricted)],
      };
    }
    case "agent": {
      if (typeof caller.accountId !== "string" || caller.accountId.length === 0) {
        throw inputError("an agent caller needs an accountId.");
      }
      const scope = `account:${caller.accountId}`;
      return {
        caller,
        restricted: [scope],
        includeAll: true,
        clause: `(d.vis = 'all' OR d.scope = ?)`,
        params: [scope],
      };
    }
    default:
      throw inputError("unknown caller kind.");
  }
}

/** True when this caller may see documents in `scope` at all (for resolving `in:`). */
export function scopeVisible(sql: SqlStorage, acl: Acl, scope: Scope): boolean {
  if (acl.restricted.includes(scope)) return true;
  if (!acl.includeAll) return false;
  const row = sql
    .exec<{ ok: number }>(
      `SELECT EXISTS (SELECT 1 FROM scopes WHERE scope = ? AND vis = 'all')
           OR EXISTS (SELECT 1 FROM documents WHERE scope = ? AND vis = 'all' AND deleted_at IS NULL) AS ok`,
      scope,
      scope,
    )
    .one();
  return row.ok === 1;
}
