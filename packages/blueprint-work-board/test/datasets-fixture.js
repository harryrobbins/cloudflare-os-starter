// A seeded datastore read the way the gadget server reads it (snapshot, then the whole journal
// backfilled into per-record history), for dataset and insights tests.
import { FakeRecords } from "./fake-records.js";
import { seedWork } from "../harness/seed.js";
import { createReplica } from "../src/shared/replica.js";
import { buildIndex } from "../src/shared/model/index.js";

export const NOW = Date.parse("2026-09-26T12:00:00Z");

/**
 * @param {{ items?: number, records?: (fake: FakeRecords) => void, now?: number }} [o]
 */
export async function seededContext(o = {}) {
  const now = o.now ?? NOW;
  const fake = new FakeRecords({ now: () => now });
  if (o.items) seedWork(fake, { items: o.items, now });
  o.records?.(fake);
  const replica = createReplica({ now: () => now });
  const source = fake.session();
  await replica.load(source);
  while (!(await replica.backfillHistory(source, 50)));
  const index = buildIndex(replica.records.values(), { planning: true, label: "Team work", times: replica.times });
  return { fake, replica, index, ctx: { index, viewer: null, now, today: new Date(now).toISOString().slice(0, 10), history: replica.history, historyComplete: true } };
}
