// Redaction (canonical plan §8, "Erasure"): the one sanctioned exception to journal immutability.
// It overwrites free text in the current row, in past journal entries and in saved outcomes, as the
// migration owner only, and records a `redact` entry, an audit event and a ledger row. No other role
// and no other path can rewrite the journal, the owner included.

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { createTestDatabase } from "@records/schema/testing";

import { previewRedaction, rebuildAt, redact, restoreDatastore } from "../src/ops/index.js";
import { createWorld, key, type World } from "./world.js";

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => w?.close());

const SECRET = "Jane Doe 07700 900123";

async function issueWithSecret() {
  const createKey = key();
  const input = { projectId: w.eng, title: `Call ${SECRET}`, description: `Notes about ${SECRET}` };
  const issue = (await w.service.projects.createIssue(w.ed.caller, w.ds1, input, createKey)).record;
  await w.service.projects.editIssue(w.ed.caller, w.ds1, { issueId: issue.id, expectedRevision: 1, patch: { title: `Call ${SECRET} again` } }, key());
  const comment = (await w.service.projects.addComment(w.ed.caller, w.ds1, { issueId: issue.id, body: `About ${SECRET}` }, key())).record;
  return { issue, comment, createKey, input };
}

describe("redaction", () => {
  it("removes the text everywhere it was recorded and journals the redaction", async () => {
    const { issue, comment, createKey, input } = await issueWithSecret();
    // A copy of the journal as it stood before the redaction: an older "branch" to restore from.
    const beforeRedaction = await w.owner`SELECT * FROM records.journal WHERE datastore_id = ${w.ds1} ORDER BY seq, ordinal`;
    const restorePoint = Number(beforeRedaction.at(-1)!.seq);

    const target = { datastoreId: w.ds1, entityType: "issue" as const, entityId: issue.id, fields: ["title", "description"], reason: "Erasure request 42", actorId: w.ada.id };
    const preview = await previewRedaction(w.owner, target);
    expect(preview).toMatchObject({ exists: true, journalEntries: 2, currentLengths: { title: `Call ${SECRET} again`.length } });
    expect(preview.idempotencyRows).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(preview)).not.toContain("Jane");

    const [{ seq: headBefore }] = (await w.owner`SELECT seq FROM records.datastore_clock WHERE datastore_id = ${w.ds1}`) as unknown as [{ seq: string }];
    const result = await redact(w.owner, target);
    expect(result).toMatchObject({ seq: Number(headBefore) + 1, journalEntries: 2 });

    // Current row, journal, saved outcomes: no trace of the text for this issue.
    const [row] = await w.owner`SELECT title, description, revision, last_seq FROM projects.issues WHERE id = ${issue.id}`;
    expect(row).toEqual({ title: "[redacted]", description: "[redacted]", revision: 3, last_seq: String(result.seq) });
    const issueEntries = await w.owner`SELECT after::text || coalesce(before::text, '') AS t FROM records.journal WHERE entity_id = ${issue.id}`;
    expect(issueEntries.some((e) => (e.t as string).includes("Jane"))).toBe(false);
    const outcomes = await w.owner`SELECT outcome::text AS t FROM records.idempotency_keys WHERE outcome::text LIKE ${`%${issue.id}%`}`;
    expect(outcomes.length).toBeGreaterThanOrEqual(2);
    expect(outcomes.some((o) => (o.t as string).includes(`Call ${SECRET}`))).toBe(false);
    // Other records are untouched: the comment was not named.
    expect((await w.owner`SELECT body FROM projects.comments WHERE id = ${comment.id}`)[0]!.body).toBe(`About ${SECRET}`);

    // The redaction itself is recorded.
    const [entry] = await w.owner`SELECT command, op, via, actor_id, after, before, entity_rev FROM records.journal WHERE datastore_id = ${w.ds1} AND seq = ${result.seq}`;
    expect(entry).toEqual({ command: "system.redact", op: "redact", via: "system", actor_id: w.ada.id, after: { title: "[redacted]", description: "[redacted]" }, before: null, entity_rev: 3 });
    const [audit] = await w.owner`SELECT operation, via, target_id, detail FROM records.audit_events WHERE operation = 'redact' AND target_id = ${issue.id}`;
    expect(audit).toMatchObject({ via: "system", detail: { fields: ["description", "title"], reason: "Erasure request 42", journalEntries: 2 } });
    expect(await w.owner`SELECT fields, marker FROM records_ops.redactions WHERE entity_id = ${issue.id}`).toEqual([{ fields: ["description", "title"], marker: "[redacted]" }]);

    // Readers see the marker; a replayed create returns the redacted outcome; the journal still rebuilds.
    const replay = await w.service.projects.createIssue(w.ed.caller, w.ds1, input, createKey);
    expect(replay).toMatchObject({ replayed: true, record: { id: issue.id, title: "[redacted]" } });
    const fold = await rebuildAt(w.owner, w.ds1, result.seq);
    expect(fold.state.get(issue.id)!.fields).toMatchObject({ title: "[redacted]", description: "[redacted]" });
    const pulled = await w.service.sync.pull(w.olive.caller, w.ds1, { clientGroupId: "redact-group-1", cookie: null });
    expect(pulled.patch.find((p) => p.op === "put" && p.key === `issue/${issue.id}`)).toMatchObject({ value: { title: "[redacted]", description: "[redacted]", revision: 3 } });

    // A restore from a branch taken before the redaction does not bring the text back.
    const other = await createTestDatabase(inject("pgSuperuserUrl"));
    const branch = postgres(other.ownerUrl, { max: 1, onnotice: () => {} });
    try {
      await branch.begin(async (tx) => {
        for (const table of ["organisations", "principals", "datastores"] as const) {
          const rows = table === "organisations"
            ? await w.owner`SELECT * FROM records.organisations WHERE id = ${w.orgA}`
            : table === "principals"
              ? await w.owner`SELECT * FROM records.principals WHERE org_id = ${w.orgA} ORDER BY owner_principal_id NULLS FIRST`
              : await w.owner`SELECT * FROM records.datastores WHERE id = ${w.ds1}`;
          await tx`INSERT INTO ${tx("records")}.${tx(table)} SELECT * FROM jsonb_populate_recordset(NULL::${tx.unsafe(`records.${table}`)}, ${tx.json(rows as never)})`;
        }
        await tx`INSERT INTO records.journal SELECT * FROM jsonb_populate_recordset(NULL::records.journal, ${tx.json(beforeRedaction as never)})`;
        await tx`UPDATE records.datastore_clock SET seq = ${restorePoint} WHERE datastore_id = ${w.ds1}`;
      });
      const report = await restoreDatastore({ source: branch, target: w.owner, datastoreId: w.ds1, uptoSeq: restorePoint, actorId: w.ada.id, dryRun: true });
      expect(report.redactionsReapplied).toBe(2);
      expect(report.changes.find((c) => c.entityId === issue.id)).toBeUndefined(); // already the marker: nothing to restore
      const applied = await restoreDatastore({ source: branch, target: w.owner, datastoreId: w.ds1, uptoSeq: restorePoint, actorId: w.ada.id });
      expect(JSON.stringify(applied)).not.toContain("Jane");
      expect((await w.owner`SELECT title FROM projects.issues WHERE id = ${issue.id}`)[0]!.title).toBe("[redacted]");
    } finally {
      await branch.end();
    }
  });

  it("redacts comments and projects; refuses other fields, unknown records and missing reasons", async () => {
    const { comment } = await issueWithSecret();
    await redact(w.owner, { datastoreId: w.ds1, entityType: "comment", entityId: comment.id, fields: ["body"], reason: "Erasure", actorId: w.ada.id, marker: "[removed]" });
    expect((await w.owner`SELECT body FROM projects.comments WHERE id = ${comment.id}`)[0]!.body).toBe("[removed]");
    const [entry] = await w.owner`SELECT entity_rev, after FROM records.journal WHERE entity_id = ${comment.id} AND op = 'redact'`;
    expect(entry).toEqual({ entity_rev: 1, after: { body: "[removed]" } });
    await redact(w.owner, { datastoreId: w.ds2, entityType: "project", entityId: w.ops, fields: ["description"], reason: "Tidy", actorId: w.ada.id });

    const base = { datastoreId: w.ds1, entityType: "issue" as const, entityId: comment.issueId, reason: "Erasure", actorId: w.ada.id };
    await expect(redact(w.owner, { ...base, fields: ["state"] })).rejects.toThrow(/subset/);
    await expect(w.owner`SELECT * FROM records_ops.redact(${w.ds1}::uuid, 'issue', ${comment.issueId}::uuid, '{state}', 'Erasure', ${w.ada.id}::uuid)`).rejects.toThrow(/subset/);
    await expect(w.owner`SELECT * FROM records_ops.redact(${w.ds1}::uuid, 'issue', ${comment.issueId}::uuid, '{title}', 'x', ${w.ada.id}::uuid)`).rejects.toThrow(/reason/);
    await expect(redact(w.owner, { ...base, entityId: crypto.randomUUID(), fields: ["title"] })).rejects.toThrow(/no issue/);
    await expect(redact(w.owner, { ...base, datastoreId: w.ds2, fields: ["title"] })).rejects.toThrow(/no issue/); // wrong datastore
    await expect(redact(w.owner, { ...base, actorId: crypto.randomUUID(), fields: ["title"] })).rejects.toThrow(/actor/);
  });

  it("cannot be used or imitated by any other role, and the owner cannot rewrite the journal outside it", async () => {
    // The app role cannot reach the procedure at all.
    const denied = await w.owner`
      SELECT has_schema_privilege('records_app', 'records_ops', 'USAGE') AS app_schema,
             has_function_privilege('records_app', 'records_ops.redact(uuid, text, uuid, text[], text, uuid, text)', 'EXECUTE') AS app_exec,
             has_function_privilege('records_publisher', 'records_ops.redact(uuid, text, uuid, text[], text, uuid, text)', 'EXECUTE') AS pub_exec,
             has_function_privilege('public', 'records_ops.redact(uuid, text, uuid, text[], text, uuid, text)', 'EXECUTE') AS public_exec`;
    expect(denied[0]).toEqual({ app_schema: false, app_exec: false, pub_exec: false, public_exec: false });
    const [row] = await w.owner`SELECT id FROM projects.issues WHERE datastore_id = ${w.ds1} LIMIT 1`;
    await expect(w.app.begin(async (tx) => {
      await tx`SELECT set_config('records.org_id', ${w.orgA}, true), set_config('records.datastore_id', ${w.ds1}, true),
                      set_config('records.principal_id', ${w.olive.id}, true), set_config('records.scopes', '*', true)`;
      await tx`SELECT * FROM records_ops.redact(${w.ds1}::uuid, 'issue', ${row!.id}::uuid, '{title}', 'Erasure', ${w.olive.id}::uuid)`;
    })).rejects.toThrow(/permission denied/);

    // Setting the flag does not help the app role: it has no UPDATE privilege on the journal.
    await expect(w.app.begin(async (tx) => {
      await tx`SELECT set_config('records.org_id', ${w.orgA}, true), set_config('records.datastore_id', ${w.ds1}, true),
                      set_config('records.principal_id', ${w.olive.id}, true), set_config('records.scopes', '*', true),
                      set_config('records.journal_redaction', 'on', true)`;
      await tx`UPDATE records.journal SET after = '{}' WHERE datastore_id = ${w.ds1}`;
    })).rejects.toThrow(/permission denied/);

    // Nor a role that was (wrongly) granted UPDATE and a policy: the trigger refuses every non-owner.
    const role = `journal_tamper_${crypto.randomUUID().slice(0, 8)}`;
    await w.owner.unsafe(`CREATE ROLE ${role} NOLOGIN; GRANT USAGE ON SCHEMA records TO ${role}; GRANT SELECT, UPDATE ON records.journal TO ${role};
                          CREATE POLICY tamper ON records.journal TO ${role} USING (true) WITH CHECK (true)`);
    try {
      await expect(w.owner.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        await tx`SELECT set_config('records.journal_redaction', 'on', true)`;
        await tx`UPDATE records.journal SET after = '{}' WHERE datastore_id = ${w.ds1}`;
      })).rejects.toThrow(/append-only/);
    } finally {
      await w.owner.unsafe(`DROP POLICY tamper ON records.journal; REVOKE ALL ON records.journal FROM ${role}; REVOKE ALL ON SCHEMA records FROM ${role}; DROP ROLE ${role}`);
    }

    // The owner itself: no journal UPDATE without the flag, and with it only after/before may change.
    await expect(w.owner`UPDATE records.journal SET after = '{}' WHERE datastore_id = ${w.ds1}`).rejects.toThrow(/append-only/);
    await expect(w.owner.begin(async (tx) => {
      await tx`SELECT set_config('records.journal_redaction', 'on', true)`;
      await tx`UPDATE records.journal SET via = 'system', after = '{}' WHERE datastore_id = ${w.ds1}`;
    })).rejects.toThrow(/append-only/);
  });
});
