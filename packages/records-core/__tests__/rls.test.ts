// The database as a second line (acceptance scenarios §11.4 and §11.5). Everything here runs as
// the runtime app role through withContext, deliberately skipping authorize(), as a service with a
// broken authorisation check would.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CallerContext } from "@records/contracts";

import { commitPlan, contextOf, PROJECTS_HANDLERS, uuidv7, withContext, type Tx } from "../src/index.js";
import { createWorld, key, type World } from "./world.js";

let w: World;
let issueId: string;
beforeAll(async () => {
  w = await createWorld();
  issueId = (await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Guarded" }, key())).record.id;
  await w.service.projects.addComment(w.ed.caller, w.ds1, { issueId, body: "Private" }, key());
});
afterAll(async () => w?.close());

/**
 * Raw SQL as the app role with a caller's context and NO authorisation check. withContext maps an
 * RLS violation (42501) to `internal: … not permitted`; a row hidden from FOR UPDATE by RLS shows
 * up as the handler's own not_found.
 */
const unchecked = <T>(caller: CallerContext, datastoreId: string, fn: (tx: Tx) => Promise<T>) =>
  withContext(w.app, contextOf(caller, datastoreId), fn, 1);

const counts = (caller: CallerContext, ds = w.ds1) => unchecked(caller, ds, async (tx) => {
  const [r] = await tx`
    SELECT (SELECT count(*)::int FROM projects.projects) AS projects, (SELECT count(*)::int FROM projects.issues) AS issues,
           (SELECT count(*)::int FROM projects.comments) AS comments, (SELECT count(*)::int FROM projects.workflow_states) AS states,
           (SELECT count(*)::int FROM records.journal) AS journal`;
  return r;
});

/** Run a real handler and commit without authorize(): only RLS stands in the way. */
const forcedCreate = (caller: CallerContext, ds: string, projectId: string) => unchecked(caller, ds, async (tx) => {
  const h = PROJECTS_HANDLERS["projects.createIssue"];
  const plan = await h.prepare(tx, caller, ds, h.parse({ projectId, title: "Forced" }));
  return commitPlan(tx, caller, ds, { command: "projects.createIssue", commandId: uuidv7(), via: "system" }, plan);
});

describe("principal RLS with authorisation skipped (§11.5)", () => {
  it("a member sees the rows (control)", async () => {
    expect(await counts(w.rae.caller)).toMatchObject({ projects: 1, issues: 1, comments: 1, states: 5 });
  });

  it("a principal with no membership reads nothing and cannot write", async () => {
    expect(await counts(w.nia.caller)).toEqual({ projects: 0, issues: 0, comments: 0, states: 0, journal: 0 });
    // The handler cannot even find the project it would allocate from.
    await expect(forcedCreate(w.nia.caller, w.ds1, w.eng)).rejects.toThrow(/Unknown project/);
    // A hand-written insert is refused outright.
    await expect(unchecked(w.nia.caller, w.ds1, (tx) => tx`
      INSERT INTO projects.comments (org_id, datastore_id, id, issue_id, body, author_id, last_seq)
      VALUES (${w.orgA}, ${w.ds1}, ${crypto.randomUUID()}, ${issueId}, 'sneaky', ${w.nia.id}, 1)`)).rejects.toThrow(/not permitted/);
    await expect(unchecked(w.nia.caller, w.ds1, (tx) => tx`
      UPDATE records.datastore_clock SET seq = seq + 1 RETURNING seq`)).resolves.toHaveLength(0);
  });

  it("the data administrator's provisioning right ends with the creating transaction", async () => {
    expect(await counts(w.ada.caller)).toEqual({ projects: 0, issues: 0, comments: 0, states: 0, journal: 0 });
    await expect(unchecked(w.ada.caller, w.ds1, (tx) => tx`
      INSERT INTO projects.workflow_states (org_id, datastore_id, key, name, category, position)
      VALUES (${w.orgA}, ${w.ds1}, 'sneaky', 'Sneaky', 'todo', 9)`)).rejects.toThrow(/not permitted/);
  });

  it("a member of another datastore cannot reach this one by switching the datastore context", async () => {
    const outsider = (await w.service.registry.invitePrincipal(w.ada.caller, { email: "otto@a.test", displayName: "Otto" })).id;
    const ds3 = (await w.service.registry.createDatastore(w.ada.caller, { name: "Otto's", moduleId: "projects", ownerPrincipalId: outsider })).id;
    const otto: CallerContext = { orgId: w.orgA, principalId: outsider, via: "management" };
    expect(await counts(otto, ds3)).toMatchObject({ states: 5 });
    expect(await counts(otto, w.ds1)).toEqual({ projects: 0, issues: 0, comments: 0, states: 0, journal: 0 });
    await expect(forcedCreate(otto, w.ds1, w.eng)).rejects.toThrow(/Unknown project/);
  });

  it("narrowing scopes are enforced by the database, not only by authorize()", async () => {
    const projectsOnly: CallerContext = { ...w.ed.caller, scopes: ["projects.read"] };
    expect(await counts(projectsOnly)).toMatchObject({ projects: 1, issues: 0, comments: 0, journal: 0 });
    await expect(forcedCreate(projectsOnly, w.ds1, w.eng)).rejects.toThrow(/Unknown project|not permitted/);

    const readOnly: CallerContext = { ...w.ed.caller, scopes: ["projects.read", "issues.read"] };
    expect(await counts(readOnly)).toMatchObject({ issues: 1, comments: 1 });
    await expect(forcedCreate(readOnly, w.ds1, w.eng)).rejects.toThrow(/Unknown project|not permitted/);
    await expect(unchecked(readOnly, w.ds1, (tx) => tx`UPDATE projects.issues SET title = 'x', last_seq = last_seq + 1000 WHERE id = ${issueId}`))
      .resolves.toHaveLength(0);
  });

  it("a binding narrows in the database too, and a revoked one stops at once", async () => {
    const binding = await w.service.registry.createGadgetBinding(w.ed.caller, w.ds1, { label: "Reader", scopes: ["projects.read", "issues.read"] });
    const viaBinding: CallerContext = { ...w.ed.caller, via: "gadget", bindingId: binding.id };
    // Claimed scopes cannot widen the stored binding.
    const widened: CallerContext = { ...viaBinding, scopes: ["issues.create"] };
    expect(await counts(viaBinding)).toMatchObject({ issues: 1 });
    await expect(forcedCreate(widened, w.ds1, w.eng)).rejects.toThrow(/Unknown project|not permitted/);
    await expect(forcedCreate(viaBinding, w.ds1, w.eng)).rejects.toThrow(/Unknown project|not permitted/);
    await w.service.registry.revokeBinding(w.ed.caller, binding.id);
    expect(await counts(viaBinding)).toEqual({ projects: 0, issues: 0, comments: 0, states: 0, journal: 0 });
  });

  it("an editor with no narrowing can do all of it (control)", async () => {
    const out = await forcedCreate(w.ed.caller, w.ds1, w.eng);
    expect(out.seq).toBeGreaterThan(0);
  });
});

describe("journal presence (§11.4) and immutability, as the app role", () => {
  it("a current-row insert with no journal entry fails at commit", async () => {
    let reachedCommit = false;
    await expect(unchecked(w.ed.caller, w.ds1, async (tx) => {
      const [{ seq }] = (await tx`UPDATE records.datastore_clock SET seq = seq + 1 RETURNING seq`) as unknown as [{ seq: string }];
      await tx`INSERT INTO projects.comments (org_id, datastore_id, id, issue_id, body, author_id, last_seq)
               VALUES (${w.orgA}, ${w.ds1}, ${crypto.randomUUID()}, ${issueId}, 'unjournaled', ${w.ed.id}, ${seq})`;
      reachedCommit = true; // every statement succeeded; only COMMIT is left
    })).rejects.toThrow(/could not be recorded|no journal entry/);
    expect(reachedCommit).toBe(true);
    expect((await counts(w.rae.caller)).comments).toBe(1);
  });

  it("an update that advances last_seq to a seq with no entry fails at commit", async () => {
    await expect(unchecked(w.ed.caller, w.ds1, async (tx) => {
      await tx`UPDATE projects.issues SET title = 'Silently', revision = revision + 1, last_seq = last_seq + 100000 WHERE id = ${issueId}`;
    })).rejects.toThrow(/could not be recorded|no journal entry/);
  });

  it("an update that changes content without advancing last_seq is refused immediately", async () => {
    await expect(unchecked(w.ed.caller, w.ds1, (tx) => tx`UPDATE projects.issues SET title = 'Silently' WHERE id = ${issueId}`))
      .rejects.toThrow(/could not be recorded|advance last_seq/);
  });

  it("an entry naming a different entity does not satisfy the check", async () => {
    await expect(unchecked(w.ed.caller, w.ds1, async (tx) => {
      const [{ seq }] = (await tx`UPDATE records.datastore_clock SET seq = seq + 1 RETURNING seq`) as unknown as [{ seq: string }];
      await tx`UPDATE projects.issues SET title = 'Misfiled', revision = revision + 1, last_seq = ${seq} WHERE id = ${issueId}`;
      await tx`INSERT INTO records.journal (org_id, datastore_id, seq, ordinal, change_id, command, command_id, entity_type, entity_id, entity_rev, op, after, actor_id, via)
               VALUES (${w.orgA}, ${w.ds1}, ${seq}, 0, ${uuidv7()}, 'projects.editIssue', ${uuidv7()}, 'issue', ${crypto.randomUUID()}, 2, 'update', '{}', ${w.ed.id}, 'system')`;
    })).rejects.toThrow(/could not be recorded|no journal entry/);
  });

  it("the app role cannot update or delete journal entries", async () => {
    await expect(unchecked(w.olive.caller, w.ds1, (tx) => tx`UPDATE records.journal SET after = '{}'`)).rejects.toThrow(/not permitted/);
    await expect(unchecked(w.olive.caller, w.ds1, (tx) => tx`DELETE FROM records.journal`)).rejects.toThrow(/not permitted/);
    const [row] = await w.owner`SELECT count(*)::int AS n FROM records.journal WHERE datastore_id = ${w.ds1}`;
    expect(row!.n).toBeGreaterThan(0);
  });
});
