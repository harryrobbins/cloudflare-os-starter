// Journal reads: the commit-ordered change feed (`GET …/changes?after=<seq>`) and one entity's
// history. Both need issues.read, checked by authorize() and again by the journal's RLS policy.
//
// Because seq is gapless and in commit order per datastore, "entries with seq > after" never skips
// a change that commits later: a transaction holding seq n blocks every later one on the clock row
// until it commits or rolls back. A page never splits one seq, so `nextAfter` is always a complete
// cursor. Pages are bounded by the clock head read at the start, so `head >= nextAfter`.
//
// Retention: journal partitions may one day be archived and detached (plan §8). The earliest
// retained seq is the smallest seq still present. `after = 0` is always valid while nothing has
// been purged (the journal still starts at seq 1); otherwise `after` must be at least the earliest
// retained seq minus one, or the caller must reload current state (`resetRequired`).

import {
  ChangesQuerySchema,
  JOURNAL_ENTITY_TYPES,
  parseInput,
  RecordsError,
  UuidSchema,
  type CallerContext,
  type ChangesPage,
  type JournalEntry,
} from "@records/contracts";
import { z } from "zod";

import { contextOf, withContext, type Db, type Tx } from "../db/context.js";
import { authorize } from "../domain/authorize.js";

type Row = Record<string, unknown>;

const HISTORY_LIMIT = 1000;

function toEntry(r: Row): JournalEntry {
  return {
    seq: Number(r.seq),
    ordinal: Number(r.ordinal),
    changeId: r.change_id as string,
    command: r.command as string,
    entityType: r.entity_type as JournalEntry["entityType"],
    entityId: r.entity_id as string,
    entityRev: r.entity_rev as number,
    op: r.op as JournalEntry["op"],
    after: r.after as Record<string, unknown>,
    before: (r.before as Record<string, unknown> | null) ?? null,
    actorId: r.actor_id as string,
    actId: (r.act_id as string | null) ?? null,
    via: r.via as JournalEntry["via"],
    occurredAt: (r.occurred_at as Date).toISOString(),
  };
}

function entrySelect(tx: Tx) {
  return tx`
    SELECT seq, ordinal, change_id, command, entity_type, entity_id, entity_rev, op, after, before,
           actor_id, act_id, via, occurred_at
      FROM records.journal`;
}

export class JournalReader {
  constructor(private readonly db: Db) {}

  async changes(caller: CallerContext, datastoreId: string, raw: unknown): Promise<ChangesPage> {
    const { after, limit } = parseInput(ChangesQuerySchema, raw ?? {});
    return withContext(this.db, contextOf(caller, datastoreId), async (tx) => {
      await authorize(tx, caller, datastoreId, "listIssues");
      const [clock] = await tx`SELECT seq FROM records.datastore_clock WHERE datastore_id = ${datastoreId}`;
      const head = clock ? Number(clock.seq) : 0;
      const [bounds] = await tx`SELECT min(seq) AS earliest FROM records.journal WHERE datastore_id = ${datastoreId}`;
      const earliest = bounds?.earliest == null ? null : Number(bounds.earliest);
      const purged = earliest === null ? head > 0 : earliest > 1;
      const resetRequired = after > head || (purged && after < (earliest ?? head + 1) - 1);
      if (resetRequired || after >= head) return { entries: [], nextAfter: after, head, resetRequired };

      const rows = await tx`${entrySelect(tx)}
        WHERE datastore_id = ${datastoreId} AND seq > ${after} AND seq <= ${head}
        ORDER BY seq, ordinal LIMIT ${limit + 1}`;
      let entries = rows.map(toEntry);
      if (entries.length > limit) {
        const page = entries.slice(0, limit);
        const lastSeq = page.at(-1)!.seq;
        const whole = page.filter((e) => e.seq !== lastSeq);
        if (entries[limit]!.seq !== lastSeq) entries = page; // the page ends on a seq boundary
        else if (whole.length > 0) entries = whole; // drop the trailing seq that continues past the page
        else {
          // One transaction with more entries than a page: return all of it.
          entries = (await tx`${entrySelect(tx)} WHERE datastore_id = ${datastoreId} AND seq = ${lastSeq} ORDER BY ordinal`).map(toEntry);
        }
      }
      return { entries, nextAfter: entries.at(-1)?.seq ?? after, head, resetRequired: false };
    });
  }

  async history(caller: CallerContext, datastoreId: string, entityType: string, entityId: string): Promise<JournalEntry[]> {
    const type = parseInput(z.enum(JOURNAL_ENTITY_TYPES), entityType);
    const id = parseInput(UuidSchema, entityId);
    return withContext(this.db, contextOf(caller, datastoreId), async (tx) => {
      await authorize(tx, caller, datastoreId, "listIssues");
      const rows = await tx`${entrySelect(tx)}
        WHERE datastore_id = ${datastoreId} AND entity_id = ${id} AND entity_type = ${type}
        ORDER BY seq, ordinal LIMIT ${HISTORY_LIMIT}`;
      if (rows.length === 0) throw new RecordsError("not_found", "No history for that record.");
      return rows.map(toEntry);
    });
  }
}
