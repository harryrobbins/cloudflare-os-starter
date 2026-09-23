// The datastore registry: lifecycle, membership, discovery, bindings, credentials and audit.
// One query layer serves the management UI, the resource picker and agent discovery, so every
// listing is filtered the same way: a caller sees only datastores they are a member of, plus (when
// asked) datastores whose owners opted into organisation-wide discovery. Discovery never grants
// record access.

import {
  AddMemberInputSchema,
  InvitePrincipalInputSchema,
  SetDataAdminInputSchema,
  canAssignRole,
  CreateCredentialInputSchema,
  CreateDatastoreInputSchema,
  CreateGadgetBindingInputSchema,
  DEFAULT_WORKFLOW,
  effectivePermissions,
  ListAuditInputSchema,
  parseInput,
  RecordsError,
  RemoveMemberInputSchema,
  SearchDatastoresInputSchema,
  SetMemberRoleInputSchema,
  TransferOwnershipInputSchema,
  UuidSchema,
  type AuditEvent,
  type Binding,
  type CallerContext,
  type CreatedCredential,
  type CredentialInfo,
  type DatastoreDetail,
  type DatastoreRole,
  type DatastoreSummary,
  type DomainOperation,
  type Member,
  type Page,
  type PrincipalRef,
} from "@records/contracts";
import { z } from "zod";

import { withContext, type Db, type Tx } from "../db/context.js";
import { authorize, hasOrgRole, requireOrgRole, requireWritable } from "./authorize.js";
import { decodeCursor, encodeCursor, likePattern } from "./cursor.js";
import { audit, emit, useDatastore } from "./journal.js";
import { seedWorkflow } from "./projects.js";

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v as Date).toISOString();

/** The issuer for Workshop sign-in identities (Access-verified e-mail, lower-cased). */
export const WORKSHOP_ISSUER = "workshop-email";

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function ref(r: Row, prefix: string): PrincipalRef {
  return { id: r[`${prefix}_id`] as string, displayName: r[`${prefix}_name`] as string, kind: r[`${prefix}_kind`] as "human" | "service" };
}

function toSummary(r: Row): DatastoreSummary {
  return {
    id: r.id as string,
    name: r.name as string,
    description: r.description as string,
    moduleId: r.module_id as string,
    apiMajor: r.api_major as number,
    features: (r.features as string[] | null) ?? [],
    lifecycle: r.lifecycle as "active" | "archived",
    ownerTeam: (r.owner_team as string | null) ?? null,
    discovery: r.discovery as "members" | "organisation",
    role: (r.role as DatastoreRole | null) ?? null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

// Credential tokens: rk1_<credential id, 32 hex>_<secret, 43 base64url>. Only SHA-256(secret) is
// stored; the prefix shown in listings is the first 8 characters of the ID part.
const TOKEN = /^rk1_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

const hexToUuid = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;

/** The narrowest role whose permissions cover a service credential's scopes. */
function roleForScopes(scopes: readonly string[]): DatastoreRole {
  if (scopes.includes("audit.read")) return "admin";
  if (scopes.some((s) => !s.endsWith(".read"))) return "editor";
  return "reader";
}

export type Whoami = { orgId: string; principal: PrincipalRef; email: string | null; dataAdmin: boolean };

export class RegistryService {
  constructor(private readonly db: Db) {}

  // -------------------------------------------------------------------------------------------
  // Identity

  /** Map a verified external identity to its principal, or null. Used before any context exists. */
  async resolveIdentity(issuer: string, subject: string): Promise<{ orgId: string; principalId: string } | null> {
    const [row] = await this.db`SELECT * FROM records.resolve_identity(${issuer}, ${subject})`;
    if (!row || row.status !== "active") return null;
    return { orgId: row.org_id as string, principalId: row.principal_id as string };
  }

  async whoami(caller: CallerContext): Promise<Whoami> {
    return withContext(this.db, { orgId: caller.orgId }, async (tx) => {
      const [p] = await tx`SELECT id, display_name, kind, email FROM records.principals WHERE id = ${caller.principalId}`;
      if (!p) throw new RecordsError("forbidden", "Unknown identity.");
      return {
        orgId: caller.orgId,
        principal: { id: p.id as string, displayName: p.display_name as string, kind: p.kind as "human" | "service" },
        email: (p.email as string | null) ?? null,
        dataAdmin: await hasOrgRole(tx, caller.principalId, "data_admin"),
      };
    });
  }

  /** Add a person to the organisation directory (data administrators only). */
  async invitePrincipal(caller: CallerContext, raw: unknown): Promise<PrincipalRef> {
    const input = parseInput(InvitePrincipalInputSchema, raw);
    return withContext(this.db, { orgId: caller.orgId }, async (tx) => {
      await requireOrgRole(tx, caller, "data_admin");
      const email = normaliseEmail(input.email);
      const existing = await this.resolveIdentityTx(tx, email);
      if (existing) throw new RecordsError("duplicate", "That person is already in the directory.");
      const id = crypto.randomUUID();
      await tx`INSERT INTO records.principals (org_id, id, kind, display_name, email)
               VALUES (${caller.orgId}, ${id}, 'human', ${input.displayName}, ${email})`;
      await tx`INSERT INTO records.identity_mappings (issuer, subject, org_id, principal_id)
               VALUES (${WORKSHOP_ISSUER}, ${email}, ${caller.orgId}, ${id})`;
      await audit(tx, caller, { datastoreId: null, operation: "invitePrincipal", targetType: "principal", targetId: id, summary: `Added ${input.displayName} to the directory` });
      return { id, displayName: input.displayName, kind: "human" };
    });
  }

  private async resolveIdentityTx(tx: Tx, email: string): Promise<boolean> {
    const [row] = await tx`SELECT 1 FROM records.identity_mappings WHERE issuer = ${WORKSHOP_ISSUER} AND subject = ${email}`;
    return !!row;
  }

  /** Grant or revoke the organisation data administrator role. */
  async setDataAdmin(caller: CallerContext, raw: unknown): Promise<void> {
    const input = parseInput(SetDataAdminInputSchema, raw);
    return withContext(this.db, { orgId: caller.orgId }, async (tx) => {
      await requireOrgRole(tx, caller, "data_admin");
      if (!input.enabled && input.principalId === caller.principalId) {
        const [{ n }] = (await tx`SELECT count(*)::int AS n FROM records.org_roles WHERE role = 'data_admin'`) as unknown as [{ n: number }];
        if (n <= 1) throw new RecordsError("validation_failed", "The organisation needs at least one data administrator.");
      }
      if (input.enabled) {
        await tx`INSERT INTO records.org_roles (org_id, principal_id, role, granted_by)
                 VALUES (${caller.orgId}, ${input.principalId}, 'data_admin', ${caller.principalId}) ON CONFLICT DO NOTHING`;
      } else {
        await tx`DELETE FROM records.org_roles WHERE principal_id = ${input.principalId} AND role = 'data_admin'`;
      }
      await audit(tx, caller, { datastoreId: null, operation: "setDataAdmin", targetType: "principal", targetId: input.principalId, summary: input.enabled ? "Granted data administrator" : "Revoked data administrator" });
    });
  }

  /** The organisation's data administrators (visible to data administrators). */
  async listDataAdmins(caller: CallerContext): Promise<PrincipalRef[]> {
    return withContext(this.db, { orgId: caller.orgId }, async (tx) => {
      await requireOrgRole(tx, caller, "data_admin");
      const rows = await tx`
        SELECT p.id, p.display_name FROM records.org_roles r JOIN records.principals p ON p.id = r.principal_id
         WHERE r.role = 'data_admin' ORDER BY p.display_name LIMIT 100`;
      return rows.map((r) => ({ id: r.id as string, displayName: r.display_name as string, kind: "human" as const }));
    });
  }

  /** People who can be assigned issues: the datastore's active human members. Needs issues.read. */
  async listAssignees(caller: CallerContext, datastoreId: string): Promise<PrincipalRef[]> {
    return withContext(this.db, { orgId: caller.orgId, datastoreId }, async (tx) => {
      await authorize(tx, caller, datastoreId, "listIssues");
      const rows = await tx`
        SELECT p.id, p.display_name FROM records.memberships m JOIN records.principals p ON p.id = m.principal_id
         WHERE m.datastore_id = ${datastoreId} AND p.kind = 'human' AND p.status = 'active'
         ORDER BY p.display_name LIMIT 500`;
      return rows.map((r) => ({ id: r.id as string, displayName: r.display_name as string, kind: "human" as const }));
    });
  }

  /** Directory search for member pickers: active humans only, bounded. */
  async searchPrincipals(caller: CallerContext, raw: unknown): Promise<(PrincipalRef & { email: string | null })[]> {
    const input = parseInput(z.object({ query: z.string().trim().max(100).default("") }), raw ?? {});
    return withContext(this.db, { orgId: caller.orgId }, async (tx) => {
      const [self] = await tx`SELECT kind, status FROM records.principals WHERE id = ${caller.principalId}`;
      if (!self || self.kind !== "human" || self.status !== "active" || caller.bindingId) {
        throw new RecordsError("forbidden", "Directory search is for signed-in people.");
      }
      const pattern = likePattern(input.query);
      const rows = await tx`
        SELECT id, display_name, email FROM records.principals
         WHERE org_id = ${caller.orgId} AND kind = 'human' AND status = 'active'
           AND (display_name ILIKE ${pattern} OR email ILIKE ${pattern})
         ORDER BY display_name LIMIT 20`;
      return rows.map((r) => ({ id: r.id as string, displayName: r.display_name as string, kind: "human" as const, email: (r.email as string | null) ?? null }));
    });
  }

  // -------------------------------------------------------------------------------------------
  // Datastore lifecycle

  async createDatastore(caller: CallerContext, raw: unknown): Promise<DatastoreSummary> {
    const input = parseInput(CreateDatastoreInputSchema, raw);
    return withContext(this.db, { orgId: caller.orgId }, async (tx) => {
      await requireOrgRole(tx, caller, "data_admin");
      const [module] = await tx`SELECT api_versions, features FROM records.module_installations WHERE module_id = ${input.moduleId}`;
      if (!module) throw new RecordsError("validation_failed", `Module ${input.moduleId} is not installed.`);
      const [owner] = await tx`
        SELECT kind, status FROM records.principals WHERE id = ${input.ownerPrincipalId} AND org_id = ${caller.orgId}`;
      if (!owner || owner.kind !== "human" || owner.status !== "active") {
        throw new RecordsError("validation_failed", "The owner must be an active person in this organisation.");
      }
      const id = crypto.randomUUID();
      const apiMajor = Math.max(...(module.api_versions as number[]));
      await tx`
        INSERT INTO records.datastores (org_id, id, name, description, module_id, api_major, owner_principal_id, owner_team,
                                        retention_policy, discovery, created_by)
        VALUES (${caller.orgId}, ${id}, ${input.name}, ${input.description}, ${input.moduleId}, ${apiMajor},
                ${input.ownerPrincipalId}, ${input.ownerTeam}, ${input.retentionPolicy}, ${input.discovery}, ${caller.principalId})`;
      await tx`
        INSERT INTO records.memberships (org_id, datastore_id, principal_id, role, granted_by)
        VALUES (${caller.orgId}, ${id}, ${input.ownerPrincipalId}, 'owner', ${caller.principalId})`;
      await useDatastore(tx, id);
      await seedWorkflow(tx, caller.orgId, id, DEFAULT_WORKFLOW);
      if (input.initialProject) {
        await tx`
          INSERT INTO projects.projects (org_id, datastore_id, id, key, name, created_by, updated_by)
          VALUES (${caller.orgId}, ${id}, ${crypto.randomUUID()}, ${input.initialProject.key}, ${input.initialProject.name},
                  ${caller.principalId}, ${caller.principalId})`;
      }
      await audit(tx, caller, { datastoreId: id, operation: "createDatastore", targetType: "datastore", targetId: id, summary: `Created datastore ${input.name}` });
      await emit(tx, caller.orgId, { datastoreId: id, eventType: "datastore.created", entityType: "datastore", entityId: id, revision: 1 });
      const [row] = await tx`
        SELECT d.*, i.features, m.role FROM records.datastores d
          JOIN records.module_installations i ON i.module_id = d.module_id
          LEFT JOIN records.memberships m ON m.datastore_id = d.id AND m.principal_id = ${caller.principalId}
         WHERE d.id = ${id}`;
      return toSummary(row!);
    });
  }

  async searchDatastores(caller: CallerContext, raw: unknown): Promise<Page<DatastoreSummary>> {
    const input = parseInput(SearchDatastoresInputSchema, raw ?? {});
    return withContext(this.db, { orgId: caller.orgId }, async (tx) => {
      const [self] = await tx`SELECT status FROM records.principals WHERE id = ${caller.principalId}`;
      if (!self || self.status !== "active") throw new RecordsError("forbidden", "This identity is not active.");
      const after = decodeCursor("datastores", input.cursor);
      const onlyBinding = caller.bindingId
        ? tx`AND d.id = (SELECT datastore_id FROM records.bindings WHERE id = ${caller.bindingId} AND status = 'active')`
        : tx``;
      const orgWide = input.allOrganisation && !caller.bindingId && !caller.scopes && (await hasOrgRole(tx, caller.principalId, "data_admin"));
      if (input.allOrganisation && !orgWide) throw new RecordsError("forbidden", "This needs the organisation data administrator role.");
      const visibility = orgWide
        ? tx``
        : input.includeRequestable && !caller.bindingId
          ? tx`AND (m.role IS NOT NULL OR d.discovery = 'organisation')`
          : tx`AND m.role IS NOT NULL`;
      const rows = await tx`
        SELECT d.*, i.features, m.role FROM records.datastores d
          JOIN records.module_installations i ON i.module_id = d.module_id
          LEFT JOIN records.memberships m ON m.datastore_id = d.id AND m.principal_id = ${caller.principalId}
         WHERE d.org_id = ${caller.orgId} ${visibility} ${onlyBinding}
           ${input.includeArchived ? tx`` : tx`AND d.lifecycle = 'active'`}
           ${input.moduleId ? tx`AND d.module_id = ${input.moduleId}` : tx``}
           ${input.apiMajor ? tx`AND ${input.apiMajor} = ANY(i.api_versions)` : tx``}
           ${input.query ? tx`AND (d.name ILIKE ${likePattern(input.query)} OR d.description ILIKE ${likePattern(input.query)})` : tx``}
           ${after ? tx`AND (lower(d.name), d.id) > (${after[0] as string}, ${after[1] as string})` : tx``}
         ORDER BY lower(d.name), d.id LIMIT ${input.limit + 1}`;
      const items = rows.slice(0, input.limit).map((r) => {
        const summary = toSummary(r);
        // A requestable entry reveals its name and module only.
        return summary.role ? summary : { ...summary, description: "", ownerTeam: null };
      });
      const last = items.at(-1);
      return { items, nextCursor: rows.length > input.limit && last ? encodeCursor("datastores", [last.name.toLowerCase(), last.id]) : null };
    });
  }

  async getDatastore(caller: CallerContext, datastoreId: string): Promise<DatastoreSummary | DatastoreDetail> {
    return withContext(this.db, { orgId: caller.orgId, datastoreId }, async (tx) => {
      const access = await authorize(tx, caller, datastoreId, "listProjects");
      const [r] = await tx`
        SELECT d.*, i.features, i.version AS module_version, m.role,
               o.id AS owner_id, o.display_name AS owner_name, o.kind AS owner_kind,
               (SELECT count(*)::int FROM records.memberships x WHERE x.datastore_id = d.id) AS member_count,
               (SELECT count(*)::int FROM records.bindings b WHERE b.datastore_id = d.id AND b.status = 'active') AS binding_count,
               (SELECT count(*)::int FROM records.credentials c JOIN records.bindings b ON b.id = c.binding_id
                 WHERE b.datastore_id = d.id AND c.revoked_at IS NULL AND c.expires_at > now()) AS credential_count
          FROM records.datastores d
          JOIN records.module_installations i ON i.module_id = d.module_id
          JOIN records.memberships m ON m.datastore_id = d.id AND m.principal_id = ${caller.principalId}
          JOIN records.principals o ON o.id = d.owner_principal_id
         WHERE d.id = ${datastoreId}`;
      const summary = toSummary(r!);
      if (!access.permissions.has("members.manage")) return summary;
      return {
        ...summary,
        owner: ref(r!, "owner"),
        retentionPolicy: r!.retention_policy as string,
        environment: r!.environment as string,
        placement: r!.placement as string,
        moduleVersion: (r!.module_version as string | null) ?? null,
        memberCount: r!.member_count as number,
        activeBindingCount: r!.binding_count as number,
        activeCredentialCount: r!.credential_count as number,
        revision: r!.revision as number,
      } satisfies DatastoreDetail;
    });
  }

  async setLifecycle(caller: CallerContext, datastoreId: string, lifecycle: "active" | "archived"): Promise<void> {
    return withContext(this.db, { orgId: caller.orgId, datastoreId }, async (tx) => {
      await authorize(tx, caller, datastoreId, lifecycle === "archived" ? "archiveDatastore" : "restoreDatastore", { lock: true });
      const res = await tx`
        UPDATE records.datastores SET lifecycle = ${lifecycle}, revision = revision + 1, updated_at = now()
         WHERE id = ${datastoreId} AND lifecycle <> ${lifecycle} RETURNING revision`;
      if (res.count === 0) return;
      const verb = lifecycle === "archived" ? "Archived" : "Restored";
      await audit(tx, caller, { datastoreId, operation: lifecycle === "archived" ? "archiveDatastore" : "restoreDatastore", targetType: "datastore", targetId: datastoreId, summary: `${verb} the datastore` });
      await emit(tx, caller.orgId, { datastoreId, eventType: lifecycle === "archived" ? "datastore.archived" : "datastore.restored", entityType: "datastore", entityId: datastoreId, revision: res[0]!.revision as number });
    });
  }

  // -------------------------------------------------------------------------------------------
  // Membership

  async listMembers(caller: CallerContext, datastoreId: string): Promise<Member[]> {
    return withContext(this.db, { orgId: caller.orgId, datastoreId }, async (tx) => {
      await authorize(tx, caller, datastoreId, "listMembers");
      const rows = await tx`
        SELECT m.role, m.granted_at, p.id AS p_id, p.display_name AS p_name, p.kind AS p_kind
          FROM records.memberships m JOIN records.principals p ON p.id = m.principal_id
         WHERE m.datastore_id = ${datastoreId}
         ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END, p.display_name
         LIMIT 500`;
      return rows.map((r) => ({ principal: ref(r, "p"), role: r.role as DatastoreRole, grantedAt: iso(r.granted_at) }));
    });
  }

  async addMember(caller: CallerContext, datastoreId: string, raw: unknown): Promise<void> {
    const input = parseInput(AddMemberInputSchema, raw);
    return this.writeMembership(caller, datastoreId, "addMember", input.principalId, input.role);
  }

  async setMemberRole(caller: CallerContext, datastoreId: string, raw: unknown): Promise<void> {
    const input = parseInput(SetMemberRoleInputSchema, raw);
    return this.writeMembership(caller, datastoreId, "setMemberRole", input.principalId, input.role);
  }

  async removeMember(caller: CallerContext, datastoreId: string, raw: unknown): Promise<void> {
    const input = parseInput(RemoveMemberInputSchema, raw);
    return this.writeMembership(caller, datastoreId, "removeMember", input.principalId, null);
  }

  private async writeMembership(caller: CallerContext, datastoreId: string, operation: "addMember" | "setMemberRole" | "removeMember",
                          principalId: string, role: DatastoreRole | null): Promise<void> {
    return withContext(this.db, { orgId: caller.orgId, datastoreId }, async (tx) => {
      const access = await authorize(tx, caller, datastoreId, operation, { lock: true });
      const [target] = await tx`
        SELECT p.kind, p.status, m.role FROM records.principals p
          LEFT JOIN records.memberships m ON m.principal_id = p.id AND m.datastore_id = ${datastoreId}
         WHERE p.id = ${principalId} AND p.org_id = ${caller.orgId}`;
      if (!target) throw new RecordsError("not_found", "Unknown person.");
      if (target.kind !== "human") throw new RecordsError("validation_failed", "Service principals are managed through credentials.");
      const current = (target.role as DatastoreRole | null) ?? null;
      if (current === "owner") throw new RecordsError("forbidden", "Transfer ownership before changing the owner's membership.");
      if (current && !canAssignRole(access.role, current)) throw new RecordsError("forbidden", `An ${access.role} cannot change a ${current}.`);
      if (role && !canAssignRole(access.role, role)) throw new RecordsError("forbidden", `An ${access.role} cannot grant ${role}.`);
      if (operation === "addMember" && current) throw new RecordsError("duplicate", "That person is already a member.");
      if (operation !== "addMember" && !current) throw new RecordsError("not_found", "That person is not a member.");
      if (role && target.status !== "active") throw new RecordsError("validation_failed", "That person is not active.");

      if (role) {
        await tx`
          INSERT INTO records.memberships (org_id, datastore_id, principal_id, role, granted_by)
          VALUES (${caller.orgId}, ${datastoreId}, ${principalId}, ${role}, ${caller.principalId})
          ON CONFLICT (datastore_id, principal_id) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by, granted_at = now()`;
      } else {
        await tx`DELETE FROM records.memberships WHERE datastore_id = ${datastoreId} AND principal_id = ${principalId}`;
        // A removed member's gadget connections to this datastore stop working with them.
        await tx`
          UPDATE records.bindings SET status = 'revoked', revoked_at = now(), revoked_by = ${caller.principalId}
           WHERE datastore_id = ${datastoreId} AND principal_id = ${principalId} AND status = 'active'`;
      }
      await audit(tx, caller, {
        datastoreId, operation, targetType: "principal", targetId: principalId,
        summary: role ? `Set role ${role}` : "Removed member", detail: { from: current, to: role },
      });
      await emit(tx, caller.orgId, { datastoreId, eventType: "membership.changed", entityType: "membership", entityId: principalId, revision: 0 });
    });
  }

  async transferOwnership(caller: CallerContext, datastoreId: string, raw: unknown): Promise<void> {
    const input = parseInput(TransferOwnershipInputSchema, raw);
    return withContext(this.db, { orgId: caller.orgId, datastoreId }, async (tx) => {
      const [ds] = await tx`SELECT owner_principal_id FROM records.datastores WHERE id = ${datastoreId} FOR NO KEY UPDATE`;
      // The current owner, or a data administrator recovering a datastore whose owner left.
      let permitted = false;
      try {
        await authorize(tx, caller, datastoreId, "transferOwnership", { lock: true });
        permitted = true;
      } catch (err) {
        if (!(err instanceof RecordsError)) throw err;
      }
      if (!permitted && !caller.bindingId && !caller.scopes && (await hasOrgRole(tx, caller.principalId, "data_admin"))) {
        permitted = true;
      }
      if (!permitted || !ds) throw new RecordsError("not_found", "Unknown datastore.");
      const [next] = await tx`
        SELECT kind, status FROM records.principals WHERE id = ${input.newOwnerPrincipalId} AND org_id = ${caller.orgId}`;
      if (!next || next.kind !== "human" || next.status !== "active") {
        throw new RecordsError("validation_failed", "The new owner must be an active person in this organisation.");
      }
      const previous = ds.owner_principal_id as string;
      if (previous === input.newOwnerPrincipalId) return;
      await tx`UPDATE records.memberships SET role = 'admin' WHERE datastore_id = ${datastoreId} AND principal_id = ${previous}`;
      await tx`
        INSERT INTO records.memberships (org_id, datastore_id, principal_id, role, granted_by)
        VALUES (${caller.orgId}, ${datastoreId}, ${input.newOwnerPrincipalId}, 'owner', ${caller.principalId})
        ON CONFLICT (datastore_id, principal_id) DO UPDATE SET role = 'owner', granted_by = excluded.granted_by, granted_at = now()`;
      await tx`UPDATE records.datastores SET owner_principal_id = ${input.newOwnerPrincipalId}, revision = revision + 1, updated_at = now()
               WHERE id = ${datastoreId}`;
      await audit(tx, caller, { datastoreId, operation: "transferOwnership", targetType: "principal", targetId: input.newOwnerPrincipalId, summary: "Transferred ownership", detail: { from: previous } });
      await emit(tx, caller.orgId, { datastoreId, eventType: "membership.changed", entityType: "membership", entityId: input.newOwnerPrincipalId, revision: 0 });
    });
  }

  // -------------------------------------------------------------------------------------------
  // Gadget bindings

  /**
   * A member binds a datastore to a gadget for themself. Scopes must be within their own rights:
   * a binding narrows authority, never widens it.
   */
  async createGadgetBinding(caller: CallerContext, datastoreId: string, raw: unknown, connectionId: string | null = null): Promise<Binding> {
    const input = parseInput(CreateGadgetBindingInputSchema, raw);
    return withContext(this.db, { orgId: caller.orgId, datastoreId }, async (tx) => {
      if (caller.bindingId || caller.scopes) throw new RecordsError("forbidden", "Connections cannot create connections.");
      const access = await authorize(tx, caller, datastoreId, "listProjects", { lock: true });
      requireWritable(access);
      const beyond = input.scopes.filter((s) => !access.permissions.has(s));
      if (beyond.length) throw new RecordsError("forbidden", `You do not hold ${beyond.join(", ")} on this datastore.`);
      const id = crypto.randomUUID();
      await tx`
        INSERT INTO records.bindings (org_id, datastore_id, id, kind, label, principal_id, scopes, connection_id, created_by)
        VALUES (${caller.orgId}, ${datastoreId}, ${id}, 'gadget', ${input.label}, ${caller.principalId}, ${input.scopes}, ${connectionId}, ${caller.principalId})`;
      await audit(tx, caller, { datastoreId, operation: "createBinding", targetType: "binding", targetId: id, summary: `Connected ${input.label}`, detail: { scopes: input.scopes } });
      return this.loadBinding(tx, id);
    });
  }

  async listBindings(caller: CallerContext, datastoreId: string): Promise<Binding[]> {
    return withContext(this.db, { orgId: caller.orgId, datastoreId }, async (tx) => {
      await authorize(tx, caller, datastoreId, "listBindings");
      const rows = await tx`${this.bindingSelect(tx)} WHERE b.datastore_id = ${datastoreId} ORDER BY b.status, b.created_at DESC LIMIT 500`;
      return rows.map((r) => this.toBinding(r));
    });
  }

  /** The binding's own principal may always revoke it; otherwise `bindings.manage` is needed. */
  async revokeBinding(caller: CallerContext, bindingId: string): Promise<void> {
    parseInput(UuidSchema, bindingId);
    return withContext(this.db, { orgId: caller.orgId }, async (tx) => {
      const [b] = await tx`SELECT datastore_id, principal_id, status, kind FROM records.bindings WHERE id = ${bindingId} FOR UPDATE`;
      if (!b) throw new RecordsError("not_found", "Unknown connection.");
      const datastoreId = b.datastore_id as string;
      await useDatastore(tx, datastoreId);
      if (b.principal_id !== caller.principalId || caller.bindingId) {
        await authorize(tx, caller, datastoreId, "revokeBinding", { lock: true });
      }
      if (b.status === "revoked") return;
      await this.revokeBindingRow(tx, caller, bindingId, datastoreId, b.kind === "service" ? (b.principal_id as string) : null);
    });
  }

  /**
   * Revoke every active gadget binding made through one connector account (the account was
   * removed). Records are untouched: they belong to the organisation.
   */
  async revokeConnection(caller: CallerContext, connectionId: string): Promise<number> {
    return withContext(this.db, { orgId: caller.orgId }, async (tx) => {
      const rows = await tx`
        SELECT id, datastore_id FROM records.bindings
         WHERE connection_id = ${connectionId} AND principal_id = ${caller.principalId} AND status = 'active' FOR UPDATE`;
      for (const b of rows) {
        await useDatastore(tx, b.datastore_id as string);
        await this.revokeBindingRow(tx, caller, b.id as string, b.datastore_id as string, null);
      }
      return rows.length;
    });
  }

  /**
   * Check, without doing anything, whether `caller` may perform `operation` on a datastore now.
   * Adapters use it to fail fast (and observers to verify read access); every operation still
   * re-authorises inside its own transaction.
   */
  async checkAccess(caller: CallerContext, datastoreId: string, operation: DomainOperation): Promise<{ role: DatastoreRole; lifecycle: "active" | "archived" }> {
    return withContext(this.db, { orgId: caller.orgId, datastoreId }, async (tx) => {
      const access = await authorize(tx, caller, datastoreId, operation);
      return { role: access.role, lifecycle: access.lifecycle };
    });
  }

  /** Which of `principalIds` currently hold read access to the datastore. */
  async readersAmong(orgId: string, datastoreId: string, principalIds: string[]): Promise<Set<string>> {
    if (principalIds.length === 0) return new Set();
    return withContext(this.db, { orgId, datastoreId }, async (tx) => {
      const rows = await tx`
        SELECT m.principal_id FROM records.memberships m JOIN records.principals p ON p.id = m.principal_id
         WHERE m.datastore_id = ${datastoreId} AND m.principal_id = ANY(${principalIds}) AND p.status = 'active'`;
      return new Set(rows.map((r) => r.principal_id as string));
    });
  }

  private async revokeBindingRow(tx: Tx, caller: CallerContext, bindingId: string, datastoreId: string, servicePrincipal: string | null): Promise<void> {
    await tx`UPDATE records.bindings SET status = 'revoked', revoked_at = now(), revoked_by = ${caller.principalId} WHERE id = ${bindingId}`;
    await tx`UPDATE records.credentials SET revoked_at = now() WHERE binding_id = ${bindingId} AND revoked_at IS NULL`;
    if (servicePrincipal) {
      await tx`DELETE FROM records.memberships WHERE datastore_id = ${datastoreId} AND principal_id = ${servicePrincipal}`;
      await tx`UPDATE records.principals SET status = 'disabled' WHERE id = ${servicePrincipal}`;
    }
    await audit(tx, caller, { datastoreId, operation: "revokeBinding", targetType: "binding", targetId: bindingId, summary: "Revoked a connection" });
    await emit(tx, caller.orgId, { datastoreId, eventType: "binding.revoked", entityType: "binding", entityId: bindingId, revision: 0 });
  }

  private bindingSelect(tx: Tx) {
    return tx`
      SELECT b.*, p.id AS p_id, p.display_name AS p_name, p.kind AS p_kind
        FROM records.bindings b JOIN records.principals p ON p.id = b.principal_id`;
  }

  private toBinding(r: Row): Binding {
    return {
      id: r.id as string,
      datastoreId: r.datastore_id as string,
      kind: r.kind as "gadget" | "service",
      label: r.label as string,
      principal: ref(r, "p"),
      scopes: r.scopes as string[],
      status: r.status as "active" | "revoked",
      createdAt: iso(r.created_at),
      revokedAt: r.revoked_at ? iso(r.revoked_at) : null,
    };
  }

  private async loadBinding(tx: Tx, id: string): Promise<Binding> {
    const [r] = await tx`${this.bindingSelect(tx)} WHERE b.id = ${id}`;
    return this.toBinding(r!);
  }

  /** Binding lookup for adapters: the datastore and principal a binding acts for. */
  async resolveBinding(orgId: string, bindingId: string): Promise<{ datastoreId: string; principalId: string; scopes: string[]; active: boolean } | null> {
    return withContext(this.db, { orgId }, async (tx) => {
      const [b] = await tx`SELECT datastore_id, principal_id, scopes, status FROM records.bindings WHERE id = ${bindingId}`;
      return b ? { datastoreId: b.datastore_id as string, principalId: b.principal_id as string, scopes: b.scopes as string[], active: b.status === "active" } : null;
    });
  }

  // -------------------------------------------------------------------------------------------
  // Service credentials

  async createCredential(caller: CallerContext, datastoreId: string, raw: unknown): Promise<CreatedCredential> {
    const input = parseInput(CreateCredentialInputSchema, raw);
    return withContext(this.db, { orgId: caller.orgId, datastoreId }, async (tx) => {
      if (caller.bindingId || caller.scopes) throw new RecordsError("forbidden", "Credentials cannot mint credentials.");
      const access = await authorize(tx, caller, datastoreId, "createCredential", { lock: true });
      requireWritable(access);
      const scopes = [...new Set(input.scopes)];
      const beyond = scopes.filter((s) => !access.permissions.has(s as never));
      if (beyond.length) throw new RecordsError("forbidden", `You do not hold ${beyond.join(", ")} on this datastore.`);

      const principalId = crypto.randomUUID();
      const bindingId = crypto.randomUUID();
      const credentialId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000);
      const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const idHex = credentialId.replaceAll("-", "");
      await tx`
        INSERT INTO records.principals (org_id, id, kind, display_name, owner_principal_id, expires_at)
        VALUES (${caller.orgId}, ${principalId}, 'service', ${input.label}, ${caller.principalId}, ${expiresAt})`;
      await tx`
        INSERT INTO records.memberships (org_id, datastore_id, principal_id, role, granted_by)
        VALUES (${caller.orgId}, ${datastoreId}, ${principalId}, ${roleForScopes(scopes)}, ${caller.principalId})`;
      await tx`
        INSERT INTO records.bindings (org_id, datastore_id, id, kind, label, principal_id, scopes, created_by)
        VALUES (${caller.orgId}, ${datastoreId}, ${bindingId}, 'service', ${input.label}, ${principalId}, ${scopes}, ${caller.principalId})`;
      await tx`
        INSERT INTO records.credentials (org_id, id, binding_id, owner_principal_id, digest, prefix, expires_at)
        VALUES (${caller.orgId}, ${credentialId}, ${bindingId}, ${caller.principalId}, ${await sha256(secret)},
                ${`rk1_${idHex.slice(0, 8)}`}, ${expiresAt})`;
      await audit(tx, caller, { datastoreId, operation: "createCredential", targetType: "credential", targetId: credentialId, summary: `Created credential ${input.label}`, detail: { scopes, expiresAt: expiresAt.toISOString() } });
      const [credential] = await this.listCredentialsTx(tx, datastoreId, credentialId);
      return { credential: credential!, secret: `rk1_${idHex}_${secret}` };
    });
  }

  async listCredentials(caller: CallerContext, datastoreId: string): Promise<CredentialInfo[]> {
    return withContext(this.db, { orgId: caller.orgId, datastoreId }, async (tx) => {
      await authorize(tx, caller, datastoreId, "listCredentials");
      return this.listCredentialsTx(tx, datastoreId);
    });
  }

  private async listCredentialsTx(tx: Tx, datastoreId: string, only?: string): Promise<CredentialInfo[]> {
    const rows = await tx`
      SELECT c.id, c.binding_id, c.prefix, c.created_at, c.expires_at, c.revoked_at, c.last_used_at,
             b.label, b.scopes, s.id AS s_id, s.display_name AS s_name, s.kind AS s_kind,
             o.id AS o_id, o.display_name AS o_name, o.kind AS o_kind
        FROM records.credentials c
        JOIN records.bindings b ON b.id = c.binding_id
        JOIN records.principals s ON s.id = b.principal_id
        JOIN records.principals o ON o.id = c.owner_principal_id
       WHERE b.datastore_id = ${datastoreId} ${only ? tx`AND c.id = ${only}` : tx``}
       ORDER BY c.created_at DESC LIMIT 200`;
    return rows.map((r) => ({
      id: r.id as string,
      bindingId: r.binding_id as string,
      label: r.label as string,
      prefix: r.prefix as string,
      scopes: r.scopes as string[],
      servicePrincipal: ref(r, "s"),
      owner: ref(r, "o"),
      createdAt: iso(r.created_at),
      expiresAt: iso(r.expires_at),
      revokedAt: r.revoked_at ? iso(r.revoked_at) : null,
      lastUsedAt: r.last_used_at ? iso(r.last_used_at) : null,
    }));
  }

  async revokeCredential(caller: CallerContext, datastoreId: string, credentialId: string): Promise<void> {
    parseInput(UuidSchema, credentialId);
    return withContext(this.db, { orgId: caller.orgId, datastoreId }, async (tx) => {
      await authorize(tx, caller, datastoreId, "revokeCredential", { lock: true });
      const [c] = await tx`
        SELECT c.binding_id, b.principal_id FROM records.credentials c JOIN records.bindings b ON b.id = c.binding_id
         WHERE c.id = ${credentialId} AND b.datastore_id = ${datastoreId} FOR UPDATE OF c`;
      if (!c) throw new RecordsError("not_found", "Unknown credential.");
      await this.revokeBindingRow(tx, caller, c.binding_id as string, datastoreId, c.principal_id as string);
    });
  }

  /**
   * Verify a presented credential and return the caller context it acts as, or null. Checks, all
   * against fresh state: format, digest (constant time), expiry, revocation, binding, service
   * principal status, and that the credential's human owner still holds credentials.manage on the
   * datastore (an owner who loses access takes their integrations with them).
   */
  async authenticateCredential(token: string): Promise<{ caller: CallerContext; datastoreId: string } | null> {
    const match = TOKEN.exec(token);
    if (!match) return null;
    const credentialId = hexToUuid(match[1]!);
    const [row] = await this.db`SELECT * FROM records.resolve_credential(${credentialId})`;
    if (!row) return null;
    if (!constantTimeEqual(new Uint8Array(row.digest as Uint8Array), await sha256(match[2]!))) return null;
    if (row.revoked_at || (row.expires_at as Date) <= new Date()) return null;
    const orgId = row.org_id as string;
    return withContext(this.db, { orgId }, async (tx) => {
      const [b] = await tx`
        SELECT b.id AS binding_id, b.datastore_id, b.principal_id, b.scopes, b.status, c.owner_principal_id, c.last_used_at, p.status AS p_status
          FROM records.bindings b
          JOIN records.credentials c ON c.binding_id = b.id
          JOIN records.principals p ON p.id = b.principal_id
         WHERE c.id = ${credentialId}`;
      if (!b || b.status !== "active" || b.p_status !== "active") return null;
      const datastoreId = b.datastore_id as string;
      const [owner] = await tx`
        SELECT m.role, p.status FROM records.memberships m JOIN records.principals p ON p.id = m.principal_id
         WHERE m.datastore_id = ${datastoreId} AND m.principal_id = ${b.owner_principal_id as string}`;
      if (!owner || owner.status !== "active" || !effectivePermissions(owner.role as DatastoreRole, undefined).has("credentials.manage")) return null;
      if (!b.last_used_at || Date.now() - (b.last_used_at as Date).getTime() > 5 * 60_000) {
        await tx`UPDATE records.credentials SET last_used_at = now() WHERE id = ${credentialId}`;
      }
      return {
        datastoreId,
        caller: { orgId, principalId: b.principal_id as string, via: "http", bindingId: b.binding_id as string, scopes: b.scopes as string[] },
      };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Audit

  async listAudit(caller: CallerContext, datastoreId: string, raw: unknown): Promise<Page<AuditEvent>> {
    const input = parseInput(ListAuditInputSchema, raw ?? {});
    return withContext(this.db, { orgId: caller.orgId, datastoreId }, async (tx) => {
      await authorize(tx, caller, datastoreId, "listAudit");
      const after = decodeCursor("audit", input.cursor);
      const rows = await tx`
        SELECT e.*, a.id AS a_id, a.display_name AS a_name, a.kind AS a_kind,
               i.id AS i_id, i.display_name AS i_name, i.kind AS i_kind
          FROM records.audit_events e
          JOIN records.principals a ON a.id = e.actor_principal_id
          LEFT JOIN records.principals i ON i.id = e.initiator_principal_id
         WHERE e.datastore_id = ${datastoreId} ${after ? tx`AND e.seq < ${after[0] as number}` : tx``}
         ORDER BY e.seq DESC LIMIT ${input.limit + 1}`;
      const items = rows.slice(0, input.limit).map((r) => ({
        id: r.id as string,
        datastoreId: (r.datastore_id as string | null) ?? null,
        operation: r.operation as string,
        actor: ref(r, "a"),
        initiator: r.i_id ? ref(r, "i") : null,
        bindingId: (r.binding_id as string | null) ?? null,
        via: r.via as AuditEvent["via"],
        targetType: (r.target_type as string | null) ?? null,
        targetId: (r.target_id as string | null) ?? null,
        summary: r.summary as string,
        at: iso(r.at),
      }));
      const lastSeq = rows.length > input.limit ? Number(rows[input.limit - 1]!.seq) : null;
      return { items, nextCursor: lastSeq ? encodeCursor("audit", [lastSeq]) : null };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Export

  /** Synchronous JSON export, bounded. Larger datasets need the (future) export job. */
  async exportDatastore(caller: CallerContext, datastoreId: string): Promise<Record<string, unknown>> {
    return withContext(this.db, { orgId: caller.orgId, datastoreId }, async (tx) => {
      await authorize(tx, caller, datastoreId, "exportDatastore");
      const [{ n }] = (await tx`SELECT count(*)::int AS n FROM projects.issues WHERE datastore_id = ${datastoreId}`) as unknown as [{ n: number }];
      if (n > 10_000) throw new RecordsError("payload_too_large", "This datastore is too large for a direct export.");
      const [ds] = await tx`SELECT id, name, description, module_id, api_major FROM records.datastores WHERE id = ${datastoreId}`;
      const data = {
        format: "records-export/v1",
        exportedAt: new Date().toISOString(),
        datastore: ds,
        workflowStates: await tx`SELECT key, name, category, position FROM projects.workflow_states WHERE datastore_id = ${datastoreId} ORDER BY position`,
        workflowTransitions: await tx`SELECT from_state, to_state FROM projects.workflow_transitions WHERE datastore_id = ${datastoreId}`,
        customFields: await tx`SELECT key, name, type, options FROM projects.custom_fields WHERE datastore_id = ${datastoreId}`,
        projects: await tx`SELECT id, key, name, description, created_at, updated_at FROM projects.projects WHERE datastore_id = ${datastoreId} ORDER BY key`,
        issues: await tx`SELECT id, project_id, number, title, description, state, priority, assignee_id, custom_fields, revision, created_by, updated_by, created_at, updated_at
                           FROM projects.issues WHERE datastore_id = ${datastoreId} ORDER BY project_id, number`,
        comments: await tx`SELECT id, issue_id, body, author_id, created_at FROM projects.comments WHERE datastore_id = ${datastoreId} ORDER BY created_at, id`,
      };
      await audit(tx, caller, { datastoreId, operation: "exportDatastore", targetType: "datastore", targetId: datastoreId, summary: `Exported ${n} issues` });
      return JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
    });
  }
}
