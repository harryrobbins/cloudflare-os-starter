// The WebSocket half: accept, fan-out, the four client commands, and presence.
//
// **Hibernation.** Sockets are accepted with `ctx.acceptWebSocket(ws, [userId])` so the object can be
// evicted between frames. Everything a socket needs to be understood after that eviction lives in its
// `serializeAttachment()` payload ({@link SocketAttachment}); everything else is re-read from SQLite.
//
// **Authorization.** The tag is the user id, so `getWebSockets(userId)` is the personal channel.
// Membership is rechecked from SQLite on `sub`, on every command and on every fan-out, never cached
// in the attachment: a socket that was a member when it subscribed must stop receiving a private
// channel the moment it is removed from it.
//
// **Subscriptions are a filter, not a permission.** A socket that has subscribed receives the
// channels it named; a socket that has subscribed to nothing receives every channel it is entitled
// to. That keeps a naive client correct and lets a busy one narrow the traffic.
//
// **Presence expires lazily.** A user is online while one of their sockets sent a frame within
// {@link PRESENCE_TTL_MS}; clients ping every {@link WS_HEARTBEAT_MS}. There is no presence alarm --
// the only alarm this object owns is the upload sweep -- so the set is recomputed whenever somebody
// asks for it or a connect or disconnect makes it worth broadcasting. A close event alone is not
// enough to know somebody left (the plan says so), and a hibernating socket is still open, so the
// heartbeat is the only honest signal.

import {
  MAX_CLIENT_FRAME_BYTES,
  MAX_SUBSCRIPTIONS,
  PRESENCE_TTL_MS,
  PROTOCOL_VERSION,
  TYPING_THROTTLE_MS,
  type ChannelId,
  type ServerEvent,
  type SocketAttachment,
  type UserId,
} from "../shared/protocol.js";
import { parseClientEvent, utf8Bytes } from "../shared/validate.js";
import { loadMembership, recipientsOf, requireRead } from "./access.js";
import type { Broadcaster, Ctx } from "./context.js";
import { newSessionId } from "./ids.js";
import { typingAllowed } from "./limits.js";
import { hashId, logDenial, logEvent } from "./logs.js";
import { toUser, type UserRow } from "./rows.js";
import { badgeSummary } from "./unread.js";
import { markRead } from "./channels.js";
import { loadUserRow } from "./users.js";

export function readAttachment(ws: WebSocket): SocketAttachment | null {
  const raw: unknown = ws.deserializeAttachment();
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Partial<SocketAttachment>;
  if (typeof candidate.userId !== "string" || typeof candidate.sessionId !== "string") return null;
  return {
    userId: candidate.userId,
    sessionId: candidate.sessionId,
    channels: Array.isArray(candidate.channels) ? candidate.channels : [],
    connectedAt: typeof candidate.connectedAt === "number" ? candidate.connectedAt : 0,
    lastSeenAt: typeof candidate.lastSeenAt === "number" ? candidate.lastSeenAt : 0,
  };
}

function writeAttachment(ws: WebSocket, attachment: SocketAttachment): void {
  ws.serializeAttachment(attachment);
}

function send(ws: WebSocket, event: ServerEvent): void {
  try {
    ws.send(JSON.stringify(event));
  } catch {
    // A socket that closed between the membership query and this call is not an error worth
    // failing the request that triggered the fan-out.
  }
}

/** A socket receives a channel event when it asked for that channel, or asked for nothing. */
function wants(attachment: SocketAttachment, channelId: ChannelId): boolean {
  return attachment.channels.length === 0 || attachment.channels.includes(channelId);
}

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

export function createBroadcaster(state: DurableObjectState, getCtx: () => Ctx): Broadcaster {
  let onlineAt = -1;
  let onlineSet: readonly UserId[] = [];

  function liveAttachments(): readonly { ws: WebSocket; attachment: SocketAttachment }[] {
    const out: { ws: WebSocket; attachment: SocketAttachment }[] = [];
    for (const ws of state.getWebSockets()) {
      const attachment = readAttachment(ws);
      if (attachment !== null) out.push({ ws, attachment });
    }
    return out;
  }

  const bus: Broadcaster = {
    toUsers(userIds, event) {
      const seen = new Set<UserId>();
      for (const userId of userIds) {
        if (seen.has(userId)) continue;
        seen.add(userId);
        for (const ws of state.getWebSockets(userId)) send(ws, event);
      }
    },

    toAll(event) {
      for (const ws of state.getWebSockets()) send(ws, event);
    },

    toChannel(channelId, event, options) {
      const recipients = recipientsOf(getCtx(), channelId);
      const allowed = recipients.everyone ? null : new Set(recipients.userIds);
      for (const { ws, attachment } of liveAttachments()) {
        if (allowed !== null && !allowed.has(attachment.userId)) continue;
        if (options?.exclude === attachment.userId) continue;
        if (!wants(attachment, channelId)) continue;
        send(ws, event);
      }
    },

    badges(userIds) {
      const ctx = getCtx();
      const seen = new Set<UserId>();
      for (const userId of userIds) {
        if (seen.has(userId)) continue;
        seen.add(userId);
        const sockets = state.getWebSockets(userId);
        if (sockets.length === 0) continue;
        const summary = badgeSummary(ctx, userId);
        for (const ws of sockets) send(ws, { t: "badge", ...summary });
      }
    },

    online() {
      const now = Date.now();
      if (now === onlineAt) return onlineSet;
      const fresh = new Set<UserId>();
      for (const { attachment } of liveAttachments()) {
        if (now - attachment.lastSeenAt <= PRESENCE_TTL_MS) fresh.add(attachment.userId);
      }
      onlineAt = now;
      onlineSet = [...fresh];
      return onlineSet;
    },

    isOnline(userId) {
      return bus.online().includes(userId);
    },
  };
  return bus;
}

function broadcastPresence(ctx: Ctx): void {
  ctx.bus.toAll({ t: "presence", online: [...ctx.bus.online()] });
}

// ---------------------------------------------------------------------------
// Upgrade
// ---------------------------------------------------------------------------

/** Accepts the upgrade and sends `hello`. The caller has already verified the Access assertion. */
export function acceptSocket(ctx: Ctx, state: DurableObjectState, user: UserRow): Response {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  const now = ctx.now();
  const sessionId = newSessionId(now);

  state.acceptWebSocket(server, [user.id]);
  writeAttachment(server, {
    userId: user.id,
    sessionId,
    channels: [],
    connectedAt: now,
    lastSeenAt: now,
  });

  const lastSeq: Record<ChannelId, number> = {};
  for (const row of ctx.sql
    .exec<{ id: string; last_seq: number }>(
      `SELECT c.id AS id, c.last_seq AS last_seq FROM channels c
         JOIN memberships m ON m.channel_id = c.id AND m.user_id = ?`,
      user.id,
    )
    .toArray()) {
    lastSeq[row.id] = row.last_seq;
  }

  send(server, {
    t: "hello",
    user: toUser(user, true),
    sessionId,
    serverTime: now,
    protocolVersion: PROTOCOL_VERSION,
    lastSeq,
  });
  send(server, { t: "badge", ...badgeSummary(ctx, user.id) });
  broadcastPresence(ctx);
  logEvent("chat.ws.connect", { user: hashId(user.id), sockets: state.getWebSockets().length });

  return new Response(null, { status: 101, webSocket: client });
}

export function socketClosed(ctx: Ctx, userId: UserId | null): void {
  logEvent("chat.ws.close", { user: hashId(userId) });
  broadcastPresence(ctx);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function handleFrame(ctx: Ctx, ws: WebSocket, raw: string | ArrayBuffer): void {
  const attachment = readAttachment(ws);
  if (attachment === null) {
    send(ws, { t: "error", code: "unauthenticated", message: "This socket has no identity." });
    ws.close(1008, "no identity");
    return;
  }

  const size = typeof raw === "string" ? utf8Bytes(raw) : raw.byteLength;
  if (size > MAX_CLIENT_FRAME_BYTES) {
    logDenial("ws_frame_size", { user: hashId(attachment.userId), bytes: size });
    send(ws, { t: "error", code: "payload_too_large", message: "That frame is too large." });
    return;
  }

  const now = ctx.now();
  // Every frame is a heartbeat: presence expires from this, not from a close event.
  writeAttachment(ws, { ...attachment, lastSeenAt: now });

  const parsed = parseClientEvent(raw);
  if (!parsed.ok) {
    send(ws, { t: "error", code: "invalid_request", message: parsed.message });
    return;
  }

  const user = loadUserRow(ctx, attachment.userId);
  if (user === null) {
    send(ws, { t: "error", code: "unauthenticated", message: "Unknown user." });
    ws.close(1008, "unknown user");
    return;
  }

  switch (parsed.value.t) {
    case "ping":
      return;

    case "sub": {
      const requested = parsed.value.channels.slice(0, MAX_SUBSCRIPTIONS);
      const permitted = requested.filter((channelId) => requireRead(ctx, channelId, user.id).ok);
      writeAttachment(ws, { ...attachment, channels: permitted, lastSeenAt: now });
      if (permitted.length !== requested.length) {
        logDenial("ws_sub", { user: hashId(user.id), dropped: requested.length - permitted.length });
        send(ws, {
          t: "error",
          code: "forbidden",
          message: `${requested.length - permitted.length} channel(s) could not be subscribed.`,
        });
      }
      return;
    }

    case "read": {
      const result = markRead(ctx, user, parsed.value.channel, { seq: parsed.value.seq });
      if (!result.ok) {
        logDenial("ws_read", { user: hashId(user.id), channel: hashId(parsed.value.channel) });
        send(ws, { t: "error", code: result.code, message: result.message });
      }
      return;
    }

    case "typing": {
      const channelId = parsed.value.channel;
      // Membership first, throttle second: a refused typing frame must not consume the budget that
      // would otherwise let a legitimate one through.
      const membership = loadMembership(ctx, channelId, user.id);
      const access = requireRead(ctx, channelId, user.id);
      if (!access.ok || (access.value.channel.kind !== "public" && membership === null)) {
        logDenial("ws_typing", { user: hashId(user.id), channel: hashId(channelId) });
        send(ws, { t: "error", code: "forbidden", message: "Not a member of that conversation." });
        return;
      }
      if (!typingAllowed(user.id, channelId, now, TYPING_THROTTLE_MS)) return;
      // Never persisted: a typing indicator is worth nothing a second after it was sent.
      ctx.bus.toChannel(channelId, { t: "typing", channel: channelId, user: user.id }, { exclude: user.id });
      return;
    }
  }
}
