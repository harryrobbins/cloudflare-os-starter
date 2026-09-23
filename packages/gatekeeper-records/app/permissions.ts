// Role-based UI gating, from the frozen matrix in @records/contracts. The server re-checks every
// call; this only hides what would be refused.

import {
  canAssignRole,
  DATASTORE_ROLES,
  ROLE_PERMISSIONS,
  SERVICE_EXTRA_SCOPES,
  RECORD_SCOPES,
  type DatastoreRole,
  type Permission,
  type ServiceScope,
} from '@records/contracts'

export type Perms = { role: DatastoreRole | null; has(p: Permission): boolean }

export function permsFor(role: DatastoreRole | null): Perms {
  const set = role ? ROLE_PERMISSIONS[role] : new Set<Permission>()
  return { role, has: (p) => set.has(p) }
}

/** Roles `granter` may hand out, most senior first. */
export function assignableRoles(granter: DatastoreRole | null): DatastoreRole[] {
  if (!granter) return []
  return DATASTORE_ROLES.filter((r) => canAssignRole(granter, r))
}

/** Whether `granter` may change or remove a member currently holding `current`. */
export function canManageMember(granter: DatastoreRole | null, current: DatastoreRole): boolean {
  if (!granter || current === 'owner') return false
  return canAssignRole(granter, current)
}

/** Scopes a credential may carry: service scopes the caller's own role already holds. */
export function grantableScopes(role: DatastoreRole | null): ServiceScope[] {
  const perms = permsFor(role)
  return [...RECORD_SCOPES, ...SERVICE_EXTRA_SCOPES].filter((s) => perms.has(s))
}

export const ROLE_LABEL: Record<DatastoreRole, string> = {
  owner: 'Owner',
  admin: 'Administrator',
  editor: 'Editor',
  reader: 'Reader',
}

export const SCOPE_LABEL: Record<ServiceScope, string> = {
  'projects.read': 'Read projects',
  'issues.read': 'Read issues',
  'issues.create': 'Create issues',
  'issues.edit': 'Edit issues',
  'issues.transition': 'Move issues through the workflow',
  'comments.create': 'Add comments',
  'audit.read': 'Read the audit log',
}
