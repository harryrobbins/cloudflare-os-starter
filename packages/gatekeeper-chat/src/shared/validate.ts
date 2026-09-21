// Runtime narrowing for everything inbound: JSON request bodies, query strings and WebSocket
// frames. Hand-written rather than schema-driven -- the contract is small, a validator here is the
// only place a field can be silently accepted, and the package carries no dependency for it.
//
// Every parser returns a Result. Nothing throws on bad input: a thrown validator inside a DO turns a
// client mistake into a 500 and, on the WebSocket path, into a dropped connection.

import {
  DEFAULT_PAGE_LIMIT,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_BODY_BYTES,
  MAX_CHANNEL_NAME_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_EMOJI_LENGTH,
  MAX_PAGE_LIMIT,
  MAX_PURPOSE_LENGTH,
  MAX_SUBSCRIPTIONS,
  MAX_TOPIC_LENGTH,
  MENTION_TOKEN_SOURCE,
  type ChannelKind,
  type ClientEvent,
  type CreateChannelRequest,
  type EditMessageRequest,
  type ListMessagesQuery,
  type ListThreadsQuery,
  type MarkReadRequest,
  type NotifyLevel,
  type PushSubscribeRequest,
  type SendMessageRequest,
  type UpdateChannelRequest,
  type UpdateMembershipRequest,
  type UpdateMeRequest,
} from "./protocol.js";

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T>(message: string): Result<T> {
  return { ok: false, message };
}

// --- primitives -------------------------------------------------------------

type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** UTF-8 byte length. `body.length` is UTF-16 units and undercounts emoji. */
export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function requiredString(source: Json, key: string, maxLength: number): Result<string> {
  const raw = source[key];
  if (typeof raw !== "string") return fail(`${key} must be a string`);
  const value = raw.trim();
  if (value.length === 0) return fail(`${key} must not be empty`);
  if (value.length > maxLength) return fail(`${key} must be at most ${maxLength} characters`);
  return ok(value);
}

/** Missing and `undefined` yield `undefined`; an explicit `null` is preserved when allowed. */
function optionalString(
  source: Json,
  key: string,
  maxLength: number,
  { nullable = false }: { nullable?: boolean } = {},
): Result<string | null | undefined> {
  if (!(key in source) || source[key] === undefined) return ok(undefined);
  const raw = source[key];
  if (raw === null) return nullable ? ok(null) : fail(`${key} must not be null`);
  if (typeof raw !== "string") return fail(`${key} must be a string`);
  const value = raw.trim();
  if (value.length > maxLength) return fail(`${key} must be at most ${maxLength} characters`);
  return ok(value);
}

function optionalNonNegativeInt(source: Json, key: string): Result<number | undefined> {
  if (!(key in source) || source[key] === undefined) return ok(undefined);
  const raw = source[key];
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    return fail(`${key} must be a non-negative integer`);
  }
  return ok(raw);
}

function stringArray(value: unknown, key: string, maxItems: number, maxLength: number): Result<string[]> {
  if (!Array.isArray(value)) return fail(`${key} must be an array`);
  if (value.length > maxItems) return fail(`${key} must have at most ${maxItems} entries`);
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > maxLength) {
      return fail(`${key} must contain non-empty strings of at most ${maxLength} characters`);
    }
    out.push(entry);
  }
  return ok(out);
}

const CHANNEL_KINDS: readonly ChannelKind[] = ["public", "private", "dm", "group"];
const NOTIFY_LEVELS: readonly NotifyLevel[] = ["all", "mentions", "none"];

/**
 * Channel names follow Slack's shape: lowercase, no spaces, so `#name` autocomplete and `in:#name`
 * search qualifiers need no quoting.
 */
const CHANNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Opaque ids are generated server-side; accept only what one can look like. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ID_MAX_LENGTH = 64;

export function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function requiredId(source: Json, key: string): Result<string> {
  const raw = source[key];
  if (!isId(raw)) return fail(`${key} must be an identifier`);
  return ok(raw);
}

/**
 * A bounded, deduplicated list of ids: the shape every inbound list takes -- channel members,
 * attachments, subscriptions. Deduplicated here so no handler has to wonder whether it was.
 */
function idArray(value: unknown, key: string, maxItems: number): Result<string[]> {
  const parsed = stringArray(value, key, maxItems, ID_MAX_LENGTH);
  if (!parsed.ok) return parsed;
  if (parsed.value.some((id) => !ID_PATTERN.test(id))) return fail(`${key} must contain identifiers`);
  return ok([...new Set(parsed.value)]);
}

// --- JSON bodies ------------------------------------------------------------

export function parseUpdateMe(input: unknown): Result<UpdateMeRequest> {
  if (!isRecord(input)) return fail("body must be an object");
  const displayName = optionalString(input, "displayName", MAX_DISPLAY_NAME_LENGTH, { nullable: true });
  if (!displayName.ok) return displayName;
  const tz = optionalString(input, "tz", 64, { nullable: true });
  if (!tz.ok) return tz;
  const notify = optionalEnum(input, "notify", NOTIFY_LEVELS);
  if (!notify.ok) return notify;
  const result: UpdateMeRequest = {
    ...(displayName.value !== undefined ? { displayName: displayName.value } : {}),
    ...(tz.value !== undefined ? { tz: tz.value } : {}),
    ...(notify.value !== undefined ? { notify: notify.value } : {}),
  };
  if (Object.keys(result).length === 0) return fail("body must change at least one field");
  return ok(result);
}

export function parseCreateChannel(input: unknown): Result<CreateChannelRequest> {
  if (!isRecord(input)) return fail("body must be an object");
  const kind = input["kind"];
  if (typeof kind !== "string" || !CHANNEL_KINDS.includes(kind as ChannelKind)) {
    return fail(`kind must be one of ${CHANNEL_KINDS.join(", ")}`);
  }
  const channelKind = kind as ChannelKind;

  const named = channelKind === "public" || channelKind === "private";
  let name: string | undefined;
  if (named) {
    const parsed = requiredString(input, "name", MAX_CHANNEL_NAME_LENGTH);
    if (!parsed.ok) return parsed;
    if (!CHANNEL_NAME_PATTERN.test(parsed.value)) {
      return fail("name must be lowercase letters, digits, hyphens or underscores");
    }
    name = parsed.value;
  } else if (input["name"] !== undefined && input["name"] !== null) {
    return fail(`a ${channelKind} channel must not have a name`);
  }

  const topic = optionalString(input, "topic", MAX_TOPIC_LENGTH);
  if (!topic.ok) return topic;
  const purpose = optionalString(input, "purpose", MAX_PURPOSE_LENGTH);
  if (!purpose.ok) return purpose;

  let memberIds: string[] | undefined;
  if (input["memberIds"] !== undefined) {
    const parsed = idArray(input["memberIds"], "memberIds", 200);
    if (!parsed.ok) return parsed;
    memberIds = parsed.value;
  }
  if (channelKind === "dm" && memberIds?.length !== 1) return fail("a dm needs exactly one memberIds entry");
  if (channelKind === "group" && (memberIds === undefined || memberIds.length < 2)) {
    return fail("a group needs at least two memberIds entries");
  }

  return ok({
    kind: channelKind,
    ...(name !== undefined ? { name } : {}),
    ...(topic.value ? { topic: topic.value } : {}),
    ...(purpose.value ? { purpose: purpose.value } : {}),
    ...(memberIds !== undefined ? { memberIds } : {}),
  });
}

export function parseUpdateChannel(input: unknown): Result<UpdateChannelRequest> {
  if (!isRecord(input)) return fail("body must be an object");
  const name = optionalString(input, "name", MAX_CHANNEL_NAME_LENGTH);
  if (!name.ok) return name;
  if (typeof name.value === "string" && !CHANNEL_NAME_PATTERN.test(name.value)) {
    return fail("name must be lowercase letters, digits, hyphens or underscores");
  }
  const topic = optionalString(input, "topic", MAX_TOPIC_LENGTH, { nullable: true });
  if (!topic.ok) return topic;
  const purpose = optionalString(input, "purpose", MAX_PURPOSE_LENGTH, { nullable: true });
  if (!purpose.ok) return purpose;
  const result: UpdateChannelRequest = {
    ...(typeof name.value === "string" ? { name: name.value } : {}),
    ...(topic.value !== undefined ? { topic: topic.value } : {}),
    ...(purpose.value !== undefined ? { purpose: purpose.value } : {}),
  };
  if (Object.keys(result).length === 0) return fail("body must change at least one field");
  return ok(result);
}

/**
 * Per-conversation preferences. Every field is optional, but a body that changes nothing is rejected
 * rather than answered with an unchanged row: it is always a client bug.
 */
export function parseUpdateMembership(input: unknown): Result<UpdateMembershipRequest> {
  if (!isRecord(input)) return fail("body must be an object");
  const notify = optionalEnum(input, "notify", NOTIFY_LEVELS);
  if (!notify.ok) return notify;
  const muted = optionalBoolean(input, "muted");
  if (!muted.ok) return muted;
  const starred = optionalBoolean(input, "starred");
  if (!starred.ok) return starred;
  const result: UpdateMembershipRequest = {
    ...(notify.value === undefined ? {} : { notify: notify.value }),
    ...(muted.value === undefined ? {} : { muted: muted.value }),
    ...(starred.value === undefined ? {} : { starred: starred.value }),
  };
  if (Object.keys(result).length === 0) return fail("body must change at least one field");
  return ok(result);
}

export function parseMarkRead(input: unknown): Result<MarkReadRequest> {
  if (!isRecord(input)) return fail("body must be an object");
  const hasSeq = input["seq"] !== undefined;
  const hasManual = "manualUnreadSeq" in input && input["manualUnreadSeq"] !== undefined;
  if (hasSeq === hasManual) return fail("body must set exactly one of seq or manualUnreadSeq");
  if (hasSeq) {
    const seq = optionalNonNegativeInt(input, "seq");
    if (!seq.ok) return seq;
    return ok({ seq: seq.value! });
  }
  if (input["manualUnreadSeq"] === null) return ok({ manualUnreadSeq: null });
  const manual = optionalNonNegativeInt(input, "manualUnreadSeq");
  if (!manual.ok) return manual;
  return ok({ manualUnreadSeq: manual.value! });
}

export function parseSendMessage(input: unknown): Result<SendMessageRequest> {
  if (!isRecord(input)) return fail("body must be an object");

  const rawBody = input["body"];
  if (typeof rawBody !== "string") return fail("body must be a string");
  // Trailing whitespace only, so a Markdown code block keeps its leading indentation.
  const body = rawBody.replace(/\s+$/u, "");
  if (utf8Bytes(body) > MAX_BODY_BYTES) return fail(`body must be at most ${MAX_BODY_BYTES} bytes`);

  const clientId = requiredId(input, "clientId");
  if (!clientId.ok) return clientId;

  let rootId: string | undefined;
  if (input["rootId"] !== undefined && input["rootId"] !== null) {
    const parsed = requiredId(input, "rootId");
    if (!parsed.ok) return parsed;
    rootId = parsed.value;
  }

  let attachmentIds: string[] | undefined;
  if (input["attachmentIds"] !== undefined) {
    const parsed = idArray(input["attachmentIds"], "attachmentIds", MAX_ATTACHMENTS_PER_MESSAGE);
    if (!parsed.ok) return parsed;
    attachmentIds = parsed.value;
  }

  // An empty body is only meaningful as an attachment carrier.
  if (body.length === 0 && (attachmentIds === undefined || attachmentIds.length === 0)) {
    return fail("body must not be empty unless the message carries an attachment");
  }

  return ok({
    body,
    clientId: clientId.value,
    ...(rootId !== undefined ? { rootId } : {}),
    ...(attachmentIds !== undefined ? { attachmentIds } : {}),
  });
}

export function parseEditMessage(input: unknown): Result<EditMessageRequest> {
  if (!isRecord(input)) return fail("body must be an object");
  const raw = input["body"];
  if (typeof raw !== "string") return fail("body must be a string");
  const body = raw.replace(/\s+$/u, "");
  if (body.length === 0) return fail("body must not be empty");
  if (utf8Bytes(body) > MAX_BODY_BYTES) return fail(`body must be at most ${MAX_BODY_BYTES} bytes`);
  return ok({ body });
}

export function parsePushSubscribe(input: unknown): Result<PushSubscribeRequest> {
  if (!isRecord(input)) return fail("body must be an object");
  const endpoint = requiredString(input, "endpoint", 2048);
  if (!endpoint.ok) return endpoint;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(endpoint.value);
  } catch {
    return fail("endpoint must be an absolute URL");
  }
  if (parsedUrl.protocol !== "https:") return fail("endpoint must be https");
  const p256dh = requiredString(input, "p256dh", 256);
  if (!p256dh.ok) return p256dh;
  const auth = requiredString(input, "auth", 256);
  if (!auth.ok) return auth;
  return ok({ endpoint: endpoint.value, p256dh: p256dh.value, auth: auth.value });
}

// --- mention tokens ---------------------------------------------------------

/** The token autocomplete inserts for a person. Both halves of the app build it from here. */
export function mentionToken(userId: string): string {
  return `<@${userId}>`;
}

/**
 * Every distinct user id mentioned in a body, in first-appearance order.
 *
 * Extraction only: the caller still has to check each id against a real user before writing a
 * `mentions` row, because a body is client-supplied text and a token can name anybody.
 */
export function extractMentionIds(body: string): readonly string[] {
  const pattern = new RegExp(MENTION_TOKEN_SOURCE, "gu");
  const seen = new Set<string>();
  for (const match of body.matchAll(pattern)) {
    const id = match[1];
    if (id !== undefined) seen.add(id);
  }
  return [...seen];
}

/** A reaction emoji arrives as a path segment, so it is validated on its own. */
export function parseEmoji(value: string): Result<string> {
  if (value.length === 0 || value.length > MAX_EMOJI_LENGTH) return fail("emoji has an invalid length");
  // No whitespace, no control characters: enough to keep it a single rendered token without
  // shipping a Unicode emoji table to both halves of the app.
  if (/[\s\p{Cc}\p{Cn}]/u.test(value)) return fail("emoji must be a single token");
  return ok(value);
}

// --- query strings ----------------------------------------------------------

export function parseListMessagesQuery(params: URLSearchParams): Result<ListMessagesQuery> {
  const cursors = ["before", "after", "around"].filter((key) => params.has(key));
  if (cursors.length > 1) return fail("use at most one of before, after or around");

  const limit = parseLimit(params);
  if (!limit.ok) return limit;

  const query: Record<string, unknown> = { limit: limit.value };
  for (const key of ["before", "after"] as const) {
    const raw = params.get(key);
    if (raw === null) continue;
    const seq = Number(raw);
    if (!Number.isSafeInteger(seq) || seq < 0) return fail(`${key} must be a non-negative integer`);
    query[key] = seq;
  }
  for (const key of ["around", "rootId"] as const) {
    const raw = params.get(key);
    if (raw === null) continue;
    if (!isId(raw)) return fail(`${key} must be an identifier`);
    query[key] = raw;
  }
  return ok(query as ListMessagesQuery);
}

export function parseListThreadsQuery(params: URLSearchParams): Result<ListThreadsQuery> {
  const limit = parseLimit(params);
  if (!limit.ok) return limit;
  const cursor = params.get("cursor");
  if (cursor !== null && cursor.length > 256) return fail("cursor is too long");
  return ok({
    unread: params.get("unread") === "1" || params.get("unread") === "true",
    limit: limit.value,
    ...(cursor !== null ? { cursor } : {}),
  });
}

function parseLimit(params: URLSearchParams): Result<number> {
  const raw = params.get("limit");
  if (raw === null) return ok(DEFAULT_PAGE_LIMIT);
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1) return fail("limit must be a positive integer");
  return ok(Math.min(limit, MAX_PAGE_LIMIT));
}

// --- WebSocket frames -------------------------------------------------------

/**
 * Parses one inbound frame. `raw` may be an ArrayBuffer because `webSocketMessage` delivers binary
 * frames too; those are rejected rather than decoded, since the protocol is JSON text.
 */
export function parseClientEvent(raw: string | ArrayBuffer): Result<ClientEvent> {
  if (typeof raw !== "string") return fail("frames must be text");
  if (raw.length === 0) return fail("frame is empty");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("frame is not JSON");
  }
  if (!isRecord(parsed)) return fail("frame must be an object");

  switch (parsed["t"]) {
    case "sub": {
      const channels = idArray(parsed["channels"], "channels", MAX_SUBSCRIPTIONS);
      if (!channels.ok) return channels;
      return ok({ t: "sub", channels: channels.value });
    }
    case "typing": {
      const channel = requiredId(parsed, "channel");
      if (!channel.ok) return channel;
      return ok({ t: "typing", channel: channel.value });
    }
    case "read": {
      const channel = requiredId(parsed, "channel");
      if (!channel.ok) return channel;
      const seq = optionalNonNegativeInt(parsed, "seq");
      if (!seq.ok) return seq;
      if (seq.value === undefined) return fail("seq is required");
      return ok({ t: "read", channel: channel.value, seq: seq.value });
    }
    case "ping":
      return ok({ t: "ping" });
    default:
      return fail(`unknown event type ${JSON.stringify(parsed["t"])}`);
  }
}

// --- helpers ----------------------------------------------------------------

function optionalBoolean(source: Json, key: string): Result<boolean | undefined> {
  if (!(key in source) || source[key] === undefined) return ok(undefined);
  const raw = source[key];
  if (typeof raw !== "boolean") return fail(`${key} must be true or false`);
  return ok(raw);
}

function optionalEnum<T extends string>(source: Json, key: string, allowed: readonly T[]): Result<T | undefined> {
  if (!(key in source) || source[key] === undefined) return ok(undefined);
  const raw = source[key];
  if (typeof raw !== "string" || !allowed.includes(raw as T)) {
    return fail(`${key} must be one of ${allowed.join(", ")}`);
  }
  return ok(raw as T);
}
