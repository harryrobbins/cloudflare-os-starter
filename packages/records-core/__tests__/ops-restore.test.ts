// Per-datastore restore by journal replay (canonical plan §8, acceptance §11.7): one datastore
// restored to an earlier seq matches the state rebuilt from the journal at that seq, the restore is
// itself journaled (history is appended to, never rewritten), and every other datastore is
// untouched, byte for byte.

import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { createTestDatabase } from "@records/schema/testing";

import { CONTENT_FIELDS, rebuildAt, restoreDatastore, seqAtTime } from "../src/ops/index.js";
import { createWorld, key, type World } from "./world.js";

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => w?.close());

const head = async (ds: string) => Number((await w.owner`SELECT seq FROM records.datastore_clock WHERE datastore_id = ${ds}`)[0]!.seq);

/** Every row that belongs to a datastore, as text, in a stable order. */
async function snapshot(sql: Sql, ds: string) {
  const text = async (q: Promise<Record<string, unknown>[]>) => (await q).map((r) => r.t as string);
  return {
    projects: await text(sql`SELECT to_jsonb(x)::text AS t FROM projects.projects x WHERE datastore_id = ${ds} ORDER BY id`),
    issues: await text(sql`SELECT to_jsonb(x)::text AS t FROM projects.issues x WHERE datastore_id = ${ds} ORDER BY id`),
    comments: await text(sql`SELECT to_jsonb(x)::text AS t FROM projects.comments x WHERE datastore_id = ${ds} ORDER BY id`),
    journal: await text(sql`SELECT to_jsonb(x)::text AS t FROM records.journal x WHERE datastore_id = ${ds} ORDER BY seq, ordinal`),
    clock: await text(sql`SELECT to_jsonb(x)::text AS t FROM records.datastore_clock x WHERE datastore_id = ${ds}`),
    audit: await text(sql`SELECT to_jsonb(x)::text AS t FROM records.audit_events x WHERE datastore_id = ${ds} ORDER BY seq`),
    outbox: await text(sql`SELECT (to_jsonb(x) - 'state' - 'attempts' - 'available_at' - 'lease_owner' - 'lease_until' - 'published_at' - 'last_error')::text AS t
                             FROM records.outbox x WHERE datastore_id = ${ds} ORDER BY event_id`),
  };
}

/** The content of every current row of a datastore, keyed by entity ID, in journal field names. */
async function currentContent(ds: string): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const r of await w.owner`SELECT id, name, description FROM projects.projects WHERE datastore_id = ${ds}`) {
    out.set(r.id as string, { name: r.name, description: r.description });
  }
  for (const r of await w.owner`
    SELECT id, title, description, state, priority, assignee_id, custom_fields FROM projects.issues WHERE datastore_id = ${ds}`) {
    out.set(r.id as string, {
      title: r.title, description: r.description, state: r.state, priority: r.priority, assigneeId: r.assignee_id ?? null, customFields: r.custom_fields,
    });
  }
  for (const r of await w.owner`SELECT id, body FROM projects.comments WHERE datastore_id = ${ds}`) out.set(r.id as string, { body: r.body });
  return out;
}

async function rebuiltContent(ds: string, upto: number): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const e of (await rebuildAt(w.owner, ds, upto)).state.values()) {
    out.set(e.id, Object.fromEntries(CONTENT_FIELDS[e.type].map((f) => [f, e.fields[f] ?? (f === "assigneeId" ? null : f === "customFields" ? {} : "")])));
  }
  return out;
}

describe("restoreDatastore", () => {
  it("brings one datastore back to an earlier seq with new system entries and leaves the other untouched", async () => {
    const { ed, olive } = w;
    // History worth keeping, in both datastores.
    const a = (await w.service.projects.createIssue(ed.caller, w.ds1, { projectId: w.eng, title: "Alpha", description: "first" }, key())).record;
    const b = (await w.service.projects.createIssue(ed.caller, w.ds1, { projectId: w.eng, title: "Beta" }, key())).record;
    const c1 = (await w.service.projects.addComment(ed.caller, w.ds1, { issueId: a.id, body: "keep me" }, key())).record;
    await w.service.projects.editIssue(ed.caller, w.ds1, { issueId: a.id, expectedRevision: 1, patch: { title: "Alpha 2" } }, key());
    await w.service.projects.transitionIssue(ed.caller, w.ds1, { issueId: a.id, expectedRevision: 2, toState: "todo" }, key());
    const z = (await w.service.projects.createIssue(ed.caller, w.ds2, { projectId: w.ops, title: "Zed" }, key())).record;
    const restorePoint = await head(w.ds1);
    const pullBefore = await w.service.sync.pull(olive.caller, w.ds1, { clientGroupId: "restore-group-1", cookie: null });

    // The damage, after the restore point.
    await w.service.projects.editIssue(ed.caller, w.ds1, { issueId: a.id, expectedRevision: 3, patch: { title: "Alpha broken", priority: "urgent" } }, key());
    await w.service.projects.transitionIssue(ed.caller, w.ds1, { issueId: a.id, expectedRevision: 4, toState: "in_progress" }, key());
    await w.service.projects.editIssue(ed.caller, w.ds1, { issueId: b.id, expectedRevision: 1, patch: { description: "overwritten" } }, key());
    const late = (await w.service.projects.createIssue(ed.caller, w.ds1, { projectId: w.eng, title: "Created later" }, key())).record;
    const lateComment = (await w.service.projects.addComment(ed.caller, w.ds1, { issueId: a.id, body: "later" }, key())).record;
    await w.service.projects.editIssue(ed.caller, w.ds2, { issueId: z.id, expectedRevision: 1, patch: { title: "Zed 2" } }, key());
    await w.owner`DELETE FROM projects.comments WHERE id = ${c1.id}`; // a lost row

    const ds2Before = await snapshot(w.owner, w.ds2);
    const ds1Before = await snapshot(w.owner, w.ds1);
    const headBefore = await head(w.ds1);

    // Dry run: the plan, and nothing written.
    const plan = await restoreDatastore({ source: w.owner, target: w.owner, datastoreId: w.ds1, uptoSeq: restorePoint, actorId: w.ada.id, dryRun: true });
    expect(plan.applied).toBe(false);
    expect(plan.changes.map((c) => [c.entityId, c.op, c.fields.toSorted()]).toSorted()).toEqual([
      [a.id, "update", ["priority", "state", "title"]],
      [b.id, "update", ["description"]],
      [c1.id, "restore", ["authorId", "body", "issueId"]],
    ].toSorted());
    expect(plan.cannotRemove.map((p) => p.entityId).toSorted()).toEqual([late.id, lateComment.id].toSorted());
    expect(plan.unresolved).toEqual([]);
    expect(await snapshot(w.owner, w.ds1)).toEqual(ds1Before);

    // Apply.
    const report = await restoreDatastore({ source: w.owner, target: w.owner, datastoreId: w.ds1, uptoSeq: restorePoint, actorId: w.ada.id, reason: "test" });
    expect(report.applied).toBe(true);
    expect(report.seqs).toEqual([headBefore + 1]);
    expect(await head(w.ds1)).toBe(headBefore + 1);

    // Every entity that existed at the restore point has its content back.
    const want = await rebuiltContent(w.ds1, restorePoint);
    const now = await currentContent(w.ds1);
    for (const [id, content] of want) expect(now.get(id), id).toEqual(content);
    // The rest are exactly the reported survivors.
    expect([...now.keys()].filter((id) => !want.has(id)).toSorted()).toEqual([late.id, lateComment.id].toSorted());

    // History was appended to, not rewritten; and the journal still rebuilds the current tables.
    const after = await snapshot(w.owner, w.ds1);
    expect(after.journal.slice(0, ds1Before.journal.length)).toEqual(ds1Before.journal);
    const added = await w.owner`SELECT command, via, actor_id, op, entity_id FROM records.journal WHERE datastore_id = ${w.ds1} AND seq > ${headBefore} ORDER BY ordinal`;
    expect(added.every((e) => e.command === "system.restoreDatastore" && e.via === "system" && e.actor_id === w.ada.id)).toBe(true);
    expect(added).toHaveLength(3);
    const full = await rebuiltContent(w.ds1, headBefore + 1);
    expect(Object.fromEntries(full)).toEqual(Object.fromEntries(await currentContent(w.ds1)));

    // Recorded: an audit event and outbox events for the issues.
    const [event] = await w.owner`SELECT operation, via, actor_principal_id, detail FROM records.audit_events WHERE datastore_id = ${w.ds1} AND operation = 'restoreDatastore'`;
    expect(event).toMatchObject({ via: "system", actor_principal_id: w.ada.id, detail: expect.objectContaining({ uptoSeq: restorePoint, changes: 3, cannotRemove: 2, reason: "test" }) });
    const events = await w.owner`SELECT event_type, entity_id FROM records.outbox WHERE datastore_id = ${w.ds1} AND occurred_at >= (SELECT at FROM records.audit_events WHERE operation = 'restoreDatastore' AND datastore_id = ${w.ds1})`;
    expect(events.map((e) => e.event_type).toSorted()).toEqual(["comment.created", "issue.updated", "issue.updated"]);

    // The other datastore: byte for byte.
    expect(await snapshot(w.owner, w.ds2)).toEqual(ds2Before);

    // A client that pulled before the damage converges through an ordinary delta.
    const pulled = await w.service.sync.pull(olive.caller, w.ds1, { clientGroupId: "restore-group-1", cookie: pullBefore.cookie });
    expect(pulled.patch[0]).not.toEqual({ op: "clear" });
    expect(pulled.patch.find((p) => p.op === "put" && p.key === `issue/${a.id}`)).toMatchObject({ value: { title: "Alpha 2", state: "todo", priority: "none" } });

    // Idempotent: a second restore to the same point finds nothing to do.
    const again = await restoreDatastore({ source: w.owner, target: w.owner, datastoreId: w.ds1, uptoSeq: restorePoint, actorId: w.ada.id });
    expect(again).toMatchObject({ applied: false, changes: [], seqs: [] });
  });

  it("resolves a time to the last seq whose whole prefix began by then", async () => {
    expect(await seqAtTime(w.owner, w.ds2, new Date("2000-01-01T00:00:00Z"))).toBe(0);
    expect(await seqAtTime(w.owner, w.ds2, new Date(Date.now() + 60_000))).toBe(await head(w.ds2));
    const [mid] = await w.owner`SELECT seq, occurred_at FROM records.journal WHERE datastore_id = ${w.ds2} ORDER BY seq LIMIT 1`;
    // JavaScript dates carry milliseconds; occurred_at carries microseconds.
    expect(await seqAtTime(w.owner, w.ds2, new Date((mid!.occurred_at as Date).getTime() + 1))).toBeGreaterThanOrEqual(Number(mid!.seq));
    const byTime = await restoreDatastore({ source: w.owner, target: w.owner, datastoreId: w.ds2, uptoTime: new Date(Date.now() + 60_000), actorId: w.ada.id, dryRun: true });
    expect(byTime).toMatchObject({ uptoSeq: await head(w.ds2), changes: [], cannotRemove: [] });
  });

  it("refuses bad points, wrong actors and a source with a different history", async () => {
    const base = { source: w.owner, target: w.owner, datastoreId: w.ds2, actorId: w.ada.id };
    await expect(restoreDatastore({ ...base, uptoSeq: (await head(w.ds2)) + 1 })).rejects.toThrow(/cannot restore to seq/);
    await expect(restoreDatastore({ ...base, uptoSeq: 1, uptoTime: new Date() })).rejects.toThrow(/exactly one/);
    await expect(restoreDatastore({ ...base, uptoSeq: 1, actorId: crypto.randomUUID() })).rejects.toThrow(/principal of the datastore/);

    // A "branch" from another database: same datastore ID and organisation, different history.
    const other = await createTestDatabase(inject("pgSuperuserUrl"));
    const branch = postgres(other.ownerUrl, { max: 1, onnotice: () => {} });
    try {
      await branch.begin(async (tx) => {
        await tx`INSERT INTO records.organisations (id, name) VALUES (${w.orgA}, 'Org A')`;
        await tx`INSERT INTO records.principals (org_id, id, kind, display_name) VALUES (${w.orgA}, ${w.ada.id}, 'human', 'Ada')`;
        await tx`INSERT INTO records.datastores (org_id, id, name, module_id, api_major, owner_principal_id, retention_policy, created_by)
                 VALUES (${w.orgA}, ${w.ds2}, 'Elsewhere', 'projects', 1, ${w.ada.id}, 'keep', ${w.ada.id})`;
        const project = crypto.randomUUID();
        await tx`UPDATE records.datastore_clock SET seq = 1 WHERE datastore_id = ${w.ds2}`;
        await tx`INSERT INTO projects.projects (org_id, datastore_id, id, key, name, created_by, updated_by, last_seq)
                 VALUES (${w.orgA}, ${w.ds2}, ${project}, 'OPS', 'Ops', ${w.ada.id}, ${w.ada.id}, 1)`;
        await tx`INSERT INTO records.journal (org_id, datastore_id, seq, ordinal, change_id, command, command_id, entity_type, entity_id, entity_rev, op, after, actor_id, via)
                 VALUES (${w.orgA}, ${w.ds2}, 1, 0, gen_random_uuid(), 'projects.createProject', gen_random_uuid(), 'project', ${project}, 1, 'create',
                         ${tx.json({ key: "OPS", name: "Ops", description: "" })}, ${w.ada.id}, 'system')`;
      });
      await expect(restoreDatastore({ ...base, source: branch, uptoSeq: 1 })).rejects.toThrow(/differs from the target's/);
    } finally {
      await branch.end();
    }
  });
});
