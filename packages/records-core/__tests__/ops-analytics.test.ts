// Analytics contract v1 (canonical plan §8, "Analytics"): security_invoker views, read through a
// login mapped to one principal. The login sees exactly the datastores that principal may read,
// cannot widen that by forging session settings, cannot see journal bodies and cannot write.

import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ANALYTICS_VIEWS_V1, grantAnalyticsLogin } from "../src/ops/index.js";
import { createWorld, key, type World } from "./world.js";

let w: World;
const opened: Sql[] = [];
beforeAll(async () => {
  w = await createWorld();
  await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Counted" }, key());
  await w.service.projects.createIssue(w.ed.caller, w.ds2, { projectId: w.ops, title: "Not visible to Rae" }, key());
});
afterAll(async () => {
  await Promise.all(opened.map((s) => s.end()));
  await w?.close();
});

const PASSWORD = "analytics-test-only-password-0123456789";

async function loginFor(principalId: string): Promise<Sql> {
  const login = `analytics_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await grantAnalyticsLogin(w.owner, { login, principalId, password: PASSWORD });
  const url = new URL(w.db.ownerUrl);
  url.username = login;
  url.password = PASSWORD;
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
  opened.push(sql);
  return sql;
}

describe("analytics", () => {
  it("publishes the v1 views as security_invoker, readable by records_analytics only", async () => {
    const views = await w.owner`
      SELECT c.relname, c.reloptions, has_table_privilege('records_analytics', c.oid, 'SELECT') AS analytics,
             has_table_privilege('records_app', c.oid, 'SELECT') AS app
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relkind = 'v' ORDER BY 1`;
    expect(views.map((v) => v.relname)).toEqual([...ANALYTICS_VIEWS_V1].toSorted());
    for (const v of views) expect(v).toMatchObject({ reloptions: ["security_invoker=true"], analytics: true, app: false });
    const [role] = await w.owner`SELECT rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname = 'records_analytics'`;
    expect(role).toEqual({ rolcanlogin: false, rolbypassrls: false });
  });

  it("a login sees exactly its principal's readable datastores", async () => {
    const rae = await loginFor(w.rae.id); // reader of ds1 only
    const issues = await rae`SELECT datastore_id, issue_key, state_category, comment_count, project_key FROM analytics.issues_v1`;
    expect(issues.length).toBeGreaterThan(0);
    expect(new Set(issues.map((i) => i.datastore_id))).toEqual(new Set([w.ds1]));
    expect(issues[0]).toMatchObject({ project_key: "ENG", state_category: expect.stringMatching(/todo|in_progress|done/), comment_count: "0" });
    expect((await rae`SELECT datastore_id FROM analytics.datastores_v1`).map((r) => r.datastore_id)).toEqual([w.ds1]);
    expect((await rae`SELECT DISTINCT datastore_id FROM analytics.projects_v1`).map((r) => r.datastore_id)).toEqual([w.ds1]);
    const activity = await rae`SELECT datastore_id, entity_type, op, changes FROM analytics.daily_activity_v1`;
    expect(new Set(activity.map((a) => a.datastore_id))).toEqual(new Set([w.ds1]));
    expect(activity.some((a) => a.entity_type === "issue" && a.op === "create")).toBe(true);

    // Forged settings change nothing: the policies key off the login, not the session.
    const forged = await rae.begin(async (tx) => {
      await tx`SELECT set_config('records.org_id', ${w.orgA}, true), set_config('records.datastore_id', ${w.ds2}, true),
                      set_config('records.principal_id', ${w.olive.id}, true), set_config('records.scopes', '*', true)`;
      return tx`SELECT DISTINCT datastore_id FROM analytics.issues_v1`;
    });
    expect(forged.map((r) => r.datastore_id)).toEqual([w.ds1]);

    // Read-only, views only, no journal bodies.
    await expect(rae`SELECT after FROM records.journal`).rejects.toThrow(/permission denied/);
    await expect(rae`SELECT * FROM projects.issues`).rejects.toThrow(/permission denied/);
    await expect(rae`SELECT * FROM records_ops.analytics_logins`).rejects.toThrow(/permission denied/);
    expect((await rae`SHOW default_transaction_read_only`)[0]!.default_transaction_read_only).toBe("on");
    // Privileges refuse the write before the read-only default is even reached.
    await expect(rae.begin("read write", (tx) => tx`DELETE FROM analytics.datastores_v1`)).rejects.toThrow(/permission denied/);

    // The owner of both datastores sees both.
    const olive = await loginFor(w.olive.id);
    expect(new Set((await olive`SELECT datastore_id FROM analytics.issues_v1`).map((r) => r.datastore_id))).toEqual(new Set([w.ds1, w.ds2]));
  });

  it("sees nothing without a membership, a mapping or an active principal", async () => {
    const nia = await loginFor(w.nia.id);
    expect(await nia`SELECT * FROM analytics.issues_v1`).toEqual([]);
    expect(await nia`SELECT * FROM analytics.daily_activity_v1`).toEqual([]);

    // A records_analytics member created by hand, with no mapping.
    const login = `analytics_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await w.owner.unsafe(`CREATE ROLE ${login} LOGIN PASSWORD '${PASSWORD}' IN ROLE records_analytics; GRANT CONNECT ON DATABASE ${w.db.name} TO ${login}`);
    const url = new URL(w.db.ownerUrl);
    url.username = login;
    url.password = PASSWORD;
    const unmapped = postgres(url.toString(), { max: 1, onnotice: () => {} });
    opened.push(unmapped);
    expect(await unmapped`SELECT * FROM analytics.issues_v1`).toEqual([]);

    const ed = await loginFor(w.ed.id);
    expect((await ed`SELECT DISTINCT datastore_id FROM analytics.issues_v1`).length).toBe(2);
    await w.owner`UPDATE records.principals SET status = 'disabled' WHERE id = ${w.ed.id}`;
    try {
      expect(await ed`SELECT * FROM analytics.issues_v1`).toEqual([]);
    } finally {
      await w.owner`UPDATE records.principals SET status = 'active' WHERE id = ${w.ed.id}`;
    }
  });

  it("the grant's dry run shows the statements without the password and validates input", async () => {
    const plan = await grantAnalyticsLogin(w.owner, { login: "analytics_dry", principalId: w.rae.id, password: PASSWORD, dryRun: true });
    expect(plan).toMatchObject({ login: "analytics_dry", principalId: w.rae.id, datastores: 1 });
    expect(JSON.stringify(plan)).not.toContain(PASSWORD);
    expect((await w.owner`SELECT 1 FROM pg_roles WHERE rolname = 'analytics_dry'`)).toHaveLength(0);
    await expect(grantAnalyticsLogin(w.owner, { login: "Bad-Name", principalId: w.rae.id, password: PASSWORD })).rejects.toThrow(/login/);
    await expect(grantAnalyticsLogin(w.owner, { login: "analytics_short", principalId: w.rae.id, password: "short" })).rejects.toThrow(/24/);
  });
});
