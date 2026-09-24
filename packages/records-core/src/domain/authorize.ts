// Authorization against fresh, authoritative state, inside the operation's own transaction.
//
// effective = principal role ∩ binding/credential scopes ∩ the operation's permission
//
// Mutations take FOR SHARE locks on the membership and binding rows they rely on, so a revocation
// (which updates or deletes those rows) waits for in-flight writes and every later write sees it.
// A revocation committed before this check therefore denies the operation; one committed after an
// operation was authorised lets that operation finish. Reads take no locks.

import {
  effectivePermissions,
  OPERATION_PERMISSION,
  RecordsError,
  type CallerContext,
  type DatastoreRole,
  type DomainOperation,
  type Permission,
} from "@records/contracts";

import type { Tx } from "../db/context.js";

export type DatastoreAccess = {
  datastoreId: string;
  role: DatastoreRole;
  permissions: Set<Permission>;
  lifecycle: "active" | "archived";
  moduleId: string;
};

/** Verify the principal is active. Disabled or expired principals hold no rights. */
async function requireActivePrincipal(tx: Tx, caller: CallerContext): Promise<void> {
  const [p] = await tx`
    SELECT status, expires_at FROM records.principals WHERE id = ${caller.principalId}`;
  if (!p || p.status !== "active" || (p.expires_at && (p.expires_at as Date) <= new Date())) {
    throw new RecordsError("forbidden", "This identity is not active.");
  }
}

/**
 * Resolve the caller's authority on one datastore and require `operation`. Unknown datastores and
 * datastores the caller cannot see both report not_found, so existence is not disclosed.
 */
export async function authorize(
  tx: Tx,
  caller: CallerContext,
  datastoreId: string,
  operation: DomainOperation,
  opts: { lock?: boolean } = {},
): Promise<DatastoreAccess> {
  await requireActivePrincipal(tx, caller);
  const lock = opts.lock ? tx`FOR SHARE OF m` : tx``;
  const [row] = await tx`
    SELECT m.role, d.lifecycle, d.module_id
      FROM records.memberships m
      JOIN records.datastores d ON d.id = m.datastore_id AND d.org_id = m.org_id
     WHERE m.datastore_id = ${datastoreId} AND m.principal_id = ${caller.principalId}
     ${lock}`;
  if (!row) throw new RecordsError("not_found", "Unknown datastore.");

  let scopes = caller.scopes;
  if (caller.bindingId) {
    const bindingLock = opts.lock ? tx`FOR SHARE` : tx``;
    const [binding] = await tx`
      SELECT status, datastore_id, scopes FROM records.bindings WHERE id = ${caller.bindingId} ${bindingLock}`;
    if (!binding || binding.status !== "active" || binding.datastore_id !== datastoreId) {
      throw new RecordsError("forbidden", "This connection has been revoked.");
    }
    // The stored scopes are authoritative; a caller-supplied list can only narrow them further.
    const stored = binding.scopes as string[];
    scopes = scopes ? scopes.filter((s) => stored.includes(s)) : stored;
  }

  const role = row.role as DatastoreRole;
  const permissions = effectivePermissions(role, scopes);
  const access: DatastoreAccess = {
    datastoreId,
    role,
    permissions,
    lifecycle: row.lifecycle as "active" | "archived",
    moduleId: row.module_id as string,
  };
  const needed = OPERATION_PERMISSION[operation];
  if (!permissions.has(needed)) {
    // Holding no read permission at all is indistinguishable from not being a member.
    if (!permissions.has("projects.read") && !permissions.has("issues.read")) {
      throw new RecordsError("not_found", "Unknown datastore.");
    }
    throw new RecordsError("forbidden", `This needs the ${needed} permission.`);
  }
  return access;
}

export function requireWritable(access: DatastoreAccess): void {
  if (access.lifecycle !== "active") throw new RecordsError("datastore_archived", "This datastore is archived and read-only.");
}

/** Organisation-level roles (data administrator), checked fresh. */
export async function requireOrgRole(tx: Tx, caller: CallerContext, role: "data_admin"): Promise<void> {
  await requireActivePrincipal(tx, caller);
  if (caller.bindingId || caller.scopes) {
    throw new RecordsError("forbidden", "Organisation administration is not available to connections or credentials.");
  }
  const [row] = await tx`
    SELECT 1 FROM records.org_roles WHERE principal_id = ${caller.principalId} AND role = ${role}`;
  if (!row) throw new RecordsError("forbidden", "This needs the organisation data administrator role.");
}

export async function hasOrgRole(tx: Tx, principalId: string, role: "data_admin"): Promise<boolean> {
  const [row] = await tx`SELECT 1 FROM records.org_roles WHERE principal_id = ${principalId} AND role = ${role}`;
  return !!row;
}
