// Video calls: the Durable Object as the call's room (docs/plans/chat-video.md).
//
// The Cloudflare Realtime SFU has sessions and tracks and nothing else. Who is in which call, which
// session is theirs, which of their tracks are flowing and whether they are muted all live here, in
// the `calls` and `call_participants` tables, and reach clients as `{t:"call"}` events. Every SFU
// operation a browser wants goes through a handler below, which authorises it and then forwards it
// with the app secret (src/do/sfu.ts).
//
// The rules this file is responsible for:
//
//   * **Membership, as posting.** Joining needs write access to the conversation; joining a public
//     channel's call joins the channel. Every signalling route rechecks read access, so somebody
//     removed from a private channel cannot pull anything new.
//   * **Participants are owned.** A `participantId` must be a live row whose `user_id` is the caller.
//     SFU session ids are read from rows, never from a request: a client can neither push into
//     somebody else's session nor name a session to pull from.
//   * **Only announced tracks exist.** A published track is private until its owner announces that
//     bytes are flowing; only announced tracks of live participants of the same call can be pulled.
//   * **One call per conversation, one row per person.** A partial unique index holds the first; a
//     second join by the same person ends their older row and tells its sockets `call-moved`.
//   * **Nothing is left open.** Leaving, being replaced and expiring all force-close the departed
//     participant's published tracks on the SFU (subscriptions do not stop on their own), and the
//     last departure ends the call and edits its system message.
//   * **Expiry is lazy plus the alarm.** A participant with no `call-beat` for
//     CALL_PARTICIPANT_TTL_MS is dropped by the next call read or write, or by the object's alarm.
//
// Handlers that talk to the SFU await it, and other requests may run while they wait. So each one
// checks what it needs, calls the SFU, then re-reads the rows before writing -- a count or a row read
// before the `await` is never trusted after it.

import {
  CALL_PARTICIPANT_TTL_MS,
  CALL_REACTION_BURST,
  CALL_REACTION_WINDOW_MS,
  MAX_CALL_PARTICIPANTS,
  type AnnounceTracksRequest,
  type CallFeature,
  type CallIceServer,
  type CallParticipant,
  type CallResponse,
  type CallState,
  type CallTrackKind,
  type ChannelId,
  type ClientEvent,
  type CloseTracksRequest,
  type CloseTracksResponse,
  type JoinCallResponse,
  type Message,
  type MessageId,
  type OkResponse,
  type PublishTracksRequest,
  type PublishTracksResponse,
  type PullTracksRequest,
  type PullTracksResponse,
  type RenegotiateRequest,
  type SetLayerRequest,
  type UserId,
  formatCallDuration,
} from "../shared/protocol.js";
import { memberIdsOf, requireRead, requireWrite } from "./access.js";
import { allow, firstRow, placeholders, refuse, type Ctx, type Outcome } from "./context.js";
import { newCallId, newParticipantId } from "./ids.js";
import { pruneCallStatsBudgets } from "./call-stats.js";
import { consume, reactionAllowed } from "./limits.js";
import { hashId, logDenial, logEvent } from "./logs.js";
import { hydrateMessages, loadMessage, postSystemMessage } from "./messages.js";
import type { UserRow } from "./rows.js";
import { namesFor } from "./users.js";
import { queueSearchMessage } from "./search-sync.js";
import { SfuError, sfuClient, type RealtimeConfig, type RemoteTrack } from "./sfu.js";
import { iceServersFor } from "./turn.js";

/** Layer a simulcast pull starts on when the client names none: the grid tile's. */
const DEFAULT_PULL_RID = "b" as const;
/** How far past a heartbeat's expiry the alarm wakes, so the row is certainly stale when it runs. */
const EXPIRY_SLACK_MS = 1_000;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type CallRow = {
  id: string;
  channel_id: string;
  started_by: string;
  started_at: number;
  ended_at: number | null;
  message_id: string;
  peak_participants: number;
};

export type ParticipantRow = {
  id: string;
  call_id: string;
  user_id: string;
  sfu_session_id: string;
  joined_at: number;
  left_at: number | null;
  last_seen_at: number;
  audio: number;
  video: number;
  screen: number;
  tracks: string;
  /** Migration 6. When the hand went up; null while it is down. */
  hand_at: number | null;
};

/** One published track as stored in `call_participants.tracks`. */
export interface StoredTrack {
  readonly name: string;
  readonly kind: CallTrackKind;
  /** On the publisher's own session; what a forced close needs. */
  readonly mid: string;
  readonly simulcast: boolean;
  readonly announced: boolean;
}

function readTracks(row: Pick<ParticipantRow, "tracks">): StoredTrack[] {
  try {
    const parsed: unknown = JSON.parse(row.tracks);
    return Array.isArray(parsed) ? (parsed as StoredTrack[]) : [];
  } catch {
    return [];
  }
}

function loadCall(ctx: Ctx, callId: string): CallRow | null {
  return firstRow<CallRow>(ctx, `SELECT * FROM calls WHERE id = ?`, callId);
}

function activeCallIn(ctx: Ctx, channelId: ChannelId): CallRow | null {
  return firstRow<CallRow>(ctx, `SELECT * FROM calls WHERE channel_id = ? AND ended_at IS NULL`, channelId);
}

function loadParticipant(ctx: Ctx, participantId: string): ParticipantRow | null {
  return firstRow<ParticipantRow>(ctx, `SELECT * FROM call_participants WHERE id = ?`, participantId);
}

function liveParticipants(ctx: Ctx, callId: string): ParticipantRow[] {
  return ctx.sql
    .exec<ParticipantRow>(
      `SELECT * FROM call_participants WHERE call_id = ? AND left_at IS NULL ORDER BY joined_at, rowid`,
      callId,
    )
    .toArray();
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

function toParticipant(row: ParticipantRow): CallParticipant {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.sfu_session_id,
    joinedAt: row.joined_at,
    audio: row.audio === 1,
    video: row.video === 1,
    screen: row.screen === 1,
    ...(row.hand_at === null || row.hand_at === undefined ? {} : { hand: row.hand_at }),
    tracks: readTracks(row)
      .filter((track) => track.announced)
      .map((track) => ({ name: track.name, kind: track.kind, simulcast: track.simulcast })),
  };
}

function toCallState(ctx: Ctx, call: CallRow, live: readonly ParticipantRow[] = liveParticipants(ctx, call.id)): CallState {
  return {
    id: call.id,
    channelId: call.channel_id,
    startedBy: call.started_by,
    startedAt: call.started_at,
    messageId: call.message_id,
    participants: live.map(toParticipant),
  };
}

/** Rows keyed by their `call_id`, keeping query order within each call. */
function byCall<T extends { call_id: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(row.call_id);
    if (list === undefined) out.set(row.call_id, [row]);
    else list.push(row);
  }
  return out;
}

/**
 * Everyone who joined at any point, per call, in first-join order. `callFilter` is a SQL condition
 * on the call's id (`= ?`, `IN (...)`) and its parameters.
 */
function everJoinedBy(ctx: Ctx, callFilter: string, ...params: SqlStorageValue[]): Map<string, UserId[]> {
  const rows = ctx.sql
    .exec<{ call_id: string; user_id: string }>(
      `SELECT call_id, user_id FROM call_participants WHERE call_id ${callFilter}
        GROUP BY call_id, user_id ORDER BY MIN(joined_at), MIN(rowid)`,
      ...params,
    )
    .toArray();
  return new Map([...byCall(rows)].map(([callId, list]) => [callId, list.map((row) => row.user_id)]));
}

function everJoined(ctx: Ctx, callId: string): UserId[] {
  return everJoinedBy(ctx, "= ?", callId).get(callId) ?? [];
}

/** `Message.call` for the system messages calls posted, hydrated by message id like `agentRequest`. */
export function callFieldsFor(ctx: Ctx, messageIds: readonly MessageId[]): Map<MessageId, Pick<Message, "call">> {
  const out = new Map<MessageId, Pick<Message, "call">>();
  if (messageIds.length === 0) return out;
  const inMessages = `IN (${placeholders(messageIds.length)})`;
  const calls = ctx.sql.exec<CallRow>(`SELECT * FROM calls WHERE message_id ${inMessages}`, ...messageIds).toArray();
  if (calls.length === 0) return out;
  const joined = everJoinedBy(ctx, `IN (SELECT id FROM calls WHERE message_id ${inMessages})`, ...messageIds);
  for (const call of calls) {
    out.set(call.message_id, {
      call: {
        id: call.id,
        state: call.ended_at === null ? "active" : "ended",
        startedAt: call.started_at,
        endedAt: call.ended_at,
        participantIds: joined.get(call.id) ?? [],
      },
    });
  }
  return out;
}

export function callFeature(ctx: Ctx): CallFeature {
  return { enabled: realtimeOf(ctx) !== null, maxParticipants: MAX_CALL_PARTICIPANTS };
}

/**
 * Active calls in every conversation the user can see: public channels and their memberships.
 * `ChannelListResponse.calls` and `hello.calls`. Expires stale participants first, so a rail
 * never shows somebody who left without saying so.
 */
export function activeCallsFor(ctx: Ctx, userId: UserId): CallState[] {
  sweepInBackground(ctx);
  const calls = ctx.sql
    .exec<CallRow>(
      `SELECT k.* FROM calls k JOIN channels c ON c.id = k.channel_id
        WHERE k.ended_at IS NULL
          AND (c.kind = 'public'
               OR EXISTS (SELECT 1 FROM memberships m WHERE m.channel_id = c.id AND m.user_id = ?))
        ORDER BY k.started_at`,
      userId,
    )
    .toArray();
  if (calls.length === 0) return [];
  // Every live participant of every running call in one read; few calls run at once.
  const live = byCall(
    ctx.sql
      .exec<ParticipantRow>(
        `SELECT p.* FROM call_participants p JOIN calls k ON k.id = p.call_id
          WHERE k.ended_at IS NULL AND p.left_at IS NULL ORDER BY p.joined_at, p.rowid`,
      )
      .toArray(),
  );
  return calls.map((call) => toCallState(ctx, call, live.get(call.id) ?? []));
}

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

/** The call's current state to the conversation, like a `msg`. */
function broadcastCall(ctx: Ctx, callId: string): void {
  const call = loadCall(ctx, callId);
  if (call === null) return;
  ctx.bus.toChannel(call.channel_id, {
    t: "call",
    channel: call.channel_id,
    call: call.ended_at === null ? toCallState(ctx, call) : null,
  });
}

/**
 * The event that starts a call. In a `dm` or `group` it rings everybody but the starter, who gets
 * the same state without `ring`; a channel never rings.
 *
 * The ring goes to the members' sockets directly, not through `toChannel`: a socket's `sub` list is
 * the conversations it knew when it subscribed, so a dm created after the other person connected
 * (the usual way a first call starts) would never ring them. Their client refreshes its channel list
 * when a ring names a conversation it does not have.
 */
function broadcastStart(ctx: Ctx, call: CallRow, ring: boolean): void {
  const state = toCallState(ctx, call);
  if (!ring) {
    ctx.bus.toChannel(call.channel_id, { t: "call", channel: call.channel_id, call: state });
    return;
  }
  const others = memberIdsOf(ctx, call.channel_id).filter((userId) => userId !== call.started_by);
  ctx.bus.toUsers(others, { t: "call", channel: call.channel_id, call: state, ring: true });
  ctx.bus.toUsers([call.started_by], { t: "call", channel: call.channel_id, call: state });
}

// ---------------------------------------------------------------------------
// Departures, the end of a call, expiry
// ---------------------------------------------------------------------------

/** Published tracks to force-close on the SFU once the row changes are written. */
type Cleanup = { readonly sessionId: string; readonly mids: readonly string[] }[];

function cleanupFor(row: ParticipantRow): Cleanup {
  const mids = readTracks(row).map((track) => track.mid);
  return mids.length === 0 ? [] : [{ sessionId: row.sfu_session_id, mids }];
}

/** Marks one participant gone and says what must be closed on the SFU. Does not broadcast. */
function depart(ctx: Ctx, row: ParticipantRow, now: number): Cleanup {
  ctx.sql.exec(`UPDATE call_participants SET left_at = ? WHERE id = ? AND left_at IS NULL`, now, row.id);
  return cleanupFor(row);
}

/** After departures: ends the call when nobody is left, else pushes the new state. */
function settle(ctx: Ctx, callId: string, now: number): void {
  const call = loadCall(ctx, callId);
  if (call === null || call.ended_at !== null) return;
  if (liveParticipants(ctx, callId).length === 0) {
    endCall(ctx, call, now);
    return;
  }
  broadcastCall(ctx, callId);
}

/**
 * Ends a call: `ended_at`, the system message edited to "Call ended ..." with `call.state` ended,
 * then `edit` and `call {call: null}` to the conversation.
 */
function endCall(ctx: Ctx, call: CallRow, now: number): void {
  const message = loadMessage(ctx, call.message_id);
  ctx.storage.transactionSync(() => {
    ctx.sql.exec(`UPDATE calls SET ended_at = ? WHERE id = ? AND ended_at IS NULL`, now, call.id);
    // An admin may have deleted the message; the call still ends.
    if (message !== null && message.deleted_at === null) {
      ctx.sql.exec(`UPDATE messages SET body = ? WHERE id = ?`, endedBody(ctx, call, now), call.message_id);
      queueSearchMessage(ctx, call.message_id);
    }
  });
  logEvent("chat.call.end", {
    call: hashId(call.id),
    channel: hashId(call.channel_id),
    ms: now - call.started_at,
    peak: call.peak_participants,
  });
  if (message !== null && message.deleted_at === null) {
    const edited = loadMessage(ctx, call.message_id);
    if (edited !== null) ctx.bus.toChannel(call.channel_id, { t: "edit", message: hydrateMessages(ctx, [edited])[0]! });
  }
  ctx.bus.toChannel(call.channel_id, { t: "call", channel: call.channel_id, call: null });
}

/** "Call ended · 23 min · Harry, Alice, Bob" -- what search and a plain-text client see. */
function endedBody(ctx: Ctx, call: CallRow, now: number): string {
  const ids = everJoined(ctx, call.id);
  const names = namesFor(ctx, ids);
  const duration = formatCallDuration(now - call.started_at);
  const people = ids.map((id) => names.get(id) ?? "Someone").join(", ");
  return people.length > 0 ? `Call ended · ${duration} · ${people}` : `Call ended · ${duration}`;
}

/**
 * Drops every live participant whose heartbeat is older than the TTL, in every call: their sockets
 * get `call-moved {reason: "expired"}`, each affected call is settled. Synchronous; the SFU closes
 * it returns are the caller's to run.
 */
function expireStale(ctx: Ctx): Cleanup {
  const now = ctx.now();
  const stale = ctx.sql
    .exec<ParticipantRow>(
      `SELECT * FROM call_participants WHERE left_at IS NULL AND last_seen_at < ?`,
      now - CALL_PARTICIPANT_TTL_MS,
    )
    .toArray();
  if (stale.length === 0) return [];
  const cleanup: Cleanup = [];
  const calls = new Set<string>();
  for (const row of stale) {
    cleanup.push(...depart(ctx, row, now));
    calls.add(row.call_id);
    ctx.bus.toUsers([row.user_id], { t: "call-moved", call: row.call_id, participant: row.id, reason: "expired" });
    logEvent("chat.call.expire", { call: hashId(row.call_id), user: hashId(row.user_id) });
  }
  for (const callId of calls) settle(ctx, callId, now);
  return cleanup;
}

/** Best effort: a close that fails is logged and forgotten; the SFU collects silent tracks itself. */
async function flush(ctx: Ctx, cleanup: Cleanup): Promise<void> {
  const config = realtimeOf(ctx);
  if (config === null || cleanup.length === 0) return;
  const sfu = sfuClient(config);
  await Promise.all(
    cleanup.map(async ({ sessionId, mids }) => {
      try {
        await sfu.closeForced(sessionId, mids);
      } catch (error) {
        logEvent("chat.call.cleanup_failed", {
          session: hashId(sessionId),
          code: error instanceof SfuError ? error.code : "unknown",
        });
      }
    }),
  );
}

/** For synchronous callers (the rail, `hello`, `call-beat`): expire now, close without waiting. */
function sweepInBackground(ctx: Ctx): void {
  const cleanup = expireStale(ctx);
  if (cleanup.length > 0) void flush(ctx, cleanup);
}

/**
 * The alarm's share: expire stale participants, close their tracks, prune spent stats budgets, and
 * say when the next live participant would go stale (null when no call is running).
 */
export async function runCallExpiry(ctx: Ctx): Promise<number | null> {
  await flush(ctx, expireStale(ctx));
  pruneCallStatsBudgets(ctx);
  const oldest = firstRow<{ value: number | null }>(
    ctx,
    `SELECT MIN(last_seen_at) AS value FROM call_participants WHERE left_at IS NULL`,
  )?.value;
  return oldest === null || oldest === undefined ? null : oldest + CALL_PARTICIPANT_TTL_MS + EXPIRY_SLACK_MS;
}

// ---------------------------------------------------------------------------
// Preconditions shared by the routes
// ---------------------------------------------------------------------------

function realtimeOf(ctx: Ctx): RealtimeConfig | null {
  return ctx.realtime ?? null;
}

/** The one refusal every call route gives on a deployment without Realtime credentials. */
export function unavailable<T>(): Outcome<T> {
  return refuse("unavailable", "Calls are not available on this deployment.");
}

function upstream<T>(error: unknown): Outcome<T> {
  if (!(error instanceof SfuError)) throw error;
  return refuse("upstream_error", `The call service refused that request (${error.code}).`);
}

/** The participant a request or frame names, if the caller owns it in that call and it is still there. */
function ownLiveParticipant(
  ctx: Ctx,
  user: UserRow,
  event: { readonly call: string; readonly participant: string },
  what: string,
): Outcome<ParticipantRow> {
  const row = loadParticipant(ctx, event.participant);
  if (row === null || row.call_id !== event.call || row.user_id !== user.id) {
    logDenial(what, { call: hashId(event.call), user: hashId(user.id) });
    return refuse("forbidden", "That participant is not yours.");
  }
  if (row.left_at !== null) return refuse("not_found", "You are no longer in this call.");
  return allow(row);
}

interface Owned {
  readonly config: RealtimeConfig;
  readonly call: CallRow;
  readonly participant: ParticipantRow;
}

/**
 * The preamble of every route addressed to `/calls/:callId`: calls on, budget, expiry, the call
 * running, the caller still able to read its conversation, and `participantId` a live row of theirs
 * in this call.
 */
async function owned(
  ctx: Ctx,
  user: UserRow,
  callId: string,
  participantId: string,
  bucket: "callJoins" | "callSignals" = "callSignals",
): Promise<Outcome<Owned>> {
  const config = realtimeOf(ctx);
  if (config === null) return unavailable();
  const budget = consume(ctx, user.id, bucket);
  if (!budget.ok) return budget;
  await flush(ctx, expireStale(ctx));
  const call = loadCall(ctx, callId);
  if (call === null) return refuse("not_found", "No such call.");
  const access = requireRead(ctx, call.channel_id, user.id);
  if (!access.ok) return refuse("not_found", "No such call.");
  const participant = ownLiveParticipant(ctx, user, { call: callId, participant: participantId }, "call_participant");
  if (!participant.ok) return participant;
  if (call.ended_at !== null) return refuse("not_found", "You are no longer in this call.");
  return allow({ config, call, participant: participant.value });
}

/** The same participant, re-read after an `await`: still live, and still on the same SFU session. */
function stillLive(ctx: Ctx, before: ParticipantRow): ParticipantRow | null {
  const row = loadParticipant(ctx, before.id);
  if (row === null || row.left_at !== null || row.sfu_session_id !== before.sfu_session_id) return null;
  return row;
}

/** A live participant of `callId` and one of their announced tracks, or null. */
function announcedTrack(
  ctx: Ctx,
  callId: string,
  participantId: string,
  name: string,
): { owner: ParticipantRow; track: StoredTrack } | null {
  const owner = loadParticipant(ctx, participantId);
  if (owner === null || owner.call_id !== callId || owner.left_at !== null) return null;
  const track = readTracks(owner).find((candidate) => candidate.name === name && candidate.announced);
  return track === undefined ? null : { owner, track };
}

/** Rewrites a participant's tracks and the flags that follow from them. */
function writeTracks(ctx: Ctx, row: ParticipantRow, tracks: readonly StoredTrack[], flags: Flags): void {
  ctx.sql.exec(
    `UPDATE call_participants SET tracks = ?, audio = ?, video = ?, screen = ? WHERE id = ?`,
    JSON.stringify(tracks),
    ...flagParams(flags),
    row.id,
  );
}

interface Flags {
  readonly audio: boolean;
  readonly video: boolean;
  readonly screen: boolean;
}

/** The `audio, video, screen` column values, in that order. */
function flagParams(flags: Flags): [number, number, number] {
  return [flags.audio ? 1 : 0, flags.video ? 1 : 0, flags.screen ? 1 : 0];
}

function flagsOf(row: ParticipantRow): Flags {
  return { audio: row.audio === 1, video: row.video === 1, screen: row.screen === 1 };
}

/** A flag can only be on while a track of its kind is announced. */
function clampFlags(flags: Flags, tracks: readonly StoredTrack[]): Flags {
  const has = (kind: CallTrackKind) => tracks.some((track) => track.kind === kind && track.announced);
  return { audio: flags.audio && has("audio"), video: flags.video && has("video"), screen: flags.screen && has("screen") };
}

function sameFlags(a: Flags, b: Flags): boolean {
  return a.audio === b.audio && a.video === b.video && a.screen === b.screen;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** `GET /channels/:channelId/call` */
export async function getCall(ctx: Ctx, user: UserRow, channelId: ChannelId): Promise<Outcome<CallResponse>> {
  if (realtimeOf(ctx) === null) return unavailable();
  const access = requireRead(ctx, channelId, user.id);
  if (!access.ok) return access;
  const budget = consume(ctx, user.id, "callSignals");
  if (!budget.ok) return budget;
  await flush(ctx, expireStale(ctx));
  const call = activeCallIn(ctx, channelId);
  return allow({ call: call === null ? null : toCallState(ctx, call) });
}

/**
 * `POST /channels/:channelId/call/join`: starts the call when none runs, adds the caller, and hands
 * back a fresh SFU session and ICE servers to negotiate on right away.
 */
export async function joinCall(ctx: Ctx, user: UserRow, channelId: ChannelId): Promise<Outcome<JoinCallResponse>> {
  const config = realtimeOf(ctx);
  if (config === null) return unavailable();
  const read = requireRead(ctx, channelId, user.id);
  if (!read.ok) return read;
  const { channel } = read.value;
  if (channel.archived_at !== null) return refuse("forbidden", "This channel is archived.");
  const budget = consume(ctx, user.id, "callJoins");
  if (!budget.ok) return budget;
  await flush(ctx, expireStale(ctx));

  // Early refusal of a full call, so a sixth person does not cost an SFU session. Rechecked below.
  const early = activeCallIn(ctx, channelId);
  if (early !== null && othersIn(ctx, early.id, user.id) >= MAX_CALL_PARTICIPANTS) return full();

  // In parallel, as orange does. A session created here and then refused below just expires.
  let sessionId: string;
  let iceServers: readonly CallIceServer[];
  try {
    [sessionId, iceServers] = await Promise.all([sfuClient(config).newSession(), iceServersFor(config)]);
  } catch (error) {
    return upstream(error);
  }

  // Everything from here to the fan-out is synchronous: no other request can interleave.
  const write = requireWrite(ctx, channelId, user.id);
  if (!write.ok) return write;
  const now = ctx.now();
  const participantId = newParticipantId(now);
  const insertParticipant = (callId: string) =>
    ctx.sql.exec(
      `INSERT INTO call_participants (id, call_id, user_id, sfu_session_id, joined_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      participantId,
      callId,
      user.id,
      sessionId,
      now,
      now,
    );

  let call = activeCallIn(ctx, channelId);
  let replaced: ParticipantRow | null = null;
  const started = call === null;
  if (call === null) {
    const callId = newCallId(now);
    // The call row and the first participant are written inside the message's transaction, so the
    // `msg` fan-out already carries `Message.call` with the starter in it.
    postSystemMessage(ctx, channelId, `${user.name} started a call`, (messageId) => {
      ctx.sql.exec(
        `INSERT INTO calls (id, channel_id, started_by, started_at, message_id) VALUES (?, ?, ?, ?, ?)`,
        callId,
        channelId,
        user.id,
        now,
        messageId,
      );
      insertParticipant(callId);
    });
    call = loadCall(ctx, callId)!;
    logEvent("chat.call.start", { call: hashId(callId), channel: hashId(channelId), kind: channel.kind });
  } else {
    const live = liveParticipants(ctx, call.id);
    replaced = live.find((row) => row.user_id === user.id) ?? null;
    if (live.length - (replaced === null ? 0 : 1) >= MAX_CALL_PARTICIPANTS) return full();
    const callId = call.id;
    ctx.storage.transactionSync(() => {
      if (replaced !== null) depart(ctx, replaced, now);
      insertParticipant(callId);
      ctx.sql.exec(
        `UPDATE calls SET peak_participants = MAX(peak_participants,
           (SELECT COUNT(*) FROM call_participants WHERE call_id = ? AND left_at IS NULL))
         WHERE id = ?`,
        callId,
        callId,
      );
    });
  }
  logEvent("chat.call.join", { call: hashId(call.id), user: hashId(user.id), replaced: replaced !== null });

  if (replaced !== null) {
    ctx.bus.toUsers([user.id], { t: "call-moved", call: call.id, participant: replaced.id, reason: "replaced" });
  }
  if (started) broadcastStart(ctx, call, channel.kind === "dm" || channel.kind === "group");
  else broadcastCall(ctx, call.id);
  const state = toCallState(ctx, call);

  await ctx.wakeAt(now + CALL_PARTICIPANT_TTL_MS + EXPIRY_SLACK_MS);
  if (replaced !== null) await flush(ctx, cleanupFor(replaced));
  return allow({ call: state, participantId, sessionId, iceServers });
}

function othersIn(ctx: Ctx, callId: string, userId: UserId): number {
  return liveParticipants(ctx, callId).filter((row) => row.user_id !== userId).length;
}

function full<T>(): Outcome<T> {
  return refuse("conflict", `This call is full (${MAX_CALL_PARTICIPANTS}).`);
}

/**
 * `POST /calls/:callId/publish`: the client's offer for new `sendonly` transceivers. The server names
 * each track, the SFU answers, and the tracks are recorded unannounced.
 */
export async function publishTracks(
  ctx: Ctx,
  user: UserRow,
  callId: string,
  request: PublishTracksRequest,
): Promise<Outcome<PublishTracksResponse>> {
  const pre = await owned(ctx, user, callId, request.participantId);
  if (!pre.ok) return pre;
  const { config, participant } = pre.value;
  const clash = (tracks: readonly StoredTrack[]) =>
    request.tracks.find((wanted) => tracks.some((track) => track.kind === wanted.kind));
  if (clash(readTracks(participant)) !== undefined) {
    return refuse("conflict", "You are already publishing a track of that kind; close it first.");
  }

  const named = request.tracks.map((track) => ({ ...track, name: `${participant.id}-${track.kind}` }));
  let result;
  try {
    result = await sfuClient(config).publish(
      participant.sfu_session_id,
      request.offer,
      named.map((track) => ({ mid: track.mid, trackName: track.name })),
    );
  } catch (error) {
    return upstream(error);
  }

  const now = stillLive(ctx, participant);
  if (now === null || clash(readTracks(now)) !== undefined) {
    // Left, reconnected or raced a second publish while the SFU answered: undo on the SFU.
    await flush(ctx, [{ sessionId: participant.sfu_session_id, mids: result.tracks.map((track) => track.mid) }]);
    return now === null
      ? refuse("not_found", "You are no longer in this call.")
      : refuse("conflict", "You are already publishing a track of that kind; close it first.");
  }
  const stored: StoredTrack[] = named.map((track) => ({
    name: track.name,
    kind: track.kind,
    mid: result.tracks.find((item) => item.trackName === track.name)?.mid ?? track.mid,
    simulcast: track.simulcast,
    announced: false,
  }));
  const tracks = [...readTracks(now), ...stored];
  writeTracks(ctx, now, tracks, flagsOf(now));
  return allow({
    answer: result.answer,
    tracks: stored.map((track) => ({ mid: track.mid, name: track.name, kind: track.kind })),
  });
}

/** `POST /calls/:callId/announce`: these published tracks have bytes flowing; make them visible. */
export async function announceTracks(
  ctx: Ctx,
  user: UserRow,
  callId: string,
  request: AnnounceTracksRequest,
): Promise<Outcome<CallResponse>> {
  const pre = await owned(ctx, user, callId, request.participantId);
  if (!pre.ok) return pre;
  const { call, participant } = pre.value;
  const tracks = readTracks(participant);
  if (request.names.some((name) => !tracks.some((track) => track.name === name))) {
    return refuse("not_found", "You have not published a track by that name.");
  }
  const next = tracks.map((track) => (request.names.includes(track.name) ? { ...track, announced: true } : track));
  const flags: { -readonly [K in keyof Flags]: Flags[K] } = { ...flagsOf(participant) };
  let changed = false;
  for (const track of next) {
    if (!request.names.includes(track.name)) continue;
    const was = tracks.find((candidate) => candidate.name === track.name)!;
    if (!was.announced) changed = true;
    // A newly flowing track starts on: the owner mutes afterwards with `call-beat`.
    if (!was.announced) flags[track.kind] = true;
  }
  if (changed) {
    writeTracks(ctx, participant, next, flags);
    broadcastCall(ctx, call.id);
  }
  return allow({ call: toCallState(ctx, loadCall(ctx, call.id)!) });
}

/**
 * `POST /calls/:callId/pull`: subscribe the caller's session to other participants' tracks. Every
 * one must be an announced track of a live participant of this same call; the publisher's session
 * comes from their row.
 */
export async function pullTracks(
  ctx: Ctx,
  user: UserRow,
  callId: string,
  request: PullTracksRequest,
): Promise<Outcome<PullTracksResponse>> {
  const pre = await owned(ctx, user, callId, request.participantId);
  if (!pre.ok) return pre;
  const { config, participant } = pre.value;

  const remotes: RemoteTrack[] = [];
  for (const wanted of request.tracks) {
    const found = announcedTrack(ctx, callId, wanted.participantId, wanted.name);
    if (found === null) {
      logDenial("call_pull", { call: hashId(callId), user: hashId(user.id) });
      return refuse("not_found", "That track is not available in this call.");
    }
    remotes.push({
      sessionId: found.owner.sfu_session_id,
      trackName: found.track.name,
      ...(found.track.simulcast ? { preferredRid: wanted.rid ?? DEFAULT_PULL_RID } : {}),
    });
  }

  let result;
  try {
    result = await sfuClient(config).pull(participant.sfu_session_id, remotes);
  } catch (error) {
    return upstream(error);
  }
  return allow({
    ...(result.offer === null ? {} : { offer: result.offer }),
    requiresImmediateRenegotiation: result.requiresImmediateRenegotiation,
    tracks: request.tracks.map((wanted, index) => {
      const item = result.tracks[index] ?? { mid: null, error: "missing_track" };
      return {
        participantId: wanted.participantId,
        name: wanted.name,
        mid: item.mid,
        ...(item.error === undefined ? {} : { error: item.error }),
      };
    }),
  });
}

/** `POST /calls/:callId/renegotiate`: the client's answer to an SFU offer. */
export async function renegotiateCall(
  ctx: Ctx,
  user: UserRow,
  callId: string,
  request: RenegotiateRequest,
): Promise<Outcome<OkResponse>> {
  const pre = await owned(ctx, user, callId, request.participantId);
  if (!pre.ok) return pre;
  try {
    await sfuClient(pre.value.config).renegotiate(pre.value.participant.sfu_session_id, request.answer);
  } catch (error) {
    return upstream(error);
  }
  return allow({ ok: true });
}

/**
 * `POST /calls/:callId/close-tracks`: close transceivers on the caller's own session, negotiated
 * (with an offer) or forced. Published tracks among them leave the call's state.
 */
export async function closeTracks(
  ctx: Ctx,
  user: UserRow,
  callId: string,
  request: CloseTracksRequest,
): Promise<Outcome<CloseTracksResponse>> {
  const pre = await owned(ctx, user, callId, request.participantId);
  if (!pre.ok) return pre;
  const { config, participant } = pre.value;
  const sfu = sfuClient(config);
  let answer = null;
  try {
    if (request.offer === undefined) await sfu.closeForced(participant.sfu_session_id, request.mids);
    else answer = await sfu.closeNegotiated(participant.sfu_session_id, request.mids, request.offer);
  } catch (error) {
    return upstream(error);
  }

  const now = stillLive(ctx, participant);
  if (now !== null) {
    const tracks = readTracks(now);
    const kept = tracks.filter((track) => !request.mids.includes(track.mid));
    if (kept.length !== tracks.length) {
      writeTracks(ctx, now, kept, clampFlags(flagsOf(now), kept));
      if (tracks.some((track) => track.announced && request.mids.includes(track.mid))) broadcastCall(ctx, callId);
    }
  }
  return allow(answer === null ? {} : { answer });
}

/** `POST /calls/:callId/layer`: the preferred simulcast layer of one track the caller pulls. */
export async function setLayer(
  ctx: Ctx,
  user: UserRow,
  callId: string,
  request: SetLayerRequest,
): Promise<Outcome<OkResponse>> {
  const pre = await owned(ctx, user, callId, request.participantId);
  if (!pre.ok) return pre;
  const found = announcedTrack(ctx, callId, request.trackParticipantId, request.name);
  if (found === null) return refuse("not_found", "That track is not available in this call.");
  if (!found.track.simulcast) return refuse("invalid_request", "That track has a single layer.");
  try {
    await sfuClient(pre.value.config).setLayer(pre.value.participant.sfu_session_id, request.mid, {
      sessionId: found.owner.sfu_session_id,
      trackName: found.track.name,
      preferredRid: request.rid,
    });
  } catch (error) {
    return upstream(error);
  }
  return allow({ ok: true });
}

/**
 * `POST /calls/:callId/reconnect`: a new SFU session for the same participant after the connection
 * failed. Its tracks are cleared (to be re-published and re-announced) and the old ones closed.
 */
export async function reconnectCall(
  ctx: Ctx,
  user: UserRow,
  callId: string,
  participantId: string,
): Promise<Outcome<JoinCallResponse>> {
  const pre = await owned(ctx, user, callId, participantId, "callJoins");
  if (!pre.ok) return pre;
  const { config, participant } = pre.value;
  let sessionId: string;
  let iceServers: readonly CallIceServer[];
  try {
    [sessionId, iceServers] = await Promise.all([sfuClient(config).newSession(), iceServersFor(config)]);
  } catch (error) {
    return upstream(error);
  }

  const before = loadParticipant(ctx, participant.id);
  if (before === null || before.left_at !== null) return refuse("not_found", "You are no longer in this call.");
  const now = ctx.now();
  ctx.sql.exec(
    `UPDATE call_participants
        SET sfu_session_id = ?, tracks = '[]', audio = 0, video = 0, screen = 0, last_seen_at = ?
      WHERE id = ?`,
    sessionId,
    now,
    before.id,
  );
  logEvent("chat.call.reconnect", { call: hashId(callId), user: hashId(user.id) });
  broadcastCall(ctx, callId);
  const state = toCallState(ctx, loadCall(ctx, callId)!);
  await ctx.wakeAt(now + CALL_PARTICIPANT_TTL_MS + EXPIRY_SLACK_MS);
  await flush(ctx, cleanupFor(before));
  return allow({ call: state, participantId: before.id, sessionId, iceServers });
}

/**
 * `POST /calls/:callId/leave`. Idempotent: leaving a call already left or already ended is fine.
 * Only the owner's own participant can be left, and leaving needs no channel access -- somebody
 * just removed from a private channel must still be able to hang up.
 */
export async function leaveCall(
  ctx: Ctx,
  user: UserRow,
  callId: string,
  participantId: string,
): Promise<Outcome<OkResponse>> {
  if (realtimeOf(ctx) === null) return unavailable();
  const budget = consume(ctx, user.id, "callSignals");
  if (!budget.ok) return budget;
  const participant = loadParticipant(ctx, participantId);
  if (participant === null || participant.call_id !== callId || participant.user_id !== user.id) {
    logDenial("call_leave", { call: hashId(callId), user: hashId(user.id) });
    return refuse("forbidden", "That participant is not yours.");
  }
  const cleanup = expireStale(ctx);
  const current = loadParticipant(ctx, participantId)!;
  if (current.left_at === null) {
    const now = ctx.now();
    cleanup.push(...depart(ctx, current, now));
    logEvent("chat.call.leave", { call: hashId(callId), user: hashId(user.id) });
    settle(ctx, callId, now);
  }
  await flush(ctx, cleanup);
  return allow({ ok: true });
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

/**
 * `{t:"call-beat"}`: the participant's heartbeat and mute state. Writes `last_seen_at` every time and
 * the flags only when they change, which is also the only time it broadcasts. A flag cannot be on
 * without an announced track of its kind.
 */
export function callBeat(ctx: Ctx, user: UserRow, beat: Extract<ClientEvent, { t: "call-beat" }>): Outcome<void> {
  if (realtimeOf(ctx) === null) return unavailable();
  const participant = ownLiveParticipant(ctx, user, beat, "call_beat");
  if (!participant.ok) return participant;
  const row = participant.value;
  const now = ctx.now();
  const flags = clampFlags(beat, readTracks(row));
  const changed = !sameFlags(flags, flagsOf(row));
  if (changed) {
    // Charged only when it fans out: a steady heartbeat is free, a flapping one is bounded.
    const budget = consume(ctx, user.id, "callSignals");
    if (!budget.ok) return budget;
  }
  ctx.sql.exec(
    `UPDATE call_participants SET last_seen_at = ?, audio = ?, video = ?, screen = ? WHERE id = ?`,
    now,
    ...flagParams(flags),
    row.id,
  );
  if (changed) broadcastCall(ctx, row.call_id);
  sweepInBackground(ctx);
  return allow(undefined);
}

/**
 * `{t:"call-hand"}`: raise or lower the hand. Only a change writes, broadcasts and costs a signal from
 * the same budget as mute changes; raising a raised hand keeps its place in the queue.
 */
export function callHand(ctx: Ctx, user: UserRow, event: Extract<ClientEvent, { t: "call-hand" }>): Outcome<void> {
  if (realtimeOf(ctx) === null) return unavailable();
  const participant = ownLiveParticipant(ctx, user, event, "call_hand");
  if (!participant.ok) return participant;
  const row = participant.value;
  if ((row.hand_at !== null) === event.raised) return allow(undefined);
  const budget = consume(ctx, user.id, "callSignals");
  if (!budget.ok) return budget;
  ctx.sql.exec(`UPDATE call_participants SET hand_at = ? WHERE id = ?`, event.raised ? ctx.now() : null, row.id);
  logEvent("chat.call.hand", { call: hashId(row.call_id), raised: event.raised });
  broadcastCall(ctx, row.call_id);
  return allow(undefined);
}

/**
 * `{t:"call-react"}`: fan a reaction out to the conversation, the sender included (their other
 * windows, and their own overlay comes from the same event as everybody else's). Nothing is stored.
 */
export function callReact(ctx: Ctx, user: UserRow, event: Extract<ClientEvent, { t: "call-react" }>): Outcome<void> {
  if (realtimeOf(ctx) === null) return unavailable();
  const participant = ownLiveParticipant(ctx, user, event, "call_react");
  if (!participant.ok) return participant;
  const row = participant.value;
  if (!reactionAllowed(row.id, ctx.now(), CALL_REACTION_BURST, CALL_REACTION_WINDOW_MS)) {
    return refuse("rate_limited", "Slow down: too many reactions.", Math.ceil(CALL_REACTION_WINDOW_MS / 1000));
  }
  const call = loadCall(ctx, row.call_id);
  if (call === null || call.ended_at !== null) return refuse("not_found", "That call has ended.");
  ctx.bus.toChannel(call.channel_id, {
    t: "call-react",
    channel: call.channel_id,
    call: call.id,
    participant: row.id,
    emoji: event.emoji,
  });
  return allow(undefined);
}
