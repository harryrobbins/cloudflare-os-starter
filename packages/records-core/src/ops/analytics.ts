// Analytics access (canonical plan §8, "Analytics"): a LOGIN role in the records_analytics group,
// mapped to one principal. Migration 0009's policies key the login's reads to that principal's
// memberships through session_user, so the login sees exactly what the principal may read.
// The login is read-only by default and has a small connection limit.

import type { Sql } from "postgres";

const LOGIN = /^[a-z][a-z0-9_]{2,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ANALYTICS_VIEWS_V1 = ["datastores_v1", "projects_v1", "issues_v1", "daily_activity_v1"] as const;

export type AnalyticsGrant = {
  login: string;
  principalId: string;
  password: string;
  connectionLimit?: number;
  dryRun?: boolean;
};

export type AnalyticsGrantPlan = { login: string; orgId: string; principalId: string; principalName: string; datastores: number; statements: string[] };

export async function grantAnalyticsLogin(sql: Sql, g: AnalyticsGrant): Promise<AnalyticsGrantPlan> {
  if (!LOGIN.test(g.login)) throw new Error("The login must match ^[a-z][a-z0-9_]{2,40}$.");
  if (!UUID.test(g.principalId)) throw new Error("principalId must be a UUID.");
  if (g.password.length < 24) throw new Error("Use a password of at least 24 characters.");
  const limit = g.connectionLimit ?? 3;
  const [p] = await sql`SELECT org_id, display_name, status FROM records.principals WHERE id = ${g.principalId}`;
  if (!p) throw new Error("Unknown principal.");
  if (p.status !== "active") throw new Error("That principal is disabled.");
  const [n] = await sql`
    SELECT count(DISTINCT m.datastore_id) AS n FROM records.memberships m
      JOIN records.role_permissions rp ON rp.role = m.role AND rp.permission = 'issues.read'
     WHERE m.principal_id = ${g.principalId}`;
  const [{ create, connect, readonly }] = (await sql`
    SELECT format('CREATE ROLE %I LOGIN PASSWORD %L CONNECTION LIMIT %s IN ROLE records_analytics', ${g.login}::text, ${g.password}::text, ${limit}::int) AS create,
           format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), ${g.login}::text) AS connect,
           format('ALTER ROLE %I SET default_transaction_read_only = on', ${g.login}::text) AS readonly`) as unknown as [
    { create: string; connect: string; readonly: string },
  ];
  const plan: AnalyticsGrantPlan = {
    login: g.login, orgId: p.org_id as string, principalId: g.principalId, principalName: p.display_name as string, datastores: Number(n!.n),
    statements: [create.replace(/PASSWORD '(?:[^']|'')*'/, "PASSWORD '…'"), connect, readonly,
                 `INSERT INTO records_ops.analytics_logins (login, org_id, principal_id) VALUES ('${g.login}', …)`],
  };
  if (g.dryRun) return plan;
  await sql.begin(async (tx) => {
    await tx.unsafe(create);
    await tx.unsafe(connect);
    await tx.unsafe(readonly);
    await tx`INSERT INTO records_ops.analytics_logins (login, org_id, principal_id) VALUES (${g.login}, ${p.org_id as string}, ${g.principalId})`;
  });
  return plan;
}
