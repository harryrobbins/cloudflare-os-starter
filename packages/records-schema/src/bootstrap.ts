// Operator bootstrap: create an organisation and its first data administrator. Organisation
// creation and identity mapping are deliberately operator actions (plan §2 and §5): nothing infers
// membership from an e-mail domain, and deployment administration confers no record access.
// Runs with the migration-owner credential. Idempotent for the same organisation and e-mail.

import type { Sql } from "postgres";

export const WORKSHOP_ISSUER = "workshop-email";

export type BootstrapInput = { orgName: string; adminEmail: string; adminName: string; orgId?: string };
export type BootstrapResult = { orgId: string; principalId: string; created: boolean };

export async function bootstrapOrganisation(sql: Sql, input: BootstrapInput): Promise<BootstrapResult> {
  const email = input.adminEmail.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error("adminEmail is not an e-mail address.");
  return (await sql.begin(async (tx) => {
    const [mapped] = await tx`
      SELECT org_id, principal_id FROM records.identity_mappings WHERE issuer = ${WORKSHOP_ISSUER} AND subject = ${email}`;
    if (mapped) {
      await tx`INSERT INTO records.org_roles (org_id, principal_id, role) VALUES (${mapped.org_id}, ${mapped.principal_id}, 'data_admin')
               ON CONFLICT DO NOTHING`;
      return { orgId: mapped.org_id as string, principalId: mapped.principal_id as string, created: false };
    }
    const orgId = input.orgId ?? crypto.randomUUID();
    const principalId = crypto.randomUUID();
    await tx`INSERT INTO records.organisations (id, name) VALUES (${orgId}, ${input.orgName}) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO records.principals (org_id, id, kind, display_name, email) VALUES (${orgId}, ${principalId}, 'human', ${input.adminName}, ${email})`;
    await tx`INSERT INTO records.identity_mappings (issuer, subject, org_id, principal_id) VALUES (${WORKSHOP_ISSUER}, ${email}, ${orgId}, ${principalId})`;
    await tx`INSERT INTO records.org_roles (org_id, principal_id, role) VALUES (${orgId}, ${principalId}, 'data_admin')`;
    await tx`INSERT INTO records.audit_events (org_id, id, operation, actor_principal_id, via, summary)
             VALUES (${orgId}, ${crypto.randomUUID()}, 'bootstrapOrganisation', ${principalId}, 'system', 'Operator bootstrap')`;
    return { orgId, principalId, created: true };
  })) as BootstrapResult;
}
