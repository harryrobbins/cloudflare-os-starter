// Seed data for the mock transport: a workspace that looks like a real week of work, so the UI is
// developed and screenshot-tested against something with the awkward shapes in it -- long threads,
// an unread run with a mention in the middle, a muted channel, a DM, a group DM, an image, a file, a
// system message, a tombstone, an edited message, and enough bulk history to make the windowed list
// do actual work.

import {
  GENERAL_CHANNEL_ID,
  type Attachment,
  type Channel,
  type ChannelId,
  type Membership,
  type Message,
  type Reaction,
  type ReadCursor,
  type User,
  type UserId,
} from "../contract.js";
import { userToken } from "../lib/mentions.js";

const DAY = 86_400_000;
const MINUTE = 60_000;

/** Fixed "now" offsets are computed from the real clock so day dividers say Today and Yesterday. */
export function seedNow(): number {
  const now = new Date();
  now.setHours(14, 42, 0, 0);
  return now.getTime();
}

export const ME: UserId = "u-harry";

export interface Seed {
  readonly users: User[];
  readonly channels: Channel[];
  readonly memberships: Membership[];
  readonly messages: Message[];
  readonly attachments: Map<string, { readonly dataUrl: string; readonly thumbUrl: string }>;
  readonly following: Set<string>;
  /**
   * How far the *other* members of a `dm` or `group` have read.
   *
   * Only those two kinds, matching `GET channels/:id/messages`: the server omits `readCursors` for
   * `public` and `private`, because a channel can hold the whole deployment.
   */
  readonly readCursors: Map<ChannelId, ReadCursor[]>;
}

function user(id: UserId, name: string, email: string, online: boolean, now: number): User {
  return {
    id,
    name,
    email,
    avatarKey: null,
    firstSeenAt: now - 90 * DAY,
    lastSeenAt: now - (online ? MINUTE : 5 * 60 * MINUTE),
    tz: "Europe/London",
    online,
  };
}

/**
 * A placeholder image as an inline SVG data URL.
 *
 * Deterministic from the seed string, so a screenshot run produces the same picture every time, and
 * cheap enough that the mock can hold a dozen without a fixture directory.
 */
export function placeholderImage(seed: string, width: number, height: number, label: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${hue} 62% 58%)"/>
    <stop offset="1" stop-color="hsl(${(hue + 48) % 360} 68% 42%)"/>
  </linearGradient></defs>
  <rect width="${width}" height="${height}" fill="url(#g)"/>
  <g fill="rgba(255,255,255,0.22)">
    <circle cx="${width * 0.22}" cy="${height * 0.72}" r="${height * 0.3}"/>
    <circle cx="${width * 0.74}" cy="${height * 0.3}" r="${height * 0.22}"/>
  </g>
  <text x="50%" y="52%" text-anchor="middle" font-family="system-ui,sans-serif" font-size="${Math.round(height / 9)}" fill="rgba(255,255,255,0.92)" font-weight="600">${label}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function buildSeed(): Seed {
  const now = seedNow();
  const users: User[] = [
    user(ME, "Harry Robbins", "harry@example.test", true, now),
    user("u-alice", "Alice Chen", "alice@example.test", true, now),
    user("u-bob", "Bob Okafor", "bob@example.test", true, now),
    user("u-cara", "Cara Silva", "cara@example.test", false, now),
    user("u-dan", "Dan Weiss", "dan@example.test", false, now),
    user("u-eve", "Eve Novak", "eve@example.test", true, now),
    user("u-fran", "Fran Mbeki", "fran@example.test", false, now),
    { ...user("u-agent", "Agent", "agent@example.test", true, now), email: null },
  ];

  const attachments = new Map<string, { dataUrl: string; thumbUrl: string }>();
  const messages: Message[] = [];
  const following = new Set<string>();

  const channels: Channel[] = [
    channel(GENERAL_CHANNEL_ID, "public", "general", "Release week — ship by Friday", "Everything that does not belong anywhere else.", 8, now - 60 * DAY),
    channel("c-design", "public", "design", "Rail spacing and the new empty states", "Design review and critique.", 6, now - 50 * DAY),
    channel("c-platform", "private", "platform", "Durable Objects, R2, the router", null, 4, now - 40 * DAY),
    channel("c-releases", "public", "releases", "Automated release notes", null, 7, now - 45 * DAY),
    channel("c-random", "public", "random", null, "Coffee, links, nonsense.", 8, now - 55 * DAY),
    channel("c-support", "public", "support", "Customer questions, triaged here", null, 5, now - 30 * DAY),
    dm("d-alice", ["u-alice", ME], now - 20 * DAY),
    dm("d-bob", ["u-bob", ME], now - 12 * DAY),
    group("g-launch", ["u-alice", "u-cara", "u-eve", ME], now - 8 * DAY),
  ];

  // --- #general: the curated conversation the screenshots show ---------------
  interface SeedEntry {
    readonly at: number;
    readonly by: UserId;
    readonly body: string;
    readonly id?: string;
    readonly kind?: Message["kind"];
    readonly attachmentIds?: readonly string[];
    readonly deleted?: boolean;
    readonly edited?: boolean;
  }

  const general: SeedEntry[] = [
    { at: now - DAY - 260 * MINUTE, by: "u-cara", body: "Morning all. Standup in ten." },
    { at: now - DAY - 258 * MINUTE, by: "u-dan", body: "Running two minutes late, sorry." },
    { at: now - DAY - 190 * MINUTE, by: "u-alice", body: "Can we ship today? The last blocker was the upload cap and that merged overnight.", id: "m-root-ship" },
    { at: now - DAY - 186 * MINUTE, by: "u-bob", body: "Build is green on `main`.\n\n```\n✓ 412 tests   12.4s\n✓ types       3.1s\n```" },
    { at: now - DAY - 180 * MINUTE, by: "u-bob", body: "Here is the dashboard after the change — p95 send latency is down to 38ms.", attachmentIds: ["a-graph"] },
    { at: now - DAY - 120 * MINUTE, by: "u-eve", body: "Lovely. I've attached the release checklist we agreed in the review.", attachmentIds: ["a-checklist"] },
    { at: now - DAY - 60 * MINUTE, by: "system", body: "Cara Silva archived #old-migration", kind: "system" },
    { at: now - 300 * MINUTE, by: "u-alice", body: "Reminder: **freeze is at 16:00**. Anything not merged by then rides the next train." },
    { at: now - 296 * MINUTE, by: "u-alice", body: "I'll do the release notes." },
    { at: now - 240 * MINUTE, by: "u-dan", body: "Deleted for now", kind: "user", deleted: true },
    { at: now - 180 * MINUTE, by: "u-agent", body: "I've summarised the week's incidents in [the postmortem doc](https://example.test/postmortem). Two of the three were the same DO eviction.", kind: "agent" },
    { at: now - 95 * MINUTE, by: "u-cara", body: "That matches what I saw. Nice one." },
    { at: now - 42 * MINUTE, by: "u-bob", body: `${userToken(ME)} can you look at the rail spacing before the freeze? It's 2px out at narrow widths.`, id: "m-mention-rail" },
    // Three images on one message: a portrait, a landscape and a second landscape, so the inline row
    // has to cope with mixed shapes and the lightbox has something to page through.
    { at: now - 38 * MINUTE, by: "u-eve", body: "Same on the thread pane. Screenshots:", attachmentIds: ["a-rail", "a-rail-narrow", "a-thread-pane"] },
    { at: now - 12 * MINUTE, by: "u-alice", body: "Release notes are drafted — shout if anything is missing.", edited: true },
  ];

  let seq = 0;
  const generalMessages: Message[] = [];
  for (const entry of general) {
    seq += 1;
    const id = entry.id ?? `m-general-${seq}`;
    const attachmentIds = entry.attachmentIds ?? [];
    generalMessages.push({
      id,
      channelId: GENERAL_CHANNEL_ID,
      seq,
      rootId: null,
      authorId: entry.by === "system" ? "u-cara" : entry.by,
      body: entry.deleted === true ? "" : entry.body,
      kind: entry.kind ?? "user",
      createdAt: entry.at,
      editedAt: entry.edited === true ? entry.at + 4 * MINUTE : null,
      deletedAt: entry.deleted === true ? entry.at + MINUTE : null,
      replyCount: 0,
      lastReplyAt: null,
      reactions: [],
      attachments: attachmentIds.map((attachmentId) =>
        makeAttachment(attachmentId, GENERAL_CHANNEL_ID, id, entry.by, attachments, entry.at),
      ),
      mentions: entry.body.includes(userToken(ME)) ? [{ kind: "user", userId: ME }] : [],
    });
  }

  // Reactions and a thread on the "can we ship today?" root.
  decorate(generalMessages, "m-root-ship", {
    reactions: [
      { emoji: "👍", userIds: ["u-bob", "u-eve", ME] },
      { emoji: "🚀", userIds: ["u-cara"] },
    ],
    replyCount: 4,
    lastReplyAt: now - DAY - 100 * MINUTE,
  });
  decorate(generalMessages, "m-mention-rail", {
    reactions: [{ emoji: "👀", userIds: ["u-cara"] }],
  });
  const tombstone = generalMessages.find((message) => message.deletedAt !== null);
  if (tombstone !== undefined) decorate(generalMessages, tombstone.id, { replyCount: 2, lastReplyAt: now - 200 * MINUTE });

  const threadReplies: Array<{ by: UserId; body: string; at: number }> = [
    { by: "u-bob", body: "Yes, if the smoke test is green by noon.", at: now - DAY - 170 * MINUTE },
    { by: "u-cara", body: "Smoke test is running now — about 12 minutes.", at: now - DAY - 150 * MINUTE },
    { by: "u-bob", body: "Green. Nothing in the logs.", at: now - DAY - 120 * MINUTE },
    { by: ME, body: "Done ✓ tagged `v1.4.0` and the router is pointing at it.", at: now - DAY - 100 * MINUTE },
  ];
  for (const reply of threadReplies) {
    seq += 1;
    generalMessages.push({
      id: `m-general-t-${seq}`,
      channelId: GENERAL_CHANNEL_ID,
      seq,
      rootId: "m-root-ship",
      authorId: reply.by,
      body: reply.body,
      kind: "user",
      createdAt: reply.at,
      editedAt: null,
      deletedAt: null,
      replyCount: 0,
      lastReplyAt: null,
      reactions: [],
      attachments: [],
      mentions: [],
    });
  }
  following.add("m-root-ship");
  messages.push(...generalMessages.toSorted((a, b) => a.seq - b.seq));

  // --- #design: three unread, one of them a mention -------------------------
  messages.push(
    ...conversation("c-design", [
      { by: "u-eve", body: "New empty states are in Figma. I've gone with an illustration-free treatment — one line, one action.", at: now - 2 * DAY },
      { by: "u-alice", body: "Agreed. The illustrations never survived dark mode anyway.", at: now - 2 * DAY + 20 * MINUTE },
      { by: "u-eve", body: "Rail spacing: 8px between sections, 2px between rows. Anything tighter and the unread dot collides with the name.", at: now - 130 * MINUTE },
      { by: "u-cara", body: `${userToken(ME)} does that work with the badge at 3 digits?`, at: now - 125 * MINUTE, mentionsMe: true },
      { by: "u-eve", body: "We cap at 9+, so three digits never happens.", at: now - 120 * MINUTE },
    ]),
  );

  messages.push(
    ...conversation("c-platform", [
      { by: "u-bob", body: "The eviction happens when the alarm and a fetch race. Fix is to take the write lock first.", at: now - 3 * DAY },
      { by: ME, body: "That matches the trace. I'll write it up.", at: now - 3 * DAY + 30 * MINUTE },
      { by: "u-bob", body: "FTS5 `bm25()` is negative, lower is better — took me an hour.", at: now - 26 * 60 * MINUTE },
    ]),
  );

  messages.push(
    ...conversation("c-releases", [
      { by: "u-agent", body: "**v1.3.9** released.\n\n- Upload cap raised to 10 MiB\n- Thread follow state persists\n- Fixed the reconnect storm after a redeploy", at: now - 4 * DAY, kind: "agent" },
      { by: "u-agent", body: "**v1.4.0** released.\n\n- Permalinks\n- Search qualifiers\n- Presence", at: now - 100 * MINUTE, kind: "agent" },
    ]),
  );

  messages.push(
    ...conversation("c-support", [
      { by: "u-fran", body: "Customer asks whether attachments are scanned. Answer: magic-number sniffed, not virus scanned. Worth documenting.", at: now - 5 * DAY },
    ]),
  );

  // --- #random: bulk history, so the windowed list is exercised --------------
  const chatter = [
    "Coffee machine is fixed.", "Anyone got a spare USB-C cable?", "This week's link: https://example.test/why-sqlite-is-fine",
    "Lunch?", "The lift is out again.", "Found a great pen.", "Who left the whiteboard uncapped 😤",
    "Standup moved to 10:15.", "It's raining sideways.", "New keyboard, sorry about the noise.",
  ];
  const randomMessages: Message[] = [];
  for (let i = 0; i < 1200; i++) {
    const author = users[1 + (i % 6)]!.id;
    randomMessages.push({
      id: `m-random-${i}`,
      channelId: "c-random",
      seq: i + 1,
      rootId: null,
      authorId: author,
      body: `${chatter[i % chatter.length]!}${i % 17 === 0 ? "\n\nAlso: a second line, because grouping has to cope with those too." : ""}`,
      kind: "user",
      createdAt: now - 30 * DAY + i * 32 * MINUTE,
      editedAt: null,
      deletedAt: null,
      replyCount: 0,
      lastReplyAt: null,
      reactions: i % 23 === 0 ? [{ emoji: "😂", userIds: ["u-bob", "u-eve"] }] : [],
      attachments: [],
      mentions: [],
    });
  }
  messages.push(...randomMessages);

  // --- direct messages ------------------------------------------------------
  messages.push(
    ...conversation("d-alice", [
      { by: "u-alice", body: "Did you get a chance to look at the draft?", at: now - 180 * MINUTE },
      { by: ME, body: "Halfway through. The second section needs an example.", at: now - 176 * MINUTE },
      { by: "u-alice", body: "I'll add one.", at: now - 30 * MINUTE },
      { by: "u-alice", body: "Added — have a look when you can 🙏", at: now - 26 * MINUTE },
    ]),
  );
  messages.push(
    ...conversation("d-bob", [
      { by: "u-bob", body: "Pairing at 3?", at: now - 3 * DAY },
      { by: ME, body: "Works for me.", at: now - 3 * DAY + 5 * MINUTE },
    ]),
  );
  messages.push(
    ...conversation("g-launch", [
      { by: "u-cara", body: "Launch checklist: comms, status page, on-call rota. Who has comms?", at: now - 2 * DAY },
      { by: "u-eve", body: "Me. Draft is in the doc.", at: now - 2 * DAY + 12 * MINUTE },
      { by: "u-alice", body: "On-call rota is done. Bob is primary Friday night.", at: now - 50 * MINUTE },
    ]),
  );

  // Channel high-water marks follow from the messages.
  const lastSeqByChannel = new Map<ChannelId, number>();
  for (const message of messages) {
    lastSeqByChannel.set(message.channelId, Math.max(lastSeqByChannel.get(message.channelId) ?? 0, message.seq));
  }
  const withSeq = channels.map((entry) => ({ ...entry, lastSeq: lastSeqByChannel.get(entry.id) ?? 0 }));

  const memberships: Membership[] = [
    membership(GENERAL_CHANNEL_ID, (lastSeqByChannel.get(GENERAL_CHANNEL_ID) ?? 0) - 2, { starred: true }),
    membership("c-design", (lastSeqByChannel.get("c-design") ?? 0) - 3),
    membership("c-platform", lastSeqByChannel.get("c-platform") ?? 0, { starred: true }),
    membership("c-releases", (lastSeqByChannel.get("c-releases") ?? 0) - 1, { muted: true, notify: "none" }),
    // A deliberately long unread run: more than a screenful, so the "New messages" rule opens above
    // the viewport and the jump-to-unread and new-messages affordances have something to do.
    membership("c-random", (lastSeqByChannel.get("c-random") ?? 0) - 40, { notify: "mentions" }),
    membership("d-alice", (lastSeqByChannel.get("d-alice") ?? 0) - 2),
    membership("d-bob", lastSeqByChannel.get("d-bob") ?? 0),
    membership("g-launch", (lastSeqByChannel.get("g-launch") ?? 0) - 1),
  ];

  // Three people at three different places in the group, so the seen-by markers stack and spread.
  const groupLast = lastSeqByChannel.get("g-launch") ?? 0;
  const readCursors = new Map<ChannelId, ReadCursor[]>([
    ["d-alice", [{ userId: "u-alice", lastReadSeq: lastSeqByChannel.get("d-alice") ?? 0 }]],
    ["d-bob", [{ userId: "u-bob", lastReadSeq: (lastSeqByChannel.get("d-bob") ?? 0) - 1 }]],
    [
      "g-launch",
      [
        { userId: "u-alice", lastReadSeq: groupLast },
        { userId: "u-cara", lastReadSeq: groupLast },
        { userId: "u-eve", lastReadSeq: Math.max(1, groupLast - 2) },
      ],
    ],
  ]);

  return { users, channels: withSeq, memberships, messages, attachments, following, readCursors };

  // --- local helpers --------------------------------------------------------

  function conversation(
    channelId: ChannelId,
    entries: Array<{ by: UserId; body: string; at: number; kind?: Message["kind"]; mentionsMe?: boolean }>,
  ): Message[] {
    return entries.map((entry, index) => ({
      id: `m-${channelId}-${index}`,
      channelId,
      seq: index + 1,
      rootId: null,
      authorId: entry.by,
      body: entry.body,
      kind: entry.kind ?? "user",
      createdAt: entry.at,
      editedAt: null,
      deletedAt: null,
      replyCount: 0,
      lastReplyAt: null,
      reactions: [],
      attachments: [],
      mentions: entry.mentionsMe === true ? [{ kind: "user", userId: ME }] : [],
    }));
  }
}

function decorate(
  messages: Message[],
  id: string,
  patch: { reactions?: Reaction[]; replyCount?: number; lastReplyAt?: number },
): void {
  const index = messages.findIndex((message) => message.id === id);
  if (index === -1) return;
  messages[index] = { ...messages[index]!, ...patch };
}

function channel(
  id: ChannelId,
  kind: Channel["kind"],
  name: string,
  topic: string | null,
  purpose: string | null,
  memberCount: number,
  createdAt: number,
): Channel {
  return {
    id,
    kind,
    name,
    topic,
    purpose,
    createdBy: "u-alice",
    createdAt,
    archived: false,
    memberCount,
    lastSeq: 0,
  };
}

function dm(id: ChannelId, memberIds: UserId[], createdAt: number): Channel {
  return {
    id,
    kind: "dm",
    name: null,
    topic: null,
    purpose: null,
    createdBy: memberIds[0]!,
    createdAt,
    archived: false,
    memberCount: memberIds.length,
    lastSeq: 0,
    memberIds,
  };
}

function group(id: ChannelId, memberIds: UserId[], createdAt: number): Channel {
  return { ...dm(id, memberIds, createdAt), kind: "group" };
}

function membership(
  channelId: ChannelId,
  lastReadSeq: number,
  extra: Partial<Membership> = {},
): Membership {
  return {
    channelId,
    userId: ME,
    joinedAt: 0,
    lastReadSeq: Math.max(0, lastReadSeq),
    manualUnreadSeq: null,
    notify: "all",
    muted: false,
    starred: false,
    ...extra,
  };
}

const ATTACHMENT_SPECS: Record<
  string,
  { name: string; mime: string; bytes: number; width: number | null; height: number | null; label: string }
> = {
  "a-graph": { name: "send-latency.png", mime: "image/png", bytes: 184_320, width: 960, height: 540, label: "p95 38ms" },
  "a-rail": { name: "rail-spacing.png", mime: "image/png", bytes: 96_100, width: 720, height: 460, label: "rail spacing" },
  "a-rail-narrow": { name: "rail-spacing-390.png", mime: "image/png", bytes: 88_400, width: 390, height: 620, label: "390px" },
  // Deliberately unmeasured: exercises the placeholder that has no aspect ratio to work from.
  "a-thread-pane": { name: "thread-pane.png", mime: "image/png", bytes: 74_200, width: 640, height: 400, label: "thread pane" },
  "a-checklist": { name: "release-checklist.pdf", mime: "application/pdf", bytes: 412_000, width: null, height: null, label: "" },
};

function makeAttachment(
  id: string,
  channelId: ChannelId,
  messageId: string,
  uploaderId: UserId,
  registry: Map<string, { dataUrl: string; thumbUrl: string }>,
  createdAt: number,
): Attachment {
  const spec = ATTACHMENT_SPECS[id] ?? {
    name: `${id}.bin`,
    mime: "application/octet-stream",
    bytes: 1024,
    width: null,
    height: null,
    label: "",
  };
  if (spec.width !== null && spec.height !== null) {
    registry.set(id, {
      dataUrl: placeholderImage(id, spec.width, spec.height, spec.label),
      thumbUrl: placeholderImage(id, Math.round(spec.width / 2), Math.round(spec.height / 2), spec.label),
    });
  }
  return {
    id,
    messageId,
    channelId,
    uploaderId,
    name: spec.name,
    mime: spec.mime,
    bytes: spec.bytes,
    width: spec.width,
    height: spec.height,
    hasThumb: spec.width !== null,
    createdAt,
  };
}
