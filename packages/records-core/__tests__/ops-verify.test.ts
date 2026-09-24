// The restore rehearsal's verification query (scripts/records/verify.sql): it passes on a healthy
// database, after a redaction and a restore, and fails when a current row drifts from its journal.

import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { redact, restoreDatastore } from "../src/ops/index.js";
import { createWorld, key, type World } from "./world.js";

const VERIFY = readFileSync(new URL("../../../scripts/records/verify.sql", import.meta.url), "utf8");

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => w?.close());

type Check = { check: string; status: string; detail: string };
const failures = (rows: Check[]) => rows.filter((r) => r.status === "FAIL");

describe("verify.sql", () => {
  it("passes on a healthy database, including after a redaction and a restore", async () => {
    const issue = (await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Verify me", description: "text" }, key())).record;
    await w.service.projects.addComment(w.ed.caller, w.ds1, { issueId: issue.id, body: "a comment" }, key());
    const point = Number((await w.owner`SELECT seq FROM records.datastore_clock WHERE datastore_id = ${w.ds1}`)[0]!.seq);
    await w.service.projects.editIssue(w.ed.caller, w.ds1, { issueId: issue.id, expectedRevision: 1, patch: { priority: "high" } }, key());
    await redact(w.owner, { datastoreId: w.ds1, entityType: "issue", entityId: issue.id, fields: ["description"], reason: "Erasure", actorId: w.ada.id });
    await restoreDatastore({ source: w.owner, target: w.owner, datastoreId: w.ds1, uptoSeq: point, actorId: w.ada.id });

    const rows = (await w.owner.unsafe(VERIFY)) as unknown as Check[];
    expect(rows.map((r) => r.check)).toEqual([
      "migrations", "row_counts", "journal_partitions", "clock_matches_journal", "journal_gapless", "journal_presence", "journal_rebuild", "rls_enabled",
    ]);
    expect(failures(rows)).toEqual([]);
    expect(rows.find((r) => r.check === "journal_rebuild")!.detail).toMatch(/^2 datastores rebuilt from seq 1$/);
  });

  it("fails when a current row no longer matches its journal", async () => {
    const [row] = await w.owner`SELECT id FROM projects.issues WHERE datastore_id = ${w.ds1} LIMIT 1`;
    const rows = await w.owner.begin(async (tx) => {
      // Superuser only: bypass the triggers to simulate corruption, then roll it all back.
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE projects.issues SET title = 'Tampered' WHERE id = ${row!.id}`;
      await tx`UPDATE records.datastore_clock SET seq = seq + 5 WHERE datastore_id = ${w.ds2}`;
      const result = (await tx.unsafe(VERIFY)) as unknown as Check[];
      throw Object.assign(new Error("rollback"), { result });
    }).catch((err: { result?: Check[] }) => err.result!);
    expect(failures(rows).map((r) => r.check)).toEqual(["clock_matches_journal", "journal_rebuild"]);
    expect(failures(rows).find((r) => r.check === "journal_rebuild")!.detail).toContain(`${row!.id as string}.title`);
    // And nothing stuck.
    expect(failures((await w.owner.unsafe(VERIFY)) as unknown as Check[])).toEqual([]);
  });
});
