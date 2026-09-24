// Last-write-wins edits and transitions for the Jira surface (canonical plan §7): allowed only for
// `via: 'jira'` with `lastWriteWins`, still journaled with before/after, still workflow-checked.
// Every other channel keeps requiring an expected revision.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Issue } from "@records/contracts";

import { code, createWorld, key, type World } from "./world.js";

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => w?.close());

async function newIssue(): Promise<Issue> {
  return (await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "LWW" }, key("c"))).record;
}

describe("last write wins", () => {
  it("applies a Jira edit to the current revision and journals before/after", async () => {
    const issue = await newIssue();
    await w.service.projects.editIssue(w.ed.caller, w.ds1, { issueId: issue.id, expectedRevision: 1, patch: { title: "Native" } }, key("e"));
    const out = await w.service.commands.execute(w.ed.caller, w.ds1, {
      name: "projects.editIssue", input: { issueId: issue.id, patch: { title: "From Jira" } },
    }, { idempotencyKey: key("j"), via: "jira", lastWriteWins: true });
    expect(out.record).toMatchObject({ title: "From Jira", revision: 3 });
    const [entry] = await w.owner`
      SELECT via, entity_rev, after, before FROM records.journal WHERE entity_id = ${issue.id} ORDER BY seq DESC LIMIT 1`;
    expect(entry).toMatchObject({ via: "jira", entity_rev: 3, after: { title: "From Jira" }, before: { title: "Native" } });
  });

  it("replays the same keyed request instead of writing twice", async () => {
    const issue = await newIssue();
    const k = key("j");
    const run = () => w.service.commands.execute(w.ed.caller, w.ds1, {
      name: "projects.editIssue", input: { issueId: issue.id, patch: { priority: "high" } },
    }, { idempotencyKey: k, via: "jira", lastWriteWins: true });
    const first = await run();
    const again = await run();
    expect(again).toMatchObject({ replayed: true, seq: first.seq });
    expect((await w.service.projects.getIssue(w.ed.caller, w.ds1, issue.id)).revision).toBe(2);
  });

  it("still checks an explicit revision, and the workflow", async () => {
    const issue = await newIssue();
    expect(await code(w.service.commands.execute(w.ed.caller, w.ds1, {
      name: "projects.editIssue", input: { issueId: issue.id, expectedRevision: 9, patch: { title: "stale" } },
    }, { idempotencyKey: key("j"), via: "jira", lastWriteWins: true }))).toBe("revision_conflict");
    expect(await code(w.service.commands.execute(w.ed.caller, w.ds1, {
      name: "projects.transitionIssue", input: { issueId: issue.id, toState: "done" },
    }, { idempotencyKey: key("j"), via: "jira", lastWriteWins: true }))).toBe("workflow_conflict");
    const moved = await w.service.commands.execute(w.ed.caller, w.ds1, {
      name: "projects.transitionIssue", input: { issueId: issue.id, toState: "todo" },
    }, { idempotencyKey: key("j"), via: "jira", lastWriteWins: true });
    expect(moved.record).toMatchObject({ state: "todo", revision: 2 });
  });

  it("is refused on every other channel, and without the option", async () => {
    const issue = await newIssue();
    const attempt = (opts: { via?: "http" | "sync" | "jira"; lastWriteWins?: boolean }) =>
      code(w.service.commands.execute(w.ed.caller, w.ds1, {
        name: "projects.editIssue", input: { issueId: issue.id, patch: { title: "no revision" } },
      }, { idempotencyKey: key("x"), ...opts }));
    expect(await attempt({ via: "http", lastWriteWins: true })).toBe("revision_required");
    expect(await attempt({ via: "sync", lastWriteWins: true })).toBe("revision_required");
    expect(await attempt({ via: "jira" })).toBe("revision_required");
    expect(await attempt({})).toBe("revision_required");
  });

  it("still needs the permission: a reader cannot edit through Jira", async () => {
    const issue = await newIssue();
    expect(await code(w.service.commands.execute(w.rae.caller, w.ds1, {
      name: "projects.editIssue", input: { issueId: issue.id, patch: { title: "reader" } },
    }, { idempotencyKey: key("r"), via: "jira", lastWriteWins: true }))).toBe("forbidden");
  });
});
