// @ts-check
// A realistic, deterministic work datastore for the harness and tests: people, a Triage state and
// a WIP limit, labels, projects, six two-week cycles around `now`, epics with sub-issues, items
// that moved through states over ~70 days by several people, blocking relations and comments.
// Everything is written through FakeRecords.run() with a controlled clock, so the journal carries
// realistic actors and times and the activity history is rich.

export const SEED_PEOPLE = Object.freeze([
  { id: "ada@example.com", displayName: "Ada Lovelace" },
  { id: "grace@example.com", displayName: "Grace Hopper" },
  { id: "alan@example.com", displayName: "Alan Turing" },
  { id: "katherine@example.com", displayName: "Katherine Johnson" },
  { id: "linus@example.com", displayName: "Linus Torvalds" },
  { id: "margaret@example.com", displayName: "Margaret Hamilton" },
]);

/** A small seeded PRNG. @param {number} a */
export function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
const LABELS = [
  ["bug", "Bug", "#d73a4a", "Something is broken"], ["feature", "Feature", "#5b6ee1", "New capability"],
  ["improvement", "Improvement", "#1f9d8b", "Make something better"], ["design", "Design", "#c75bd1", "Needs design input"],
  ["docs", "Docs", "#3b82c4", "Documentation"], ["performance", "Performance", "#e0891b", "Speed and efficiency"],
  ["security", "Security", "#b3261e", "Security relevant"], ["tech-debt", "Tech debt", "#7a6f5a", "Clean-up work"],
  ["customer", "Customer", "#2f9e5b", "Reported by a customer"],
];
const PROJECTS = [
  ["Website relaunch", "New marketing site with a faster, accessible design system.", "active", 0, "#5b6ee1"],
  ["Mobile app", "Native shell around the web app with offline support.", "active", 1, "#1f9d8b"],
  ["Billing v2", "Usage-based billing, invoices and dunning.", "active", 3, "#e0891b"],
  ["Onboarding", "Get new teams to their first board in five minutes.", "planned", 5, "#c75bd1"],
  ["Platform reliability", "SLOs, alerting and incident tooling.", "paused", 2, "#b3261e"],
];
const VERBS = ["Fix", "Add", "Improve", "Refactor", "Investigate", "Document", "Speed up", "Redesign", "Remove", "Migrate", "Support", "Audit"];
const THINGS = ["login redirect", "invoice PDF export", "search results ranking", "password reset email", "dark mode contrast", "CSV import",
  "webhook retries", "session timeout", "avatar upload", "pricing page", "keyboard navigation", "rate limiter", "billing address form",
  "onboarding checklist", "push notifications", "audit log", "team invitations", "API pagination", "empty states", "error toasts",
  "date picker", "SSO configuration", "usage dashboard", "offline sync", "image lazy loading", "cookie banner", "status page", "trial expiry flow"];
const PLACES = ["on mobile", "in Safari", "for admins", "in the settings page", "for new teams", "behind the feature flag", "in the EU region", "", "", "", ""];
const EPICS = ["Checkout redesign", "Accessibility pass", "Self-serve onboarding", "Invoice automation", "Search overhaul", "Offline mode",
  "Observability baseline", "Team permissions", "Design system v2", "Performance budget", "Notifications centre", "Data export"];
const COMMENTS = ["I can reproduce this on staging.", "Looks good to me — shipping after review.", "Blocked until the API change lands.",
  "Could we split this into two smaller pieces?", "Added a screenshot to the description.", "Customer confirmed the fix works.",
  "Moving this to next cycle; we ran out of time.", "Pairing on this tomorrow morning.", "The root cause is a race in the cache refresh.",
  "Design review done: see the **updated mocks**.", "Let's add a regression test before closing.", "`npm run bench` shows a 30% improvement.",
  "Do we need a migration for existing rows?", "Checked with legal: fine to proceed."];
const CUSTOMERS = ["Acme", "Globex", "Initech", "Umbrella", "Stark Industries"];

/**
 * @param {import("../test/fake-records.js").FakeRecords} fake
 * @param {{ items?: number, now?: number, rng?: () => number }} [options]
 */
export function seedWork(fake, { items = 300, now = Date.parse("2026-09-26T12:00:00Z"), rng = mulberry32(42) } = {}) {
  const pick = (/** @type {any[]} */ list) => list[Math.floor(rng() * list.length)];
  const chance = (/** @type {number} */ p) => rng() < p;
  const actor = (/** @type {string} */ id) => `cloudflare-os:${id}`;
  const people = SEED_PEOPLE.map((p) => actor(p.id));
  const iso = (/** @type {number} */ t) => new Date(t).toISOString().slice(0, 10);
  const start = now - 70 * DAY;
  const originalNow = fake.now;
  let clock = start;
  fake.now = () => clock;
  /** @type {{ t: number, run: () => void }[]} */
  const events = [];
  const at = (/** @type {number} */ t, /** @type {() => void} */ run) => events.push({ t: Math.min(t, now - 60_000), run });
  const rev = (/** @type {string} */ id) => /** @type {any} */ (fake.rows.get(id)).revision;
  const update = (/** @type {string} */ id, /** @type {Record<string, any>} */ patch, /** @type {string} */ by) =>
    fake.run("work.update", { id, ...patch }, { actor: by, revision: rev(id) });

  try {
    // Setup by Ada (the board owner) on day 0.
    const ada = people[0];
    fake.run("work.state.create", { key: "triage", name: "Triage", kind: "triage", position: 0, color: "#b45bcf" }, { actor: ada });
    const review = [...fake.rows.values()].find((r) => r.entity === "workflow_state" && r.data.key === "in_review");
    if (review) fake.run("work.state.update", { id: review.id, wip_limit: 5 }, { actor: ada, revision: review.revision });
    for (const [key, name, color, description] of LABELS) fake.run("work.label.create", { key, name, color, description }, { actor: ada });
    const projectIds = PROJECTS.map(([name, description, state, lead, color], i) => fake.run("work.project.create", {
      name, description, state, lead: people[/** @type {number} */ (lead)], color,
      start_date: iso(start + i * 5 * DAY), target_date: iso(now + (20 + i * 15) * DAY),
    }, { actor: ada }).id);
    const currentStart = Date.parse(`${iso(now)}T00:00:00Z`) - 5 * DAY;
    const cycles = [-3, -2, -1, 0, 1, 2].map((offset, i) => {
      const s = currentStart + offset * 14 * DAY;
      const record = fake.run("work.cycle.create", { name: `Cycle ${21 + i}`, starts_on: iso(s), ends_on: iso(s + 13 * DAY), goal: offset === 0 ? "Ship the checkout redesign and close P1 bugs." : "" }, { actor: ada });
      return { id: record.id, offset, start: s, end: s + 14 * DAY };
    });

    /** @param {number} created */
    const plan = (created, /** @type {boolean} */ epic) => {
      /** @type {typeof cycles[number]|null} */
      let cycle = null;
      if (!epic && chance(0.72)) {
        const when = created + (2 + rng() * 10) * DAY;
        cycle = cycles.find((c) => c.start <= when && when < c.end) ?? null;
        if (cycle && cycle.offset >= 0 && chance(0.3)) cycle = cycles[cycles.indexOf(cycle) + 1] ?? cycle;
      }
      const r = rng();
      let target;
      if (!cycle) target = r < 0.18 ? "triage" : r < 0.55 ? "backlog" : r < 0.75 ? "todo" : r < 0.9 ? "done" : "cancelled";
      else if (cycle.offset < 0) target = r < 0.82 ? "done" : r < 0.9 ? "cancelled" : r < 0.96 ? "in_progress" : "todo";
      else if (cycle.offset === 0) target = r < 0.3 ? "todo" : r < 0.55 ? "in_progress" : r < 0.7 ? "in_review" : "done";
      else target = r < 0.7 ? "todo" : "backlog";
      if (epic) target = r < 0.3 ? "done" : "in_progress";
      return { cycle, target };
    };

    const epicCount = Math.max(1, Math.round(items / 30));
    /** @type {{ ref: { id: string }, created: number, epic: boolean, parent: { id: string }|null, target: string, assignee: string|null }[]} */
    const made = [];
    let remaining = items;
    const makeItem = (/** @type {number} */ created, /** @type {{ ref: {id: string}, created: number }|null} */ parent, /** @type {string|null} */ epicTitle) => {
      const epic = epicTitle !== null;
      const { cycle, target } = plan(created, epic);
      const assignee = chance(0.85) ? pick(people) : null;
      const by = pick(people);
      const title = epicTitle ?? `${pick(VERBS)} ${pick(THINGS)} ${pick(PLACES)}`.trim();
      /** @type {Record<string, any>} */
      const input = { title, state: target === "triage" ? "triage" : target === "backlog" ? "backlog" : "todo", priority: epic ? 2 : pick([0, 1, 2, 2, 3, 3, 3, 4, 4]) };
      if (chance(0.6)) input.description = description(title);
      if (assignee) input.assignee = assignee;
      const labels = [...new Set(Array.from({ length: Math.floor(rng() * 4) }, () => pick(LABELS)[0]))];
      if (labels.length) input.labels = labels;
      if (chance(0.75)) input.estimate = pick([1, 2, 3, 5, 8]);
      if (chance(0.3)) input.due_date = iso(now + Math.round((rng() * 50 - 20)) * DAY);
      if (chance(0.75)) input.project = projectIds[Math.floor(rng() * projectIds.length)];
      if (chance(0.1)) input.extensions = { customer: pick(CUSTOMERS) };
      const ref = { id: "" };
      const entry = { ref, created, epic, parent: parent?.ref ?? null, target, assignee };
      made.push(entry);
      at(created, () => {
        if (parent) input.parent = parent.ref.id;
        ref.id = fake.run("work.create", input, { actor: by }).id;
      });
      // Move through the workflow over time.
      const worker = assignee ?? pick(people);
      let t = created + (0.2 + rng() * 3) * DAY;
      const move = (/** @type {Record<string, any>} */ patch, /** @type {string} */ who) => { const when = t; at(when, () => update(ref.id, patch, who)); t += (0.3 + rng() * 4) * DAY; };
      if (cycle) move({ cycle: cycle.id, ...(input.state === "triage" || input.state === "backlog" ? { state: "todo" } : {}) }, ada);
      if (["in_progress", "in_review", "done"].includes(target)) move({ state: "in_progress" }, worker);
      if (target === "in_review" || (target === "done" && chance(0.7))) move({ state: "in_review" }, worker);
      if (target === "done") move({ state: "done" }, chance(0.5) ? worker : pick(people));
      if (target === "cancelled") move({ state: "cancelled" }, ada);
      if (chance(0.15)) move({ priority: pick([1, 2, 3]) }, pick(people));
      if (chance(0.02) && target !== "in_progress") move({ archived: true }, ada);
      return entry;
    };

    for (let e = 0; e < epicCount && remaining > 0; e++) {
      const created = start + rng() * 20 * DAY;
      const epic = makeItem(created, null, EPICS[e % EPICS.length] + (e >= EPICS.length ? ` ${Math.floor(e / EPICS.length) + 1}` : ""));
      remaining--;
      const subs = 3 + Math.floor(rng() * 5);
      for (let s = 0; s < subs && remaining > 0; s++, remaining--) makeItem(created + (0.1 + rng() * 30) * DAY, epic, null);
    }
    while (remaining-- > 0) makeItem(start + rng() * 69 * DAY, null, null);

    // Relations and comments, after both ends exist.
    const plain = made.filter((m) => !m.epic);
    const relations = Math.round(items / 12);
    for (let i = 0; i < relations + Math.round(items / 50); i++) {
      const a = pick(plain), b = pick(plain);
      if (a === b) continue;
      const kind = i < relations ? "blocks" : chance(0.6) ? "relates" : "duplicates";
      at(Math.max(a.created, b.created) + rng() * 5 * DAY, () => {
        try { fake.run("work.relation.create", { from: a.ref.id, to: b.ref.id, kind }, { actor: pick(people) }); } catch { /* duplicate: skip */ }
      });
    }
    for (let i = 0; i < Math.round(items / 2); i++) {
      const m = pick(made);
      at(m.created + rng() * 20 * DAY, () => fake.run("work.comment.create", { item: m.ref.id, body: pick(COMMENTS) }, { actor: m.assignee && chance(0.5) ? m.assignee : pick(people) }));
    }

    events.sort((a, b) => a.t - b.t);
    for (const event of events) { clock = Math.max(clock, event.t); event.run(); }
    return { items: made.length, cycles: cycles.map((c) => c.id), projects: projectIds, seq: fake.seq };
  } finally {
    fake.now = originalNow;
  }

  /** @param {string} title */
  function description(title) {
    const parts = [
      `${title} so that teams stop working around it. Reported in ${pick(["support", "the design review", "a customer call", "our own dogfooding"])}.`,
    ];
    if (chance(0.6)) parts.push(`Acceptance criteria:\n\n- Works with keyboard only\n- ${pick(["No regressions in", "Covered by tests for", "Documented in"])} the ${pick(THINGS)}\n- Copy reviewed`);
    if (chance(0.4)) parts.push(`Relevant setting: \`${pick(["session.ttl", "billing.grace_days", "search.boost", "sync.interval"])}\`. See [the spec](https://example.com/spec) for details.`);
    return parts.join("\n\n");
  }
}
