// Naming a conversation.
//
// `Channel.name` is null for a DM or a group -- the contract says so, because those are named from
// their members and a stored name would go stale the moment somebody is renamed. Every place that
// shows a conversation's name goes through here so a DM is labelled identically in the rail, the
// header, a toast and the document title.

import type { Channel, ChannelId, User, UserId } from "../contract.js";

export function otherMemberIds(channel: Channel, meId: UserId | undefined): readonly UserId[] {
  const members = channel.memberIds ?? [];
  const others = members.filter((id) => id !== meId);
  // A DM with yourself (a note to self) has no "other", so fall back to showing yourself.
  return others.length > 0 ? others : members;
}

/** `#general`, `Alice`, `Alice, Bob and 2 others`. No leading `#` for DMs and groups. */
export function channelLabel(
  channel: Channel,
  users: Readonly<Record<UserId, User>>,
  meId: UserId | undefined,
): string {
  if (channel.name !== null) return `#${channel.name}`;
  const others = otherMemberIds(channel, meId);
  const names = others.map((id) => users[id]?.name ?? "Unknown");
  if (names.length === 0) return "Direct message";
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]}, ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/** The label without the `#`, for a page title or a search chip. */
export function channelPlainLabel(
  channel: Channel,
  users: Readonly<Record<UserId, User>>,
  meId: UserId | undefined,
): string {
  const label = channelLabel(channel, users, meId);
  return label.startsWith("#") ? label.slice(1) : label;
}

export function isDirect(channel: Channel): boolean {
  return channel.kind === "dm" || channel.kind === "group";
}

/** The one channel nobody can leave. */
export function isGeneral(channel: Channel): boolean {
  return channel.name === "general";
}

export function channelById(
  channels: Readonly<Record<ChannelId, Channel>>,
  channelId: ChannelId | null,
): Channel | undefined {
  return channelId === null ? undefined : channels[channelId];
}
