// Fixture documents for mock mode: every known source plus one the contract does not know ("github",
// to exercise the label fallback), several scopes (public and private), authors, workspaces, kinds and
// months, and a couple of bodies with markup in them to show the snippet stays text.

import type { IngestDocument, ScopeDeclaration } from "../contract.js";

/** A fixture adds `topics`: words the mock's pretend embedding treats as "meaning". */
export interface FixtureDocument extends IngestDocument {
  topics: string[];
}

// Relative to load time so "2 hours ago" stays true whenever the mock is opened.
const NOW = Math.floor(Date.now() / 60_000) * 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const FIXTURE_NOW = NOW;

export const FIXTURE_SCOPES: ScopeDeclaration[] = [
  { scope: "chat:C-general", label: "#general", vis: "all" },
  { scope: "chat:C-atlas", label: "#project-atlas", vis: "all" },
  { scope: "chat:C-design", label: "#design", vis: "all" },
  { scope: "chat:C-leads", label: "#leads", vis: "scoped" },
  { scope: "chat:D-jane-sam", label: "Jane, Sam", vis: "scoped" },
  { scope: "context:K-handbook", label: "Team handbook", vis: "all" },
  { scope: "context:K-atlas", label: "Atlas research", vis: "all" },
  { scope: "context:K-finance", label: "Finance (private)", vis: "scoped" },
  { scope: "gadget:acct-harry", label: "Harry's gadgets", vis: "scoped" },
  { scope: "github:org-surprisingly", label: "surprisingly/os", vis: "all" },
];

let counter = 0;
function doc(
  partial: Omit<FixtureDocument, "id" | "vis" | "createdAt" | "updatedAt" | "url"> & {
    ago: number;
    url?: string | null;
    idHint?: string;
  },
): FixtureDocument {
  counter += 1;
  const source = partial.scope.split(":")[0]!;
  const scopeRow = FIXTURE_SCOPES.find((row) => row.scope === partial.scope);
  const id = `${source}:${partial.idHint ?? `doc-${counter}`}`;
  const updatedAt = NOW - partial.ago;
  const { ago: _ago, idHint: _idHint, ...rest } = partial;
  return {
    ...rest,
    id,
    vis: scopeRow?.vis ?? "all",
    url: partial.url === undefined ? `/gatekeeper/${source}/d/${encodeURIComponent(id)}` : partial.url,
    createdAt: updatedAt - 2 * DAY,
    updatedAt,
  };
}

const LONG_SPEC = Array.from(
  { length: 40 },
  (_, index) =>
    `${index + 1}. Atlas ingestion step ${index + 1}: validate the batch, hash each body, and skip unchanged documents.\n` +
    `   Notes: retries back off exponentially; a poison message goes to the dead-letter queue after 5 attempts.`,
).join("\n\n");

export const FIXTURE_DOCUMENTS: FixtureDocument[] = [
  // --- Team chat -------------------------------------------------------------------------------
  doc({
    scope: "chat:C-atlas",
    kind: "message",
    title: "#project-atlas · Jane Okafor",
    author: "Jane Okafor",
    authorId: "jane",
    channel: "C-atlas",
    body: "The Atlas kickoff deck is in the Context Library under Atlas research. Please read the goals slide before Thursday.",
    topics: ["atlas", "kickoff", "planning", "docs", "presentation"],
    ago: 25 * 60_000,
    url: "/gatekeeper/chat/c/C-atlas/m/M1",
  }),
  doc({
    scope: "chat:C-atlas",
    kind: "message",
    title: "#project-atlas · Sam Patel",
    author: "Sam Patel",
    authorId: "sam",
    channel: "C-atlas",
    body: "Where are the docs about project Atlas's data model? I can only find the old spreadsheet.",
    topics: ["atlas", "docs", "schema", "database"],
    ago: 3 * HOUR,
    url: "/gatekeeper/chat/c/C-atlas/m/M2",
  }),
  doc({
    scope: "chat:C-atlas",
    kind: "message",
    title: "#project-atlas · Priya Shah",
    author: "Priya Shah",
    authorId: "priya",
    channel: "C-atlas",
    body: "Deployment of the Atlas ingest worker is blocked on the queue quota. Raised a ticket with Cloudflare.",
    topics: ["atlas", "deploy", "release", "infrastructure", "queue"],
    ago: 8 * HOUR,
    url: "/gatekeeper/chat/c/C-atlas/m/M3",
  }),
  doc({
    scope: "chat:C-general",
    kind: "message",
    title: "#general · Harry Robbins",
    author: "Harry Robbins",
    authorId: "harry",
    channel: "C-general",
    body: "Reminder: the office is closed on Friday for the move. Laptops home please!",
    topics: ["office", "holiday", "logistics"],
    ago: 26 * HOUR,
    url: "/gatekeeper/chat/c/C-general/m/M4",
  }),
  doc({
    scope: "chat:C-general",
    kind: "message",
    title: "#general · Sam Patel",
    author: "Sam Patel",
    authorId: "sam",
    channel: "C-general",
    body: "Anyone know why <script>alert('hi')</script> shows up in the old wiki export? Looks like unescaped HTML.",
    topics: ["wiki", "bug", "security"],
    ago: 2 * DAY,
    url: "/gatekeeper/chat/c/C-general/m/M5",
  }),
  doc({
    scope: "chat:C-design",
    kind: "message",
    title: "#design · Mia Chen",
    author: "Mia Chen",
    authorId: "mia",
    channel: "C-design",
    body: "New colour tokens for dark mode are ready for review. The violet surfaces match the shell now.",
    topics: ["design", "theme", "colour", "dark"],
    ago: 4 * DAY,
    url: "/gatekeeper/chat/c/C-design/m/M6",
  }),
  doc({
    scope: "chat:C-design",
    kind: "thread",
    title: "#design · Onboarding flow review",
    author: "Mia Chen",
    authorId: "mia",
    channel: "C-design",
    body: "Thread: onboarding flow review. We agreed to cut the welcome carousel and go straight to the workspace picker.",
    topics: ["design", "onboarding", "ux"],
    ago: 12 * DAY,
    url: "/gatekeeper/chat/c/C-design/t/T1",
  }),
  doc({
    scope: "chat:C-leads",
    kind: "message",
    title: "#leads · Jane Okafor",
    author: "Jane Okafor",
    authorId: "jane",
    channel: "C-leads",
    body: "Budget for Q4 is approved. Atlas gets two more engineers from November.",
    topics: ["budget", "hiring", "atlas", "finance"],
    ago: 20 * DAY,
    url: "/gatekeeper/chat/c/C-leads/m/M7",
  }),
  doc({
    scope: "chat:D-jane-sam",
    kind: "message",
    title: "Jane, Sam",
    author: "Jane Okafor",
    authorId: "jane",
    channel: "D-jane-sam",
    body: "Can you send me the retro notes from the Atlas sprint? I want to quote them in the board update.",
    topics: ["retro", "atlas", "notes"],
    ago: 33 * DAY,
    url: "/gatekeeper/chat/c/D-jane-sam/m/M8",
  }),
  ...Array.from({ length: 14 }, (_, index) =>
    doc({
      scope: "chat:C-general",
      kind: "message",
      title: `#general · ${["Harry Robbins", "Priya Shah", "Mia Chen"][index % 3]!}`,
      author: ["Harry Robbins", "Priya Shah", "Mia Chen"][index % 3]!,
      authorId: ["harry", "priya", "mia"][index % 3]!,
      channel: "C-general",
      body: `Weekly update ${index + 1}: shipped search fixes, reviewed Atlas docs, and planned the next sprint.`,
      topics: ["update", "weekly", "status", "atlas"],
      ago: (40 + index * 6) * DAY,
      url: `/gatekeeper/chat/c/C-general/m/W${index}`,
    }),
  ),

  // --- Context Library -------------------------------------------------------------------------
  doc({
    scope: "context:K-atlas",
    kind: "slides",
    title: "Atlas kickoff deck",
    author: "Jane Okafor",
    authorId: "jane",
    workspace: "ws-atlas",
    mime: "application/vnd.gadget.slides",
    body: "Atlas kickoff.\n\nGoals: one index for every team document; answers ranked by meaning and by words.\n\nNon-goals: replacing the chat search page.",
    topics: ["atlas", "kickoff", "goals", "presentation", "planning"],
    ago: 2 * DAY,
  }),
  doc({
    scope: "context:K-atlas",
    kind: "doc",
    title: "Atlas data model",
    author: "Sam Patel",
    authorId: "sam",
    workspace: "ws-atlas",
    mime: "text/markdown",
    body: "# Atlas data model\n\nDocuments, chunks, scopes and principals.\n\n    documents(id, kind, title, url, scope, vis, body_hash)\n    chunks(id, document_id, ordinal, text, embed_revision)\n\nEvery document carries exactly one scope.",
    topics: ["atlas", "schema", "database", "docs", "model"],
    ago: 6 * DAY,
  }),
  doc({
    scope: "context:K-atlas",
    kind: "doc",
    title: "Atlas ingestion runbook",
    author: "Priya Shah",
    authorId: "priya",
    workspace: "ws-atlas",
    mime: "text/plain",
    body: LONG_SPEC,
    topics: ["atlas", "runbook", "operations", "queue", "deploy"],
    ago: 9 * DAY,
    idHint: "atlas-runbook",
  }),
  doc({
    scope: "context:K-handbook",
    kind: "doc",
    title: "Expenses policy",
    author: "Harry Robbins",
    authorId: "harry",
    body: "Claim expenses within 30 days. Receipts over £25 need a photo. Travel is booked through the shared account.",
    topics: ["finance", "expenses", "policy", "travel"],
    ago: 45 * DAY,
  }),
  doc({
    scope: "context:K-handbook",
    kind: "doc",
    title: "Holiday and leave",
    author: "Harry Robbins",
    authorId: "harry",
    body: "Everyone gets 28 days of leave plus bank holidays. Book leave in the calendar at least two weeks ahead.",
    topics: ["holiday", "leave", "policy", "vacation"],
    ago: 70 * DAY,
  }),
  doc({
    scope: "context:K-handbook",
    kind: "note",
    title: "How we write docs",
    author: "Mia Chen",
    authorId: "mia",
    body: "Lead with the answer. One idea per paragraph. Link, don't repeat.",
    topics: ["docs", "writing", "style"],
    ago: 100 * DAY,
  }),
  doc({
    scope: "context:K-finance",
    kind: "sheet",
    title: "Q4 budget",
    author: "Jane Okafor",
    authorId: "jane",
    mime: "application/vnd.gadget.sheet",
    body: "Line, Q3, Q4\nEngineering, 410000, 480000\nDesign, 90000, 95000\nInfrastructure, 38000, 52000",
    topics: ["budget", "finance", "money", "spreadsheet"],
    ago: 18 * DAY,
  }),

  // --- Workspace gadgets -----------------------------------------------------------------------
  doc({
    scope: "gadget:acct-harry",
    kind: "board",
    title: "Atlas launch board",
    author: null,
    workspace: "ws-atlas",
    body: "To do: provision Vectorize metadata indexes. Doing: backfill chat history. Done: SearchIndex DO skeleton.",
    topics: ["atlas", "planning", "tasks", "launch", "deploy"],
    ago: 90 * 60_000,
  }),
  doc({
    scope: "gadget:acct-harry",
    kind: "whiteboard",
    title: "Search architecture sketch",
    author: null,
    workspace: "ws-atlas",
    body: "Boxes: sources → SearchService → SearchIndex DO → FTS5 + Vectorize. Arrow from queue consumer to Workers AI.",
    topics: ["architecture", "diagram", "atlas", "search"],
    ago: 5 * DAY,
  }),
  doc({
    scope: "gadget:acct-harry",
    kind: "records",
    title: "Customer interviews",
    author: null,
    workspace: "ws-research",
    body: "12 interviews. Top pain: can't find last quarter's decisions. Second: duplicate docs with different names.",
    topics: ["research", "customers", "interviews", "findability"],
    ago: 28 * DAY,
  }),

  // --- A source the contract does not know (label fallback) -------------------------------------
  doc({
    scope: "github:org-surprisingly",
    kind: "issue",
    title: "Search: dense half returns stale results after edit",
    author: "priya-s",
    authorId: "priya",
    body: "Steps: edit a doc, search immediately. Words match at once; meaning-based results catch up a few seconds later.",
    topics: ["bug", "search", "freshness", "atlas"],
    ago: 3 * DAY,
    url: "https://github.com/surprisingly/os/issues/42",
  }),
];
