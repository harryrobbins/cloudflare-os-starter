// Rebuild-and-compare (canonical plan §3): current tables are a cache of the journal. Apply a
// random mix of commands (including ones that fail), rebuild projects, issues and comments purely
// from journal rows, and compare with the current tables field by field.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { settle } from "../src/index.js";
import { createWorld, key, type Person, type World } from "./world.js";

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => w?.close());

/** Deterministic PRNG so a failure reproduces. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Entity = Record<string, unknown>;

/** Fold journal entries into entity state, knowing nothing but the journal. */
function rebuild(entries: Record<string, unknown>[]): Map<string, Entity> {
  const state = new Map<string, Entity>();
  for (const e of entries) {
    const id = e.entity_id as string;
    const at = (e.occurred_at as Date).toISOString();
    const meta = { type: e.entity_type, rev: e.entity_rev, lastSeq: String(e.seq), updatedBy: e.actor_id, updatedAt: at };
    if (e.op === "create") {
      if (state.has(id)) throw new Error(`created twice: ${id}`);
      state.set(id, { ...(e.after as Entity), ...meta, createdBy: e.actor_id, createdAt: at });
    } else if (e.op === "update") {
      const cur = state.get(id);
      if (!cur) throw new Error(`update before create: ${id}`);
      if (e.entity_rev !== (cur.rev as number) + 1) throw new Error(`revision gap on ${id}`);
      state.set(id, { ...cur, ...(e.after as Entity), ...meta });
    } else {
      throw new Error(`unexpected op ${e.op as string}`);
    }
  }
  return state;
}

describe("rebuild and compare", () => {
  it("rebuilds projects, issues and comments exactly from the journal after a random mix of commands", async () => {
    const rand = mulberry32(20260924);
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const writers: Person[] = [w.olive, w.ed];
    await w.owner`INSERT INTO projects.custom_fields (org_id, datastore_id, key, name, type, options) VALUES
      (${w.orgA}, ${w.ds1}, 'points', 'Points', 'number', '{}'), (${w.orgA}, ${w.ds1}, 'size', 'Size', 'enum', '{S,M,L}')`;
    const projects = [w.eng];
    const issues: { id: string; rev: number }[] = [];
    const states = ["backlog", "todo", "in_progress", "in_review", "done"];
    let applied = 0;
    let refused = 0;

    for (let i = 0; i < 160; i++) {
      const who = pick(writers);
      const roll = rand();
      let result;
      if (roll < 0.05) {
        result = await w.service.projects.createProject(w.olive.caller, w.ds1, { key: `P${i}`, name: `Project ${i}`, description: rand() < 0.5 ? "" : `About ${i}` })
          .then((p) => { projects.push(p.id); return { status: "applied" }; }, () => ({ status: "rejected" }));
      } else if (roll < 0.3 || issues.length === 0) {
        const id = rand() < 0.5 ? crypto.randomUUID() : undefined;
        result = await settle(w.service.commands.execute(who.caller, w.ds1, {
          name: "projects.createIssue",
          input: {
            ...(id ? { id } : {}), projectId: pick(projects), title: `Issue ${i}`, description: rand() < 0.3 ? `Details ${i}` : "",
            priority: pick(["none", "low", "medium", "high", "urgent"]), assigneeId: rand() < 0.3 ? pick([w.ed.id, w.rae.id]) : null,
            customFields: rand() < 0.4 ? { points: Math.floor(rand() * 8) } : {},
          },
        }, { idempotencyKey: key() }));
        if (result.status === "applied") issues.push({ id: (result.record as { id: string }).id, rev: 1 });
      } else if (roll < 0.6) {
        const target = pick(issues);
        const stale = rand() < 0.15;
        const patch: Record<string, unknown> = {};
        if (rand() < 0.6) patch.title = `Edited ${i}`;
        if (rand() < 0.3) patch.description = `Desc ${i}`;
        if (rand() < 0.3) patch.priority = pick(["none", "low", "medium", "high", "urgent"]);
        if (rand() < 0.3) patch.assigneeId = rand() < 0.5 ? null : pick([w.ed.id, w.olive.id]);
        if (rand() < 0.3) patch.customFields = rand() < 0.5 ? { size: pick(["S", "M", "L"]) } : { points: Math.floor(rand() * 8), size: null };
        if (Object.keys(patch).length === 0) patch.title = `Edited ${i}`;
        result = await settle(w.service.commands.execute(who.caller, w.ds1, {
          name: "projects.editIssue", input: { issueId: target.id, patch },
        }, { idempotencyKey: key(), expectedRevision: stale ? Math.max(1, target.rev - 1) : target.rev }));
        if (result.status === "applied") target.rev += 1;
      } else if (roll < 0.85) {
        const target = pick(issues);
        result = await settle(w.service.commands.execute(who.caller, w.ds1, {
          name: "projects.transitionIssue", input: { issueId: target.id, expectedRevision: target.rev, toState: pick(states) },
        }, { idempotencyKey: key() }));
        if (result.status === "applied") target.rev += 1;
      } else {
        result = await settle(w.service.commands.execute(pick([...writers]).caller, w.ds1, {
          name: "projects.addComment", input: { issueId: pick(issues).id, body: `Comment ${i}` },
        }, { idempotencyKey: key() }));
      }
      if (result.status === "applied") applied++;
      else refused++;
    }
    expect(applied).toBeGreaterThan(80);
    expect(refused).toBeGreaterThan(5); // workflow and revision conflicts are part of the mix

    const entries = await w.owner`
      SELECT seq, ordinal, entity_type, entity_id, entity_rev, op, after, actor_id, occurred_at
        FROM records.journal WHERE datastore_id = ${w.ds1} ORDER BY seq, ordinal`;
    // Gapless from 1.
    expect(entries.map((e) => Number(e.seq))).toEqual(entries.map((_, i) => i + 1));
    const rebuilt = rebuild(entries);

    const projectRows = await w.owner`
      SELECT id, key, name, description, revision, last_seq, created_by, updated_by, created_at, updated_at
        FROM projects.projects WHERE datastore_id = ${w.ds1}`;
    const issueRows = await w.owner`
      SELECT i.id, i.project_id, i.number, p.key || '-' || i.number AS key, i.title, i.description, i.state, i.priority, i.assignee_id,
             i.custom_fields, i.revision, i.last_seq, i.created_by, i.updated_by, i.created_at, i.updated_at
        FROM projects.issues i JOIN projects.projects p ON p.id = i.project_id WHERE i.datastore_id = ${w.ds1}`;
    const commentRows = await w.owner`
      SELECT id, issue_id, body, author_id, last_seq, created_at FROM projects.comments WHERE datastore_id = ${w.ds1}`;

    const current = new Map<string, Entity>();
    for (const r of projectRows) {
      current.set(r.id as string, {
        type: "project", key: r.key, name: r.name, description: r.description, rev: r.revision, lastSeq: r.last_seq,
        createdBy: r.created_by, createdAt: (r.created_at as Date).toISOString(),
        // A project's revision and updated_* change only with journaled project updates (none yet).
        updatedBy: r.updated_by, updatedAt: (r.updated_at as Date).toISOString(),
      });
    }
    for (const r of issueRows) {
      current.set(r.id as string, {
        type: "issue", projectId: r.project_id, number: r.number, key: r.key, title: r.title, description: r.description, state: r.state,
        priority: r.priority, assigneeId: r.assignee_id, customFields: r.custom_fields, rev: r.revision, lastSeq: r.last_seq,
        createdBy: r.created_by, updatedBy: r.updated_by, createdAt: (r.created_at as Date).toISOString(), updatedAt: (r.updated_at as Date).toISOString(),
      });
    }
    for (const r of commentRows) {
      const at = (r.created_at as Date).toISOString();
      current.set(r.id as string, {
        type: "comment", issueId: r.issue_id, body: r.body, authorId: r.author_id, rev: 1, lastSeq: r.last_seq,
        createdBy: r.author_id, updatedBy: r.author_id, createdAt: at, updatedAt: at,
      });
    }

    expect(current.size).toBe(rebuilt.size);
    expect(Object.fromEntries(rebuilt)).toEqual(Object.fromEntries(current));
  });
});
