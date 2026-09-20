// The left rail.
//
// Reading order follows the plan: the three personal views, then Starred, Channels and Direct messages,
// each collapsible, with Browse channels and New message at the foot of their group. A conversation is
// bold when unread, dim when muted, and carries a mention badge; a muted conversation never badges, which
// is the whole contract muting offers.

import {
  At,
  CaretRight,
  ChatsCircle,
  Gear,
  Hash,
  LockSimple,
  MagnifyingGlass,
  NotePencil,
  Plus,
  Star,
  Users,
} from "@phosphor-icons/react";
import { Link, useRouterState, type LinkProps } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";

import type { Channel, ChannelId } from "../contract.js";
import { channelLabel, isDirect, otherMemberIds } from "../lib/labels.js";
import { compareChannels, isUnread } from "../store/unread.js";
import { useChat } from "../hooks/store.js";
import { Avatar, CountBadge, PresenceDot, SectionLabel } from "./primitives.js";

export function Rail({
  onNewChannel,
  onNewMessage,
  onSearch,
  onNavigate,
}: {
  onNewChannel: () => void;
  onNewMessage: () => void;
  onSearch: () => void;
  /** Narrow layouts close the rail after a navigation. */
  onNavigate?: () => void;
}): ReactNode {
  const channels = useChat((state) => state.channels);
  const memberships = useChat((state) => state.memberships);
  const badges = useChat((state) => state.badges);
  const users = useChat((state) => state.users);
  const online = useChat((state) => state.online);
  const meId = useChat((state) => state.me?.id);
  const threadCount = useChat((state) => state.badges.threads);
  const draftCount = useChat((state) => Object.keys(state.drafts).length);
  const mentionCount = useMemo(
    () => Object.values(badges.mentions).reduce((total, count) => total + count, 0),
    [badges.mentions],
  );

  const groups = useMemo(() => {
    const mine = Object.values(channels).filter((channel) => memberships[channel.id] !== undefined);
    const starred = mine.filter((channel) => memberships[channel.id]?.starred === true);
    const starredIds = new Set(starred.map((channel) => channel.id));
    return {
      starred: starred.sort(compareChannels),
      channels: mine
        .filter((channel) => !isDirect(channel) && !starredIds.has(channel.id) && !channel.archived)
        .sort(compareChannels),
      directs: mine
        .filter((channel) => isDirect(channel) && !starredIds.has(channel.id))
        .sort((a, b) => b.lastSeq - a.lastSeq),
    };
  }, [channels, memberships]);

  return (
    <nav
      aria-label="Conversations"
      className="flex h-full w-full flex-col border-r border-kumo-line bg-kumo-elevated"
    >
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-kumo-line px-3">
        <button
          type="button"
          onClick={onSearch}
          className="press flex h-8 flex-1 cursor-pointer items-center gap-2 rounded-lg border border-kumo-line bg-kumo-base px-2.5 text-left text-[12px] text-kumo-inactive transition-colors hover:border-kumo-ring hover:text-kumo-subtle"
        >
          <MagnifyingGlass size={14} />
          <span className="flex-1 truncate">Search</span>
          <kbd className="rounded border border-kumo-line px-1 font-sans text-[10px] text-kumo-inactive">
            ⌘K
          </kbd>
        </button>
      </div>

      <div className="quiet-scroll min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <div className="flex flex-col gap-0.5">
          <RailLink to="/threads" icon={<ChatsCircle size={15} />} label="Threads" badge={threadCount} onNavigate={onNavigate} />
          <RailLink to="/mentions" icon={<At size={15} />} label="Mentions & reactions" badge={mentionCount} onNavigate={onNavigate} />
          <RailLink to="/drafts" icon={<NotePencil size={15} />} label="Drafts" count={draftCount} onNavigate={onNavigate} />
          <RailLink to="/people" icon={<Users size={15} />} label="People" onNavigate={onNavigate} />
        </div>

        {groups.starred.length > 0 && (
          <Section label="Starred" icon={<Star size={11} weight="fill" />}>
            {groups.starred.map((channel) => (
              <ChannelRow
                key={channel.id}
                channel={channel}
                unread={isUnread(memberships[channel.id], channel.lastSeq)}
                mentions={badges.mentions[channel.id] ?? 0}
                muted={memberships[channel.id]?.muted === true}
                label={channelLabel(channel, users, meId)}
                online={presenceOf(channel, online, meId)}
                onNavigate={onNavigate}
              />
            ))}
          </Section>
        )}

        <Section label="Channels">
          {groups.channels.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              unread={isUnread(memberships[channel.id], channel.lastSeq)}
              mentions={badges.mentions[channel.id] ?? 0}
              muted={memberships[channel.id]?.muted === true}
              label={channelLabel(channel, users, meId)}
              onNavigate={onNavigate}
            />
          ))}
          <FooterAction icon={<Plus size={13} />} label="Browse channels" to="/browse" onNavigate={onNavigate} />
          <FooterButton icon={<Plus size={13} />} label="New channel" onClick={onNewChannel} />
        </Section>

        <Section label="Direct messages">
          {groups.directs.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              unread={isUnread(memberships[channel.id], channel.lastSeq)}
              mentions={badges.mentions[channel.id] ?? 0}
              muted={memberships[channel.id]?.muted === true}
              label={channelLabel(channel, users, meId)}
              online={presenceOf(channel, online, meId)}
              onNavigate={onNavigate}
            />
          ))}
          <FooterButton icon={<Plus size={13} />} label="New message" onClick={onNewMessage} />
        </Section>
      </div>

      <Footer onNavigate={onNavigate} />
    </nav>
  );
}

function presenceOf(
  channel: Channel,
  online: readonly string[],
  meId: string | undefined,
): boolean | undefined {
  if (channel.kind !== "dm") return undefined;
  const others = otherMemberIds(channel, meId);
  return others.some((id) => online.includes(id));
}

function Section({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: ReactNode;
  children: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(true);
  return (
    <section className="mt-5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="group flex w-full cursor-pointer items-center gap-1 rounded px-1.5 py-1 text-left transition-colors hover:bg-kumo-tint"
      >
        <CaretRight
          size={10}
          weight="bold"
          className={`shrink-0 text-kumo-inactive transition-transform ${open ? "rotate-90" : ""}`}
        />
        {icon !== undefined && <span className="text-kumo-inactive">{icon}</span>}
        <SectionLabel>{label}</SectionLabel>
      </button>
      {open && <div className="mt-0.5 flex flex-col gap-px">{children}</div>}
    </section>
  );
}

function RailLink({
  to,
  icon,
  label,
  badge = 0,
  count = 0,
  onNavigate,
}: {
  // `LinkProps["to"]` rather than `string`: the router's path union is what makes a typo in a rail
  // destination a compile error instead of a blank screen.
  to: LinkProps["to"];
  icon: ReactNode;
  label: string;
  badge?: number;
  count?: number;
  onNavigate?: () => void;
}): ReactNode {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = pathname === to;
  return (
    <Link
      to={to}
      onClick={onNavigate}
      className={[
        "group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors",
        active ? "bg-kumo-fill font-medium text-kumo-strong" : "text-kumo-default hover:bg-kumo-tint",
      ].join(" ")}
    >
      <span className={active ? "text-kumo-brand" : "text-kumo-subtle group-hover:text-kumo-default"}>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge > 0 ? (
        <CountBadge count={badge} />
      ) : count > 0 ? (
        <span className="text-[11px] text-kumo-inactive tabular-nums">{count}</span>
      ) : null}
    </Link>
  );
}

function ChannelRow({
  channel,
  label,
  unread,
  mentions,
  muted,
  online,
  onNavigate,
}: {
  channel: Channel;
  label: string;
  unread: boolean;
  mentions: number;
  muted: boolean;
  online?: boolean;
  onNavigate?: () => void;
}): ReactNode {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = pathname.startsWith(`/c/${channel.id}`);
  const direct = isDirect(channel);
  const users = useChat((state) => state.users);
  const meId = useChat((state) => state.me?.id);
  const otherId = direct ? otherMemberIds(channel, meId)[0] : undefined;

  return (
    <Link
      to="/c/$channelId"
      params={{ channelId: channel.id }}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={[
        "group flex h-7 items-center gap-2 rounded-md px-2.5 text-[13px] transition-colors",
        active
          ? "bg-kumo-fill text-kumo-strong"
          : muted
            ? "text-kumo-inactive hover:bg-kumo-tint"
            : unread
              ? "font-semibold text-kumo-strong hover:bg-kumo-tint"
              : "text-kumo-default hover:bg-kumo-tint",
      ].join(" ")}
    >
      <span className="flex w-4 shrink-0 justify-center">
        {direct ? (
          channel.kind === "group" ? (
            <Users size={13} className="text-kumo-subtle" />
          ) : otherId !== undefined ? (
            <Avatar name={users[otherId]?.name ?? "?"} id={otherId} size={16} />
          ) : (
            <Users size={13} className="text-kumo-subtle" />
          )
        ) : channel.kind === "private" ? (
          <LockSimple size={13} className="text-kumo-subtle" />
        ) : (
          <Hash size={13} className="text-kumo-subtle" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {online !== undefined && !unread && mentions === 0 && (
        <PresenceDot online={online} className="h-2 w-2" />
      )}
      {!muted && <CountBadge count={mentions} />}
    </Link>
  );
}

function FooterAction({
  icon,
  label,
  to,
  onNavigate,
}: {
  icon: ReactNode;
  label: string;
  to: LinkProps["to"];
  onNavigate?: () => void;
}): ReactNode {
  return (
    <Link
      to={to}
      onClick={onNavigate}
      className="flex h-7 items-center gap-2 rounded-md px-2.5 text-[12px] text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default"
    >
      <span className="flex w-4 shrink-0 justify-center">{icon}</span>
      {label}
    </Link>
  );
}

function FooterButton({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-7 cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-[12px] text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default"
    >
      <span className="flex w-4 shrink-0 justify-center">{icon}</span>
      {label}
    </button>
  );
}

function Footer({ onNavigate }: { onNavigate?: () => void }): ReactNode {
  const me = useChat((state) => state.me);
  const online = useChat((state) => state.online);
  if (me === null) return null;
  return (
    <div className="flex h-14 shrink-0 items-center gap-2.5 border-t border-kumo-line px-3">
      <Avatar name={me.name} id={me.id} size={28} online={online.includes(me.id)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-medium text-kumo-strong">{me.name}</span>
        <span className="block truncate text-[11px] text-kumo-inactive">{me.email ?? ""}</span>
      </span>
      <Link
        to="/settings"
        onClick={onNavigate}
        aria-label="Settings"
        title="Settings"
        className="press inline-flex h-7 w-7 items-center justify-center rounded-md text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default"
      >
        <Gear size={15} />
      </Link>
    </div>
  );
}

export type { ChannelId };
