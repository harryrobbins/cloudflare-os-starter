// The complete wire contract for `cfos-chat`: HTTP bodies, WebSocket events and the few
// server-internal shapes both halves of the Worker share. Types only -- no runtime code, so the SPA
// bundle imports it for free. Runtime narrowing of anything inbound lives in `./validate.ts`.
//
// Derived from docs/plans/chat.md ("HTTP API", "Live updates", "Storage", and the UX sections).
// Every field the plan's SQL schema exposes to a client appears here in camelCase; nothing that the
// plan keeps server-side (r2_key, push subscription secrets, agent_links) does.

/** Protocol version, sent in `hello`. Bump on any breaking change to the events below. */
export const PROTOCOL_VERSION = 1;

/** Cloudflare Access `sub`. Stable across email changes, unlike the address. */
export type UserId = string;
export type ChannelId = string;
export type MessageId = string;
export type AttachmentId = string;

/** Milliseconds since the epoch. The DO stores integers; the client never parses a date string. */
export type Timestamp = number;

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export type ChannelKind = "public" | "private" | "dm" | "group";
/** `agent` is the one built-in account; everyone else signs in through Access. */
export type UserKind = "person" | "agent";
export type MessageKind = "user" | "system" | "agent";
export type NotifyLevel = "all" | "mentions" | "none";
export type MentionKind = "user" | "channel" | "here" | "agent";

export interface User {
  readonly id: UserId;
  /** Display name: the Access identity's `name`, else the email local part, else a profile override. */
  readonly name: string;
  /**
   * Normalized email. Present for the signed-in user and for directory entries; a mutable contact
   * field, never an identity key.
   */
  readonly email: string | null;
  readonly avatarKey: string | null;
  readonly firstSeenAt: Timestamp;
  readonly lastSeenAt: Timestamp;
  readonly tz: string | null;
  /** Approximate: true while at least one WebSocket tagged with this id is connected. */
  readonly online: boolean;
  /** Absent means `person`; only the built-in {@link AGENT_USER_ID} row is an `agent`. */
  readonly kind?: UserKind;
}

export interface Channel {
  readonly id: ChannelId;
  readonly kind: ChannelKind;
  /** Null for `dm` and `group`, which the client names from `memberIds`. */
  readonly name: string | null;
  readonly topic: string | null;
  readonly purpose: string | null;
  readonly createdBy: UserId;
  readonly createdAt: Timestamp;
  readonly archived: boolean;
  readonly memberCount: number;
  /** Highest `seq` committed in this channel. Unread arithmetic and paging both use it. */
  readonly lastSeq: number;
  /** Populated for `dm` and `group` only, and only for members. */
  readonly memberIds?: readonly UserId[];
}

/** The signed-in user's own row in `memberships`. Never another user's. */
export interface Membership {
  readonly channelId: ChannelId;
  readonly userId: UserId;
  readonly joinedAt: Timestamp;
  readonly lastReadSeq: number;
  /**
   * "Mark unread from here". Separate from `lastReadSeq` because moving that cursor backwards would
   * re-notify old mentions and fight another tab's read acknowledgement.
   */
  readonly manualUnreadSeq: number | null;
  readonly notify: NotifyLevel;
  readonly muted: boolean;
  readonly starred: boolean;
}

export interface Attachment {
  readonly id: AttachmentId;
  /** Null while the upload is pending, i.e. before the message that carries it is committed. */
  readonly messageId: MessageId | null;
  readonly channelId: ChannelId;
  readonly uploaderId: UserId;
  readonly name: string;
  /** Sniffed server-side for images; never the client's claim. */
  readonly mime: string;
  readonly bytes: number;
  readonly width: number | null;
  readonly height: number | null;
  /** True when a server-generated thumbnail exists at `filePath(id, true)`. */
  readonly hasThumb: boolean;
  readonly createdAt: Timestamp;
}

export interface Reaction {
  readonly emoji: string;
  readonly userIds: readonly UserId[];
}

export type Mention =
  | { readonly kind: "user"; readonly userId: UserId }
  | { readonly kind: "channel" | "here" | "agent" };

export interface Message {
  readonly id: MessageId;
  readonly channelId: ChannelId;
  /** Per-channel and monotonic. Thread replies get one too, so a reply permalink works. */
  readonly seq: number;
  /** Null for a top-level message; the root's id for a thread reply. */
  readonly rootId: MessageId | null;
  readonly authorId: UserId;
  /** Markdown, capped at {@link MAX_BODY_BYTES}. Blank for a tombstone. */
  readonly body: string;
  readonly kind: MessageKind;
  readonly createdAt: Timestamp;
  readonly editedAt: Timestamp | null;
  /** Non-null means a tombstone: a deleted root that still has replies. */
  readonly deletedAt: Timestamp | null;
  readonly replyCount: number;
  readonly lastReplyAt: Timestamp | null;
  readonly reactions: readonly Reaction[];
  readonly attachments: readonly Attachment[];
  readonly mentions: readonly Mention[];
  /** Echoed back on the sender's own message so an optimistic row can be reconciled. */
  readonly clientId?: string;
}

export interface ThreadSummary {
  readonly rootId: MessageId;
  readonly channelId: ChannelId;
  readonly root: Message;
  readonly replyCount: number;
  readonly lastReplyAt: Timestamp | null;
  readonly lastReadReplySeq: number;
  readonly unreadReplies: number;
  readonly following: boolean;
  /** Most recent repliers first, capped server-side; enough to render the avatar stack. */
  readonly participantIds: readonly UserId[];
}

/** Everything the rail badges and the document title need, in one object. */
export interface BadgeSummary {
  readonly unread: Readonly<Record<ChannelId, number>>;
  readonly mentions: Readonly<Record<ChannelId, number>>;
  readonly threads: number;
}

export interface UserPrefs {
  /** Overrides the Access-derived name when the IdP supplies nothing useful. */
  readonly displayName: string | null;
  readonly tz: string | null;
  /** Default for conversations with no explicit setting. */
  readonly notify: NotifyLevel;
}

// ---------------------------------------------------------------------------
// Built-in rows and the mention token
// ---------------------------------------------------------------------------

/**
 * The reserved agent account. It is an implicit member of every public channel (the Durable Object
 * materialises a membership row so every membership query stays one query), and it is the identity
 * the Gatekeeper vendor uses when the agent reads or posts.
 */
export const AGENT_USER_ID: UserId = "agent";
export const AGENT_USER_NAME = "Agent";

/** Seeded on first boot. Public, and the one channel nobody may leave. */
export const GENERAL_CHANNEL_ID: ChannelId = "general";
export const GENERAL_CHANNEL_NAME = "general";

/**
 * A mention in a message body is an immutable id token, never a display name: names are neither
 * unique nor stable (chat.md, "Unread and mention model"). Autocomplete inserts `<@userId>`; the
 * server extracts the ids, checks them against real users, and stores them in `mentions`. The
 * renderer resolves each token back to the current display name at paint time.
 *
 * The source string rather than a `RegExp`, because a shared global regex carries `lastIndex`
 * between callers. {@link mentionToken} and `extractMentionIds` in `./validate.ts` build one per
 * call.
 */
export const MENTION_TOKEN_SOURCE = String.raw`<@([A-Za-z0-9_-]{1,64})>`;

// ---------------------------------------------------------------------------
// Limits (shared so the client can reject before a round trip)
// ---------------------------------------------------------------------------

/** Markdown body cap, in UTF-8 bytes. */
export const MAX_BODY_BYTES = 8 * 1024;
/** Default upload cap; `deployment.jsonc` `chat.maxUploadBytes` may lower it. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_CHANNEL_NAME_LENGTH = 80;
export const MAX_TOPIC_LENGTH = 250;
export const MAX_PURPOSE_LENGTH = 500;
export const MAX_DISPLAY_NAME_LENGTH = 80;
/** Largest `limit` a history or search page will serve. */
export const MAX_PAGE_LIMIT = 100;
export const DEFAULT_PAGE_LIMIT = 50;
/** Channels one socket may subscribe to, so a `sub` frame cannot be used to fan out everything. */
export const MAX_SUBSCRIPTIONS = 200;
/** Largest inbound WebSocket frame accepted, in bytes. */
export const MAX_CLIENT_FRAME_BYTES = 16 * 1024;
/** A reaction is a single emoji, not arbitrary text. */
export const MAX_EMOJI_LENGTH = 32;
/** Attachments per message. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/** Server-enforced per-user budgets. Starting values, to be tuned from measurements. */
export const RATE_LIMITS = {
  messagesPerMinute: 30,
  uploadsPerHour: 20,
  searchesPerMinute: 60,
} as const;

/**
 * How often a connected client should send `{t:"ping"}`.
 *
 * Presence is derived from the newest frame each socket sent, not from close events, so a socket
 * that stops pinging drops out of `presence` after {@link PRESENCE_TTL_MS} even though hibernation
 * keeps it open.
 */
export const WS_HEARTBEAT_MS = 30_000;
/** A socket counts as online while its last frame is newer than this. */
export const PRESENCE_TTL_MS = 90_000;
/** Minimum gap between two `typing` frames for one conversation; extra frames are dropped. */
export const TYPING_THROTTLE_MS = 2_000;
/** How long an uploaded but unattached object survives before the sweep alarm deletes it. */
export const PENDING_UPLOAD_TTL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Closed set. The client switches on the code; `message` is for humans and is never a stack trace
 * (the workers-chat-demo error handler leaks those -- see chat.md).
 */
export const ERROR_CODES = [
  "unauthenticated",
  "forbidden",
  "not_found",
  "invalid_request",
  "conflict",
  "payload_too_large",
  "rate_limited",
  "not_implemented",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorEnvelope {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    /** Present on `rate_limited`: seconds until the budget refills. */
    readonly retryAfter?: number;
  };
}

/** HTTP status each code is served with. One mapping, so a handler cannot invent its own. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  conflict: 409,
  payload_too_large: 413,
  rate_limited: 429,
  not_implemented: 501,
  internal: 500,
};

// ---------------------------------------------------------------------------
// HTTP: requests and responses, route by route
// ---------------------------------------------------------------------------

/** `GET /api/me` */
export interface MeResponse {
  readonly user: User;
  readonly prefs: UserPrefs;
  /** From the `ADMINS` var, after identity verification. Never a client-supplied flag. */
  readonly admin: boolean;
  readonly badges: BadgeSummary;
  readonly limits: {
    readonly maxBodyBytes: number;
    readonly maxUploadBytes: number;
    readonly maxAttachmentsPerMessage: number;
  };
  readonly protocolVersion: number;
}

/** `PATCH /api/me` */
export interface UpdateMeRequest {
  readonly displayName?: string | null;
  readonly tz?: string | null;
  readonly notify?: NotifyLevel;
}

/** `PATCH /api/me`, `PUT /api/me/avatar` */
export interface UserResponse {
  readonly user: User;
  readonly prefs: UserPrefs;
}

/** `GET /api/channels` -- the whole rail in one request. */
export interface ChannelListResponse {
  readonly channels: readonly Channel[];
  /** The caller's own memberships, one per channel they belong to. */
  readonly memberships: readonly Membership[];
  /** Everyone referenced by a DM or group channel above, so the rail can render names. */
  readonly users: readonly User[];
  readonly badges: BadgeSummary;
}

/** `POST /api/channels` */
export interface CreateChannelRequest {
  readonly kind: ChannelKind;
  /** Required for `public` and `private`; must be absent for `dm` and `group`. */
  readonly name?: string;
  readonly topic?: string;
  readonly purpose?: string;
  /** Required for `dm` (exactly one other user) and `group`; optional seed for `private`. */
  readonly memberIds?: readonly UserId[];
}

/** `PATCH /api/channels/:channelId` */
export interface UpdateChannelRequest {
  readonly name?: string;
  readonly topic?: string | null;
  readonly purpose?: string | null;
}

/** `POST /api/channels`, `PATCH …`, `POST …/{join,leave,archive}` */
export interface ChannelResponse {
  readonly channel: Channel;
  /** Absent after `leave`. */
  readonly membership: Membership | null;
  /** A system message ("Harry archived #old") when the action produced one. */
  readonly systemMessage?: Message;
}

/**
 * `PATCH /api/channels/:channelId/membership`
 *
 * Per-conversation preferences, all optional and independently settable. Separate from
 * {@link UpdateChannelRequest}, which changes the channel for everybody: these three fields are the
 * caller's own row in `memberships` and nobody else can see them.
 */
export interface UpdateMembershipRequest {
  readonly notify?: NotifyLevel;
  /** A muted conversation never badges, whatever `notify` says. */
  readonly muted?: boolean;
  readonly starred?: boolean;
}

/** `PATCH /api/channels/:channelId/membership`. Carries badges: muting changes the counts. */
export interface MembershipResponse {
  readonly membership: Membership;
  readonly badges: BadgeSummary;
}

/**
 * `POST /api/channels/:channelId/read`
 *
 * Exactly one of the two fields. `seq` advances `lastReadSeq` (never backwards);
 * `manualUnreadSeq` sets or clears the "unread from here" marker.
 */
export interface MarkReadRequest {
  readonly seq?: number;
  readonly manualUnreadSeq?: number | null;
}

export interface MarkReadResponse {
  readonly membership: Membership;
  readonly badges: BadgeSummary;
}

/**
 * `GET /api/channels/:channelId/messages` query string.
 *
 * At most one cursor. `around` serves a permalink: a page centred on that message.
 * `rootId` restricts the page to one thread.
 */
export interface ListMessagesQuery {
  readonly before?: number;
  readonly after?: number;
  readonly around?: MessageId;
  readonly rootId?: MessageId;
  readonly limit?: number;
}

/** How far somebody else has read. The "seen by" line under the last message of a conversation. */
export interface ReadCursor {
  readonly userId: UserId;
  readonly lastReadSeq: number;
}

export interface MessagePageResponse {
  /** Ascending by `seq`. */
  readonly messages: readonly Message[];
  readonly hasMoreBefore: boolean;
  readonly hasMoreAfter: boolean;
  /** Authors of the page, so the client needs no second directory fetch. */
  readonly users: readonly User[];
  readonly channelLastSeq: number;
  /**
   * The other members' read cursors, for `dm` and `group` only.
   *
   * Absent for `public` and `private`: a channel can have every person in the deployment in it, and
   * "seen by" is a two-or-a-handful-of-people feature. The caller's own cursor is not here either --
   * it is on their {@link Membership}.
   */
  readonly readCursors?: readonly ReadCursor[];
}

/** `POST /api/channels/:channelId/messages` */
export interface SendMessageRequest {
  readonly body: string;
  readonly rootId?: MessageId;
  readonly attachmentIds?: readonly AttachmentId[];
  /** Client-generated; makes a retry idempotent. Required, not optional. */
  readonly clientId: string;
}

export interface SendMessageResponse {
  readonly message: Message;
  /** True when this `clientId` had already been committed, so nothing new was written. */
  readonly deduped: boolean;
  readonly badges: BadgeSummary;
}

/** `PATCH /api/messages/:messageId` */
export interface EditMessageRequest {
  readonly body: string;
}

export interface MessageResponse {
  readonly message: Message;
}

/** `DELETE /api/messages/:messageId` */
export interface DeleteMessageResponse {
  readonly id: MessageId;
  readonly channelId: ChannelId;
  /** The blanked row when replies keep it visible; null when the message vanished entirely. */
  readonly tombstone: Message | null;
}

/** `PUT`/`DELETE /api/messages/:messageId/reactions/:emoji` */
export interface ReactionResponse {
  readonly messageId: MessageId;
  readonly channelId: ChannelId;
  readonly reactions: readonly Reaction[];
}

/** `GET /api/threads` query string. */
export interface ListThreadsQuery {
  readonly unread?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ThreadListResponse {
  readonly threads: readonly ThreadSummary[];
  readonly users: readonly User[];
  readonly cursor: string | null;
}

export interface ThreadResponse {
  readonly thread: ThreadSummary;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export type SearchHasFilter = "image" | "file" | "link";

/**
 * A parsed `GET /api/search?q=` string. The server does the parsing: qualifiers become bound SQL
 * parameters and `text` becomes an escaped FTS5 query, never interpolation.
 */
export interface SearchQuery {
  /** Free text with qualifiers stripped. May be empty when only qualifiers were given. */
  readonly text: string;
  readonly in?: readonly ChannelId[];
  readonly from?: readonly UserId[];
  /** `to:me` resolves to the caller's id before it reaches the query. */
  readonly to?: readonly UserId[];
  readonly has?: readonly SearchHasFilter[];
  readonly isThread?: boolean;
  /** Inclusive day boundaries, already resolved to epoch milliseconds in the caller's tz. */
  readonly before?: Timestamp;
  readonly after?: Timestamp;
}

export interface SearchHit {
  readonly message: Message;
  readonly channelId: ChannelId;
  /** FTS5 `snippet()` output, with the marks the client's renderer expects. */
  readonly snippet: string;
  /** FTS5 `bm25()`; lower is a better match. */
  readonly score: number;
  /** The thread root when the hit is a reply, so the result can show its context. */
  readonly root: Message | null;
}

export interface SearchResult {
  /** What the server actually ran, so the UI can show the interpreted qualifiers. */
  readonly query: SearchQuery;
  readonly hits: readonly SearchHit[];
  /** Name matches, shown above message results. */
  readonly channels: readonly Channel[];
  readonly users: readonly User[];
  readonly cursor: string | null;
}

// ---------------------------------------------------------------------------
// Uploads, directory, push
// ---------------------------------------------------------------------------

/**
 * `POST /api/uploads` is `multipart/form-data`, not JSON: `channelId` plus one `file` part. The
 * response carries the pending attachment; `SendMessageRequest.attachmentIds` commits it.
 */
export interface UploadResponse {
  readonly attachment: Attachment;
}

export interface UserListResponse {
  readonly users: readonly User[];
  readonly cursor: string | null;
}

/** `PUT /api/me/avatar` is `multipart/form-data` with one `file` part. */

/** `POST`/`DELETE /api/push/subscribe` */
export interface PushSubscribeRequest {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export interface OkResponse {
  readonly ok: true;
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

/**
 * Client to server. The set the plan fixes; anything else is answered with an `error` event and the
 * frame is dropped rather than closing the socket, so a newer client cannot be locked out by an
 * older server.
 */
export type ClientEvent =
  | { readonly t: "sub"; readonly channels: readonly ChannelId[] }
  | { readonly t: "typing"; readonly channel: ChannelId }
  | { readonly t: "read"; readonly channel: ChannelId; readonly seq: number }
  | { readonly t: "ping" };

export type ClientEventType = ClientEvent["t"];

/**
 * Server to client.
 *
 * `del` and `react` carry `channel` as well as the message id, which the plan's sketch omits: the
 * client stores messages per channel and a bare id would force a scan of every open conversation.
 */
export type ServerEvent =
  | {
      readonly t: "hello";
      readonly user: User;
      /** Identifies this socket, so the client can ignore its own echoed events. */
      readonly sessionId: string;
      readonly serverTime: Timestamp;
      readonly protocolVersion: number;
      /** Per-channel high-water marks at connect time, so the client knows what to catch up on. */
      readonly lastSeq: Readonly<Record<ChannelId, number>>;
    }
  | { readonly t: "msg"; readonly message: Message }
  | { readonly t: "edit"; readonly message: Message }
  | {
      readonly t: "del";
      readonly channel: ChannelId;
      readonly id: MessageId;
      readonly tombstone: Message | null;
    }
  | {
      readonly t: "react";
      readonly channel: ChannelId;
      readonly id: MessageId;
      readonly reactions: readonly Reaction[];
    }
  /**
   * Somebody's read cursor moved. Sent to every socket of the reader, so their other tabs move the
   * "New messages" line, and -- for a `dm` or a `group` -- to the other members, so "seen by" updates
   * live. `userId` is who read; the server always sets it, and it is optional only so a client that
   * builds this event in a test or a mock does not have to.
   */
  | {
      readonly t: "read";
      readonly channel: ChannelId;
      readonly seq: number;
      readonly userId?: UserId;
    }
  | { readonly t: "presence"; readonly online: readonly UserId[] }
  | { readonly t: "typing"; readonly channel: ChannelId; readonly user: UserId }
  | {
      readonly t: "badge";
      readonly unread: Readonly<Record<ChannelId, number>>;
      readonly mentions: Readonly<Record<ChannelId, number>>;
      readonly threads: number;
    }
  | { readonly t: "error"; readonly code: ErrorCode; readonly message: string };

export type ServerEventType = ServerEvent["t"];

/**
 * What `serializeAttachment()` persists per hibernatable socket. Small on purpose: it is rewritten
 * on every `sub`, and the DO rebuilds everything else from SQLite after hibernation.
 */
export interface SocketAttachment {
  readonly userId: UserId;
  readonly sessionId: string;
  readonly channels: readonly ChannelId[];
  readonly connectedAt: Timestamp;
  /** Last frame received. Presence expires from this, not from a close event. */
  readonly lastSeenAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Server-internal: the identity the Worker hands the Durable Object
// ---------------------------------------------------------------------------

/**
 * The verified caller, passed to the DO in the `x-chat-user` header as JSON.
 *
 * Trusted because the DO has no route of its own: it is reachable only through this Worker's
 * `CHAT_WORKSPACE` binding, and this Worker verifies the Access assertion (or, on a dev server
 * only, a signed dev cookie) before it constructs the header. The Worker strips any inbound
 * `x-chat-user` from the browser's request first, so a client cannot supply one.
 */
export interface ChatIdentity {
  /** Access `sub`. */
  readonly id: UserId;
  readonly email: string;
  readonly name?: string;
}

export const IDENTITY_HEADER = "x-chat-user";

// ---------------------------------------------------------------------------
// Embedded mode: the phase-2 shell bridge
// ---------------------------------------------------------------------------

export type AppToShellMessage =
  | { readonly type: "chat:badge"; readonly unread: number; readonly mentions: number }
  | {
      readonly type: "chat:notify";
      readonly title: string;
      readonly body: string;
      readonly href: string;
    }
  | { readonly type: "chat:expand"; readonly href: string };

export type ShellToAppMessage =
  | { readonly type: "chat:open"; readonly href: string }
  | { readonly type: "chat:theme"; readonly mode: "light" | "dark"; readonly accent?: string }
  | { readonly type: "chat:visible"; readonly visible: boolean };
