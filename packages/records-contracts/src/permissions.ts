// The frozen v1 role/operation matrix.
//
// Effective authority for any call is
//
//     principal rights  ∩  binding or credential scopes  ∩  the operation's required permission
//
// where "principal rights" come from the caller's datastore membership role (or, for organisation
// operations, their organisation role). Scopes on a binding or credential can only narrow what the
// principal already holds; they never add to it.
//
// Decisions frozen here (organisation-datastores plan §6, "Roles and scope"):
// - Datastore owners and administrators also hold every record permission an editor holds. They are
//   accountable for the dataset, and a management role that could grant itself editor rights anyway
//   gains nothing from being denied them directly.
// - The organisation data administrator holds NO record permission by virtue of that role. It can
//   create datastores and assign owners; reading records needs a membership like anyone else.
// - Workshop `build`/`use` roles and deployment admin status are not inputs to this matrix.
// - There is no catch-all write scope.

import { z } from "zod";

/** Record operations a gadget binding or service credential can be granted. */
export const RECORD_SCOPES = [
  "projects.read",
  "issues.read",
  "issues.create",
  "issues.edit",
  "issues.transition",
  "comments.create",
] as const;
export type RecordScope = (typeof RECORD_SCOPES)[number];
export const RecordScopeSchema = z.enum(RECORD_SCOPES);

/**
 * Management permissions. Never grantable to a gadget binding; a service credential may hold only
 * the read-only `audit.read` among them, and only when its owner holds it.
 */
export const MANAGEMENT_PERMISSIONS = [
  "projects.manage",
  "members.manage",
  "bindings.manage",
  "credentials.manage",
  "audit.read",
  "export.run",
  "lifecycle.manage",
  "ownership.transfer",
  "datastore.purge",
] as const;
export type ManagementPermission = (typeof MANAGEMENT_PERMISSIONS)[number];

export type Permission = RecordScope | ManagementPermission;

export const DATASTORE_ROLES = ["owner", "admin", "editor", "reader"] as const;
export type DatastoreRole = (typeof DATASTORE_ROLES)[number];
export const DatastoreRoleSchema = z.enum(DATASTORE_ROLES);

export const ORG_ROLES = ["data_admin"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

const READER: readonly Permission[] = ["projects.read", "issues.read"];
const EDITOR: readonly Permission[] = [
  ...READER,
  "issues.create",
  "issues.edit",
  "issues.transition",
  "comments.create",
];
const ADMIN: readonly Permission[] = [
  ...EDITOR,
  "projects.manage",
  "members.manage",
  "bindings.manage",
  "credentials.manage",
  "audit.read",
  "export.run",
];
const OWNER: readonly Permission[] = [
  ...ADMIN,
  "lifecycle.manage",
  "ownership.transfer",
  "datastore.purge",
];

/** Permissions each datastore role confers. */
export const ROLE_PERMISSIONS: Readonly<Record<DatastoreRole, ReadonlySet<Permission>>> = {
  reader: new Set(READER),
  editor: new Set(EDITOR),
  admin: new Set(ADMIN),
  owner: new Set(OWNER),
};

/** Organisation-level operations. Only `data_admin` holds them. */
export const ORG_PERMISSIONS = ["datastores.create", "datastores.assign_owner", "modules.manage"] as const;
export type OrgPermission = (typeof ORG_PERMISSIONS)[number];

/** Roles an administrator may hand out. Only an owner may create another owner (a transfer). */
export function canAssignRole(granter: DatastoreRole, role: DatastoreRole): boolean {
  if (role === "owner") return false; // ownership moves only through transferOwnership
  if (granter === "owner") return true;
  if (granter === "admin") return role !== "admin";
  return false;
}

/** Scopes that a service credential may carry beyond record scopes. */
export const SERVICE_EXTRA_SCOPES = ["audit.read"] as const;
export const ServiceScopeSchema = z.enum([...RECORD_SCOPES, ...SERVICE_EXTRA_SCOPES]);
export type ServiceScope = z.infer<typeof ServiceScopeSchema>;

/**
 * The effective permission set: role ∩ scopes. `scopes` undefined means the caller is acting
 * directly as themself (the management UI), with no binding narrowing their role.
 */
export function effectivePermissions(
  role: DatastoreRole | null,
  scopes: readonly string[] | undefined,
): Set<Permission> {
  if (!role) return new Set();
  const fromRole = ROLE_PERMISSIONS[role];
  if (scopes === undefined) return new Set(fromRole);
  const out = new Set<Permission>();
  for (const s of scopes) if (fromRole.has(s as Permission)) out.add(s as Permission);
  return out;
}

/** The permission each domain operation requires. The single source for both transports. */
export const OPERATION_PERMISSION = {
  listProjects: "projects.read",
  getProject: "projects.read",
  createProject: "projects.manage",
  listIssues: "issues.read",
  getIssue: "issues.read",
  listComments: "issues.read",
  getWorkflow: "projects.read",
  createIssue: "issues.create",
  editIssue: "issues.edit",
  transitionIssue: "issues.transition",
  addComment: "comments.create",
  listMembers: "members.manage",
  addMember: "members.manage",
  setMemberRole: "members.manage",
  removeMember: "members.manage",
  listBindings: "bindings.manage",
  createBinding: "bindings.manage",
  revokeBinding: "bindings.manage",
  listCredentials: "credentials.manage",
  createCredential: "credentials.manage",
  revokeCredential: "credentials.manage",
  listAudit: "audit.read",
  exportDatastore: "export.run",
  archiveDatastore: "lifecycle.manage",
  restoreDatastore: "lifecycle.manage",
  transferOwnership: "ownership.transfer",
} as const satisfies Record<string, Permission>;
export type DomainOperation = keyof typeof OPERATION_PERMISSION;

/** Operations that change state. Each needs an idempotency key and goes through approval for gadgets. */
export const MUTATING_RECORD_OPERATIONS = [
  "createIssue",
  "editIssue",
  "transitionIssue",
  "addComment",
] as const satisfies readonly DomainOperation[];
export type MutatingRecordOperation = (typeof MUTATING_RECORD_OPERATIONS)[number];
