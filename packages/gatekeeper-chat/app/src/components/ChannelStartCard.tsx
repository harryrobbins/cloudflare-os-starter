// What sits at the top of a conversation's history.
//
// Two cards, because "the beginning of the conversation" means two different things. In a channel you
// have just scrolled to the top of, it means "here is what this place is and who is in it" -- the
// facts that are otherwise two clicks away in the details pane, shown at the one moment you are
// looking for them. In a deployment's first hour it means something else entirely: #general is empty,
// nobody has done anything yet, and a line reading "This is the very beginning of the conversation"
// is a true statement that helps nobody.

import { Hash, LockSimple, NotePencil, UserCirclePlus, Users } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type { Channel, User, UserId } from "../contract.js";
import { formatFullDate } from "../lib/format.js";
import { isDirect } from "../lib/labels.js";
import { Button } from "./primitives.js";

/**
 * The header card: topic, purpose, who made it and when, how many people are in it.
 *
 * Rendered by the message list only once history has actually reached the first message, so it is a
 * reward for scrolling to the top rather than a banner that eats the first screen of every channel.
 */
export function ChannelStartCard({
  channel,
  label,
  users,
  isMember,
  onJoin,
}: {
  channel: Channel;
  label: string;
  users: Readonly<Record<UserId, User>>;
  isMember: boolean;
  onJoin: () => void;
}): ReactNode {
  const creator = users[channel.createdBy]?.name ?? "someone";
  const direct = isDirect(channel);

  return (
    <div className="px-5 pt-6 pb-2">
      <div className="rounded-xl border border-kumo-line bg-kumo-elevated p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-subtle">
            {direct ? (
              <Users size={18} />
            ) : channel.kind === "private" ? (
              <LockSimple size={18} />
            ) : (
              <Hash size={18} />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-kumo-strong">
              This is the start of {label}
            </p>
            <p className="mt-0.5 text-[12px] text-kumo-subtle">
              {direct
                ? `Just the two of you — or the few of you. Messages here stay between members.`
                : `Created by ${creator} on ${formatFullDate(channel.createdAt)}.`}
            </p>

            {channel.purpose !== null && channel.purpose.length > 0 && (
              <p className="mt-2 text-[13px] leading-5 text-kumo-default">{channel.purpose}</p>
            )}

            {(channel.topic !== null || !direct) && (
              <dl className="mt-2.5 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[12px]">
                {channel.topic !== null && channel.topic.length > 0 && (
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <dt className="shrink-0 text-kumo-inactive">Topic</dt>
                    <dd className="min-w-0 truncate text-kumo-default">{channel.topic}</dd>
                  </span>
                )}
                {!direct && (
                  <span className="flex items-baseline gap-1.5">
                    <dt className="text-kumo-inactive">Members</dt>
                    <dd className="text-kumo-default tabular-nums">{channel.memberCount}</dd>
                  </span>
                )}
              </dl>
            )}

            {!isMember && (
              <Button variant="primary" size="sm" className="mt-3" onClick={onJoin}>
                Join {label}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The card a brand-new deployment sees in #general.
 *
 * Three next steps, because "you are here, now what" is the only question anybody has at that point,
 * and the answers are all one click away from this rail.
 */
export function FirstRunCard({
  label,
  onNewChannel,
  onNewMessage,
  hasDisplayName,
}: {
  label: string;
  onNewChannel: () => void;
  onNewMessage: () => void;
  hasDisplayName: boolean;
}): ReactNode {
  return (
    <div className="px-5 py-6" data-testid="first-run-card">
      <div className="rounded-xl border border-kumo-line bg-kumo-elevated p-5">
        <p className="text-[15px] font-semibold text-kumo-strong">Welcome to {label}</p>
        <p className="mt-1 max-w-prose text-[13px] leading-5 text-kumo-subtle">
          This is the channel everybody who signs in lands in, and the one nobody can leave. Anything
          posted here is visible to the whole deployment; anything narrower belongs in a channel of
          its own or in a direct message.
        </p>

        <p className="mt-4 text-[11px] font-semibold tracking-[0.06em] text-kumo-inactive uppercase">
          Three things to try
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <NextStep
            icon={<Hash size={15} />}
            title="Create a channel"
            body="One per project, one per team."
            onClick={onNewChannel}
          />
          <NextStep
            icon={<NotePencil size={15} />}
            title="Message someone"
            body="Anyone who has opened chat."
            onClick={onNewMessage}
          />
          <NextStep
            icon={<UserCirclePlus size={15} />}
            title={hasDisplayName ? "Check your name" : "Set your display name"}
            body="It is what everyone else sees."
            to="/settings"
          />
        </div>
      </div>
    </div>
  );
}

function NextStep({
  icon,
  title,
  body,
  onClick,
  to,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  onClick?: () => void;
  to?: "/settings";
}): ReactNode {
  const className =
    "press flex cursor-pointer flex-col items-start gap-1 rounded-lg border border-kumo-line bg-kumo-control p-3 text-left transition-colors hover:border-kumo-ring hover:bg-kumo-tint";
  const content = (
    <>
      <span className="text-kumo-brand">{icon}</span>
      <span className="text-[13px] font-medium text-kumo-strong">{title}</span>
      <span className="text-[11px] leading-4 text-kumo-subtle">{body}</span>
    </>
  );
  if (to !== undefined) {
    return (
      <Link to={to} className={className}>
        {content}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={className}>
      {content}
    </button>
  );
}
