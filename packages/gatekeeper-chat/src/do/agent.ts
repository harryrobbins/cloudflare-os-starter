// Questions to the Agent: the outbox, the prompt, and the reply.
//
// A person asks by mentioning `@agent` in a public channel (or one of its threads), or by writing
// anything in a one-to-one direct message with Agent. The question goes to the Workshop's
// `ExternalMessageGateway` as the asker's own account, into the asker's own workspace ("Chat agent",
// `gadgetKey = user:<id>`), and the answer comes back through `ChatAgentReply` (src/agent-reply.ts) and
// is posted as the built-in Agent member. The invariants this file is responsible for:
//
//   * **The outbox row is written before the Workshop is called.** Every call happens from the
//     object's alarm, so a question survives an eviction, a thrown RPC and a deploy. States:
//     `pending` (queued or backing off) -> `accepted` (the Workshop took it) -> `replied`, or
//     `failed` with a reason from any of them.
//   * **Only the verified asker's own account is ever named.** The gateway trusts `callerEmail`
//     completely, so the value comes from the identity the Worker verified (`workshopAccount`) and
//     from nowhere else: not a body, not a mention, not a stored preference.
//   * **Nothing outside the one conversation is sent.** The prompt is built from the thread, or the
//     channel's or DM's top level, that the question was asked in -- all of which the asker can read
//     -- and a private channel or a group conversation is refused before a prompt exists at all.
//   * **A reply is posted once.** Delivery is at-least-once (the Workshop retries until
//     acknowledged), so the reply is written with a fixed client id and the Agent's `(author,
//     client_id)` uniqueness absorbs a duplicate or a late second delivery.
//   * **One question in flight per conversation per asker.** The Workshop refuses a second prompt
//     into a chat whose agent is still running, so a later question in the same thread waits for the
//     earlier one to be answered (or to fail) instead of burning its retries on that refusal.

import type { SubmitExternalMessageResult } from "@gadgets/workshop-shared/external-message-gateway";

import {
  AGENT_CONTEXT_BYTES,
  AGENT_CONTEXT_MESSAGES,
  AGENT_REPLY_TIMEOUT_MS,
  AGENT_USER_ID,
  AGENT_USER_NAME,
  MAX_BODY_BYTES,
  type AgentRequest,
  type AgentRequestState,
  type Message,
  type MessageId,
  type UserId,
} from "../shared/protocol.js";
import { mentionsAgent, utf8Bytes } from "../shared/validate.js";
import { memberIdsOf } from "./access.js";
import { allow, firstRow, placeholders, refuse, type Ctx, type Outcome } from "./context.js";
import { consume } from "./limits.js";
import { hashId, logEvent } from "./logs.js";
import { hydrateMessages, loadMessage, sendMessage } from "./messages.js";
import type { ChannelRow, MessageRow, UserRow } from "./rows.js";
import { loadUserRow } from "./users.js";

/** The workspace every asker's questions go to, created in their account on first use. */
export const AGENT_GADGET_TITLE = "Chat agent";

/** Automatic attempts at reaching the Workshop before a question is marked failed. */
export const MAX_AGENT_ATTEMPTS = 5;
/** Wait before attempt n+1, after attempt n threw. The last entry repeats. */
const BACKOFF_MS: readonly number[] = [5_000, 20_000, 60_000, 180_000];
/** Questions handed to the Workshop per alarm run; the rest wait for the next run. */
const DISPATCH_BATCH = 10;
/** One earlier message never takes more than this of the context budget. */
const CONTEXT_MESSAGE_BYTES = 2_000;
/** Room left in a reply body for the truncation notice. */
const REPLY_NOTICE = "\n\n*(Reply shortened to fit a chat message. The full answer is in the workspace.)*";

export type AgentRequestRow = {
  message_id: string;
  channel_id: string;
  reply_root_id: string | null;
  requester_id: string;
  caller_account: string;
  chat_key: string;
  prompt: string;
  state: string;
  retryable: number;
  generation: number;
  attempts: number;
  next_attempt_at: number | null;
  chat_path: string | null;
  reply_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  accepted_at: number | null;
};

/** What the object hands the Workshop for one question. The reply target is minted by the adapter. */
export interface AgentSubmission {
  /** The asking message: what the reply target reports back against. */
  readonly requestId: MessageId;
  readonly callerEmail: string;
  readonly gadgetKey: string;
  readonly chatKey: string;
  readonly messageKey: string;
  readonly gadgetTitle: string;
  readonly prompt: string;
}

/**
 * The Workshop, as the outbox sees it: one call that either answers or throws.
 *
 * `src/workspace.ts` implements it over the `WORKSHOP_GATEWAY` binding and a `ChatAgentReply` stub
 * from `ctx.exports`; null when the deployment has no binding (`chat.agentReplies: false`).
 */
export interface AgentGateway {
  submit(submission: AgentSubmission): Promise<SubmitExternalMessageResult>;
}

// ---------------------------------------------------------------------------
// Messages people see
// ---------------------------------------------------------------------------

const REFUSED_CONVERSATION =
  "The Agent only answers in public channels and in a direct message with it, so nothing from this " +
  "conversation was sent to it.";
const REPLIES_DISABLED = "Agent replies are turned off for this deployment.";
const NO_ACCOUNT =
  "Your sign-in did not identify a workspace account, so the Agent could not be asked.";
const UNREACHABLE =
  "The workspace could not be reached. Nothing was lost -- try again in a few minutes.";
const TIMED_OUT = "No answer came back from your workspace within 15 minutes.";

// ---------------------------------------------------------------------------
// Rows and the wire shape
// ---------------------------------------------------------------------------

export function loadAgentRequest(ctx: Ctx, messageId: MessageId): AgentRequestRow | null {
  return firstRow<AgentRequestRow>(ctx, `SELECT * FROM agent_requests WHERE message_id = ?`, messageId);
}

function asState(value: string): AgentRequestState {
  return value === "accepted" || value === "replied" || value === "failed" ? value : "pending";
}

export function toAgentRequest(row: AgentRequestRow): AgentRequest {
  return {
    state: asState(row.state),
    requesterId: row.requester_id,
    error: row.state === "failed" ? row.error : null,
    retryable: row.state === "failed" && row.retryable !== 0,
    chatPath: row.chat_path,
    replyId: row.reply_id,
    updatedAt: row.updated_at,
  };
}

/**
 * The agent fields of a page of messages: the request on each asking message, and the workspace
 * path on each reply. Two queries rather than one `OR`, so neither list of bound ids can exceed a
 * page's worth.
 */
export function agentFieldsFor(
  ctx: Ctx,
  messageIds: readonly MessageId[],
): Map<MessageId, Pick<Message, "agentRequest" | "agentReply">> {
  const out = new Map<MessageId, Pick<Message, "agentRequest" | "agentReply">>();
  if (messageIds.length === 0) return out;
  for (const row of ctx.sql
    .exec<AgentRequestRow>(
      `SELECT * FROM agent_requests WHERE message_id IN (${placeholders(messageIds.length)})`,
      ...messageIds,
    )
    .toArray()) {
    out.set(row.message_id, { agentRequest: toAgentRequest(row) });
  }
  for (const row of ctx.sql
    .exec<{ message_id: string; reply_id: string; requester_id: string; chat_path: string | null }>(
      `SELECT message_id, reply_id, requester_id, chat_path FROM agent_requests
        WHERE reply_id IN (${placeholders(messageIds.length)})`,
      ...messageIds,
    )
    .toArray()) {
    out.set(row.reply_id, {
      ...out.get(row.reply_id),
      agentReply: { requestId: row.message_id, requesterId: row.requester_id, chatPath: row.chat_path },
    });
  }
  return out;
}

/** The gateway's messageKey. A manual retry is a new question, so its key differs from the first. */
export function gatewayMessageKey(row: Pick<AgentRequestRow, "message_id" | "generation">): string {
  return row.generation === 0 ? row.message_id : `${row.message_id}.${row.generation}`;
}

/** The one workspace per person. Keyed by the chat user id (the Access `sub`), never an address. */
export function agentGadgetKey(requesterId: UserId): string {
  return `user:${requesterId}`;
}

function publish(ctx: Ctx, row: AgentRequestRow): void {
  const message = loadMessage(ctx, row.message_id);
  if (message === null) return;
  ctx.bus.toChannel(row.channel_id, {
    t: "agent",
    channel: row.channel_id,
    id: row.message_id,
    rootId: message.root_id,
    request: toAgentRequest(row),
  });
}

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

/** Why a message is or is not a question to the Agent. */
export type AgentIntent =
  | { readonly ask: false }
  | { readonly ask: true; readonly allowed: false }
  | { readonly ask: true; readonly allowed: true; readonly dm: boolean };

/**
 * Decides whether a just-sent message asks the Agent something, and whether it may.
 *
 * A one-to-one DM with Agent asks with every message. Anywhere else only an explicit mention asks,
 * and only a public channel may be answered: a private channel or a group conversation would mean
 * handing its members' words to a model none of them chose, so it is refused (and visibly so, on the
 * message) rather than silently ignored.
 */
export function agentIntent(
  ctx: Ctx,
  author: UserRow,
  channel: ChannelRow,
  body: string,
): AgentIntent {
  if (author.id === AGENT_USER_ID || author.kind === "agent") return { ask: false };
  if (channel.kind === "dm") {
    const members = memberIdsOf(ctx, channel.id);
    const withAgent = members.length === 2 && members.includes(AGENT_USER_ID) && members.includes(author.id);
    if (withAgent) return { ask: true, allowed: true, dm: true };
  }
  if (!mentionsAgent(body)) return { ask: false };
  if (channel.kind === "public") return { ask: true, allowed: true, dm: false };
  return { ask: true, allowed: false };
}

/**
 * Records a question in the outbox, or a refusal on the message, straight after it is committed.
 *
 * Synchronous: it only writes SQLite, so the message the sender gets back (and the `msg` event
 * everyone else gets) already carries the request's state. Returns true when a question was queued,
 * so the caller can wake the alarm that dispatches it.
 */
export function recordAgentRequest(
  ctx: Ctx,
  author: UserRow,
  channel: ChannelRow,
  message: MessageRow,
  workshopAccount: string | null,
): boolean {
  const intent = agentIntent(ctx, author, channel, message.body);
  if (!intent.ask) return false;

  const now = ctx.now();
  const replyRootId = intent.allowed && !intent.dm ? (message.root_id ?? message.id) : message.root_id;
  const chatKey = intent.allowed && intent.dm
    ? `dm:${channel.id}`
    : `channel:${channel.id}:thread:${message.root_id ?? message.id}`;

  const insert = (state: AgentRequestState, fields: { prompt?: string; error?: string; retryable?: boolean }) => {
    ctx.sql.exec(
      `INSERT INTO agent_requests (message_id, channel_id, reply_root_id, requester_id, caller_account,
                                   chat_key, prompt, state, retryable, error, next_attempt_at,
                                   created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (message_id) DO NOTHING`,
      message.id,
      channel.id,
      replyRootId,
      author.id,
      workshopAccount ?? "",
      chatKey,
      fields.prompt ?? "",
      state,
      fields.retryable === false ? 0 : 1,
      fields.error ?? null,
      state === "pending" ? now : null,
      now,
      now,
    );
  };

  // Refusals first, and none of them builds a prompt: nothing from a refused conversation exists
  // anywhere but the message itself.
  if (!intent.allowed) {
    insert("failed", { error: REFUSED_CONVERSATION, retryable: false });
    logEvent("chat.agent.refused", { channel: hashId(channel.id), user: hashId(author.id), kind: channel.kind });
    return false;
  }
  if (ctx.agentGateway === null) {
    insert("failed", { error: REPLIES_DISABLED, retryable: false });
    return false;
  }
  if (workshopAccount === null || workshopAccount.length === 0) {
    insert("failed", { error: NO_ACCOUNT, retryable: false });
    return false;
  }
  const budget = consume(ctx, author.id, "agent");
  if (!budget.ok) {
    insert("failed", {
      error: `You have asked the Agent a lot in the last hour. ${budget.message}`,
      retryable: true,
    });
    return false;
  }

  insert("pending", { prompt: buildAgentPrompt(ctx, author, channel, message) });
  logEvent("chat.agent.queued", { channel: hashId(channel.id), user: hashId(author.id), dm: intent.dm });
  return true;
}

/**
 * `POST /api/messages/:messageId/agent/retry`.
 *
 * Only the asker, only a retryable failure, and only against the same budget a first question
 * spends. The prompt is the one frozen at asking time; the generation moves, so the Workshop sees a
 * new question even if it had accepted the old one before it timed out here.
 */
export function retryAgentRequest(
  ctx: Ctx,
  user: UserRow,
  messageId: MessageId,
  workshopAccount: string | null,
): Outcome<AgentRequestRow> {
  const row = loadAgentRequest(ctx, messageId);
  if (row === null) return refuse("not_found", "That message did not ask the Agent anything.");
  if (row.requester_id !== user.id) {
    return refuse("forbidden", "Only the person who asked can retry.");
  }
  if (row.state !== "failed" || row.retryable === 0) {
    return refuse("conflict", "This question is not waiting for a retry.");
  }
  if (ctx.agentGateway === null) return refuse("forbidden", REPLIES_DISABLED);
  if (workshopAccount === null || workshopAccount.length === 0) return refuse("forbidden", NO_ACCOUNT);
  const budget = consume(ctx, user.id, "agent");
  if (!budget.ok) return budget;

  const now = ctx.now();
  ctx.sql.exec(
    `UPDATE agent_requests
        SET state = 'pending', generation = generation + 1, attempts = 0, next_attempt_at = ?,
            error = NULL, chat_path = NULL, accepted_at = NULL, caller_account = ?, updated_at = ?
      WHERE message_id = ?`,
    now,
    workshopAccount,
    now,
    messageId,
  );
  const updated = loadAgentRequest(ctx, messageId)!;
  publish(ctx, updated);
  logEvent("chat.agent.retry", { user: hashId(user.id), generation: updated.generation });
  return allow(updated);
}

/** Drops the question with its message: a withdrawn question gets no answer. */
export function forgetAgentRequest(ctx: Ctx, messageId: MessageId): void {
  ctx.sql.exec(`DELETE FROM agent_requests WHERE message_id = ?`, messageId);
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

/** Cuts a string to at most `maxBytes` of UTF-8, on a code point boundary. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  let out = "";
  let used = 0;
  for (const char of text) {
    const size = utf8Bytes(char);
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return out;
}

function stamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * The text the Workshop's agent is given.
 *
 * Framed, so the model knows it is a chat participant answering one person rather than the owner of
 * a workspace; bounded, to {@link AGENT_CONTEXT_MESSAGES} earlier messages and
 * {@link AGENT_CONTEXT_BYTES} of their text, newest kept first; and scoped to the conversation the
 * question was asked in -- the thread when it was asked in one, the top level otherwise. Mention
 * tokens are turned back into names so the model reads what people read.
 */
export function buildAgentPrompt(ctx: Ctx, asker: UserRow, channel: ChannelRow, message: MessageRow): string {
  const inThread = message.root_id !== null;
  const earlier = ctx.sql
    .exec<MessageRow>(
      inThread
        ? `SELECT * FROM messages
            WHERE channel_id = ? AND (id = ? OR root_id = ?) AND seq < ? AND deleted_at IS NULL
            ORDER BY seq DESC LIMIT ?`
        : `SELECT * FROM messages
            WHERE channel_id = ? AND root_id IS NULL AND seq < ? AND deleted_at IS NULL
            ORDER BY seq DESC LIMIT ?`,
      ...(inThread
        ? [channel.id, message.root_id, message.root_id, message.seq, AGENT_CONTEXT_MESSAGES]
        : [channel.id, message.seq, AGENT_CONTEXT_MESSAGES]),
    )
    .toArray();

  const names = namesFor(ctx, [asker.id, ...earlier.map((row) => row.author_id), ...tokenIds([message, ...earlier])]);
  const nameOf = (id: UserId): string => names.get(id) ?? "Someone";
  const readable = (body: string): string =>
    body.replace(/<@([A-Za-z0-9_-]{1,64})>/gu, (_token, id: string) => `@${nameOf(id)}`);

  // Newest first against the byte budget, then back into reading order.
  const lines: string[] = [];
  let budget = AGENT_CONTEXT_BYTES;
  for (const row of earlier) {
    const who = row.kind === "system" ? "(system)" : row.author_id === AGENT_USER_ID ? AGENT_USER_NAME : nameOf(row.author_id);
    const line = `[${stamp(row.created_at)}] ${who}: ${truncateUtf8(readable(row.body), CONTEXT_MESSAGE_BYTES)}`;
    const size = utf8Bytes(line) + 1;
    if (size > budget) break;
    budget -= size;
    lines.push(line);
  }
  lines.reverse();

  const askerName = nameOf(asker.id);
  const where =
    channel.kind === "dm"
      ? `in a direct message with you${inThread ? ", in a thread" : ""}`
      : `in #${channel.name ?? channel.id}${inThread ? ", in a thread" : ""}`;
  const audience =
    channel.kind === "dm"
      ? `Only ${askerName} can read it.`
      : `Everyone who can read #${channel.name ?? channel.id} will see it.`;
  return [
    `You are the ${AGENT_USER_NAME} member of the team chat, replying to ${askerName} ${where}.`,
    `Your answer is posted back into the chat as a message from ${AGENT_USER_NAME}. ${audience}`,
    "Answer the last message below. Write Markdown, and keep it short enough to read in a chat pane.",
    "",
    lines.length === 0
      ? "There are no earlier messages in this conversation."
      : `Earlier messages in this conversation, oldest first (the ${lines.length} most recent; anything older is not included):`,
    ...lines,
    "",
    `The message to answer, from ${askerName}:`,
    readable(message.body),
  ].join("\n");
}

function tokenIds(rows: readonly MessageRow[]): UserId[] {
  const ids: UserId[] = [];
  for (const row of rows) {
    for (const match of row.body.matchAll(/<@([A-Za-z0-9_-]{1,64})>/gu)) ids.push(match[1]!);
  }
  return ids;
}

function namesFor(ctx: Ctx, userIds: readonly UserId[]): Map<UserId, string> {
  const ids = [...new Set(userIds)].slice(0, 100);
  const out = new Map<UserId, string>();
  if (ids.length === 0) return out;
  for (const row of ctx.sql
    .exec<{ id: string; name: string }>(`SELECT id, name FROM users WHERE id IN (${placeholders(ids.length)})`, ...ids)
    .toArray()) {
    out.set(row.id, row.name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dispatch (the alarm)
// ---------------------------------------------------------------------------

/**
 * True when an earlier question from the same person in the same conversation is still ahead of
 * this one: accepted and unanswered, or queued before it.
 */
function blocked(ctx: Ctx, row: AgentRequestRow): boolean {
  return (
    firstRow(
      ctx,
      `SELECT message_id FROM agent_requests
        WHERE requester_id = ? AND chat_key = ? AND message_id <> ?
          AND (state = 'accepted' OR (state = 'pending' AND created_at < ?))
        LIMIT 1`,
      row.requester_id,
      row.chat_key,
      row.message_id,
      row.created_at,
    ) !== null
  );
}

function fail(ctx: Ctx, row: AgentRequestRow, error: string, retryable: boolean): void {
  ctx.sql.exec(
    `UPDATE agent_requests SET state = 'failed', error = ?, retryable = ?, next_attempt_at = NULL,
            updated_at = ?
      WHERE message_id = ? AND generation = ?`,
    error,
    retryable ? 1 : 0,
    ctx.now(),
    row.message_id,
    row.generation,
  );
}

/**
 * One alarm's worth of outbox work. Returns when the alarm should next fire for it, or null.
 *
 * Times out accepted questions that never got an answer, then hands due questions to the Workshop
 * one at a time. A question is re-read after every await: the reply can arrive (through
 * `deliverAgentReply`) before the call that asked for it has returned, and a state written from a
 * stale copy would undo it.
 */
export async function runAgentOutbox(ctx: Ctx): Promise<number | null> {
  const now = ctx.now();

  for (const row of ctx.sql
    .exec<AgentRequestRow>(
      `SELECT * FROM agent_requests WHERE state = 'accepted' AND accepted_at <= ?`,
      now - AGENT_REPLY_TIMEOUT_MS,
    )
    .toArray()) {
    fail(ctx, row, TIMED_OUT, true);
    publish(ctx, loadAgentRequest(ctx, row.message_id)!);
    logEvent("chat.agent.timeout", { user: hashId(row.requester_id) });
  }

  const due = ctx.sql
    .exec<AgentRequestRow>(
      `SELECT * FROM agent_requests WHERE state = 'pending' AND next_attempt_at <= ?
        ORDER BY created_at LIMIT ?`,
      now,
      DISPATCH_BATCH,
    )
    .toArray();

  for (const queued of due) {
    if (blocked(ctx, queued)) continue;
    await dispatch(ctx, queued);
  }

  return nextWake(ctx);
}

async function dispatch(ctx: Ctx, row: AgentRequestRow): Promise<void> {
  const gateway = ctx.agentGateway;
  if (gateway === null) {
    // The binding was removed by a deploy while this question waited.
    fail(ctx, row, REPLIES_DISABLED, false);
    publish(ctx, loadAgentRequest(ctx, row.message_id)!);
    return;
  }

  const attempt = row.attempts + 1;
  ctx.sql.exec(
    `UPDATE agent_requests SET attempts = ?, updated_at = ? WHERE message_id = ? AND generation = ?`,
    attempt,
    ctx.now(),
    row.message_id,
    row.generation,
  );

  let result: SubmitExternalMessageResult | null = null;
  let thrown: unknown = null;
  try {
    result = await gateway.submit({
      requestId: row.message_id,
      callerEmail: row.caller_account,
      gadgetKey: agentGadgetKey(row.requester_id),
      chatKey: row.chat_key,
      messageKey: gatewayMessageKey(row),
      gadgetTitle: AGENT_GADGET_TITLE,
      prompt: row.prompt,
    });
  } catch (error) {
    thrown = error;
  }

  // Re-read: a reply, a retry or a delete may have landed during the call.
  const current = loadAgentRequest(ctx, row.message_id);
  if (current === null || current.generation !== row.generation || current.state !== "pending") return;

  const now = ctx.now();
  if (result !== null && result.accepted) {
    ctx.sql.exec(
      `UPDATE agent_requests SET state = 'accepted', chat_path = ?, accepted_at = ?, next_attempt_at = NULL,
              updated_at = ?
        WHERE message_id = ? AND generation = ?`,
      safeChatPath(result.chatPath),
      now,
      now,
      row.message_id,
      row.generation,
    );
    logEvent("chat.agent.accepted", { user: hashId(row.requester_id), attempt });
  } else if (result !== null) {
    // An actionable refusal ("create an account", "configure a model"): the Workshop's own words are
    // the most useful thing to show, and retrying unchanged would get the same answer.
    fail(ctx, row, truncateUtf8(result.message, 500), true);
    logEvent("chat.agent.rejected", { user: hashId(row.requester_id) });
  } else if (attempt >= MAX_AGENT_ATTEMPTS) {
    fail(ctx, row, UNREACHABLE, true);
    logEvent("chat.agent.unreachable", {
      user: hashId(row.requester_id),
      attempt,
      message: (thrown instanceof Error ? thrown.message : String(thrown)).slice(0, 200),
    });
  } else {
    ctx.sql.exec(
      `UPDATE agent_requests SET next_attempt_at = ?, updated_at = ? WHERE message_id = ? AND generation = ?`,
      now + backoff(attempt),
      now,
      row.message_id,
      row.generation,
    );
    logEvent("chat.agent.retry_later", {
      user: hashId(row.requester_id),
      attempt,
      message: (thrown instanceof Error ? thrown.message : String(thrown)).slice(0, 200),
    });
  }
  publish(ctx, loadAgentRequest(ctx, row.message_id)!);
}

export function backoff(attempt: number): number {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1] ?? BACKOFF_MS.at(-1)!;
}

/**
 * The chat path is shown as a link, so it must stay a same-origin path: a scheme or a
 * protocol-relative `//host` would turn "Open in workspace" into a link off the deployment.
 */
export function safeChatPath(path: string): string | null {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    return null;
  }
  return path.slice(0, 500);
}

/**
 * When the alarm is next needed: the earliest backoff among questions nothing is waiting on, or the
 * earliest timeout among accepted ones. A blocked question needs no alarm of its own -- whatever it
 * waits on either replies (which wakes the outbox) or times out (which is on this list).
 */
function nextWake(ctx: Ctx): number | null {
  let next: number | null = null;
  const consider = (at: number) => {
    next = next === null ? at : Math.min(next, at);
  };
  for (const row of ctx.sql
    .exec<AgentRequestRow>(`SELECT * FROM agent_requests WHERE state = 'pending'`)
    .toArray()) {
    if (!blocked(ctx, row)) consider(Math.max(row.next_attempt_at ?? 0, ctx.now() + 250));
  }
  const oldest = firstRow<{ at: number | null }>(
    ctx,
    `SELECT MIN(accepted_at) AS at FROM agent_requests WHERE state = 'accepted'`,
  );
  if (oldest?.at !== null && oldest?.at !== undefined) consider(oldest.at + AGENT_REPLY_TIMEOUT_MS);
  return next;
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

/** The Workshop's text as a chat message body: never empty, never over the body cap. */
export function formatAgentReply(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "*(The agent finished without saying anything.)*";
  if (utf8Bytes(trimmed) <= MAX_BODY_BYTES) return trimmed;
  return truncateUtf8(trimmed, MAX_BODY_BYTES - utf8Bytes(REPLY_NOTICE)).trimEnd() + REPLY_NOTICE;
}

/**
 * Posts the Workshop's answer, once. Called by `ChatAgentReply.onGadgetResponse`, which the
 * Workshop invokes at least once per question and possibly more.
 *
 * Accepts the answer in any unanswered state, including `failed`: a question that timed out here
 * and then got its answer late is better answered than not. A key that does not belong to this
 * message is ignored, as is an answer to a message that has since been deleted.
 *
 * Returns normally whenever the Workshop should stop retrying, and throws only for a failure that a
 * later delivery could fix.
 */
export async function deliverAgentReply(
  ctx: Ctx,
  requestId: MessageId,
  messageKey: string,
  text: string,
): Promise<"posted" | "duplicate" | "ignored"> {
  const row = loadAgentRequest(ctx, requestId);
  if (row === null || !(messageKey === requestId || messageKey.startsWith(`${requestId}.`))) {
    logEvent("chat.agent.reply_ignored", { known: row !== null });
    return "ignored";
  }
  if (row.state === "replied") return "duplicate";

  const agent = loadUserRow(ctx, AGENT_USER_ID);
  if (agent === null) throw new Error("The built-in Agent row is missing.");
  const clientId = `agent-reply-${requestId}`;
  const outcome = await sendMessage(
    ctx,
    agent,
    row.channel_id,
    {
      body: formatAgentReply(text),
      clientId,
      ...(row.reply_root_id === null ? {} : { rootId: row.reply_root_id }),
    },
    { agentReply: true },
  );

  // A concurrent delivery can win the insert; its message is the reply either way.
  const posted = outcome.ok
    ? outcome.value.message.id
    : (firstRow<{ id: string }>(ctx, `SELECT id FROM messages WHERE author_id = ? AND client_id = ?`, AGENT_USER_ID, clientId)?.id ?? null);

  const now = ctx.now();
  if (posted === null) {
    // Refused for a reason retrying will not fix (the thread was deleted, the channel archived).
    ctx.sql.exec(
      `UPDATE agent_requests SET state = 'failed', error = ?, retryable = 0, updated_at = ? WHERE message_id = ?`,
      `The answer could not be posted here: ${outcome.ok ? "" : outcome.message}`,
      now,
      requestId,
    );
    publish(ctx, loadAgentRequest(ctx, requestId)!);
    return "ignored";
  }

  const before = loadAgentRequest(ctx, requestId);
  if (before?.state === "replied") return "duplicate";
  ctx.sql.exec(
    `UPDATE agent_requests SET state = 'replied', reply_id = ?, error = NULL, next_attempt_at = NULL,
            updated_at = ?
      WHERE message_id = ?`,
    posted,
    now,
    requestId,
  );
  const replied = loadAgentRequest(ctx, requestId)!;
  publish(ctx, replied);
  // The reply went out before it was linked to its question; send it again with `agentReply`.
  const replyRow = loadMessage(ctx, posted);
  if (replyRow !== null) {
    const [reply] = hydrateMessages(ctx, [replyRow]);
    if (reply !== undefined) ctx.bus.toChannel(row.channel_id, { t: "edit", message: reply });
  }
  logEvent("chat.agent.replied", { user: hashId(row.requester_id), channel: hashId(row.channel_id) });
  // Anything this question was holding up in the same conversation can go now.
  await ctx.wakeAt(now);
  return "posted";
}
