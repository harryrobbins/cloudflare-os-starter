// The command bus: journal entries, attribution, idempotent replay, revisions, the change feed and
// entity history.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { JournalEntrySchema, type CallerContext, type Comment, type Issue } from "@records/contracts";

import { settle, uuidv7 } from "../src/index.js";
import { code, createWorld, key, type World } from "./world.js";

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => w?.close());

const journal = (ds: string) => w.owner`
  SELECT seq, ordinal, command, command_id, entity_type, entity_id, entity_rev, op, after, before, actor_id, act_id, via
    FROM records.journal WHERE datastore_id = ${ds} ORDER BY seq, ordinal`;

describe("uuidv7", () => {
  it("is a version 7, variant 10 UUID that sorts by time", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
    expect(a.slice(0, 13).replace("-", "")).toBe((1_700_000_000_000).toString(16).padStart(12, "0"));
  });
});

describe("execute", () => {
  it("creates projects through the bus too: createDatastore journaled the initial project", async () => {
    const rows = await journal(w.ds1);
    expect(rows[0]).toMatchObject({
      seq: "1", ordinal: 0, command: "projects.createProject", entity_type: "project", entity_id: w.eng, entity_rev: 1, op: "create",
      after: { key: "ENG", name: "Engineering", description: "" }, before: null, actor_id: w.ada.id, act_id: null, via: "management",
    });
  });

  it("journals each command with wire-named fields, attribution and the seq it committed at", async () => {
    const before = await w.service.journal.changes(w.olive.caller, w.ds1, {});
    const issueId = crypto.randomUUID();
    const created = await w.service.commands.execute(w.ed.caller, w.ds1, {
      name: "projects.createIssue",
      input: { id: issueId, projectId: w.eng, title: "Journaled", priority: "high", customFields: {} },
    }, { idempotencyKey: key(), via: "sync" });
    expect(created).toMatchObject({ status: "applied", replayed: false, seq: before.head + 1 });
    const issue = created.record as Issue;
    expect(issue.id).toBe(issueId); // the client-chosen ID is honoured

    const edited = await w.service.commands.execute(w.ed.caller, w.ds1, {
      name: "projects.editIssue", input: { issueId, patch: { title: "Journaled!", priority: "high", assigneeId: w.rae.id } },
    }, { idempotencyKey: key(), expectedRevision: 1 });
    expect(edited.seq).toBe(created.seq + 1);

    const moved = await w.service.commands.execute(w.ed.caller, w.ds1, {
      name: "projects.transitionIssue", input: { issueId, expectedRevision: 2, toState: "todo" },
    }, { idempotencyKey: key() });

    const commentId = crypto.randomUUID();
    const commented = await w.service.commands.execute(w.ed.caller, w.ds1, {
      name: "projects.addComment", input: { id: commentId, issueId, body: "Noted" },
    }, { idempotencyKey: key() });
    expect((commented.record as Comment).id).toBe(commentId);

    const rows = (await journal(w.ds1)).filter((r) => Number(r.seq) > before.head);
    expect(rows.map((r) => [Number(r.seq), r.command, r.op, r.entity_rev, r.via])).toEqual([
      [created.seq, "projects.createIssue", "create", 1, "sync"],
      [edited.seq, "projects.editIssue", "update", 2, "management"],
      [moved.seq, "projects.transitionIssue", "update", 3, "management"],
      [commented.seq, "projects.addComment", "create", 1, "management"],
    ]);
    expect(rows[0]!.after).toEqual({
      projectId: w.eng, number: issue.number, key: issue.key, title: "Journaled", description: "", state: "backlog",
      priority: "high", assigneeId: null, customFields: {},
    });
    // Only the fields that changed (priority was already high).
    expect(rows[1]!.after).toEqual({ title: "Journaled!", assigneeId: w.rae.id });
    expect(rows[1]!.before).toEqual({ title: "Journaled", assigneeId: null });
    expect(rows[2]!).toMatchObject({ after: { state: "todo" }, before: { state: "backlog" } });
    expect(rows[3]!.after).toEqual({ issueId, body: "Noted", authorId: w.ed.id });
    expect(rows.every((r) => r.actor_id === w.ed.id && r.act_id === null)).toBe(true);
    expect(new Set(rows.map((r) => r.command_id)).size).toBe(4);

    // Current rows name their journal entry.
    const [cur] = await w.owner`SELECT last_seq, revision FROM projects.issues WHERE id = ${issueId}`;
    expect(cur).toEqual({ last_seq: String(moved.seq), revision: 3 });
  });

  it("records the binding a call was made through as act_id", async () => {
    const binding = await w.service.registry.createGadgetBinding(w.ed.caller, w.ds1, { label: "Board", scopes: ["projects.read", "issues.read", "issues.create"] });
    const viaBinding: CallerContext = { ...w.ed.caller, via: "gadget", bindingId: binding.id };
    const out = await w.service.commands.execute(viaBinding, w.ds1, { name: "projects.createIssue", input: { projectId: w.eng, title: "Via gadget" } }, { idempotencyKey: key() });
    const [row] = await w.owner`SELECT actor_id, act_id, via FROM records.journal WHERE datastore_id = ${w.ds1} AND seq = ${out.seq}`;
    expect(row).toEqual({ actor_id: w.ed.id, act_id: binding.id, via: "gadget" });
  });

  it("merges customFields and journals the full merged object", async () => {
    await w.owner`INSERT INTO projects.custom_fields (org_id, datastore_id, key, name, type) VALUES
      (${w.orgA}, ${w.ds1}, 'points', 'Points', 'number'), (${w.orgA}, ${w.ds1}, 'team', 'Team', 'text')`;
    const { record } = await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Fields", customFields: { points: 3 } }, key());
    const edited = await w.service.projects.editIssue(w.ed.caller, w.ds1, { issueId: record.id, expectedRevision: 1, patch: { customFields: { team: "core" } } }, key());
    expect(edited.record.customFields).toEqual({ points: 3, team: "core" });
    const [row] = await w.owner`SELECT after, before FROM records.journal WHERE datastore_id = ${w.ds1} AND seq = ${edited.seq!}`;
    expect(row).toEqual({ after: { customFields: { points: 3, team: "core" } }, before: { customFields: { points: 3 } } });
  });

  it("an idempotent replay returns the same record, seq and command, and writes nothing", async () => {
    const k = key("replay");
    const input = { projectId: w.eng, title: "Once only" };
    const first = await w.service.commands.execute(w.ed.caller, w.ds1, { name: "projects.createIssue", input }, { idempotencyKey: k });
    const head = (await w.service.journal.changes(w.olive.caller, w.ds1, {})).head;
    const again = await w.service.commands.execute(w.ed.caller, w.ds1, { name: "projects.createIssue", input }, { idempotencyKey: k });
    expect(again).toEqual({ ...first, replayed: true });
    expect((await w.service.journal.changes(w.olive.caller, w.ds1, {})).head).toBe(head);
    // Through the v1 wrapper too.
    const wrapped = await w.service.projects.createIssue(w.ed.caller, w.ds1, input, k);
    expect(wrapped).toMatchObject({ replayed: true, seq: first.seq });
  });

  it("revisions: If-Match merges, disagreement is refused, absence is revision_required", async () => {
    const { record } = await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Rev" }, key());
    const cmd = (input: unknown, expectedRevision?: number) =>
      w.service.commands.execute(w.ed.caller, w.ds1, { name: "projects.editIssue", input }, { idempotencyKey: key(), ...(expectedRevision ? { expectedRevision } : {}) });
    expect(await code(cmd({ issueId: record.id, patch: { title: "x" } }))).toBe("revision_required");
    expect(await code(cmd({ issueId: record.id, expectedRevision: 1, patch: { title: "x" } }, 2))).toBe("validation_failed");
    expect(await code(cmd({ issueId: record.id, patch: { title: "x" } }, 1))).toBe("ok");
    const conflict = await settle(cmd({ issueId: record.id, patch: { title: "y" } }, 1));
    expect(conflict).toMatchObject({ status: "conflict", code: "revision_conflict", currentRevision: 2 });
    const rejected = await settle(w.service.commands.execute(w.rae.caller, w.ds1, { name: "projects.createIssue", input: { projectId: w.eng, title: "no" } }, { idempotencyKey: key() }));
    expect(rejected).toMatchObject({ status: "rejected", code: "forbidden" });
  });

  it("refuses unknown commands and missing idempotency keys", async () => {
    expect(await code(w.service.commands.execute(w.ed.caller, w.ds1, { name: "projects.dropTable" as never, input: {} }, { idempotencyKey: key() }))).toBe("validation_failed");
    expect(await code(w.service.commands.execute(w.ed.caller, w.ds1, { name: "projects.createIssue", input: { projectId: w.eng, title: "x" } }, {} as never))).toBe("validation_failed");
  });

  it("a client-chosen ID that already exists is a duplicate, not an overwrite", async () => {
    const id = crypto.randomUUID();
    await w.service.projects.createIssue(w.ed.caller, w.ds1, { id, projectId: w.eng, title: "Mine" }, key());
    expect(await code(w.service.projects.createIssue(w.ed.caller, w.ds1, { id, projectId: w.eng, title: "Theirs" }, key()))).toBe("duplicate");
    expect(await code(w.service.projects.createIssue(w.ed.caller, w.ds2, { id, projectId: w.ops, title: "Elsewhere" }, key()))).toBe("duplicate");
  });

  it("failed commands leave no journal entry and no gap in the clock", async () => {
    const head = (await w.service.journal.changes(w.olive.caller, w.ds1, {})).head;
    expect(await code(w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: crypto.randomUUID(), title: "x" }, key()))).toBe("not_found");
    const next = await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "After failure" }, key());
    expect(next.seq).toBe(head + 1);
  });
});

describe("changes and history", () => {
  it("pages the feed in seq order without splitting a seq, and reports the head", async () => {
    const all = await w.service.journal.changes(w.olive.caller, w.ds2, { after: 0, limit: 1000 });
    for (let i = 0; i < 5; i++) await w.service.projects.createIssue(w.ed.caller, w.ds2, { projectId: w.ops, title: `Feed ${i}` }, key());
    const pages: number[][] = [];
    let after = all.nextAfter;
    for (;;) {
      const page = await w.service.journal.changes(w.olive.caller, w.ds2, { after, limit: 2 });
      expect(page.resetRequired).toBe(false);
      if (page.entries.length === 0) {
        expect(page.nextAfter).toBe(after);
        expect(page.head).toBe(after);
        break;
      }
      for (const e of page.entries) JournalEntrySchema.parse(e);
      pages.push(page.entries.map((e) => e.seq));
      after = page.nextAfter;
    }
    expect(pages.flat()).toEqual([1, 2, 3, 4, 5].map((n) => all.head + n));
    expect(pages.every((p) => p.length <= 2)).toBe(true);
  });

  it("0 is always a valid cursor; a cursor ahead of the head needs a reset", async () => {
    const page = await w.service.journal.changes(w.olive.caller, w.ds1, { after: 0, limit: 5 });
    expect(page.entries[0]!.seq).toBe(1);
    expect(page.resetRequired).toBe(false);
    expect((await w.service.journal.changes(w.olive.caller, w.ds1, { after: page.head + 10 })).resetRequired).toBe(true);
  });

  it("reports resetRequired once entries before the cursor have been purged", async () => {
    // Simulate archival (plan §8) as the owner: drop ds2's first entries.
    const head = (await w.service.journal.changes(w.olive.caller, w.ds2, {})).head;
    await w.owner`DELETE FROM records.journal WHERE datastore_id = ${w.ds2} AND seq <= 2`;
    expect((await w.service.journal.changes(w.olive.caller, w.ds2, { after: 0 })).resetRequired).toBe(true);
    expect((await w.service.journal.changes(w.olive.caller, w.ds2, { after: 1 })).resetRequired).toBe(true);
    expect((await w.service.journal.changes(w.olive.caller, w.ds2, { after: 2 })).resetRequired).toBe(false);
    expect((await w.service.journal.changes(w.olive.caller, w.ds2, { after: head })).entries).toEqual([]);
  });

  it("history lists one entity's entries; both reads need issues.read", async () => {
    const { record } = await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "History" }, key());
    await w.service.projects.transitionIssue(w.ed.caller, w.ds1, { issueId: record.id, expectedRevision: 1, toState: "todo" }, key());
    const history = await w.service.journal.history(w.rae.caller, w.ds1, "issue", record.id);
    expect(history.map((e) => [e.op, e.entityRev])).toEqual([["create", 1], ["update", 2]]);

    const binding = await w.service.registry.createGadgetBinding(w.ed.caller, w.ds1, { label: "Projects only", scopes: ["projects.read"] });
    const narrow: CallerContext = { ...w.ed.caller, via: "gadget", bindingId: binding.id };
    expect(await code(w.service.journal.changes(narrow, w.ds1, {}))).toBe("forbidden");
    expect(await code(w.service.journal.history(narrow, w.ds1, "issue", record.id))).toBe("forbidden");
    expect(await code(w.service.journal.changes(w.nia.caller, w.ds1, {}))).toBe("not_found");
    expect(await code(w.service.journal.history(w.rae.caller, w.ds1, "widget", record.id))).toBe("validation_failed");
  });
});
