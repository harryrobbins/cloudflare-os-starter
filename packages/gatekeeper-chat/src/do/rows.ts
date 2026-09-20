// SQLite row shapes and the mapping to the wire types in `shared/protocol.ts`.
//
// Type aliases, not interfaces: `sql.exec<T>()` constrains `T` to `Record<string, SqlStorageValue>`,
// and only an alias gets the implicit index signature that satisfies it.
//
// Every mapper is the single place a snake_case column becomes a camelCase field, so a renamed
// column breaks the build in one file rather than leaking a raw row to a client.

import {
  type Attachment,
  type Channel,
  type ChannelKind,
  type Membership,
  type MessageKind,
  type NotifyLevel,
  type User,
  type UserKind,
  type UserPrefs,
} from "../shared/protocol.js";

export type UserRow = {
  id: string;
  name: string;
  display_name: string | null;
  email: string | null;
  avatar_key: string | null;
  first_seen_at: number;
  last_seen_at: number;
  tz: string | null;
  notify: string;
  kind: string;
};

export type ChannelRow = {
  id: string;
  kind: string;
  name: string | null;
  topic: string | null;
  purpose: string | null;
  created_by: string;
  created_at: number;
  archived_at: number | null;
  last_seq: number;
  dm_key: string | null;
};

export type MembershipRow = {
  channel_id: string;
  user_id: string;
  joined_at: number;
  last_read_seq: number;
  manual_unread_seq: number | null;
  notify: string;
  muted: number;
  starred: number;
};

export type MessageRow = {
  id: string;
  channel_id: string;
  seq: number;
  root_id: string | null;
  author_id: string;
  body: string;
  kind: string;
  client_id: string | null;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  reply_count: number;
  last_reply_at: number | null;
  has_image: number;
  has_file: number;
  has_link: number;
};

export type AttachmentRow = {
  id: string;
  message_id: string | null;
  channel_id: string;
  uploader_id: string;
  r2_key: string;
  name: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  thumb_key: string | null;
  created_at: number;
};

export type CountRow = { channel_id: string; n: number };

export function isNotifyLevel(value: string): value is NotifyLevel {
  return value === "all" || value === "mentions" || value === "none";
}

function asChannelKind(value: string): ChannelKind {
  return value === "private" || value === "dm" || value === "group" ? value : "public";
}

export function asMessageKind(value: string): MessageKind {
  return value === "system" || value === "agent" ? value : "user";
}

function asUserKind(value: string): UserKind {
  return value === "agent" ? "agent" : "person";
}

export function toUser(row: UserRow, online: boolean): User {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    avatarKey: row.avatar_key,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    tz: row.tz,
    online,
    kind: asUserKind(row.kind),
  };
}

export function toPrefs(row: UserRow): UserPrefs {
  return {
    displayName: row.display_name,
    tz: row.tz,
    notify: isNotifyLevel(row.notify) ? row.notify : "all",
  };
}

export function toChannel(
  row: ChannelRow,
  memberCount: number,
  memberIds?: readonly string[],
): Channel {
  return {
    id: row.id,
    kind: asChannelKind(row.kind),
    name: row.name,
    topic: row.topic,
    purpose: row.purpose,
    createdBy: row.created_by,
    createdAt: row.created_at,
    archived: row.archived_at !== null,
    memberCount,
    lastSeq: row.last_seq,
    ...(memberIds === undefined ? {} : { memberIds }),
  };
}

export function toMembership(row: MembershipRow): Membership {
  return {
    channelId: row.channel_id,
    userId: row.user_id,
    joinedAt: row.joined_at,
    lastReadSeq: row.last_read_seq,
    manualUnreadSeq: row.manual_unread_seq,
    notify: isNotifyLevel(row.notify) ? row.notify : "all",
    muted: row.muted !== 0,
    starred: row.starred !== 0,
  };
}

export function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    messageId: row.message_id,
    channelId: row.channel_id,
    uploaderId: row.uploader_id,
    name: row.name,
    mime: row.mime,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    hasThumb: row.thumb_key !== null,
    createdAt: row.created_at,
  };
}
